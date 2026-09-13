#!/usr/bin/env node

import { spawn } from 'node:child_process';
import path from 'node:path';

const outputDir = path.resolve(process.argv[2] || 'artifacts/comprehensive-demo');
const musicPath = path.resolve(process.argv[3] || '');
if (!process.argv[3]) {
  throw new Error('usage: add-v2-walkthrough-bgm.mjs OUTPUT_DIR MUSIC_FILE');
}

const narratedVideo = path.join(outputDir, 'trebuchet-comprehensive-demo.mp4');
const finalVideo = path.join(outputDir, 'trebuchet-comprehensive-demo-with-bgm.mp4');
const ffmpeg = process.env.FFMPEG || '/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg';
const durationSeconds = 144.8;

const filter = [
  '[0:a]aformat=sample_rates=48000:channel_layouts=stereo,asplit=2[voice][key]',
  `[1:a]atrim=duration=${durationSeconds},asetpts=PTS-STARTPTS,loudnorm=I=-26:TP=-4:LRA=7,afade=t=in:st=0:d=2.2,afade=t=out:st=138.8:d=6[music]`,
  '[music][key]sidechaincompress=threshold=0.035:ratio=8:attack=18:release=420[ducked]',
  '[voice][ducked]amix=inputs=2:duration=longest:dropout_transition=0:normalize=0,loudnorm=I=-16:TP=-1.5:LRA=9,aresample=48000[mix]',
].join(';');

const args = [
  '-y',
  '-i', narratedVideo,
  '-i', musicPath,
  '-filter_complex', filter,
  '-map', '0:v:0',
  '-map', '[mix]',
  '-c:v', 'copy',
  '-c:a', 'aac',
  '-b:a', '256k',
  '-movflags', '+faststart',
  '-shortest',
  finalVideo,
];

await new Promise((resolve, reject) => {
  const child = spawn(ffmpeg, args, { stdio: 'inherit' });
  child.once('error', reject);
  child.once('exit', (code) => {
    if (code === 0) resolve();
    else reject(new Error(`ffmpeg exited with status ${code}`));
  });
});

console.log(finalVideo);
