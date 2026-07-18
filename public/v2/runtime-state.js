(function installTrebuchetV2RuntimeState(global) {
  function walletUnlocked({ wallet = null, secretPin = {}, demoActive = false } = {}) {
    if (!wallet || wallet.hasSecretKey !== true || wallet.decryptionFailed === true) return false;
    if (demoActive) return true;
    if (secretPin.locked === true) return false;
    if (secretPin.configured === true) return secretPin.unlocked === true;
    return true;
  }

  function networkLabel({ demoActive = false, rpcName = '', rpcActiveUrl = '' } = {}) {
    if (demoActive) return 'Demo';
    if (String(rpcName || '').trim()) return String(rpcName).trim();
    try {
      return new URL(rpcActiveUrl).hostname || 'RPC unavailable';
    } catch {
      return 'RPC unavailable';
    }
  }

  function fundingEstimate({ estimateMatches = false, estimatedSol = null } = {}) {
    const value = Number(estimatedSol);
    if (!estimateMatches || !Number.isFinite(value) || value <= 0) {
      return { available: false, value: null, label: 'Estimate required' };
    }
    return { available: true, value, label: 'Verified estimate' };
  }

  global.TrebuchetV2RuntimeState = Object.freeze({
    fundingEstimate,
    networkLabel,
    walletUnlocked,
  });
}(window));
