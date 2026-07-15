/**
 * 绿幕素材标准化工具 — Express 后端
 *
 * 功能：
 *   POST /api/export  接收原图+参数，返回处理后的 PNG
 *
 * 技术栈：Express + node-canvas + multer(文件上传)
 */

const express = require('express');
const multer = require('multer');
const { createCanvas, Image } = require('canvas');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { processVideo, probeVideo, findLoopEndFrame, exportSpriteSheet } = require('./videoProcessor.cjs');

// 加载 polyfill（必须在引入 keying.js 之前）
require('./src/lib/canvas-polyfill.js');

// keying.js 是 ES module，需要动态 import
let applyKeying, composeToCanvas, autoCropKeyed;

const app = express();
const PORT = process.env.PORT ? parseInt(process.env.PORT) : 20003;

// multer 配置：内存存储（图片），限制 500MB 以支持视频
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 500 * 1024 * 1024 }
});

// 视频用磁盘存储（大文件不适合内存）
const tmpDir = path.join(os.tmpdir(), 'greenscreen-studio');
if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

const videoUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, tmpDir),
    filename: (req, file, cb) => cb(null, `upload_${Date.now()}_${file.originalname}`),
  }),
  limits: { fileSize: 500 * 1024 * 1024 }
});

// 静态文件（生产环境服务 dist）
app.use(express.json({ limit: '50mb' }));

// CORS（开发环境 vite 在 5174）
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

/**
 * POST /api/export
 * multipart/form-data:
 *   image: 原图文件
 *   params: JSON 字符串，包含 keying + layout 参数
 *
 * 返回：PNG 图片（直接以 image/png 返回）
 */
app.post('/api/export', upload.single('image'), async (req, res) => {
  try {
    if (!applyKeying) {
      const mod = await import('./src/lib/keying.js');
      applyKeying = mod.applyKeying;
      composeToCanvas = mod.composeToCanvas;
      autoCropKeyed = mod.autoCropKeyed;
    }

    if (!req.file) {
      return res.status(400).json({ error: '未提供图片文件' });
    }

    const params = JSON.parse(req.body.params);

    // 1. 加载原图
    const img = new Image();
    img.src = req.file.buffer;

    // 2. 在 canvas 上绘制原图，获取 ImageData
    const srcCanvas = createCanvas(img.width, img.height);
    const srcCtx = srcCanvas.getContext('2d');
    srcCtx.drawImage(img, 0, 0);
    const srcImageData = srcCtx.getImageData(0, 0, img.width, img.height);

    // 3. 抠像
    let keyedData = applyKeying(srcImageData, params.keying);

    // 3.5 自动裁剪（如果开启，默认开）
    if (params.layout.autoCrop !== false) {
      keyedData = autoCropKeyed(keyedData);
    }

    // 4. 创建目标画布
    const { canvasWidth, canvasHeight } = params.layout;
    const outCanvas = createCanvas(canvasWidth, canvasHeight);
    const outCtx = outCanvas.getContext('2d');

    // 5. 合成（抠像人物 → 绿幕画布）
    const tempCanvas = createCanvas(100, 100); // 临时画布（composeToCanvas 会 resize）
    const result = composeToCanvas(outCtx, keyedData, params.layout, tempCanvas, params.keying?.keyColor);

    // 6. 根据 mode 决定输出
    const mode = params.mode || 'greenscreen'; // 'greenscreen' | 'transparent'

    let outputBuffer;
    if (mode === 'transparent') {
      // 透明模式：只输出抠像后的人物（等比缩放到 personWidth×personHeight，居中于画布）
      const transCanvas = createCanvas(canvasWidth, canvasHeight);
      const transCtx = transCanvas.getContext('2d');
      // 临时画布放抠像结果
      tempCanvas.width = keyedData.width;
      tempCanvas.height = keyedData.height;
      const tempCtx2 = tempCanvas.getContext('2d');
      const transImgData = tempCtx2.createImageData(keyedData.width, keyedData.height);
      transImgData.data.set(keyedData.data);
      tempCtx2.putImageData(transImgData, 0, 0);
      // 等比缩放 + 居中
      const scaleX = params.layout.personWidth / keyedData.width;
      const scaleY = params.layout.personHeight / keyedData.height;
      const scale = Math.min(scaleX, scaleY);
      const sw = Math.round(keyedData.width * scale);
      const sh = Math.round(keyedData.height * scale);
      const ox = Math.round((canvasWidth - sw) / 2);
      const oy = Math.round((canvasHeight - sh) / 2);
      transCtx.drawImage(tempCanvas, ox, oy, sw, sh);
      outputBuffer = transCanvas.toBuffer('image/png');
    } else {
      // 绿幕合成模式
      outputBuffer = outCanvas.toBuffer('image/png');
    }

    // 7. 返回
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Content-Disposition', `attachment; filename="export_${Date.now()}.png"`);
    res.send(outputBuffer);

    console.log(`✓ 导出成功: ${canvasWidth}×${canvasHeight} ${mode} | 缩放: ${result.scaledW}×${result.scaledH}`);
  } catch (err) {
    console.error('导出失败:', err);
    res.status(500).json({ error: err.message });
  }
});

