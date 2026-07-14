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
let applyKeying, composeToCanvas, autoCropKeyedWithBounds, cleanupKeyed, drawKeyedToCanvas, findAlphaBounds;
const AUTO_CROP_ALPHA_THRESHOLD = 10;

async function loadAlgorithms() {
  if (!applyKeying) {
    const mod = await import('./src/lib/keying.js');
    applyKeying = mod.applyKeying;
    composeToCanvas = mod.composeToCanvas;
    autoCropKeyedWithBounds = mod.autoCropKeyedWithBounds;
    cleanupKeyed = mod.cleanupKeyed;
    drawKeyedToCanvas = mod.drawKeyedToCanvas;
    findAlphaBounds = mod.findAlphaBounds;
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
 * @param {Object} params - { keying, layout, mode, range?, region? }
 *   mode: 'transparent' | 'greenscreen'
 *   range?: { startFrame: number, endFrame: number } 帧范围（可选，默认全视频）
 * @param {Function} onProgress - (current, total) => void
 * @returns {Promise<Object>} 处理结果
 */
async function processVideo(inputPath, outputPath, params, onProgress) {
  await loadAlgorithms();

  const { keying, layout, mode, range, cleanup, region } = params;
  const { canvasWidth, canvasHeight } = layout;

  // 1. 探测视频
  const info = await probeVideo(inputPath);
  const { width: srcW, height: srcH, fps, duration, hasAudio } = info;
  const totalFrames = info.frameCount || Math.round(fps * duration);

  // 计算帧范围。range 为 end-exclusive；未指定时处理全视频。
  const normalizedRange = normalizeFrameRange(range, totalFrames);
  const { startFrame, endFrame } = normalizedRange;
  const processFrameCount = endFrame - startFrame;
  const startTime = startFrame / fps;
  const rangeDuration = processFrameCount / fps;
  const frameSize = srcW * srcH * 4; // RGBA

  const hasRange = startFrame > 0 || endFrame < totalFrames;
  const rangeDesc = hasRange ? ` [${startFrame}–${endFrame}帧, ${processFrameCount}帧]` : '';
  const normalizedRegion = normalizeRegionForSize(region, srcW, srcH);
  const hasRegion = normalizedRegion && !isFullRegion(normalizedRegion, srcW, srcH);
  const regionDesc = hasRegion
    ? `, region=${normalizedRegion.width}×${normalizedRegion.height}@${normalizedRegion.x},${normalizedRegion.y}`
    : '';

  console.log(`  📹 视频信息: ${srcW}×${srcH} @ ${fps}fps, ${duration.toFixed(1)}s, ${totalFrames} frames, audio=${hasAudio}${rangeDesc}${regionDesc}`);

  const usesStableVideoCrop = layout.autoCrop !== false;
  const progressTotal = usesStableVideoCrop ? processFrameCount * 2 : processFrameCount;
  const renderProgressOffset = usesStableVideoCrop ? processFrameCount : 0;
  const stableCrop = usesStableVideoCrop
    ? await scanStableVideoCrop(inputPath, {
        startFrame,
        endFrame,
        fps,
        frameBytes: frameSize,
        srcW,
        srcH,
        params: { keying, cleanup, region },
        onProgress,
        progressTotal,
      })
    : null;

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
      onProgress(renderProgressOffset + parseInt(match[1]), progressTotal);
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
  const srcBuffer = Buffer.alloc(frameSize);

  let frameIndex = 0;
  let bytesBuffered = 0;
  let pipelineError = null;
  let encoderClosed = false;
  let firstFrameMetadata = null;
  const cleanupTotals = createCleanupSummary();
  const warnings = [];

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
            const processedFrame = processFrameWithMetadata(srcBuffer, srcW, srcH, { keying, layout, mode, cleanup, region, stableCrop });
            if (!firstFrameMetadata) firstFrameMetadata = processedFrame.metadata;
            mergeCleanupSummary(cleanupTotals, processedFrame.metadata.cleanup);
            appendWarnings(warnings, processedFrame.metadata.warnings);
            encoder.stdin.write(processedFrame.buffer);
          } catch (e) {
            if (!pipelineError) pipelineError = e;
            return;
          }
          bytesBuffered = 0;
          frameIndex++;

          if (frameIndex % 30 === 0 && onProgress) {
            onProgress(renderProgressOffset + frameIndex, progressTotal);
          }
        }
      }
    });

    extractor.on('close', () => {
      // 处理最后一帧（如果有残余数据）
      if (!encoderClosed && !pipelineError && bytesBuffered > 0 && bytesBuffered >= frameSize) {
        try {
          const processedFrame = processFrameWithMetadata(srcBuffer, srcW, srcH, { keying, layout, mode, cleanup, region, stableCrop });
          if (!firstFrameMetadata) firstFrameMetadata = processedFrame.metadata;
          mergeCleanupSummary(cleanupTotals, processedFrame.metadata.cleanup);
          appendWarnings(warnings, processedFrame.metadata.warnings);
          encoder.stdin.write(processedFrame.buffer);
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

      onProgress && onProgress(progressTotal, progressTotal);
      resolve({
        frameCount: frameIndex,
        duration: rangeDuration || duration,
        fps: fps,
        outputSize: fs.existsSync(outputPath) ? fs.statSync(outputPath).size : 0,
        range: hasRange ? { startFrame, endFrame, processFrameCount } : null,
        sampleFrame: firstFrameMetadata,
        stableCrop: summarizeStableCrop(stableCrop),
        cleanup: cleanupTotals,
        warnings,
      });
    });

    encoder.on('error', e => { pipelineError = e; reject(e); });
  });
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function normalizeRegionForSize(region, width, height) {
  if (!region || width <= 0 || height <= 0) return null;

  const rawX = Number(region.x);
  const rawY = Number(region.y);
  const rawWidth = Number(region.width);
  const rawHeight = Number(region.height);
  if (![rawX, rawY, rawWidth, rawHeight].every(Number.isFinite)) return null;

  const x = clamp(Math.floor(rawX), 0, width);
  const y = clamp(Math.floor(rawY), 0, height);
  const regionWidth = clamp(Math.ceil(rawWidth), 0, width - x);
  const regionHeight = clamp(Math.ceil(rawHeight), 0, height - y);

  if (regionWidth <= 0 || regionHeight <= 0) return null;
  return { x, y, width: regionWidth, height: regionHeight };
}

function isFullRegion(region, width, height) {
  return (
    region &&
    region.x === 0 &&
    region.y === 0 &&
    region.width === width &&
    region.height === height
  );
}

function cropImageDataToRegion(imageData, region) {
  const normalized = normalizeRegionForSize(region, imageData.width, imageData.height);
  if (!normalized || isFullRegion(normalized, imageData.width, imageData.height)) return imageData;

  const { x: cropX, y: cropY, width: cropW, height: cropH } = normalized;
  const cropped = new Uint8ClampedArray(cropW * cropH * 4);

  for (let y = 0; y < cropH; y++) {
    const srcRow = ((cropY + y) * imageData.width + cropX) * 4;
    const dstRow = y * cropW * 4;
    cropped.set(imageData.data.subarray(srcRow, srcRow + cropW * 4), dstRow);
  }

  return { data: cropped, width: cropW, height: cropH };
}

