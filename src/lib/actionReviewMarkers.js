export const MARKER_TYPES = Object.freeze([
  'clip_start',
  'clip_end',
  'loop_start',
  'loop_end',
  'windup_end',
  'active_start',
  'hit',
  'active_end',
  'recovery_start',
  'cancel_open',
  'sfx',
  'vfx',
  'camera',
  'note',
])

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object || {}, key)
}

function toFrame(value) {
  const frame = Math.round(Number(value))
  return Number.isFinite(frame) ? frame : null
}

export function normalizeMarkerFrame(value, clip) {
  const frame = toFrame(value)
  if (frame == null) return { ok: false, error: 'frame_invalid' }
  const startFrame = toFrame(clip?.startFrame)
  const endFrame = toFrame(clip?.endFrame)
  if (startFrame == null || endFrame == null || frame < startFrame || frame >= endFrame) {
    return { ok: false, error: 'frame_outside_clip' }
  }
  return { ok: true, frame }
}

export function parseMarkerPayload(value) {
  if (value == null || value === '') return { ok: true, payload: {} }
  let payload = value
  if (typeof value === 'string') {
    try {
      payload = JSON.parse(value)
    } catch {
      return { ok: false, error: 'payload_invalid_json' }
    }
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { ok: false, error: 'payload_not_object' }
  }
  return { ok: true, payload }
}

function normalizeMarkerType(type) {
  const value = String(type || '')
  return MARKER_TYPES.includes(value) ? { ok: true, type: value } : { ok: false, error: 'type_invalid' }
}

export function buildCreateMarkerPayload(input = {}, { clip } = {}) {
  const frame = normalizeMarkerFrame(input.frame, clip)
  if (!frame.ok) return frame
  const type = normalizeMarkerType(input.type)
  if (!type.ok) return type
  const payload = parseMarkerPayload(hasOwn(input, 'payloadText') ? input.payloadText : input.payload)
  if (!payload.ok) return payload
  return {
    ok: true,
    payload: {
      frame: frame.frame,
      type: type.type,
      label: String(input.label || '').trim(),
      payload: payload.payload,
    },
  }
}

export function buildUpdateMarkerPayload(patch = {}, { clip, current = {} } = {}) {
  const next = {}
  if (hasOwn(patch, 'frame')) {
    const frame = normalizeMarkerFrame(patch.frame, clip)
    if (!frame.ok) return frame
    next.frame = frame.frame
  }
  if (hasOwn(patch, 'type')) {
    const type = normalizeMarkerType(patch.type)
    if (!type.ok) return type
    next.type = type.type
  }
  if (hasOwn(patch, 'label')) next.label = String(patch.label || '').trim()
  if (hasOwn(patch, 'payloadText') || hasOwn(patch, 'payload')) {
    const payload = parseMarkerPayload(hasOwn(patch, 'payloadText') ? patch.payloadText : patch.payload)
    if (!payload.ok) return payload
    next.payload = payload.payload
  }
  if (Object.keys(next).length === 0) return { ok: false, error: 'empty_patch' }

  const effectiveFrame = hasOwn(next, 'frame') ? next.frame : current.frame
  const frame = normalizeMarkerFrame(effectiveFrame, clip)
  if (!frame.ok) return frame
  return { ok: true, payload: next }
}

export function sortMarkers(markers = []) {
  return [...markers].sort((a, b) => {
    const frameDiff = (a.frame ?? 0) - (b.frame ?? 0)
    if (frameDiff !== 0) return frameDiff
    const typeDiff = String(a.type || '').localeCompare(String(b.type || ''))
    if (typeDiff !== 0) return typeDiff
    return String(a.id || '').localeCompare(String(b.id || ''))
  })
}

export function markerTimelineStyle(marker, totalFrames) {
  const total = Math.max(1, Math.round(Number(totalFrames) || 1))
  const frame = Math.max(0, Math.min(total - 1, toFrame(marker?.frame) ?? 0))
  return { left: `${(frame / total) * 100}%` }
}
