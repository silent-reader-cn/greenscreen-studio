export function parseExplicitFrameList(value, totalFrames = Infinity) {
  const text = String(value || '').trim()
  if (!text) {
    return { frames: [], invalidTokens: [], outOfRangeFrames: [], duplicatesRemoved: 0 }
  }

  const invalidTokens = []
  const outOfRangeFrames = []
  const seen = new Set()
  const frames = []
  let duplicatesRemoved = 0

  for (const token of text.split(/[\s,]+/)) {
    if (!/^\d+$/.test(token)) {
      invalidTokens.push(token)
      continue
    }

    const frame = Number(token)
    if (!Number.isSafeInteger(frame)) {
      invalidTokens.push(token)
      continue
    }
    if (frame >= totalFrames) {
      outOfRangeFrames.push(frame)
      continue
    }
    if (seen.has(frame)) {
      duplicatesRemoved += 1
      continue
    }
    seen.add(frame)
    frames.push(frame)
  }

  return {
    frames: frames.sort((a, b) => a - b),
    invalidTokens,
    outOfRangeFrames,
    duplicatesRemoved,
  }
}
