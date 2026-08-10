# Trebuchet CLI and UX separation gap analysis

Status: 2026-08-09

## Decision

Trebuchet should become one execution product with two interfaces, not two
implementations:

- **Trebuchet Core** owns launch intent, validation, planning, readiness,
  execution, journaling, recovery, and proof generation.
- **Trebuchet CLI** is the stable, headless interface to Core. It is designed for
  scripts, operators, CI, and recovery when the desktop application is
  unavailable.
- **Trebuchet Desktop** is the guided visual interface. It can improve quickly,
  but it submits the same typed intents and invokes the same use cases as the
  CLI.
- **Trebuchet Local API** is an optional adapter used by Desktop. It translates
  HTTP requests into Core calls and must not own launch rules or orchestration.

The credible boundary is therefore not “terminal versus Electron.” It is
**stable execution contracts versus replaceable presentation**.

## Current assessment

Trebuchet does not currently have a product CLI. `package.json` has no `bin`
entry, there is no command or exit-code contract, and the repository publishes a
single desktop package. The scripts under `scripts/` are developer utilities;
calling them a stable CLI would be misleading.

The desktop renderer and local HTTP server are also too coupled to serve as a
clean foundation:

- `public/v2/app.js` is approximately 21,000 lines and combines rendering,
  client state, workflow decisions, proof handling, and API calls.
- `server.js` is approximately 8,100 lines and combines Express routing,
  validation, launch orchestration, progress state, recovery, and service calls.
- `main.js` starts `server.js` by side-effect import after setting process-wide
  environment variables. `server.js` immediately listens on a port, which makes
  the runtime difficult to embed or test without HTTP.
- `v2LaunchPlan.js` is a useful deterministic seam for planning and readiness,
  but its contracts have not yet been promoted into a public Core API.
- Chain, wallet, storage, and report services are reusable in principle, but
  several read global configuration, use process-wide stores, or report through
  `console` and timers rather than injected ports and structured events.
- CI has substantial desktop, API, viewport, visual, packaging, and optional
  devnet coverage, but no CLI contract tests or CLI release artifact.

## Gap matrix

| Capability | Current state | Gap to a credible split |
| --- | --- | --- |
| Product command | Missing | No `trebuchet` binary, command grammar, help contract, or standalone artifact. |
| Launch contracts | Partial | Plan/readiness/proof shapes exist but are scattered and include persisted `v2` markers. |
| Core use cases | Missing | Important orchestration lives inside Express route handlers. |
| Chain adapters | Partial | Service modules exist, but runtime configuration, progress, and retries are not consistently injected. |
| Runtime construction | Weak | Server startup and configuration rely on module side effects and process globals. |
| Custody and storage | Partial | Local journals and secret protection are strong, but Electron `safeStorage`, PIN storage, paths, and recovery policy need explicit interfaces. |
| Structured progress | Missing | UI-oriented polling and console output do not form a stable event contract. |
| Automation safety | Missing | No non-interactive prompt policy, dry-run contract, `--yes` rules, or documented exit codes. |
| Idempotency/recovery | Partial | Journals and resume checks exist, but they are not exposed as stable command outcomes. |
| UX/core parity | Weak | Desktop can encode decisions in renderer state before the server rebuilds readiness. Both interfaces need one `LaunchIntent`. |
| Version negotiation | Missing | Desktop and local API ship together, so there is no explicit protocol compatibility handshake. |
| CLI testing/release | Missing | No golden command fixtures, cross-platform command smoke, or signed/checksummed CLI deliverable. |

## Target architecture

Start with a small number of strong boundaries. Splitting every existing file
into a package immediately would create motion without isolation.

```text
packages/
  core/          contracts, validation, planning, use cases, events, errors
  solana/        RPC, token, Raydium, metadata, and transaction adapters
  storage/       journals, secrets, pending wallets, reports, preferences
  local-api/     authenticated loopback HTTP adapter
  cli/           command parsing, prompts, JSON/text presenters, exit codes
apps/
  desktop/       Electron shell and Trebuchet renderer
```

