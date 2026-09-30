# Checkpoint 1 — Scaffold + green build

## Tool versions (verified)

| Component | Version |
|---|---|
| Anchor CLI | `~/.avm/bin/anchor-0.30.1` (0.31.x CANNOT build — see below) |
| Solana CLI | 2.0.21 |
| SBF platform-tools | v1.42 → **rustc/cargo 1.75.0** |
| Host rustc | 1.97.1 (irrelevant for `anchor build`) |
| `anchor-lang`, `anchor-spl` | 0.30.1 (`init-if-needed` enabled) |
| `solana-program` family | 1.18.26 |
| `spl-token-2022` (transitive) | 3.0.5 |
| Cargo.lock | **copied from `amm-homework/Cargo.lock`**, root package renamed, version 3 |
| `@coral-xyz/anchor` | 0.30.1 |
| `@solana/spl-token` | 0.4.15 |
| `@solana/web3.js` | 1.98.x |

## Critical finding — Anchor 0.31 vs SBF toolchain (RESOLVED post-scaffold)

`anchor-lang 0.31.x` hard-requires `solana-program 2.x`, which needs a Rust
newer than 1.75. The original SBF toolchain (platform-tools v1.42, shipped
with solana-cli 2.0.21) was **rustc 1.75.0**, making 0.31 impossible.

**Resolution (same day):** `agave-install init stable` upgraded to
solana-cli **4.2.2** / cargo-build-sbf 4.1.0 / platform-tools **v1.54
(rustc 1.89.0-dev)**. Verified `anchor-0.31.1 build` produces `.so` + IDL,
and `anchor-0.30.1 build` on THIS workspace still passes under the new
toolchain (solana-program 1.18.26 compiles fine on rustc 1.89).

This homework continues on 0.30.1 (green, lockfile proven, mid-assignment).
New projects can now use Anchor 0.31.x + solana-program 2.x per AGENTS.md.
Platform-tools live in `~/.cache/solana/v{1.42,1.52,1.54}/` — per-version,
so old toolchains still work if a project pins them.

## Conflicts hit and fixes

| Error | Fix |
|---|---|
| `lock file version 4 requires -Znext-lockfile-bump` | Host Cargo 1.97 writes v4; SBF Cargo 1.75 reads v3 only → `sed` the lockfile `version = 4` → `version = 3` after every host-cargo lockfile mutation |
| `edition2024 is required` via `block-buffer 0.12.1` / `hashbrown 0.17.1` | New transitive crates escaping into the 1.75 graph. First fix `blake3 --precise 1.5.5` worked, but whack-a-mole followed → **final fix: reuse `amm-homework/Cargo.lock` wholesale** and rename the workspace package entry. Zero conflicts after that. |
| `@coral-xyz/anchor` 0.31.1 vs CLI 0.30.1 warning | `yarn add -D @coral-xyz/anchor@0.30.1` |
| `anchor-syn` proc-macro issue (preemptive) | `vendor/anchor-syn` copied from amm-homework + `[patch.crates-io]` in workspace Cargo.toml — keep this, it is 0.30-specific |

## Golden-scaffold rule (learned)

**Never `cargo generate-lockfile` fresh on this machine.** The resolver picks
edition2024-era crates that SBF Cargo 1.75 can't even parse. Always start from
the proven lockfile, and if a new direct dep is needed, add it via
`cargo add`/`cargo update -p <crate> --precise`, then downgrade lockfile back
to v3.

## State

- Program: `programs/remittance-stablecoin` (`remittance_stablecoin`),
  program id `KChY5fYCcqXS9uiY3daKx3fctBPTa1aQKfuJ8MkD1gz` (dev scaffold key —
  regenerate for real deployment).
- `anchor-0.30.1 build` green; `anchor-0.30.1 test` green (1 passing);
  `target/idl/remittance_stablecoin.json` generated.
- Logs: `docs/build-1.log`, `docs/test-output.txt`.

## Known extension-API note for Session 2/3

`anchor-spl 0.30.1` → `spl-token-2022 3.0.5`. Check which CPI builders
`anchor_spl::token_2022_extensions` exposes in this version; for anything
missing (e.g., parts of confidential transfer), build the instruction via
`spl_token_2022::instruction::*` directly + `invoke_signed` — the crate is
already in the graph transitively.