// ===== 视频接口 =====

// 视频任务状态存储（内存，进程级）
const videoJobs = new Map();

/**
 * POST /api/video/upload
 * 上传视频文件，返回 jobId + 视频信息（尺寸、fps、时长、是否有音轨）
 */
app.post('/api/video/upload', videoUpload.single('video'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: '未提供视频文件' });

    const info = await probeVideo(req.file.path);
    const jobId = `vid_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    videoJobs.set(jobId, {
      status: 'uploaded',
      inputPath: req.file.path,
      info,
      createdAt: Date.now(),
    });

    console.log(`  📹 视频上传: ${jobId} | ${info.width}×${info.height} @ ${info.fps}fps, ${info.duration.toFixed(1)}s`);

    res.json({
      jobId,
      width: info.width,
      height: info.height,
      fps: info.fps,
      duration: info.duration,
      hasAudio: info.hasAudio,
      frameCount: info.frameCount,
    });
  } catch (err) {
    console.error('视频上传失败:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/video/process
 * 开始处理视频。body: { jobId, params, format }
 *   params: { keying, layout, mode }
 *   format: 'webm' | 'mov' | 'mp4' | 'gif'
 * 返回 { taskId } 用于轮询进度
 */
app.post('/api/video/process', express.json({ limit: '10mb' }), (req, res) => {
  const { jobId, params, format, range } = req.body;
  const job = videoJobs.get(jobId);
  if (!job) return res.status(404).json({ error: 'job not found' });

  const taskId = `task_${Date.now()}`;
  const ext = String(format || (params.mode === 'transparent' ? 'webm' : 'mp4')).toLowerCase();
  const outputPath = path.join(tmpDir, `output_${taskId}.${ext}`).replace(/\\/g, '/');

  // 计算帧范围（用于初始进度显示）
  const info = job.info;
  const totalFrames = info.frameCount || Math.round(info.fps * info.duration);
  const startFrame = range?.startFrame ?? 0;
  const endFrame = range?.endFrame ?? totalFrames;
  const processFrameCount = endFrame - startFrame;

  job.taskId = taskId;
  job.status = 'processing';
  job.progress = { current: 0, total: processFrameCount, percent: 0 };
  job.outputPath = outputPath;
  job.outputFormat = ext;
  job.error = null;
  job.range = range || null;

  // 如果有 range，合并到 params 中传给 processVideo
  if (range) {
    params.range = range;
  }

  // 异步处理（不阻塞响应）
  processVideo(job.inputPath, outputPath, params, (current, total) => {
    const percent = total > 0 ? Math.round((current / total) * 100) : 0;
    job.progress = { current, total, percent };
  })
    .then(result => {
      job.status = 'done';
      job.result = result;
      const rangeInfo = range ? ` [${range.startFrame}-${range.endFrame}帧]` : '';
      console.log(`  ✅ 视频处理完成: ${jobId} | ${result.frameCount} frames${rangeInfo}`);
    })
    .catch(err => {
      job.status = 'error';
      job.error = err.message;
      console.error(`  ❌ 视频处理失败: ${jobId}`, err.message);
    });

  res.json({ taskId, jobId });
});

/**
 * GET /api/video/progress/:taskId
 * 轮询处理进度
 */
app.get('/api/video/progress/:taskId', (req, res) => {
  // 通过 taskId 找 job
  let job = null;
  for (const [_, j] of videoJobs) {
    if (j.taskId === req.params.taskId) { job = j; break; }
  }
  if (!job) return res.status(404).json({ error: 'task not found' });

  res.json({
    status: job.status,
    progress: job.progress,
    error: job.error,
    result: job.result,
  });
});

/**
 * GET /api/video/preview/:jobId
 * 预览处理完成的视频/动图，不清理临时文件。
 */
app.get('/api/video/preview/:jobId', (req, res) => {
  const job = videoJobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'job not found' });
  if (job.status !== 'done') return res.status(400).json({ error: `job status: ${job.status}` });
  if (!fs.existsSync(job.outputPath)) return res.status(404).json({ error: 'output file not found' });

  res.setHeader('Content-Type', getVideoMime(job.outputFormat));
  const stream = fs.createReadStream(job.outputPath);
  stream.pipe(res);
});

/**
 * GET /api/video/download/:jobId
 * 下载处理完成的视频
 */
app.get('/api/video/download/:jobId', (req, res) => {
  const job = videoJobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'job not found' });
  if (job.status !== 'done') return res.status(400).json({ error: `job status: ${job.status}` });
  if (!fs.existsSync(job.outputPath)) return res.status(404).json({ error: 'output file not found' });

  const filename = `export_${job.outputFormat}_${Date.now()}.${job.outputFormat}`;
  res.setHeader('Content-Type', getVideoMime(job.outputFormat));
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  const stream = fs.createReadStream(job.outputPath);
  stream.pipe(res);
  stream.on('close', () => {
    // 下载完后清理（延迟，避免文件被删太快）
    setTimeout(() => {
      try {
        fs.unlinkSync(job.outputPath);
        fs.unlinkSync(job.inputPath);
        videoJobs.delete(req.params.jobId);
      } catch (e) {}
    }, 5000);
  });
});

/**
 * POST /api/video/find-loop-end
 * 自动检测与起始帧最相似的循环终点帧
 * body: { jobId, startFrame, params?: { keying, layout, mode? }, options?: { maxSearch?, step?, hashSize? } }
 */
app.post('/api/video/find-loop-end', express.json({ limit: '1mb' }), async (req, res) => {
  try {
    const { jobId, startFrame, params, options } = req.body;
    const job = videoJobs.get(jobId);
    if (!job) return res.status(404).json({ error: 'job not found' });

    const { info } = job;
    const fps = info.fps;
    const totalFrames = info.frameCount || Math.round(fps * info.duration);

    if (startFrame == null || startFrame < 0 || startFrame >= totalFrames - 1) {
      return res.status(400).json({ error: '无效的起始帧号' });
    }

    console.log(`  🔍 检测循环帧: ${jobId} 起始帧=${startFrame}, 总帧=${totalFrames}`);

    const result = await findLoopEndFrame(
      job.inputPath,
      startFrame,
      fps,
      totalFrames,
      {
        ...(options || {}),
        params,
        sourceWidth: info.width,
        sourceHeight: info.height,
      }
    );

    const top = result.candidates[0] || null;
    console.log(`  ✅ 找到 ${result.candidates.length} 个候选: ${
      result.candidates.map(c => `#${c.frame}(${c.score.toFixed(0)})`).join(', ')
    }`);

    res.json(result);
  } catch (err) {
    console.error('  ❌ 循环帧检测失败:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/video/export-spritesheet
 * 导出精灵图 PNG。body: { jobId, params: { keying, layout }, spriteParams }
 */
app.post('/api/video/export-spritesheet', express.json({ limit: '10mb' }), async (req, res) => {
  try {
    const { jobId, params, spriteParams } = req.body;
    const job = videoJobs.get(jobId);
    if (!job) return res.status(404).json({ error: 'job not found' });

    const { frameWidth, frameHeight, framesPerRow } = spriteParams || {};
    if (!frameWidth || !frameHeight || !framesPerRow) {
      return res.status(400).json({ error: 'frameWidth, frameHeight, framesPerRow 为必填参数' });
    }
    if (frameWidth < 8 || frameHeight < 8 || framesPerRow < 1) {
      return res.status(400).json({ error: 'frameWidth/frameHeight 最小 8px，framesPerRow 最小 1' });
    }

    job.status = 'processing';
    job.progress = { current: 0, total: 0, percent: 0 };
    job.error = null;

    console.log(`  🖼️ 精灵图导出: ${jobId} | 格子 ${frameWidth}×${frameHeight}, ${framesPerRow}列`);

    const result = await exportSpriteSheet(job.inputPath, params, spriteParams, (current, total) => {
      const percent = total > 0 ? Math.round((current / total) * 100) : 0;
      job.progress = { current, total, percent };
    });

    job.status = 'done';
    job.progress = { current: result.frameCount, total: result.frameCount, percent: 100 };

    const filename = `spritesheet_${Date.now()}.png`;
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(result.buffer);

    console.log(`  🖼️✅ 精灵图导出完成: ${result.frameCount}帧, ${result.sheetWidth}×${result.sheetHeight}`);
  } catch (err) {
    console.error('精灵图导出失败:', err);
    const job = videoJobs.get(req.body?.jobId);
    if (job) {
      job.status = 'error';
      job.error = err.message;
    }
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

function getVideoMime(ext) {
  const map = { webm: 'video/webm', mov: 'video/quicktime', mp4: 'video/mp4', gif: 'image/gif' };
  return map[ext] || 'application/octet-stream';
}

// 健康检查
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

// 生产环境服务前端静态文件
const distPath = path.join(__dirname, 'dist');
if (fs.existsSync(distPath)) {
  app.use(express.static(distPath));
  app.get('*', (req, res) => {
    if (!req.path.startsWith('/api')) {
      res.sendFile(path.join(distPath, 'index.html'));
    }
  });
}

// 仅当作为主进程运行时才启动 listen（被 Electron require 时不启动）
if (require.main === module) {
  const port = process.env.PORT ? parseInt(process.env.PORT) : 20003;
  app.listen(port, () => {
    console.log(`\n  🟢 绿幕工具后端已启动: http://localhost:${port}`);
    console.log(`  📁 项目路径: ${__dirname}\n`);
  });
}

// 导出给 Electron 主进程 require
module.exports = { app, defaultPort: 3001 };
