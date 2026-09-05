# V2 production field evidence

This directory holds the human-reviewed mainnet evidence that unlocks a `v2.0.0` or newer production release. The evidence is release input, not a fixture, screenshot, or sample.

The expected production files are deliberately absent until an authorized field launch is complete:

- `field-verification.json` — exact full JSON bytes exported by v2 **Download proof**;
- `release-attestation.json` — independent approval of those bytes and their retained Classic artifact.

[`release-attestation.example.json`](release-attestation.example.json) is a schema template only. Never rename it while placeholders remain, and never put a wallet secret, recovery phrase, private key, PIN, credential, or access token in this directory.

## Roles and separation

Two different people are required:

- **field operator:** executes and exports the authorized mainnet launch;
- **release reviewer:** independently validates the proof and writes the approval.

Both identities must be valid, different GitHub usernames. The reviewer cannot approve before the proof is exported.

## Preconditions

Before spending funds or generating evidence:

1. Freeze the release-candidate commit and record its full 40-character lowercase SHA.
2. Confirm that commit contains the exact v2 code intended for release and will remain an ancestor of the release tag.
3. Use `mainnet-beta`, a dedicated RPC endpoint, a fresh launch wallet, bounded funds, and a controlled destination wallet.
4. Complete a demo or low-risk rehearsal without reusing its proof as production evidence.
5. Confirm every planned token, authority, pool, position, lock, Fee Key, airdrop, recovery, report, and sweep field is understood.
6. Retain the complete structured Classic JSON or HTML artifact for the same launch outcome. A screenshot or hand-written summary is insufficient.
7. Confirm macOS signing/notarization and Windows signing credentials are available for the final gate. The evidence process does not waive artifact trust.

## Operator procedure

Run the candidate exactly as a user would:

1. Launch v2 from the frozen field-run commit.
2. Configure the token and all intended launch parameters. Verify addresses in full before funding or signing.
3. Fund the launch wallet only to the reviewed requirement plus an explicit safety buffer.
4. Execute one authorized, non-demo launch through:
   - token creation and metadata;
   - mint, freeze, and metadata authority finalization;
   - every planned pool and position;
   - every planned Burn & Earn lock;
   - Fee Key creation and delivery;
   - any configured airdrop;
   - proof-bound report generation; and
   - the terminal token, NFT, and SOL sweep to the controlled destination wallet.
5. Resolve any interrupted stage through the journaled recovery flow. Do not restart from an ambiguous state or discard failed-wallet metadata.
6. In v2's Classic comparison panel, load the complete Classic JSON or HTML artifact and resolve every required comparison row.
7. Confirm the report-parity audit passes at 100%, without warnings or missing rows.
8. Confirm the Classic-retirement gate passes every requirement and replacement criterion.
9. Confirm the field-verification packet shows `READY`, `nextAction: "none"`, and zero blockers.
10. After the terminal wallet-empty sweep is recorded, use **Download proof** again. The final local proof-download record must be bound to that sweep; an export made before sweeping is invalid.

The proof must show concrete transaction evidence. A configured plan, optimistic UI state, demo result, compact HTML report, or explorer screenshot cannot replace the full JSON export.

## Preserve exact bytes

Review the downloaded JSON for accidental secrets without changing it. The export is designed to contain public chain proof and non-secret launch configuration. If a secret appears, stop: treat it as exposed, rotate or recover as appropriate, and fix the export path before making new evidence.

The following must remain intact:

- the exact exported JSON bytes;
- `classicReportComparison.input`, containing the trimmed but otherwise complete raw Classic artifact;
- every comparison row and proof-derived field;
- the final sweep-bound `localDossier` record;
- timestamps and proof fingerprints.

Do not pretty-print, minify, reorder, redact, hand-fill, copy selected fields, or “repair” the proof. Save the unmodified download as:

```text
release-evidence/v2/field-verification.json
```

Commit that exact file on the release pull request. The attested `fieldRunCommit` is the frozen commit used to run the app, not the later evidence-commit SHA; the gate proves it is an ancestor of the release commit.

