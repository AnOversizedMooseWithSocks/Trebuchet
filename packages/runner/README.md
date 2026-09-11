# Trebuchet Sealed Runner

The operator-owned execution environment for Trebuchet launches. The
public site (trebuchet.ratimics.com / Arweave) is **static** and holds no
keys; each operator deploys their own runner on fly.io and attaches to
it. Wallets are generated inside the runner's ephemeral state and
destroyed with the machine.

**There is no hosted demo/try-it mode anywhere in this architecture.**

## What works today

- `GET /v1/health` — liveness and capability report (public).
- `POST /v1/attach` — operator handshake (bearer token).
- `POST /v1/packets` — upload a `trebuchet-launch-packet/v1` archive;
  the runner recomputes **every** manifest hash, verifies the embedded
  plan against the Core integrity contract, and refuses anything that
  does not match exactly. Verified packets get a `packetId`.
- `POST /v1/launches` — **gated**: answers `503 NOT_READY`. Launch
  execution is wired only after the Core custody gate opens (signed
  confirmation contract, custody backend, idempotency state machine,
  and a complete funded devnet recovery cycle — see
  `docs/secure-launch-packet.md`).

All routes except `/v1/health` require:

```
Authorization: Bearer $TREBUCHET_RUNNER_TOKEN
```

## Deploying your own runner

```bash
cd packages/runner
fly launch --no-deploy          # accepts the fly.toml + Dockerfile here
fly secrets set TREBUCHET_RUNNER_TOKEN="$(openssl rand -hex 32)"
fly deploy
```

The machine scales to zero when idle (`min_machines_running = 0`) and
starts on the first request, so an idle runner costs ~nothing. There are
**no volumes**: packet state, generated wallets, and the launch journal
live in the machine's ephemeral filesystem and vanish with it.

## Attaching from the planner site

The static planner asks for two things: your runner URL
(`https://<your-app>.fly.dev`) and the runner token (kept in your
browser's local storage, sent only to that URL). Uploads go straight
from your browser to your runner — the site only builds and hashes the
packet.

## Security notes

- The bearer token is compared in constant time.
- Packets that fail any hash check are deleted immediately and can
  never be launched.
- Path traversal in manifest entries is rejected (`path.resolve`
  must stay inside the packet directory).
- The runner runs as an unprivileged user in a minimal image
  (node:22-slim + Core source + runner source, nothing else).