#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

const outputDir = path.resolve(process.argv[2] || 'artifacts/comprehensive-demo');
const silentVideo = path.join(outputDir, 'trebuchet-complete-operations-walkthrough.mp4');
const manifestPath = path.join(outputDir, 'voiceover', 'manifest.json');
const finalVideo = path.join(outputDir, 'trebuchet-comprehensive-demo.mp4');
const ffmpeg = process.env.FFMPEG || '/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg';
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));

const tempoById = {
  'cli-boundary': 1.25,
  outro: 1.45,
};

const scheduled = [];
for (const segment of manifest.segments) {
  const tempo = tempoById[segment.id] || 1;
  const durationMs = segment.durationMs / tempo;
  const previous = scheduled.at(-1);
  const earliest = previous ? previous.startMs + previous.durationMs + 150 : 0;
  scheduled.push({
    ...segment,
    tempo,
    durationMs,
    startMs: Math.max(segment.startMs, earliest),
  });
}

const args = ['-y', '-i', silentVideo];
for (const segment of scheduled) args.push('-i', segment.path);

const filters = scheduled.map((segment, index) => {
  const source = `[${index + 1}:a]`;
  const tempo = segment.tempo === 1 ? '' : `atempo=${segment.tempo},`;
  return `${source}atrim=start=0,asetpts=PTS-STARTPTS,${tempo}highpass=f=70,lowpass=f=10500,acompressor=threshold=-20dB:ratio=2.2:attack=10:release=140,adelay=${Math.round(segment.startMs)}:all=1[a${index}]`;
});
filters.push(`${scheduled.map((_, index) => `[a${index}]`).join('')}amix=inputs=${scheduled.length}:duration=longest:dropout_transition=0:normalize=0,loudnorm=I=-16:TP=-1.5:LRA=9,aresample=48000,apad[mix]`);

args.push(
  '-filter_complex', filters.join(';'),
  '-map', '0:v:0',
  '-map', '[mix]',
  '-c:v', 'copy',
  '-c:a', 'aac',
  '-b:a', '192k',
  '-movflags', '+faststart',
  '-shortest',
  finalVideo,
);

await new Promise((resolve, reject) => {
  const child = spawn(ffmpeg, args, { stdio: 'inherit' });
  child.once('error', reject);
  child.once('exit', (code) => {
    if (code === 0) resolve();
    else reject(new Error(`ffmpeg exited with status ${code}`));
  });
});

console.log(finalVideo);
