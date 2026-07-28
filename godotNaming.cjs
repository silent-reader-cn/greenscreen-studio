const DIRECTION_SUFFIXES = ['SE', 'NE', 'SW', 'NW', 'S', 'N', 'E', 'W']

function sanitizeNamePart(value, fallback = '') {
  const cleaned = String(value || '')
    .normalize('NFKC')
    .replace(/[^\w\u4e00-\u9fff-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
  return cleaned || fallback
}

function parseAnimationBaseName(name) {
  const text = String(name || '').trim()
  if (!text) return { base: '', direction: null, fullName: '' }

  for (const direction of DIRECTION_SUFFIXES) {
    const suffix = `_${direction}`
    if (text.endsWith(suffix) && text.length > suffix.length) {
      return {
        base: text.slice(0, -suffix.length),
        direction,
        fullName: text,
      }
    }
  }

  return { base: text, direction: null, fullName: text }
}

/**
 * Build a filesystem-safe Godot export basename.
 *
 * Preferred shape:
 * - multi animation pack: character_action
 * - single animation: character_action[_direction]
 *
 * Falls back to exportName, then animation names, then fallbackPrefix.
 */
function buildGodotExportBasename({
  characterName,
  actionName,
  animationNames = [],
  exportName,
  fallbackPrefix = 'godot_export',
} = {}) {
  const explicit = sanitizeNamePart(exportName)
  if (explicit) return explicit

  const names = (Array.isArray(animationNames) ? animationNames : [])
    .map(name => String(name || '').trim())
    .filter(Boolean)

  const parsedNames = names.map(parseAnimationBaseName)
  const sharedBase = parsedNames.length > 0
    ? parsedNames.every(item => item.base && item.base === parsedNames[0].base)
      ? parsedNames[0].base
      : ''
    : ''

  const character = sanitizeNamePart(characterName)
  const action = sanitizeNamePart(actionName || sharedBase)

  if (character && action) {
    if (names.length === 1 && parsedNames[0].direction) {
      return `${character}_${action}_${parsedNames[0].direction}`
    }
    return `${character}_${action}`
  }

  if (action && names.length === 1 && parsedNames[0].direction) {
    return `${action}_${parsedNames[0].direction}`
  }
  if (action) return action

  if (names.length === 1) {
    return sanitizeNamePart(names[0], fallbackPrefix)
  }
  if (sharedBase) return sanitizeNamePart(sharedBase, fallbackPrefix)

  return sanitizeNamePart(fallbackPrefix, 'godot_export')
}

module.exports = {
  DIRECTION_SUFFIXES,
  sanitizeNamePart,
  parseAnimationBaseName,
  buildGodotExportBasename,
}
