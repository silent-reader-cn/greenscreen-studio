/**
 * Pure helpers for Action Asset Review Workbench clip timeline.
 * Keeps multi-select, range validation, and payload shaping testable
 * without React or the network layer.
 */

export const CLIP_STATUSES = Object.freeze([
  'draft',
  'needs_review',
  'approved',
  'exported',
  'verified_in_game',
  'rejected',
])

/**
 * @param {number} value
 * @param {number} [fallback=0]
 */
export function toFrame(value, fallback = 0) {
  const frame = Math.round(Number(value))
  return Number.isFinite(frame) && frame >= 0 ? frame : fallback
}

/**
 * Inclusive start, exclusive end. end must be greater than start.
 * @param {{ startFrame?: number, endFrame?: number }} range
 * @param {{ totalFrames?: number|null }} [options]
 * @returns {{ ok: true, startFrame: number, endFrame: number } | { ok: false, error: string }}
 */
export function normalizeClipRange(range = {}, options = {}) {
  const startFrame = toFrame(range.startFrame, 0)
  const endFrame = toFrame(range.endFrame, startFrame)
  if (endFrame <= startFrame) {
    return { ok: false, error: 'range_invalid' }
  }
  const total = options.totalFrames != null ? Math.round(Number(options.totalFrames)) : null
  if (Number.isFinite(total) && total > 0) {
    if (startFrame >= total) return { ok: false, error: 'start_out_of_video' }
    if (endFrame > total) return { ok: false, error: 'end_out_of_video' }
  }
  return { ok: true, startFrame, endFrame }
}

/**
 * Build create-clip request body for POST /api/projects/:id/clips
 * @param {{
 *   assetId: string,
 *   name?: string,
 *   startFrame?: number,
 *   endFrame?: number,
 *   loop?: boolean,
 *   status?: string,
 *   notes?: string,
 *   params?: object,
 *   totalFrames?: number|null,
 * }} input
 */
export function buildCreateClipPayload(input = {}) {
  const assetId = String(input.assetId || '').trim()
  if (!assetId) return { ok: false, error: 'asset_required' }

  const name = String(input.name || '').trim()
  if (!name) return { ok: false, error: 'name_required' }

  const range = normalizeClipRange(
    { startFrame: input.startFrame, endFrame: input.endFrame },
    { totalFrames: input.totalFrames },
  )
  if (!range.ok) return range

  return {
    ok: true,
    payload: {
      assetId,
      name,
      startFrame: range.startFrame,
      endFrame: range.endFrame,
      loop: Boolean(input.loop),
      status: CLIP_STATUSES.includes(input.status) ? input.status : 'draft',
      notes: String(input.notes || ''),
      params: input.params && typeof input.params === 'object' ? input.params : {},
    },
  }
}

/**
 * Build patch body for PATCH /api/projects/:id/clips/:clipId
 * Only includes defined fields.
 * @param {object} patch
 * @param {{ totalFrames?: number|null, current?: { startFrame: number, endFrame: number } }} [options]
 */
export function buildUpdateClipPayload(patch = {}, options = {}) {
  const body = {}
  if (patch.name != null) {
    const name = String(patch.name).trim()
    if (!name) return { ok: false, error: 'name_required' }
    body.name = name
  }
  if (patch.loop != null) body.loop = Boolean(patch.loop)
  if (patch.status != null) {
    if (!CLIP_STATUSES.includes(patch.status)) return { ok: false, error: 'status_invalid' }
    body.status = patch.status
  }
  if (patch.notes != null) body.notes = String(patch.notes)
  if (patch.params !== undefined) {
    body.params = patch.params && typeof patch.params === 'object' ? patch.params : {}
  }

  const hasStart = patch.startFrame !== undefined
  const hasEnd = patch.endFrame !== undefined
  if (hasStart || hasEnd) {
    const current = options.current || {}
    const range = normalizeClipRange(
      {
        startFrame: hasStart ? patch.startFrame : current.startFrame,
        endFrame: hasEnd ? patch.endFrame : current.endFrame,
      },
      { totalFrames: options.totalFrames },
    )
    if (!range.ok) return range
    if (hasStart) body.startFrame = range.startFrame
    if (hasEnd) body.endFrame = range.endFrame
  }

  if (Object.keys(body).length === 0) return { ok: false, error: 'empty_patch' }
  return { ok: true, payload: body }
}

