# X post + LinkedIn variant

Image: `docs/x-post-image.png` (attach to post 1) — real screenshot of the passing `anchor test` output (14 green checks).
Replace `<REPO_URL>` before posting.

## X thread (5 posts)

**1/5**
Token-2022 gives regulators a PermanentDelegate and users ConfidentialTransferMint. I built a stablecoin with both and found the paradox: a user who sees a sanction coming can deposit into the confidential balance first, and the delegate can't reach it.

**2/5**
Why: PermanentDelegate can burn/transfer the plaintext u64. Confidential balances are ElGamal ciphertexts under the user's key, and moving them needs a ZK proof only the user can build. In my test the delegate burns 600 of 1000, a 1-unit burn then fails, 400 stays encrypted.

**3/5**
The fix is before the deposit, not after. On the mint: ConfidentialTransferMint with auto_approve_new_accounts=false, so the issuer must approve each account (deposit before approve fails with 0x18), plus DefaultAccountState=Frozen so new accounts start unusable.

**4/5**
Two more layers: an auditor ElGamal key set at mint init so transfer amounts are visible (my v2 leaves it None, that's a gap I documented), and freeze on suspect accounts, which blocks deposits. Deposit amounts are plaintext, so watch them and freeze inside the window.

**5/5**
Stack: TransferFeeConfig, PermanentDelegate, ConfidentialTransferMint, DefaultAccountState, plus MetadataPointer and MintCloseAuthority. Anchor 0.30.1, 14 tests. Confidential transfer on a fee mint isn't supported by the CLI or JS yet, notes in the repo. <REPO_URL>

## LinkedIn variant

I built a remittance stablecoin on Solana Token-2022 and used it to test a compliance question: what happens when a mint has both a PermanentDelegate (the issuer can burn or transfer from any holder) and ConfidentialTransferMint (balances are encrypted)?

The gap: a holder who expects to be sanctioned can deposit into the confidential balance first. The delegate only moves the plaintext balance. The confidential balance is an ElGamal ciphertext under the user's key, and withdrawing or transferring it needs a zero-knowledge proof only the user can produce. In my tests the delegate burned the 600 plaintext units of a 1000 balance; a further 1-unit burn failed and the 400 deposited units stayed encrypted.

The controls have to sit before the deposit:
- ConfidentialTransferMint with auto_approve_new_accounts=false, so the issuer approves every account (a deposit before approval fails with error 0x18).
- DefaultAccountState=Frozen, so new accounts are unusable until screened.
- Freezing suspect accounts, which blocks deposits.
- An auditor ElGamal key set at mint creation for visibility into transfer amounts. My v2 does not set one; I flagged that as a gap.
- Monitoring Deposit instructions, since the deposit amount is plaintext.

The mint also uses TransferFeeConfig for a 50 bps protocol fee. One limitation I hit: confidential transfer on a mint with a transfer fee is not supported by the spl-token CLI (5.6.1) or the JS client (0.4.15), so I proved the ZK transfer path on a control mint without the fee extension. Details, tests and the write-up are in the repo: <REPO_URL>
