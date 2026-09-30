# X post + LinkedIn variant

Image: `docs/x-post-image.png` (attach to post 1) — real screenshot of the passing `anchor test` output (14 green checks).
Repo link is already filled in: https://github.com/ToXMon/remittance-stablecoin

## X thread (5 posts)

**1/5**
I'm late posting this. I kept working anyway. The homework was a remittance stablecoin on Solana Token-2022 that gives regulators a PermanentDelegate and users ConfidentialTransferMint, then shows why seizure still fails. 14 tests green, repo at the end.

**2/5**
Why it fails: the delegate burns the plaintext u64. Confidential balances are ElGamal ciphertexts under the holder's key, and moving them needs a ZK proof only the holder can build. My test: delegate burned 600 of 1000, a 1-unit burn then failed, 400 stayed encrypted.

**3/5**
The fix has to sit before the deposit. ConfidentialTransferMint with auto_approve_new_accounts=false means the issuer approves every account. Deposit before approve fails with 0x18. DefaultAccountState=Frozen keeps new accounts unusable until screened.

**4/5**
More layers: an auditor ElGamal key at mint init makes transfer amounts visible (my v2 leaves it unset, documented gap), freezing a suspect account blocks deposits, and deposit amounts are plaintext so they're watchable.

**5/5**
This one stretched me: mint sizing so extensions actually fit, extension inits before InitializeMint, a validator whose token-2022 had no zk-ops, and a CLI that still can't do confidential transfer on a fee mint. Slow, but I finished it. https://github.com/ToXMon/remittance-stablecoin

## LinkedIn variant

I submitted this later than I wanted to, and I'd rather say that up front than bury it. What matters to me is that I finished it.

The assignment was a remittance stablecoin on Solana Token-2022, and I used it to test a compliance question: what happens when a mint has both a PermanentDelegate (the issuer can burn or transfer from any holder) and ConfidentialTransferMint (balances are encrypted)?

The gap: a holder who expects to be sanctioned can deposit into the confidential balance first. The delegate only moves the plaintext balance. The confidential balance is an ElGamal ciphertext under the user's key, and moving it needs a zero-knowledge proof only the user can produce. In my tests the delegate burned the 600 plaintext units of a 1000 balance; a further 1-unit burn failed and the 400 deposited units stayed encrypted.

The controls have to sit before the deposit:
- ConfidentialTransferMint with auto_approve_new_accounts=false, so the issuer approves every account (a deposit before approval fails with error 0x18).
- DefaultAccountState=Frozen, so new accounts are unusable until screened.
- Freezing suspect accounts, which blocks deposits.
- An auditor ElGamal key set at mint creation for visibility into transfer amounts. My v2 does not set one; I flagged that as a gap.
- Monitoring Deposit instructions, since the deposit amount is plaintext.

The mint also uses TransferFeeConfig for a 50 bps protocol fee.

What actually stretched me on this one wasn't the concept, it was the tooling. Mint account sizing had to match the extension length exactly or InitializeMint rejects it. Extension inits must run before InitializeMint, TokenMetadata after. The local test validator's token-2022 build had no zk-ops, so I swapped in the mainnet program as a genesis fixture. And confidential transfer on a mint with a transfer fee is not supported by the spl-token CLI (5.6.1) or the JS client (0.4.15), so I proved the ZK transfer path on a control mint without the fee extension. All of it is documented in the repo.

14 tests passing, real screenshot included. If you're mid-homework and behind schedule: the honest version shipped beats the perfect version that doesn't exist. https://github.com/ToXMon/remittance-stablecoin
