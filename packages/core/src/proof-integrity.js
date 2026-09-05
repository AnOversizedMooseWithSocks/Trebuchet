const AUTHORITY_FIELDS = [
  'mintAuthorityRenounced',
  'freezeAuthorityDisabled',
  'metadataUpdateAuthorityRevoked',
  'metadataImmutable',
];

function optionalBoolean(value) {
  if (value === true) return true;
  if (value === false) return false;
  return null;
}

function numberOrNull(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function optionalCount(value, fallback = 0) {
  const number = numberOrNull(value);
  return number !== null && number >= 0 ? Math.floor(number) : fallback;
}

function stableHashString(value) {
  const text = String(value ?? '');
  const bytes = [];
  for (let index = 0; index < text.length; index += 1) {
    let codePoint = text.codePointAt(index);
    if (codePoint > 0xffff) index += 1;
    if (codePoint <= 0x7f) bytes.push(codePoint);
    else if (codePoint <= 0x7ff) {
      bytes.push(0xc0 | (codePoint >>> 6), 0x80 | (codePoint & 0x3f));
    } else if (codePoint <= 0xffff) {
      bytes.push(0xe0 | (codePoint >>> 12), 0x80 | ((codePoint >>> 6) & 0x3f), 0x80 | (codePoint & 0x3f));
    } else {
      bytes.push(
        0xf0 | (codePoint >>> 18),
        0x80 | ((codePoint >>> 12) & 0x3f),
        0x80 | ((codePoint >>> 6) & 0x3f),
        0x80 | (codePoint & 0x3f),
      );
    }
  }
  const bitLength = bytes.length * 8;
  bytes.push(0x80);
  while (bytes.length % 64 !== 56) bytes.push(0);
  const high = Math.floor(bitLength / 0x100000000);
  const low = bitLength >>> 0;
  for (let shift = 24; shift >= 0; shift -= 8) bytes.push((high >>> shift) & 0xff);
  for (let shift = 24; shift >= 0; shift -= 8) bytes.push((low >>> shift) & 0xff);
  const rotate = (word, bits) => (word >>> bits) | (word << (32 - bits));
  const constants = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];
  const state = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ];
  for (let offset = 0; offset < bytes.length; offset += 64) {
    const words = new Array(64).fill(0);
    for (let index = 0; index < 16; index += 1) {
      const cursor = offset + (index * 4);
      words[index] = ((bytes[cursor] << 24) | (bytes[cursor + 1] << 16)
        | (bytes[cursor + 2] << 8) | bytes[cursor + 3]) >>> 0;
    }
    for (let index = 16; index < 64; index += 1) {
      const s0 = rotate(words[index - 15], 7) ^ rotate(words[index - 15], 18) ^ (words[index - 15] >>> 3);
      const s1 = rotate(words[index - 2], 17) ^ rotate(words[index - 2], 19) ^ (words[index - 2] >>> 10);
      words[index] = (words[index - 16] + s0 + words[index - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = state;
    for (let index = 0; index < 64; index += 1) {
      const sum1 = rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25);
      const choice = (e & f) ^ (~e & g);
      const temp1 = (h + sum1 + choice + constants[index] + words[index]) >>> 0;
      const sum0 = rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (sum0 + majority) >>> 0;
      h = g; g = f; f = e; e = (d + temp1) >>> 0;
      d = c; c = b; b = a; a = (temp1 + temp2) >>> 0;
    }
    [a, b, c, d, e, f, g, h].forEach((word, index) => {
      state[index] = (state[index] + word) >>> 0;
    });
  }
  return state.map((word) => word.toString(16).padStart(8, '0')).join('');
}

function positionRecords(results = []) {
  return (Array.isArray(results) ? results : []).flatMap((pool) => {
    if (Array.isArray(pool?.positions) && pool.positions.length) return pool.positions;
    return [
      ...(Array.isArray(pool?.mainPositions) ? pool.mainPositions : []),
      ...(Array.isArray(pool?.ladderPositions) ? pool.ladderPositions : []),
      ...(Array.isArray(pool?.supportPositions) ? pool.supportPositions : []),
      ...(pool?.bootstrap ? [pool.bootstrap] : []),
    ];
  });
}

function normalizeAirdropRows(rows = []) {
  return (Array.isArray(rows) ? rows : [])
    .map((row) => ({
      wallet: row?.wallet || row?.recipient || row?.address || null,
      tokens: numberOrNull(row?.tokens),
      amountRaw: row?.amountRaw == null ? null : String(row.amountRaw),
      txId: row?.txId || row?.signature || row?.tx || null,
    }))
    .filter((row) => row.wallet)
    .sort((a, b) => [
      a.wallet || '',
      String(a.tokens ?? ''),
      String(a.amountRaw ?? ''),
      a.txId || '',
    ].join('|').localeCompare([
      b.wallet || '',
      String(b.tokens ?? ''),
      String(b.amountRaw ?? ''),
      b.txId || '',
    ].join('|')));
}

function airdropFingerprint(airdrop = {}) {
  const listHash = (key) => {
    const rows = airdrop?.[key];
    const storedHash = typeof airdrop?.[`${key}Hash`] === 'string'
      ? airdrop[`${key}Hash`].trim()
      : '';
    return (!Array.isArray(rows) || rows.length === 0) && storedHash
      ? storedHash
      : stableHashString(JSON.stringify(normalizeAirdropRows(rows)));
  };
  return {
    recipientsHash: listHash('recipients'),
    transferredHash: listHash('transferred'),
    failedHash: listHash('failed'),
  };
}

function transferEvidenceRows(transfer = {}) {
  const rows = [];
  const tokenTransfers = Array.isArray(transfer?.tokenSweep?.transferred)
    ? transfer.tokenSweep.transferred
    : [];
  const nftTransfers = Array.isArray(transfer?.nftSweep?.transferred)
    ? transfer.nftSweep.transferred
    : [];
  const tokenErrors = Array.isArray(transfer?.tokenTransferErrors)
    ? transfer.tokenTransferErrors
    : Array.isArray(transfer?.tokenSweep?.errors) ? transfer.tokenSweep.errors : [];
  const nftErrors = Array.isArray(transfer?.nftTransferErrors)
    ? transfer.nftTransferErrors
    : Array.isArray(transfer?.nftSweep?.errors) ? transfer.nftSweep.errors : [];
  const solAmount = numberOrNull(transfer?.solSweep?.solTransferred ?? transfer?.solTransferred);
  const solTx = transfer?.solSweep?.txId
    || transfer?.solTxId
    || transfer?.txId
    || transfer?.signature
    || null;

  if (solAmount != null || solTx || transfer?.solSweepError) {
    rows.push({
      type: 'sol',
      asset: 'SOL',
      amount: solAmount,
      decimals: null,
      txId: solTx,
      status: transfer?.solSweepError || null,
      error: Boolean(transfer?.solSweepError),
    });
  }
  tokenTransfers.forEach((row) => rows.push({
    type: 'token',
    asset: row.mint || row.tokenMint || null,
    amount: row.amount == null ? null : String(row.amount),
    decimals: numberOrNull(row.decimals),
    txId: row.txId || row.signature || null,
    status: 'transferred',
    error: false,
  }));
  nftTransfers.forEach((row) => rows.push({
    type: 'nft',
    asset: row.mint || row.nftMint || null,
    amount: '1',
    programName: row.programName || null,
    txId: row.txId || row.signature || null,
    status: 'transferred',
    error: false,
  }));
  tokenErrors.forEach((row) => rows.push({
    type: 'token',
    asset: row.mint || row.tokenMint || null,
    amount: null,
    decimals: numberOrNull(row.decimals),
    txId: row.txId || row.signature || null,
    status: row.error || row.reason || 'transfer failed',
    error: true,
  }));
  nftErrors.forEach((row) => rows.push({
    type: 'nft',
    asset: row.mint || row.nftMint || null,
    amount: null,
    programName: row.programName || null,
    txId: row.txId || row.signature || null,
    status: row.error || row.reason || 'transfer failed',
    error: true,
  }));

  return rows.sort((a, b) => [
    a.type || '',
    a.asset || '',
    String(a.amount ?? ''),
    String(a.decimals ?? ''),
    a.programName || '',
    a.txId || '',
    a.status || '',
    String(a.error),
  ].join('|').localeCompare([
    b.type || '',
    b.asset || '',
    String(b.amount ?? ''),
    String(b.decimals ?? ''),
    b.programName || '',
    b.txId || '',
    b.status || '',
    String(b.error),
  ].join('|')));
}

export function v2TransferEvidenceHash(transfer = {}) {
  if (!transfer || typeof transfer !== 'object' || Object.keys(transfer).length === 0) return null;
  return stableHashString(JSON.stringify({
    destinationWallet: transfer.destinationWallet || null,
    status: transfer.status || null,
    walletEmpty: optionalBoolean(transfer.walletEmpty),
    rows: transferEvidenceRows(transfer),
  }));
}

function terminalTransfer(transfer = null) {
  const tokenErrors = Array.isArray(transfer?.tokenTransferErrors)
    ? transfer.tokenTransferErrors
    : Array.isArray(transfer?.tokenSweep?.errors) ? transfer.tokenSweep.errors : [];
  const nftErrors = Array.isArray(transfer?.nftTransferErrors)
    ? transfer.nftTransferErrors
    : Array.isArray(transfer?.nftSweep?.errors) ? transfer.nftSweep.errors : [];
  return Boolean(
    transfer
      && typeof transfer === 'object'
      && String(transfer.destinationWallet || '').trim()
      && transfer.status !== 'planned-before-sweep'
      && transfer.walletEmpty === true
      && tokenErrors.length === 0
      && nftErrors.length === 0
      && !transfer.solSweepError
  );
}

function poolFingerprint(results = []) {
  return (Array.isArray(results) ? results : []).map((pool) => ({
    poolId: pool?.poolId || pool?.id || null,
    quoteMint: pool?.quoteMint || pool?.quoteAddress || null,
    supplyPercent: numberOrNull(pool?.supplyPercent),
    tickSpacing: numberOrNull(pool?.tickSpacing),
    initialPrice: pool?.initialPrice == null ? null : String(pool.initialPrice),
    launchedSide: pool?.launchedSide || null,
    createPoolTx: pool?.createPoolTx || pool?.txIds?.createPool || null,
  })).sort((a, b) => [
    a.poolId || '',
    a.quoteMint || '',
    String(a.tickSpacing ?? ''),
    String(a.initialPrice ?? ''),
  ].join('|').localeCompare([
    b.poolId || '',
    b.quoteMint || '',
    String(b.tickSpacing ?? ''),
    String(b.initialPrice ?? ''),
  ].join('|')));
}

function positionFingerprint(results = []) {
  return (Array.isArray(results) ? results : []).flatMap((pool) => {
    const poolId = pool?.poolId || pool?.id || null;
    const record = (position = {}, type) => ({
      poolId,
      type: type || position.type || position.kind || null,
      sliceIndex: numberOrNull(position.sliceIndex),
      bandIndex: numberOrNull(position.bandIndex),
      supportIndex: numberOrNull(position.supportIndex),
      sharePercent: numberOrNull(position.sharePercent),
      supplyPercent: numberOrNull(position.supplyPercent),
      lowerMultiplier: numberOrNull(position.lowerMultiplier),
      upperMultiplier: numberOrNull(position.upperMultiplier),
      depthPct: numberOrNull(position.depthPct),
      positionNftMint: position.positionNftMint || position.nftMint || position.positionMint || null,
      feeKeyNftMint: position.feeKeyNftMint || position.feeKeyMint || null,
      locked: optionalBoolean(position.locked),
      recipient: position.recipient || null,
      transferredTo: position.transferredTo || null,
      tickLower: numberOrNull(position.tickLower),
      tickUpper: numberOrNull(position.tickUpper),
      openTx: position.openTx || position.txIds?.open || null,
      lockTx: position.lockTx || position.txIds?.lock || null,
      transferTx: position.transferTx || position.txIds?.transfer || null,
    });
    if (Array.isArray(pool?.positions) && pool.positions.length) {
      return pool.positions.map((position) => record(position, position.type || position.kind || null));
    }
    return [
      ...(Array.isArray(pool?.mainPositions) ? pool.mainPositions.map((position) => record(position, 'main')) : []),
      ...(Array.isArray(pool?.ladderPositions) ? pool.ladderPositions.map((position) => record(position, 'ladder')) : []),
      ...(Array.isArray(pool?.supportPositions) ? pool.supportPositions.map((position) => record(position, 'support')) : []),
      ...(pool?.bootstrap ? [record(pool.bootstrap, 'bootstrap')] : []),
    ];
  }).sort((a, b) => [
    a.poolId || '',
    a.positionNftMint || '',
    a.feeKeyNftMint || '',
    a.type || '',
    String(a.sliceIndex ?? ''),
    String(a.bandIndex ?? ''),
    String(a.supportIndex ?? ''),
    String(a.sharePercent ?? ''),
    String(a.supplyPercent ?? ''),
    String(a.lowerMultiplier ?? ''),
    String(a.upperMultiplier ?? ''),
    String(a.depthPct ?? ''),
    String(a.tickLower ?? ''),
    String(a.tickUpper ?? ''),
    a.recipient || '',
    a.transferredTo || '',
    a.openTx || '',
    a.lockTx || '',
    a.transferTx || '',
  ].join('|').localeCompare([
    b.poolId || '',
    b.positionNftMint || '',
    b.feeKeyNftMint || '',
    b.type || '',
    String(b.sliceIndex ?? ''),
    String(b.bandIndex ?? ''),
    String(b.supportIndex ?? ''),
    String(b.sharePercent ?? ''),
    String(b.supplyPercent ?? ''),
    String(b.lowerMultiplier ?? ''),
    String(b.upperMultiplier ?? ''),
    String(b.depthPct ?? ''),
    String(b.tickLower ?? ''),
    String(b.tickUpper ?? ''),
    b.recipient || '',
    b.transferredTo || '',
    b.openTx || '',
    b.lockTx || '',
    b.transferTx || '',
  ].join('|')));
}

export function v2LaunchProofFingerprint(proof = {}) {
  const results = Array.isArray(proof?.liquidity?.results) ? proof.liquidity.results : [];
  const positions = positionRecords(results);
  const poolIds = [
    ...(Array.isArray(proof?.liquidity?.poolIds) ? proof.liquidity.poolIds : []),
    ...results.map((pool) => pool?.poolId || pool?.id).filter(Boolean),
  ].filter((value, index, values) => value && values.indexOf(value) === index).sort();
  const destination = terminalTransfer(proof?.transfer)
    ? String(proof.transfer.destinationWallet || '').trim() || null
    : proof?.destinationWallet || null;
  return JSON.stringify({
    mint: proof?.token?.mint || null,
    launchWallet: proof?.walletPublicKey || null,
    destinationWallet: destination,
    terminalTransferEvidenceHash: terminalTransfer(proof?.transfer)
      ? v2TransferEvidenceHash(proof.transfer)
      : null,
    poolIds,
    pools: poolFingerprint(results),
    positionCount: optionalCount(proof?.liquidity?.positionCount, positions.length),
    lockedPositionCount: optionalCount(
      proof?.liquidity?.lockedPositionCount,
      positions.filter((position) => position?.locked === true).length,
    ),
    feeKeyCount: optionalCount(
      proof?.liquidity?.feeKeyCount,
      positions.filter((position) => position?.feeKeyNftMint || position?.feeKeyMint).length,
    ),
    positions: positionFingerprint(results),
    authorities: AUTHORITY_FIELDS.reduce((record, field) => {
      record[field] = optionalBoolean(proof?.token?.[field]);
      return record;
    }, {}),
    airdrop: {
      plannedRecipientCount: Number(proof?.airdrop?.plannedRecipientCount || 0),
      deliveredCount: Number(proof?.airdrop?.deliveredCount || 0),
      failedCount: Number(proof?.airdrop?.failedCount || 0),
      ...airdropFingerprint(proof?.airdrop || {}),
    },
  });
}

export function requiredClassicComparisonRowIds(proof = {}) {
  const results = Array.isArray(proof?.liquidity?.results) ? proof.liquidity.results : [];
  const positions = positionRecords(results);
  const pools = poolFingerprint(results);
  const poolIds = [...new Set([
    ...(Array.isArray(proof?.liquidity?.poolIds) ? proof.liquidity.poolIds : []),
    ...results.map((pool) => pool?.poolId || pool?.id).filter(Boolean),
  ])];
  const airdropRequired = Number(proof?.airdrop?.plannedRecipientCount || 0) > 0
    || Number(proof?.airdrop?.deliveredCount || 0) > 0
    || Number(proof?.airdrop?.failedCount || 0) > 0;
  const rows = [];
  const add = (id, required) => {
    if (required) rows.push(id);
  };
  add('mint', proof?.token?.mint);
  add('launch-wallet', proof?.walletPublicKey);
  add('pools', poolIds.length > 0);
  add('pool-quote-mints', pools.some((pool) => pool.quoteMint));
  add('pool-parameters', pools.some((pool) => (
    pool.supplyPercent != null
      || pool.tickSpacing != null
      || pool.initialPrice != null
      || pool.launchedSide
  )));
  add('pool-create-transactions', pools.some((pool) => pool.createPoolTx));
  add('authority-posture', AUTHORITY_FIELDS.some((field) => optionalBoolean(proof?.token?.[field]) !== null));
  add('positionCount', positions.length > 0 || Number(proof?.liquidity?.positionCount || 0) > 0);
  add('lockedPositionCount', positions.some((position) => position?.locked === true) || Number(proof?.liquidity?.lockedPositionCount || 0) > 0);
  add('feeKeyCount', positions.some((position) => position?.feeKeyNftMint || position?.feeKeyMint) || Number(proof?.liquidity?.feeKeyCount || 0) > 0);
  add('position-nfts', positions.some((position) => position?.positionNftMint || position?.nftMint || position?.positionMint));
  add('fee-key-nfts', positions.some((position) => position?.feeKeyNftMint || position?.feeKeyMint));
  add('fee-key-recipients', positions.some((position) => position?.recipient || position?.transferredTo));
  add('position-transactions', positions.some((position) => (
    position?.openTx || position?.lockTx || position?.transferTx
      || position?.txIds?.open || position?.txIds?.lock || position?.txIds?.transfer
  )));
  add('position-liquidity-shape', positions.some((position) => (
    position?.sharePercent != null
      || position?.supplyPercent != null
      || position?.lowerMultiplier != null
      || position?.upperMultiplier != null
      || position?.depthPct != null
  )));
  add('destination', terminalTransfer(proof?.transfer)
    ? proof.transfer.destinationWallet
    : proof?.destinationWallet || proof?.launchConfig?.poolTopology?.sweepDestination);
  add('airdrop-delivery', airdropRequired);
  add('airdrop-recipients', airdropRequired);
  add('airdrop-transactions', airdropRequired);
  return rows;
}

export function classicArtifactRequiredValues(proof = {}) {
  const results = Array.isArray(proof?.liquidity?.results) ? proof.liquidity.results : [];
  const positions = positionRecords(results);
  return [...new Set([
    proof?.token?.mint,
    proof?.walletPublicKey,
    terminalTransfer(proof?.transfer) ? proof.transfer.destinationWallet : proof?.destinationWallet,
    ...results.flatMap((pool) => [
      pool?.poolId || pool?.id,
      pool?.quoteMint || pool?.quoteAddress,
      pool?.createPoolTx || pool?.txIds?.createPool,
    ]),
    ...positions.flatMap((position) => [
      position?.positionNftMint || position?.nftMint || position?.positionMint,
      position?.feeKeyNftMint || position?.feeKeyMint,
      position?.openTx || position?.txIds?.open,
      position?.lockTx || position?.txIds?.lock,
      position?.recipient,
      position?.transferredTo,
      position?.transferTx || position?.txIds?.transfer,
    ]),
    ...(Array.isArray(proof?.airdrop?.recipients)
      ? proof.airdrop.recipients.map((row) => row?.wallet || row?.recipient || row?.address)
      : []),
    ...(Array.isArray(proof?.airdrop?.transferred)
      ? proof.airdrop.transferred.flatMap((row) => [
        row?.wallet || row?.recipient || row?.address,
        row?.txId || row?.signature || row?.tx,
      ])
      : []),
  ].filter((value) => typeof value === 'string' && value.trim()))];
}
