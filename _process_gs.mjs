import fs from 'node:fs/promises';
import { createCanvas, Image } from 'canvas';
import { processVideo, probeVideo } from './videoProcessor.cjs';
import { applyKeying, measureAlphaHeight } from './src/lib/keying.js';

const input = 'D:/worktrees/末社-动作系统研究/assets/characters/wenning/raw/rift_devour_SE_auto_20260723_074827_001.mp4';
const output = 'D:/worktrees/末社-动作系统研究/assets/characters/wenning/raw/rift_devour_frames_proper.mp4';
const info = await probeVideo(input);
console.log('probe', JSON.stringify(info));

// First frame for height measurement
const { spawnSync } = await import('node:child_process');
const ffmpeg = (await import('ffmpeg-static')).default;
const raw = spawnSync(ffmpeg, ['-ss', '0', '-i', input, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'], { maxBuffer: info.width * info.height * 4 + 1024 * 1024 });
const firstFrame = { data: new Uint8ClampedArray(raw.stdout.buffer, raw.stdout.byteOffset, raw.stdout.byteLength), width: info.width, height: info.height };
const keying = { keyColor: [0, 255, 0], tolerance: 30, spillSuppression: 40, feather: 15, edgeShrink: 0 };
const keyed = applyKeying(firstFrame, keying);
const sourceCharacterHeight = measureAlphaHeight(keyed, 10);
console.log('sourceCharacterHeight', sourceCharacterHeight);

const params = {
  mode: 'greenscreen',
  keying,
  cleanup: {},
  layout: {
    canvasWidth: 256,
    canvasHeight: 256,
    personWidth: 160,
    personHeight: 160,
    autoCrop: true,
    sourceCenterAnchor: true,
    sourceCharacterHeight,
    anchor: 'feet',
  },
};

let lastPct = -1;
const result = await processVideo(input, output, params, (current, total) => {
  const pct = Math.floor(current / total * 100);
  if (pct >= lastPct + 10 || pct === 100) {
    lastPct = pct;
    console.log(`progress ${current}/${total} ${pct}%`);
  }
});
console.log(JSON.stringify({ output, sourceCharacterHeight, result }));
await fs.stat(output).then(s => console.log('output size', s.size));
