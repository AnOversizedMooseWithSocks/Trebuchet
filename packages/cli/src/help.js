export const CLI_HELP = `Trebuchet CLI (experimental; demo execution)

Usage:
  trebuchet doctor [--json]
  trebuchet plan build --config <launch.json> [--out <plan.json>] [--json]
  trebuchet plan verify <plan.json> [--json]
  trebuchet estimate (--plan <plan.json> | --config <launch.json>) [--json]
  trebuchet proof verify <proof.json> [--json]
  trebuchet execute --config <launch.json> [--network demo] [--out <run.json>]
                   [--server <server.js>] [--timeout <seconds>] [--json]
  trebuchet custody create [--from <keypair.json>] --out <custody.json>
                           [--passphrase <p>] [--json]
  trebuchet confirm --plan <plan.json> --keyfile <custody.json> --network <n>
                    --max-spend-sol <n> [--wallet <pubkey>] [--expires-in <h>]
                    [--passphrase <p>] [--out <confirmation.json>] [--json]
  trebuchet confirmation verify <confirmation.json> [--expect-plan <plan.json>] [--json]
  trebuchet launch save --config <launch.json> [--name <label>] [--config-dir <dir>] [--json]
  trebuchet launch list [--config-dir <dir>] [--json]
  trebuchet launch remove --id <id> [--config-dir <dir>] [--json]

Global options:
  --json       Emit one versioned result envelope to stdout.
  --help       Show this help.
  --version    Show CLI and Core versions.

'trebuchet execute' runs a complete launch on the built-in demo chain:
no real RPC, no funds, disposable wallet. Live execution (mainnet/devnet)
remains blocked until custody, journal, idempotency, and non-interactive
confirmation contracts move into Core and pass a funded devnet recovery
cycle.

Custody keyfiles ('trebuchet custody create') hold one operator keypair,
encrypted at rest with a passphrase (scrypt + AES-256-GCM). 'trebuchet
confirm' signs a trebuchet-confirmation/v1 envelope binding a verified
plan digest, the network, a spend ceiling, and an expiry — the artifact
every live execution will be required to present.`;