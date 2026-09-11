import test from 'node:test';
import assert from 'node:assert/strict';
import { Keypair, PublicKey } from '@solana/web3.js';
import { AccountLayout, MintLayout, TOKEN_PROGRAM_ID } from '@solana/spl-token';

import {
  normalizePortfolioResponses,
  rankPortfolioHoldingsByOwnership,
  resolveLargestAccountOwners,
  scanPersonalDiscovery,
  selectPersonalDiscoveryWallets,
} from '../personalDiscoveryService.js';

function parsedTokenAccount(mint, amount, decimals = 6) {
  const divisor = 10 ** decimals;
  return {
    account: {
      data: {
        parsed: {
          info: {
            mint,
            tokenAmount: {
              amount: String(amount),
              decimals,
              uiAmount: Number(amount) / divisor,
              uiAmountString: String(Number(amount) / divisor),
            },
          },
        },
      },
    },
  };
}

function tokenAccountInfo(owner) {
  const data = Buffer.alloc(AccountLayout.span);
  owner.toBuffer().copy(data, 32);
  return { data, executable: false, owner: TOKEN_PROGRAM_ID };
}

function mintAccountInfo(supply, decimals = 6) {
  const data = Buffer.alloc(MintLayout.span);
  MintLayout.encode({
    mintAuthorityOption: 0,
    mintAuthority: PublicKey.default,
    supply: BigInt(supply),
    decimals,
    isInitialized: true,
    freezeAuthorityOption: 0,
    freezeAuthority: PublicKey.default,
  }, data);
  return { data, executable: false, owner: TOKEN_PROGRAM_ID };
}

test('personal Discovery aggregates fungible balances and removes NFT-like receipts', () => {
  const mint = Keypair.generate().publicKey.toBase58();
  const nft = Keypair.generate().publicKey.toBase58();
  const holdings = normalizePortfolioResponses([
    { value: [parsedTokenAccount(mint, 1_500_000), parsedTokenAccount(nft, 1, 0)] },
    { value: [parsedTokenAccount(mint, 500_000)] },
  ]);

  assert.deepEqual(holdings, [{
    mint,
    amountRaw: '2000000',
    amountUi: 2,
    decimals: 6,
  }]);
});

test('personal Discovery resolves token-account addresses to their owners', () => {
  const tokenAccount = Keypair.generate().publicKey;
  const owner = Keypair.generate().publicKey;
  const rows = resolveLargestAccountOwners(
    [{ address: tokenAccount, amount: '420' }],
    [tokenAccountInfo(owner)],
  );

  assert.deepEqual(rows, [{
    tokenAccount: tokenAccount.toBase58(),
    owner: owner.toBase58(),
    amountRaw: '420',
  }]);
});

test('personal Discovery ranks holdings by ownership share instead of incomparable display units', () => {
  const common = Keypair.generate().publicKey.toBase58();
  const meaningful = Keypair.generate().publicKey.toBase58();
  const ranked = rankPortfolioHoldingsByOwnership([
    { mint: common, amountRaw: '900000000000', amountUi: 900000 },
    { mint: meaningful, amountRaw: '100', amountUi: 0.0001 },
  ], new Map([
    [common, '1000000000000000'],
    [meaningful, '1000'],
  ]));

  assert.equal(ranked[0].mint, meaningful);
  assert.equal(ranked[0].ownershipShare, 0.1);
  assert.ok(ranked[0].ownershipShare > ranked[1].ownershipShare);
});

test('personal Discovery prioritizes watch-only wallets inside the scan budget', () => {
  const wallets = [
    { publicKey: 'managed-a', source: 'managed', enabled: true },
    { publicKey: 'managed-b', source: 'managed', enabled: true },
    { publicKey: 'watch-a', source: 'watch-only', enabled: true },
    { publicKey: 'watch-paused', source: 'watch-only', enabled: false },
    { publicKey: 'watch-b', source: 'watch-only', enabled: true },
  ];

  assert.deepEqual(
    selectPersonalDiscoveryWallets(wallets, 3).map((wallet) => wallet.publicKey),
    ['watch-a', 'watch-b', 'managed-a'],
  );
});

