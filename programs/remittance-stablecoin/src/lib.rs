use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::invoke;
use anchor_lang::solana_program::system_instruction;
use spl_token_2022::extension::{
    transfer_fee::TransferFeeConfig, BaseStateWithExtensions, ExtensionType, StateWithExtensions,
};

declare_id!("KChY5fYCcqXS9uiY3daKx3fctBPTa1aQKfuJ8MkD1gz");

#[program]
pub mod remittance_stablecoin {
    use super::*;

    /// Creates a Token-2022 mint stacking:
    ///   TransferFeeConfig + MetadataPointer (-> mint itself) +
    ///   DefaultAccountState(Frozen) + MintCloseAuthority.
    /// All extension-init instructions run BEFORE InitializeMint;
    /// TokenMetadata::Initialize runs after, once the mint exists.
    pub fn init_mint_v1(
        ctx: Context<InitMintV1>,
        decimals: u8,
        fee_bps: u16,
        max_fee: u64,
        name: String,
        symbol: String,
        uri: String,
    ) -> Result<()> {
        init_mint_impl(&ctx, decimals, fee_bps, max_fee, name, symbol, uri, None)
    }

    /// v1 stack PLUS PermanentDelegate (issuer = delegate) and
    /// ConfidentialTransferMint with auto_approve_new_accounts = false (issuer
    /// must approve each configured account — manual KYC-style policy).
    /// Extensions can't be added to an existing mint, so this is a NEW mint.
    /// Token-2022 rejects TransferFeeConfig + ConfidentialTransferMint unless
    /// ConfidentialTransferFeeConfig is present too, so v2 also initializes it
    /// with `fee_withdraw_elgamal_pubkey` (32-byte ElGamal key that encrypts
    /// withheld confidential fees).
    pub fn init_mint_v2(
        ctx: Context<InitMintV1>,
        decimals: u8,
        fee_bps: u16,
        max_fee: u64,
        name: String,
        symbol: String,
        uri: String,
        fee_withdraw_elgamal_pubkey: [u8; 32],
    ) -> Result<()> {
        init_mint_impl(
            &ctx,
            decimals,
            fee_bps,
            max_fee,
            name,
            symbol,
            uri,
            Some(fee_withdraw_elgamal_pubkey),
        )
    }

    /// Proof-free confidential step: moves `amount` from the account's public
    /// balance into its confidential PENDING balance. Owner-signed. Decimals
    /// are read from the mint via StateWithExtensions.
    pub fn deposit_confidential(ctx: Context<ConfidentialAccountOp>, amount: u64) -> Result<()> {
        let mint_data = ctx.accounts.mint.try_borrow_data()?;
        let decimals = StateWithExtensions::<spl_token_2022::state::Mint>::unpack(&mint_data)
            .map_err(|_| error!(ErrorCode::InvalidMintState))?
            .base
            .decimals;
        drop(mint_data);

        invoke(
            &spl_token_2022::extension::confidential_transfer::instruction::deposit(
                &ctx.accounts.token_program.key(),
                &ctx.accounts.token_account.key(),
                &ctx.accounts.mint.key(),
                amount,
                decimals,
                &ctx.accounts.owner.key(),
                &[],
            )?,
            &[
                ctx.accounts.token_account.to_account_info(),
                ctx.accounts.mint.to_account_info(),
                ctx.accounts.owner.to_account_info(),
            ],
        )?;
        Ok(())
    }

    /// Proof-free confidential step: folds PENDING into AVAILABLE. The owner's
    /// client must supply the credit counter it observed and the AES-encrypted
    /// new available balance (36 bytes) — both derive from the owner's secret
    /// keys, so they cannot be computed on-chain; they are passed through.
    /// Token-2022 only RECORDS the counter (expected vs actual lets the owner
    /// detect a stale ciphertext) and cannot verify the ciphertext at all.
    pub fn apply_pending_balance(
        ctx: Context<ApplyPendingBalance>,
        expected_pending_balance_credit_counter: u64,
        new_decryptable_available_balance: [u8; 36],
    ) -> Result<()> {
        invoke(
            &spl_token_2022::extension::confidential_transfer::instruction::inner_apply_pending_balance(
                &ctx.accounts.token_program.key(),
                &ctx.accounts.token_account.key(),
                expected_pending_balance_credit_counter,
                spl_token_2022::solana_zk_token_sdk::zk_token_elgamal::pod::AeCiphertext(
                    new_decryptable_available_balance,
                ),
                &ctx.accounts.owner.key(),
                &[],
            )?,
            &[
                ctx.accounts.token_account.to_account_info(),
                ctx.accounts.owner.to_account_info(),
            ],
        )?;
        Ok(())
    }

