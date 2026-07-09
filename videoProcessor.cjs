/**
 * 视频处理管线
 *
 * 流程：ffprobe 探测 → ffmpeg 逐帧提取 raw RGBA → JS 抠像+裁剪+缩放合成 → ffmpeg 编码
 *
 * 支持输出：
 *   - webm: VP9 + alpha (透明背景)
 *   - mov: ProRes 4444 + alpha (透明背景)
 *   - mp4: H.264 绿幕合成 (不透明)
 */

const { spawn, spawnSync } = require('child_process');
const { createCanvas, Image } = require('canvas');
const fs = require('fs');
const path = require('path');
const os = require('os');

/**
 * 解析 ffmpeg / ffprobe 实际可执行路径
 * - 打包后的 Electron:ffmpeg-static / ffprobe-static 位于 extraResources 目录
 * - 开发模式:从 node_modules 里取
 */
function resolveFfmpeg() {
  // 1. 优先用 ffmpeg-static(开发模式)
  try {
    const p = require('ffmpeg-static');
    if (p && fs.existsSync(p)) return p;
  } catch (e) {}

  // 2. 打包模式:resources/bin/ffmpeg.exe
  const packaged = path.join(process.resourcesPath || '', 'bin', 'ffmpeg.exe');
  if (fs.existsSync(packaged)) return packaged;

  // 3. 退回系统 PATH
  return 'ffmpeg';
}

function resolveFfprobe() {
  try {
    const mod = require('ffprobe-static');
    const p = mod.path || mod;
    if (p && fs.existsSync(p)) return p;
  } catch (e) {}

  const packaged = path.join(process.resourcesPath || '', 'bin', 'ffprobe.exe');
  if (fs.existsSync(packaged)) return packaged;

  return 'ffprobe';
}

const FFMPEG = resolveFfmpeg();
const FFPROBE = resolveFfprobe();

console.log(`  🎬 ffmpeg: ${FFMPEG}`);
console.log(`  🎬 ffprobe: ${FFPROBE}`);

// 动态加载共享算法
let applyKeying, composeToCanvas, autoCropKeyed;

async function loadAlgorithms() {
  if (!applyKeying) {
    const mod = await import('./src/lib/keying.js');
    applyKeying = mod.applyKeying;
    composeToCanvas = mod.composeToCanvas;
    autoCropKeyed = mod.autoCropKeyed;
  }
}

/**
 * 用 ffprobe 获取视频信息
 */
function probeVideo(videoPath) {
  return new Promise((resolve, reject) => {
    const ffprobe = spawn(FFPROBE, [
      '-v', 'quiet',
      '-print_format', 'json',
      '-show_streams',
      '-show_format',
      videoPath
    ]);

    let stdout = '', stderr = '';
    ffprobe.stdout.on('data', d => stdout += d);
    ffprobe.stderr.on('data', d => stderr += d);
    ffprobe.on('close', code => {
      if (code !== 0) return reject(new Error(`ffprobe failed: ${stderr}`));
      try {
        const info = JSON.parse(stdout);
        const vStream = info.streams.find(s => s.codec_type === 'video');
        const aStream = info.streams.find(s => s.codec_type === 'audio');
        resolve({
          width: parseInt(vStream.width),
          height: parseInt(vStream.height),
          fps: eval(vStream.r_frame_rate), // "30/1" → 30
          frameCount: parseInt(vStream.nb_frames) || null,
          duration: parseFloat(info.format.duration),
          hasAudio: !!aStream,
          videoCodec: vStream.codec_name,
        });
      } catch (e) {
        reject(new Error(`ffprobe parse error: ${e.message}`));
      }
    });
  });
}

/**
 * 处理视频：逐帧抠像 + 标准化重排 + 编码输出
 *
 * @param {string} inputPath - 输入视频路径
 * @param {string} outputPath - 输出视频路径
 * @param {Object} params - { keying, layout, mode, range? }
 *   mode: 'transparent' | 'greenscreen'
 *   range?: { startFrame: number, endFrame: number } 帧范围（可选，默认全视频）
 * @param {Function} onProgress - (current, total) => void
 * @returns {Promise<Object>} 处理结果
 */
