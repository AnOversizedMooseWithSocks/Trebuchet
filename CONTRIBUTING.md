# Contributing

Trebuchet signs real Solana transactions and can leave recoverable on-chain
state when an operation fails halfway through. Changes to execution, recovery,
proof, signing, or release behavior need evidence proportional to that risk.

## Development setup

Use Node.js `22.12.0`, matching CI:

```bash
npm ci
npm run build:c
npm start
```

The desktop default is v2. Use `npm run start:classic` when validating the
fallback or comparing behavior.

## Before editing

- Read [ENG.md](ENG.md) for runtime boundaries and generated-file rules.
- Read [SECURITY.md](SECURITY.md) before changing dependencies, upload parsing,
  local secrets, session handling, or external URL behavior.
- Read [DESIGN.md](DESIGN.md) for user-interface work. v2 should remain a dense
  crypto operations terminal, not drift back toward a rounded SaaS dashboard.
- Update [PRD.md](PRD.md) or [GAP_ANALYSIS.md](GAP_ANALYSIS.md) when a change
  alters product scope or production acceptance.

## Required local checks

Run the smallest relevant checks while iterating, then the complete baseline
before pushing:

```bash
npm run check:syntax
npm run check:package
npm test
```

Additional checks by change type:

| Change | Checks |
| --- | --- |
| v2 UI or interaction | `npm run test:e2e:v2`, `npm run test:v2:viewport`, `npm run test:visual` |
| Classic UI/modules | `npm run build:js`, `git diff --exit-code -- public/app.js`, `npm run test:e2e` |
| Electron boot/package | `npm run test:electron:v2`; packaged smoke when practical |
| Runtime packaging | platform smoke build plus `npm run check:package` |
| Solana/Raydium compatibility | relevant unit tests and `npm run smoke:mainnet:readonly` |
| Dependency change | `npm audit --audit-level=critical` and `npm audit --audit-level=high` before/after |
| Release gate | `node --test test/production-release-gate.test.mjs test/release-workflow.test.mjs` |

The read-only mainnet launch smoke can use a dedicated endpoint:

```bash
TREBUCHET_SMOKE_TEST_RPC=https://mainnet.helius-rpc.com/?api-key=YOUR_KEY \
  node --test test/smoke-launch.test.mjs
```

It must not send transactions.

## Generated and packaged files

- `public/app.js` is generated from `public/modules/`. Edit the modules, run
  `npm run build:js`, and commit the rebuilt bundle.
- `public/v2/app.js` and `public/v2/styles.css` are direct v2 sources.
- `c/build/` is generated and ignored. CI and releases run `npm run build:c`.
- Any runtime import reachable from `main.js` must appear in both package file
  lists. `npm run check:package` enforces this.
- Do not commit `dist/`, credentials, Recovery PIN material, wallet secrets, or
  live proof files that have not been reviewed for public disclosure.

## Pull request expectations

A pull request should state:

- the user-visible or operational outcome;
- safety and recovery impact;
- exact validation performed;
- whether screenshots or proof contracts changed;
- whether dependency, release, or signing risk changed;
- any claim that remains staged/configured rather than live and proven.

Do not describe an app-generated preview, staged operation, or passing local flag
as completed on-chain behavior without transaction evidence.

## CI checks

Pull request checks include:

- **Test** — syntax, generated Classic bundle parity, package-file coverage,
  unit/integration tests, a critical audit gate, and a non-blocking high audit
  report.
- **Build macOS arm64**, **Build Windows**, and **Build Linux** — unpacked
  package smoke builds. Linux also runs the packaged v2 Electron smoke.
- **E2E UI Flows** — Classic Playwright, v2 API-backed E2E, desktop/mobile
  viewport proof, visual regression, and tutorial artifact generation.
- **Capture README screenshots** — runs only when paths covered by the
  screenshot workflow change.

All jobs should be green before merge. A `continue-on-error` advisory step does
not make its underlying risk disappear; record known exposure in
[SECURITY.md](SECURITY.md).

## Branch protection

Maintainers should use a default-branch ruleset that:

1. requires the stable CI check names used by `.github/workflows/ci.yml`;
2. requires the branch to be current with `main`;
3. requires review for execution, security, or release changes;
4. prevents bypass of failed package or E2E checks.

## Release changes

Merges to `main` are tagged by `.github/workflows/auto-release.yml`. The merged
PR labels select the bump:

- no release label: patch;
- `minor`: minor;
- `major`: major (`major` wins if both exist).

A `v2+` release is intentionally different from a v1 prerelease: it requires
field evidence, a two-person attestation, full signing credentials, and the
production gate. See [docs/releasing.md](docs/releasing.md).
