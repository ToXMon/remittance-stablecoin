# Checkpoint 3 — Phase C done, Phase D next

Date: 2026-09-30. Tests: **11/11 green** (`docs/test-output.txt`).

## Done

- `init_mint_v2(decimals, fee_bps, max_fee, name, symbol, uri, fee_withdraw_elgamal_pubkey[32])`
  — v1 stack + PermanentDelegate (issuer) + ConfidentialTransferMint
  (`auto_approve_new_accounts=false`, no auditor) + **ConfidentialTransferFeeConfig**.
  v1/v2 share `init_mint_impl` (outside `#[program]`); v1 behavior unchanged.
- `deposit_confidential(amount)` — CPI `confidential_transfer::instruction::deposit`;
  decimals read from the mint via `StateWithExtensions`.
- `apply_pending_balance(expected_counter, new_decryptable_available_balance[36])`
  — CPI `inner_apply_pending_balance`. Args come from the client (AES ciphertext
  derives from the owner's secret key; impossible on-chain).
- Tests: v2 extension stack; manual-approve gating (deposit before approve →
  0x18 `ConfidentialTransferAccountNotApproved`); deposit → pending visible;
  CLI apply → withdraw; CPI apply; non-owner apply rejected; ZK-proof transfer
  control.

## Surprises (in order of pain)

1. **Built-in Token-2022 in solana-test-validator 4.2.2 has no `zk-ops`.**
   Confidential Deposit/Withdraw/Transfer/ApplyPending return
   `InvalidInstructionData` (~1k CUs). Fix: `[[test.genesis]]` in Anchor.toml
   overrides Token-2022 with a mainnet dump
   (`tests/fixtures/token_2022_mainnet.so`, dumped 2026-09-30). ZK ElGamal proof
   program is present and its features are active at genesis — no "unknown
   program" issues once Token-2022 is swapped.
2. **TransferFeeConfig + ConfidentialTransferMint requires
   ConfidentialTransferFeeConfig** (else InitializeMint2 →
   `InvalidExtensionCombination` 0x33). Added; needs an ElGamal pubkey for the
   fee-withdraw authority. Test uses a valid public key produced by the CLI
   (`rgON8+ajn/...`); its secret is unknown, so **withheld confidential fees
   cannot be withdrawn** on that mint. Phase D: generate a real key.
3. **Confidential *transfer* on a fee mint is not possible with tooling here.**
   spl-token CLI 5.6.1 panics "Confidential transfer with fee is not yet
   supported"; `@solana/spl-token` 0.4.15 has no confidential client at all
   (just the `ExtensionType` enum; `ConfidentialTransferFeeConfig`=16 isn't even
   named). So the v2 lifecycle test stops at deposit → apply → withdraw, and
   the ZK transfer is proven on a **control mint without TransferFee** via CLI
   (alice → bob; balances verified black-box via exact-amount withdraw proofs,
   1 extra unit fails). Real v2 transfer needs `TransferWithFee` split proofs →
   a Rust helper with `spl-token-confidential-transfer-proof-generation`
   (0.5.1 is in the cargo cache). No JS decrypt helper exists either, so
   "decrypted balance" is asserted via withdraw proofs, not plaintext.
4. CLI 5.6.1 has no `approve-confidential-transfer-account`; approval is a raw
   instruction (`[27, 3]`, accounts: account w, mint r, authority signer) built
   in the test.
5. Token-2022 does not validate `expected_pending_balance_credit_counter` nor
   the AES ciphertext; it just records them. A program passing a placeholder
   succeeds and corrupts the owner's decryptable balance (test `holder2` does
   this deliberately on a throwaway account).
6. Side effect: I temporarily ran `solana config set -u localhost -k a.json`
   while probing; keypair was restored to `~/.config/solana/id.json`, but the
   **RPC URL is still `localhost`** (prior value unknown) — reset if needed.

## Migration gap (why v2 is a new mint)

Extensions can only be added at mint creation (before InitializeMint). There is
no way to add PermanentDelegate or ConfidentialTransferMint to the v1 mint. A
"re-issue" therefore means: new mint pubkey → new ATAs for every holder →
freeze/burn v1 supply and mint the same balances on v2 (or a wrapper/redeem
program) → integrators, metadata, fee configs, and off-chain indexes repointed.
Holders in v1 with DefaultAccountState=Frozen need re-thaw (KYC) on v2 too.
Design lesson: decide the extension set up front; PermanentDelegate is the
usual "we wish we had it" one.

## Resume commands

```
~/.avm/bin/anchor-0.30.1 build
~/.avm/bin/anchor-0.30.1 test        # needs `spl-token` (5.6.1) on PATH
```
Anchor validator sometimes needs a retry right after a previous run
("Test validator does not look started") — just rerun.

## Next — Phase D

Pick per RUNBOOK; suggested carry-overs: (a) Rust proof helper for confidential
`TransferWithFee` on the v2 mint + real fee-withdraw ElGamal key; (b) PermanentDelegate
demo (burn/transfer by delegate) using the v2 mint; (c) migration/redeem
program v1 → v2.
