# Remittance Stablecoin — Homework Runbook

Token-2022 homework: protocol transfer fee, KYC freeze gating, on-chain metadata,
mint close authority, re-issue with PermanentDelegate + ConfidentialTransfer, full
confidential lifecycle, optional CPI-Guard delegation challenge, and a written
seizure-gap finding.

**Execution model: one fresh agent session per phase.** Each phase commits a
checkpoint file (`docs/checkpoint-N.md`); the next session reads checkpoints
instead of carrying conversation history. This keeps context small and prevents
SBF build-log noise from poisoning the session.

## Homework deliverables

- Repository with README (this directory, filled by Session 4)
- Screenshot of all tests passing
- Optional: X/LinkedIn post of the written finding

## Session prompts

Start each phase in a **new agent session** with the matching prompt below.
Do not skip the READ FIRST blocks — they are sized to be cheap (~3k tokens)
and prevent expensive rediscovery.

### Session 1 — Scaffold + green build

```
We are starting a Solana Token-2022 homework in /Users/tolushekoni/sb2026.

READ FIRST (in this order, nothing else):
1. /Users/tolushekoni/sb2026/amm-homework/docs/TOOLCHAIN_SETUP.md
2. /Users/tolushekoni/sb2026/AGENTS.md

TASK: Scaffold the Anchor project inside /Users/tolushekoni/sb2026/remittance-stablecoin
(the directory already exists with docs/ and this runbook — init the Anchor
workspace here, keep RUNBOOK.md and docs/).

> SUPERSEDED — Session 1 already ran and discovered Anchor 0.31.x is
> impossible on this machine (SBF rustc 1.75 vs solana-program 2.x). The
> workspace now uses the AMM-proven 0.30.1 / solana 1.18.26 family with the
> amm-homework Cargo.lock and vendored anchor-syn patch. See
> docs/checkpoint-1.md. Sessions 2–4 build on that baseline.
- When builds fail: tee the log, grep the FIRST error, classify it via the
  TOOLCHAIN_SETUP.md error table, fix one thing, retry. Never paste a whole
  build log into context.

DONE WHEN: `anchor build` and `anchor test` exit 0 with the default empty
program. Then: commit Cargo.lock + package.json, and write docs/checkpoint-1.md
recording exact tool versions and any conflicts hit + their fix.
```

### Session 2 — Mint stack + fee transfer + thaw (Tasks 1–4)

```
Continue the Token-2022 homework at /Users/tolushekoni/sb2026/remittance-stablecoin.

READ FIRST: docs/checkpoint-1.md, then /Users/tolushekoni/sb2026/AGENTS.md.
Reference patterns: /Users/tolushekoni/sb2026/resources/knowledge/code-patterns.md
and /Users/tolushekoni/sb2026/resources/skills/solana-tokens/SKILL.md.

TASK: Implement and test, one instruction at a time with a test after EACH:

1. init_mint_v1: mint stacking TransferFeeConfig, MetadataPointer (→ mint
   itself), DefaultAccountState(Frozen), MintCloseAuthority. Space via
   ExtensionType::try_calculate_account_len. Order: all extension-init ixs
   BEFORE InitializeMint; TokenMetadata::Initialize runs AFTER mint init.
2. transfer_with_fee(amount): transfer_checked_with_fee CPI (NOT transfer or
   transfer_checked). Compute expected fee via the mint's TransferFeeConfig::
   calculate_epoch_fee(current_epoch, amount) — never a cached rate.
3. thaw_account: freeze authority thaws ONE account post-KYC; prove it's
   per-account (other new accounts remain frozen). Changing mint default
   state is a separate concern.

HARD RULE: all mint/account state reads go through StateWithExtensions,
never raw unpack.

Tests must cover negative paths: fee mismatch, frozen sender transfer fails,
thawed sender succeeds, wrong thaw authority fails.

DONE WHEN: anchor test green, output tee'd to docs/test-output.txt, and
docs/checkpoint-2.md records what was built + any surprises.
```

### Session 3 — Re-issue + confidential lifecycle (Tasks 5–6)

```
Continue at /Users/tolushekoni/sb2026/remittance-stablecoin.

READ FIRST: docs/checkpoint-1.md and checkpoint-2.md.

TASK:
4. init_mint_v2: re-issue the mint with the SAME extensions plus
   PermanentDelegate and ConfidentialTransfer with
   auto_approve_new_accounts = false (manual policy). In docs/checkpoint-3.md,
   document the gap: extensions can't be added post-init, so re-issue = new
   mint pubkey + holder/supply migration.
5. Confidential lifecycle end-to-end:
   - Program CPIs the proof-free steps: deposit_confidential,
     apply_pending_balance
   - TS tests drive proof steps via @solana/spl-token: ConfigureAccount
     (owner-signed — distinct from ATA creation which anyone can do),
     issuer approveAccount (manual policy), confidential Transfer, Withdraw —
     with apply_pending before withdraw.
   - If spl-token JS confidential APIs fight, fall back to spl-token CLI
     in the test script and note it in the checkpoint.
   - Confirm the validator has the zk-token-proof program
     (Solana 2.0.21 ships it by default).

DONE WHEN: full lifecycle green in anchor test. checkpoint-3.md +
test-output.txt updated.
```

### Session 4 — Challenge + finding + submission

```
Continue at /Users/tolushekoni/sb2026/remittance-stablecoin.

READ: all checkpoints.

TASK:
6. OPTIONAL challenge: minimal program where a user Approves a program PDA
   delegate, the program transfers on their behalf; user then enables CPI
   Guard on the account; confirm the delegated path still works unmodified.
7. Write the finding (docs/FINDING.md): a sanctioned user deposits their
   balance into the confidential system before the permanent delegate acts.
   Explain why seizure fails (delegate can only move the plaintext available
   balance; confidential balances are ElGamal-encrypted under the user's key —
   the delegate cannot generate ZK proofs) and the mitigations (auditor
   ElGamal key at mint init, manual approve policy as chokepoint, monitoring
   DepositConfidentialTokens events, freezing the account blocks deposits).
8. Final README: what was built, extension-stack table, how to run tests,
   finding summary, tool versions.
9. Tee final `anchor test` output to docs/test-output.txt and take the
   passing-tests screenshot.

DONE WHEN: repo is submission-ready (README + screenshot + finding).
```

## Token-hygiene rules (all sessions)

- `tee` build/test logs; grep the **first** error only. Never read a raw SBF
  log (>50k tokens).
- Read checkpoints (~1k tokens each) instead of re-exploring the repo.
- Commit after every green test — the lockfile is the artifact that makes the
  next homework nearly free.
- Budget: Session 1 ~40–80k tokens; Sessions 2–4 ~150–300k total. If Session 1
  exceeds ~100k, stop and report — something is off-script.

## Deliverable checklist

- [ ] `anchor test` green, `docs/test-output.txt` committed
- [ ] Screenshot of passing tests
- [ ] README (Session 4)
- [ ] `docs/FINDING.md` (seizure gap)
- [ ] Optional X/LinkedIn post link
