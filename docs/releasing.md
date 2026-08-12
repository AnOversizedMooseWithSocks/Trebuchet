# Releasing Trebuchet

Trebuchet releases are created from immutable `v*` tags. Merges to `main` run [Auto Release](../.github/workflows/auto-release.yml), which reads the merged pull request labels, computes the next semantic version, verifies every production gate, and only then pushes the tag and starts [Release](../.github/workflows/release.yml). The release workflow re-verifies the gate, builds desktop artifacts from a clean checkout, publishes a GitHub Release, publishes the matching package to GitHub Packages, and deploys the static [`website/`](../website) directory.

## Release states

| State | Meaning |
| --- | --- |
| Pull request | Reviewable source change; not a release artifact. |
| CI package build | Unsigned directory build used to catch packaging regressions. |
| V1 prerelease | May contain unsigned test artifacts when signing credentials are absent. |
| V2 production release | Mainnet evidence is approved and current; macOS and Windows trust credentials are complete. |

Do not describe CI package outputs as distributable production builds.

## Version selection

Merge a pull request to `main` to invoke automatic versioning:

- no release label: patch increment;
- `minor` label: minor increment;
- `major` label: major increment;
- both `minor` and `major`: `major` wins.

The label selects the normal semantic increment. The automation then derives the next version from `package.json` plus existing `v*` tags and applies the configured minimum-major floor. It does not inspect whether the merged code changes the default UI.

> **Hard v2 invariant:** a pull request that makes v2 the production default must not merge unless it will create a `v2.0.0` or newer tag and the V2 production gate is ready. `auto-release.yml` currently sets `TREBUCHET_MIN_RELEASE_MAJOR=2`, so with only v1 tags present any label choice is promoted to `v2.0.0`. If that floor is removed, the release must use a `major` label or another enforced mechanism that cannot create a v1 tag.

Confirm the calculated version before merge. If it would put v2-default code under a v1 tag, stop the release and correct the label or automation first.

The workflow can also be run manually, but it must be dispatched from an existing semantic `v*` tag. A branch ref is rejected because the build derives its version from `GITHUB_REF_NAME`.

## Pre-merge release review

Before merging a release-bearing pull request:

1. Confirm the intended semantic version and release label.
2. Require all pull request checks: tests, the three platform package smoke builds, v2 E2E coverage, and any path-triggered screenshot checks.
3. Review the PR's dependency-risk section and record a disposition for every high or critical advisory. The current audit snapshot is maintained in [`SECURITY.md`](../SECURITY.md).
4. Confirm user-facing claims match implemented execution.
5. For v2+, complete the field-evidence, independent-review, and signing preflight below before merge.
6. Verify the marketing-site download names still match `package.json` artifact names.

Pull requests run tests and Windows, Linux, and macOS arm64 package smoke builds. Smoke builds use `electron-builder --dir`; they do not produce trusted installers. Merges to `main` do not rerun that CI matrix before tagging, so green PR checks are a release precondition.

## V2 production gate

Every proposed `v2.0.0` or newer release is blocked before its public tag is created unless all production conditions pass. The tag-driven release workflow repeats the same verification before desktop builds:

1. `release-evidence/v2/field-verification.json` is the unmodified full JSON produced by v2's **Download proof** action after an authorized, non-demo, journal-backed mainnet launch reaches its wallet-empty terminal sweep. It must include a passing report-parity audit, passing Classic-retirement gate, all replacement criteria, a sweep-bound local proof record, and a structured Classic artifact comparison for the same proof fingerprint.
2. `release-evidence/v2/release-attestation.json` approves those exact evidence bytes and the retained raw Classic input by SHA-256. It names the exact field-run commit, which must be an ancestor of the release commit, and records different GitHub users as field operator and release reviewer. Evidence older than 30 days is rejected.
3. The repository supplies complete macOS signing and notarization credentials and complete Windows signing credentials. V2 releases cannot fall back to unsigned test artifacts.

The two production files are intentionally absent until the field run and independent review are complete. Follow [`release-evidence/v2/README.md`](../release-evidence/v2/README.md); never construct, trim, reformat, or repair the exported proof by hand.

The gate independently recomputes the proof fingerprint and terminal-sweep fingerprint. It also checks the concrete mint, authority state, pool and position transactions, Burn & Earn locks, Fee Key records, optional airdrop, report, full raw Classic input, comparison rows, local proof-download record, evidence age, reviewer separation, file digests, and Git ancestry.

Run the same check locally with the production signing environment loaded:

```bash
npm run release:gate -- v2.0.0
```

A passing local command is necessary but does not create a release. Auto Release runs the gate before tagging, and the tag workflow runs it again from full Git history.

V1 tags retain the prerelease trust policy and skip this additional gate. That exception is why the v2 version invariant above is mandatory.