The first extraction may keep `contracts` inside `core`. Create a separate
contracts package only when another package needs to depend on schemas without
pulling in the runtime.

Core should expose an explicit runtime rather than globals:

```js
const runtime = createTrebuchetRuntime({
  chain,
  custody,
  journalStore,
  reportStore,
  clock,
  logger,
});

await runtime.planLaunch(intent);
await runtime.estimateLaunch(plan);
await runtime.executeLaunch(plan, confirmation);
await runtime.resumeLaunch(journalId, confirmation);
await runtime.verifyProof(proof);
```

Neither Core nor the CLI may import Electron, Express, DOM APIs, renderer code,
or a process-global config singleton. The Local API and CLI adapt external input
to these calls; they do not reimplement them.

## Stable CLI contract

A useful first command surface is:

```text
trebuchet doctor [--json]
trebuchet plan build --config launch.json --out plan.json
trebuchet plan verify plan.json [--json]
trebuchet estimate --plan plan.json [--json]
trebuchet wallet create|import|list|unlock
trebuchet launch run --plan plan.json [--network devnet|mainnet] [--yes]
trebuchet launch status <journal-id> [--json]
trebuchet launch resume <journal-id> [--yes]
trebuchet launch sweep <journal-id> --destination <address> [--yes]
trebuchet proof verify <proof.json> [--json]
trebuchet proof export <journal-id> --out <proof.json>
```

Required behavior:

- Human-readable output is the default for a TTY. `--json` emits one documented
  schema to stdout; progress and diagnostics go to stderr.
- A non-TTY invocation never opens an interactive prompt. Missing confirmation
  fails closed.
- Mainnet is never inferred. It requires `--network mainnet` and either a typed
  interactive confirmation or an explicit automation policy such as `--yes`.
- Every irreversible command prints or emits its journal ID and recovery command
  before the first transaction is sent.
- Partial completion is a distinct outcome, not a generic failure. It includes
  the journal, observed signatures, safe next actions, and unsafe unknowns.
- Secrets are accepted through protected files, keychain-backed custody, or
  stdin with explicit flags. They never appear in argv, logs, JSON output, or
  shell history guidance.

Proposed stable exit codes:

| Code | Meaning |
| --- | --- |
| `0` | Completed successfully. |
| `2` | Invalid command, config, or input. |
| `3` | Valid request, but readiness checks did not pass. |
| `4` | Wallet or custody is locked/unavailable. |
| `5` | Network or other retryable dependency failure. |
| `6` | Partial execution; recovery or resume is required. |
| `7` | Proof, fingerprint, or journal integrity mismatch. |
| `70` | Unexpected internal error. |

These meanings and all `--json` schemas become semantic-versioned public
contracts. Text copy and progress presentation do not.

## What “stable CLI” must mean

The CLI is credible as a stable interface only when all of these are true:

1. It runs headlessly on supported macOS, Linux, and Windows environments
   without Electron, Chromium, or an HTTP server.
2. Plan construction and verification are deterministic against committed
   golden fixtures.
3. JSON schemas, exit codes, idempotency keys, and recovery semantics are
   documented and protected by compatibility tests.
4. Non-interactive execution fails closed when any prompt, wallet unlock,
   network selection, or destructive confirmation is missing.
5. An interrupted execution can be inspected and resumed from its journal
   without the desktop application.
6. Every release produces a checksummed CLI artifact or npm package, an SBOM,
   and platform smoke results. Signing should follow the same trust policy as
   desktop releases.
7. CI exercises `doctor`, plan build/verify, dry-run, proof verification, and a
   funded devnet lifecycle through the published command surface—not private
   service functions.

Until those conditions hold, the command should be labeled experimental and
must not be presented as the recovery backstop for mainnet launches.

## What the UX is allowed to change

Desktop can iterate on layout, copy, tutorial steps, charts, and progressive
disclosure without destabilizing Core. It must still obey these constraints:

- Guided and Advanced modes both compile into the same versioned
  `LaunchIntent`; Guided is a recipe over Core fields, not a second launch model.
- Desktop invokes typed Core use cases through the Local API or a future IPC
  adapter. It does not import chain services directly.