async function processVideo(inputPath, outputPath, params, onProgress) {
  await loadAlgorithms();

  const { keying, layout, mode, range } = params;
  const { canvasWidth, canvasHeight } = layout;

  // 1. 探测视频
  const info = await probeVideo(inputPath);
  const { width: srcW, height: srcH, fps, duration, hasAudio } = info;
  const totalFrames = info.frameCount || Math.round(fps * duration);

  // 计算帧范围
  const startFrame = range?.startFrame ?? 0;
  const endFrame = range?.endFrame ?? totalFrames;
  const processFrameCount = endFrame - startFrame;
  const startTime = startFrame / fps;
  const rangeDuration = processFrameCount / fps;

  const hasRange = startFrame > 0 || endFrame < totalFrames;
  const rangeDesc = hasRange ? ` [${startFrame}–${endFrame}帧, ${processFrameCount}帧]` : '';

  console.log(`  📹 视频信息: ${srcW}×${srcH} @ ${fps}fps, ${duration.toFixed(1)}s, ${totalFrames} frames, audio=${hasAudio}${rangeDesc}`);

  // 2. 临时文件：提取的原始音频
  const tmpDir = path.join(os.tmpdir(), 'greenscreen-studio');
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
  // ffmpeg 在 Windows 上对反斜杠路径处理不稳定，统一用正斜杠
  const audioPath = path.join(tmpDir, `audio_${Date.now()}.m4a`).replace(/\\/g, '/');

  // 3. 提取音频（如果有）— 如果指定了范围，同时裁剪音频
  let audioExtracted = false;
  if (hasAudio) {
    const audioArgs = [
      ...(hasRange ? ['-ss', String(startTime)] : []),
      '-i', inputPath,
      '-vn', '-acodec', 'aac',
      '-b:a', '192k',
      ...(hasRange ? ['-t', String(rangeDuration)] : []),
      '-y', audioPath
    ];
    await new Promise((resolve, reject) => {
      const ffmpeg = spawn(FFMPEG, audioArgs);
      ffmpeg.stderr.on('data', () => {});
      ffmpeg.on('close', code => {
        audioExtracted = code === 0 && fs.existsSync(audioPath);
        resolve();
      });
      ffmpeg.on('error', reject);
    });
  }

  // 4. 启动 ffmpeg 提取帧（raw RGBA pipe）
  //    如果指定了范围，用 -ss 快速定位 + -frames:v 限制输出帧数
  const extractArgs = [
    ...(hasRange ? ['-ss', String(startTime)] : []),
    '-i', inputPath,
    '-f', 'rawvideo',
    '-pix_fmt', 'rgba',
    ...(hasRange ? ['-frames:v', String(processFrameCount)] : []),
    '-'
  ];
  const extractor = spawn(FFMPEG, extractArgs);

  // 5. 启动 ffmpeg 编码器（接收 raw RGBA pipe → 编码输出）
  const { encoderArgs, outputFormat } = buildEncoderArgs(outputPath, mode, layout, fps, audioExtracted ? audioPath : null);
  const encoder = spawn(FFMPEG, encoderArgs);

  extractor.stderr.on('data', () => {});
  encoder.stderr.on('data', d => {
    const text = d.toString();
    console.log(`  [encoder] ${text.trim().slice(0, 200)}`);
    // 解析进度（encoder 报告的帧号，以 processFrameCount 为总数）
    const match = text.match(/frame=\s*(\d+)/);
    if (match && onProgress) {
      onProgress(parseInt(match[1]), processFrameCount);
    }
  });

  // 防止 encoder.stdin 的 error 事件导致进程崩溃
  encoder.stdin.on('error', (e) => {
    if (!pipelineError) pipelineError = e;
  });
  encoder.on('error', (e) => {
    if (!pipelineError) pipelineError = e;
  });

  // 6. 逐帧处理管道
  const frameSize = srcW * srcH * 4; // RGBA
  const srcBuffer = Buffer.alloc(frameSize);

  let frameIndex = 0;
  let bytesBuffered = 0;
  let pipelineError = null;
  let encoderClosed = false;

  encoder.on('close', (code) => {
    encoderClosed = true;
  });

  return new Promise((resolve, reject) => {
    extractor.stdout.on('data', chunk => {
      if (pipelineError || encoderClosed) return;

      // 将 chunk 填入帧缓冲
      let offset = 0;
      while (offset < chunk.length) {
        const remaining = frameSize - bytesBuffered;
        const toCopy = Math.min(remaining, chunk.length - offset);
        chunk.copy(srcBuffer, bytesBuffered, offset, offset + toCopy);
        bytesBuffered += toCopy;
        offset += toCopy;

        // 一帧完整了，处理它
        if (bytesBuffered === frameSize) {
          if (encoderClosed || pipelineError) return;
          try {
            const processedFrame = processFrame(srcBuffer, srcW, srcH, keying, layout, mode);
            encoder.stdin.write(processedFrame);
          } catch (e) {
            if (!pipelineError) pipelineError = e;
            return;
          }
          bytesBuffered = 0;
          frameIndex++;

          if (frameIndex % 30 === 0 && onProgress) {
            onProgress(frameIndex, processFrameCount);
          }
        }
      }
    });

    extractor.on('close', () => {
      // 处理最后一帧（如果有残余数据）
      if (!encoderClosed && !pipelineError && bytesBuffered > 0 && bytesBuffered >= frameSize) {
        try {
          const processedFrame = processFrame(srcBuffer, srcW, srcH, keying, layout, mode);
          encoder.stdin.write(processedFrame);
          frameIndex++;
        } catch (e) {
          if (!pipelineError) pipelineError = e;
        }
      }
      if (!encoderClosed) {
        encoder.stdin.end();
      }
    });

    extractor.on('error', e => { if (!pipelineError) pipelineError = e; });

    encoder.on('close', code => {
      // 清理临时音频
      if (audioExtracted) {
        try { fs.unlinkSync(audioPath); } catch (e) {}
      }

      if (pipelineError) return reject(pipelineError);
      if (code !== 0) return reject(new Error(`ffmpeg encoder exited with code ${code}`));

      onProgress && onProgress(processFrameCount, processFrameCount);
      resolve({
        frameCount: frameIndex,
        duration: rangeDuration || duration,
        fps: fps,
        outputSize: fs.existsSync(outputPath) ? fs.statSync(outputPath).size : 0,
        range: hasRange ? { startFrame, endFrame, processFrameCount } : null,
      });
    });

    encoder.on('error', e => { pipelineError = e; reject(e); });
  });
}

