# Trebuchet CLI

The Trebuchet CLI is an experimental, headless, read-only interface to
Trebuchet Core. It does not import Electron, Express, renderer code, wallet
custody, RPC adapters, or transaction services.

Available commands:

```text
trebuchet doctor [--json]
trebuchet plan build --config launch.json [--out plan.json] [--json]
trebuchet plan verify plan.json [--json]
trebuchet estimate (--plan plan.json | --config launch.json) [--json]
trebuchet proof verify proof.json [--json]
```

JSON output uses `trebuchet-cli-result/v1`. Exit codes are stable within this
experimental contract: `0` success, `2` invalid input, `3` unsupported/not
ready, `4` custody locked, `5` retryable dependency failure, `6` recovery
required, `7` integrity mismatch, and `70` unexpected internal error.

There are deliberately no wallet or launch-execution commands yet. Those are
blocked until custody, journal, idempotency, and non-interactive confirmation
contracts move into Core and pass a complete funded devnet recovery cycle.
