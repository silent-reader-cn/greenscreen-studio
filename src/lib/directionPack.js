const DIRECTION_SUFFIXES = ['SE', 'NE', 'SW', 'NW', 'S', 'N', 'E', 'W']

export function parseAnimationBaseName(name) {
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

export function buildSourceClip({
  name,
  jobId,
  sourceLabel,
  fps,
  loop,
  range,
  frames,
  sampleEvery,
  maxFrames,
  selectionMode,
  idFactory = defaultId,
}) {
  return {
    id: idFactory(),
    name,
    jobId,
    sourceLabel,
    fps,
    loop,
    range,
    frames,
    sampleEvery,
    maxFrames,
    selectionMode,
  }
}

export function buildMirrorClip(sourceClip, mirrorName, idFactory = defaultId) {
  return {
    id: idFactory(),
    name: mirrorName,
    jobId: sourceClip.jobId,
    sourceLabel: sourceClip.sourceLabel,
    fps: sourceClip.fps,
    loop: sourceClip.loop,
    mirrorOf: sourceClip.name,
    selectionMode: 'mirror',
  }
}

/**
 * Build SE/SW pair from the current draft selection.
 * animationName may be "walk" or "walk_SE".
 */
export function buildSePairPack({
  existingClips = [],
  animationName,
  draft,
  idFactory = defaultId,
}) {
  const parsed = parseAnimationBaseName(animationName)
  if (!parsed.base) {
    return { ok: false, error: 'name_required', clips: existingClips }
  }
  if (!draft?.jobId) {
    return { ok: false, error: 'source_required', clips: existingClips }
  }
  if (draft.error) {
    return { ok: false, error: draft.error, clips: existingClips }
  }

  const seName = `${parsed.base}_SE`
  const swName = `${parsed.base}_SW`
  const names = new Set(existingClips.map(clip => clip.name))
  if (names.has(seName) || names.has(swName)) {
    return { ok: false, error: 'name_conflict', clips: existingClips, conflict: [seName, swName].filter(n => names.has(n)) }
  }

  const seClip = buildSourceClip({
    ...draft,
    name: seName,
    idFactory,
  })
  const swClip = buildMirrorClip(seClip, swName, idFactory)
  return {
    ok: true,
    clips: [...existingClips, seClip, swClip],
    added: [seClip.name, swClip.name],
  }
}

/**
 * Expand already-saved SE (+ optional NE) source clips into missing mirrors.
 * - SE only → SW
 * - SE + NE → SW + NW
 */
export function buildDirectionMirrorsFromSaved({
  existingClips = [],
  baseName,
  idFactory = defaultId,
}) {
  const parsed = parseAnimationBaseName(baseName)
  const base = parsed.base
  if (!base) {
    return { ok: false, error: 'name_required', clips: existingClips }
  }

  const byName = new Map(existingClips.map(clip => [clip.name, clip]))
  const seName = `${base}_SE`
  const neName = `${base}_NE`
  const swName = `${base}_SW`
  const nwName = `${base}_NW`

  const seClip = byName.get(seName)
  if (!seClip || seClip.mirrorOf) {
    return { ok: false, error: 'se_required', clips: existingClips }
  }

  const next = [...existingClips]
  const added = []
  const names = new Set(existingClips.map(clip => clip.name))

  if (!names.has(swName)) {
    const swClip = buildMirrorClip(seClip, swName, idFactory)
    next.push(swClip)
    added.push(swName)
    names.add(swName)
  }

  const neClip = byName.get(neName)
  if (neClip && !neClip.mirrorOf && !names.has(nwName)) {
    const nwClip = buildMirrorClip(neClip, nwName, idFactory)
    next.push(nwClip)
    added.push(nwName)
  }

  if (added.length === 0) {
    return { ok: false, error: 'nothing_to_add', clips: existingClips }
  }

  return {
    ok: true,
    clips: next,
    added,
    mode: neClip && !neClip.mirrorOf ? 'quad' : 'pair',
  }
}

/**
 * One-click SE+NE quad when NE is already saved and current draft is SE,
 * or current draft is NE and SE is already saved.
 */
export function buildSeNeQuadPack({
  existingClips = [],
  animationName,
  draft,
  idFactory = defaultId,
}) {
  const parsed = parseAnimationBaseName(animationName)
  if (!parsed.base) {
    return { ok: false, error: 'name_required', clips: existingClips }
  }
  if (!draft?.jobId) {
    return { ok: false, error: 'source_required', clips: existingClips }
  }
  if (draft.error) {
    return { ok: false, error: draft.error, clips: existingClips }
  }

  const seName = `${parsed.base}_SE`
  const neName = `${parsed.base}_NE`
  const byName = new Map(existingClips.map(clip => [clip.name, clip]))
  const names = new Set(existingClips.map(clip => clip.name))

  // Prefer explicit direction from name; otherwise infer from what is missing.
  let draftDirection = parsed.direction
  if (draftDirection !== 'SE' && draftDirection !== 'NE') {
    if (!byName.has(seName)) draftDirection = 'SE'
    else if (!byName.has(neName)) draftDirection = 'NE'
    else return { ok: false, error: 'se_ne_exist', clips: existingClips }
  }

  const draftName = draftDirection === 'SE' ? seName : neName
  if (names.has(draftName)) {
    return { ok: false, error: 'name_conflict', clips: existingClips, conflict: [draftName] }
  }

  const draftClip = buildSourceClip({
    ...draft,
    name: draftName,
    idFactory,
  })
  let next = [...existingClips, draftClip]

  // If the complementary source already exists, expand mirrors; otherwise only save current source.
  const complementName = draftDirection === 'SE' ? neName : seName
  if (!byName.has(complementName)) {
    return {
      ok: true,
      clips: next,
      added: [draftName],
      mode: 'source_only',
      pending: complementName,
    }
  }

  const mirrored = buildDirectionMirrorsFromSaved({
    existingClips: next,
    baseName: parsed.base,
    idFactory,
  })
  if (!mirrored.ok) {
    return mirrored
  }
  return {
    ok: true,
    clips: mirrored.clips,
    added: [draftName, ...mirrored.added],
    mode: 'quad',
  }
}

function defaultId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
}