## Compute the digests

From the repository root, compute the SHA-256 of the exact file bytes:

```bash
shasum -a 256 release-evidence/v2/field-verification.json
```

Compute the digest of the trimmed full Classic input exactly as the gate does:

```bash
node -e "const c=require('crypto'),f=require('fs'),p=JSON.parse(f.readFileSync('release-evidence/v2/field-verification.json')); console.log(c.createHash('sha256').update(String(p.classicReportComparison.input||'').trim()).digest('hex'))"
```

Record both lowercase, 64-character digests for the independent reviewer. If the evidence file changes by even one byte, recompute the file digest and repeat review. If the Classic input changes, the export is no longer the operator's original packet and must be regenerated through the app.

## Independent review

The release reviewer should inspect the evidence without relying on the operator's summary:

1. Match the token mint and launch wallet across the proof, report, and Classic artifact.
2. Verify authority finalization: mint authority renounced, freeze authority disabled, metadata update authority revoked, and metadata immutable.
3. Open every pool-creation transaction and confirm every recorded position NFT and open transaction.
4. Confirm every position is locked and has a lock transaction.
5. Confirm every Fee Key mint exists and any configured recipient received it through the recorded transfer.
6. Verify every configured airdrop recipient and require zero failed recipients.
7. Confirm terminal token, NFT, and SOL sweep success, the destination wallet, and `walletEmpty: true`.
8. Confirm the local JSON proof-download record is bound to the terminal sweep hash.
9. Inspect the complete raw Classic input and every comparison row; require zero warnings, missing fields, or mismatches.
10. Independently recompute the proof fingerprint, sweep-evidence hash, evidence-file digest, and raw-Classic digest using the repository gate.
11. Confirm the field-run commit is the reviewed candidate and is an ancestor of the release commit.
12. Confirm the export is no more than 30 days old and the timestamps are ordered: field run, proof export, then review.

Only after all checks pass, copy the example to `release-attestation.json` and replace every placeholder:

```json
{
  "schema": "trebuchet-v2-production-attestation",
  "version": 1,
  "cluster": "mainnet-beta",
  "releaseTag": "v2.0.0",
  "decision": "approved-for-v2-production",
  "evidenceSha256": "<sha256-of-exact-field-verification-json-bytes>",
  "classicArtifactSha256": "<sha256-of-trimmed-classic-report-comparison-input>",
  "fieldRunCommit": "<40-character-lowercase-git-commit>",
  "fieldRunCompletedAt": "<ISO-8601-timestamp>",
  "operatedBy": "<github-user-who-ran-the-field-launch>",
  "reviewedAt": "<ISO-8601-timestamp-after-proof-export>",
  "reviewedBy": "<different-github-user-who-reviewed-the-proof>"
}
```

`releaseTag` must match the exact tag being released. Commit the completed attestation beside the evidence file; do not edit the example into an approval artifact.

## Run the production gate

Load the real release-signing environment, then run from the exact release candidate:

```bash
npm run release:gate -- v2.0.0
```

The command must report:

- the evidence file and its SHA-256;
- the reviewer;
- the independently derived field-proof fingerprint; and
- `macOS signed and notarized; Windows signed`.

The tag workflow fetches full Git history and runs the same gate before any v2+ desktop build. A missing, demo, stale, partially passing, compact, hand-thinned, sweep-unbound, hash-mismatched, unreviewed, same-person, non-ancestral, unsigned, or non-Classic packet fails closed.

## Archival and incident handling

Keep the approved files in Git history with the release candidate. The public proof contains chain-visible data, but it still needs the secret review above before commit.

If any mismatch is discovered after approval:

1. stop the release or mark the release candidate invalid;
2. do not patch the JSON or reuse the attestation;
3. investigate whether funds, secrets, or release trust are affected;
4. generate a new app export from a valid completed launch state when safe; and
5. require a new independent review and attestation.

If 30 days elapse before the release workflow runs, repeat the authorized evidence process. Changing the system clock, timestamp fields, or gate constants is not a valid renewal.
