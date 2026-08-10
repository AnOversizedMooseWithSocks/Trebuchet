import { PublicKey, SystemProgram } from '@solana/web3.js';
import {
  AccountLayout,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';

export const PERSONAL_DISCOVERY_LIMITS = Object.freeze({
  maxWallets: 5,
  maxKnownTokens: 10,
  maxSeeds: 3,
  maxHoldersPerSeed: 5,
  maxPortfolioTokens: 10,
  maxCandidates: 10,
});

const TOKEN_PROGRAMS = Object.freeze([TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]);

function safeBigInt(value) {
  try {
    return BigInt(String(value ?? '0'));
  } catch {
    return 0n;
  }
}

function finiteNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function shortAddress(address) {
  const value = String(address || '');
  return value.length > 12 ? `${value.slice(0, 5)}…${value.slice(-4)}` : value;
}

function holdingRankValue(holding) {
  const amountUi = Math.max(0, finiteNumber(holding.amountUi) || 0);
  return Math.log10(1 + amountUi);
}

export function normalizePortfolioResponses(responses = []) {
  const holdings = new Map();
  for (const response of responses) {
    for (const tokenAccount of response?.value || []) {
      const info = tokenAccount?.account?.data?.parsed?.info;
      const mint = String(info?.mint || '').trim();
      const amountRaw = safeBigInt(info?.tokenAmount?.amount);
      const decimals = Number(info?.tokenAmount?.decimals);
      if (!mint || amountRaw <= 0n || !Number.isInteger(decimals) || decimals < 0) continue;
      // The graph is for fungible token discovery. A one-of-one zero-decimal
      // balance is overwhelmingly likely to be an NFT or position receipt.
      if (decimals === 0 && amountRaw === 1n) continue;
      const existing = holdings.get(mint) || {
        mint,
        amountRaw: 0n,
        amountUi: 0,
        decimals,
      };
      existing.amountRaw += amountRaw;
      existing.amountUi += Math.max(0, finiteNumber(info?.tokenAmount?.uiAmountString) || 0);
      holdings.set(mint, existing);
    }
  }
  return [...holdings.values()].map((holding) => ({
    ...holding,
    amountRaw: holding.amountRaw.toString(),
  }));
}

export async function readWalletPortfolio(connection, publicKey) {
  const owner = publicKey instanceof PublicKey ? publicKey : new PublicKey(publicKey);
  const settled = await Promise.allSettled(TOKEN_PROGRAMS.map((programId) => (
    connection.getParsedTokenAccountsByOwner(owner, { programId }, 'confirmed')
  )));
  const responses = settled
    .filter((result) => result.status === 'fulfilled')
    .map((result) => result.value);
  if (!responses.length) {
    throw settled.find((result) => result.status === 'rejected')?.reason
      || new Error('Wallet portfolio lookup failed.');
  }
  return {
    holdings: normalizePortfolioResponses(responses),
    partial: settled.some((result) => result.status === 'rejected'),
  };
}

export function resolveLargestAccountOwners(largestAccounts = [], accountInfos = []) {
  const rows = [];
  largestAccounts.forEach((account, index) => {
    const info = accountInfos[index];
    if (!info?.data) return;
    try {
      const decoded = AccountLayout.decode(info.data);
      rows.push({
        tokenAccount: String(account.address || ''),
        owner: new PublicKey(decoded.owner).toBase58(),
        amountRaw: String(account.amount || '0'),
      });
    } catch {
      // Ignore malformed or non-token accounts returned by an upstream RPC.
    }
  });
  return rows;
}

async function qualifyingLargestOwners(connection, mint, maxHolders) {
  const result = await connection.getTokenLargestAccounts(new PublicKey(mint), 'confirmed');
  const largest = (result?.value || []).slice(0, Math.max(maxHolders * 2, maxHolders));
  if (!largest.length) return [];
  const tokenAddresses = largest.map((row) => new PublicKey(row.address));
  const tokenInfos = await connection.getMultipleAccountsInfo(tokenAddresses, 'confirmed');
  const resolved = resolveLargestAccountOwners(largest, tokenInfos);
  const uniqueOwners = [...new Set(resolved.map((row) => row.owner))];
  const ownerInfos = uniqueOwners.length
    ? await connection.getMultipleAccountsInfo(uniqueOwners.map((owner) => new PublicKey(owner)), 'confirmed')
    : [];
  const eligibleOwners = new Set(uniqueOwners.filter((owner, index) => {
    const info = ownerInfos[index];
    // Ordinary wallets are System Program accounts. An address with no own
    // account can still control token accounts, so it remains eligible. PDAs,
    // pool vaults, and most program-controlled owners are excluded here.
    return !info || (!info.executable && info.owner?.equals?.(SystemProgram.programId));
  }));
  return resolved
    .filter((row) => eligibleOwners.has(row.owner))
    .filter((row, index, rows) => rows.findIndex((entry) => entry.owner === row.owner) === index)
    .slice(0, maxHolders);
}

function addKnownHolding(known, wallet, holding) {
  const record = known.get(holding.mint) || {
    mint: holding.mint,
    walletCount: 0,
    wallets: [],
    aggregateUiAmount: 0,
  };
  if (!record.wallets.some((entry) => entry.publicKey === wallet.publicKey)) {
    record.walletCount += 1;
    record.wallets.push({
      publicKey: wallet.publicKey,
      label: wallet.label || shortAddress(wallet.publicKey),
      amountUi: holding.amountUi,
    });
  }
  record.aggregateUiAmount += Math.max(0, finiteNumber(holding.amountUi) || 0);
  known.set(holding.mint, record);
}

function candidateScore(candidate, context) {
  const holderReach = context.holdersScanned > 0
    ? candidate.holders.size / context.holdersScanned
    : 0;
  const seedReach = context.seedsScanned > 0
    ? candidate.seeds.size / context.seedsScanned
    : 0;
  const ranks = candidate.paths.map((path) => path.rank);
  const averageRank = ranks.length
    ? ranks.reduce((sum, rank) => sum + rank, 0) / ranks.length
    : PERSONAL_DISCOVERY_LIMITS.maxPortfolioTokens;
  const rankStrength = Math.max(0, (11 - Math.min(10, averageRank)) / 10);
  return Math.max(0, Math.min(100, Math.round(
    holderReach * 55
      + seedReach * 25
      + rankStrength * 20,
  )));
}

function confidenceForCoverage(coverage) {
  if (coverage >= 0.8) return 'High';
  if (coverage >= 0.5) return 'Medium';
  return 'Low';
}

async function enrichRecords(records, enrichToken, onProgress, phase) {
  if (typeof enrichToken !== 'function') return records;
  const enriched = new Array(records.length);
  let cursor = 0;
  let completed = 0;
  const workers = Array.from({ length: Math.min(3, records.length) }, async () => {
    while (cursor < records.length) {
      const index = cursor;
      cursor += 1;
      const record = records[index];
      try {
        enriched[index] = { ...record, ...(await enrichToken(record.mint)) };
      } catch (error) {
        enriched[index] = {
          ...record,
          warnings: [...(record.warnings || []), `Token details: ${error.message || 'lookup failed'}`],
        };
      }
      completed += 1;
      onProgress?.({ phase, current: completed, total: records.length });
    }
  });
  await Promise.all(workers);
  return enriched;
}

export async function scanPersonalDiscovery({
  connection,
  wallets = [],
  enrichToken = null,
  limits = {},
  onProgress = null,
  now = () => new Date(),
} = {}) {
  if (!connection) throw new Error('Personal Discovery requires a Solana connection.');
  const effective = { ...PERSONAL_DISCOVERY_LIMITS };
  Object.keys(PERSONAL_DISCOVERY_LIMITS).forEach((key) => {
    if (!Object.prototype.hasOwnProperty.call(limits, key)) return;
    effective[key] = Math.max(1, Math.min(
      PERSONAL_DISCOVERY_LIMITS[key],
      Number(limits[key]) || 1,
    ));
  });
  const activeWallets = wallets.filter((wallet) => wallet?.enabled !== false).slice(0, effective.maxWallets);
  if (!activeWallets.length) throw new Error('Add and enable at least one wallet before scanning.');

  const warnings = [];
  const known = new Map();
  onProgress?.({ phase: 'known-wallets', current: 0, total: activeWallets.length });
  for (let index = 0; index < activeWallets.length; index += 1) {
    const wallet = activeWallets[index];
    onProgress?.({ phase: 'known-wallets', current: index + 1, total: activeWallets.length });
    try {
      if (typeof connection.getAccountInfo === 'function') {
        const account = await connection.getAccountInfo(new PublicKey(wallet.publicKey), 'confirmed');
        if (account && (account.executable || !account.owner?.equals?.(SystemProgram.programId))) {
          warnings.push(`${wallet.label || shortAddress(wallet.publicKey)} is not an ordinary wallet address and was skipped.`);
          continue;
        }
      }
      const portfolio = await readWalletPortfolio(connection, wallet.publicKey);
      if (portfolio.partial) warnings.push(`${wallet.label || shortAddress(wallet.publicKey)}: one token program was unavailable.`);
      portfolio.holdings.forEach((holding) => addKnownHolding(known, wallet, holding));
    } catch (error) {
      warnings.push(`${wallet.label || shortAddress(wallet.publicKey)}: ${error.message || 'portfolio lookup failed'}`);
    }
  }

  let knownTokens = [...known.values()]
    .sort((a, b) => b.walletCount - a.walletCount || b.aggregateUiAmount - a.aggregateUiAmount)
    .slice(0, effective.maxKnownTokens);
  knownTokens = (await enrichRecords(knownTokens, enrichToken, onProgress, 'known-details'))
    .map((token) => ({
      ...token,
      estimatedValueUsd: finiteNumber(token.priceUsd) == null
        ? null
        : Math.max(0, token.aggregateUiAmount * Number(token.priceUsd)),
    }))
    .sort((a, b) => b.walletCount - a.walletCount
      || (b.estimatedValueUsd || 0) - (a.estimatedValueUsd || 0)
      || b.aggregateUiAmount - a.aggregateUiAmount);
  const seeds = knownTokens.slice(0, effective.maxSeeds);
  // Exclude every token already held by a tracked wallet, not only the ten
  // records shown in the Known tokens summary.
  const knownMints = new Set(known.keys());
  const candidates = new Map();
  const scannedHolders = new Set();
  const holderPortfolios = new Map();
  let successfulHolderSlots = 0;

  onProgress?.({ phase: 'holder-network', current: 0, total: seeds.length });
  for (let seedIndex = 0; seedIndex < seeds.length; seedIndex += 1) {
    const seed = seeds[seedIndex];
    onProgress?.({ phase: 'holder-network', current: seedIndex + 1, total: seeds.length });
    let owners;
    try {
      owners = await qualifyingLargestOwners(connection, seed.mint, effective.maxHoldersPerSeed);
    } catch (error) {
      warnings.push(`${shortAddress(seed.mint)} holders: ${error.message || 'lookup failed'}`);
      continue;
    }
    for (const owner of owners) {
      if (activeWallets.some((wallet) => wallet.publicKey === owner.owner)) continue;
      try {
        let portfolio = holderPortfolios.get(owner.owner);
        if (!portfolio) {
          portfolio = await readWalletPortfolio(connection, owner.owner);
          holderPortfolios.set(owner.owner, portfolio);
        }
        successfulHolderSlots += 1;
        scannedHolders.add(owner.owner);
        const ranked = portfolio.holdings
          .filter((holding) => holding.mint !== seed.mint)
          .sort((a, b) => holdingRankValue(b) - holdingRankValue(a))
          .slice(0, effective.maxPortfolioTokens);
        ranked.forEach((holding, rankIndex) => {
          if (knownMints.has(holding.mint)) return;
          const candidate = candidates.get(holding.mint) || {
            mint: holding.mint,
            holders: new Set(),
            seeds: new Set(),
            paths: [],
          };
          candidate.holders.add(owner.owner);
          candidate.seeds.add(seed.mint);
          candidate.paths.push({
            seedMint: seed.mint,
            holder: owner.owner,
            rank: rankIndex + 1,
            amountUi: holding.amountUi,
          });
          candidates.set(holding.mint, candidate);
        });
      } catch (error) {
        warnings.push(`${shortAddress(owner.owner)} portfolio: ${error.message || 'lookup failed'}`);
      }
    }
  }

  const coverage = seeds.length
    ? Math.min(1, successfulHolderSlots / (seeds.length * effective.maxHoldersPerSeed))
    : 0;
  const context = { holdersScanned: scannedHolders.size, seedsScanned: seeds.length };
  const minimumHolderCount = scannedHolders.size >= 2 ? 2 : 1;
  let candidateRows = [...candidates.values()]
    .filter((candidate) => candidate.holders.size >= minimumHolderCount)
    .map((candidate) => ({
      mint: candidate.mint,
      networkScore: candidateScore(candidate, context),
      confidence: confidenceForCoverage(coverage),
      holderCount: candidate.holders.size,
      seedCount: candidate.seeds.size,
      paths: candidate.paths
        .sort((a, b) => a.rank - b.rank)
        .slice(0, 8),
    }))
    .sort((a, b) => b.networkScore - a.networkScore || b.holderCount - a.holderCount)
    .slice(0, effective.maxCandidates);

  candidateRows = await enrichRecords(candidateRows, enrichToken, onProgress, 'candidate-details');

  return {
    schema: 'trebuchet-personal-discovery/v1',
    completedAt: now().toISOString(),
    limits: effective,
    coverage: {
      walletsRequested: activeWallets.length,
      walletsWithTokens: new Set(knownTokens.flatMap((token) => token.wallets?.map((wallet) => wallet.publicKey) || [])).size,
      knownTokenCount: knownTokens.length,
      seedsScanned: seeds.length,
      holdersScanned: scannedHolders.size,
      ratio: coverage,
      confidence: confidenceForCoverage(coverage),
    },
    knownTokens,
    candidates: candidateRows,
    warnings: warnings.slice(0, 50),
  };
}
