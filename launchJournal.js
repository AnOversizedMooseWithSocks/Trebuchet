// Compatibility entrypoint. New code should import from @trebuchet/core.
//
// App-level launch journal: binds the Core journal contract to
// TREBUCHET_CONFIG_DIR/launchJournals.json with console reporting, keeping
// the historical module-level function surface used by server.js.

import path from 'path';
import { fileURLToPath } from 'url';
import {
  createLaunchJournalStore,
  errorMessage,
  errorDetails,
  tokenCreationComplete,
} from '@trebuchet/core';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function configDir() {
  return process.env.TREBUCHET_CONFIG_DIR || __dirname;
}

// A store is created per call so TREBUCHET_CONFIG_DIR changes between
// calls are honored (the same behavior the original module had by
// resolving the file path on every operation).
function store() {
  return createLaunchJournalStore({
    filePath: path.join(configDir(), 'launchJournals.json'),
    onWarn: (message) => console.warn(message),
    onError: (message) => console.error(message),
  });
}

export {
  errorMessage,
  errorDetails,
  tokenCreationComplete,
};

export function start({ walletPublicKey }) {
  return store().start({ walletPublicKey });
}

export function get(id) {
  return store().get(id);
}

export function activeForWallet(walletPublicKey) {
  return store().activeForWallet(walletPublicKey);
}

export function update(id, patch = {}, event = null) {
  return store().update(id, patch, event);
}

export function upsertForWallet(walletPublicKey, patch = {}, event = null) {
  return store().upsertForWallet(walletPublicKey, patch, event);
}

export function recordEvent(walletPublicKey, event) {
  return store().recordEvent(walletPublicKey, event);
}

export function list(options = {}) {
  return store().list(options);
}

export function archive(id) {
  return store().archive(id);
}