function getProcessingRegionMetadata(region, srcW, srcH) {
  const normalized = normalizeRegionForSize(region, srcW, srcH);
  if (!normalized || isFullRegion(normalized, srcW, srcH)) {
    return {
      applied: false,
      x: 0,
      y: 0,
      width: srcW,
      height: srcH,
      sourceWidth: srcW,
      sourceHeight: srcH,
    };
  }

  return {
    applied: true,
    ...normalized,
    sourceWidth: srcW,
    sourceHeight: srcH,
  };
}

function mergeAlphaBounds(current, next) {
  if (!next) return current || null;
  if (!current) return { ...next };
  return {
    minX: Math.min(current.minX, next.minX),
    minY: Math.min(current.minY, next.minY),
    maxX: Math.max(current.maxX, next.maxX),
    maxY: Math.max(current.maxY, next.maxY),
  };
}

function clampAlphaBounds(bounds, width, height) {
  if (!bounds || width <= 0 || height <= 0) return null;
  const minX = clamp(Math.floor(bounds.minX), 0, width - 1);
  const minY = clamp(Math.floor(bounds.minY), 0, height - 1);
  const maxX = clamp(Math.ceil(bounds.maxX), 0, width - 1);
  const maxY = clamp(Math.ceil(bounds.maxY), 0, height - 1);
  if (maxX < minX || maxY < minY) return null;
  return { minX, minY, maxX, maxY };
}

function cropKeyedToBounds(keyedData, bounds, threshold = AUTO_CROP_ALPHA_THRESHOLD, metadata = {}) {
  const { data, width, height } = keyedData;
  const normalized = clampAlphaBounds(bounds, width, height);

  if (!normalized) {
    return {
      imageData: keyedData,
      crop: {
        applied: false,
        x: 0,
        y: 0,
        width,
        height,
        sourceWidth: width,
        sourceHeight: height,
        alphaThreshold: threshold,
        reason: 'no_foreground',
        ...metadata,
      },
    };
  }

  const { minX, minY, maxX, maxY } = normalized;
  const cropW = maxX - minX + 1;
  const cropH = maxY - minY + 1;
  const cropped = new Uint8ClampedArray(cropW * cropH * 4);

  for (let y = 0; y < cropH; y++) {
    const srcRow = ((minY + y) * width + minX) * 4;
    const dstRow = y * cropW * 4;
    cropped.set(data.subarray(srcRow, srcRow + cropW * 4), dstRow);
  }

  return {
    imageData: { data: cropped, width: cropW, height: cropH },
    crop: {
      applied: cropW !== width || cropH !== height,
      x: minX,
      y: minY,
      width: cropW,
      height: cropH,
      sourceWidth: width,
      sourceHeight: height,
      alphaThreshold: threshold,
      ...metadata,
    },
  };
}

function boundsToCropBox(bounds) {
  if (!bounds) return null;
  return {
    x: bounds.minX,
    y: bounds.minY,
    width: bounds.maxX - bounds.minX + 1,
    height: bounds.maxY - bounds.minY + 1,
  };
}

function summarizeStableCrop(stableCrop) {
  if (!stableCrop) return null;
  return {
    strategy: stableCrop.strategy,
    bounds: boundsToCropBox(stableCrop.bounds),
    alphaThreshold: stableCrop.alphaThreshold,
    scan: stableCrop.scan,
  };
}

function getFrameAlphaBounds(srcBuffer, srcW, srcH, params) {
  const { keying, cleanup, region } = params;
  const srcData = {
    data: new Uint8ClampedArray(srcBuffer),
    width: srcW,
    height: srcH,
  };
  const processingRegion = getProcessingRegionMetadata(region, srcW, srcH);
  const processingData = processingRegion.applied
    ? cropImageDataToRegion(srcData, processingRegion)
    : srcData;
  let keyed = applyKeying(processingData, keying);
  keyed = cleanupKeyed(keyed, cleanup || {}).imageData;

  return {
    bounds: findAlphaBounds(keyed, AUTO_CROP_ALPHA_THRESHOLD),
    processingRegion,
  };
}

async function scanStableVideoCrop(inputPath, {
  startFrame,
  endFrame,
  fps,
  frameBytes,
  srcW,
  srcH,
  params,
  onProgress,
  progressTotal,
}) {
  const frameCount = endFrame - startFrame;
  if (frameCount <= 0) {
    throw new Error('Frame range must contain at least one frame');
  }

  console.log(`  🔎 自动裁剪扫描: ${startFrame}–${endFrame}帧 (${frameCount}帧)`);

  let unionBounds = null;
  let scannedFrameCount = 0;
  let foregroundFrameCount = 0;
  let scanRegion = null;

  await scanRawFrames(inputPath, startFrame, fps, frameCount, frameBytes, (frameBuf) => {
    const { bounds, processingRegion } = getFrameAlphaBounds(frameBuf, srcW, srcH, params);
    if (!scanRegion) scanRegion = processingRegion;
    if (bounds) {
      unionBounds = mergeAlphaBounds(unionBounds, bounds);
      foregroundFrameCount++;
    }
    scannedFrameCount++;
    if (onProgress && scannedFrameCount % 30 === 0) {
      onProgress(scannedFrameCount, progressTotal);
    }
  });

  if (!scanRegion) {
    scanRegion = getProcessingRegionMetadata(params.region, srcW, srcH);
  }

  const summary = {
    strategy: 'video_union',
    bounds: unionBounds,
    alphaThreshold: AUTO_CROP_ALPHA_THRESHOLD,
    scan: {
      startFrame,
      endFrame,
      requestedFrameCount: frameCount,
      scannedFrameCount,
      foregroundFrameCount,
      sourceWidth: scanRegion.width,
      sourceHeight: scanRegion.height,
      processingRegion: scanRegion,
    },
  };

  const box = boundsToCropBox(unionBounds);
  const boxDesc = box ? `${box.width}×${box.height}@${box.x},${box.y}` : 'no foreground';
  console.log(`  🔎 自动裁剪并集框: ${boxDesc}, foreground=${foregroundFrameCount}/${scannedFrameCount}`);
  if (onProgress) onProgress(scannedFrameCount, progressTotal);

  return summary;
}

/**
 * 处理单帧：提取 → 可选处理区域裁剪 → 抠像 → 清理 → 裁剪 → 合成 → 输出 raw RGBA + 元数据
 */
