import { parseAnimationBaseName } from './directionPack.js'

const DIRECTION_TOKEN = /\b(SE|NE|SW|NW|S|N|E|W)\b/i
const SOURCE_DIRECTIONS = new Set(['SE', 'NE', 'S', 'N', 'E', 'W'])

/**
 * Infer direction suffix from a video filename.
 * Accepts: walk_SE.mp4, walk-SE.mp4, SE_walk.mp4, walk SE.mp4, walkSE.mp4
 */
export function detectDirectionFromFilename(filename) {
  const base = String(filename || '')
    .replace(/\\/g, '/')
    .split('/')
    .pop()
    .replace(/\.[^.]+$/, '')
  if (!base) return null

  const parsed = parseAnimationBaseName(base)
  if (parsed.direction) return parsed.direction

  const token = base.match(DIRECTION_TOKEN)
  if (token) return token[1].toUpperCase()

  const glued = base.match(/(?:^|[^A-Za-z])(SE|NE|SW|NW|S|N|E|W)(?:[^A-Za-z]|$)/i)
  if (glued) return glued[1].toUpperCase()

  return null
}

/**
 * Infer action base name from a video filename, stripping a direction token when present.
 */
export function detectActionBaseFromFilename(filename, fallback = 'animation') {
  const base = String(filename || '')
    .replace(/\\/g, '/')
    .split('/')
    .pop()
    .replace(/\.[^.]+$/, '')
    .trim()
  if (!base) return fallback

  const parsed = parseAnimationBaseName(base)
  if (parsed.direction && parsed.base) return parsed.base

  const cleaned = base
    .replace(/[_\-\s.]?(SE|NE|SW|NW)(?=$|[_\-\s.])/ig, '')
    .replace(/[_\-\s.]?\b(S|N|E|W)\b(?=$|[_\-\s.])/ig, '')
    .replace(/[_\-\s.]+$/g, '')
    .replace(/^[_\-\s.]+/g, '')
    .trim()

  return cleaned || fallback
}

/**
 * Classify dropped/selected video files for direction-pack import.
 * Returns ordered source candidates (SE before NE when both present).
 */
export function classifyDirectionVideos(files = []) {
  const list = Array.from(files || []).filter(Boolean)
  const items = list.map((file, index) => {
    const name = file.name || `video_${index + 1}`
    const direction = detectDirectionFromFilename(name)
    const actionBase = detectActionBaseFromFilename(name, 'animation')
    return {
      file,
      name,
      direction,
      actionBase,
      isSourceDirection: direction ? SOURCE_DIRECTIONS.has(direction) : false,
    }
  })

  const withDirection = items.filter(item => item.direction)
  const withoutDirection = items.filter(item => !item.direction)
  const sourceItems = withDirection.filter(item => item.isSourceDirection)
  const mirrorOnly = withDirection.filter(item => !item.isSourceDirection)

  const preferredOrder = ['SE', 'NE', 'S', 'E', 'N', 'W']
  sourceItems.sort((a, b) => {
    const ai = preferredOrder.indexOf(a.direction)
    const bi = preferredOrder.indexOf(b.direction)
    return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi)
  })

  const actionBases = [...new Set(sourceItems.map(item => item.actionBase).filter(Boolean))]
  const directions = [...new Set(sourceItems.map(item => item.direction))]

  return {
    items,
    sourceItems,
    mirrorOnly,
    withoutDirection,
    actionBase: actionBases[0] || null,
    directions,
    canAutoPack: sourceItems.length >= 1,
    isMulti: list.length > 1,
  }
}