## Signing and platform trust

### macOS

Both code-signing values are required:

- `CSC_LINK`
- `CSC_KEY_PASSWORD`

They must be paired with one complete notarization method:

- App Store Connect API key: `APPLE_API_KEY`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`;
- Apple ID: `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`; or
- keychain profile: `APPLE_KEYCHAIN`, `APPLE_KEYCHAIN_PROFILE`.

When complete, both arm64 and x64 DMGs are signed and notarized. A partial credential set fails. With no macOS credentials, only v1 can publish an unsigned test artifact; v2+ fails in the production gate.

### Windows

Both values are required:

- `WIN_CSC_LINK`
- `WIN_CSC_KEY_PASSWORD`

When complete, the NSIS installer and portable executable are signed. A partial set fails. With neither value, only v1 can publish unsigned test artifacts; v2+ fails.

### Linux

The AppImage and deb package are currently unsigned. Release notes and metadata must state that trust state directly.

If any v1 desktop artifact is an unsigned test artifact, the GitHub Release is marked as a prerelease. Do not reuse the v1 quarantine-bypass guidance as a substitute for v2 signing.

## Build and publish sequence

After the production gate passes, the workflow:

1. applies the tag version without creating another Git tag;
2. installs dependencies with `npm ci`;
3. builds the native vanity-key generator;
4. builds macOS arm64 and x64 DMGs, Windows NSIS and portable EXEs, and Linux AppImage and deb packages;
5. records per-platform release metadata;
6. captures current UI walkthrough GIFs;
7. publishes or updates the GitHub Release;
8. attaches `SHA256SUMS.txt` and generated release notes;
9. publishes `@anoversizedmoosewithsocks/trebuchet-desktop` at the same version to GitHub Packages; and
10. verifies the six website download filenames before publishing the marketing site.

The package publish is rerun-safe: if the immutable package version already exists, that step exits successfully. A rerun for the same tag rewrites release notes, reuploads current assets, and removes stale GitHub Release assets.

## Artifact verification

Every release attaches `SHA256SUMS.txt`. Download the checksum file and the desired artifacts into one directory, then run:

```bash
shasum -a 256 -c SHA256SUMS.txt
```

Also review the generated release metadata and release notes. They identify each platform artifact as signed, signed and notarized, unsigned, or an unsigned test artifact.

Expected public filenames are:

- `Trebuchet-<version>-arm64.dmg`
- `Trebuchet-<version>-x64.dmg`
- `Trebuchet-<version>-Setup.exe`
- `Trebuchet-<version>-Portable.exe`
- `Trebuchet-<version>-x86_64.AppImage`
- `trebuchet-desktop_<version>_amd64.deb`

Changing an artifact template requires a matching update to the hard-coded website URLs and the release asset verifier.

## Website publishing

The website job runs only after the GitHub Release exists and all expected download assets are present. It replaces `__TREBUCHET_VERSION__` in [`website/index.html`](../website/index.html) and mirrors [`website/`](../website) to the configured FTP destination.

When the v2 UI or website hero copy changes, run `npm run shots:marketing` and review all four generated PNGs before tagging. The capture uses the connected demo runtime and a deterministic Discovery evidence record, so the website does not drift behind the shipped interface.

Required secrets:

- `FTP_LOGIN`
- `FTP_PASSWORD`

Optional repository variables:

- `FTP_HOST` — defaults to `p1401.use1.mysecurecloudhost.com`;
- `FTP_PROTOCOL` — defaults to `ftp`;
- `FTP_REMOTE_DIR` — defaults to `.`.

Use the hosting provider's FTP hostname for `FTP_HOST`, not the public marketing domain, so TLS certificate verification matches the endpoint. The deploy uploads only newer files and does not delete other remote files by default.

## Failure handling

- **Wrong automatically created tag:** do not publish or move a released tag. Stop and investigate before deleting an unpublished bad tag or creating a corrected release; coordinate any tag mutation with repository administrators.
- **Production gate failure:** fix the stated evidence, attestation, ancestry, age, or signing precondition. Never weaken the gate or edit an exported proof to make it pass.
- **One platform build fails:** rerun the same immutable tag after a transient infrastructure failure. A source fix requires a new commit and new tag. Do not mix files from different commits into one release.
- **Website verification fails:** align the website links and `package.json` artifact names, then publish a new tagged commit.
- **Partial publish:** inspect the existing GitHub Release and package version before rerunning; the workflow is designed to reconcile assets for the same tag, but npm package contents cannot be replaced.

After publication, install each platform artifact on a clean machine, verify the checksum and trust state, open v2 as the default UI, and retain Classic only as the documented fallback. A successful workflow is not a substitute for release-candidate smoke testing.
