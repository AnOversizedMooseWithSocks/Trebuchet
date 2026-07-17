# V2 production field evidence

`field-verification.json` and `release-attestation.json` are release inputs, not fixtures. They are deliberately absent until an authorized production field run and independent review are complete. Never rename the example attestation until its placeholders have been replaced.

To create it:

1. Run one authorized non-demo launch in v2 through token creation, authority finalization, every planned pool and position, Burn & Earn locks, Fee Key delivery, any configured airdrop, proof-bound report generation, and the final wallet-empty sweep.
2. Load the completed Classic JSON or HTML artifact in v2's Classic comparison panel and resolve every required comparison row.
3. Confirm the center-panel field-verification packet says `READY`, with no requirement or replacement-criterion blockers.
4. After the terminal sweep, use **Download proof** again so its local artifact record carries the final sweep evidence hash.
5. Review the JSON for accidental secrets. The app export is designed to contain public proof and a non-secret launch configuration, never a wallet secret or PIN. Confirm that `classicReportComparison.input` still contains the full raw Classic artifact; do not replace it with a summary.
6. Save those exact bytes as `release-evidence/v2/field-verification.json` and commit them on the v2 release pull request. Record the 40-character commit used for the field run; it must remain an ancestor of the release tag.
7. Compute the SHA-256 of the exact evidence file and the trimmed raw Classic input:

   ```bash
   shasum -a 256 release-evidence/v2/field-verification.json
   node -e "const c=require('crypto'),f=require('fs'),p=JSON.parse(f.readFileSync('release-evidence/v2/field-verification.json')); console.log(c.createHash('sha256').update(String(p.classicReportComparison.input||'').trim()).digest('hex'))"
   ```

8. Copy `release-attestation.example.json` to `release-attestation.json`. Fill in the release tag, both digests, field-run commit and timestamps, operator, and reviewer. The operator and reviewer must be different GitHub users, the review must happen after the proof export, and the export must be no more than 30 days old when the release runs.
9. The reviewer must inspect the mint, authority state, pool and position transactions, Fee Key delivery, airdrop, sweep destination, raw Classic artifact, comparison rows, and recomputed proof fingerprint before setting `decision` to `approved-for-v2-production`.
10. With the signing/notarization environment loaded, run `npm run release:gate -- v2.0.0`.

The release workflow fetches full Git history and runs the same gate before any `v2+` build. A missing, demo, stale, partially passing, hand-thinned, sweep-unbound, hash-mismatched, unreviewed, non-ancestral, or non-Classic packet fails the release.
