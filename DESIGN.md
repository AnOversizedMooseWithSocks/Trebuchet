# Trebuchet v2 design system

This document defines the production-facing v2 terminal. The implemented source
of truth is [public/v2/styles.css](public/v2/styles.css). Classic intentionally
keeps its parchment identity and is not the template for new v2 work.

## Product posture

Trebuchet should feel like a crypto operations terminal: compact, local,
instrumented, and explicit about risk. It is not a generic SaaS dashboard and
not a playful token-minting toy.

The interface should answer five questions without making the operator hunt:

1. What launch and wallet am I operating?
2. What is verified, modeled, staged, running, or failed?
3. What is the next authorized action?
4. What will that action cost and change?
5. Where is the transaction, journal, or proof behind the claim?

## Core visual rules

- Use hard panel edges, 1 px rules, tabular rows, and dense spacing.
- Use the local mono face for operational UI and tabular numerals.
- Keep a clear three-column hierarchy: primary work, evidence/progress, next
  action.
- Prefer one framed workspace with internal dividers over a pile of floating
  cards.
- Preserve first-viewport utility. Configure/Fund/Execute/Verify/Recover switch
  within the Launch workspace instead of growing a long landing page.
- Use color for state and focus, not decoration.
- Keep labels concrete: **Estimate funding**, **Arm run**, **Retry airdrop**,
  **Download proof**. Avoid vague CTA language.

## Anti-patterns

Do not introduce:

- large rounded white cards;
- pill-heavy navigation;
- inflated hero typography;
- comic, novelty, or handwritten type;
- chunky gradients and oversized shadows;
- marketing copy inside the execution surface;
- color-only status;
- clipped addresses that hide the suffix;
- native browser prompts or confirms;
- a recovery list visually nested under the active wallet;
- preview/staged data presented as live proof.

If a change could be dropped into a generic CRM or analytics SaaS app unchanged,
it probably does not belong in the v2 terminal.

## Palette

The final terminal token block in `public/v2/styles.css` overrides the early
prototype tokens:

| Token | Dark value | Role |
| --- | --- | --- |
| `--bg` | `#030706` | Application field. |
| `--panel` | `#070b0a` | Primary terminal surface. |
| `--panel-2` | `#090e0c` | Secondary row/surface. |
| `--panel-strong` | `#0b110f` | Inputs and raised evidence surfaces. |
| `--ink` | `#e5eee9` | Primary text. |
| `--muted` | `#7c8c84` | Secondary text. |
| `--subtle` | `#4d5b54` | Metadata and dormant state. |
| `--line` | `#17221d` | Ordinary rules. |
| `--line-strong` | `#30433a` | Focused/structural rules. |
| `--green` | `#74f7a9` | Ready, verified, active selection. |
| `--blue` / `--cyan` | `#68cfff` | Informational/live data. |
| `--amber` | `#f3be5b` | Warning, needs review, staged. |
| `--red` | `#ff6570` | Failed, destructive, blocked. |
| `--violet` | `#b09cff` | Secondary proof and selection accent. |

The light-mode overrides are functional, not a separate aesthetic. Maintain the
same hierarchy and state semantics with accessible darker accents.

Do not paste new hex values into components when an existing semantic token
fits. Rarity colors are scoped to Vanity CA grading and must not become general
status colors.

## Typography

The v2 terminal ships local JetBrains Mono weights and sets:

```css
--mono: "JetBrains Mono", "SFMono-Regular", Consolas, monospace;
```

The body uses `12px`, tabular numerals, slashed zero, and slightly tightened
tracking. The working scale is deliberately small:

- view title: about `20px / 700`;
- section title: about `14px / 700`;
- row title: about `12px / 700`;
- body/help: `11–12px`;
- eyebrow/table label: `7–10px`, uppercase, tracked.

Addresses, signatures, hashes, prices, quantities, and state codes must use the
mono stack and tabular figures. Do not mix a decorative display face into the
terminal.

## Geometry and spacing

- Primary radius: `2px`; small radius: `1px`.
- Sidebar width: `204px` on full desktop.
- Borders: normally `1px`.
- Dense controls: roughly `22–32px` high.
- Primary actions may be taller, but should not become landing-page buttons.
- Default internal gaps are `4–12px`; large gaps should indicate a real change
  of workspace, not arbitrary breathing room.
- Shadows are exceptional. Structure should come from lines, contrast, and
  surface tone.

