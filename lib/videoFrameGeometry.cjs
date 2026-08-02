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

function summarizeFrameBounds(frameEntries, sourceWidth, sourceHeight) {
  const width = Math.max(1, Number(sourceWidth) || 1);
  const height = Math.max(1, Number(sourceHeight) || 1);
  const sourceArea = width * height;
  const diagonal = Math.hypot(width, height);
  const areas = [];
  const foregroundFrames = [];
  const edgeContacts = { left: 0, right: 0, top: 0, bottom: 0 };

  for (const entry of frameEntries || []) {
    const bounds = entry?.bounds || null;
    if (!bounds) continue;
    const boxWidth = Math.max(0, bounds.maxX - bounds.minX + 1);
    const boxHeight = Math.max(0, bounds.maxY - bounds.minY + 1);
    const area = boxWidth * boxHeight;
    const touches = {
      left: bounds.minX <= 1,
      right: bounds.maxX >= width - 2,
      top: bounds.minY <= 1,
      bottom: bounds.maxY >= height - 2,
    };
    for (const side of Object.keys(touches)) {
      if (touches[side]) edgeContacts[side]++;
    }
    areas.push(area / sourceArea);
    foregroundFrames.push({
      frame: entry.frame,
      centerX: (bounds.minX + bounds.maxX) / 2,
      centerY: (bounds.minY + bounds.maxY) / 2,
      bottomY: bounds.maxY,
      area,
      touchesEdge: Object.values(touches).some(Boolean),
    });
  }

  let maxCenterDelta = 0;
  let maxBottomDelta = 0;
  let maxAreaChangeRatio = 0;
  for (let index = 1; index < foregroundFrames.length; index++) {
    const previous = foregroundFrames[index - 1];
    const current = foregroundFrames[index];
    if (Number(current.frame) !== Number(previous.frame) + 1) continue;
    maxCenterDelta = Math.max(maxCenterDelta, Math.hypot(
      current.centerX - previous.centerX,
      current.centerY - previous.centerY,
    ));
    maxBottomDelta = Math.max(maxBottomDelta, Math.abs(current.bottomY - previous.bottomY));
    maxAreaChangeRatio = Math.max(
      maxAreaChangeRatio,
      Math.abs(current.area - previous.area) / Math.max(1, previous.area),
    );
  }

  return {
    sampleFrameCount: (frameEntries || []).length,
    foregroundFrameCount: foregroundFrames.length,
    foregroundAreaRatio: {
      min: areas.length ? Math.min(...areas) : 0,
      max: areas.length ? Math.max(...areas) : 0,
      mean: areas.length ? areas.reduce((sum, value) => sum + value, 0) / areas.length : 0,
    },
    edgeContacts: {
      ...edgeContacts,
      frameCount: foregroundFrames.filter((entry) => entry.touchesEdge).length,
    },
    feet: {
      maxBottomDelta,
      maxBottomDeltaRatio: maxBottomDelta / height,
    },
    jitter: {
      maxCenterDelta,
      maxCenterDeltaRatio: maxCenterDelta / diagonal,
      maxAreaChangeRatio,
    },
  };
}

module.exports = {
  clamp,
  normalizeRegionForSize,
  isFullRegion,
  cropImageDataToRegion,
  getProcessingRegionMetadata,
  mergeAlphaBounds,
  clampAlphaBounds,
  cropKeyedToBounds,
  boundsToCropBox,
  summarizeFrameBounds,
};