/**
 * 处理单帧：提取 → 抠像 → 裁剪 → 合成 → 输出 raw RGBA
 */
function processFrame(srcBuffer, srcW, srcH, keying, layout, mode) {
  // 从 raw buffer 构建 ImageData-like 对象
  const srcData = {
    data: new Uint8ClampedArray(srcBuffer),
    width: srcW,
    height: srcH,
  };

  // 抠像
  let keyed = applyKeying(srcData, keying);

  // 自动裁剪
  if (layout.autoCrop !== false) {
    keyed = autoCropKeyed(keyed);
  }

  const { canvasWidth, canvasHeight } = layout;

  if (mode === 'transparent') {
    // 透明模式：输出画布是透明的，只画人物
    const canvas = createCanvas(canvasWidth, canvasHeight);
    const ctx = canvas.getContext('2d');
    // 画布默认透明，不需要填绿底

    // 等比缩放人物到 personWidth×personHeight，居中
    const tempCanvas = createCanvas(keyed.width, keyed.height);
    const tempCtx = tempCanvas.getContext('2d');
    const tempImgData = tempCtx.createImageData(keyed.width, keyed.height);
    tempImgData.data.set(keyed.data);
    tempCtx.putImageData(tempImgData, 0, 0);

    const { personWidth, personHeight } = layout;
    const scale = Math.min(personWidth / keyed.width, personHeight / keyed.height);
    const sw = Math.round(keyed.width * scale);
    const sh = Math.round(keyed.height * scale);
    const ox = Math.round((canvasWidth - sw) / 2);
    const oy = Math.round((canvasHeight - sh) / 2);
    ctx.drawImage(tempCanvas, ox, oy, sw, sh);

    // 输出 raw RGBA
    const outImageData = ctx.getImageData(0, 0, canvasWidth, canvasHeight);
    return Buffer.from(outImageData.data);
  } else {
    // 绿幕合成模式
    const canvas = createCanvas(canvasWidth, canvasHeight);
    const ctx = canvas.getContext('2d');
    const tempCanvas = createCanvas(keyed.width, keyed.height);
    composeToCanvas(ctx, keyed, layout, tempCanvas);

    const outImageData = ctx.getImageData(0, 0, canvasWidth, canvasHeight);
    return Buffer.from(outImageData.data);
  }
}