Responsive layouts collapse the sidebar and columns, preserve a minimum target
size for touch actions, and keep horizontal overflow at zero. Charts may become
horizontally paged cards on narrow screens, but the primary next action must
remain visible.

## Application shell

The full desktop shell is:

- left navigation: Launch, Wallet, Discovery, History, Settings;
- terminal tape: chain, environment, signer, execution policy, custody;
- topbar: current workspace and selected wallet;
- global strip: health/blocker summary;
- view-owned workspace.

The terminal tape is operational context, not branding filler. If a value is not
known, display an unavailable/unknown state instead of a confident placeholder.

## Status grammar

Use a small, stable vocabulary:

| State | Meaning | Color |
| --- | --- | --- |
| Draft / Preview | Local input or visualization only. | muted |
| Model | Normalized plan/estimate, not chain evidence. | blue |
| Staged | Bound to a wallet/config and waiting for authorization. | amber |
| Running | Operation is active. | blue/green with text |
| Proof / Ready | Backed by required evidence. | green |
| Needs proof / Review | Incomplete or operator action required. | amber |
| Blocked / Failed | Unsafe or unsuccessful. | red |

Never use **Ready**, **Minted**, **Complete**, or **Verified** solely because a
renderer transaction row changed state. These words require the evidence
defined by the execution and proof layers.

## Addresses and identifiers

Compact Solana addresses must preserve both identity anchors:

```text
ABCD…WXYZ
```

- Show at least the first four and last four characters.
- Never truncate only the end.
- Provide the full value through copy, title/accessible description, a details
  row, or destructive confirmation.
- Do not break a signature into proportional text.

The same rule applies to mint addresses, wallets, pool IDs, position NFTs, Fee
Keys, and transaction signatures.

## Controls

### Buttons

- Primary: one dominant action per local context.
- Secondary: outlined or low-fill.
- Destructive: red border/fill plus explicit text.
- Icon-only controls require an accessible label and visible focus state.
- Loading must keep the action width stable and explain what is running.

### Numeric steppers

Use the compact terminal pattern:

```text
−  10  +
```

Do not expose browser spinner chrome. The minus and plus are real buttons with
keyboard/focus behavior; the value remains directly editable where precision
matters.

### Uploads

The logo control should look like an instrument input, not a chunky drop-zone
CTA:

- compact choose/replace action;
- filename, source dimensions, and size;
- local preview;
- normalization/compression result;
- validation error next to the control.

Accept only formats supported by the execution contract. Never imply that a
large file was accepted until the normalized payload passes Classic limits.

### Confirmation dialogs

Use the in-app operator dialog. A destructive action should show:

- operation;
- wallet or destination in full;
- affected assets/state;
- typed confirmation requirement;
- cancel and confirm actions with distinct hierarchy.

Never call `prompt()`, `confirm()`, or `alert()` for an Electron workflow.

## Major surfaces

### Launch cockpit

Keep the agent/next-move rail, tokenomics, liquidity, funding, and signature
evidence visible as a coordinated instrument. Drawers hold advanced detail, not
basic progress.

Classic parity controls may be collapsed, but their values and blockers must
feed the same plan and proof state as the primary controls.

### Recovery

The active wallet is not the parent of every recoverable wallet. Put recovery
inventory in the central History/Wallet workspace, collapsed by default when it
is not the current task. Separate:

Use the wallet's rarity grade as the selected-wallet identity accent across its
row, topbar indicator, and active-signer badge. Keep warning, failure, and
destructive colors independent so rarity never obscures operational state.

- active launch signer;
- pending/recovery wallets;
- launch journals;
- unsafe manual recovery.

Each row needs state, last evidence, available action, and a full-detail
inspection path.

### Discovery

Use dense evidence rows and a focused inspection rail. No popularity score,
likes, paid placement, social feed, or oversized token cards. Confidence must be
explained by available evidence.

## Accessibility

- Maintain visible `:focus-visible` states.
- Do not remove keyboard access when replacing native controls.
- Status needs text/icon shape in addition to color.
- Use `aria-live` only for meaningful state transitions.
- Keep destructive dialog focus trapped and return focus on close.
- Respect zoom and narrow widths; do not freeze text into pixel-perfect boxes.
- Preserve QR quiet zones and full address copy access.

## Classic boundary

Classic is a compatibility and comparison surface. Its parchment design may be
maintained in `public/`, but new v2 work must not copy its serif typography,
paper fills, large narrative spacing, or manuscript ornament.

The v2 dossier can render Classic-style report artifacts where parity requires
it. That report styling is evidence compatibility, not the v2 application
identity.
