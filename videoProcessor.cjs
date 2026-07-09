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
 * @param {Object} params - { keying, layout, mode }
 *   mode: 'transparent' | 'greenscreen'
 * @param {Function} onProgress - (current, total) => void
 * @returns {Promise<Object>} 处理结果
 */
async function processVideo(inputPath, outputPath, params, onProgress) {
  await loadAlgorithms();

  const { keying, layout, mode } = params;
  const { canvasWidth, canvasHeight } = layout;

  // 1. 探测视频
  const info = await probeVideo(inputPath);
  const { width: srcW, height: srcH, fps, duration, hasAudio } = info;
  const totalFrames = info.frameCount || Math.round(fps * duration);

  console.log(`  📹 视频信息: ${srcW}×${srcH} @ ${fps}fps, ${duration.toFixed(1)}s, ${totalFrames} frames, audio=${hasAudio}`);

  // 2. 临时文件：提取的原始音频
  const tmpDir = path.join(os.tmpdir(), 'greenscreen-studio');
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
  // ffmpeg 在 Windows 上对反斜杠路径处理不稳定，统一用正斜杠
  const audioPath = path.join(tmpDir, `audio_${Date.now()}.m4a`).replace(/\\/g, '/');

  // 3. 提取音频（如果有）
  let audioExtracted = false;
  if (hasAudio) {
    await new Promise((resolve, reject) => {
      const ffmpeg = spawn(FFMPEG, [
        '-i', inputPath,
        '-vn', '-acodec', 'aac',
        '-b:a', '192k',
        '-y', audioPath
      ]);
      ffmpeg.stderr.on('data', () => {});
      ffmpeg.on('close', code => {
        audioExtracted = code === 0 && fs.existsSync(audioPath);
        resolve();
      });
      ffmpeg.on('error', reject);
    });
  }

  // 4. 启动 ffmpeg 提取帧（raw RGBA pipe）
  const extractArgs = [
    '-i', inputPath,
    '-f', 'rawvideo',
    '-pix_fmt', 'rgba',
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
    // 解析进度
    const match = text.match(/frame=\s*(\d+)/);
    if (match && onProgress) {
      onProgress(parseInt(match[1]), totalFrames);
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
            onProgress(frameIndex, totalFrames);
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

      onProgress && onProgress(totalFrames, totalFrames);
      resolve({
        frameCount: frameIndex,
        duration: duration,
        fps: fps,
        outputSize: fs.existsSync(outputPath) ? fs.statSync(outputPath).size : 0,
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
 * 导出精灵图（Sprite Sheet）：将视频帧抠像后排列成网格 PNG
 *
 * @param {string} inputPath - 视频路径
 * @param {Object} params - { keying, layout }
 * @param {Object} spriteParams
 *   frameWidth: 每个精灵格宽度 (px)
 *   frameHeight: 每个精灵格高度 (px)
 *   framesPerRow: 每行帧数
 *   maxFrames: 最大导出帧数 (默认全部)
 *   sampleEvery: 采样间隔，每隔 N 帧取一帧 (默认 1 = 每帧都取)
 * @param {Function} onProgress - (current, total) => void
 * @returns {Promise<{ buffer, frameCount, sheetWidth, sheetHeight, cols, rows }>}
 */
async function exportSpriteSheet(inputPath, params, spriteParams, onProgress) {
  await loadAlgorithms();

  const { keying, layout } = params;
  const { frameWidth, frameHeight, framesPerRow, maxFrames = Infinity, sampleEvery = 1 } = spriteParams;

  // 1. 探测视频
  const info = await probeVideo(inputPath);
  const { width: srcW, height: srcH, fps, duration } = info;
  const totalFrames = info.frameCount || Math.round(fps * duration);
  // 采样后最多能取到的帧数
  const maxSampledFrames = Math.ceil(totalFrames / sampleEvery);
  const maxToProcess = Math.min(maxFrames, maxSampledFrames);
  const cols = framesPerRow;
  const rows = Math.ceil(maxToProcess / cols);
  const sheetWidth = cols * frameWidth;
  const sheetHeight = rows * frameHeight;

  console.log(`  📹 精灵图导出: ${srcW}×${srcH} @ ${fps}fps, 总${totalFrames}帧 每${sampleEvery}帧采样 → ${maxToProcess}帧, ${cols}×${rows}=${sheetWidth}×${sheetHeight}`);

  // 2. 预分配精灵图画布（透明背景）
  const sheetCanvas = createCanvas(sheetWidth, sheetHeight);
  const sheetCtx = sheetCanvas.getContext('2d');

  // 3. ffmpeg 提取帧（raw RGBA pipe）
  const extractArgs = ['-i', inputPath, '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'];
  const extractor = spawn(FFMPEG, extractArgs);

  const frameSize = srcW * srcH * 4;
  const srcBuffer = Buffer.alloc(frameSize);

  let frameIndex = 0;          // 已采样的输出帧计数
  let inputFrameIndex = 0;     // 输入帧计数（含跳过的）
  let bytesBuffered = 0;
  let pipelineError = null;

  return new Promise((resolve, reject) => {
    extractor.stdout.on('data', chunk => {
      if (pipelineError) return;
      if (frameIndex >= maxToProcess) return;

      let offset = 0;
      while (offset < chunk.length && frameIndex < maxToProcess) {
        const remaining = frameSize - bytesBuffered;
        const toCopy = Math.min(remaining, chunk.length - offset);
        chunk.copy(srcBuffer, bytesBuffered, offset, offset + toCopy);
        bytesBuffered += toCopy;
        offset += toCopy;

        if (bytesBuffered === frameSize) {
          const shouldSample = (inputFrameIndex % sampleEvery === 0);
          inputFrameIndex++;

          if (shouldSample) {
            try {
              // 抠像 + 自动裁剪
              const srcData = {
                data: new Uint8ClampedArray(srcBuffer),
                width: srcW, height: srcH,
              };
              let keyed = applyKeying(srcData, keying);
              if (layout.autoCrop !== false) {
                keyed = autoCropKeyed(keyed);
              }

              // 抠像结果放到临时 canvas
              const tempCanvas = createCanvas(keyed.width, keyed.height);
              const tempCtx = tempCanvas.getContext('2d');
              const imgData = tempCtx.createImageData(keyed.width, keyed.height);
              imgData.data.set(keyed.data);
              tempCtx.putImageData(imgData, 0, 0);

              // 计算在精灵格中的位置（等比缩放 + 居中）
              const scale = Math.min(frameWidth / keyed.width, frameHeight / keyed.height);
              const sw = Math.round(keyed.width * scale);
              const sh = Math.round(keyed.height * scale);
              const col = frameIndex % cols;
              const row = Math.floor(frameIndex / cols);
              const ox = col * frameWidth + Math.round((frameWidth - sw) / 2);
              const oy = row * frameHeight + Math.round((frameHeight - sh) / 2);

              sheetCtx.drawImage(tempCanvas, ox, oy, sw, sh);
              frameIndex++;

              if (frameIndex % 30 === 0 && onProgress) {
                onProgress(frameIndex, maxToProcess);
              }
            } catch (e) {
              pipelineError = e;
              return;
            }
          }
          bytesBuffered = 0;
        }
      }
    });

    extractor.on('close', () => {
      if (pipelineError) return reject(pipelineError);

      onProgress && onProgress(maxToProcess, maxToProcess);
      const buffer = sheetCanvas.toBuffer('image/png');
      console.log(`  ✅ 精灵图导出完成: ${frameIndex}帧, ${sheetWidth}×${sheetHeight} PNG`);

      resolve({
        buffer,
        frameCount: frameIndex,
        sheetWidth,
        sheetHeight,
        cols,
        rows,
      });
    });

    extractor.on('error', e => {
      pipelineError = e;
      reject(e);
    });
  });
}

module.exports = { processVideo, probeVideo, exportSpriteSheet };
