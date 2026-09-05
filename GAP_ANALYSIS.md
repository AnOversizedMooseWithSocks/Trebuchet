# Trebuchet production gap

Status date: 2026-08-08

## Executive summary

The implementation gap from Classic to the current Trebuchet token-launch experience is
largely closed. The remaining gap to a production `v2.0.0` is operational
proof and release trust. Auto-release now enforces
`TREBUCHET_MIN_RELEASE_MAJOR=2`, so the earlier v1-tag bypass is closed in
automation while Trebuchet is the desktop default.

The current Trebuchet-default pull request may be mergeable as code, but it is not safe
to merge and auto-publish until field evidence, independent review, signing
inputs, and the residual dependency-risk decision are complete.

## What is complete

| Area | State | Evidence |
| --- | --- | --- |
| Trebuchet desktop default | Complete | `main.js`, default/Classic tests |
| Terminal design and responsive shell | Complete | Trebuchet viewport and visual checks |
| Managed wallet, Recovery PIN, recovery inventory | Complete | wallet/PIN/recovery tests |
| Token/pool/airdrop/support configuration | Complete | plan/readiness and parity tests |
| Oversized logo normalization | Complete | Trebuchet logo tests and server upload validation |
| Guarded Classic-backed execution | Complete in code | API E2E, unit, mutex, resume tests |
| In-app typed sweep confirmation | Complete | prompt regression tests |
| Mainnet mint inspection fallback | Complete | Discovery service tests and readonly smoke |
| Report/dossier and final-sweep proof | Complete in code | proof staleness/binding tests |
| Structured Classic comparison | Complete in code | JSON/HTML exact-evidence tests |
| Independent production release gate | Complete | adversarial release-gate tests |
| 2.0 minimum-major release invariant | Complete | `auto-release.yml`, auto-version tests |
| Package/runtime smoke | Complete | Linux packaged Trebuchet app plus platform build jobs |
| Classic fallback | Complete | explicit startup route and E2E |

“Complete in code” is deliberately different from “field-proven on mainnet.”

## Production blockers

### 1. Authorized funded mainnet field run

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

### 2. Field evidence and independent review

The field run must produce:

- `release-evidence/v2/field-verification.json`;
- the retained full raw Classic comparison input;
- `release-evidence/v2/release-attestation.json`.

The gate recomputes the launch fingerprint and sweep hash, validates concrete
proof and required Classic rows, verifies exact evidence and Classic SHA-256
digests, requires an ancestral field-run commit, enforces a 30-day freshness
window, and requires different GitHub users for operation and review.

### 3. Platform signing

Repository administrators must supply:

- macOS signing identity (`CSC_LINK`, `CSC_KEY_PASSWORD`);
- one complete Apple notarization method;
- Windows signing identity (`WIN_CSC_LINK`, `WIN_CSC_KEY_PASSWORD`).

Trebuchet 2.0 cannot publish unsigned test artifacts.

### 4. Dependency advisory disposition

The 2026-08-08 lockfile audit policy reports:

- 0 critical;
- 7 high;
- 0 moderate;
- 17 low.

The audit policy passes because every remaining high dependency node traces to
the documented upstream `bigint-buffer` advisory in the Solana parser path.
Before production, record an explicit accept/mitigate/defer decision for that
residual after relevant launch tests. See [SECURITY.md](SECURITY.md).

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

1. Record the production disposition for the residual dependency advisory.
2. Load repository signing/notarization credentials.
3. Run the authorized mainnet launch from the candidate commit.
4. Export the final proof after the terminal sweep.
5. Load and compare the retained Classic artifact.
6. Have a second GitHub user review and attest exact hashes.
7. Run `npm run release:gate -- v2.0.0` with signing variables loaded.
8. Confirm auto-release still enforces `TREBUCHET_MIN_RELEASE_MAJOR=2` and the
   computed tag is `v2.0.0` or newer.
9. Merge, verify the tag, and monitor the full release workflow.
10. Verify release assets, checksums, trust metadata, GitHub Package, and
    marketing-site links.

## Exit criteria

The Trebuchet production gap is closed only when:

- no v1 tag can ship the Trebuchet-default product;
- the exact field evidence and attestation are committed;
- the production gate passes on the release commit;
- all required platform credentials are present;
- dependency risk has a recorded production disposition;
- all PR checks and tag-release jobs are green;
- the published artifacts and website links verify.

Until then, the accurate state is:

> Trebuchet token-launch release candidate; code-complete for guarded launch parity,
> awaiting production field proof, independent review, and trust inputs.

## Post-2.0 work

These are improvements, not substitutes for the blockers above:

- modularize the large Trebuchet renderer and proof code;
- add richer Discovery data providers;
- track Fee Key portfolios;
- add multi-launch operational views;
- explore browser-compatible read/configuration surfaces without weakening
  local custody.