/**
 * 构建 ffmpeg 编码器参数
 */
function buildEncoderArgs(outputPath, mode, layout, fps, audioPath) {
  const { canvasWidth, canvasHeight } = layout;
  const fpsStr = fps.toString();
  const args = [
    // 输入：raw RGBA from stdin
    '-f', 'rawvideo',
    '-pix_fmt', 'rgba',
    '-s', `${canvasWidth}x${canvasHeight}`,
    '-r', fpsStr,
    '-i', '-',
  ];

  // 音频输入
  if (audioPath) {
    args.push('-i', audioPath);
  }

  if (mode === 'transparent') {
    const ext = path.extname(outputPath).toLowerCase();
    if (ext === '.webm') {
      // VP9 + alpha
      args.push(
        '-c:v', 'libvpx-vp9',
        '-pix_fmt', 'yuva420p',
        '-b:v', '0', '-crf', '35',
        '-row-mt', '1',
        '-auto-alt-ref', '0',  // alpha 需要关闭此选项
      );
    } else if (ext === '.mov') {
      // ProRes 4444 + alpha
      args.push(
        '-c:v', 'prores_ks',
        '-profile:v', '4',     // ProRes 4444
        '-pix_fmt', 'yuva444p10le',
        '-vendor', 'ap10',
        '-bits_per_mb', '8000',
      );
    }
  } else {
    // 绿幕合成模式（不透明）
    const ext = path.extname(outputPath).toLowerCase();
    if (ext === '.webm') {
      args.push('-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', '32', '-pix_fmt', 'yuv420p');
    } else {
      args.push('-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p');
    }
  }

  // 音频编码（根据容器格式选择）
  if (audioPath) {
    const ext = path.extname(outputPath).toLowerCase();
    if (ext === '.webm') {
      // WebM 只支持 Vorbis 或 Opus
      args.push('-c:a', 'libopus', '-b:a', '192k', '-shortest');
    } else {
      // MP4 / MOV 用 AAC
      args.push('-c:a', 'aac', '-b:a', '192k', '-shortest');
    }
  }

  args.push('-y', outputPath);
  return { encoderArgs: args, outputFormat: path.extname(outputPath) };
}

/**
 * 从视频中找与起始帧相似的循环终点帧候选列表
 *
 * 将帧缩略到 thumbSize×thumbSize 后逐像素比较 RGB，
 * 用局部极小值检测 + 最小间距过滤，返回多个有间隔的最佳候选。
 *
 * @param {string} inputPath - 输入视频路径
 * @param {number} startFrame - 起始帧号
 * @param {number} fps - 视频帧率
 * @param {number} totalFrames - 视频总帧数
 * @param {Object} [options]
 * @param {number} [options.maxSearch=300] - 最大向后搜索帧数
 * @param {number} [options.step=2] - 每隔 step 帧检查一次（兼顾速度与精度）
 * @param {number} [options.thumbSize=64] - 缩略图尺寸
 * @param {number} [options.minSpacing=12] - 候选帧之间最小帧间距（避免扎堆，默认 ~0.4s@30fps）
 * @param {number} [options.maxCandidates=5] - 最多返回多少个候选
 * @returns {Promise<{candidates: Array<{frame:number,score:number}>, scores: Array<{frame:number,score:number}>}>}
 */
