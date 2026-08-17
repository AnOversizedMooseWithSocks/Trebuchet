# Security Notes

## npm audit residuals

`npm audit --audit-level=high` currently reports 4 high-severity findings, all in one unfixable transitive chain:

- `bigint-buffer` through `@solana/spl-token` -> `@solana/buffer-layout-utils` (and `@raydium-io/raydium-sdk-v2`).
- `elliptic` through `@metaplex-foundation/umi-uploader-irys` and its Irys upload stack.

Three findings that DID have safe fix paths were resolved by override/version bumps rather than left as residuals
(release audit, August 2026). Each stays within its current major, so no API surface changed:

| Package | Was | Now | Advisory |
| --- | --- | --- | --- |
| `multer` (direct) | `^2.1.1` | `^2.2.0` | DoS via deeply nested field names; DoS via incomplete cleanup of aborted uploads. Directly reachable — this is the logo-upload endpoint. |
| `axios` (override) | `^1.16.1` | `^1.19.0` | Ten advisories incl. prototype pollution, `maxBodyLength` bypass, `NO_PROXY` bypass. Reached via Raydium SDK and the Irys stack. |
| `tmp` (override) | `^0.2.6` | `^0.2.7` | Type-confusion path traversal via non-string prefix/postfix. Reached via `arbundles -> tmp-promise`. |
| `form-data` (override) | `^4.0.5` | `^4.0.6` | CRLF injection via unescaped multipart field names. |

`bigint-buffer` has **no patched release at all** (latest published is the vulnerable `1.1.5`), so it cannot be
fixed in place at any version — it is an ecosystem-wide residual affecting every Solana app on the current
`@solana/spl-token` line. Mitigating detail: the vulnerability is in the *native* binding's `toBigIntLE()`, and
this app logs `bigint: Failed to load bindings, pure JS will be used` at startup, so the affected native path is
not the one in use. Revisit when `@solana/buffer-layout-utils` drops the dependency.

The npm force fixes are not safe to apply blindly:

- The `bigint-buffer` force fix downgrades `@solana/spl-token` to `0.1.8`, which removes APIs this app needs for current SPL/Token-2022 compatibility checks.
- The `elliptic` force fix moves the Irys uploader to the Umi `1.5.x` stack, while this app's Metaplex token metadata stack is still on the `0.9.x` Umi line.

Do not run `npm audit fix --force` without validating token minting, metadata upload, and Raydium CLMM creation end to end. Keep these residuals visible until compatible upstream Solana, Raydium, and Metaplex releases allow a non-breaking upgrade.

## SDK compatibility matrix

| Package | Current constraint | Why it matters | Upgrade blocker |
| --- | --- | --- | --- |
| `@solana/web3.js` | `^1.98.4` | Core wallet, token, and transaction RPC primitives. | Must remain compatible with `@solana/spl-token` and Raydium SDK transaction builders. |
| `@solana/spl-token` | `^0.4.14` | SPL minting, token accounts, authority revocation, and Token-2022 compatibility checks. | npm's `bigint-buffer` force fix downgrades this to `0.1.8`, which removes APIs used by Trebuchet. |
| `@raydium-io/raydium-sdk-v2` | `0.1.144-alpha` | CLMM pool creation, position opens, locks, and route/swap support. | Needs live CLMM validation before changing because failed pool transactions can spend real SOL. |
| `@metaplex-foundation/umi` | `^0.9.2` | Umi identity and transaction execution for token metadata. | Must stay aligned with MPL Token Metadata and the Irys uploader plugin line. |
| `@metaplex-foundation/mpl-token-metadata` | `^3.2.1` | Metadata account creation and update-authority revocation. | Umi major-line changes need token metadata create/update validation. |
| `@metaplex-foundation/umi-uploader-irys` | `^0.9.2` | Arweave/Irys logo and metadata upload. | npm's `elliptic` force fix moves this to `1.5.0`, crossing the Umi `1.x` boundary. |

## Upgrade workflow

Dependency changes touching token minting, metadata upload, or Raydium CLMM creation should:

- Run `npm audit --audit-level=high` before and after the change.
- Avoid `npm audit fix --force` unless the resulting dependency graph is validated.
- Run `npm run check:syntax` and `npm test`.
- Exercise metadata upload through `metadataUploadService.js` tests before attempting a full launch.
- For Solana/Raydium SDK upgrades, run an explicit live-RPC smoke on a low-risk wallet before shipping.