    /// Checked transfer with the Token-2022 transfer fee withheld to the mint.
    /// `expected_fee` must equal the fee the mint's TransferFeeConfig computes
    /// for the current epoch — a client lying about the fee fails here.
    /// The mint itself performs the authoritative fee calculation; we only gate
    /// the max, so the mint is passed writable and read via StateWithExtensions
    /// (NEVER raw Mint::unpack — the account carries extensions).
    pub fn transfer_with_fee(
        ctx: Context<TransferWithFee>,
        amount: u64,
        expected_fee: u64,
    ) -> Result<()> {
        let token_program = ctx.accounts.token_program.key();

        let mint_data = ctx.accounts.mint.try_borrow_data()?;
        let state = StateWithExtensions::<spl_token_2022::state::Mint>::unpack(&mint_data)
            .map_err(|_| error!(ErrorCode::InvalidMintState))?;
        let decimals = state.base.decimals;
        let fee_config = state
            .get_extension::<TransferFeeConfig>()
            .map_err(|_| error!(ErrorCode::MissingTransferFeeConfig))?;
        let epoch = Clock::get()?.epoch;
        // calculate_epoch_fee returns Option<u64> (None on overflow) — keep it
        // checked, no unwrap on user-controlled `amount`.
        let fee = fee_config
            .calculate_epoch_fee(epoch, amount)
            .ok_or_else(|| error!(ErrorCode::FeeMismatch))?;
        drop(mint_data);

        require!(expected_fee == fee, ErrorCode::FeeMismatch);

        invoke(
            &spl_token_2022::extension::transfer_fee::instruction::transfer_checked_with_fee(
                &token_program,
                &ctx.accounts.source.key(),
                &ctx.accounts.mint.key(),
                &ctx.accounts.destination.key(),
                &ctx.accounts.authority.key(),
                &[],
                amount,
                decimals,
                expected_fee,
            )?,
            &[
                ctx.accounts.source.to_account_info(),
                ctx.accounts.mint.to_account_info(),
                ctx.accounts.destination.to_account_info(),
                ctx.accounts.authority.to_account_info(),
            ],
        )?;

        Ok(())
    }

    /// Thaws ONE token account (freeze authority signed). Per-account control:
    /// every other new account stays frozen (DefaultAccountState).
    pub fn thaw_account(ctx: Context<ThawAccount>) -> Result<()> {
        invoke(
            &spl_token_2022::instruction::thaw_account(
                &ctx.accounts.token_program.key(),
                &ctx.accounts.token_account.key(),
                &ctx.accounts.mint.key(),
                &ctx.accounts.freeze_authority.key(),
                &[],
            )?,
            &[
                ctx.accounts.token_account.to_account_info(),
                ctx.accounts.mint.to_account_info(),
                ctx.accounts.freeze_authority.to_account_info(),
            ],
        )?;

        Ok(())
    }
}