function processFrameWithMetadata(srcBuffer, srcW, srcH, params, outputSize) {
  const { keying, layout, mode, cleanup, region, stableCrop } = params;
  const renderLayout = outputSize
    ? { ...layout, canvasWidth: outputSize.width, canvasHeight: outputSize.height }
    : layout;
  // 从 raw buffer 构建 ImageData-like 对象
  const srcData = {
    data: new Uint8ClampedArray(srcBuffer),
    width: srcW,
    height: srcH,
  };
  const processingRegion = getProcessingRegionMetadata(region, srcW, srcH);
  const processingData = processingRegion.applied
    ? cropImageDataToRegion(srcData, processingRegion)
    : srcData;

  // 抠像
  let keyed = applyKeying(processingData, keying);
  const cleanupResult = cleanupKeyed(keyed, cleanup || {});
  keyed = cleanupResult.imageData;

  // 自动裁剪
  let crop = {
    applied: false,
    x: 0,
    y: 0,
    width: keyed.width,
    height: keyed.height,
    sourceWidth: keyed.width,
    sourceHeight: keyed.height,
  };
  if (layout.autoCrop !== false) {
    const cropResult = stableCrop
      ? cropKeyedToBounds(keyed, stableCrop.bounds, stableCrop.alphaThreshold, {
          strategy: stableCrop.strategy,
          scan: stableCrop.scan,
        })
      : autoCropKeyedWithBounds(keyed);
    keyed = cropResult.imageData;
    crop = cropResult.crop;
  }

  const { canvasWidth, canvasHeight } = renderLayout;
  const canvas = createCanvas(canvasWidth, canvasHeight);
  const ctx = canvas.getContext('2d');
  const tempCanvas = createCanvas(Math.max(1, keyed.width), Math.max(1, keyed.height));
  let placement;

  if (mode === 'transparent') {
    // 透明模式：输出画布是透明的，只画人物
    placement = drawKeyedToCanvas(ctx, keyed, renderLayout, tempCanvas);
  } else {
    // 绿幕合成模式
    placement = composeToCanvas(ctx, keyed, renderLayout, tempCanvas, keying?.keyColor);
  }

  const outImageData = ctx.getImageData(0, 0, canvasWidth, canvasHeight);
  const metadata = {
    source: { width: srcW, height: srcH },
    processingRegion,
    keyed: { width: keyed.width, height: keyed.height },
    crop,
    placement,
    cleanup: cleanupResult.stats,
    warnings: buildFrameWarnings({ keyed, crop, placement, cleanup: cleanupResult.stats, canvasWidth, canvasHeight }),
  };

  return { buffer: Buffer.from(outImageData.data), canvas, metadata };
}

/**
 * 处理单帧：提取 → 抠像 → 裁剪 → 合成 → 输出 raw RGBA
 */
