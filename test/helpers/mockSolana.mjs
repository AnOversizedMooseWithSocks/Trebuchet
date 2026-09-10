// test/helpers/mockSolana.mjs
//
// Minimal, network-free fakes for the Solana / Metaplex surface that the
// money-moving services touch. Used by the launch-integration tests so that
// createTokenWithMetaplex and the LP phase helpers can run with no RPC,
// Arweave, or Irys calls.
//
// Nothing here is imported by production code — these are test doubles wired
// in through the *ForTests DI seams exported by tokenService.js / lpService.js.

import { Keypair } from '@solana/web3.js';

// A throwing knob: returns a function that throws on the Nth call (1-based),
// otherwise delegates to `ok`. Handy for "fail on the 2nd getBalance" fixtures.
export function failOnCall(n, ok, error) {
  let calls = 0;
  return (...args) => {
    calls += 1;
    if (calls === n) {
      throw (error instanceof Error ? error : new Error(error || `injected failure on call ${n}`));
    }
    return ok(...args);
  };
}

// Build a fake @solana/web3.js Connection. Every method is a no-op stub by
// default; override any of them via `overrides`. `getBalance` defaults to a
// healthy balance so transfer/sweep paths don't think the wallet is empty.
export function makeFakeConnection(overrides = {}) {
  const base = {
    getBalance: async () => 5 * 1e9,
    getMinimumBalanceForRentExemption: async () => 890_880,
    getAccountInfo: async () => ({ data: Buffer.alloc(0), owner: null }),
    getParsedAccountInfo: async () => ({ value: null }),
    getParsedTokenAccountsByOwner: async () => ({ value: [] }),
    getTokenAccountsByOwner: async () => ({ value: [] }),
    confirmTransaction: async () => ({ value: { err: null } }),
    sendTransaction: async () => 'fake-sol-tx-sig',
    getSignaturesForAddress: async () => [],
    getParsedTransaction: async () => null,
    getLatestBlockhash: async () => ({
      blockhash: '11111111111111111111111111111111',
      lastValidBlockHeight: 1,
    }),
  };
  return { ...base, ...overrides };
}

// Build a fake umi for the metadata-upload path. The uploader returns
// deterministic URIs unless told to reject. Set `rejectUpload` /
// `rejectUploadJson` to a string/Error to simulate an Irys outage.
export function makeFakeUmi({ rejectUpload, rejectUploadJson } = {}) {
  return {
    identity: { publicKey: 'fake-umi-identity' },
    eddsa: {
      createKeypairFromSecretKey: () => ({ publicKey: 'fake', secretKey: new Uint8Array(64) }),
    },
    use() { return this; },
    uploader: {
      async upload() {
        if (rejectUpload) throw asError(rejectUpload);
        return ['https://arweave.test/image'];
      },
      async uploadJson() {
        if (rejectUploadJson) throw asError(rejectUploadJson);
        return 'https://arweave.test/metadata';
      },
    },
  };
}

function asError(e) {
  return e instanceof Error ? e : new Error(String(e));
}

// A deterministic keypair so tests that need a stable wallet pubkey don't
// depend on randomness. seed is a 0-255 byte repeated across 32 bytes.
export function deterministicKeypair(seedByte = 7) {
  return Keypair.fromSeed(Uint8Array.from(new Array(32).fill(seedByte & 0xff)));
}

// Build a fake parsed token account entry as returned by
// getParsedTokenAccountsByOwner. Used by the sweep tests to simulate
// on-chain token balances without a real RPC.
//
//   mint:        base58 mint address
//   owner:       wallet public key (base58)
//   programId:   TOKEN_PROGRAM_ID or TOKEN_2022_PROGRAM_ID (PublicKey)
//   amount:      raw token amount (string, e.g. '1000000')
//   decimals:    token decimals (number)
//
// Returns an object suitable for resp.value array. `tokenAccount` is the
// address of the token ACCOUNT holding the balance (defaults to the mint
// string for legacy tests that don't care); it's what the sweep now uses
// as the transfer source, so tests exercising non-ATA sources set it.
export function makeFakeTokenAccountEntry({ mint, owner, programId, amount = '1000000', decimals = 6, tokenAccount = null }) {
  const address = tokenAccount || mint;
  return {
    pubkey: { toBase58: () => address }, // shaped like a PublicKey for enumeration
    account: {
      data: {
        parsed: {
          info: {
            mint,
            tokenAmount: {
              amount,
              uiAmount: Number(amount) / (10 ** decimals),
              decimals,
            },
          },
        },
      },
    },
  };
}
