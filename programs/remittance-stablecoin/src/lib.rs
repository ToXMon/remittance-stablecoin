use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::invoke;
use anchor_lang::solana_program::system_instruction;
use spl_token_2022::extension::ExtensionType;

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
        let mint = ctx.accounts.mint.key();
        let authority = ctx.accounts.authority.key();
        let token_program = ctx.accounts.token_program.key();

        // Space for the mint + all four extensions, computed by Token-2022
        // rather than hand-rolled math.
        let extensions = &[
            ExtensionType::TransferFeeConfig,
            ExtensionType::MetadataPointer,
            ExtensionType::DefaultAccountState,
            ExtensionType::MintCloseAuthority,
        ];
        // InitializeMint enforces data_len == try_calculate_account_len(extensions),
        // so the account must be exactly this size — metadata grows the account
        // via realloc inside TokenMetadata::Initialize.
        let space =
            ExtensionType::try_calculate_account_len::<spl_token_2022::state::Mint>(extensions)
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
            space + metadata
                .tlv_size_of()
                .map_err(|_| error!(ErrorCode::ExtensionSpaceCalc))?,
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

#[error_code]
pub enum ErrorCode {
    #[msg("Failed to calculate extension account length")]
    ExtensionSpaceCalc,
}