function processFrame(srcBuffer, srcW, srcH, keying, layout, mode, cleanup, region) {
  return processFrameWithMetadata(srcBuffer, srcW, srcH, { keying, layout, mode, cleanup, region }).buffer;
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
 */
async function exportSpriteSheet(inputPath, params, spriteParams, onProgress) {
  await loadAlgorithms();

  const info = await probeVideo(inputPath);
  const { width: srcW, height: srcH, fps, duration } = info;
  const totalFrames = info.frameCount || Math.round(fps * duration);
  const selection = selectSpriteFrames(spriteParams, totalFrames);
  const { frameWidth, frameHeight, framesPerRow } = spriteParams;
  const maxToProcess = selection.frames.length;
  const cols = framesPerRow;
  const rows = Math.ceil(maxToProcess / cols);
  const sheetWidth = cols * frameWidth;
  const sheetHeight = rows * frameHeight;

  console.log(`  📹 精灵图导出: ${srcW}×${srcH} @ ${fps}fps, 总${totalFrames}帧 → ${maxToProcess}帧, ${cols}×${rows}=${sheetWidth}×${sheetHeight}`);

  const sheetCanvas = createCanvas(sheetWidth, sheetHeight);
  const sheetCtx = sheetCanvas.getContext('2d');

  const frameJobs = selection.frames.map((sourceFrameIndex, atlasIndex) => ({
    atlasIndex,
    sourceFrameIndex,
    inputPath,
  }));
  const metadata = await renderFrameJobsToAtlas({
    sheetCanvas,
    sheetCtx,
    frameJobs,
    params,
    frameWidth,
    frameHeight,
    cols,
    onProgress,
    totalProgress: maxToProcess,
    sourceInfoByPath: new Map([[inputPath, { ...info, totalFrames, srcW, srcH }]]),
    stableCropRangesByInput: new Map([[inputPath, selection.range]]),
  });

  const buffer = sheetCanvas.toBuffer('image/png');
  console.log(`  ✅ 精灵图导出完成: ${metadata.frames.length}帧, ${sheetWidth}×${sheetHeight} PNG`);

  return {
    buffer,
    frameCount: metadata.frames.length,
    sheetWidth,
    sheetHeight,
    atlasDimensions: { width: sheetWidth, height: sheetHeight },
    cols,
    rows,
    frames: metadata.frames,
    selection,
    cleanup: metadata.cleanup,
    warnings: [...selection.warnings, ...metadata.warnings],
  };
}

/**
 * 导出 Godot SpriteFrames：图集 PNG + SpriteFrames tres 字符串 + 元数据。
 */
async function exportGodotSpriteFrames(frameJobs, params, spriteParams, godotOptions = {}, onProgress) {
  await loadAlgorithms();

  const { frameWidth, frameHeight, framesPerRow } = spriteParams;
  const frameCount = frameJobs.length;
  if (frameCount === 0) {
    throw new Error('At least one Godot animation frame is required');
  }

  const cols = Math.max(1, Math.min(framesPerRow || frameCount, frameCount));
  const rows = Math.ceil(frameCount / cols);
  const sheetWidth = cols * frameWidth;
  const sheetHeight = rows * frameHeight;
  const sheetCanvas = createCanvas(sheetWidth, sheetHeight);
  const sheetCtx = sheetCanvas.getContext('2d');

  const metadata = await renderFrameJobsToAtlas({
    sheetCanvas,
    sheetCtx,
    frameJobs,
    params,
    frameWidth,
    frameHeight,
    cols,
    onProgress,
    totalProgress: frameCount,
  });
  const animationMetadata = buildAnimationMetadata(frameJobs, godotOptions.animations || [], godotOptions.fps || 12);
  const tres = buildGodotSpriteFramesTres({
    atlasResourcePath: godotOptions.atlasResourcePath || 'res://atlas.png',
    frames: metadata.frames,
    animations: animationMetadata,
  });

  return {
    buffer: sheetCanvas.toBuffer('image/png'),
    tres,
    frameCount,
    sheetWidth,
    sheetHeight,
    atlasDimensions: { width: sheetWidth, height: sheetHeight },
    cols,
    rows,
    frames: metadata.frames,
    animations: animationMetadata,
    cleanup: metadata.cleanup,
    warnings: metadata.warnings,
  };
}

function selectSpriteFrames(spriteParams, totalFrames) {
  const sampleEvery = positiveInt(spriteParams.sampleEvery, 1);
  const maxFrames = spriteParams.maxFrames == null ? Infinity : positiveInt(spriteParams.maxFrames, Infinity);
  const range = normalizeFrameRange(spriteParams.range, totalFrames);
  const warnings = [];
  let frames;
  let mode;

  if (Array.isArray(spriteParams.frames) && spriteParams.frames.length > 0) {
    mode = 'frames';
    const seen = new Set();
    const invalid = [];
    frames = [];

    for (const rawFrame of spriteParams.frames) {
      const frame = Number(rawFrame);
      if (!Number.isInteger(frame) || frame < 0 || frame >= totalFrames) {
        invalid.push(rawFrame);
        continue;
      }
      if (seen.has(frame)) continue;
      seen.add(frame);
      frames.push(frame);
    }

    if (invalid.length > 0) {
      throw new Error(`frames contains invalid source frame indexes: ${invalid.join(', ')}`);
    }
    if (frames.length !== spriteParams.frames.length) {
      warnings.push('Duplicate frame indexes were removed from the explicit frame list.');
    }

    frames.sort((a, b) => a - b);
    const beforeRange = frames.length;
    frames = frames.filter(frame => frame >= range.startFrame && frame < range.endFrame);
    if (frames.length !== beforeRange) {
      warnings.push('Some explicit frame indexes were outside the requested range and were omitted.');
    }
    if (Number.isFinite(maxFrames)) {
      frames = frames.slice(0, maxFrames);
    }
  } else {
    mode = 'sample';
    frames = [];
    for (let frame = range.startFrame; frame < range.endFrame && frames.length < maxFrames; frame += sampleEvery) {
      frames.push(frame);
    }
  }

  if (frames.length === 0) {
    throw new Error('Frame selection produced no frames');
  }

  return {
    mode,
    frames,
    frameCount: frames.length,
    range,
    sampleEvery,
    maxFrames: Number.isFinite(maxFrames) ? maxFrames : null,
    ordering: 'ascending_source_frame',
    warnings,
  };
}

function normalizeFrameRange(range, totalFrames) {
  const startFrame = range?.startFrame == null ? 0 : Math.round(Number(range.startFrame));
  const endFrame = range?.endFrame == null ? totalFrames : Math.round(Number(range.endFrame));
  if (!Number.isInteger(startFrame) || startFrame < 0 || startFrame >= totalFrames) {
    throw new Error(`range.startFrame must be between 0 and ${Math.max(0, totalFrames - 1)}`);
  }
  if (!Number.isInteger(endFrame) || endFrame <= startFrame || endFrame > totalFrames) {
    throw new Error(`range.endFrame must be greater than startFrame and no more than ${totalFrames}`);
  }
  return { startFrame, endFrame };
}

async function renderFrameJobsToAtlas({
  sheetCtx,
  frameJobs,
  params,
  frameWidth,
  frameHeight,
  cols,
  onProgress,
  totalProgress,
  sourceInfoByPath = new Map(),
  stableCropRangesByInput = new Map(),
}) {
  const frames = new Array(frameJobs.length);
  const warnings = [];
  const cleanupSummary = createCleanupSummary();
  const jobsByInput = new Map();
  let rendered = 0;

  for (const job of frameJobs) {
    if (!jobsByInput.has(job.inputPath)) jobsByInput.set(job.inputPath, []);
    jobsByInput.get(job.inputPath).push(job);
  }

  for (const [inputPath, jobs] of jobsByInput) {
    let info = sourceInfoByPath.get(inputPath);
    if (!info) {
      const probed = await probeVideo(inputPath);
      const totalFrames = probed.frameCount || Math.round(probed.fps * probed.duration);
      info = { ...probed, totalFrames, srcW: probed.width, srcH: probed.height };
      sourceInfoByPath.set(inputPath, info);
    }

    const srcW = info.srcW || info.width;
    const srcH = info.srcH || info.height;
    const totalFrames = info.totalFrames || info.frameCount || Math.round(info.fps * info.duration);
    const frameBytes = srcW * srcH * 4;
    const jobsByFrame = new Map();

    for (const job of jobs) {
      if (job.sourceFrameIndex < 0 || job.sourceFrameIndex >= totalFrames) {
        throw new Error(`Frame ${job.sourceFrameIndex} is outside ${inputPath} frame range 0-${totalFrames - 1}`);
      }
      if (!jobsByFrame.has(job.sourceFrameIndex)) jobsByFrame.set(job.sourceFrameIndex, []);
      jobsByFrame.get(job.sourceFrameIndex).push(job);
    }

    const selectedFrames = [...jobsByFrame.keys()].sort((a, b) => a - b);
    const scanStart = selectedFrames[0];
    const scanEnd = selectedFrames[selectedFrames.length - 1];
    const expected = new Set(selectedFrames);
    const seen = new Set();
    const stableCropRange = stableCropRangesByInput.get(inputPath) || {
      startFrame: scanStart,
      endFrame: scanEnd + 1,
    };
    const normalizedStableCropRange = normalizeFrameRange(stableCropRange, totalFrames);
    const stableCrop = params.layout?.autoCrop !== false
      ? await scanStableVideoCrop(inputPath, {
          startFrame: normalizedStableCropRange.startFrame,
          endFrame: normalizedStableCropRange.endFrame,
          fps: info.fps,
          frameBytes,
          srcW,
          srcH,
          params: {
            keying: params.keying,
            cleanup: params.cleanup,
            region: params.region,
          },
        })
      : null;

    await scanRawFrames(inputPath, scanStart, info.fps, scanEnd - scanStart + 1, frameBytes, (frameBuf, i) => {
      const sourceFrameIndex = scanStart + i;
      const frameJobsForSource = jobsByFrame.get(sourceFrameIndex);
      if (!frameJobsForSource) return;

      seen.add(sourceFrameIndex);
      const processed = processFrameWithMetadata(frameBuf, srcW, srcH, { ...params, stableCrop }, { width: frameWidth, height: frameHeight });

      for (const job of frameJobsForSource) {
        mergeCleanupSummary(cleanupSummary, processed.metadata.cleanup);
        const region = drawAtlasFrame(sheetCtx, processed.canvas, job, frameWidth, frameHeight, cols);
        const frameWarnings = [...processed.metadata.warnings];
        if (region.width !== frameWidth || region.height !== frameHeight) {
          frameWarnings.push(`Atlas region for frame ${job.atlasIndex} did not match requested frame size.`);
        }
        appendWarnings(warnings, frameWarnings.map(warning => `${job.animationName ? `${job.animationName}: ` : ''}${warning}`));
        frames[job.atlasIndex] = {
          atlasIndex: job.atlasIndex,
          animationName: job.animationName || null,
          animationFrameIndex: job.animationFrameIndex ?? job.atlasIndex,
          sourceVideoPath: inputPath,
          sourceFrameIndex,
          region,
          processingRegion: processed.metadata.processingRegion,
          flipH: job.flipH === true,
          crop: processed.metadata.crop,
          placement: processed.metadata.placement,
          cleanup: processed.metadata.cleanup,
          warnings: frameWarnings,
        };
        rendered++;
        if (rendered % 30 === 0 && onProgress) {
          onProgress(rendered, totalProgress);
        }
      }
    });

    for (const frame of expected) {
      if (!seen.has(frame)) {
        warnings.push(`Requested source frame ${frame} was not decoded from ${inputPath}.`);
      }
    }
  }

  onProgress && onProgress(rendered, totalProgress);
  return {
    frames: frames.filter(Boolean).sort((a, b) => a.atlasIndex - b.atlasIndex),
    cleanup: cleanupSummary,
    warnings,
  };
}

function drawAtlasFrame(sheetCtx, frameCanvas, job, frameWidth, frameHeight, cols) {
  const col = job.atlasIndex % cols;
  const row = Math.floor(job.atlasIndex / cols);
  const x = col * frameWidth;
  const y = row * frameHeight;

  if (job.flipH) {
    sheetCtx.save();
    sheetCtx.translate(x + frameWidth, y);
    sheetCtx.scale(-1, 1);
    sheetCtx.drawImage(frameCanvas, 0, 0, frameWidth, frameHeight);
    sheetCtx.restore();
  } else {
    sheetCtx.drawImage(frameCanvas, x, y, frameWidth, frameHeight);
  }

  return { x, y, width: frameWidth, height: frameHeight };
}

function buildAnimationMetadata(frameJobs, animationSpecs, defaultFps) {
  const specByName = new Map(animationSpecs.map(spec => [spec.name, spec]));
  const names = [];
  for (const job of frameJobs) {
    if (!names.includes(job.animationName)) names.push(job.animationName);
  }

  return names.map(name => {
    const spec = specByName.get(name) || {};
    const jobs = frameJobs
      .filter(job => job.animationName === name)
      .sort((a, b) => a.animationFrameIndex - b.animationFrameIndex);
    return {
      name,
      fps: Number.isFinite(Number(spec.fps)) ? Number(spec.fps) : defaultFps,
      loop: spec.loop !== false,
      frameCount: jobs.length,
      atlasFrameIndexes: jobs.map(job => job.atlasIndex),
    };
  });
}

function buildGodotSpriteFramesTres({ atlasResourcePath, frames, animations }) {
  const lines = [
    `[gd_resource type="SpriteFrames" load_steps=${frames.length + 2} format=3]`,
    '',
    `[ext_resource type="Texture2D" path="${escapeGodotString(atlasResourcePath)}" id="1_atlas"]`,
    '',
  ];

  for (const frame of frames) {
    lines.push(`[sub_resource type="AtlasTexture" id="AtlasTexture_${frame.atlasIndex}"]`);
    lines.push('atlas = ExtResource("1_atlas")');
    lines.push(`region = Rect2(${frame.region.x}, ${frame.region.y}, ${frame.region.width}, ${frame.region.height})`);
    lines.push('');
  }

  lines.push('[resource]');
  lines.push('animations = [{');
  animations.forEach((animation, animationIndex) => {
    if (animationIndex > 0) {
      lines.push('}, {');
    }
    lines.push('"frames": [');
    animation.atlasFrameIndexes.forEach((atlasIndex, frameIndex) => {
      const suffix = frameIndex === animation.atlasFrameIndexes.length - 1 ? '' : ',';
      lines.push(`{"duration": 1.0, "texture": SubResource("AtlasTexture_${atlasIndex}")}${suffix}`);
    });
    lines.push('],');
    lines.push(`"loop": ${animation.loop ? 'true' : 'false'},`);
    lines.push(`"name": &"${escapeGodotString(animation.name)}",`);
    lines.push(`"speed": ${animation.fps}`);
  });
  lines.push('}]');
  lines.push('');

  return lines.join('\n');
}

function escapeGodotString(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function buildFrameWarnings({ keyed, placement, cleanup, canvasWidth, canvasHeight }) {
  const warnings = [];
  if (placement.scaledW <= 0 || placement.scaledH <= 0) {
    warnings.push('Frame placement produced an empty drawn size.');
  }
  const outsideHorizontally = placement.offsetX + placement.scaledW <= 0 || placement.offsetX >= canvasWidth;
  const outsideVertically = placement.offsetY + placement.scaledH <= 0 || placement.offsetY >= canvasHeight;
  if (outsideHorizontally || outsideVertically) {
    warnings.push('Frame placement is completely outside the output canvas.');
  }
  if (cleanup.enabled && cleanup.foregroundPixelsAfter === 0 && cleanup.foregroundPixelsBefore > 0) {
    warnings.push('Cleanup removed all foreground pixels.');
  }
  if (cleanup.componentsFound > 1 && cleanup.componentsKept > 1) {
    warnings.push('Multiple foreground components remain after cleanup; small artifacts may still affect layout.');
  }
  if (keyed.width <= 1 || keyed.height <= 1) {
    warnings.push('Auto-crop produced a nearly empty foreground region.');
  }
  return warnings;
}

function createCleanupSummary() {
  return {
    frames: 0,
    foregroundPixelsBefore: 0,
    paleGreenPixelsRemoved: 0,
    foregroundPixelsAfterPaleGreen: 0,
    componentsFound: 0,
    largestComponentPixelsMax: 0,
    componentsRemoved: 0,
    componentPixelsRemoved: 0,
    componentsKept: 0,
    foregroundPixelsAfter: 0,
  };
}

function mergeCleanupSummary(summary, stats) {
  if (!stats) return summary;
  summary.frames++;
  summary.foregroundPixelsBefore += stats.foregroundPixelsBefore || 0;
  summary.paleGreenPixelsRemoved += stats.paleGreenPixelsRemoved || 0;
  summary.foregroundPixelsAfterPaleGreen += stats.foregroundPixelsAfterPaleGreen || 0;
  summary.componentsFound += stats.componentsFound || 0;
  summary.largestComponentPixelsMax = Math.max(summary.largestComponentPixelsMax, stats.largestComponentPixels || 0);
  summary.componentsRemoved += stats.componentsRemoved || 0;
  summary.componentPixelsRemoved += stats.componentPixelsRemoved || 0;
  summary.componentsKept += stats.componentsKept || 0;
  summary.foregroundPixelsAfter += stats.foregroundPixelsAfter || 0;
  return summary;
}

function appendWarnings(target, warnings = []) {
  for (const warning of warnings) {
    if (warning && !target.includes(warning)) target.push(warning);
  }
}

function positiveInt(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return Math.max(1, Math.round(number));
}

/**
 * 从视频中找与起始帧相似的循环终点帧候选列表。
 *
 * 如果 options.params / options.previewParams 中包含 keying + layout，则先按合成预览
 * 处理每帧（键控、自动裁剪、缩放到输出画布、填充键控色背景），再计算 dHash。
 * 没有处理参数时保留旧行为：直接比较原始视频缩略帧。
 *
 * 使用 dHash (Difference Hash) 算法：
 *   1. 提取帧缩略图到 (hashSize+1) × hashSize 大小（默认 9×8）
 *   2. 对每行比较相邻像素的亮度梯度 → 64-bit 感知哈希
 *   3. 用汉明距离比较哈希，距离越低 = 画面越相似
 *
 * dHash 对比纯像素/直方图的优势：
 *   - 捕捉梯度结构 → 同一人物/构图即使微移也能匹配
 *   - 亮度标准化 → 对不同光照鲁棒
 *   - 64-bit 哈希极易存储和比较
 *
 * @param {string} inputPath - 输入视频路径
 * @param {number} startFrame - 起始帧号
 * @param {number} fps - 视频帧率
 * @param {number} totalFrames - 视频总帧数
 * @param {Object} [options]
 * @param {number} [options.maxSearch=300] - 最大向后搜索帧数
 * @param {number} [options.step=2] - 每隔 step 帧检查一次
 * @param {number} [options.hashSize=16] - dHash 尺寸（默认 16 → 17×16 缩略 → 256-bit）
 * @param {number} [options.minSpacing=12] - 候选帧之间最小帧间距
 * @param {number} [options.maxCandidates=5] - 最多返回多少个候选
 * @param {Object} [options.params] - { keying, layout, mode? }，用于按合成预览处理帧
 * @returns {Promise<{candidates: Array<{frame:number,score:number}>, scores: Array<{frame:number,score:number,displayOnly?:boolean}>}>}
 */
function findLoopEndFrame(inputPath, startFrame, fps, totalFrames, options = {}) {
  const previewParams = getLoopPreviewParams(options);
  if (previewParams) {
    return findLoopEndFrameProcessed(inputPath, startFrame, fps, totalFrames, options, previewParams);
  }
  return findLoopEndFrameRaw(inputPath, startFrame, fps, totalFrames, options);
}

function getLoopPreviewParams(options = {}) {
  const params = options.params || options.previewParams || null;
  if (!params || !params.keying || !params.layout) return null;
  return {
    keying: params.keying,
    layout: params.layout,
    mode: params.mode || 'greenscreen',
    region: params.region,
    cleanup: params.cleanup,
  };
}

async function findLoopEndFrameProcessed(inputPath, startFrame, fps, totalFrames, options = {}, previewParams) {
  await loadAlgorithms();

  const {
    maxSearch = 300,
    step = 2,
    hashSize = 16,
    minSpacing = 12,
    earlyFrameExclusion = minSpacing,
    maxCandidates = 5,
    motionWeight = 0.35,
    suspiciousCloseThreshold = Math.max(minSpacing * 2, 24)
  } = options;

  const endSearch = Math.min(startFrame + maxSearch, totalFrames);
  const scanStartFrame = startFrame + 1;
  const searchCount = Math.max(0, endSearch - scanStartFrame);
  const scaleW = hashSize + 1;
  const scaleH = hashSize;

  if (searchCount <= 0) {
    return {
      candidates: [],
      scores: [],
      message: '搜索范围过小'
    };
  }

  let srcW = Number(options.sourceWidth || options.width || options.srcW || 0);
  let srcH = Number(options.sourceHeight || options.height || options.srcH || 0);
  if (!srcW || !srcH) {
    const info = await probeVideo(inputPath);
    srcW = info.width;
    srcH = info.height;
  }

  const frameBytes = srcW * srcH * 4;
  const hashProcessedFrame = createProcessedFrameHasher(previewParams, scaleW, scaleH);

  const startBuf = await extractRawFrame(inputPath, startFrame, fps, frameBytes);
  const referenceHash = hashProcessedFrame(startBuf, srcW, srcH);
  const scores = [{ frame: startFrame, score: 0, displayOnly: true }];

  const exclusionFrames = Math.max(minSpacing, earlyFrameExclusion);
  const scanned = await scanRawFrames(inputPath, scanStartFrame, fps, searchCount, frameBytes, (frameBuf, i) => {
    const candidateHash = hashProcessedFrame(frameBuf, srcW, srcH);
    const score = hammingDistance(referenceHash, candidateHash);
    const frameNum = scanStartFrame + i;
    scores.push({
      frame: frameNum,
      score,
      ...(frameNum - startFrame < exclusionFrames ? { displayOnly: true, excluded: 'early_frame_exclusion' } : {}),
    });
  });

  const candidateScores = scores.filter(s => !s.displayOnly);
  const lastFrameIdx = totalFrames - 1;
  const lastScanned = scanned > 0 ? scanStartFrame + scanned - 1 : startFrame;
  const needTail = lastScanned < lastFrameIdx && lastFrameIdx > startFrame;
  const searchEndFrame = totalFrames - 1;

  if (needTail) {
    try {
      const tailBuf = await extractRawFrame(inputPath, lastFrameIdx, fps, frameBytes);
      const tailHash = hashProcessedFrame(tailBuf, srcW, srcH);
      const tailScore = hammingDistance(referenceHash, tailHash);
      const tailEntry = { frame: lastFrameIdx, score: tailScore };
      scores.push(tailEntry);
      candidateScores.push(tailEntry);
      console.log(`  📌 补提尾帧 #${lastFrameIdx} score=${tailScore}`);
    } catch (e) {
      // 尾帧提取失败不影响主结果
    }
  }

  const candidates = pickLoopCandidates(candidateScores, {
    minSpacing,
    earlyFrameExclusion,
    maxCandidates,
    startFrame,
    endFrame: searchEndFrame,
    motionWeight,
  });
  const warnings = buildLoopWarnings(candidates, startFrame, { minSpacing, earlyFrameExclusion, suspiciousCloseThreshold });
  return { candidates, scores, warnings };
}

function createProcessedFrameHasher(previewParams, scaleW, scaleH) {
  const { keying, layout, mode, cleanup, region } = previewParams;
  const { canvasWidth, canvasHeight } = layout;
  const processedCanvas = createCanvas(canvasWidth, canvasHeight);
  const processedCtx = processedCanvas.getContext('2d');
  const hashCanvas = createCanvas(scaleW, scaleH);
  const hashCtx = hashCanvas.getContext('2d');

  return (srcBuffer, srcW, srcH) => {
    const processedFrame = processFrame(srcBuffer, srcW, srcH, keying, layout, mode, cleanup, region);
    const imageData = processedCtx.createImageData(canvasWidth, canvasHeight);
    imageData.data.set(processedFrame);
    processedCtx.putImageData(imageData, 0, 0);

    hashCtx.clearRect(0, 0, scaleW, scaleH);
    hashCtx.drawImage(processedCanvas, 0, 0, scaleW, scaleH);
    const hashData = hashCtx.getImageData(0, 0, scaleW, scaleH);
    return dHashRaw(hashData.data, scaleW, scaleH);
  };
}

function extractRawFrame(inputPath, frameNum, fps, frameBytes) {
  return new Promise((resolve, reject) => {
    const args = [
      '-ss', String(frameNum / fps),
      '-i', inputPath,
      '-f', 'rawvideo',
      '-pix_fmt', 'rgba',
      '-frames:v', '1',
      '-'
    ];
    const proc = spawn(FFMPEG, args);
    let buf = Buffer.alloc(0);
    let err = '';

    proc.stdout.on('data', d => { buf = Buffer.concat([buf, d]); });
    proc.stderr.on('data', d => { err += d.toString(); });
    proc.on('close', code => {
      if (code !== 0 || buf.length < frameBytes) {
        return reject(new Error(`提取帧失败: ${err.slice(0, 200)}`));
      }
      resolve(buf.subarray(0, frameBytes));
    });
    proc.on('error', reject);
  });
}

function scanRawFrames(inputPath, startFrame, fps, frameCount, frameBytes, onFrame) {
  return new Promise((resolve, reject) => {
    const args = [
      '-ss', String(startFrame / fps),
      '-i', inputPath,
      '-f', 'rawvideo',
      '-pix_fmt', 'rgba',
      '-frames:v', String(frameCount),
      '-'
    ];
    const proc = spawn(FFMPEG, args);
    const frameBuf = Buffer.alloc(frameBytes);
    let bytesBuffered = 0;
    let frameIndex = 0;
    let pipelineError = null;
    let err = '';

    proc.stdout.on('data', chunk => {
      if (pipelineError) return;

      let offset = 0;
      while (offset < chunk.length) {
        const remaining = frameBytes - bytesBuffered;
        const toCopy = Math.min(remaining, chunk.length - offset);
        chunk.copy(frameBuf, bytesBuffered, offset, offset + toCopy);
        bytesBuffered += toCopy;
        offset += toCopy;

        if (bytesBuffered === frameBytes) {
          try {
            onFrame(frameBuf, frameIndex);
          } catch (e) {
            pipelineError = e;
            return;
          }
          bytesBuffered = 0;
          frameIndex++;
        }
      }
    });
    proc.stderr.on('data', d => { err += d.toString(); });
    proc.on('close', code => {
      if (pipelineError) return reject(pipelineError);
      if (code !== 0 && frameIndex === 0) {
        return reject(new Error(`扫描帧失败: ${err.slice(0, 200)}`));
      }
      resolve(frameIndex);
    });
    proc.on('error', reject);
  });
}

function findLoopEndFrameRaw(inputPath, startFrame, fps, totalFrames, options = {}) {
  const {
    maxSearch = 300,
    step = 2,
    hashSize = 16,
    minSpacing = 12,
    earlyFrameExclusion = minSpacing,
    maxCandidates = 5,
    motionWeight = 0.35,
    suspiciousCloseThreshold = Math.max(minSpacing * 2, 24)
  } = options;
  const endSearch = Math.min(startFrame + maxSearch, totalFrames);
  // 连续提取：从 startFrame + 1 到 endSearch - 1。
  // startFrame 以及 step 范围内的近邻帧只用于热度展示，不进入候选池。
  const scanStartFrame = startFrame + 1;
  const searchCount = Math.max(0, endSearch - scanStartFrame);
  const scaleW = hashSize + 1;  // 9 for hashSize=8
  const scaleH = hashSize;       // 8
  const frameBytes = scaleW * scaleH * 4; // 288 bytes — 极轻量
  const exclusionFrames = Math.max(minSpacing, earlyFrameExclusion);

  if (searchCount <= 0) {
    return Promise.resolve({
      candidates: [],
      scores: [],
      message: '搜索范围过小'
    });
  }

  return new Promise((resolve, reject) => {
    // 1. 提取起始帧 — 单 -ss 快速定位（17×16 分辨率的微偏几帧可以接受）
    const startArgs = [
      '-ss', String(startFrame / fps),
      '-i', inputPath,
      '-vf', `scale=${scaleW}:${scaleH}`,
      '-vsync', '0',
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

      const referenceHash = dHashRaw(startBuf, scaleW, scaleH);

      // 2. 扫描后续帧 — 单 -ss 批量提取
      const scanArgs = [
        '-ss', String(scanStartFrame / fps),
        '-i', inputPath,
        '-vf', `scale=${scaleW}:${scaleH}`,
        '-vsync', '0',
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
        const scores = [{ frame: startFrame, score: 0, displayOnly: true }];

        const total = Math.min(searchCount, Math.floor(scanBuf.length / frameBytes));
        for (let i = 0; i < total; i++) {
          const offset = i * frameBytes;
          const candidateBuf = scanBuf.subarray(offset, offset + frameBytes);
          const candidateHash = dHashRaw(candidateBuf, scaleW, scaleH);
          // 汉明距离: 0~256，越低越相似
          const score = hammingDistance(referenceHash, candidateHash);
          // ffmpeg -frames:v 输出连续帧，帧号 = scanStartFrame + i
          const frameNum = scanStartFrame + i;
          scores.push({
            frame: frameNum,
            score,
            ...(frameNum - startFrame < exclusionFrames ? { displayOnly: true, excluded: 'early_frame_exclusion' } : {}),
          });
        }

        const candidateScores = scores.filter(s => !s.displayOnly);

        // 2b. 如果最后一帧（总帧数-1）没有被 step 覆盖到，单独补提
        const lastFrameIdx = totalFrames - 1;
        const lastScanned = scores.length > 0 ? scores[scores.length - 1].frame : startFrame;
        const needTail = lastScanned < lastFrameIdx && lastFrameIdx > startFrame;

        // 搜索范围结束帧号
        const searchEndFrame = totalFrames - 1;

        if (!needTail) {
          // 3. 从 scores 中筛选最佳候选
          const candidates = pickLoopCandidates(candidateScores, {
            minSpacing,
            earlyFrameExclusion,
            maxCandidates,
            startFrame,
            endFrame: searchEndFrame,
            motionWeight,
          });
          const warnings = buildLoopWarnings(candidates, startFrame, { minSpacing, earlyFrameExclusion, suspiciousCloseThreshold });
          return resolve({ candidates, scores, warnings });
        }

        // 补提最后一帧
        const tailTime = lastFrameIdx / fps;
        const tailArgs = [
          '-ss', String(tailTime),
          '-i', inputPath,
          '-vf', `scale=${scaleW}:${scaleH}`,
          '-vsync', '0',
          '-f', 'rawvideo',
          '-pix_fmt', 'rgba',
          '-frames:v', '1',
          '-'
        ];
        const tailProc = spawn(FFMPEG, tailArgs);
        let tailBuf = Buffer.alloc(0);
        let tailErr = '';
        tailProc.stdout.on('data', d => { tailBuf = Buffer.concat([tailBuf, d]); });
        tailProc.stderr.on('data', d => { tailErr += d.toString(); });
        tailProc.on('close', () => {
          const finalCandidateScores = [...candidateScores];
          if (tailBuf.length >= frameBytes) {
            const tailHash = dHashRaw(tailBuf.subarray(0, frameBytes), scaleW, scaleH);
            const tailScore = hammingDistance(referenceHash, tailHash);
            const tailEntry = { frame: lastFrameIdx, score: tailScore };
            scores.push(tailEntry);
            finalCandidateScores.push(tailEntry);
            console.log(`  📌 补提尾帧 #${lastFrameIdx} score=${tailScore}`);
          }

          // 3. 从 scores 中筛选最佳候选
          const candidates = pickLoopCandidates(finalCandidateScores, {
            minSpacing,
            earlyFrameExclusion,
            maxCandidates,
            startFrame,
            endFrame: searchEndFrame,
            motionWeight,
          });
          const warnings = buildLoopWarnings(candidates, startFrame, { minSpacing, earlyFrameExclusion, suspiciousCloseThreshold });
          resolve({ candidates, scores, warnings });
        });
        tailProc.on('error', () => {
          // 尾帧提取失败不影响主结果
          const candidates = pickLoopCandidates(candidateScores, {
            minSpacing,
            earlyFrameExclusion,
            maxCandidates,
            startFrame,
            endFrame: searchEndFrame,
            motionWeight,
          });
          const warnings = buildLoopWarnings(candidates, startFrame, { minSpacing, earlyFrameExclusion, suspiciousCloseThreshold });
          resolve({ candidates, scores, warnings });
        });
      });
      scanProc.on('error', reject);
    });
    startProc.on('error', reject);
  });
}

