import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PLACEHOLDER_TOKEN_IMAGE_URI,
  SEALED_TOKEN_NAME,
  SEALED_TOKEN_SYMBOL,
  logoDataUrlToGenericFile,
  tokenMetadataJson,
  uploadSealedPlaceholderMetadata,
  uploadTokenMetadata,
} from '../metadataUploadService.js';
import { metadataDocumentHash } from '../brandShieldService.js';

test('converts logo data URLs to Umi generic files with content-type tags', () => {
  const logo = logoDataUrlToGenericFile('data:image/png;base64,aGVsbG8=');

  assert.equal(logo.fileName, 'logo');
  assert.equal(Buffer.isBuffer(logo.buffer), true);
  assert.equal(logo.buffer.toString('utf8'), 'hello');
  assert.deepEqual(logo.tags, [{ name: 'Content-Type', value: 'image/png' }]);
});

test('preserves animated GIF bytes and content type for metadata upload', () => {
  const bytes = Buffer.from('GIF89a-animation-bytes', 'ascii');
  const logo = logoDataUrlToGenericFile(`data:image/gif;base64,${bytes.toString('base64')}`);

  assert.deepEqual(logo.buffer, bytes);
  assert.deepEqual(logo.tags, [{ name: 'Content-Type', value: 'image/gif' }]);
});

test('builds token metadata json from resolved image URI', () => {
  assert.deepEqual(tokenMetadataJson({
    name: 'Test Token',
    symbol: 'TEST',
    description: 'Launch description',
    imageUri: 'https://arweave.net/logo',
  }), {
    name: 'Test Token',
    symbol: 'TEST',
    description: 'Launch description',
    image: 'https://arweave.net/logo',
  });
});

test('uploads logo and metadata through an injected uploader', async () => {
  const calls = [];
  const progress = [];
  const umi = {
    uploader: {
      async upload(files) {
        calls.push(['upload', files[0].tags]);
        return ['https://arweave.net/logo'];
      },
      async uploadJson(metadata) {
        calls.push(['uploadJson', metadata]);
        return 'https://arweave.net/metadata';
      },
    },
  };

  const result = await uploadTokenMetadata({
    umi,
    logoBase64: 'data:image/jpeg;base64,aW1hZ2U=',
    name: 'Test Token',
    symbol: 'TEST',
    description: 'Launch description',
    onProgress: (event) => progress.push(event),
    logger: { log() {}, error() {} },
  });

  assert.equal(result.imageUri, 'https://arweave.net/logo');
  assert.equal(result.metadataUri, 'https://arweave.net/metadata');
  assert.equal(result.metadataHash, metadataDocumentHash(result.metadata));
  assert.deepEqual(calls, [
    ['upload', [{ name: 'Content-Type', value: 'image/jpeg' }]],
    ['uploadJson', {
      name: 'Test Token',
      symbol: 'TEST',
      description: 'Launch description',
      image: 'https://arweave.net/logo',
    }],
  ]);
  assert.deepEqual(progress, [
    { stage: 'logo_uploaded', imageUri: 'https://arweave.net/logo' },
    {
      stage: 'metadata_uploaded',
      metadataUri: 'https://arweave.net/metadata',
      imageUri: 'https://arweave.net/logo',
      metadataHash: result.metadataHash,
    },
  ]);
});

test('continues metadata upload with placeholder image when logo upload fails', async () => {
  const progress = [];
  const umi = {
    uploader: {
      async upload() {
        throw new Error('Irys unavailable');
      },
      async uploadJson(metadata) {
        assert.equal(metadata.image, PLACEHOLDER_TOKEN_IMAGE_URI);
        return 'https://arweave.net/metadata';
      },
    },
  };

  const result = await uploadTokenMetadata({
    umi,
    logoBase64: 'data:image/png;base64,aW1hZ2U=',
    name: 'Test Token',
    symbol: 'TEST',
    description: 'Launch description',
    onProgress: (event) => progress.push(event),
    logger: { log() {}, error() {} },
  });

  assert.equal(result.imageUri, PLACEHOLDER_TOKEN_IMAGE_URI);
  assert.equal(result.metadataUri, 'https://arweave.net/metadata');
  assert.deepEqual(progress, [
    { stage: 'logo_upload_failed', error: 'Irys unavailable' },
    {
      stage: 'metadata_uploaded',
      metadataUri: 'https://arweave.net/metadata',
      imageUri: PLACEHOLDER_TOKEN_IMAGE_URI,
      metadataHash: result.metadataHash,
    },
  ]);
});

test('uploads a generic sealed identity carrying only the final metadata commitment', async () => {
  const commitmentHash = 'a'.repeat(64);
  let uploaded = null;
  const progress = [];
  const result = await uploadSealedPlaceholderMetadata({
    umi: {
      uploader: {
        async uploadJson(metadata) {
          uploaded = metadata;
          return 'https://arweave.net/sealed';
        },
      },
    },
    commitmentHash,
    onProgress: (event) => progress.push(event),
    logger: { log() {} },
  });

  assert.equal(result.metadataUri, 'https://arweave.net/sealed');
  assert.equal(uploaded.name, SEALED_TOKEN_NAME);
  assert.equal(uploaded.symbol, SEALED_TOKEN_SYMBOL);
  assert.match(uploaded.description, new RegExp(commitmentHash));
  assert.deepEqual(progress, [{
    stage: 'sealed_metadata_prepared',
    onChainMetadataUri: 'https://arweave.net/sealed',
    metadataCommitment: commitmentHash,
  }]);
});