test('personal Discovery selects every enabled wallet when no scan cap is requested', () => {
  const wallets = Array.from({ length: 1_200 }, (_, index) => ({
    publicKey: `wallet-${index}`,
    source: index % 3 === 0 ? 'managed' : 'watch-only',
    enabled: index % 17 !== 0,
  }));

  const selected = selectPersonalDiscoveryWallets(wallets);
  assert.equal(selected.length, wallets.filter((wallet) => wallet.enabled).length);
  assert.equal(selected.some((wallet) => wallet.source === 'managed'), true);
  assert.equal(selected[0].source, 'watch-only');
});

test('personal Discovery can bound managed seeds without limiting watched wallets', () => {
  const wallets = [
    ...Array.from({ length: 1_200 }, (_, index) => ({
      publicKey: `watch-${index}`,
      source: 'watch-only',
      enabled: true,
    })),
    ...Array.from({ length: 60 }, (_, index) => ({
      publicKey: `managed-${index}`,
      source: 'managed',
      enabled: true,
    })),
  ];

  const selected = selectPersonalDiscoveryWallets(wallets, Infinity, 5);
  assert.equal(selected.filter((wallet) => wallet.source === 'watch-only').length, 1_200);
  assert.equal(selected.filter((wallet) => wallet.source === 'managed').length, 5);
});

test('personal Discovery builds a bounded one-hop graph with explainable paths', async () => {
  const tracked = Keypair.generate().publicKey;
  const seed = Keypair.generate().publicKey;
  const holder = Keypair.generate().publicKey;
  const secondHolder = Keypair.generate().publicKey;
  const holderTokenAccount = Keypair.generate().publicKey;
  const secondHolderTokenAccount = Keypair.generate().publicKey;
  const candidateA = Keypair.generate().publicKey;
  const candidateB = Keypair.generate().publicKey;
  const knownOutsideSummary = Keypair.generate().publicKey;
  const portfolios = new Map([
    [tracked.toBase58(), [
      parsedTokenAccount(seed.toBase58(), 5_000_000),
      parsedTokenAccount(knownOutsideSummary.toBase58(), 1_000_000),
    ]],
    [holder.toBase58(), [
      parsedTokenAccount(candidateA.toBase58(), 900_000_000),
      parsedTokenAccount(candidateB.toBase58(), 100_000_000),
      parsedTokenAccount(knownOutsideSummary.toBase58(), 800_000_000),
      parsedTokenAccount(seed.toBase58(), 10_000),
    ]],
    [secondHolder.toBase58(), []],
  ]);
  const tokenAccounts = new Set([holderTokenAccount.toBase58(), secondHolderTokenAccount.toBase58()]);
  const holderOwners = new Set([holder.toBase58(), secondHolder.toBase58()]);
  const connection = {
    getParsedTokenAccountsByOwner: async (owner, filter) => ({
      value: filter.programId.equals(TOKEN_PROGRAM_ID)
        ? portfolios.get(owner.toBase58()) || []
        : [],
    }),
    getTokenLargestAccounts: async (mint) => {
      assert.equal(mint.toBase58(), seed.toBase58());
      return { value: [
        { address: holderTokenAccount, amount: '5000000' },
        { address: secondHolderTokenAccount, amount: '4000000' },
      ] };
    },
    getMultipleAccountsInfo: async (addresses) => {
      const values = addresses.map((address) => address.toBase58());
      if (values.every((address) => tokenAccounts.has(address))) {
        return values.map((address) => (
          address === holderTokenAccount.toBase58() ? tokenAccountInfo(holder) : tokenAccountInfo(secondHolder)
        ));
      }
      if (values.every((address) => holderOwners.has(address))) return values.map(() => null);
      return values.map((address) => {
        if (address === seed.toBase58()) return mintAccountInfo(10_000_000);
        if (address === knownOutsideSummary.toBase58()) return mintAccountInfo(1_000_000_000);
        if (address === candidateA.toBase58()) return mintAccountInfo(1_000_000_000);
        if (address === candidateB.toBase58()) return mintAccountInfo(1_000_000_000);
        return null;
      });
    },
  };
  const phases = [];
  const snapshot = await scanPersonalDiscovery({
    connection,
    wallets: [{ publicKey: tracked.toBase58(), label: 'My wallet', enabled: true }],
    limits: { maxKnownTokens: 1, maxSeeds: 1, maxHoldersPerSeed: 2, maxPortfolioTokens: 10 },
    enrichToken: async (mint) => ({ symbol: mint === seed.toBase58() ? 'SEED' : 'FOUND' }),
    onProgress: (progress) => phases.push(progress.phase),
    now: () => new Date('2026-08-09T12:00:00.000Z'),
  });

  assert.equal(snapshot.schema, 'trebuchet-personal-discovery/v1');
  assert.equal(snapshot.knownTokens.length, 1);
  assert.equal(snapshot.knownTokens[0].symbol, 'SEED');
  assert.equal(snapshot.candidates.length, 2);
  assert.equal(snapshot.candidates.some((token) => token.mint === knownOutsideSummary.toBase58()), false);
  assert.equal(snapshot.candidates[0].mint, candidateA.toBase58());
  assert.equal(snapshot.candidates[0].holderCount, 1);
  assert.equal(snapshot.coverage.holdersScanned, 2);
  assert.equal(snapshot.candidates[0].seedCount, 1);
  assert.equal(snapshot.candidates[0].paths[0].seedMint, seed.toBase58());
  assert.equal(snapshot.candidates[0].paths[0].holder, holder.toBase58());
  assert.ok(snapshot.candidates[0].networkScore > 0);
  assert.equal(snapshot.coverage.confidence, 'High');
  assert.ok(phases.includes('known-wallets'));
  assert.ok(phases.includes('holder-network'));
  assert.ok(phases.includes('candidate-details'));
});

