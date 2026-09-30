# Checkpoint 4 — Phase D done, homework complete

Date: 2026-09-30. Final run: **14 passing** (`docs/test-output.txt`, exit 0).

## Done

- `delegate_transfer(amount, expected_fee)`: PDA delegate (`seeds = ["delegate"]`,
  canonical bump re-verified by the `bump` constraint, `invoke_signed`). Test:
  user Approves the PDA, transfer works, user enables CPI Guard (reallocate
  CpiGuard extension, then enable), the same delegate path still works, and an
  owner-signed CPI transfer through our program is now blocked.
- Two evidence tests for the finding: permanent delegate burns only the
  plaintext balance (a further 1-unit burn fails, encrypted pending balance
  survives); freezing an account blocks confidential deposits.
- `docs/FINDING.md`, `docs/X-POST.md` (5-post thread + LinkedIn),
  `docs/x-post-image.png` (real screenshot of the passing `anchor test` run, 14 green checks; replaced the earlier PIL render),
  `README.md`.

## Screenshot for submission

Run this in a terminal window, then screenshot (Cmd+Shift+4) the final block:

```
cd /Users/tolushekoni/sb2026/remittance-stablecoin && ~/.avm/bin/anchor-0.30.1 test 2>&1 | tail -25
```

(If it prints "Test validator does not look started", wait a few seconds and rerun.)

## Surprises

1. A flaky `InsufficientFunds` from `spl-token withdraw-confidential-tokens`
   appeared after Phase C passed. Funding the owner with SOL was a red herring
   (flake returned). Working theory, not proven: anchor's `rpc()` returns at a
   weaker commitment than the CLI reads (`confirmed`), so the CLI applied a
   stale pending balance and computed a wrong decryptable balance. The test now
   waits for the pending counter at `confirmed` before the CLI apply. 14/14 passed
   on three consecutive runs afterwards.
2. CPI Guard needs the account reallocated with the CpiGuard extension before it
   can be enabled; a PDA delegate is unaffected by it, an owner CPI is blocked.
3. The JS client names no `ConfidentialTransferFeeConfig` (type 16 used numerically).

## State

Homework complete. Nothing pending. Untouched scratch: `docs/build-2.log`,
`docs/test-output-b.log`. Replace `<REPO_URL>` in `docs/X-POST.md` before posting.
