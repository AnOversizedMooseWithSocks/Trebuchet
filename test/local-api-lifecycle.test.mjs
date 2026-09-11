import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

test('server import does not bind a port and explicit lifecycle is reusable', async () => {
  const beforeLog = console.log;
  const { createLocalApiServer } = await import('../server.js');

  assert.equal(console.log, beforeLog, 'import must not replace console methods');

  const fakeServer = new EventEmitter();
  fakeServer.listening = false;
  fakeServer.address = () => fakeServer.listening
    ? { address: '127.0.0.1', family: 'IPv4', port: 43123 }
    : null;
  fakeServer.close = (callback) => {
    fakeServer.listening = false;
    queueMicrotask(() => callback());
  };
  const application = {
    listen(port, host, callback) {
      assert.equal(port, 0);
      assert.equal(host, '127.0.0.1');
      fakeServer.listening = true;
      queueMicrotask(callback);
      return fakeServer;
    },
  };
  const localApi = createLocalApiServer({
    application,
    port: 0,
    onStarted() {},
  });
  assert.equal(localApi.address, null);

  const address = await localApi.start();
  assert.equal(address.host, '127.0.0.1');
  assert.ok(address.port > 0);
  assert.equal(localApi.address.url, `http://127.0.0.1:${address.port}`);

  assert.equal(localApi.server, fakeServer);
  await localApi.stop();
  assert.equal(localApi.address, null);
});

test('local API refuses non-loopback bindings', async () => {
  const { createLocalApiServer } = await import('../server.js');
  assert.throws(
    () => createLocalApiServer({ host: '0.0.0.0', port: 0 }),
    /must bind to 127\.0\.0\.1/,
  );
});
