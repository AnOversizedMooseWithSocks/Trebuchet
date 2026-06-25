# Trebuchet

A barebones Solana token launcher. No frills, no extractive nonsense.

[![CI](https://github.com/AnOversizedMooseWithSocks/Trebuchet/actions/workflows/ci.yml/badge.svg)](https://github.com/AnOversizedMooseWithSocks/Trebuchet/actions/workflows/ci.yml)

> The trebuchet is the superior siege weapon. It can launch a 90 kg
> projectile over 300 meters.

Trebuchet mints an SPL token, deploys it as single-sided liquidity on
Raydium CLMM, locks the position with Burn & Earn, and hands you the
Fee Key NFTs that will earn fees forever. It runs on your own machine
against your own RPC, with no middleman taking a cut of your supply,
charging launch fees, or holding your liquidity hostage.

## A tour of the launch flow

Every launch walks the same six steps. These images are generated
automatically from the app itself — a real demo-mode launch driven by
[`scripts/capture-screenshots.mjs`](scripts/capture-screenshots.mjs).
CI re-runs that launch and refreshes every image whenever the UI
changes, so what you see below is the current build, not a screenshot
from six versions ago.

<p><img src="docs/screenshots/launch-flow.gif" width="760" alt="A complete launch, start to finish"></p>

*The whole happy path, start to finish: generate a wallet, configure,
fund, mint, build pools, transfer.*

<p><img src="docs/screenshots/00-settings.png" width="760" alt="The settings panel — RPC endpoint, demo mode, startup options"></p>

*Before anything else: the settings panel. Pick your RPC endpoint (a
dedicated one — the public endpoint will rate-limit a real launch),
toggle demo mode to walk the whole flow with no real transactions, and
set startup preferences.*

### 1. Generate a launch wallet

<p><img src="docs/screenshots/01-generate-wallet.png" width="760" alt="Step 1 — generate the ephemeral launch wallet"></p>

Every launch uses a fresh ephemeral wallet; nothing touches your
personal keys. You can optionally grind a vanity contract address here.

### 2. Configure the token and pools

<p><img src="docs/screenshots/02-token-config.png" width="760" alt="Step 2 — configure the token, with live 3D coin preview"></p>

Name, symbol, supply, logo, and target market cap — with a live 3D
preview of your coin and a running cost estimate. Simple mode picks
sensible pool defaults; everything below is optional.

<p><img src="docs/screenshots/03-tokenomics.png" width="680" alt="The tokenomics dialog — where every token goes"></p>

*Visualize tokenomics: the allocation donut shows where every token
goes — pools, positions, ladder bands, preallocation — before you
commit to anything.*

<p><img src="docs/screenshots/04-advanced-options.png" width="680" alt="Advanced options — preallocation, support floor, pool pairing"></p>

*Advanced options: hold back a preallocation, set a support floor that
backstops the price, and choose what your launch pairs against.*

<p><img src="docs/screenshots/05-airdrop-config.png" width="680" alt="Airdrop configuration — CSV recipients with per-wallet amounts"></p>

*Airdrops: paste or upload a CSV of recipients and amounts; delivery is
tracked per-wallet during the final transfer, with retry for failures.*

<p><img src="docs/screenshots/06-custom-pools.png" width="680" alt="Customize mode — per-pool fee tiers, slices, and ladder bands"></p>

*Customize mode: full manual control — multiple pools, quote tokens,
fee tiers, Fee Key slice splits, and ladder positions with per-band
price ranges.*

### 3. Fund the wallet

<p><img src="docs/screenshots/07-funding.png" width="760" alt="Step 3 — fund the launch wallet"></p>

Send the estimated SOL to the launch wallet; the checklist turns green
as funds arrive. (In demo mode, a button pretends for you.)

### 4. Mint the token

<p><img src="docs/screenshots/08-create-token.png" width="760" alt="Step 4 — mint the token"></p>

SPL token with Metaplex metadata; mint, freeze, and metadata-update
authorities are renounced on the spot, so the supply and identity are
locked before the pools exist.

### 5. Create pools and positions

<p><img src="docs/screenshots/09-preflight-confirm.png" width="520" alt="Pre-flight price confirmation before anything launches"></p>

*Before anything touches the chain, a pre-flight probe resolves live
prices and asks you to confirm them — a drift guard against launching
into a moved market.*

<p><img src="docs/screenshots/10-create-pools.png" width="760" alt="Step 5 — create pools and locked positions"></p>

Raydium CLMM pools with single-sided concentrated liquidity, locked via
Burn & Earn into Fee Key NFTs. The progress tree shows every pool,
position, and lock as it lands.

<p><img src="docs/screenshots/11-launch-report.png" width="760" alt="The complete launch report — the permanent dossier"></p>

*Every launch produces a permanent, on-chain-verifiable report: token
authorities, every pool, every locked position with its Fee Key NFT, and
how to audit it all — previewable inline, downloadable, and published
to Arweave during the final transfer. Shown here in full.*

### 6. Transfer to your wallet

<p><img src="docs/screenshots/12-transfer-confirm.png" width="520" alt="The transfer confirmation — verify the full address"></p>

*The destination address must be verified character-for-character
before anything moves.*

<p><img src="docs/screenshots/14-transfer.png" width="760" alt="Step 6 — sweep everything to your wallet"></p>

Airdrops (if configured) go out, the report publishes to Arweave, and
everything left — tokens, SOL, Fee Key NFTs — sweeps to your
destination wallet.

<p><img src="docs/screenshots/13-launch-success.png" width="520" alt="Launch complete — the success summary"></p>

**Launch complete.** Your coin, your Fee Keys, your liquidity locked for
life — and the next steps for listings laid out.

## Release authenticity

Tagged GitHub releases are built from a clean checkout in GitHub Actions.
Each release includes `SHA256SUMS.txt`, and the release notes state which
desktop artifacts were signed, notarized, unsigned, or published as
unsigned test artifacts. Merges to `main` automatically create the next
release and publish the GitHub Package. See [docs/releasing.md](docs/releasing.md).

---

## ⚠ Before you start: get a dedicated RPC endpoint

**Do not attempt to launch a token using the public Solana RPC.** The
free `api.mainnet-beta.solana.com` endpoint is shared by the entire
ecosystem and is aggressively rate-limited. Pool creation requires a
sustained burst of dozens of requests; you will be throttled mid-flow,
transactions will fail, and you can lose SOL on partial failures that
require manual recovery.

This is the single most common cause of failed launches. Spend the
five minutes to set up a real RPC before doing anything else.

**Recommended:** [Helius](https://www.helius.dev/) — sign up, create an
API key on the dashboard, and you'll get a URL like
`https://mainnet.helius-rpc.com/?api-key=YOUR_KEY`. The free tier is
plenty for individual launches; you don't need a paid plan.

**Alternatives:** Triton, QuickNode, Alchemy. Any reputable Solana
RPC provider will work, and all of them have free tiers that handle
what Trebuchet needs. Avoid free *aggregator* endpoints (the ones
that bundle multiple public RPCs behind a single URL) — they fail
in the same ways as the public RPC, just with extra middleware in
the way to obscure the cause.

Add your endpoint inside the app: click the **RPC** bar at the top
of the page, paste your URL into "Add a New RPC", give it a name,
click "Test connection", then "Add & use". The setting is saved and
will be remembered between sessions.

---

## What you'll need

Before launching, have these ready:

- **A dedicated RPC endpoint** (see above — non-negotiable; free tier
  from any reliable provider is plenty).
- **A funding wallet** with enough SOL to cover the launch costs.
  The app calculates the exact amount required during Step 3 and
  shows an itemised breakdown. Roughly: 0.1–0.3 SOL for fees plus
  whatever USD-equivalent of liquidity you want to deploy.
- **A logo image** for your token. PNG or JPG, square, under 100 KB.
- **A destination wallet address** — where the Fee Key NFTs and any
  leftover tokens/SOL will end up at the end. Use a wallet you own
  and control.

---

## Pool design: splits and pair tokens

Step 2 lets you create multiple pools and pair each with any token you
want. Most basic launches use neither feature — one pool, paired with
SOL, full supply. But these are the most interesting things Trebuchet
does, and worth understanding before you configure your pools.

### Splitting liquidity into multiple Fee Keys

The conventional way to compensate team members, venture capitalists,
advisors, and marketing partners is **supply allocations** — give them
N% of the token, usually with a vesting schedule, and they sell when
they're ready.

I think this is bad practice and don't recommend it. Allocations create
overhang: holders know there's a wallet out there that can dump at any
time, vesting cliffs become coordinated sell events, and recipients
have no reason to care about the project once their tokens unlock. It's
also one of the most common rug pull vectors in the ecosystem.

Trebuchet's alternative is to split locked liquidity into multiple
positions and hand out the resulting **Fee Key NFTs**. To allocate
"10%" to a marketing partner, create a 10% pool, let Burn & Earn lock
it, and transfer the Fee Key NFT to them. The mechanics change in ways
that materially align incentives:

- **They can't dump.** The LP is locked permanently. No overhang, no
  vesting cliff, no exit pressure on holders.
- **They're paid by volume, not by sale.** Fee Keys collect a share of
  trading fees from their pool. It's recurring income, not a one-time
  grant — the more the token trades, the more they earn.
- **Incentives compound over time.** A marketing partner with a Fee
  Key has continuous reason to drive volume. A team member has reason
  to keep building. In theory this fosters longer-term strategy and
  effort than a tokens-and-vest arrangement, where the relationship
  effectively ends at the unlock.
- **Your supply isn't diluted.** You're not paying people by printing
  tokens at the expense of holders. The cost comes out of trading
  fees, paid by whoever's actually using the token.

Fee Keys are transferable NFTs, so recipients aren't trapped — they
can sell on a secondary NFT market if they need liquidity. The locked
LP stays locked regardless of who holds the key.

### Flywheels

Trebuchet ships with two pre-configured **flywheel** quote tokens:
**Reserve** and **Meme**. A flywheel is a quote token chosen
specifically because it sits in multiple liquidity pools with other
interesting tokens. When someone buys your launched token through the
flywheel pool, the SOL or other asset they trade in flows into the
flywheel token's broader pool network — your launch can pull in
arbitrage volume from exotic pairs across the ecosystem, and price
action from those paired assets can correlate back to your token.

The default launch is a 90/10 split: a SOL pool with 90% of supply,
plus a flywheel pool with the remaining 10%. The flywheel slice is
small but does real work — it gives the token immediate exposure to
arbitrage flow that a pure SOL launch wouldn't have. You can disable
the flywheel entirely, switch between Reserve and Meme, or adjust the
percentage (5–30%) in the Step 2 panel.

The Meme flywheel is the default, even for non-meme launches. Its
pair set deliberately includes the Reserve flywheel as one of its
quote tokens, which means a Meme-launched token gets cascading
exposure to the Reserve network too — picking Meme covers both
networks at once. Reserve only sees its own network. Switch to
Reserve manually if your project's posture is closer to "utility /
brand / long-term hold" than "memetic / momentum"; the explainer
modal in the app walks through when each makes sense.

- **Reserve flywheel** — paired with an ETH-backed token, a
  BTC-backed token, and a stable-backed flywheel token. Acts as a
  store of value and a hedge against SOL. Lower downside risk, less
  volume. Use this for serious projects, utility tokens, or anything
  with a long-term posture.
- **Meme flywheel** (default) — paired with popular meme tokens
  that have retained active communities and attention, *plus* the
  Reserve flywheel itself. Higher chance of generating meaningful
  volume, more downside exposure if those paired memes decline.
  Use this for meme launches, or for any launch where the
  cross-network exposure is more valuable than the lower-variance
  Reserve-only positioning.

The "Learn more" link next to the flywheel toggle in the app expands
on the mechanics and risk tradeoffs.

### Pairing with non-SOL tokens

Every CLMM pool has a quote token. SOL is the obvious default and what
most users will expect to swap against. But you can pair with any SPL
token, and there are real reasons to:

- **Support another project.** Pairing your token with theirs creates
  permanent, locked liquidity between the two. It's a credible signal
  of alignment that's hard to fake — you literally can't take it back —
  and it gives both communities a way to swap directly without
  routing through SOL.
- **Generate arbitrage volume and price action.** If your token has
  pools against multiple quotes (yours/SOL and yours/USDC, say),
  arbitrageurs will trade between them whenever the implied prices
  diverge. That's volume that generates fees for every Fee Key holder
  in the system, with no organic demand required to bootstrap it.

One caveat: pairing with an illiquid or untrusted token couples part
of your launch's price discovery to whatever happens to that token.
Don't pair with something whose risk profile you don't understand.

---

## How to launch a token

The app walks through six steps. Each step unlocks the next when its
prerequisites are met. You can scroll up to a completed step to review
it (the fields go read-only), but you can't go back and change inputs
once a step is completed — that's what Cancel & Refund is for if you
need to start over.

### Step 1 — Generate temporary wallet

Click **Generate Wallet**. Trebuchet creates a fresh keypair and
displays its public key plus a QR code. This wallet exists only for
this launch — every transaction below is signed by it. It does not
need to be funded yet.

The 12-word recovery phrase is shown for your records, but you don't
need to copy it down for the normal flow. Step 6 sweeps everything
out of this wallet at the end. Save it only if you want a paranoid
backup in case something interrupts the flow — and remember that the
app already saves an encrypted copy in your OS keychain, so this is
genuinely just a paranoia option, not a normal step.

### Step 2 — Configure token & pools

**Token Details:**

- **Name** — what your token is called. "Doge Killer Killer."
- **Symbol** — the ticker, 1–10 characters. "DKK."
- **Total supply** — how many tokens to mint. Common choices: 1
  million, 1 billion. Bigger numbers don't make your token worth more,
  smaller numbers don't make it scarcer in any meaningful way; pick
  what looks right alongside the price.
- **Description** — a sentence or two for the metadata.
- **Logo** — upload your image.

**Pool Configuration:**

- **Target launch market cap (USD)** — sets the initial price. If you
  pick $100,000 with a 1B supply, each token is worth $0.0001. All
  pools start at the same USD-equivalent price.
- **Use a flywheel** (default on, 10% Meme) — adds a second pool
  paired with the chosen flywheel quote token for arbitrage volume
  exposure. The Meme flywheel ($seige) is the default because its
  pair set includes the Reserve flywheel itself, so meme-launched
  tokens plug into both networks at once. Switch to Reserve (XLRT)
  for serious / utility tokens. See *Flywheels* above. Untoggle for
  a pure SOL launch.
- **Split the LP** (default off) — splits each pool's main LP into
  multiple positions, each minting its own Fee Key NFT. Useful for
  partial fee-stream giveaways or sales (see *Splitting liquidity*
  above). To also split the flywheel pool, use Customize.
- **Add starting liquidity** (default off) — by default each pool
  opens with a tiny ~$1 reserve position that just makes the pool
  tradable. Enable this to deposit real starting liquidity across
  all pools. You specify the total SOL to commit; the app splits it
  evenly across every pool (SOL pool plus any flywheel pool), and
  each pool's bootstrap uses a full-range position so the support
  shows up at every price level. Token-side liquidity carves out of
  each pool's allocation; you don't need extra tokens.
- **Ladder positions** (default off) — splits a portion of each
  pool's supply across discrete log-spaced price bands going up to
  a 1000× launch-price ceiling, with gaps between bands for
  breakouts. Each band acts as resistance on the way up and support
  on the way back down. Smooths supply distribution so 90% isn't
  gobbled up by the time you hit 10×. Slider sets the percentage of
  pool supply that goes into the ladder (20–80%); a second slider
  picks the number of bands (3–10). The remainder of the pool's
  supply stays in a wide main position covering all prices.
- **Preallocate supply** (default off) — holds back a percentage of
  total supply from the LP entirely, for team/VC tokens, presales,
  airdrops, staking rewards, or any utility reserve. Pool
  allocations scale down to fit what's left. The preallocated
  tokens stay in the launch wallet and sweep to your destination
  on Step 6 for you to distribute. **Warning:** preallocated supply
  without a Support position behind it is the textbook rug shape —
  the app nags you about this, and the **Auto-back with support**
  toggle pins the Support position's SOL value to cover the
  preallocation's USD value so holders always have an honest exit.
- **Airdrop** (under Preallocation) — paste or upload a CSV of
  `wallet,sol` rows (e.g. presale contributors and what they put
  in) and each wallet receives the matching USD value in tokens at
  the launch price, sent automatically during the Step 6 sweep.
  The list is validated as you type, the per-wallet token amounts
  preview in a table, and **Auto-fit airdrop** raises the
  preallocation percentage automatically if the list outgrows it.
  Failed deliveries (rare) can be retried from Step 6; anything
  undelivered sweeps to your destination wallet instead, so tokens
  are never stranded.
- **Add support position** (default off) — a single-sided buy wall
  just below launch price. You set the SOL value and the depth
  (how far below launch it extends). Quote-side only, so it costs
  SOL but no token supply. This is what backs preallocated supply
  with real exit liquidity; it also catches early dips for a
  regular launch.
- **Customize pools manually** — for anything more elaborate than
  the defaults: multiple non-SOL pools, custom quote tokens, per-pool
  splits, external Fee Key recipients, custom ladder bands at
  hand-picked ranges. The simple panel covers ~90% of launches; the
  Customize view is there when you need it.
- **Lock liquidity (Burn & Earn)** — leave this on. It permanently
  locks the LP position and gives you a transferable NFT (the "Fee
  Key") that collects trading fees forever. Without it, your
  liquidity isn't really locked and traders will rightly distrust
  the launch.

Before continuing you can click **Visualize tokenomics** to see a
donut chart of your configured distribution — supply broken down by
pool and by position type (bootstrap, main LP slices, ladder bands).
Helps catch "I configured 5% of pool to bootstrap but really meant
50%" before you start funding. Token logo appears in the chart center
if you uploaded one.

Click **Continue to Funding**.

### Step 3 — Fund the wallet

The app shows you exactly how much SOL (and any quote tokens for
non-SOL pools) need to land in the temporary wallet. Send those
amounts from your funding wallet. Click **Refresh balances** until
everything turns green, then **Continue to Token Creation**.

For non-SOL quote tokens (flywheels, USDC, custom pairs), Trebuchet
can **auto-swap** the small amount needed from your SOL deposit — no
need to source those tokens separately. After your SOL lands, click
**Acquire quote tokens** to run the swap. If a swap can't be routed
(an obscure quote token with no Raydium liquidity path) the row
auto-converts to a manual prefund row and you can send those tokens
yourself.

The "Show cost breakdown" link expands an itemised list — pool
creation rent, position NFT mint fees, Metaplex metadata fees, network
fees, plus your actual liquidity deposit. You're not being charged a
launch fee; this is what Solana and Raydium and Metaplex cost.

**Sticker shock?** Click **Edit configuration** at the top of the
funding panel to go back to Step 2 with all your settings intact —
adjust the bootstrap amount, ladder percentage, or pool count, then
return to Step 3 for an updated estimate. Funds already in the
wallet stay put and count toward the new estimate. This is the right
escape hatch for "I should have set X differently"; Cancel & Refund
is the heavier "abandon everything" option.

### Step 4 — Create the token

Click **Create Token**. The app:

1. Mints the SPL token with your metadata.
2. Transfers the full supply to the temporary wallet.
3. Renounces the mint, freeze, and metadata-update authorities.

After this step the token exists permanently on Solana, and nobody
(including you) can mint more of it, freeze accounts, or change its
metadata. This is intentional — it's what makes the launch credible.

### Step 5 — Create pools and positions

Click **Create Pools**. The app runs the launch in phases so every
pool ends up at the intended price and gets locked together:

1. **Main positions** — for every pool: open the wide main LP and
   any ladder band positions you configured. Pool is created but not
   yet tradable (the bootstrap position hasn't landed).
2. **Bootstrap** — once every pool has its main positions in place,
   open each pool's bootstrap straddle. This is what makes the pool
   tradable at the launch price. Running bootstraps as a separate
   phase means no pool can become tradable while others are still
   being built, which prevents swap activity on an early pool from
   moving prices relative to the others.
3. **Lock** — Burn & Earn locks every main and ladder position
   (plus the bootstrap), burning each position NFT and minting a
   transferable Fee Key NFT in its place.
4. **Transfer Fee Keys** — for any slices configured with an
   external recipient, the Fee Key NFT transfers to that address.
   Slices without a recipient stay with the launch wallet and
   sweep on Step 6.

When everything succeeds you'll see a green banner and two buttons:
**Continue to Final Transfer** and **Download launch report**. The
report is a self-contained HTML document with all your token's
addresses, pool IDs, position NFTs, lock-transaction proofs, and a
tokenomics chart — copy-button-ready for listings, investor updates,
and the team's reference sheet. You can also download it again from
Step 6 after the transfer.

If something fails partway through, the app surfaces what completed
and offers an in-place **Resume launch** button. The resume path
skips the already-completed work (immutable on-chain anyway) and
retries just what's missing. Most transient failures (RPC blips,
slippage drift) clear up on retry. You can also fall back to **Skip
to Transfer Assets** to sweep the wallet and start over with a fresh
token; the pools that did succeed stay on-chain.

### Step 6 — Sweep assets to your destination wallet

Enter your destination wallet address. **Verify it character by
character** — there is no undo. The app shows a confirmation modal
listing exactly what's about to move; read it.

Click **Confirm and Transfer**. The app sweeps, in order:

- All Fee Key NFTs first (these are your earnings stream — keep
  them safe)
- The airdrop, if you configured one — each listed wallet gets its
  tokens before the rest of the supply moves; a live progress bar
  tracks deliveries, and any failed rows get a retry button (or
  fall through to your destination wallet so nothing is stranded)
- Any unallocated tokens that didn't go into pools (including the
  preallocation remainder after the airdrop)
- Remaining SOL above what's needed for the final transaction fees

After the sweep completes you'll see a green confirmation with a
**Download launch report** button. Same content as the report from
Step 5 — grab one now if you didn't earlier.

Done. The temporary wallet is now empty and your destination wallet
holds everything that matters.

### The launch report

After all pools land in Step 5, and again after the sweep in Step 6,
the app offers a **Download launch report** button. The output is a
single self-contained HTML file (~50 KB) you can open offline, share
by email, or print to PDF for investor decks.

The report includes:

- Token mint address, decimals, supply, target market cap
- Logo (embedded as a base64 data URL — survives email forwarding)
- A tokenomics donut chart, same one the preview modal shows
- Per-pool sections: pool ID, fee tier, supply allocation
- Per-position records: bootstrap, main LP slice(s), every ladder
  band — each with NFT mint, lock status, open TX, lock TX, and
  Fee Key transfer TX where applicable
- A summary banner: how many positions locked, how many Fee Keys
  reached their external recipients, with explicit warnings if
  anything didn't complete

Every address and transaction signature has a one-click Copy button
and a Solscan link icon. The visual theme matches the
[makesometokens.com](https://makesometokens.com/) marketing site —
parchment background, engineering-manuscript styling, Trebuchet MS
typography. It's the reference sheet your team needs for listings,
launch announcements, or explaining the cap-table mechanics to
investors.

### Cancel & Refund — when (not) to use it

The **Cancel & Refund** button in the top-right is the bail-out path,
not the retry path. Use it when:

- You want to abandon the launch and recover whatever's in the
  temporary wallet to a destination wallet.
- A failure can't be recovered via Resume launch (rare — only if
  the on-chain state is unrecoverably partial).

Don't reach for it just because a step failed. Most failures are
transient and the in-place retry buttons (Resume launch, Retry
bootstraps, per-row swap retries) get you through cleanly without
restarting. Cancelling means you lose the cost of any work that
already landed on-chain.

If the wallet is still empty when you click Cancel, the dialog shifts
to "End Launch" mode — it just locks the UI without doing a sweep,
since there's nothing to refund.

After a cancel that happens before any on-chain work (Steps 1–3),
the terminal panel offers **Start over with the same wallet**. The
wallet stays available, but the token form, pool configuration, and
created-token state all reset to defaults — you can start a fresh
launch without generating a new wallet. The button is hidden after
cancels that happen post-mint (Step 4+), because starting over at
that point would silently create a second token while the first one
is still on-chain.

---

## What Trebuchet doesn't do

- Take a cut of your supply
- Charge a launch fee
- Hold your liquidity hostage
- Promote your token, list it anywhere, or do any marketing
- Anything you didn't tell it to do

If you wanted any of those, you launched on the wrong tool.

---

## Recommendations

- **Use a dedicated RPC.** Said it twice already, saying it a third
  time. The free tier from Helius / QuickNode / Triton / Alchemy is
  plenty — you don't need a paid plan. You just need an endpoint
  that isn't the public mainnet RPC or an aggregator.
- **Preview your tokenomics** before funding. Click **Visualize
  tokenomics** at the bottom of Step 2 — the donut chart makes
  miscalibrated bootstrap / ladder / pool-split percentages obvious
  before you've committed any SOL.
- **Walk the flow in Demo Mode first.** Settings → Demo Mode
  simulates every on-chain operation — the full six-step flow,
  progress trees, failure banners, launch report and all — without
  sending a single transaction or spending any SOL. It's the
  fastest way to learn what each step does and looks like before
  committing real money. Turn it off before a real launch (a
  banner reminds you while it's on).
- **Test on devnet first** if you change anything substantive about
  the launch parameters or you're learning the flow. Mistakes on
  mainnet cost real money.
- **Verify the destination wallet** in Step 6 character by character
  before confirming. Solana addresses look similar enough that swapped
  characters are easy to miss; Solana transactions are final.
- **Save the launch report** before sweeping. It's the canonical
  reference for every address and transaction your team or investors
  will need. The Step 6 button gives you a second chance if you
  skipped it at Step 5.
- **Don't burn or transfer your Fee Key NFTs** unless you mean to
  permanently give up the income from your locked liquidity. Treat
  them like a property deed.

---

## Troubleshooting

**"Transactions keep failing in Step 5."**
Almost always an RPC problem. Double-check that the active RPC at the
top of the page is your dedicated endpoint and not the public mainnet
fallback.

**"Pool creation succeeded for one pool but failed for another."**
Click **Resume launch** in the failure banner. The app will skip the
pools that already succeeded (they're permanent on-chain) and retry
just the failed work. You can resume multiple times — each pass only
attempts what's still missing. If retrying keeps failing, use **Skip
to Transfer Assets** to sweep and start over with a different config.

**"A pool's bootstrap failed but the pool exists."**
Click **Retry bootstraps**. The pool is real and your main positions
are locked; only the small straddle position that makes it tradable
at the launch price failed. Retrying is safe and usually clears
transient errors.

**"A quote token couldn't be auto-swapped."**
The row auto-converts to a manual prefund: send the listed amount of
that token to the temporary wallet yourself. Alternatively, click the
per-row retry button to attempt the swap again — useful for transient
errors that the bulk Acquire didn't get past.

**"The compatibility check says my quote token isn't supported."**
Some Token-2022 mints use extensions Raydium doesn't allow (transfer
hooks, pausable, default account state, etc). Trebuchet catches these
in a pre-flight pass before spending any SOL — pick a different quote
token or use the standard SPL Token equivalent if one exists. The
check accepts every Token-2022 extension Raydium's on-chain code
permits, including TransferFeeConfig.

**"I closed the app in the middle of a launch."**
The temporary wallet's secret key is automatically saved (encrypted
at rest via your OS keychain) when generated in Step 1. On next
launch of the app, the **Pending Wallets** panel at the top of the
page shows the wallet with a button to copy its recovery phrase or
secret key. Import that into Phantom or Solflare to recover any
SOL/tokens manually. Once you're done, click Discard on the panel
entry to clear it.

When you actually try to close the app mid-launch via the X button,
a confirmation dialog appears first asking whether to leave or stay,
so accidental closes are caught before they happen.

**"It says another launch operation is already running for this wallet."**
The app refuses to run two operations on the same launch wallet at
once — two pool-creation runs would make duplicate pools; a sweep
during pool creation would pull funds out from under the launch.
This usually means a previous click is still working (launches take
minutes) or the window reloaded mid-launch while the work kept
running in the background. Wait for it to finish — the progress
list keeps updating — and only restart the app if you're certain
the operation is dead rather than slow. Restarting clears the lock
(and stops any operation that was genuinely still running).

**"I want to launch with a quote token I don't see in the dropdown."**
Use Customize mode in Step 2 and pick "Custom mint…" in the quote
token dropdown. Paste any SPL or Token-2022 mint address. The app
resolves its symbol, price, and Raydium compatibility on the spot.

---

## For developers

The desktop app is an Electron wrapper around the original web build.
Both share the same source files, and the web build still works
standalone:

```bash
npm install
npm run web        # standalone web server on port 3000
npm start          # Electron desktop app
npm run build:win  # build Windows installer and portable EXE
```

Source files of interest:

- `server.js` — Express API
- `tokenService.js` — wallet generation, SPL mint via Metaplex Umi
- `lpService.js` — Raydium CLMM pool + position creation, Burn & Earn,
  bootstrap phase, ladder-band positions, deferred-lock orchestration
  (phases: open mains → open bootstraps → lock all → transfer Fee Keys),
  resume-launch path, Token-2022 compatibility check
- `swapService.js` — SOL → quote-token auto-swap via Raydium Trade API
- `walletHelpers.js` — multi-token balance + NFT enumeration/sweep
- `tokenInfoService.js` — quote-token resolution (symbol, decimals,
  price via three-tier fallback: GeckoTerminal → Jupiter V3 →
  DexScreener; cached for 60 s / 24 h)
- `rpcConfig.js` — persistent RPC endpoint settings
- `pendingWallets.js` + `secretStore.js` — encrypted recovery cache
- `public/app.js` — the entire frontend (~9000 lines, vanilla JS).
  Houses the step orchestration, pool/position editing UI, the
  tokenomics visualization, and the HTML launch-report generator
- `public/index.html` — single-page frontend (Bulma + the styles
  needed for the parchment-themed launch report)
- `main.js` — Electron entry point, menu definition, BrowserWindow
  lifecycle

### Building the vanity keygen binary

The "Vanity CA" feature in Step 1 grinds Solana addresses with a
chosen prefix or suffix using a multithreaded C program. That program
is a separate native binary shipped alongside the Electron app —
`c/build/vanity_keygen` on Unix, `c/build/vanity_keygen.exe` on
Windows. It lives outside the JS so it can use all available cores
without blocking the Node event loop.

**You can run Trebuchet without it.** If the binary isn't present,
the vanity input field and Grind button in Step 1 are disabled with a
clear "Unavailable — binary not built" note next to them. Every
other launch path — generating a normal random wallet, the full
launch flow, the sweep — works unchanged. So if you just want to try
the app or contribute changes to the JS/UI layer, you can skip this
section.

**When you need to build it:**

- After a fresh clone, if you want to test or use vanity grinding
  locally during development
- After modifying anything in `c/`
- Release builds: handled automatically by GitHub Actions. You only
  need to build manually for local development

**Requirements — a C compiler on PATH:**

- **Linux:** install `build-essential` on Debian/Ubuntu
  (`sudo apt install build-essential`) or the Development Tools group
  on RHEL/Fedora (`sudo dnf groupinstall "Development Tools"`).
  Provides `gcc`.
- **macOS:** install the Xcode Command Line Tools
  (`xcode-select --install`). Provides `clang`, with `gcc` as an
  alias to it.
- **Windows:** install MSYS2 (https://www.msys2.org) and then run
  `pacman -S mingw-w64-x86_64-gcc` from the MSYS2 shell, OR install
  Strawberry Perl (https://strawberryperl.com) which bundles MinGW
  gcc. Make sure the `bin` directory containing `gcc.exe` is on your
  Windows PATH so `npm run build:c` can find it.

The build script (`scripts/build-c.mjs`) auto-detects whichever
compiler is available and picks platform-appropriate flags (skips
`-mtune=generic` on ARM, links `bcrypt` on Windows for the CNG-backed
RNG, etc.). You don't need to configure anything manually.

**Build command:**

```bash
npm run build:c
```

The output binary lands in `c/build/`. On macOS/Linux the executable
bit is set automatically by the build script.

**Verifying the build:**

```bash
./c/build/vanity_keygen --prefix A --threads 4
```

Should grind for a fraction of a second and print a Solana public
key starting with "A". A single-character prefix is trivial to find;
production usage in the app typically grinds 3-5 character targets
which take seconds to minutes depending on core count.

If you see "command not found" or "permission denied," re-run
`npm run build:c` and check the script's output for compiler errors.
The most common cause is `gcc` not being on PATH yet — particularly
on Windows after a fresh MSYS2 install, where you may need to open a
new terminal so PATH updates take effect.

### Merge requirements

All changes reach `main` through a pull request — direct pushes to
`main` are not allowed. A pull request cannot merge until the **Test**
job passes; that job runs syntax checks, the full unit/integration
test suite, and a critical npm audit.

The **Build** job (smoke package builds for three platforms: macOS
arm64, Windows, and Linux) is advisory — it confirms the app packages
without errors but is not required for merge. A failing Build job is a
signal, not a gate.

Both requirements are enforced by a branch ruleset on the default
branch — a required pull request and the required `Test` check. Manage
it under **Settings → Rules → Rulesets**.


Running on devnet: change `cluster: 'mainnet'` to `'devnet'` in
`lpService.js`, swap to `DEVNET_PROGRAM_ID.CLMM_PROGRAM_ID`, hit a
faucet, iterate freely.

---

## License

MIT

### Third-party assets

Trebuchet bundles a few vendored assets:

- **three.js** (the 3D coin preview) is licensed under the MIT License.
  See `public/vendor/three/LICENSE`.
- **Fonts** (IM Fell DW Pica, EB Garamond, JetBrains Mono) are licensed
  under the SIL Open Font License; see `public/vendor/fonts/OFL.txt`.

The medieval gauntlet cursor artwork is original to this project.
