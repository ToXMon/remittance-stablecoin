import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { RemittanceStablecoin } from "../target/types/remittance_stablecoin";
import {
  TOKEN_2022_PROGRAM_ID,
  createAssociatedTokenAccount,
  createMintToInstruction,
  createFreezeAccountInstruction,
  getAccount,
  getMint,
  getTransferFeeConfig,
  getMetadataPointerState,
  getMintCloseAuthority,
  getTokenMetadata,
  getDefaultAccountState,
  getTransferFeeAmount,
  getPermanentDelegate,
  getExtensionTypes,
  getExtensionData,
  ExtensionType,
} from "@solana/spl-token";
import { Keypair, PublicKey, sendAndConfirmTransaction, Transaction } from "@solana/web3.js";
import { assert } from "chai";

describe("remittance-stablecoin", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace
    .remittanceStablecoin as Program<RemittanceStablecoin>;
  const payer = provider.wallet as anchor.Wallet;

  const DECIMALS = 6;
  const FEE_BPS = 50; // 0.5% protocol fee
  const MAX_FEE = new anchor.BN(1_000_000); // 1 token cap

  const mint = Keypair.generate();

  it("init_mint_v1 stacks all four extensions", async () => {
    await program.methods
      .initMintV1(
        DECIMALS,
        FEE_BPS,
        MAX_FEE,
        "Remittance USD",
        "rUSD",
        "https://example.com/rusd.json"
      )
      .accounts({
        authority: payer.publicKey,
        mint: mint.publicKey,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
      })
      .signers([mint])
      .rpc();

    const mintInfo = await getMint(
      provider.connection,
      mint.publicKey,
      undefined,
      TOKEN_2022_PROGRAM_ID
    );
    assert.equal(mintInfo.decimals, DECIMALS);
    assert.equal(
      mintInfo.freezeAuthority?.toBase58(),
      payer.publicKey.toBase58()
    );

    // TransferFeeConfig
    const feeConfig = getTransferFeeConfig(mintInfo)!;
    assert.equal(feeConfig.newerTransferFee.transferFeeBasisPoints, FEE_BPS);
    assert.equal(
      feeConfig.transferFeeConfigAuthority?.toBase58(),
      payer.publicKey.toBase58()
    );

    // MetadataPointer -> mint itself
    const pointer = getMetadataPointerState(mintInfo)!;
    assert.equal(
      pointer.metadataAddress?.toBase58(),
      mint.publicKey.toBase58()
    );

    // On-chain metadata readable without an off-chain registry
    const metadata = await getTokenMetadata(
      provider.connection,
      mint.publicKey,
      undefined,
      TOKEN_2022_PROGRAM_ID
    );
    assert.equal(metadata!.name, "Remittance USD");
    assert.equal(metadata!.symbol, "rUSD");

    // DefaultAccountState = Frozen
    const das = getDefaultAccountState(mintInfo)!;
    assert.equal(das.state, 2 /* AccountState.Frozen */);

    // MintCloseAuthority
    const closeAuth = getMintCloseAuthority(mintInfo)!;
    assert.equal(
      closeAuth.closeAuthority?.toBase58(),
      payer.publicKey.toBase58()
    );
  });

  it("new token accounts are frozen by default (pre-KYC)", async () => {
    const holder = Keypair.generate();
    const ata = await createAssociatedTokenAccount(
      provider.connection,
      payer.payer,
      mint.publicKey,
      holder.publicKey,
      undefined,
      TOKEN_2022_PROGRAM_ID
    );
    const acct = await getAccount(
      provider.connection,
      ata,
      undefined,
      TOKEN_2022_PROGRAM_ID
    );
    assert.isTrue(acct.isFrozen);
  });

  const MINT_AMOUNT = new anchor.BN(1_000_000_000); // 1000 rUSD
  const TRANSFER_AMOUNT = 1_000_000; // 1 rUSD
  const EXPECTED_FEE = 5_000; // 50 bps of 1 rUSD, below the 1-token cap

  const createFrozenAta = async (owner: Keypair) => {
    const ata = await createAssociatedTokenAccount(
      provider.connection,
      payer.payer,
      mint.publicKey,
      owner.publicKey,
      undefined,
      TOKEN_2022_PROGRAM_ID
    );
    // Token-2022 rejects mint_to into a frozen account, so: thaw via the
    // program, mint, then re-freeze client-side with the freeze authority.
    await program.methods
      .thawAccount()
      .accounts({
        freezeAuthority: payer.publicKey,
        tokenAccount: ata,
        mint: mint.publicKey,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
      })
      .rpc();
    await sendAndConfirmTransaction(
      provider.connection,
      new Transaction().add(
        createMintToInstruction(
          mint.publicKey,
          ata,
          payer.publicKey,
          MINT_AMOUNT.toNumber(),
          [],
          TOKEN_2022_PROGRAM_ID
        )
      ),
      [payer.payer]
    );
    await sendAndConfirmTransaction(
      provider.connection,
      new Transaction().add(
        createFreezeAccountInstruction(
          ata,
          mint.publicKey,
          payer.publicKey,
          [],
          TOKEN_2022_PROGRAM_ID
        )
      ),
      [payer.payer]
    );
    return ata;
  };

  it("thaw_account unfreezes one account; other accounts stay frozen", async () => {
    const holder = Keypair.generate();
    const recipient = Keypair.generate();
    const holderAta = await createFrozenAta(holder);
    const recipientAta = await createFrozenAta(recipient);

    await program.methods
      .thawAccount()
      .accounts({
        freezeAuthority: payer.publicKey,
        tokenAccount: holderAta,
        mint: mint.publicKey,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
      })
      .rpc();

    const thawed = await getAccount(
      provider.connection,
      holderAta,
      undefined,
      TOKEN_2022_PROGRAM_ID
    );
    assert.isFalse(thawed.isFrozen);

    // Per-account control: the recipient account was NOT thawed.
    const stillFrozen = await getAccount(
      provider.connection,
      recipientAta,
      undefined,
      TOKEN_2022_PROGRAM_ID
    );
    assert.isTrue(stillFrozen.isFrozen);
  });

  it("thaw_account with the wrong authority fails", async () => {
    const holder = Keypair.generate();
    const ata = await createFrozenAta(holder);
    const wrongAuthority = Keypair.generate();

    try {
      await program.methods
        .thawAccount()
        .accounts({
          freezeAuthority: wrongAuthority.publicKey,
          tokenAccount: ata,
          mint: mint.publicKey,
          tokenProgram: TOKEN_2022_PROGRAM_ID,
        })
        .signers([wrongAuthority])
        .rpc();
      assert.fail("thaw with wrong authority should have failed");
    } catch (err) {
      // Token-2022 rejects: signer is neither account owner nor freeze authority.
      assert.include(String(err), "custom program error");
    }
  });

  it("transfer_with_fee moves tokens and withholds the epoch fee", async () => {
    const holder = Keypair.generate();
    const recipient = Keypair.generate();
    const holderAta = await createFrozenAta(holder);
    const recipientAta = await createFrozenAta(recipient);

    // Thaw both ends — frozen accounts cannot send OR receive.
    for (const ata of [holderAta, recipientAta]) {
      await program.methods
        .thawAccount()
        .accounts({
          freezeAuthority: payer.publicKey,
          tokenAccount: ata,
          mint: mint.publicKey,
          tokenProgram: TOKEN_2022_PROGRAM_ID,
        })
        .rpc();
    }

    await program.methods
      .transferWithFee(new anchor.BN(TRANSFER_AMOUNT), new anchor.BN(EXPECTED_FEE))
      .accounts({
        authority: holder.publicKey,
        source: holderAta,
        mint: mint.publicKey,
        destination: recipientAta,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
      })
      .signers([holder])
      .rpc();

    const dest = await getAccount(
      provider.connection,
      recipientAta,
      undefined,
      TOKEN_2022_PROGRAM_ID
    );
    // Recipient was pre-funded with MINT_AMOUNT by the helper; net +995000.
    assert.equal(
      dest.amount.toString(),
      (MINT_AMOUNT.toNumber() + TRANSFER_AMOUNT - EXPECTED_FEE).toString()
    );

    // Fee withheld on the destination, per calculate_epoch_fee.
    const feeAmount = getTransferFeeAmount(dest);
    assert.equal(
      feeAmount.withheldAmount.toString(),
      EXPECTED_FEE.toString()
    );
  });

  it("transfer_with_fee with a mismatched expected fee fails", async () => {
    const holder = Keypair.generate();
    const recipient = Keypair.generate();
    const holderAta = await createFrozenAta(holder);
    const recipientAta = await createFrozenAta(recipient);
    for (const ata of [holderAta, recipientAta]) {
      await program.methods
        .thawAccount()
        .accounts({
          freezeAuthority: payer.publicKey,
          tokenAccount: ata,
          mint: mint.publicKey,
          tokenProgram: TOKEN_2022_PROGRAM_ID,
        })
        .rpc();
    }

    try {
      await program.methods
        .transferWithFee(new anchor.BN(TRANSFER_AMOUNT), new anchor.BN(EXPECTED_FEE + 1))
        .accounts({
          authority: holder.publicKey,
          source: holderAta,
          mint: mint.publicKey,
          destination: recipientAta,
          tokenProgram: TOKEN_2022_PROGRAM_ID,
        })
        .signers([holder])
        .rpc();
      assert.fail("mismatched fee should have failed");
    } catch (err) {
      assert.include(String(err), "FeeMismatch");
    }
  });

  it("transfer from a frozen sender fails", async () => {
    const frozenHolder = Keypair.generate();
    const recipient = Keypair.generate();
    const frozenAta = await createFrozenAta(frozenHolder);
    const recipientAta = await createAssociatedTokenAccount(
      provider.connection,
      payer.payer,
      mint.publicKey,
      recipient.publicKey,
      undefined,
      TOKEN_2022_PROGRAM_ID
    );
    // Thaw only the recipient — the sender stays frozen.

    try {
      await program.methods
        .transferWithFee(new anchor.BN(TRANSFER_AMOUNT), new anchor.BN(EXPECTED_FEE))
        .accounts({
          authority: frozenHolder.publicKey,
          source: frozenAta,
          mint: mint.publicKey,
          destination: recipientAta,
          tokenProgram: TOKEN_2022_PROGRAM_ID,
        })
        .signers([frozenHolder])
        .rpc();
      assert.fail("transfer from frozen sender should have failed");
    } catch (err) {
      // Token-2022 AccountFrozen — surfaces as 0x12 or "Account is frozen".
      const msg = String(err);
      assert.isTrue(msg.includes("0x12") || /frozen/i.test(msg), `unexpected error: ${msg}`);
    }
  });
  // ---- Phase C: v2 mint (PermanentDelegate + ConfidentialTransferMint) ----
  const mintV2 = Keypair.generate();
  // Valid ElGamal (Ristretto) pubkey, generated by spl-token CLI 5.6.1; only
  // its public half is needed (encrypts confidential fee amounts).
  const FEE_ELGAMAL_PUBKEY = Array.from(
    Buffer.from("rgON8+ajn/ZlWvAhICZS3myL8JDCLmWEtvoK6hikU2k=", "base64")
  );

  it("init_mint_v2 adds PermanentDelegate + ConfidentialTransferMint (manual approve)", async () => {
    await program.methods
      .initMintV2(
        DECIMALS,
        FEE_BPS,
        MAX_FEE,
        "Remittance USD v2",
        "rUSD2",
        "https://example.com/rusd2.json",
        FEE_ELGAMAL_PUBKEY
      )
      .accounts({
        authority: payer.publicKey,
        mint: mintV2.publicKey,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
      })
      .signers([mintV2])
      .rpc();

    const mintInfo = await getMint(
      provider.connection,
      mintV2.publicKey,
      undefined,
      TOKEN_2022_PROGRAM_ID
    );
    const types = getExtensionTypes(mintInfo.tlvData);
    for (const t of [
      ExtensionType.TransferFeeConfig,
      ExtensionType.MetadataPointer,
      ExtensionType.DefaultAccountState,
      ExtensionType.MintCloseAuthority,
      ExtensionType.PermanentDelegate,
      ExtensionType.ConfidentialTransferMint,
      16 as ExtensionType, // ConfidentialTransferFeeConfig (not named in spl-token 0.4.15)
      ExtensionType.TokenMetadata,
    ]) {
      assert.include(types, t, `missing extension ${t}`);
    }

    const pd = getPermanentDelegate(mintInfo)!;
    assert.equal(pd.delegate.toBase58(), payer.publicKey.toBase58());

    // ConfidentialTransferMint layout: authority(32) | auto_approve(1) | auditor(32)
    const ct = getExtensionData(
      ExtensionType.ConfidentialTransferMint,
      mintInfo.tlvData
    )!;
    assert.equal(
      new PublicKey(ct.subarray(0, 32)).toBase58(),
      payer.publicKey.toBase58()
    );
    assert.equal(ct[32], 0, "auto_approve_new_accounts must be false");
  });
});
