import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DEMO_TIME_SCALE = '0';

const { Keypair } = await import('@solana/web3.js');
const demoChainService = await import('../demoChainService.js');
const { buildV2ExecutionReadiness } = await import('../v2LaunchPlan.js');

const VALID_SWEEP_DESTINATION = '11111111111111111111111111111115';
const VALID_AIRDROP_WALLET = '11111111111111111111111111111117';
const VALID_FEE_RECIPIENT = '11111111111111111111111111111118';

function mockReq(body = {}) {
  return { body, query: {}, path: '/', get: () => undefined };
}

function invokeJsonHandler(handler, body, options) {
  return new Promise((resolve, reject) => {
    const res = { _status: 200 };
    res.status = (code) => {
      res._status = code;
      return res;
    };
    res.json = (data) => {
      if (res._status >= 400 || data?.success === false) {
        const error = new Error(data?.error || `HTTP ${res._status}`);
        error.statusCode = res._status;
        error.data = data;
        reject(error);
        return;
      }
      resolve(data);
    };

    Promise.resolve(handler(mockReq(body), res, options)).catch(reject);
  });
}

async function withMutedDemoLogs(fn) {
  const originalLog = console.log;
  console.log = () => {};
  try {
    return await fn();
  } finally {
    console.log = originalLog;
  }
}

test('v2 demo launch contract rebuilds LP readiness after mint and delivers configured airdrops', async () => withMutedDemoLogs(async () => {
  const wallet = Keypair.generate();
  const walletPublicKey = wallet.publicKey.toBase58();
  const tempWalletSecretKey = Array.from(wallet.secretKey);
  demoChainService.registerWallet(walletPublicKey);

  const config = {
    token: {
      name: 'MoonKit',
      symbol: 'MKT',
      supply: '1000000',
    },
    poolTopology: {
      targetMarketCapUsd: 250000,
      sweepDestination: VALID_SWEEP_DESTINATION,
      pools: [
        {
          quoteToken: 'SOL',
          quoteSymbol: 'SOL',
          supplyPercent: 60,
          distribution: [
            { sharePercent: 80, recipient: VALID_FEE_RECIPIENT },
            { sharePercent: 20 },
          ],
          ladder: {
            mode: 'manual',
            bands: [
              { supplyPercent: 5, lowerMultiplier: 1.1, upperMultiplier: 1.5 },
            ],
          },
        },
      ],
      airdrop: {
        enabled: true,
        recipientCount: 1,
        supplyPercent: 1,
        recipients: [
          { wallet: VALID_AIRDROP_WALLET, tokens: 25 },
        ],
      },
    },
  };

  const initialReadiness = buildV2ExecutionReadiness(config, {
    demoMode: true,
    walletPublicKey,
    walletAvailable: true,
    secretAvailable: true,
  });
  assert.equal(initialReadiness.status, 'ready');
  assert.equal(initialReadiness.nextEndpoint, '/api/create-token');
  assert.equal(initialReadiness.classicPayloads.createLp.airdrop, null);

  const tokenResult = await invokeJsonHandler(demoChainService.handleCreateToken, {
    tempWalletSecretKey,
    ...initialReadiness.classicPayloads.createToken,
  });
  assert.equal(tokenResult.success, true);
  assert.ok(tokenResult.tokenMint);

  const lpReadiness = buildV2ExecutionReadiness(config, {
    demoMode: true,
    walletPublicKey,
    walletAvailable: true,
    secretAvailable: true,
    tokenMint: tokenResult.tokenMint,
  });
  assert.equal(lpReadiness.status, 'ready');
  assert.equal(lpReadiness.nextEndpoint, '/api/create-lp');
  assert.deepEqual(lpReadiness.classicPayloads.createLp.airdrop, {
    tokenMint: tokenResult.tokenMint,
    tokenDecimals: 9,
    recipientCount: 1,
    recipients: [
      { wallet: VALID_AIRDROP_WALLET, tokens: 25 },
    ],
  });

  const createLpPayload = {
    ...lpReadiness.classicPayloads.createLp,
    tempWalletSecretKey,
    tokenMint: tokenResult.tokenMint,
    tokenDecimals: tokenResult.decimals,
    tokenTotalSupply: String(tokenResult.totalSupply),
  };
  const lpResult = await invokeJsonHandler(demoChainService.handleCreateLp, createLpPayload);
  assert.equal(lpResult.success, true);
  assert.equal(lpResult.results.length, 1);
  assert.equal(lpResult.results[0].ladderPositions.length, 1);
  assert.equal(
    lpResult.results[0].mainPositions[0].transferredTo,
    VALID_FEE_RECIPIENT,
  );

  const transferResult = await invokeJsonHandler(demoChainService.handleTransferAssets, {
    ...lpReadiness.classicPayloads.transferAssets,
    tempWalletSecretKey,
    destinationWallet: VALID_SWEEP_DESTINATION,
    tokenMint: tokenResult.tokenMint,
    tokenDecimals: tokenResult.decimals,
    airdrop: createLpPayload.airdrop,
  });
  assert.equal(transferResult.success, true);
  assert.equal(transferResult.destinationWallet, VALID_SWEEP_DESTINATION);
  assert.equal(transferResult.airdrop.transferred.length, 1);
  assert.equal(transferResult.airdrop.transferred[0].wallet, VALID_AIRDROP_WALLET);
  assert.equal(transferResult.airdrop.failed.length, 0);
  assert.ok(transferResult.nftSweep.transferred.length >= 1);
  assert.ok(transferResult.tokensTransferred >= 1);
  assert.equal(transferResult.walletEmpty, true);

  const completedReadiness = buildV2ExecutionReadiness(config, {
    demoMode: true,
    walletPublicKey,
    walletAvailable: true,
    secretAvailable: true,
    tokenMint: tokenResult.tokenMint,
    liquidityComplete: true,
    transfer: transferResult,
  });
  assert.equal(completedReadiness.completed, true);
  assert.equal(completedReadiness.completionStatus, 'complete');
  assert.equal(completedReadiness.completion.terminalSweepEvidence, true);
  assert.equal(completedReadiness.nextEndpoint, null);
  assert.equal(completedReadiness.nextAction, 'Launch complete');
  assert.equal(completedReadiness.phases.find((phase) => phase.id === 'sweep')?.state, 'complete');
}));
