# Finding: the permanent delegate cannot seize confidential balances

Date: 2026-09-30 · Repo: remittance-stablecoin (Anchor 0.30.1, Token-2022 via spl-token-2022 3.0.5)

## TL;DR

A v2 mint carries `PermanentDelegate` (the issuer can burn/transfer from any
holder) and `ConfidentialTransferMint`. If a user learns they are about to be
sanctioned, they can `Deposit` their public balance into the confidential
system first. After that the delegate can still move whatever plaintext
balance is left, which is zero, but it cannot touch the encrypted part. So
the seizure power that the delegate is supposed to guarantee has a hole that
the holder controls.

## Why seizure fails

An account holds two kinds of balance:

- **Public balance**: a plain `u64` in the token account. `PermanentDelegate`
  is checked as an authority on burn/transfer, so it can move this freely.
- **Confidential pending + available balance**: ElGamal ciphertexts (64 bytes
  each) encrypted under the *user's* ElGamal key. The program stores them but
  cannot read them. Moving them out requires a ZK proof (equality + range,
  and for transfers also ciphertext-validity) built from the user's secret
  key. The delegate does not have that key, so it cannot build a valid proof.

`Deposit` is the one-way door: it debits the public `u64` and adds a
ciphertext to `pending`. It needs no proof, only the owner's signature.

## Evidence in this repo (all in `tests/remittance-stablecoin.ts`, run by `anchor test`)

- `permanent delegate can burn only the plaintext balance; confidential funds
  stay out of reach`: holder has 1000, deposits 400 into confidential, the
  delegate (issuer wallet, not the owner) burns the 600 plaintext. A further
  burn of 1 fails, the pending ciphertext is still non-zero and its credit
  counter is still 1.
- `v2 lifecycle`: the same 400 later comes back out via apply-pending +
  withdraw, but only when the owner's key builds the proof. Withdrawing 1
  more than the decrypted balance fails.
- `control: confidential transfer with real ZK proofs`: the proof machinery
  works on the validator, so this is a real property of the protocol, not a
  test artifact. (It runs on a control mint without a fee because the CLI
  cannot do confidential transfer on a fee mint; see README.)
- `v2 lifecycle` first assertion: with `auto_approve_new_accounts = false`, a
  deposit into a configured-but-unapproved account fails with `0x18`
  (`ConfidentialTransferAccountNotApproved`).
- `freezing an account blocks confidential deposits`: a frozen account cannot
  deposit.

## Mitigations, and what each really buys

1. **Manual approve policy (built, tested).** The issuer must run
   `ApproveAccount` before an account can receive a deposit. This is the
   chokepoint: screen at approval, before any balance can go confidential.
   Cost: an operational step per account.
2. **Freeze authority (built, tested for deposits).** `DefaultAccountState =
   Frozen` plus per-account thaw means a fresh account is unusable until KYC.
   Freezing a suspect account also blocks new deposits. I did not test
   confidential withdraw/transfer from a frozen account, so I am not claiming
   it; check that before relying on it.
3. **Watch `Deposit`.** The deposit amount is plaintext on-chain, so the
   issuer can see "account X moved 400 into confidential" in real time and
   freeze inside the window. This is monitoring, not prevention; it loses a
   race against a fast user.
4. **Auditor ElGamal key at mint init (NOT set in this repo).** `init_mint_v2`
   passes `auditor_elgamal_pubkey = None`. With a key, the auditor can decrypt
   the *amounts* of confidential transfers (not balances, which stay under
   user keys). It restores visibility into flows after the deposit; it does
   not give the delegate a way to move funds. It should be set at mint
   creation because it can only be changed later by the confidential-transfer
   authority via `UpdateMint`, which then applies to new transfers only.

The honest limit: nothing here lets the issuer seize funds that are already
encrypted. Compliance has to happen before the deposit (approve, freeze,
monitor), or the design has to accept that confidential balances are outside
delegate reach.

## Note on scope

No program code was changed for this finding. The only thing the finding
required was the tests listed above.
