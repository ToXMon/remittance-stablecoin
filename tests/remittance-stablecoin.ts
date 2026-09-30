import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { RemittanceStablecoin } from "../target/types/remittance_stablecoin";
import {
  TOKEN_2022_PROGRAM_ID,
  createAssociatedTokenAccount,
  getAccount,
  getMint,
  getTransferFeeConfig,
  getMetadataPointerState,
  getMintCloseAuthority,
  getTokenMetadata,
  getDefaultAccountState,
} from "@solana/spl-token";
import { Keypair } from "@solana/web3.js";
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
});
