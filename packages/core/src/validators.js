const TOKEN_DECIMALS = 9;
const U64_MAX = (1n << 64n) - 1n;
const TOKEN_RAW_MULTIPLIER = 10n ** BigInt(TOKEN_DECIMALS);
const BASE58_CHARS = new Set('123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz');
const JPEG_SOF_MARKERS = new Set([
  0xc0,
  0xc1,
  0xc2,
  0xc3,
  0xc5,
  0xc6,
  0xc7,
  0xc9,
  0xca,
  0xcb,
  0xcd,
  0xce,
  0xcf,
]);

function byteLength(s) {
  return Buffer.byteLength(String(s), 'utf8');
}

export function normalizeTokenName(value) {
  const name = String(value ?? '').trim();
  if (!name) throw new Error('Token name is required');
  if (byteLength(name) > 32) {
    throw new Error('Token name must be 32 UTF-8 bytes or fewer');
  }
  return name;
}

export function normalizeTokenSymbol(value) {
  const symbol = String(value ?? '').trim();
  if (!symbol) throw new Error('Token symbol is required');
  if (byteLength(symbol) > 10) {
    throw new Error('Token symbol must be 10 UTF-8 bytes or fewer');
  }
  return symbol;
}

export function normalizeTokenDescription(value) {
  const description = String(value ?? '').trim();
  if (byteLength(description) > 1000) {
    throw new Error('Token description must be 1000 UTF-8 bytes or fewer');
  }
  return description;
}

export function normalizeWholeTokenSupply(value, decimals = TOKEN_DECIMALS) {
  const raw = String(value ?? '').trim().replace(/,/g, '');
  if (!/^[1-9]\d*$/.test(raw)) {
    throw new Error('Total supply must be a positive whole number');
  }

  const whole = BigInt(raw);
  const multiplier = 10n ** BigInt(decimals);
  const rawSupply = whole * multiplier;
  if (rawSupply > U64_MAX) {
    const maxWhole = U64_MAX / multiplier;
    throw new Error(
      `Total supply is too large for an SPL mint with ${decimals} decimals; ` +
        `maximum whole-token supply is ${maxWhole.toString()}`,
    );
  }

  return raw;
}

export function invalidBase58Characters(value) {
  return [...new Set([...String(value ?? '')].filter((ch) => !BASE58_CHARS.has(ch)))];
}

export function normalizeVanityTargetBase58(prefixValue = '', suffixValue = '') {
  const prefix = String(prefixValue ?? '').trim();
  const suffix = String(suffixValue ?? '').trim();
  const invalid = invalidBase58Characters(`${prefix}${suffix}`);
  if (invalid.length) {
    throw new Error(
      `Vanity CA target contains invalid Base58 character${invalid.length === 1 ? '' : 's'}: ${invalid.join(', ')}`,
    );
  }
  return { prefix, suffix };
}

export function detectLogoImageMime(buffer) {
  if (!Buffer.isBuffer(buffer)) return null;

  const isPng =
    buffer.length >= 24 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a &&
    buffer.toString('ascii', 12, 16) === 'IHDR';
  if (isPng) return 'image/png';

  const isJpeg =
    buffer.length >= 4 &&
    buffer[0] === 0xff &&
    buffer[1] === 0xd8 &&
    buffer[2] === 0xff;
  if (isJpeg) return 'image/jpeg';

  return null;
}

function pngImageDimensions(buffer) {
  if (detectLogoImageMime(buffer) !== 'image/png') return null;
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  if (width <= 0 || height <= 0) return null;
  return { width, height };
}

function jpegImageDimensions(buffer) {
  if (detectLogoImageMime(buffer) !== 'image/jpeg') return null;

  let offset = 2;
  while (offset < buffer.length) {
    while (offset < buffer.length && buffer[offset] === 0xff) offset += 1;
    if (offset >= buffer.length) return null;

    const marker = buffer[offset];
    offset += 1;

    if (marker === 0xd9 || marker === 0xda) return null;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > buffer.length) return null;

    const segmentLength = buffer.readUInt16BE(offset);
    if (segmentLength < 2 || offset + segmentLength > buffer.length) return null;

    if (JPEG_SOF_MARKERS.has(marker)) {
      if (segmentLength < 7) return null;
      const height = buffer.readUInt16BE(offset + 3);
      const width = buffer.readUInt16BE(offset + 5);
      if (width <= 0 || height <= 0) return null;
      return { width, height };
    }

    offset += segmentLength;
  }

  return null;
}

export function detectLogoImageDimensions(buffer) {
  const mime = detectLogoImageMime(buffer);
  if (mime === 'image/png') return pngImageDimensions(buffer);
  if (mime === 'image/jpeg') return jpegImageDimensions(buffer);
  return null;
}

export function normalizeLogoImageMime(buffer) {
  const mime = detectLogoImageMime(buffer);
  if (!mime) throw new Error('Logo must be a PNG or JPG image');
  return mime;
}