/**
 * 对 raw RGBA 像素数据计算 dHash (Difference Hash)
 *
 * dHash 算法步骤：
 *   1. 接收已缩放到 (hashSize+1)×hashSize 的 RGBA 像素数据
 *   2. 计算每个像素的亮度 (luminance)
 *   3. 对每行比较相邻像素的亮度，左<右 → 1，否则 → 0
 *   4. 得到 hashSize×hashSize bits
 *
 * @param {Buffer|Uint8Array} rawBuf - RGBA 像素数据
 * @param {number} w - 宽度（= hashSize + 1）
 * @param {number} h - 高度（= hashSize）
 * @returns {Buffer} 二进制哈希（大端位序）
 */
function dHashRaw(rawBuf, w, h) {
  const hashBits = (w - 1) * h; // hashSize * hashSize
  const hashBytes = Buffer.alloc(Math.ceil(hashBits / 8));
  let byteIdx = hashBytes.length - 1; // 从最后一个字节开始（大端）
  let bitIdx = 0;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w - 1; x++) {
      const idxL = (y * w + x) * 4;
      const idxR = (y * w + x + 1) * 4;
      const lumL = 0.299 * rawBuf[idxL] + 0.587 * rawBuf[idxL + 1] + 0.114 * rawBuf[idxL + 2];
      const lumR = 0.299 * rawBuf[idxR] + 0.587 * rawBuf[idxR + 1] + 0.114 * rawBuf[idxR + 2];

      if (lumL < lumR) {
        hashBytes[byteIdx] |= (1 << bitIdx);
      }
      bitIdx++;
      if (bitIdx >= 8) {
        bitIdx = 0;
        byteIdx--;
      }
    }
  }

  return hashBytes;
}

