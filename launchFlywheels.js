// Compatibility entrypoint. New code should import from @trebuchet/core.
//
// App-level flywheel pool registry: binds the Core contract to
// TREBUCHET_CONFIG_DIR/flywheelPools.json with console reporting.

import path from 'path';
import { fileURLToPath } from 'url';
import { createFlywheelPoolStore } from '@trebuchet/core';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function configDir() {
  return process.env.TREBUCHET_CONFIG_DIR || __dirname;
}

export function store() {
  return createFlywheelPoolStore({
    filePath: path.join(configDir(), 'flywheelPools.json'),
    onWarn: (message) => console.warn(message),
    onError: (message) => console.error(message),
  });
}

export function list(kind = 'meme') {
  return store().get(kind);
}

export function all() {
  return store().all();
}

export function add(kind, mint) {
  return store().add(kind, mint);
}

export function remove(kind, mint) {
  return store().remove(kind, mint);
}

export function pick(kind = 'meme', options = {}) {
  return store().pick(kind, options);
}