/**
 * Sort clips for timeline display: startFrame ASC, then name, then id.
 * @param {Array<object>} clips
 */
export function sortClipsForTimeline(clips = []) {
  return [...clips].sort((a, b) => {
    const startDiff = (a.startFrame ?? 0) - (b.startFrame ?? 0)
    if (startDiff !== 0) return startDiff
    const nameDiff = String(a.name || '').localeCompare(String(b.name || ''))
    if (nameDiff !== 0) return nameDiff
    return String(a.id || '').localeCompare(String(b.id || ''))
  })
}

/**
 * Toggle multi-select for clip ids. Shift-click range is handled by the UI
 * via expandSelectionRange; this is the plain toggle / replace helper.
 * @param {string[]} selectedIds
 * @param {string} clipId
 * @param {{ mode?: 'replace'|'toggle'|'add'|'remove' }} [options]
 */
export function updateClipSelection(selectedIds = [], clipId, options = {}) {
  const id = String(clipId || '')
  if (!id) return [...selectedIds]
  const mode = options.mode || 'replace'
  const set = new Set(selectedIds.map(String))

  if (mode === 'replace') return [id]
  if (mode === 'add') {
    set.add(id)
    return [...set]
  }
  if (mode === 'remove') {
    set.delete(id)
    return [...set]
  }
  // toggle
  if (set.has(id)) set.delete(id)
  else set.add(id)
  return [...set]
}

/**
 * Expand selection from anchor to target using ordered clip list (shift-click).
 * @param {Array<{id: string}>} orderedClips
 * @param {string|null} anchorId
 * @param {string} targetId
 */
export function expandSelectionRange(orderedClips = [], anchorId, targetId) {
  const ids = orderedClips.map((clip) => String(clip.id))
  const target = String(targetId || '')
  if (!target || !ids.includes(target)) return []
  const anchor = anchorId && ids.includes(String(anchorId)) ? String(anchorId) : target
  const a = ids.indexOf(anchor)
  const b = ids.indexOf(target)
  const [from, to] = a <= b ? [a, b] : [b, a]
  return ids.slice(from, to + 1)
}

/**
 * Default clip name suggestion from action / file basename.
 * @param {string} [base]
 * @param {number} [index]
 */
export function suggestClipName(base = '', index = 1) {
  const cleaned = String(base || '')
    .replace(/\.[^.]+$/, '')
    .replace(/[^\w\u4e00-\u9fff-]+/g, '_')
    .replace(/^_+|_+$/g, '')
  const stem = cleaned || 'clip'
  return index > 1 ? `${stem}_${index}` : stem
}

/**
 * Filter clips belonging to one source asset.
 * @param {Array<object>} clips
 * @param {string} assetId
 */
export function clipsForAsset(clips = [], assetId) {
  const id = String(assetId || '')
  if (!id) return []
  return clips.filter((clip) => String(clip.assetId) === id)
}

/**
 * Compute left/width percentages for a clip bar on a full-video timeline.
 * @param {{ startFrame: number, endFrame: number }} clip
 * @param {number} totalFrames
 */
export function clipTimelineStyle(clip, totalFrames) {
  const total = Math.max(1, Math.round(Number(totalFrames) || 1))
  const start = Math.max(0, Math.min(total, toFrame(clip?.startFrame, 0)))
  const end = Math.max(start, Math.min(total, toFrame(clip?.endFrame, start)))
  const left = (start / total) * 100
  const width = Math.max(0.4, ((end - start) / total) * 100)
  return {
    left: `${left}%`,
    width: `${width}%`,
  }
}
