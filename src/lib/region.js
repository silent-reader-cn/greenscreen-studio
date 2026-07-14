export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

export function normalizeRegion(region, imageData) {
  if (!region || !imageData) return null

  const rawX = Number(region.x)
  const rawY = Number(region.y)
  const rawWidth = Number(region.width)
  const rawHeight = Number(region.height)
  if (![rawX, rawY, rawWidth, rawHeight].every(Number.isFinite)) return null

  const x = clamp(Math.floor(rawX), 0, imageData.width)
  const y = clamp(Math.floor(rawY), 0, imageData.height)
  const width = clamp(Math.ceil(rawWidth), 0, imageData.width - x)
  const height = clamp(Math.ceil(rawHeight), 0, imageData.height - y)

  if (width <= 0 || height <= 0) return null
  return { x, y, width, height }
}

export function makeRegionFromPoints(start, end, imageData) {
  if (!start || !end || !imageData) return null

  const x1 = clamp(Math.floor(Math.min(start.x, end.x)), 0, imageData.width)
  const y1 = clamp(Math.floor(Math.min(start.y, end.y)), 0, imageData.height)
  const x2 = clamp(Math.ceil(Math.max(start.x, end.x)), 0, imageData.width)
  const y2 = clamp(Math.ceil(Math.max(start.y, end.y)), 0, imageData.height)

  return normalizeRegion({
    x: x1,
    y: y1,
    width: x2 - x1,
    height: y2 - y1,
  }, imageData)
}

export function cropImageData(imageData, region) {
  const normalized = normalizeRegion(region, imageData)
  if (!normalized) return imageData
  if (
    normalized.x === 0 &&
    normalized.y === 0 &&
    normalized.width === imageData.width &&
    normalized.height === imageData.height
  ) {
    return imageData
  }

  const { x: cropX, y: cropY, width: cropW, height: cropH } = normalized
  const cropped = new Uint8ClampedArray(cropW * cropH * 4)

  for (let y = 0; y < cropH; y++) {
    const srcRow = ((cropY + y) * imageData.width + cropX) * 4
    const dstRow = y * cropW * 4
    cropped.set(imageData.data.subarray(srcRow, srcRow + cropW * 4), dstRow)
  }

  return { data: cropped, width: cropW, height: cropH }
}

export function getRegionOverlayStyle(region, imageData) {
  const normalized = normalizeRegion(region, imageData)
  if (!normalized || !imageData) return null

  return {
    left: `${(normalized.x / imageData.width) * 100}%`,
    top: `${(normalized.y / imageData.height) * 100}%`,
    width: `${(normalized.width / imageData.width) * 100}%`,
    height: `${(normalized.height / imageData.height) * 100}%`,
  }
}
