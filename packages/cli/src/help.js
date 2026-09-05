export const CLI_HELP = `Trebuchet CLI (experimental, read-only)

Usage:
  trebuchet doctor [--json]
  trebuchet plan build --config <launch.json> [--out <plan.json>] [--json]
  trebuchet plan verify <plan.json> [--json]
  trebuchet estimate (--plan <plan.json> | --config <launch.json>) [--json]
  trebuchet proof verify <proof.json> [--json]

Global options:
  --json       Emit one versioned result envelope to stdout.
  --help       Show this help.
  --version    Show CLI and Core versions.

This release cannot create wallets or send transactions. Existing internal
v2 proof markers remain accepted compatibility identifiers.`;