#[derive(Accounts)]
pub struct TransferWithFee<'info> {
    /// Holder sending tokens; must be the source account owner.
    pub authority: Signer<'info>,
    /// CHECK: token account, validated by the Token-2022 CPI (owner + frozen state).
    #[account(mut)]
    pub source: UncheckedAccount<'info>,
    /// CHECK: the mint, writable because transfer_checked_with_fee records the
    /// withheld fee; state read above via StateWithExtensions.
    #[account(mut)]
    pub mint: UncheckedAccount<'info>,
    /// CHECK: token account, validated by the Token-2022 CPI.
    #[account(mut)]
    pub destination: UncheckedAccount<'info>,
    /// CHECK: constrained to the Token-2022 program id.
    #[account(address = spl_token_2022::ID)]
    pub token_program: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct ThawAccount<'info> {
    /// Must be the mint's freeze authority — validated by the Token-2022 CPI.
    pub freeze_authority: Signer<'info>,
    /// CHECK: token account, validated by the Token-2022 CPI.
    #[account(mut)]
    pub token_account: UncheckedAccount<'info>,
    /// CHECK: the mint this token account belongs to, validated by the CPI.
    pub mint: UncheckedAccount<'info>,
    /// CHECK: constrained to the Token-2022 program id.
    #[account(address = spl_token_2022::ID)]
    pub token_program: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct InitMintV1<'info> {
    /// Issuer/payer: funds the mint, becomes fee/withdraw/metadata/freeze/close authority.
    #[account(mut)]
    pub authority: Signer<'info>,
    /// Mint keypair — signs create_account; Token-2022 owns it afterwards.
    /// CHECK: created in this instruction via system CPI; token-2022 validates
    /// it during extension init and InitializeMint.
    #[account(mut)]
    pub mint: Signer<'info>,
    /// CHECK: constrained to the Token-2022 program id.
    #[account(address = spl_token_2022::ID)]
    pub token_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ConfidentialAccountOp<'info> {
    /// Token account owner; must sign (validated by the Token-2022 CPI).
    pub owner: Signer<'info>,
    /// CHECK: token account, validated by the Token-2022 CPI.
    #[account(mut)]
    pub token_account: UncheckedAccount<'info>,
    /// CHECK: the mint; decimals read via StateWithExtensions, validated by the CPI.
    pub mint: UncheckedAccount<'info>,
    /// CHECK: constrained to the Token-2022 program id.
    #[account(address = spl_token_2022::ID)]
    pub token_program: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct ApplyPendingBalance<'info> {
    /// Token account owner; must sign (validated by the Token-2022 CPI).
    pub owner: Signer<'info>,
    /// CHECK: token account, validated by the Token-2022 CPI.
    #[account(mut)]
    pub token_account: UncheckedAccount<'info>,
    /// CHECK: constrained to the Token-2022 program id.
    #[account(address = spl_token_2022::ID)]
    pub token_program: UncheckedAccount<'info>,
}

