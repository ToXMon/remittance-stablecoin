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
  getAssociatedTokenAddressSync,
  createApproveCheckedInstruction,
  createReallocateInstruction,
  enableCpiGuard,
  getCpiGuard,
} from "@solana/spl-token";
import {
  Keypair,
  PublicKey,
  sendAndConfirmTransaction,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import { assert } from "chai";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

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

  // ---- Phase C: confidential lifecycle ----
  // @solana/spl-token 0.4.15 has NO confidential-transfer client (only the
  // ExtensionType enum), so ZK-proof steps are driven by the spl-token CLI
  // (5.6.1). Proof-free steps (deposit/apply) go through our program's CPI.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ct-"));
  const writeKeypair = (name: string, kp: Keypair) => {
    const f = path.join(tmpDir, `${name}.json`);
    fs.writeFileSync(f, JSON.stringify(Array.from(kp.secretKey)), { mode: 0o600 });
    return f;
  };
  const payerFile = () => writeKeypair("payer", payer.payer);
  const cli = (args: string[]) =>
    execFileSync(
      "spl-token",
      ["-u", provider.connection.rpcEndpoint, "--fee-payer", payerFile(), ...args],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
    );
  after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  // ConfidentialTransferAccount TLV (spl-token-2022 3.0.5 layout):
  // approved(1) elgamal(32) pending_lo(64) pending_hi(64) available(64)
  // decryptable(36) credits_ok(1) noncf_ok(1) pending_ctr(8) max(8) exp(8) act(8)
  const ctAccount = async (ata: PublicKey) => {
    const acct = await getAccount(provider.connection, ata, undefined, TOKEN_2022_PROGRAM_ID);
    const d = getExtensionData(ExtensionType.ConfidentialTransferAccount, acct.tlvData)!;
    const isZero = (b: Uint8Array) => b.every((x) => x === 0);
    return {
      publicAmount: acct.amount,
      approved: d[0] === 1,
      pendingLoZero: isZero(d.subarray(33, 97)),
      availableZero: isZero(d.subarray(161, 225)),
      decryptable: Buffer.from(d.subarray(225, 261)).toString("hex"),
      pendingCounter: Buffer.from(d.subarray(263, 271)).readBigUInt64LE(),
      expectedCounter: Buffer.from(d.subarray(279, 287)).readBigUInt64LE(),
      actualCounter: Buffer.from(d.subarray(287, 295)).readBigUInt64LE(),
    };
  };
  // Issuer ApproveAccount (no proof): TokenInstruction 27 + ct-sub-ix 3.
  const approveIx = (ata: PublicKey, m: PublicKey) =>
    new TransactionInstruction({
      programId: TOKEN_2022_PROGRAM_ID,
      keys: [
        { pubkey: ata, isSigner: false, isWritable: true },
        { pubkey: m, isSigner: false, isWritable: false },
        { pubkey: payer.publicKey, isSigner: true, isWritable: false },
      ],
      data: Buffer.from([27, 3]),
    });

  // v2 account: create (frozen by default) -> thaw -> fund publicly -> configure CT.
  const CT_FUND = 1_000_000_000; // 1000 rUSD
  const setupV2Holder = async (name: string) => {
    const owner = Keypair.generate();
    const ownerFile = writeKeypair(name, owner);
    // spl-token CLI withdraw fails with "InsufficientFunds" if the owner
    // itself holds no lamports (it funds proof-context rent), so seed it.
    await provider.connection.confirmTransaction(
      await provider.connection.requestAirdrop(owner.publicKey, 100_000_000)
    );
    const ata = await createAssociatedTokenAccount(
      provider.connection, payer.payer, mintV2.publicKey, owner.publicKey,
      undefined, TOKEN_2022_PROGRAM_ID
    );
    await program.methods
      .thawAccount()
      .accounts({
        freezeAuthority: payer.publicKey,
        tokenAccount: ata,
        mint: mintV2.publicKey,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
      })
      .rpc();
    await sendAndConfirmTransaction(
      provider.connection,
      new Transaction().add(
        createMintToInstruction(mintV2.publicKey, ata, payer.publicKey, CT_FUND, [], TOKEN_2022_PROGRAM_ID)
      ),
      [payer.payer]
    );
    cli(["configure-confidential-transfer-account", mintV2.publicKey.toBase58(), "--owner", ownerFile]);
    return { owner, ownerFile, ata };
  };
  const depositViaProgram = (h: { owner: Keypair; ata: PublicKey }, amount: number) =>
    program.methods
      .depositConfidential(new anchor.BN(amount))
      .accounts({
        owner: h.owner.publicKey,
        tokenAccount: h.ata,
        mint: mintV2.publicKey,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
      })
      .signers([h.owner])
      .rpc();

  it("v2 lifecycle: manual approve gates deposit; deposit -> apply -> withdraw", async () => {
    const h = await setupV2Holder("holder1");
    const mintStr = mintV2.publicKey.toBase58();

    // Manual policy (auto_approve=false): configured but NOT approved.
    let st = await ctAccount(h.ata);
    assert.isFalse(st.approved, "account must start unapproved");
    try {
      await depositViaProgram(h, 400_000_000);
      assert.fail("deposit into an unapproved account must fail");
    } catch (err) {
      // TokenError::ConfidentialTransferAccountNotApproved = 0x18
      assert.match(String(err), /0x18|not approved/i);
    }

    // Issuer approves -> deposit now works through our CPI.
    await sendAndConfirmTransaction(
      provider.connection,
      new Transaction().add(approveIx(h.ata, mintV2.publicKey)),
      [payer.payer]
    );
    assert.isTrue((await ctAccount(h.ata)).approved);
    await depositViaProgram(h, 400_000_000);

    // Pending balance visible after deposit; public balance dropped.
    st = await ctAccount(h.ata);
    assert.equal(st.publicAmount.toString(), (CT_FUND - 400_000_000).toString());
    assert.equal(st.pendingCounter, 1n);
    assert.isFalse(st.pendingLoZero, "pending ciphertext must be non-zero");
    assert.isTrue(st.availableZero, "available still zero before apply");

    // CLI computes the AES-encrypted new balance from the owner's keys.
    cli(["apply-pending-balance", mintStr, "--owner", h.ownerFile]);
    st = await ctAccount(h.ata);
    assert.equal(st.pendingCounter, 0n);
    assert.isTrue(st.pendingLoZero);
    assert.isFalse(st.availableZero, "available ciphertext populated");

    // Black-box decrypted-balance check: withdraw needs an equality proof
    // against the decrypted available balance. Exactly 400 succeeds...
    cli(["withdraw-confidential-tokens", mintStr, "400", "--owner", h.ownerFile]);
    st = await ctAccount(h.ata);
    assert.equal(st.publicAmount.toString(), CT_FUND.toString());
    // ...and 1 more is impossible: available is now exactly 0.
    assert.throws(() =>
      cli(["withdraw-confidential-tokens", mintStr, "1", "--owner", h.ownerFile])
    );
  });

  it("v2: apply_pending_balance CPI succeeds with the current counter", async () => {
    const h = await setupV2Holder("holder2");
    await sendAndConfirmTransaction(
      provider.connection,
      new Transaction().add(approveIx(h.ata, mintV2.publicKey)),
      [payer.payer]
    );
    await depositViaProgram(h, 100_000_000);
    assert.equal((await ctAccount(h.ata)).pendingCounter, 1n);

    // Token-2022 cannot verify the AES ciphertext (only the owner can), so a
    // placeholder is accepted structurally. A real client MUST send the true
    // ciphertext; this asserts the CPI wiring, not client crypto.
    const placeholder = Array.from({ length: 36 }, (_, i) => i + 1);

    // A non-owner cannot apply: Token-2022 rejects the signer.
    const intruder = Keypair.generate();
    try {
      await program.methods
        .applyPendingBalance(new anchor.BN(1), placeholder)
        .accounts({
          owner: intruder.publicKey,
          tokenAccount: h.ata,
          tokenProgram: TOKEN_2022_PROGRAM_ID,
        })
        .signers([intruder])
        .rpc();
      assert.fail("non-owner apply must fail");
    } catch (err) {
      assert.include(String(err), "custom program error");
    }
    await program.methods
      .applyPendingBalance(new anchor.BN(1), placeholder)
      .accounts({
        owner: h.owner.publicKey,
        tokenAccount: h.ata,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
      })
      .signers([h.owner])
      .rpc();
    const st = await ctAccount(h.ata);
    assert.equal(st.pendingCounter, 0n);
    assert.equal(st.expectedCounter, 1n); // recorded, not validated, by Token-2022
    assert.equal(st.actualCounter, 1n);
    assert.isFalse(st.availableZero);
    assert.equal(st.decryptable, Buffer.from(placeholder).toString("hex"));
  });

  it("control: confidential transfer with real ZK proofs (no-fee CT mint)", async () => {
    // A v2 mint carries TransferFeeConfig, and spl-token CLI 5.6.1 panics with
    // "Confidential transfer with fee is not yet supported". This control mint
    // (no fee ext) proves the ZK-proof path works on the validator.
    const alice = Keypair.generate();
    const bob = Keypair.generate();
    const aliceFile = writeKeypair("alice", alice);
    const bobFile = writeKeypair("bob", bob);
    const out = cli([
      "create-token", "--program-2022", "--decimals", "6",
      "--enable-confidential-transfers", "auto",
      "--mint-authority", payerFile(),
    ]);
    const cm = out.match(/Address:\s+(\w+)/)![1];
    const aliceAta = getAssociatedTokenAddressSync(
      new PublicKey(cm), alice.publicKey, false, TOKEN_2022_PROGRAM_ID
    );
    const bobAta = getAssociatedTokenAddressSync(
      new PublicKey(cm), bob.publicKey, false, TOKEN_2022_PROGRAM_ID
    );
    for (const f of [aliceFile, bobFile]) {
      cli(["create-account", cm, "--owner", f]);
      cli(["configure-confidential-transfer-account", cm, "--owner", f]);
    }
    cli(["mint", cm, "100", aliceAta.toBase58(), "--mint-authority", payerFile()]);
    cli(["deposit-confidential-tokens", cm, "50", "--owner", aliceFile]);
    cli(["apply-pending-balance", cm, "--owner", aliceFile]);

    // Confidential transfer: equality + ciphertext-validity + range proofs.
    cli(["transfer", cm, "10", bob.publicKey.toBase58(), "--confidential", "--allow-unfunded-recipient", "--owner", aliceFile]);
    assert.equal((await ctAccount(bobAta)).pendingCounter, 1n, "bob has pending credit");
    cli(["apply-pending-balance", cm, "--owner", bobFile]);

    // Decrypted-balance checks via withdraw proofs (exact amounts only).
    cli(["withdraw-confidential-tokens", cm, "10", "--owner", bobFile]);
    assert.equal((await ctAccount(bobAta)).publicAmount.toString(), "10000000");
    assert.throws(() => cli(["withdraw-confidential-tokens", cm, "1", "--owner", bobFile]));

    cli(["withdraw-confidential-tokens", cm, "40", "--owner", aliceFile]);
    assert.equal((await ctAccount(aliceAta)).publicAmount.toString(), "90000000");
    assert.throws(() => cli(["withdraw-confidential-tokens", cm, "1", "--owner", aliceFile]));
  });

  // ---- Phase D: PDA delegate survives CPI Guard ----
  it("delegate_transfer via PDA delegate still works after the user enables CPI Guard", async () => {
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
    const [delegatePda] = PublicKey.findProgramAddressSync(
      [Buffer.from("delegate")],
      program.programId
    );

    // User (top-level, not CPI) approves the program's PDA for 3 rUSD.
    await sendAndConfirmTransaction(
      provider.connection,
      new Transaction().add(
        createApproveCheckedInstruction(
          holderAta, mint.publicKey, delegatePda, holder.publicKey,
          3 * TRANSFER_AMOUNT, DECIMALS, [], TOKEN_2022_PROGRAM_ID
        )
      ),
      [payer.payer, holder]
    );

    const delegateTransfer = () =>
      program.methods
        .delegateTransfer(new anchor.BN(TRANSFER_AMOUNT), new anchor.BN(EXPECTED_FEE))
        .accounts({
          delegate: delegatePda,
          source: holderAta,
          mint: mint.publicKey,
          destination: recipientAta,
          tokenProgram: TOKEN_2022_PROGRAM_ID,
        })
        .rpc();
    const balance = async (ata: PublicKey) =>
      (await getAccount(provider.connection, ata, undefined, TOKEN_2022_PROGRAM_ID)).amount;

    // 1) Works before CPI Guard.
    const before = await balance(holderAta);
    await delegateTransfer();
    assert.equal((before - (await balance(holderAta))).toString(), TRANSFER_AMOUNT.toString());

    // 2) User enables CPI Guard (needs the CpiGuard extension allocated first).
    await sendAndConfirmTransaction(
      provider.connection,
      new Transaction().add(
        createReallocateInstruction(
          holderAta, payer.publicKey, [ExtensionType.CpiGuard], holder.publicKey,
          [], TOKEN_2022_PROGRAM_ID
        )
      ),
      [payer.payer, holder]
    );
    await enableCpiGuard(
      provider.connection, payer.payer, holderAta, holder, [], undefined, TOKEN_2022_PROGRAM_ID
    );
    const guarded = await getAccount(provider.connection, holderAta, undefined, TOKEN_2022_PROGRAM_ID);
    assert.isTrue(getCpiGuard(guarded)!.lockCpi);

    // 3) Same, unmodified delegate path still works.
    const mid = await balance(holderAta);
    await delegateTransfer();
    assert.equal((mid - (await balance(holderAta))).toString(), TRANSFER_AMOUNT.toString());

    // 4) Contrast: an owner-signed transfer through our program's CPI is now blocked.
    try {
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
      assert.fail("owner-signed CPI transfer should be blocked by CPI Guard");
    } catch (err) {
      assert.include(String(err), "custom program error");
    }
  });
});
