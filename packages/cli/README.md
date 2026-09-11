# Trebuchet CLI

The Trebuchet CLI is an experimental, headless interface to Trebuchet Core
and the Trebuchet demo runtime. It does not import Electron, renderer
code, wallet custody, RPC adapters, or transaction services. Plan,
estimate, and proof commands are read-only; `execute` can run demo-runtime
launches only (disposable wallet, no funds, no real RPC).

Available commands:

```text
trebuchet doctor [--json]
trebuchet plan build --config launch.json [--out plan.json] [--json]
trebuchet plan verify plan.json [--json]
trebuchet estimate (--plan plan.json | --config launch.json) [--json]
trebuchet proof verify proof.json [--json]
trebuchet execute --config launch.json [--network demo] [--out run.json]
                [--server server.js] [--timeout seconds] [--json]
trebuchet custody create [--from keypair.json] --out custody.json [--passphrase p]
trebuchet confirm --plan plan.json --keyfile custody.json --network n --max-spend-sol n
trebuchet launch save --config launch.json [--name label] [--config-dir dir]
trebuchet launch list [--config-dir dir]
trebuchet launch remove --id id [--config-dir dir]
```

`trebuchet launch save` persists a planned launch (`launches.json` in the
config dir) so it survives an app restart and shows up in the desktop app's
saved-launch list, exactly like saved vanity addresses. This is also how a
launch can be created programmatically instead of being retyped in the UI.
`--config-dir` defaults to `TREBUCHET_CONFIG_DIR`, then the current
directory.

`trebuchet execute` runs a complete launch on the built-in demo chain:
the CLI boots the local Trebuchet server in an isolated temp config
directory (demo mode, disposable wallet, no funds, no real RPC), drives
the full launch (token, liquidity, sweep) through the server's
`/api/v2/demo-launch/run` endpoint, and writes the public run result to
`--out`. The wallet secret key never leaves the spawned server process.
Only `--network demo` is accepted.

JSON output uses `trebuchet-cli-result/v1`. Exit codes are stable within this
experimental contract: `0` success, `2` invalid input, `3` unsupported/not
ready, `4` custody locked, `5` retryable dependency failure, `6` recovery
required, `7` integrity mismatch, and `70` unexpected internal error.

There are deliberately no wallet or live launch-execution commands yet.
Demo-runtime execution is available via `trebuchet execute --network demo`.
Mainnet/devnet execution stays blocked until the funded devnet recovery
cycle passes: the journal, recovery, confirmation, custody, and
idempotency contracts are already in Core (see `docs/secure-launch-packet.md`
for the gate table and the recovery drill); the remaining coverage is the
liquidity-stage recovery drill, which needs a local validator with cloned
Raydium programs because Raydium's CLMM is mainnet-only.
