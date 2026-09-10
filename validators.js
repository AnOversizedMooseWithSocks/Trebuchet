const TOKEN_DECIMALS = 9;
const U64_MAX = (1n << 64n) - 1n;
const TOKEN_RAW_MULTIPLIER = 10n ** BigInt(TOKEN_DECIMALS);

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

export function normalizeLogoImageMime(buffer) {
  const mime = detectLogoImageMime(buffer);
  if (!mime) throw new Error('Logo must be a PNG or JPG image');
  return mime;
}

// ---------------------------------------------------------------------------
// Logo dimension / size constraints
// ---------------------------------------------------------------------------
//
// The logo is embedded (base64) in the on-chain metadata JSON and in the
// launch-report HTML, both of which have hard size budgets — the report's
// sponsored Arweave upload caps at ~95KB total. A 1000×1000 photo blows
// straight through that, which is how "the logo doesn't show up in my
// report" happens: the oversized HTML gets skipped or the image gets
// dropped. Enforcing a 200×200 pixel ceiling (plus a byte cap for
// pathological files — a 200×200 JPEG can still carry megabytes of junk
// metadata) keeps every downstream consumer comfortably inside budget.
//
// Dimension parsing is done by hand from the file headers — PNG's IHDR and
// JPEG's SOF markers — rather than pulling in an image library: it's ~40
// lines of well-documented byte reads, and this app treats every new
// dependency as supply-chain surface.

export const LOGO_MAX_DIMENSION_PX = 200;
// Matches the frontend's MAX_LOGO_BYTES (preamble.js) and the Irys
// sponsored-upload budget the embedded copies must fit inside.
export const LOGO_MAX_BYTES = 100 * 1024;

/**
 * Read pixel dimensions from a PNG or JPEG buffer. Returns
 * { width, height } or throws if the structure can't be parsed.
 */
export function readImageDimensions(buffer) {
  const mime = detectLogoImageMime(buffer);
  if (mime === 'image/png') {
    // PNG layout: 8-byte signature, then the IHDR chunk: 4-byte length,
    // 4-byte type ('IHDR', verified by detectLogoImageMime), then the
    // data — width and height as big-endian uint32 at offsets 16 and 20.
    if (buffer.length < 24) throw new Error('PNG file is truncated');
    return {
      width: buffer.readUInt32BE(16),
      height: buffer.readUInt32BE(20),
    };
  }
  if (mime === 'image/jpeg') {
    // JPEG layout: a sequence of 0xFF-prefixed marker segments. Dimensions
    // live in the first Start-Of-Frame segment (SOF0..SOF15, excluding the
    // non-frame markers DHT/JPG/DAC = C4/C8/CC): 2-byte length, 1-byte
    // precision, then height and width as big-endian uint16.
    let offset = 2; // skip SOI (FF D8)
    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xff) {
        // Not positioned on a marker — corrupt or padding; step forward.
        offset += 1;
        continue;
      }
      const marker = buffer[offset + 1];
      if (marker === 0xff) { offset += 1; continue; } // fill byte
      if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) {
        offset += 2; // standalone markers with no length field
        continue;
      }
      const segLen = buffer.readUInt16BE(offset + 2);
      const isSof = marker >= 0xc0 && marker <= 0xcf
        && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isSof) {
        return {
          height: buffer.readUInt16BE(offset + 5),
          width: buffer.readUInt16BE(offset + 7),
        };
      }
      if (segLen < 2) throw new Error('JPEG file is corrupt (bad segment length)');
      offset += 2 + segLen;
    }
    throw new Error('JPEG file is corrupt (no frame header found)');
  }
  throw new Error('Logo must be a PNG or JPG image');
}

/**
 * Full logo validation: type, byte size, and pixel dimensions. Returns
 * { mime, width, height } on success; throws a user-readable error naming
 * the actual offending value otherwise. This is the AUTHORITATIVE check —
 * the frontend runs a friendlier copy of the same rule before upload, but
 * the server never trusts it.
 */
export function assertLogoConstraints(buffer, {
  maxDimension = LOGO_MAX_DIMENSION_PX,
  maxBytes = LOGO_MAX_BYTES,
} = {}) {
  const mime = normalizeLogoImageMime(buffer); // throws on wrong type
  if (buffer.length > maxBytes) {
    throw new Error(
      `Logo file is ${Math.ceil(buffer.length / 1024)}KB — the maximum is `
      + `${Math.floor(maxBytes / 1024)}KB. Export it at ${maxDimension}×${maxDimension} `
      + 'pixels or smaller and try again.',
    );
  }
  const { width, height } = readImageDimensions(buffer);
  if (!(width > 0) || !(height > 0)) {
    throw new Error('Logo image reports zero size — the file appears corrupt');
  }
  if (width > maxDimension || height > maxDimension) {
    throw new Error(
      `Logo is ${width}×${height} pixels — the maximum is `
      + `${maxDimension}×${maxDimension}. Resize it and try again.`,
    );
  }
  return { mime, width, height };
}
