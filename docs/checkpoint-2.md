# Checkpoint 2 — Phase A complete, Phase B next

## Done

- `init_mint_v1(decimals, fee_bps, max_fee, name, symbol, uri)` in
  `programs/remittance-stablecoin/src/lib.rs`
- Tests green (2/2): extension stack assertions + new token account frozen
  by default. Output in `docs/test-output.txt`.

## Hard-won gotcha — mint account sizing

`InitializeMint` enforces
`ExtensionType::try_calculate_account_len(&extension_types) == mint.data_len()`
(spl-token-2022 3.0.5 `processor.rs` ~L88). So:

- Create the mint account with **exactly** the extension length.
- The TokenMetadata extension grows the account via `realloc` inside
  `TokenMetadata::Initialize` ("assumes there's enough SOL for the new
  rent-exemption") — therefore **prefund** the mint with
  `rent(space + metadata.tlv_size_of())` at create_account time.
- Instruction order is: extension inits → `initialize_mint2` →
  `token_metadata::initialize`.

## API notes (spl-token-2022 3.0.5)

- `initialize_mint_close_authority` lives at `spl_token_2022::instruction::*`,
  NOT under `extension::mint_close_authority` (no instruction submodule there).
- `OptionalNonZeroPubkey`: construct via `Some(pubkey).try_into()`.
- `TokenMetadata` has no `new()` — build the struct literal, use
  `tlv_size_of()` for the rent estimate.
- Direct deps added to program Cargo.toml: `spl-token-2022 3.0.5`,
  `spl-token-metadata-interface 0.3.5`, `spl-type-length-value 0.4.6`
  (all already pinned by the proven lockfile — no churn).

## Next — Phase B (RUNBOOK Session 2 continues)

1. `transfer_with_fee(amount)` — `transfer_checked_with_fee` CPI; expected fee
   via `calculate_epoch_fee(current_epoch, amount)` from mint state read with
   `StateWithExtensions`. spl-token-2022 3.0.5 path:
   `spl_token_2022::extension::transfer_fee::instruction::transfer_checked_with_fee`.
   Mint must be passed as writable and read via
   `StateWithExtensions::<Mint>` (never raw `Mint::unpack`).
2. `thaw_account` — `spl_token_2022::instruction::thaw_account` CPI signed by
   freeze authority; test that OTHER new accounts stay frozen.
3. Negative tests: wrong fee arg fails, frozen sender transfer fails,
   wrong thaw authority fails.

Notes for the implementer: `transfer_checked_with_fee` computes the real fee
inside token-2022; our instruction arg `expected_fee` only gates the max —
the test asserts the withheld amount equals
`calculate_epoch_fee(epoch, amount)`.

---

## Phase B — DONE

- `transfer_with_fee(amount, expected_fee)` in lib.rs: mint read via
  `StateWithExtensions::<Mint>` (+ `BaseStateWithExtensions` trait import —
  `get_extension` is a trait method, NOT inherent), fee =
  `TransferFeeConfig::calculate_epoch_fee(epoch, amount)`, which returns
  **`Option<u64>`** in 3.0.5 (checked, mapped to our error — no unwrap).
  Require arg == computed fee, then CPI
  `extension::transfer_fee::instruction::transfer_checked_with_fee` with mint
  writable.
- `thaw_account`: direct `spl_token_2022::instruction::thaw_account` CPI,
  freeze-authority signer. Per-account proven: sibling accounts stay frozen.
- Tests 7/7 green (`docs/test-output.txt`). Negatives: fee mismatch (our
  FeeMismatch 6003), frozen-sender transfer (token AccountFrozen 0x12),
  wrong thaw authority.

### Surprises

1. **Token-2022 rejects `mint_to` into a frozen account** (contrary to old
   lore). Test helper thaws via the program, mints, then re-freezes
   client-side (`createFreezeAccountInstruction`) — realistic end state.
2. Fee math: 50 bps of 1_000_000 = **5_000** (I first asserted 50_000 —
   off-by-10x in the test, not the program; program was always correct).
3. Anchor 0.30 u64 args must be `new anchor.BN(...)` on the client.
4. Frozen transfer error surfaces as raw "Account is frozen"/0x12, and
   anchor sometimes can't translate it — tests accept either form.

### Next — Phase C (resume commands)

```
~/.avm/bin/anchor-0.30.1 build
~/.avm/bin/anchor-0.30.1 test
```
Phase C: `init_mint_v2` (+PermanentDelegate, +ConfidentialTransferMint with
`auto_approve_new_accounts=false`), then full confidential transfer lifecycle.
