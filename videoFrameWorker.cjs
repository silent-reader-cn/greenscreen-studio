const { parentPort, workerData } = require('worker_threads');

const {
  loadAlgorithms,
  getFrameAlphaBounds,
  processFrameWithMetadata,
} = require('./videoProcessor.cjs');

const {
  srcW,
  srcH,
  params,
  outputSize,
  task = 'process-frame',
} = workerData;

let ready = null;

function ensureReady() {
  if (!ready) ready = loadAlgorithms();
  return ready;
}

function toTransferableArrayBuffer(buffer) {
  if (buffer.byteOffset === 0 && buffer.byteLength === buffer.buffer.byteLength) {
    return buffer.buffer;
  }
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
}

parentPort.on('message', async (job) => {
  try {
    await ensureReady();
    const srcBuffer = Buffer.from(job.srcBuffer);
    const jobTask = job.task || task;

    if (jobTask === 'alpha-bounds') {
      const { bounds, processingRegion } = getFrameAlphaBounds(srcBuffer, srcW, srcH, params);
      parentPort.postMessage({
        id: job.id,
        frameIndex: job.frameIndex,
        bounds,
        processingRegion,
      });
      return;
    }

    const processed = processFrameWithMetadata(srcBuffer, srcW, srcH, params, outputSize || undefined);
    const out = processed.buffer;
    const outputBuffer = toTransferableArrayBuffer(out);
    parentPort.postMessage({
      id: job.id,
      frameIndex: job.frameIndex,
      outputBuffer,
      metadata: processed.metadata,
    }, [outputBuffer]);
  } catch (err) {
    parentPort.postMessage({
      id: job.id,
      frameIndex: job.frameIndex,
      error: err.message,
      stack: err.stack,
    });
  }
});
