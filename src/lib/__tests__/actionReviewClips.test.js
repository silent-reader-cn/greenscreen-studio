import { describe, expect, it } from 'vitest'
import {
  CLIP_STATUSES,
  availableClipStatuses,
  buildClipStatusTransition,
  buildCreateClipPayload,
  buildUpdateClipPayload,
  clipTimelineStyle,
  clipsForAsset,
  expandSelectionRange,
  normalizeClipRange,
  isClipEditable,
  sortClipsForTimeline,
  suggestClipName,
  updateClipSelection,
} from '../actionReviewClips.js'

describe('normalizeClipRange', () => {
  it('accepts inclusive start and exclusive end', () => {
    expect(normalizeClipRange({ startFrame: 10, endFrame: 40 })).toEqual({
      ok: true,
      startFrame: 10,
      endFrame: 40,
    })
  })

  it('rejects empty or inverted ranges', () => {
    expect(normalizeClipRange({ startFrame: 10, endFrame: 10 }).ok).toBe(false)
    expect(normalizeClipRange({ startFrame: 20, endFrame: 5 }).error).toBe('range_invalid')
  })

  it('rejects frames past totalFrames when provided', () => {
    expect(normalizeClipRange({ startFrame: 0, endFrame: 101 }, { totalFrames: 100 }).error)
      .toBe('end_out_of_video')
    expect(normalizeClipRange({ startFrame: 100, endFrame: 120 }, { totalFrames: 100 }).error)
      .toBe('start_out_of_video')
  })
})

describe('buildCreateClipPayload', () => {
  it('builds a draft create body', () => {
    const result = buildCreateClipPayload({
      assetId: 'asset_1',
      name: ' attack_SE ',
      startFrame: 12,
      endFrame: 48,
      loop: true,
    })
    expect(result.ok).toBe(true)
    expect(result.payload).toMatchObject({
      assetId: 'asset_1',
      name: 'attack_SE',
      startFrame: 12,
      endFrame: 48,
      loop: true,
      status: 'draft',
    })
  })

  it('requires asset and name', () => {
    expect(buildCreateClipPayload({ name: 'x' }).error).toBe('asset_required')
    expect(buildCreateClipPayload({ assetId: 'a', name: '  ' }).error).toBe('name_required')
  })

  it('requires new clips to start in draft', () => {
    expect(buildCreateClipPayload({
      assetId: 'a',
      name: 'attack',
      startFrame: 0,
      endFrame: 10,
      status: 'approved',
    }).error).toBe('status_initial_invalid')
  })
})

describe('buildUpdateClipPayload', () => {
  it('patches only provided fields and validates range against current', () => {
    const result = buildUpdateClipPayload(
      { endFrame: 90, notes: 'tighten recovery' },
      { current: { startFrame: 10, endFrame: 60 }, totalFrames: 120 },
    )
    expect(result.ok).toBe(true)
    expect(result.payload).toEqual({
      endFrame: 90,
      notes: 'tighten recovery',
    })
  })

  it('rejects invalid status and empty patches', () => {
    expect(buildUpdateClipPayload({ status: 'shipped' }).error).toBe('status_invalid')
    expect(buildUpdateClipPayload({}).error).toBe('empty_patch')
  })
})

describe('clip review state machine', () => {
  it('exposes only valid next states', () => {
    expect(availableClipStatuses('draft')).toEqual(['needs_review'])
    expect(availableClipStatuses('needs_review')).toEqual(['draft', 'approved', 'rejected'])
    expect(availableClipStatuses('approved')).toEqual(['needs_review', 'exported'])
    expect(availableClipStatuses('exported')).toEqual(['approved', 'verified_in_game'])
    expect(availableClipStatuses('verified_in_game')).toEqual(['needs_review'])
    expect(availableClipStatuses('rejected')).toEqual(['draft'])
  })

  it('builds valid transitions and rejects skipped states', () => {
    expect(buildClipStatusTransition('draft', 'needs_review')).toEqual({
      ok: true,
      payload: { status: 'needs_review' },
    })
    expect(buildClipStatusTransition('draft', 'approved').error).toBe('status_transition_invalid')
    expect(buildClipStatusTransition('approved', 'approved').error).toBe('status_unchanged')
  })

  it('locks content after review approval', () => {
    expect(isClipEditable('draft')).toBe(true)
    expect(isClipEditable('needs_review')).toBe(true)
    expect(isClipEditable('approved')).toBe(false)
    expect(isClipEditable('verified_in_game')).toBe(false)
  })
})

describe('selection helpers', () => {
  const clips = [
    { id: 'a', startFrame: 0, name: 'idle' },
    { id: 'b', startFrame: 20, name: 'attack' },
    { id: 'c', startFrame: 40, name: 'recovery' },
  ]

  it('toggles, replaces, and expands shift ranges', () => {
    expect(updateClipSelection(['a'], 'b', { mode: 'toggle' })).toEqual(['a', 'b'])
    expect(updateClipSelection(['a', 'b'], 'b', { mode: 'toggle' })).toEqual(['a'])
    expect(updateClipSelection(['a', 'b'], 'c', { mode: 'replace' })).toEqual(['c'])
    expect(expandSelectionRange(clips, 'a', 'c')).toEqual(['a', 'b', 'c'])
    expect(expandSelectionRange(clips, 'c', 'b')).toEqual(['b', 'c'])
  })

  it('sorts timeline by start then name', () => {
    const sorted = sortClipsForTimeline([
      { id: '2', startFrame: 10, name: 'b' },
      { id: '1', startFrame: 10, name: 'a' },
      { id: '3', startFrame: 0, name: 'z' },
    ])
    expect(sorted.map((c) => c.id)).toEqual(['3', '1', '2'])
  })

  it('filters by asset and computes bar geometry', () => {
    expect(clipsForAsset([
      { id: '1', assetId: 'v1' },
      { id: '2', assetId: 'v2' },
    ], 'v1')).toHaveLength(1)
    expect(clipTimelineStyle({ startFrame: 25, endFrame: 75 }, 100)).toEqual({
      left: '25%',
      width: '50%',
    })
  })
})

describe('suggestClipName', () => {
  it('strips extension and indexes extras', () => {
    expect(suggestClipName('hero_attack_SE.mp4')).toBe('hero_attack_SE')
    expect(suggestClipName('hero_attack_SE.mp4', 2)).toBe('hero_attack_SE_2')
  })

  it('exposes the accepted review statuses', () => {
    expect(CLIP_STATUSES).toContain('approved')
    expect(CLIP_STATUSES).toContain('verified_in_game')
  })
})
