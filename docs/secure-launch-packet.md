# Secure Launch Packet (RFC)

Headless, sealed-execution launches: build a launch packet on the dev
laptop, ship it to an isolated host, run it there, and get only a proof
back. Private keys never touch the developer machine's disk after the
packet is sent — they are generated inside the execution environment and
destroyed with it.

## Why

Today a real launch runs in the desktop app on the operator's machine.
That is fine for one person, but it means:

- The mint authority, funding wallet, and vanity CA keys live in the
  same process space as the browser, chat apps, and everything else on
  a daily-driver laptop.
- Launch execution cannot be delegated to a clean, ephemerally
  provisioned machine.
- The CLI is read-only (deliberately) because the custody, journal,
  idempotency, and non-interactive confirmation contracts have not moved
  into Core yet.

The launch packet is the missing middle piece: a sealed, hash-pinned
input that a hardened runner can execute without interactive custody.

## Packet contents

Built by `scripts/build-launch-packet.mjs`:

```text
flybrain-v1/
  manifest.json    per-file SHA-256, plan digest, "no private keys" attestation
  launch.json      the launch config
  plan.json        the verified trebuchet-launch-plan/v1
  logo.png         token art
```

Manifest schema: `trebuchet-launch-packet/v1`. The runner MUST:

1. Recompute every file hash and compare against `manifest.json`.
2. Reject any mismatch or missing file before doing anything else.
3. Recompute the plan digest (`plan.integrity`) and confirm it matches
   the manifest's `planDigest`.

## Execution environment

The sealed runner (`packages/runner`) is deployed **per-operator** on
fly.io, not hosted by us:

- `cd packages/runner && fly launch --no-deploy` accepts the fly.toml +
  Dockerfile, `fly secrets set TREBUCHET_RUNNER_TOKEN=...`, `fly deploy`.
- Machines scale to zero when idle and start on the first request, so an
  idle runner costs ~nothing.
- **No volumes**: packet state, generated wallets, and the launch
  journal live in the machine's ephemeral filesystem and vanish with it.
- The runner runs as an unprivileged user in a minimal image (Node +
  Core source + runner source, nothing else).
- Operators attach the static planner site to their own runner by pasting
  their runner URL + token. Uploads go browser → runner directly; the
  site only builds and hashes the packet.

**Public web posture:** there is no hosted demo/try-it mode and no hosted
custody anywhere in this architecture. The public site is static
(Arweave / trebuchet.ratimics.com); every execution path runs on a
runner the operator deployed and owns.

## Key lifecycle inside the runner

1. Generate the funding wallet, mint authority, and (optional) vanity
   CA inside the container, using the same CSPRNG path as the app
   (`vanity_keygen` already emits VRF-bound grind proofs).
2. Fund the wallet from the operator out-of-band (SOL transfer).
3. Execute the plan stages (mint, metadata, revoke authorities, create
   pools, lock liquidity, sweep) journaling each step locally.
4. Export exactly one artifact: the launch proof
   (`trebuchet proof verify` already validates this format).
5. Destroy the instance. The only outbound copy of key material is
   whatever the operator explicitly chooses to back up (secret key
   printout shown once, then gone).

## What must land before this is allowed to touch mainnet

The CLI README already states the gate: custody, journal, idempotency,
and non-interactive confirmation contracts must move into Trebuchet
Core and pass a complete funded devnet recovery cycle.

Status of that gate:

| Contract | State |
|---|---|
| Journal | ✅ in Core (`packages/core/src/launch-journal.js`) |
| Recovery | ✅ in Core (`launch-recovery.js`) |
| Signed confirmation | ✅ in Core (`confirmation.js`) + `trebuchet confirm` |
| Headless custody keyfile | ✅ in Core (`custody.js`) + `trebuchet custody create` |
| Idempotency execution context | ✅ in Core (`v2-execution-context.js`) |
| Funded devnet recovery cycle | 🔶 see below |

### Funded devnet recovery cycle

`npm run test:e2e:devnet:recovery` runs the drill:

1. boot the local server against a devnet RPC with a fresh config dir
   (wallet + journal persist to disk, so a process kill is a genuine crash);
2. generate and fund a launch wallet from the CI funding wallet, bounded
   by `TREBUCHET_DEVNET_MAX_SPEND_SOL` (0.01–0.1 SOL);
3. drive the real staged path: readiness → arm run envelope → execute-next,
   one operation at a time;
4. `SIGKILL` the server at the configured operation boundary, restart it
   from the persisted config dir, re-arm, and resume;
5. reconcile the journal: exactly one token mint, no re-execution of
   completed irreversible operations, a coherent resume trail;
6. sweep remaining SOL back and write an evidence artifact
   (`release-evidence/v2/devnet-recovery/`).

Run it with `.github/workflows/devnet-e2e.yml` (workflow_dispatch, secret-gated,
protected `devnet-e2e` environment). It skips cleanly without the secrets,
so normal CI stays green and free.

**Scope limit, stated plainly:** Raydium's CLMM programs are mainnet-only,
so `/api/create-lp` cannot execute on devnet. The drill covers the on-chain
stages devnet can run for real (mint + metadata, authority revocation) and
the recovery/idempotency machinery around them, then stops cleanly at the
liquidity stage. The liquidity-stage recovery itself is covered today by the LP-stage
resume tests (`test/launch-lifecycle.test.mjs`, "createSinglePool resumes a
verified partial Phase 1 pool"), the PALM partial-result regression fixture,
and the re-resume tx-id preservation tests — plus, later, a local-validator
drill that clones the Raydium programs from mainnet.

The runner additionally needs:

- Devnet rehearsal: the same packet format and runner execute a full
  launch on devnet, twice, including one interrupted-and-recovered run.
- Sign-before-execute: the operator signs the manifest hash (not just
  the plan digest) with their own device before the runner may spend.
- Amount ceiling: the runner refuses `launchSol` above an operator-set
  cap, so a tampered packet cannot drain a funded wallet.
- Redaction: logs exported with the proof go through `logRedaction.js`.

Until those land, the packet builder is a packaging tool only: it
prepares and pins artifacts, it does not execute anything.

## Related

- `docs/flywheel-rotation.md` — the plan for a *rotating* flywheel (keeper or
  on-chain program). Rotation is opt-in and disclosed, and cannot apply to
  locked positions.

## Current status

- `scripts/build-launch-packet.mjs` — builds and pins packets. Done.
- `packages/runner` — sealed runner service: health/attach, bearer-token
  auth, packet upload with full hash + Core plan-digest verification.
  Deployable to fly.io (Dockerfile + fly.toml). Done.
- Core contracts — journal, recovery, confirmation, custody keyfile, and
  the idempotency execution context all live in `@trebuchet/core`.
- Funded devnet recovery drill — staged kill/resume drill implemented and
  wired to the secret-gated workflow (`test:e2e:devnet:recovery`).
- Runner launch execution — gated behind the remaining drill coverage:
  the liquidity stages need a local validator with cloned Raydium
  programs (or a mainnet drill) before `POST /v1/launches` opens.