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
 * 从视频中找与起始帧最相似的循环终点帧
 *
 * 将帧缩略到 thumbSize×thumbSize 后逐像素比较 RGB，
 * 返回与 startFrame 差异最小的帧号。
 *
 * @param {string} inputPath - 输入视频路径
 * @param {number} startFrame - 起始帧号
 * @param {number} fps - 视频帧率
 * @param {number} totalFrames - 视频总帧数
 * @param {Object} [options]
 * @param {number} [options.maxSearch=300] - 最大向后搜索帧数
 * @param {number} [options.step=2] - 每隔 step 帧检查一次（兼顾速度与精度）
 * @param {number} [options.thumbSize=64] - 缩略图尺寸
 * @returns {Promise<{bestFrame: number, bestScore: number, scores: Array<{frame:number,score:number}>}>}
 */
function findLoopEndFrame(inputPath, startFrame, fps, totalFrames, options = {}) {
  const { maxSearch = 300, step = 2, thumbSize = 64 } = options;
  const endSearch = Math.min(startFrame + maxSearch, totalFrames);
  const searchCount = Math.floor((endSearch - startFrame - 1) / step);
  const frameBytes = thumbSize * thumbSize * 4;

  if (searchCount <= 0) {
    return Promise.resolve({
      bestFrame: startFrame,
      bestScore: 0,
      scores: [],
      message: '搜索范围过小'
    });
  }

  return new Promise((resolve, reject) => {
    // 1. 提取起始帧（缩略尺寸）
    const startArgs = [
      '-ss', String(startFrame / fps),
      '-i', inputPath,
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

      // 2. 扫描后续帧（批量提取缩略 raw RGBA）
      const scanTime = (startFrame + step) / fps;
      const scanArgs = [
        '-ss', String(scanTime),
        '-i', inputPath,
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
        let bestScore = Infinity;
        let bestFrame = startFrame;

        const total = Math.min(searchCount, Math.floor(scanBuf.length / frameBytes));
        for (let i = 0; i < total; i++) {
          const offset = i * frameBytes;
          const candidate = new Uint8Array(scanBuf.subarray(offset, offset + frameBytes));
          const score = pixelDiff(reference, candidate);
          const frameNum = startFrame + (i + 1) * step;

          scores.push({ frame: frameNum, score });
          if (score < bestScore) {
            bestScore = score;
            bestFrame = frameNum;
          }
        }

        resolve({ bestFrame, bestScore, scores, searchCount: total });
      });
      scanProc.on('error', reject);
    });
    startProc.on('error', reject);
  });
}

/**
 * 计算两帧缩略图之间的平均 RGB 差异（越低越相似）
 */
function pixelDiff(a, b) {
  let total = 0;
  const pixelCount = a.length / 4;
  for (let i = 0; i < a.length; i += 4) {
    total += Math.abs(a[i] - b[i])     // R
         + Math.abs(a[i + 1] - b[i + 1]) // G
         + Math.abs(a[i + 2] - b[i + 2]); // B
    // 跳过 Alpha 通道
  }
  return total / pixelCount; // 平均每像素 RGB 差异 (0-765)
}

module.exports = { processVideo, probeVideo, findLoopEndFrame };