/**
 * 计算两个 dHash 之间的汉明距离（越低越相似）
 *
 * 本质上是 XOR 后数 1-bit 的数量。
 */
function hammingDistance(a, b) {
  const len = Math.min(a.length, b.length);
  let dist = 0;
  for (let i = 0; i < len; i++) {
    let xor = a[i] ^ b[i];
    while (xor) {
      dist += xor & 1;
      xor >>= 1;
    }
  }
  return dist;
}

/**
 * 从相似度分数数组中，用「窗口分区 + 最小间距」筛选出最佳候选帧。
 *
 * 策略：
 *   a) 找出所有局部极小值（比左右相邻更相似的帧）
 *   b) 将搜索范围分成 N 个等宽窗口
 *   c) 每个窗口取最佳候选，保证候选覆盖整个时间轴
 *   d) 对距离起始帧太近的候选加惩罚
 *   e) 返回最多 maxCandidates 个候选，按分数排序
 *
 * @param {Array<{frame:number,score:number}>} scores
 * @param {Object} options
 * @param {number} options.minSpacing - 最小帧间距
 * @param {number} options.maxCandidates - 最多返回几个
 * @param {number} options.startFrame - 起始帧号
 * @param {number} options.endFrame - 搜索范围结束帧
 * @returns {Array<{frame:number,score:number}>}
 */
