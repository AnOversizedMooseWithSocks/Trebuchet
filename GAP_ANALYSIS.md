# Trebuchet v2 production gap

Status date: 2026-07-16

## Executive summary

The implementation gap from Classic to the v2 token-launch experience is
largely closed. The remaining gap to a production `v2.0.0` is now operational
proof and release trust. One release-engineering decision must not be hidden:

- the auto-release default is a patch bump, so merging a v2-default branch
  without a `major` label could publish a `v1.x` tag and skip the v2-only
  production gate.

The current v2-default pull request may be mergeable as code, but it is not safe
to merge and auto-publish until the version/gate invariant, field evidence, and
signing inputs are resolved.

## What is complete

| Area | State | Evidence |
| --- | --- | --- |
| v2 desktop default | Complete | `main.js`, default/Classic tests |
| Terminal design and responsive shell | Complete | v2 viewport and visual checks |
| Managed wallet, Recovery PIN, recovery inventory | Complete | wallet/PIN/recovery tests |
| Token/pool/airdrop/support configuration | Complete | plan/readiness and parity tests |
| Oversized logo normalization | Complete | v2 logo tests and server upload validation |
| Guarded Classic-backed execution | Complete in code | API E2E, unit, mutex, resume tests |
| In-app typed sweep confirmation | Complete | prompt regression tests |
| Mainnet mint inspection fallback | Complete | Discovery service tests and readonly smoke |
| Report/dossier and final-sweep proof | Complete in code | proof staleness/binding tests |
| Structured Classic comparison | Complete in code | JSON/HTML exact-evidence tests |
| Independent production release gate | Complete | adversarial release-gate tests |
| Package/runtime smoke | Complete | Linux packaged v2 plus platform build jobs |
| Classic fallback | Complete | explicit startup route and E2E |

“Complete in code” is deliberately different from “field-proven on mainnet.”

## Production blockers

### 1. Prevent a v1 tag bypass

Current behavior:

- v2 is the desktop default;
- auto-release uses a patch bump unless the merged PR has `minor` or `major`;
- the production release gate applies only to semantic tags with major version
  `2` or higher.

Therefore a v2-default merge without `major` could generate a `v1.x` release
that retains the v1 unsigned-test policy.

Required resolution before merge:

- apply the `major` label and satisfy the v2 gate; or
- change release automation so a v2-default commit cannot produce a v1 tag; or
- split/hold the default-switch commit until the production inputs exist.

Documentation and reviewer habit are not sufficient as the final control. A
code-level invariant is recommended.

### 2. Authorized funded mainnet field run

Run one explicitly authorized, low-risk `mainnet-beta` launch from the exact
candidate commit through:

- managed launch wallet;
- token creation and authority finalization;
- every planned CLMM pool and position;
- Burn & Earn locks;
- Fee Key proof and configured transfers;
- exact configured airdrop rows, if any;
- report or downloaded local dossier;
- terminal token/NFT/SOL sweep;
- wallet-empty confirmation.

The operator must use a dedicated RPC and a funding/destination wallet placed in
scope for the test. Read-only smoke is useful but does not replace this step.

### 3. Field evidence and independent review

The field run must produce:

- `release-evidence/v2/field-verification.json`;
- the retained full raw Classic comparison input;
- `release-evidence/v2/release-attestation.json`.

The gate recomputes the launch fingerprint and sweep hash, validates concrete
proof and required Classic rows, verifies exact evidence and Classic SHA-256
digests, requires an ancestral field-run commit, enforces a 30-day freshness
window, and requires different GitHub users for operation and review.

### 4. Platform signing

Repository administrators must supply:

- macOS signing identity (`CSC_LINK`, `CSC_KEY_PASSWORD`);
- one complete Apple notarization method;
- Windows signing identity (`WIN_CSC_LINK`, `WIN_CSC_KEY_PASSWORD`).

V2 cannot publish unsigned test artifacts.

### 5. Dependency advisory disposition

The 2026-07-16 lockfile audit reports:

- 0 critical;
- 11 high;
- 2 moderate;
- 15 low.

Some highs have ordinary fixes available (for example current upload/tooling
transitives); others are coupled to Solana/Raydium or the Irys/Umi major line.
Before production, update/remediate the safely fixable paths and record an
explicit accept/mitigate/defer decision for the coupled paths after relevant
launch tests. See [SECURITY.md](SECURITY.md).

## Replacement criteria

The field packet contains twelve replacement criteria:

1. demo end to end;
2. wallet lifecycle;
3. Vanity CA options;
4. token configuration parity;
5. charts and viewport;
6. pool configuration parity;
7. funding and quote readiness;
8. held-reserve backing;
9. run and resume safety;
10. sweep/report proof;
11. Classic artifact comparison;
12. proof audit.

Automated tests exercise these criteria, but the production packet must show all
twelve passing against the same non-demo proof fingerprint. A renderer-generated
pass state alone is not acceptance.

## Release sequence

1. Resolve the v1-tag bypass invariant.
2. Remediate/disposition the current dependency audit.
3. Load repository signing/notarization credentials.
4. Run the authorized mainnet launch from the candidate commit.
5. Export the final proof after the terminal sweep.
6. Load and compare the retained Classic artifact.
7. Have a second GitHub user review and attest exact hashes.
8. Run `npm run release:gate -- v2.0.0` with signing variables loaded.
9. Apply the `major` label only when the candidate is intended to tag
    `v2.0.0`.
10. Merge, verify the tag, and monitor the full release workflow.
11. Verify release assets, checksums, trust metadata, GitHub Package, and
    marketing-site links.

## Exit criteria

The v2 production gap is closed only when:

- no v1 tag can ship the v2-default product;
- the exact field evidence and attestation are committed;
- the production gate passes on the release commit;
- all required platform credentials are present;
- dependency risk has a recorded production disposition;
- all PR checks and tag-release jobs are green;
- the published artifacts and website links verify.

Until then, the accurate state is:

> v2 token-launch release candidate; code-complete for guarded launch parity,
> awaiting production field proof, trust inputs, and release-invariant closure.

## Post-v2 work

These are improvements, not substitutes for the blockers above:

- modularize the large v2 renderer and proof code;
- add richer Discovery data providers;
- track Fee Key portfolios;
- add multi-launch operational views;
- explore browser-compatible read/configuration surfaces without weakening
  local custody.