test('personal Discovery keeps the full feed while bounding eager token details', async () => {
  const tracked = Keypair.generate().publicKey;
  const mints = Array.from({ length: 40 }, () => Keypair.generate().publicKey.toBase58());
  const enriched = [];
  const connection = {
    getParsedTokenAccountsByOwner: async (_owner, filter) => ({
      value: filter.programId.equals(TOKEN_PROGRAM_ID)
        ? mints.map((mint) => parsedTokenAccount(mint, 1_000_000))
        : [],
    }),
    getTokenLargestAccounts: async () => ({ value: [] }),
  };

  const snapshot = await scanPersonalDiscovery({
    connection,
    wallets: [{ publicKey: tracked.toBase58(), enabled: true }],
    limits: {
      maxKnownTokens: 40,
      maxSeeds: 1,
      maxKnownTokenDetails: 5,
    },
    enrichToken: async (mint) => {
      enriched.push(mint);
      return { symbol: 'DETAIL' };
    },
  });

  assert.equal(snapshot.knownTokens.length, 40);
  assert.equal(enriched.length, 5);
  assert.equal(snapshot.knownTokens.filter((token) => token.symbol === 'DETAIL').length, 5);
});

test('personal Discovery skips executable program addresses used as wallet seeds', async () => {
  const program = Keypair.generate().publicKey;
  let portfolioCalls = 0;
  const connection = {
    getAccountInfo: async () => ({ executable: true, owner: PublicKey.default }),
    getParsedTokenAccountsByOwner: async () => {
      portfolioCalls += 1;
      return { value: [] };
    },
  };
  const snapshot = await scanPersonalDiscovery({
    connection,
    wallets: [{ publicKey: program.toBase58(), label: 'Not a wallet', enabled: true }],
    now: () => new Date('2026-08-09T12:00:00.000Z'),
  });

  assert.equal(portfolioCalls, 0);
  assert.equal(snapshot.knownTokens.length, 0);
  assert.equal(snapshot.candidates.length, 0);
  assert.match(snapshot.warnings[0], /not an ordinary wallet address/i);
});
