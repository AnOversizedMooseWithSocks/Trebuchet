# Releasing Trebuchet

Merges to `main` are versioned by [`.github/workflows/auto-release.yml`](../.github/workflows/auto-release.yml), which computes and pushes the next `v*` tag.
Tagged releases are then built by [`.github/workflows/release.yml`](../.github/workflows/release.yml) from a clean checkout using `npm ci`.
After the desktop artifacts are published to GitHub Releases, the same workflow publishes the npm package to GitHub Packages and uploads the static [`website/`](../website) directory to the production site.

## Trigger

Merge a pull request to `main`.

By default, the automation increments the patch version. Add a `minor` label to the pull request to increment the minor version, or a `major` label to increment the major version. `major` wins if both labels are present.

Pull requests run tests and Windows, Linux, and macOS arm64 package smoke builds only. The smoke builds run in parallel with tests and use `electron-builder --dir` instead of producing installer artifacts. Merges to `main` do not run the CI package matrix again; the auto-release workflow creates the tag and starts the full release build.

The tag-driven workflow can still be run manually by pushing a Git tag that starts with `v`, for example `v1.2.3`.

## V2 production gate

Every `v2.0.0` or newer tag is blocked before desktop builds start unless both production conditions are true:

1. `release-evidence/v2/field-verification.json` is the unmodified full JSON artifact produced by v2's **Download proof** action after a non-demo, journal-backed launch reaches its wallet-empty terminal sweep. The export must carry a passing report parity audit, passing Classic retirement gate, all replacement criteria, a terminal-sweep-bound local proof record, and a retirement-grade structured Classic artifact comparison for the same proof fingerprint.
2. The repository has a complete macOS signing and notarization credential set and a complete Windows signing credential set. V2 releases cannot fall back to unsigned test artifacts.

The evidence file is intentionally absent until the field launch is complete. Follow [`release-evidence/v2/README.md`](../release-evidence/v2/README.md) to produce and archive it. Do not construct or edit the packet by hand; the gate checks the concrete mint, authority, pool, position, Fee Key, airdrop, report, sweep, audit, and Classic-comparison records emitted by the app.

Repository administrators can run the same check locally with signing variables loaded:

```bash
npm run release:gate -- v2.0.0
```

V1 tags keep the existing prerelease policy and skip this additional production gate.

The workflow builds:

- macOS arm64 DMG
- macOS x64 DMG
- Windows NSIS installer
- Windows portable EXE
- Linux AppImage
- Linux deb

## Trust model

- macOS artifacts are **signed and notarized** only when both `CSC_LINK` and `CSC_KEY_PASSWORD` are present **and** one complete Apple notarization credential set is configured:
  - `APPLE_API_KEY`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`, or
  - `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`, or
  - `APPLE_KEYCHAIN`, `APPLE_KEYCHAIN_PROFILE`.
- For v1 tags, if the macOS credentials are absent, the workflow still builds macOS **unsigned test artifacts** and marks the release accordingly. V2 and newer tags fail before building instead. Website download cards disclose that macOS may report unsigned v1 downloads as damaged, and show the quarantine-removal command for users who trust the download:
  `xattr -dr com.apple.quarantine /Applications/Trebuchet.app`.
- Windows installer and portable EXE artifacts are **signed** only when `WIN_CSC_LINK` and `WIN_CSC_KEY_PASSWORD` are configured.
- For v1 tags, if the Windows credentials are absent, the workflow still builds Windows installer and portable EXE **unsigned test artifacts** and marks the release accordingly. V2 and newer tags fail before building instead.
- Linux AppImage and deb artifacts are built as **unsigned** packages.

If any v1 desktop artifact is published as an unsigned test artifact, the workflow marks the GitHub Release as a prerelease. The v2 production gate prevents an unsigned v2 release from reaching the publish job.

## Verification

Every release attaches `SHA256SUMS.txt`.

Verify downloads locally with:

```bash
shasum -a 256 -c SHA256SUMS.txt
```

The release notes also state which platform artifacts were signed, notarized, unsigned, or unsigned test artifacts.

## GitHub Packages

Each tagged release publishes `@anoversizedmoosewithsocks/trebuchet-desktop` to GitHub Packages with the same version as the Git tag. If the package version already exists during a rerun, the package publish step exits successfully because npm package versions are immutable.

## Repeatability

The workflow updates an existing release for the same tag by re-uploading current assets, deleting stale assets, and rewriting the release notes. That keeps reruns on the same `v*` tag usable after a failed or partial run.

## Website publishing

The release workflow publishes [`website/`](../website) over FTP after the GitHub Release is created.

Required secrets:

- `FTP_LOGIN`
- `FTP_PASSWORD`

Optional repository variables:

- `FTP_HOST` (defaults to `p1401.use1.mysecurecloudhost.com`, the provider hostname whose TLS certificate covers the FTP endpoint)
- `FTP_PROTOCOL` (defaults to `ftp`)
- `FTP_REMOTE_DIR` (defaults to `.`)

Use the hosting provider's FTP hostname for `FTP_HOST`, not the public marketing domain. `makesometokens.com` serves the site, but its FTP TLS certificate is not issued for that name, so `lftp` rejects it during certificate verification.

The deploy step uploads only newer files and does not delete remote files by default.
