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
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
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
