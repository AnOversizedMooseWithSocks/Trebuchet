// worker/index.js
//
// Cloudflare Workers entry for trebu.ratimics.com.
//
// - Serves the static v2 web app (public/v2) from the ASSETS binding with SPA
//   fallback, so everything the page logic already does in the browser — the
//   streamlined CP-2022 plan, cost ledger, fee policy, digest verification —
//   runs client-side against those static files with zero backend.
// - Adds two tiny same-origin edges behind /api/*:
//     GET /api/health  -> { ok: true }
//     GET /api/price   -> { solana.usd } (CoinGecko passthrough, best-effort)
//   so the client can replace the bundled $-per-SOL constant with a live one.
// Everything else (real swaps, signing, chain events) stays in the visitor's
// wallet; this Worker deliberately holds no keys and no custody.

// Jupiter price API is Solana-native, free, keyless, and worker-friendly
// (CoinGecko 403s Cloudflare Worker egress).
// Keyless, worker-friendly SOL/USD sources, tried in order.
const PRICE_SOURCES = [
  {
    name: 'binance',
    url: 'https://api.binance.com/api/v3/ticker/price?symbol=SOLUSDT',
    parse: (body) => Number(body?.price),
  },
  {
    name: 'coinbase',
    url: 'https://api.coinbase.com/v2/prices/SOL-USD/spot',
    parse: (body) => Number(body?.data?.amount),
  },
];

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'public, max-age=120',
    },
  });
}

async function handleApi(request, url) {
  if (url.pathname === '/api/health') return json({ ok: true, service: 'trebu-web' });
  if (url.pathname === '/api/price') {
    if (request.method !== 'GET') return json({ error: 'method not allowed' }, 405);
    for (const source of PRICE_SOURCES) {
      try {
        const upstream = await fetch(source.url);
        if (!upstream.ok) continue;
        const body = await upstream.json();
        const usd = source.parse(body);
        if (Number.isFinite(usd) && usd > 0) {
          return json({ solana: { usd }, source: source.name });
        }
      } catch (_error) {
        // try the next source
      }
    }
    return json({ error: 'price_unavailable' }, 503);
  }
  return null;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const apiResponse = await handleApi(request, url);
    if (apiResponse) return apiResponse;
    return env.ASSETS.fetch(request);
  },
};