- The final review shows the normalized plan returned by Core, including
  defaults the UX chose on the operator's behalf.
- Execution and recovery state come from journals and structured runtime
  events, not inferred button state.
- Desktop performs a Core/protocol version handshake and refuses incompatible
  combinations with a clear upgrade message.
- Removing internal `/api/v2` routes or `trebuchet-v2-*` persisted markers is a
  separately planned compatibility migration. Product branding does not
  authorize changing those contracts.

## Refactor sequence

### Phase 0 — Characterize before moving code

- Freeze representative launch intents, normalized plans, readiness results,
  proof fingerprints, journal transitions, and failure classifications as
  golden fixtures.
- Add contract tests at the current server boundary so extraction can prove
  behavior preservation.
- Inventory every renderer decision that affects execution rather than
  presentation.

### Phase 1 — Make the runtime constructible

- Change `server.js` from a side-effect process into
  `createLocalApiServer(runtime, options)` with explicit `start()` and `stop()`.
- Introduce `createTrebuchetRuntime(dependencies)` and inject configuration,
  stores, clock, logger, RPC, and custody.
- Keep all current HTTP paths and persisted markers as compatibility adapters.

### Phase 2 — Extract Core use cases

- Move plan, estimate, execute-next, full-run, inspect, resume, sweep, and proof
  orchestration out of route handlers.
- Give Core a typed error taxonomy matching the proposed exit codes and HTTP
  responses.
- Replace polling-only progress with structured events carrying operation ID,
  journal ID, stage, attempt, signature, and recovery state.

### Phase 3 — Ship a read-only CLI first

- Add `trebuchet doctor`, `plan build`, `plan verify`, `estimate`, and
  `proof verify`.
- Add snapshot tests for text output and schema tests for JSON output.
- Run these commands on all supported platforms in CI.

This proves the package and contract boundary without putting funds at risk.

### Phase 4 — Add custody and stateful execution

- Add wallet, status, run, resume, sweep, and proof export commands.
- Implement TTY/non-TTY confirmation policy and secret-safe inputs.
- Validate complete and interrupted devnet launches through the CLI artifact.

### Phase 5 — Put Desktop on the same use cases

- Convert Guided and Advanced configuration into one `LaunchIntent` DTO.
- Make the Local API a thin adapter over Core and delete duplicate server and
  renderer orchestration as each route migrates.
- Drive the desktop progress UI from structured Core events and journal state.

### Phase 6 — Separate releases

- Publish independently testable Core/CLI artifacts and the Desktop app.
- Gate compatibility with protocol versions and a support matrix.
- Keep `/api/v2` and existing persisted schema aliases until migration tooling,
  telemetry-free compatibility checks, and a deprecation window are complete.

## First three pull requests

1. **Runtime factory, no behavior change.** Export server construction and
   lifecycle; inject config, logger, clock, and storage paths; preserve every
   current route and test.
2. **Core contracts and golden fixtures.** Move launch-plan/readiness contracts
   behind `packages/core`, retain compatibility exports from `v2LaunchPlan.js`,
   and lock plan/proof/journal behavior with fixtures.
3. **Read-only experimental CLI.** Add the `trebuchet` binary with `doctor`,
   `plan build`, `plan verify`, and `proof verify`; document JSON and exit-code
   contracts; add cross-platform CI smoke.

Do not begin by renaming `public/v2`, `/api/v2`, or persisted proof keys. That
would spend migration risk without creating the CLI/Core boundary. Rename those
internals only after both interfaces share Core and compatibility aliases can be
tested end to end.

## Release recommendation

Continue shipping the desktop product as **Trebuchet**. Treat the CLI as
experimental through the read-only phase and through one complete devnet
execution/recovery cycle. Promote it to stable only after Phase 4 acceptance is
met and Desktop is demonstrably consuming the same Core use cases.

The desired end state is simple to explain and verify:

> Trebuchet Desktop helps a person launch safely. Trebuchet CLI exposes the
> same engine predictably to operators and automation. Core is the authority for
> both.