function findLoopEndFrame(inputPath, startFrame, fps, totalFrames, options = {}) {
  const {
    maxSearch = 300,
    step = 2,
    thumbSize = 32,
    minSpacing = 12,
    maxCandidates = 5
  } = options;
  const endSearch = Math.min(startFrame + maxSearch, totalFrames);
  const searchCount = Math.floor((endSearch - startFrame - 1) / step);
  const frameBytes = thumbSize * thumbSize * 4;

  if (searchCount <= 0) {
    return Promise.resolve({
      candidates: [],
      scores: [],
      message: '搜索范围过小'
    });
  }

  return new Promise((resolve, reject) => {
    // 1. 提取起始帧 — 用双 -ss 保证帧精确
    //    -ss <近似的> -i input -ss <精确微调> : 先快跳到附近，再精确解码到目标帧
    const preRoll = Math.min(1.0, startFrame / fps / 2); // 最多回退 1s
    const fineSeek = preRoll;
    const startArgs = [
      '-ss', String(Math.max(0, startFrame / fps - preRoll)),
      '-i', inputPath,
      '-ss', String(fineSeek),
      '-vf', `scale=${thumbSize}:${thumbSize}`,
      '-f', 'rawvideo',
      '-pix_fmt', 'rgba',
      '-frames:v', '1',
      '-'
    ];
    const startProc = spawn(FFMPEG, startArgs);
    let startBuf = Buffer.alloc(0);
    let startErr = '';

    startProc.stdout.on('data', d => { startBuf = Buffer.concat([startBuf, d]); });
    startProc.stderr.on('data', d => { startErr += d.toString(); });
    startProc.on('close', code => {
      if (code !== 0 || startBuf.length < frameBytes) {
        return reject(new Error(`提取起始帧失败: ${startErr.slice(0, 200)}`));
      }

      const reference = new Uint8Array(startBuf.subarray(0, frameBytes));

      // 2. 扫描后续帧 — 同样双 -ss 保证每帧精确
      const scanStartTime = (startFrame + step) / fps;
      const scanPreRoll = Math.min(1.0, scanStartTime / 2);
      const scanArgs = [
        '-ss', String(Math.max(0, scanStartTime - scanPreRoll)),
        '-i', inputPath,
        '-ss', String(scanPreRoll),
        '-vf', `scale=${thumbSize}:${thumbSize}`,
        '-f', 'rawvideo',
        '-pix_fmt', 'rgba',
        '-frames:v', String(searchCount),
        '-'
      ];
      const scanProc = spawn(FFMPEG, scanArgs);
      let scanBuf = Buffer.alloc(0);
      let scanErr = '';

      scanProc.stdout.on('data', d => { scanBuf = Buffer.concat([scanBuf, d]); });
      scanProc.stderr.on('data', d => { scanErr += d.toString(); });
      scanProc.on('close', () => {
        const scores = [];

        const total = Math.min(searchCount, Math.floor(scanBuf.length / frameBytes));
        for (let i = 0; i < total; i++) {
          const offset = i * frameBytes;
          const candidate = new Uint8Array(scanBuf.subarray(offset, offset + frameBytes));
          // 用直方图差异代替像素级对比，对微小平移更鲁棒
          const score = histogramDiff(reference, candidate);
          const frameNum = startFrame + (i + 1) * step;
          scores.push({ frame: frameNum, score });
        }

        // 3. 从 scores 中筛选最佳候选
        const candidates = pickLoopCandidates(scores, { minSpacing, maxCandidates });

        resolve({ candidates, scores });
      });
      scanProc.on('error', reject);
    });
    startProc.on('error', reject);
  });
}

