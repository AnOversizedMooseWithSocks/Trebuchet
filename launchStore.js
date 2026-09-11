// Compatibility entrypoint. New code should import from @trebuchet/core.
//
// App-level saved-launch store: binds the Core launch-store contract to
// TREBUCHET_CONFIG_DIR/launches.json with console reporting.

import path from 'path';
import { fileURLToPath } from 'url';
import { createLaunchStore } from '@trebuchet/core';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function configDir() {
  return process.env.TREBUCHET_CONFIG_DIR || __dirname;
}

// A store is created per call so TREBUCHET_CONFIG_DIR changes between
// calls are honored.
export function store() {
  return createLaunchStore({
    filePath: path.join(configDir(), 'launches.json'),
    onWarn: (message) => console.warn(message),
    onError: (message) => console.error(message),
  });
}

export function list() {
  return store().list();
}

export function get(id) {
  return store().get(id);
}

export function save(entry) {
  return store().save(entry);
}

export function remove(id) {
  return store().remove(id);
}

export function storeFilePath() {
  return store().filePath;
}
