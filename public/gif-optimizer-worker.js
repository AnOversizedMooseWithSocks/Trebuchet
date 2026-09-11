'use strict';

const SOURCE_MAX_DIMENSION = 8192;
let codecPromise = null;

function loadCodecs(url) {
  if (!codecPromise) codecPromise = import(url);
  return codecPromise;
}

function gifDimensions(parsed) {
  return {
    width: Number(parsed?.lsd?.width || 0),
    height: Number(parsed?.lsd?.height || 0),
  };
}

function scaledDimensions(width, height, maxDimension) {
  const scale = Math.min(1, maxDimension / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

function newCanvas(width, height) {
  return new OffscreenCanvas(width, height);
}

function canvasContext(canvas) {
  const context = canvas.getContext('2d', { alpha: true, willReadFrequently: true });
  if (!context) throw new Error('Animated GIF compression is unavailable in this runtime');
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  return context;
}

function scaledFrameRect(dims, scaleX, scaleY) {
  const left = Math.round(Number(dims?.left || 0) * scaleX);
  const top = Math.round(Number(dims?.top || 0) * scaleY);
  const right = Math.round((Number(dims?.left || 0) + Number(dims?.width || 0)) * scaleX);
  const bottom = Math.round((Number(dims?.top || 0) + Number(dims?.height || 0)) * scaleY);
  return {
    left,
    top,
    width: Math.max(1, right - left),
    height: Math.max(1, bottom - top),
  };
}

function frameDelay(frame) {
  const delay = Number(frame?.delay || 100);
  return Math.max(20, Math.min(655350, Number.isFinite(delay) ? delay : 100));
}

function yieldToWorker() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function compositeSampledFrames(frames, sourceWidth, sourceHeight, width, height, stride) {
  const canvas = newCanvas(width, height);
  const context = canvasContext(canvas);
  const patchCanvas = newCanvas(1, 1);
  const patchContext = canvasContext(patchCanvas);
  const scaleX = width / sourceWidth;
  const scaleY = height / sourceHeight;
  const output = [];
  let previous = null;
  let pending = null;

  for (let index = 0; index < frames.length; index += 1) {
    const frame = frames[index];
    if (previous?.disposalType === 2) {
      const rect = scaledFrameRect(previous.dims, scaleX, scaleY);
      context.clearRect(rect.left, rect.top, rect.width, rect.height);
    } else if (previous?.disposalType === 3 && previous.restore) {
      context.putImageData(previous.restore, 0, 0);
    }

    const restore = Number(frame.disposalType) === 3
      ? context.getImageData(0, 0, width, height)
      : null;
    const frameWidth = Math.max(1, Number(frame?.dims?.width || 1));
    const frameHeight = Math.max(1, Number(frame?.dims?.height || 1));
    patchCanvas.width = frameWidth;
    patchCanvas.height = frameHeight;
    patchContext.clearRect(0, 0, frameWidth, frameHeight);
    const patchImage = patchContext.createImageData(frameWidth, frameHeight);
    patchImage.data.set(frame.patch);
    patchContext.putImageData(patchImage, 0, 0);
    const rect = scaledFrameRect(frame.dims, scaleX, scaleY);
    context.drawImage(
      patchCanvas,
      0,
      0,
      frameWidth,
      frameHeight,
      rect.left,
      rect.top,
      rect.width,
      rect.height,
    );

    if (index % stride === 0) {
      if (pending) output.push(pending);
      pending = {
        rgba: context.getImageData(0, 0, width, height).data,
        delay: frameDelay(frame),
      };
    } else if (pending) {
      pending.delay = Math.min(655350, pending.delay + frameDelay(frame));
    }

    previous = {
      disposalType: Number(frame.disposalType || 0),
      dims: frame.dims,
      restore,
    };
    if (index > 0 && index % 12 === 0) await yieldToWorker();
  }
  if (pending) output.push(pending);
  return output;
}

function paletteSample(renderedFrames, maxPixels = 80000) {
  const totalPixels = renderedFrames.reduce((sum, frame) => sum + (frame.rgba.length / 4), 0);
  const step = Math.max(1, Math.ceil(totalPixels / maxPixels));
  const samplePixels = Math.ceil(totalPixels / step);
  const sample = new Uint8ClampedArray(samplePixels * 4);
  let sourcePixel = 0;
  let targetPixel = 0;
  for (const frame of renderedFrames) {
    for (let offset = 0; offset < frame.rgba.length; offset += 4) {
      if (sourcePixel % step === 0) {
        sample[targetPixel * 4] = frame.rgba[offset];
        sample[targetPixel * 4 + 1] = frame.rgba[offset + 1];
        sample[targetPixel * 4 + 2] = frame.rgba[offset + 2];
        sample[targetPixel * 4 + 3] = frame.rgba[offset + 3];
        targetPixel += 1;
      }
      sourcePixel += 1;
    }
  }
  return targetPixel === samplePixels ? sample : sample.slice(0, targetPixel * 4);
}

function encodeFrames(codecs, renderedFrames, width, height, maxColors) {
  const format = 'rgba4444';
  const palette = codecs.quantize(paletteSample(renderedFrames), maxColors, {
    format,
    oneBitAlpha: 127,
    clearAlpha: true,
  });
  const transparentIndex = palette.findIndex((color) => Number(color?.[3]) <= 127);
  const colorDepth = Math.max(2, Math.ceil(Math.log2(Math.max(2, palette.length))));
  const gif = codecs.GIFEncoder();
  renderedFrames.forEach((frame, index) => {
    gif.writeFrame(codecs.applyPalette(frame.rgba, palette, format), width, height, {
      palette: index === 0 ? palette : undefined,
      delay: frame.delay,
      repeat: 0,
      transparent: transparentIndex >= 0,
      transparentIndex: Math.max(0, transparentIndex),
      dispose: 2,
      colorDepth,
    });
  });
  gif.finish();
  return gif.bytes();
}

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function compressionAttempts(width, height, frameCount, sourceBytes, maxBytes) {
  const sourceMax = Math.max(width, height);
  const nearLimit = sourceBytes <= maxBytes * 2.2;
  const targetFrames = nearLimit ? 28 : 16;
  const estimatedScale = Math.sqrt((maxBytes / sourceBytes) * (frameCount / targetFrames));
  const initialDimension = nearLimit
    ? Math.min(sourceMax, 384)
    : clamp(Math.round(sourceMax * estimatedScale * 1.2), 112, Math.min(sourceMax, 256));
  const initialColors = nearLimit ? 64 : 32;
  const ladder = [
    [initialDimension, initialColors, targetFrames],
    [Math.round(initialDimension * 0.9), 24, Math.max(12, targetFrames - 2)],
    [Math.round(initialDimension * 0.8), 24, Math.max(10, targetFrames - 4)],
    [Math.round(initialDimension * 0.7), 20, Math.max(9, targetFrames - 6)],
    [128, 20, 12],
    [112, 16, 10],
    [96, 16, 9],
    [80, 16, 8],
    [64, 16, 6],
  ];
  const seen = new Set();
  return ladder.map(([maxDimension, maxColors, maxFrames]) => {
    const boundedDimension = Math.min(sourceMax, Math.max(64, maxDimension));
    const stride = Math.max(1, Math.ceil(frameCount / maxFrames));
    const key = `${boundedDimension}:${maxColors}:${stride}`;
    if (seen.has(key)) return null;
    seen.add(key);
    return { maxDimension: boundedDimension, maxColors, stride };
  }).filter(Boolean);
}

async function optimize(payload) {
  const codecs = await loadCodecs(payload.codecUrl);
  const parsed = codecs.parseGIF(payload.buffer);
  const source = gifDimensions(parsed);
  if (!source.width || !source.height) throw new Error('Animated GIF dimensions could not be read');
  if (source.width > SOURCE_MAX_DIMENSION || source.height > SOURCE_MAX_DIMENSION) {
    throw new Error(`Animated GIF dimensions must be ${SOURCE_MAX_DIMENSION}x${SOURCE_MAX_DIMENSION}px or smaller`);
  }
  if (source.width < payload.minDimension || source.height < payload.minDimension) {
    throw new Error(`Logo is ${source.width}x${source.height}px; minimum is ${payload.minDimension}x${payload.minDimension}px`);
  }
  if (
    payload.sourceBytes <= payload.maxBytes
    && source.width <= payload.maxDimension
    && source.height <= payload.maxDimension
  ) {
    return {
      bytes: null,
      width: source.width,
      height: source.height,
      compressed: false,
      originalSizeBytes: payload.sourceBytes,
    };
  }

  const frames = codecs.decompressFrames(parsed, true).filter((frame) => frame?.patch?.length);
  if (!frames.length) throw new Error('Animated GIF contains no readable frames');
  let smallest = null;
  const attempts = compressionAttempts(
    source.width,
    source.height,
    frames.length,
    payload.sourceBytes,
    payload.maxBytes,
  ).filter((attempt) => {
    const dims = scaledDimensions(source.width, source.height, attempt.maxDimension);
    return dims.width >= payload.minDimension && dims.height >= payload.minDimension;
  });

  for (let index = 0; index < attempts.length; index += 1) {
    const attempt = attempts[index];
    const dims = scaledDimensions(source.width, source.height, attempt.maxDimension);
    self.postMessage({ id: payload.id, progress: Math.round((index / attempts.length) * 90) + 5 });
    const rendered = await compositeSampledFrames(
      frames,
      source.width,
      source.height,
      dims.width,
      dims.height,
      attempt.stride,
    );
    const bytes = encodeFrames(codecs, rendered, dims.width, dims.height, attempt.maxColors);
    const result = {
      bytes,
      width: dims.width,
      height: dims.height,
      frameCount: rendered.length,
      originalFrameCount: frames.length,
    };
    if (!smallest || bytes.byteLength < smallest.bytes.byteLength) smallest = result;
    if (bytes.byteLength <= payload.maxBytes) return {
      ...result,
      compressed: true,
      originalSizeBytes: payload.sourceBytes,
    };
    await yieldToWorker();
  }

  const smallestKb = smallest ? Math.ceil(smallest.bytes.byteLength / 1024) : null;
  throw new Error(
    smallestKb
      ? `Animated GIF reached ${smallestKb}KB at minimum quality; use a shorter animation`
      : 'Animated GIF could not be compressed below 100KB',
  );
}

self.onmessage = async (event) => {
  const payload = event.data;
  try {
    const result = await optimize(payload);
    const transfer = result.bytes ? [result.bytes.buffer] : [];
    self.postMessage({ id: payload.id, ok: true, result }, transfer);
  } catch (error) {
    self.postMessage({ id: payload.id, ok: false, error: error?.message || 'Animated GIF compression failed' });
  }
};