/**
 * 从相似度分数数组中，用「局部极小值 + 最小间距」筛选出最佳候选帧。
 *
 * 策略：
 *   a) 找出所有局部极小值（比左右相邻更相似的帧）
 *   b) 按相似度排序（分数越低越相似）
 *   c) 用最小间距去重，避免扎堆推荐同一画面附近的多帧
 *   d) 返回最多 maxCandidates 个候选，按帧号排序
 *
 * @param {Array<{frame:number,score:number}>} scores
 * @param {Object} options
 * @param {number} options.minSpacing - 最小帧间距
 * @param {number} options.maxCandidates - 最多返回几个
 * @returns {Array<{frame:number,score:number}>}
 */
function pickLoopCandidates(scores, { minSpacing, maxCandidates }) {
  if (scores.length === 0) return [];

  // a) 找局部极小值
  const localMinima = [];
  for (let i = 1; i < scores.length - 1; i++) {
    const prev = scores[i - 1];
    const cur = scores[i];
    const next = scores[i + 1];
    // cur 比左右都低（或相等），就是局部极小值
    if (cur.score <= prev.score && cur.score <= next.score) {
      // 避免平坦区域的连续等同帧全部入选：只取中间的那个
      localMinima.push(cur);
    }
  }

  // 如果没有任何局部极小值（单调递增或递减），回退到全局最低
  const pool = localMinima.length > 0 ? localMinima : scores;

  // b) 按相似度排序（低分在前）
  const sorted = [...pool].sort((a, b) => a.score - b.score);

  // c) 贪心选择：拿最高分（最低 diff）的，筛掉太近的
  const selected = [];
  for (const cand of sorted) {
    const tooClose = selected.some(s => Math.abs(s.frame - cand.frame) < minSpacing);
    if (!tooClose) {
      selected.push(cand);
      if (selected.length >= maxCandidates) break;
    }
  }

  // d) 按帧号排序返回
  return selected.sort((a, b) => a.frame - b.frame);
}

/**
 * 用颜色直方图比较两帧的感知相似度（越低越相似）
 *
 * 将每帧的 RGB 像素分到 4×4×4=64 个 bin 中，
 * 用卡方距离测量直方图差异。对物体的微小平移、
 * 抖动不敏感，更适合找视觉上相似的循环帧。
 *
 * 返回卡方距离 (0 ~ 正无穷)，典型值 < 20 为非常相似，
 * < 50 为较相似，> 200 为差异很大。
 */
function histogramDiff(a, b) {
  const BINS = 4;          // 每通道 4 个 bin → 4×4×4 = 64
  const STEP = 256 / BINS; // 64
  const totalBins = BINS * BINS * BINS;

  const histA = new Float64Array(totalBins);
  const histB = new Float64Array(totalBins);

  const pixelCount = a.length / 4;

  for (let i = 0; i < a.length; i += 4) {
    // 跳过 Alpha 通道 (i+3)
    const rA = Math.min(Math.floor(a[i] / STEP), BINS - 1);
    const gA = Math.min(Math.floor(a[i + 1] / STEP), BINS - 1);
    const bA = Math.min(Math.floor(a[i + 2] / STEP), BINS - 1);
    histA[rA * BINS * BINS + gA * BINS + bA]++;

    const rB = Math.min(Math.floor(b[i] / STEP), BINS - 1);
    const gB = Math.min(Math.floor(b[i + 1] / STEP), BINS - 1);
    const bB = Math.min(Math.floor(b[i + 2] / STEP), BINS - 1);
    histB[rB * BINS * BINS + gB * BINS + bB]++;
  }

  // 归一化到 [0, 1]（除以像素数）
  for (let i = 0; i < totalBins; i++) {
    histA[i] /= pixelCount;
    histB[i] /= pixelCount;
  }

  // 卡方距离: Σ (A-B)² / (A+B+ε)
  let chi2 = 0;
  for (let i = 0; i < totalBins; i++) {
    const sum = histA[i] + histB[i];
    if (sum > 1e-10) {
      const diff = histA[i] - histB[i];
      chi2 += (diff * diff) / sum;
    }
  }

  return chi2;
}

module.exports = { processVideo, probeVideo, findLoopEndFrame };
