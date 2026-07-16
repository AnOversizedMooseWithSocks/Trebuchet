# V2 production field evidence

`field-verification.json` is a release input, not a fixture. It must be the full JSON file produced by v2's **Download proof** action after the production field run. It is deliberately not checked in yet.

To create it:

1. Run one authorized non-demo launch in v2 through token creation, authority finalization, every planned pool and position, Burn & Earn locks, Fee Key delivery, any configured airdrop, proof-bound report generation, and the final wallet-empty sweep.
2. Load the completed Classic JSON or HTML artifact in v2's Classic comparison panel and resolve every required comparison row.
3. Confirm the center-panel field-verification packet says `READY`, with no requirement or replacement-criterion blockers.
4. After the terminal sweep, use **Download proof** again so its local artifact record carries the final sweep evidence hash.
5. Review the JSON for accidental secrets. The app export is designed to contain public proof and a non-secret launch configuration, never a wallet secret or PIN.
6. Save that exact file as `release-evidence/v2/field-verification.json`, commit it on the v2 release pull request, and have a second operator review the mint, transaction links, destination, Classic comparison, and proof fingerprint.
7. With the signing/notarization environment loaded, run `npm run release:gate -- v2.0.0`.

The release workflow runs the same gate before any `v2+` build. A missing, demo, stale, partially passing, hand-thinned, sweep-unbound, or non-Classic comparison packet fails the release.
