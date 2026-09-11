# Flywheel rotation (plan)

How a flywheel can become a *running* mechanism — claim fees, recycle them
into the paired memecoin, re-weight the pools — instead of a static split.
This is the plan for later work. Today the flywheel is a one-time allocation;
nothing rotates, and nothing spends.

Read alongside `docs/secure-launch-packet.md` (packet + sealed runner) and
`packages/core/src/flywheel-schedule.js` (the policy contract that already
exists and is tested).

## The constraint that shapes everything

**Trebuchet locks liquidity.** Positions are locked in Raydium's lock program
(`DLockwT7X7sxtLmGH9g5kmfcjaBtncdbUmi738m5bvQC`) and authorities are revoked.
That is the product: buyers can verify the operator cannot pull liquidity.

A rotating flywheel means liquidity *moves*. So rotation is not a feature that
can be switched on under the current model — it is a **different promise**, and
it must be:

1. **Opt-in** — `mode: "static"` stays the default, and the safe state.
2. **Disclosed** — the mode, targets, cadence, and keeper identity belong in
   the launch plan and the published report, not in a README.
3. **Scoped** — only the quote/flywheel side may rotate. The launched token's
   mint, metadata, and supply stay exactly as launched.

Two ways to make the moving part unattended, in order of effort:

| | Path A — keeper | Path B — program |
|---|---|---|
| Trigger | sealed runner on a timer | permissionless on-chain `crank()` |
| Custody | runner holds the Fee Key NFTs | program vault owns the position |
| Trust | keeper key can act (bounded by the schedule) | no keeper key exists |
| Effort | weeks (reuses the runner) | longer + audit |
| Rotation of *locked* positions | impossible | impossible |

Both paths need the same thing first: **rotation liquidity must not be in the
lock program.** A rotating flywheel therefore keeps its rotational share in an
unlocked vault position (Path B) or an unlocked hub position the keeper owns
(Path A). Only the non-rotating share stays locked. The plan must say which
share is which, and the report must show it.

## The policy contract (exists today)

`packages/core/src/flywheel-schedule.js` — pure, chain-free, tested:

```jsonc
{
  "schema": "trebuchet-flywheel-schedule/v1",
  "mode": "static" | "rotating",
  "targets": [{ "poolId": "sol-main", "weightPct": 70 },
              { "poolId": "meme-flywheel", "weightPct": 30 }],
  "minIntervalSec": 900,          // never crank faster than this
  "driftThresholdPct": 3,         // only act when a pool drifts this far
  "maxSpendSolPerCrank": 0.05,    // hard ceiling per crank
  "maxSpendSolPerDay": 0.5,       // hard ceiling per day
  "maxCranksPerDay": 12,          // crank count ceiling
  "slippageBps": 100,             // swap bound
  "cooldownAfterFailureSec": 1800,
  "killSwitch": false
}
```

`decideCrank({ schedule, state, now })` returns exactly one of:

- **`crank`** — drift exceeds the threshold, limits allow it; returns the
  target weights and a per-crank spend ceiling (never above the day's
  remainder).
- **`wait`** — interval not elapsed, still cooling down after a failure, or
  drift is below the threshold. Retrying later is expected to work.
- **`pause`** — static mode, kill switch, daily crank or spend ceiling
  reached. A human must intervene.

Every knob is range-clamped, weights must sum to 100, and a missing schedule
normalises to `static`.

## Path A — keeper on the sealed runner

Reuses everything in `docs/secure-launch-packet.md`.

**Crank sequence** (one journal entry per step, idempotent at each boundary):

1. `claim` — collect fees for the rotational position(s).
2. `swap` — convert fees into the paired memecoin, bounded by `slippageBps`.
3. `add` — add the swapped amount to the flywheel pool (or deepen the hub).
4. `report` — append the crank to the launch proof trail: timestamp, drift
   before/after, spend, tx ids.

**Design rules**

- The keeper never touches the launched token's mint or the locked positions.
- A crank that does not complete is journaled as failed and resumed, never
  retried blind — the same `alreadyDone` discipline the launch uses.
- `decideCrank()` is called *immediately before* acting and the returned
  ceiling is enforced by the signer, not merely displayed.
- Fees stay in the vault until a crank succeeds; a failed swap leaves them
  claimable rather than half-converted.
- Kill switch is polled from the runner's config so the operator can stop the
  flywheel without redeploying.

**Acceptance criteria (all on devnet, funded)**

- Two consecutive cranks with the second refused by `minIntervalSec`.
- A crank interrupted between claim and swap resumes without double-claiming.
- A crank whose swap would exceed `slippageBps` aborts and leaves funds intact.
- Daily spend and crank ceilings stop the loop with `pause`, and the kill
  switch stops it immediately.
- Every crank leaves a verifiable trail (drift before/after, spend, tx ids)
  that reconciles against on-chain balances.

**Not trustless.** The keeper holds the Fee Key NFTs, so it can act. The
schedule bounds what it can do; it cannot be *prevented* from doing less
(never rotating is always allowed). Say this plainly in the report.

## Path B — an on-chain program (later)

A small Anchor program that:

- owns the rotational position (or a vault position) instead of a keeper key;
- stores the schedule in a PDA, so the rules are public and auditable;
- exposes `crank()` that anyone may call, enforcing `decideCrank()`'s rules
  on-chain (interval, drift, per-crank and per-day ceilings, slippage bound);
- emits events so the launch report can reconstruct every rotation from chain
  data alone.

Once that exists, the same vortex UI writes the schedule and the report can
prove the flywheel's entire history without trusting an operator or a keeper
key. Costs: program implementation, tests, an audit, and a deliberate
decision about upgrade authority (immutable vs upgradeable-with-timelock).

## Milestones

| # | Milestone | Depends on | Done when |
|---|---|---|---|
| 0 | Policy contract in Core | — | ✅ `flywheel-schedule.js` + 8 tests |
| 1 | Schedule surfaced in plan and report | 0 | plan/report name the mode, targets, cadence, keeper; `static` stays default |
| 2 | Rotational vs locked split made explicit | 1 | plan shows which share rotates and which is locked, and the lock record matches |
| 3 | Path A keeper in the sealed runner | 2, devnet drills | acceptance criteria above pass on devnet, twice |
| 4 | Path A on mainnet behind disclosure | 3 | first live crank with proof trail and reconciled balances |
| 5 | Path B program | 4, audit | `crank()` permissionless on devnet, rules enforced on-chain, events reconcile the report |
| 6 | Rotate locked positions | 5 | only if the lock program ever supports delegated rotation — otherwise out of scope by design |

## Explicit non-goals

- No rotation of locked positions. If the lock cannot move, the liquidity
  cannot either; pretending otherwise would break the launch's promise.
- No automatic rotation without disclosure. A flywheel that moves is a
  different product and must be sold as one.
- No keeper on the operator's laptop. Path A runs in the sealed runner or not
  at all.