function pickLoopCandidates(scores, {
  minSpacing,
  earlyFrameExclusion = minSpacing,
  maxCandidates,
  startFrame,
  endFrame,
  motionWeight = 0.35,
}) {
  if (scores.length === 0) return [];

  const sf = startFrame ?? 0;
  const minCandidateFrame = sf + Math.max(minSpacing, earlyFrameExclusion);
  const eligibleScores = scores
    .filter(s => s.frame - sf >= minSpacing && s.frame >= minCandidateFrame)
    .sort((a, b) => a.frame - b.frame);
  if (eligibleScores.length === 0) return [];

  // a) 找局部极小值（比左右都低或相等）
  const localMinima = [];
  for (let i = 0; i < eligibleScores.length; i++) {
    const prev = eligibleScores[i - 1];
    const current = eligibleScores[i];
    const next = eligibleScores[i + 1];
    const leftOk = !prev || current.score <= prev.score;
    const rightOk = !next || current.score <= next.score;
    if (leftOk && rightOk) {
      localMinima.push(enrichLoopScore(current, prev, next, motionWeight));
    }
  }
  const pool = localMinima.length > 0
    ? localMinima
    : eligibleScores.map((score, index) => enrichLoopScore(score, eligibleScores[index - 1], eligibleScores[index + 1], motionWeight));

  // b) 分成 N 个等宽窗口（N = maxCandidates），每个窗口取最佳
  const ef = endFrame ?? (pool.length > 0 ? pool[pool.length - 1].frame : sf + 1);
  const searchLen = Math.max(1, ef - minCandidateFrame + 1);
  const windowSize = searchLen / maxCandidates;

  const candidates = [];
  for (let w = 0; w < maxCandidates; w++) {
    const wStart = minCandidateFrame + Math.floor(w * windowSize);
    const wEnd = minCandidateFrame + Math.floor((w + 1) * windowSize);

    // 该窗口内的候选帧（局部极小值 + 距起始帧足够远）
    const inWindow = pool.filter(s =>
      s.frame >= minCandidateFrame &&
      s.frame >= wStart && s.frame < wEnd
    );

    if (inWindow.length === 0) continue;

    // 选窗口内最佳（综合相似度和局部运动/姿态可用性）
    inWindow.sort((a, b) => a.adjustedScore - b.adjustedScore);
    let best = inWindow[0];

    candidates.push({
      frame: best.frame,
      score: best.score,
      adjustedScore: best.adjustedScore,
      motionScore: best.motionScore,
      valleyDepth: best.valleyDepth,
      window: w,
    });
  }

  // 按调整后分数排序，取 top maxCandidates
  candidates.sort((a, b) => a.adjustedScore - b.adjustedScore);
  const topCandidates = candidates.slice(0, maxCandidates);

  // 用 minSpacing 做最终去重
  const deduped = [];
  for (const c of topCandidates) {
    const tooClose = deduped.some(d => Math.abs(d.frame - c.frame) < minSpacing);
    if (!tooClose) {
      deduped.push(c);
    }
  }

  // 按综合分排序返回，保留原始视觉分和运动辅助分
  return deduped
    .sort((a, b) => a.adjustedScore - b.adjustedScore)
    .map(c => ({
      frame: c.frame,
      score: c.score,
      adjustedScore: c.adjustedScore,
      motionScore: c.motionScore,
      valleyDepth: c.valleyDepth,
    }));
}

