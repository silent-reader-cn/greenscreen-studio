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
    composeToCanvas(ctx, keyed, layout, tempCanvas, keying?.keyColor);

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
 */
async function exportSpriteSheet(inputPath, params, spriteParams, onProgress) {
  await loadAlgorithms();

  const { keying, layout } = params;
  const { frameWidth, frameHeight, framesPerRow, maxFrames = Infinity, sampleEvery = 1 } = spriteParams;

  const info = await probeVideo(inputPath);
  const { width: srcW, height: srcH, fps, duration } = info;
  const totalFrames = info.frameCount || Math.round(fps * duration);
  const maxSampledFrames = Math.ceil(totalFrames / sampleEvery);
  const maxToProcess = Math.min(maxFrames, maxSampledFrames);
  const cols = framesPerRow;
  const rows = Math.ceil(maxToProcess / cols);
  const sheetWidth = cols * frameWidth;
  const sheetHeight = rows * frameHeight;

  console.log(`  📹 精灵图导出: ${srcW}×${srcH} @ ${fps}fps, 总${totalFrames}帧 每${sampleEvery}帧采样 → ${maxToProcess}帧, ${cols}×${rows}=${sheetWidth}×${sheetHeight}`);

  const sheetCanvas = createCanvas(sheetWidth, sheetHeight);
  const sheetCtx = sheetCanvas.getContext('2d');

  const extractArgs = ['-i', inputPath, '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'];
  const extractor = spawn(FFMPEG, extractArgs);

  const frameSize = srcW * srcH * 4;
  const srcBuffer = Buffer.alloc(frameSize);

  let frameIndex = 0;
  let inputFrameIndex = 0;
  let bytesBuffered = 0;
  let pipelineError = null;

  return new Promise((resolve, reject) => {
    extractor.stdout.on('data', chunk => {
      if (pipelineError || frameIndex >= maxToProcess) return;

      let offset = 0;
      while (offset < chunk.length && frameIndex < maxToProcess) {
        const remaining = frameSize - bytesBuffered;
        const toCopy = Math.min(remaining, chunk.length - offset);
        chunk.copy(srcBuffer, bytesBuffered, offset, offset + toCopy);
        bytesBuffered += toCopy;
        offset += toCopy;

        if (bytesBuffered === frameSize) {
          const shouldSample = inputFrameIndex % sampleEvery === 0;
          inputFrameIndex++;

          if (shouldSample) {
            try {
              const srcData = {
                data: new Uint8ClampedArray(srcBuffer),
                width: srcW,
                height: srcH,
              };
              let keyed = applyKeying(srcData, keying);
              if (layout.autoCrop !== false) {
                keyed = autoCropKeyed(keyed);
              }

              const tempCanvas = createCanvas(keyed.width, keyed.height);
              const tempCtx = tempCanvas.getContext('2d');
              const imgData = tempCtx.createImageData(keyed.width, keyed.height);
              imgData.data.set(keyed.data);
              tempCtx.putImageData(imgData, 0, 0);

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

      onProgress && onProgress(frameIndex, maxToProcess);
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
  };
}

async function findLoopEndFrameProcessed(inputPath, startFrame, fps, totalFrames, options = {}, previewParams) {
  await loadAlgorithms();

  const {
    maxSearch = 300,
    step = 2,
    hashSize = 16,
    minSpacing = 12,
    maxCandidates = 5
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

  const scanned = await scanRawFrames(inputPath, scanStartFrame, fps, searchCount, frameBytes, (frameBuf, i) => {
    const candidateHash = hashProcessedFrame(frameBuf, srcW, srcH);
    const score = hammingDistance(referenceHash, candidateHash);
    const frameNum = scanStartFrame + i;
    scores.push({
      frame: frameNum,
      score,
      ...(frameNum < startFrame + step ? { displayOnly: true } : {}),
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

  const candidates = pickLoopCandidates(candidateScores, { minSpacing, maxCandidates, startFrame, endFrame: searchEndFrame });
  return { candidates, scores };
}

function createProcessedFrameHasher(previewParams, scaleW, scaleH) {
  const { keying, layout, mode } = previewParams;
  const { canvasWidth, canvasHeight } = layout;
  const processedCanvas = createCanvas(canvasWidth, canvasHeight);
  const processedCtx = processedCanvas.getContext('2d');
  const hashCanvas = createCanvas(scaleW, scaleH);
  const hashCtx = hashCanvas.getContext('2d');

  return (srcBuffer, srcW, srcH) => {
    const processedFrame = processFrame(srcBuffer, srcW, srcH, keying, layout, mode);
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
    maxCandidates = 5
  } = options;
  const endSearch = Math.min(startFrame + maxSearch, totalFrames);
  // 连续提取：从 startFrame + 1 到 endSearch - 1。
  // startFrame 以及 step 范围内的近邻帧只用于热度展示，不进入候选池。
  const scanStartFrame = startFrame + 1;
  const searchCount = Math.max(0, endSearch - scanStartFrame);
  const scaleW = hashSize + 1;  // 9 for hashSize=8
  const scaleH = hashSize;       // 8
  const frameBytes = scaleW * scaleH * 4; // 288 bytes — 极轻量

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
            ...(frameNum < startFrame + step ? { displayOnly: true } : {}),
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
          const candidates = pickLoopCandidates(candidateScores, { minSpacing, maxCandidates, startFrame, endFrame: searchEndFrame });
          return resolve({ candidates, scores });
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
          const candidates = pickLoopCandidates(finalCandidateScores, { minSpacing, maxCandidates, startFrame, endFrame: searchEndFrame });
          resolve({ candidates, scores });
        });
        tailProc.on('error', () => {
          // 尾帧提取失败不影响主结果
          const candidates = pickLoopCandidates(candidateScores, { minSpacing, maxCandidates, startFrame, endFrame: searchEndFrame });
          resolve({ candidates, scores });
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
function pickLoopCandidates(scores, { minSpacing, maxCandidates, startFrame, endFrame }) {
  if (scores.length === 0) return [];

  // a) 找局部极小值（比左右都低或相等）
  const localMinima = [];
  for (let i = 1; i < scores.length - 1; i++) {
    if (scores[i].score <= scores[i - 1].score && scores[i].score <= scores[i + 1].score) {
      localMinima.push(scores[i]);
    }
  }
  const pool = localMinima.length > 0 ? localMinima : scores;

  // b) 分成 N 个等宽窗口（N = maxCandidates），每个窗口取最佳
  const sf = startFrame ?? 0;
  const ef = endFrame ?? (pool.length > 0 ? pool[pool.length - 1].frame : sf + 1);
  const searchLen = ef - sf;
  const windowSize = searchLen / maxCandidates;

  const candidates = [];
  for (let w = 0; w < maxCandidates; w++) {
    const wStart = sf + Math.floor(w * windowSize);
    const wEnd = sf + Math.floor((w + 1) * windowSize);

    // 该窗口内的候选帧（局部极小值 + 距起始帧足够远）
    const inWindow = pool.filter(s =>
      s.frame > sf + 1 &&           // 跳过紧邻起始帧
      s.frame >= wStart && s.frame < wEnd
    );

    if (inWindow.length === 0) continue;

    // 选窗口内最佳（原始分最低）
    inWindow.sort((a, b) => a.score - b.score);
    let best = inWindow[0];

    // d) 距离惩罚：距起始帧太近的帧不可能是循环终点
    const dist = best.frame - sf;
    let penalty = 0;
    if (dist > 0 && dist < minSpacing) {
      penalty = best.score * 0.5 * (1 - dist / minSpacing);
    }

    candidates.push({
      frame: best.frame,
      score: best.score,
      adjusted: best.score + penalty,
      window: w,
    });
  }

  // 按调整后分数排序，取 top maxCandidates
  candidates.sort((a, b) => a.adjusted - b.adjusted);
  const topCandidates = candidates.slice(0, maxCandidates);

  // 用 minSpacing 做最终去重
  const deduped = [];
  for (const c of topCandidates) {
    const tooClose = deduped.some(d => Math.abs(d.frame - c.frame) < minSpacing);
    if (!tooClose) {
      deduped.push(c);
    }
  }

  // 按原始分排序返回
  return deduped.sort((a, b) => a.score - b.score).map(c => ({ frame: c.frame, score: c.score }));
}

module.exports = { processVideo, probeVideo, findLoopEndFrame, dHashRaw, hammingDistance, pickLoopCandidates, exportSpriteSheet };
