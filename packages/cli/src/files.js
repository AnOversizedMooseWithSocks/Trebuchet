import { open, readFile, rename, stat, unlink } from 'node:fs/promises';
import path from 'node:path';

const MAX_INPUT_BYTES = 10 * 1024 * 1024;

export async function readJsonFile(filePath, label = 'JSON input') {
  if (!filePath) throw new TypeError(`${label} path is required.`);
  const inputPath = path.resolve(filePath);
  const inputStat = await stat(inputPath);
  if (!inputStat.isFile()) throw new TypeError(`${label} must be a regular file.`);
  if (inputStat.size > MAX_INPUT_BYTES) throw new TypeError(`${label} exceeds the 10 MB input limit.`);
  const text = await readFile(inputPath, 'utf8');
  try {
    return { path: inputPath, value: JSON.parse(text) };
  } catch (error) {
    throw new TypeError(`${label} is not valid JSON: ${error.message}`);
  }
}

export async function writeJsonFileAtomic(filePath, value) {
  if (!filePath) throw new TypeError('Output path is required.');
  const outputPath = path.resolve(filePath);
  const temporaryPath = path.join(
    path.dirname(outputPath),
    `.${path.basename(outputPath)}.${process.pid}.${Date.now()}.tmp`,
  );
  let handle;
  try {
    handle = await open(temporaryPath, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporaryPath, outputPath);
    return outputPath;
  } catch (error) {
    await handle?.close().catch(() => {});
    await unlink(temporaryPath).catch(() => {});
    throw error;
  }
}