function enrichLoopScore(score, prev, next, motionWeight) {
  const neighborScores = [prev, next].filter(Boolean).map(s => s.score);
  const valleyDepth = neighborScores.length > 0
    ? Math.max(0, Math.min(...neighborScores) - score.score)
    : 0;
  const neighborMotion = neighborScores.length > 0
    ? neighborScores.reduce((sum, neighborScore) => sum + Math.abs(neighborScore - score.score), 0) / neighborScores.length
    : 0;
  const motionScore = valleyDepth + neighborMotion * 0.25;
  return {
    ...score,
    valleyDepth,
    motionScore,
    adjustedScore: Math.max(0, score.score - motionScore * motionWeight),
  };
}

function buildLoopWarnings(candidates, startFrame, {
  minSpacing,
  earlyFrameExclusion = minSpacing,
  suspiciousCloseThreshold = Math.max(minSpacing * 2, 24),
}) {
  const warnings = [];
  const exclusionFrames = Math.max(minSpacing, earlyFrameExclusion);
  if (candidates.some(candidate => candidate.frame - startFrame < exclusionFrames)) {
    warnings.push(`A candidate violated the ${exclusionFrames}-frame early exclusion window.`);
  }
  const best = candidates[0];
  if (best && best.frame - startFrame <= suspiciousCloseThreshold) {
    warnings.push(`Best loop candidate is only ${best.frame - startFrame} frames after startFrame; inspect it before using as a loop endpoint.`);
  }
  return warnings;
}

module.exports = {
  processVideo,
  probeVideo,
  findLoopEndFrame,
  dHashRaw,
  hammingDistance,
  pickLoopCandidates,
  exportSpriteSheet,
  exportGodotSpriteFrames,
  selectSpriteFrames,
  mergeAlphaBounds,
  cropKeyedToBounds,
};
