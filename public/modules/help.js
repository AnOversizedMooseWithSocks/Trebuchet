// ===========================================================================
// Concept help / glossary
// ---------------------------------------------------------------------------
// One mechanism for explaining the app's harder concepts, so explanations
// don't accumulate as one-off modals and ad-hoc links. Usage, anywhere in
// the markup (static or dynamically rendered — the listener is delegated):
//
//   <a href="#" class="explain-link" data-explain="fee-key-nft">what's this?</a>
//
// Clicking any [data-explain] element opens the matching topic in the
// generic confirm modal (single "Got it" button). Adding a new explainable
// term is one dictionary entry plus one attribute — no extra wiring.
//
// Writing style for entries: plain language first, the proper term second.
// Assume the reader has used a phone wallet and nothing else. Two to five
// sentences; say what the thing is, why it matters to THEM, and what (if
// anything) they need to do about it. No marketing.
// ===========================================================================

const HELP_TOPICS = {
  'rpc-endpoint': {
    title: 'What is an RPC endpoint?',
    body:
      '<p>An RPC endpoint is the server Trebuchet talks to when it reads from ' +
      'or writes to the Solana blockchain — every balance check, token ' +
      'creation, and pool transaction goes through it.</p>' +
      '<p>The free public endpoint strictly limits how many requests you can ' +
      'make. A launch needs a rapid burst of dozens, so on the public ' +
      'endpoint it gets cut off partway through and fails. A dedicated ' +
      'endpoint from a provider like Helius has limits high enough for a ' +
      'launch, and their free tiers are more than sufficient.</p>',
  },
  'ephemeral-wallet': {
    title: 'The launch wallet (and its recovery phrase)',
    body:
      '<p>Trebuchet creates a fresh, temporary wallet to run your launch. You ' +
      'fund it, it does all the on-chain work, and at the end everything left ' +
      'in it is swept to an address you choose. It exists so you never have ' +
      'to paste your personal wallet\u2019s keys into anything.</p>' +
      '<p>Its recovery phrase is the master key to that wallet. Trebuchet ' +
      'stores it encrypted on this machine until the launch completes, but ' +
      'you should also write it down: if this computer dies mid-launch, the ' +
      'phrase is the only way to reach the funds.</p>',
  },
  'vanity-ca': {
    title: 'What is a vanity CA?',
    body:
      '<p>Every token has a contract address (\u201cCA\u201d) \u2014 the long string people ' +
      'paste into wallets and explorers to find it. Normally it\u2019s random.</p>' +
      '<p>A vanity CA is one ground out by brute force until it starts or ' +
      'ends with characters you chose (like your ticker). Purely cosmetic \u2014 ' +
      'the token works identically either way \u2014 but it makes the address ' +
      'recognizable at a glance. Longer patterns take exponentially longer ' +
      'to find.</p>',
  },
  'market-cap': {
    title: 'Target market cap and starting price',
    body:
      '<p>Market cap is the token\u2019s total supply multiplied by its price. The ' +
      'target you enter here sets the token\u2019s <em>starting</em> price: price ' +
      '= target market cap \u00f7 total supply.</p>' +
      '<p>Example: 1 billion tokens with a $10,000 target start at $0.00001 ' +
      'each. It\u2019s a starting point, not a promise \u2014 the moment trading ' +
      'begins, the market sets the price.</p>',
  },
  'liquidity-pool': {
    title: 'What is a liquidity pool?',
    body:
      '<p>A liquidity pool is what makes a token tradable. It\u2019s an on-chain ' +
      'pot holding your token so buyers can swap SOL (or another token) for ' +
      'it at a price that moves with supply and demand. No pool, no ' +
      'trading.</p>' +
      '<p>Trebuchet creates concentrated pools (Raydium \u201cCLMM\u201d) seeded ' +
      'single-sided \u2014 only your token goes in, no upfront SOL on the other ' +
      'side. The SOL side fills up naturally as people buy.</p>',
  },
  'fee-tier': {
    title: 'What is a pool\u2019s fee tier?',
    body:
      '<p>Every trade in a pool pays a small percentage fee \u2014 the fee tier ' +
      'is that percentage (for example 0.25% or 1%).</p>' +
      '<p>Those fees are what your Fee Key NFTs collect after the launch. ' +
      'Higher tiers earn more per trade but can discourage trading; the ' +
      'defaults are sensible for most launches.</p>',
  },
  'bootstrap-position': {
    title: 'What is the bootstrap position?',
    body:
      '<p>A newly created pool with only your token in it isn\u2019t tradable yet ' +
      '\u2014 there\u2019s nothing on the other side to price against. The bootstrap ' +
      'position is a small, deliberate deposit that crosses that line and ' +
      'switches the pool live.</p>' +
      '<p>Trebuchet defers every bootstrap until all pools\u2019 main liquidity is ' +
      'in place, so trading can\u2019t start on one pool while the others are ' +
      'still being built.</p>',
  },
  'burn-and-earn': {
    title: 'Locking liquidity (Burn & Earn)',
    body:
      '<p>Locking, via Raydium\u2019s Burn &amp; Earn, permanently gives up the ' +
      'ability to withdraw the liquidity \u2014 yours included. Nobody can ever ' +
      'pull the pot out from under traders, which is the strongest ' +
      '\u201cno rug\u201d guarantee a launch can make.</p>' +
      '<p>In exchange for each locked position you receive a Fee Key NFT ' +
      'that collects that position\u2019s trading fees forever. The liquidity is ' +
      'locked; the income from it is not.</p>',
  },
  'fee-key-nft': {
    title: 'What is a Fee Key NFT?',
    body:
      '<p>A Fee Key NFT is the receipt you get for permanently locking a ' +
      'liquidity position. Whoever holds it collects the trading fees that ' +
      'position earns, forever.</p>' +
      '<p>It\u2019s a normal transferable NFT: keep it, sell it, or split several ' +
      'among team members. In Trebuchet, 100% of them go to you \u2014 there is ' +
      'no platform cut. Guard them like money, because they are.</p>',
  },
  'slippage': {
    title: 'What is slippage?',
    body:
      '<p>Slippage is the gap between the price you saw when you submitted a ' +
      'trade and the price you actually got \u2014 the market can move in the ' +
      'second in between.</p>' +
      '<p>A slippage tolerance says how much of that gap you\u2019ll accept ' +
      'before the trade cancels itself instead of filling at a worse ' +
      'price.</p>',
  },
  'network-fees': {
    title: 'Network fees (and priority fees)',
    body:
      '<p>Every Solana transaction pays a tiny base fee, and Trebuchet adds a ' +
      'small \u201cpriority fee\u201d tip on top \u2014 that\u2019s what gets transactions ' +
      'processed promptly when the network is busy instead of being ' +
      'dropped.</p>' +
      '<p>Trebuchet measures the going rate right before each transaction and ' +
      'bids slightly above it, with a hard cap. The whole overhead is ' +
      'fractions of a cent per transaction and is already included in the ' +
      'funding estimate.</p>',
  },
  'sweep': {
    title: 'The final sweep',
    body:
      '<p>The last step of a launch empties the temporary launch wallet: Fee ' +
      'Key NFTs, any airdrop you configured, leftover tokens, and remaining ' +
      'SOL all move to one destination address you choose.</p>' +
      '<p>Use a wallet you control \u2014 not an exchange deposit address, which ' +
      'usually can\u2019t receive tokens or NFTs. Transfers on Solana are final, ' +
      'so the address gets a full-screen confirmation before anything ' +
      'moves.</p>',
  },
  'launch-report': {
    title: 'The permanent launch report',
    body:
      '<p>After a launch finishes, Trebuchet can write a public record of it ' +
      'to Arweave \u2014 permanent storage that can\u2019t be edited or deleted. ' +
      'Anyone can look the report up from the token\u2019s address and verify how ' +
      'the launch was configured: supply, pools, locks.</p>' +
      '<p>Nothing is added to the token itself, and the report is signed by ' +
      'the launch wallet so it can\u2019t be forged. It\u2019s optional \u2014 turn it off ' +
      'in Settings to keep your launch private.</p>',
  },
  'metadata-authority': {
    title: 'Permanent metadata vs. keeping the update authority',
    body:
      '<p>A token\u2019s metadata is its name, symbol, and logo. By default, ' +
      'Trebuchet permanently revokes the ability to change them \u2014 nobody, ' +
      'including you, can ever alter what the token looks like. Holders can ' +
      'verify that on any explorer, and it\u2019s the more trusted setup.</p>' +
      '<p>If you uncheck this, the update authority is instead handed to ' +
      'your destination wallet at the end of the launch, so you can change ' +
      'the name or logo later using standard Metaplex tools. The trade-off ' +
      'is trust: explorers will show the metadata as still editable. Supply ' +
      'is capped and liquidity locking works the same either way.</p>',
  },
  'preallocation': {
    title: 'What is preallocation?',
    body:
      '<p>Preallocation reserves part of the token supply before it goes into ' +
      'the pools \u2014 for an airdrop, a team share, or anything else you plan ' +
      'to distribute yourself.</p>' +
      '<p>Whatever you preallocate ends up in the final sweep to your ' +
      'destination wallet instead of in the trading pools. More ' +
      'preallocation means less liquidity backing the price, so keep it ' +
      'modest.</p>',
  },
};

// Show one topic in the generic confirm modal as an info dialog.
function showHelpTopic(id) {
  const topic = HELP_TOPICS[id];
  if (!topic) {
    console.warn(`help: unknown explain topic "${id}"`);
    return;
  }
  confirmDialog({
    title: topic.title,
    body: topic.body,
    confirmLabel: 'Got it',
    hideCancel: true,
  });
}

// Delegated listener: works for static markup AND anything rendered later
// (pool rows, dynamically built panels) with no per-element wiring.
document.addEventListener('click', (e) => {
  const el = e.target.closest?.('[data-explain]');
  if (!el) return;
  e.preventDefault();
  showHelpTopic(el.getAttribute('data-explain'));
});