/// Shared body of init_mint_v1 / init_mint_v2. `v2_fee_elgamal` = Some(..) adds
/// PermanentDelegate, ConfidentialTransferMint (manual approval) and the
/// mandatory ConfidentialTransferFeeConfig. All extension inits run BEFORE
/// InitializeMint2; TokenMetadata::Initialize runs after.
#[allow(clippy::too_many_arguments)]
fn init_mint_impl(
    ctx: &Context<InitMintV1>,
    decimals: u8,
    fee_bps: u16,
    max_fee: u64,
    name: String,
    symbol: String,
    uri: String,
    v2_fee_elgamal: Option<[u8; 32]>,
) -> Result<()> {
    let mint = ctx.accounts.mint.key();
    let authority = ctx.accounts.authority.key();
    let token_program = ctx.accounts.token_program.key();

    let mut extensions = vec![
        ExtensionType::TransferFeeConfig,
        ExtensionType::MetadataPointer,
        ExtensionType::DefaultAccountState,
        ExtensionType::MintCloseAuthority,
    ];
    if v2_fee_elgamal.is_some() {
        extensions.push(ExtensionType::PermanentDelegate);
        extensions.push(ExtensionType::ConfidentialTransferMint);
        extensions.push(ExtensionType::ConfidentialTransferFeeConfig);
    }
    // InitializeMint enforces data_len == try_calculate_account_len(extensions),
    // so the account must be exactly this size — metadata grows the account
    // via realloc inside TokenMetadata::Initialize.
    let space =
        ExtensionType::try_calculate_account_len::<spl_token_2022::state::Mint>(&extensions)
            .map_err(|_| error!(ErrorCode::ExtensionSpaceCalc))?;
    // Metadata realloc "assumes there's enough SOL for the new
    // rent-exemption" — prefund the mint with rent for the final size.
    let metadata = spl_token_metadata_interface::state::TokenMetadata {
        update_authority: Some(authority)
            .try_into()
            .map_err(|_| error!(ErrorCode::ExtensionSpaceCalc))?,
        mint,
        name: name.clone(),
        symbol: symbol.clone(),
        uri: uri.clone(),
        additional_metadata: vec![],
    };
    let lamports = Rent::get()?.minimum_balance(
        space
            .checked_add(
                metadata
                    .tlv_size_of()
                    .map_err(|_| error!(ErrorCode::ExtensionSpaceCalc))?,
            )
            .ok_or_else(|| error!(ErrorCode::ExtensionSpaceCalc))?,
    );

    invoke(
        &system_instruction::create_account(
            &ctx.accounts.authority.key(),
            &mint,
            lamports,
            space as u64,
            &token_program,
        ),
        &[
            ctx.accounts.authority.to_account_info(),
            ctx.accounts.mint.to_account_info(),
            ctx.accounts.system_program.to_account_info(),
        ],
    )?;

    // Extension inits — ALL before InitializeMint.
    invoke(
        &spl_token_2022::extension::transfer_fee::instruction::initialize_transfer_fee_config(
            &token_program,
            &mint,
            Some(&authority),
            Some(&authority),
            fee_bps,
            max_fee,
        )?,
        &[ctx.accounts.mint.to_account_info()],
    )?;

    invoke(
        &spl_token_2022::extension::metadata_pointer::instruction::initialize(
            &token_program,
            &mint,
            Some(authority),
            Some(mint),
        )?,
        &[ctx.accounts.mint.to_account_info()],
    )?;

    invoke(
        &spl_token_2022::extension::default_account_state::instruction::initialize_default_account_state(
            &token_program,
            &mint,
            &spl_token_2022::state::AccountState::Frozen,
        )?,
        &[ctx.accounts.mint.to_account_info()],
    )?;

    invoke(
        &spl_token_2022::instruction::initialize_mint_close_authority(
            &token_program,
            &mint,
            Some(&authority),
        )?,
        &[ctx.accounts.mint.to_account_info()],
    )?;

    if let Some(fee_elgamal) = v2_fee_elgamal {
        invoke(
            &spl_token_2022::instruction::initialize_permanent_delegate(
                &token_program,
                &mint,
                &authority,
            )?,
            &[ctx.accounts.mint.to_account_info()],
        )?;

        // auto_approve_new_accounts = false: issuer must approve each account.
        // No auditor key (None).
        invoke(
            &spl_token_2022::extension::confidential_transfer::instruction::initialize_mint(
                &token_program,
                &mint,
                Some(authority),
                false,
                None,
            )?,
            &[ctx.accounts.mint.to_account_info()],
        )?;

        invoke(
            &spl_token_2022::extension::confidential_transfer_fee::instruction::initialize_confidential_transfer_fee_config(
                &token_program,
                &mint,
                Some(authority),
                spl_token_2022::solana_zk_token_sdk::zk_token_elgamal::pod::ElGamalPubkey(
                    fee_elgamal,
                ),
            )?,
            &[ctx.accounts.mint.to_account_info()],
        )?;
    }

    // InitializeMint LAST.
    invoke(
        &spl_token_2022::instruction::initialize_mint2(
            &token_program,
            &mint,
            &authority,
            Some(&authority),
            decimals,
        )?,
        &[ctx.accounts.mint.to_account_info()],
    )?;

    // Now that the mint is initialized, write the on-chain metadata into
    // the mint account itself (metadata_address == mint, set above).
    invoke(
        &spl_token_metadata_interface::instruction::initialize(
            &token_program,
            &mint,
            &authority,
            &mint,
            &authority,
            name,
            symbol,
            uri,
        ),
        &[
            ctx.accounts.mint.to_account_info(),
            ctx.accounts.authority.to_account_info(),
            ctx.accounts.mint.to_account_info(),
            ctx.accounts.authority.to_account_info(),
        ],
    )?;

    Ok(())
}

#[error_code]
pub enum ErrorCode {
    #[msg("Failed to calculate extension account length")]
    ExtensionSpaceCalc,
    #[msg("Mint account could not be parsed with extensions")]
    InvalidMintState,
    #[msg("Mint does not carry a TransferFeeConfig extension")]
    MissingTransferFeeConfig,
    #[msg("expected_fee does not match the mint's current-epoch transfer fee")]
    FeeMismatch,
}
