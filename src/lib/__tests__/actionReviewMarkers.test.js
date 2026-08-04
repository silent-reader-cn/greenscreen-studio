import { describe, expect, it } from 'vitest'
import {
  MARKER_TYPES,
  buildCreateMarkerPayload,
  buildUpdateMarkerPayload,
  markerTimelineStyle,
  normalizeMarkerFrame,
  parseMarkerPayload,
  sortMarkers,
} from '../actionReviewMarkers.js'

const clip = { id: 'clip_1', startFrame: 10, endFrame: 40 }

describe('semantic marker payloads', () => {
  it('accepts the inclusive clip start and rejects the exclusive end', () => {
    expect(normalizeMarkerFrame(10, clip)).toEqual({ ok: true, frame: 10 })
    expect(normalizeMarkerFrame(39, clip)).toEqual({ ok: true, frame: 39 })
    expect(normalizeMarkerFrame(40, clip).error).toBe('frame_outside_clip')
    expect(normalizeMarkerFrame('nope', clip).error).toBe('frame_invalid')
  })

  it('creates a typed marker with an object payload', () => {
    expect(buildCreateMarkerPayload({
      frame: 24,
      type: 'instant',
      label: ' sword impact ',
      payloadText: '{"damageMultiplier":1.25}',
    }, { clip })).toEqual({
      ok: true,
      payload: {
        frame: 24,
        type: 'instant',
        label: 'sword impact',
        payload: { damageMultiplier: 1.25 },
      },
    })
  })

  it('rejects unknown types and non-object JSON payloads', () => {
    expect(buildCreateMarkerPayload({ frame: 20, type: 'unknown' }, { clip }).error).toBe('type_invalid')
    expect(parseMarkerPayload('{broken').error).toBe('payload_invalid_json')
    expect(parseMarkerPayload('[1,2]').error).toBe('payload_not_object')
  })

  it('builds partial move and metadata patches', () => {
    expect(buildUpdateMarkerPayload(
      { frame: 30, label: 'late hit', payload: { strength: 2 } },
      { clip, current: { frame: 20, type: 'instant' } },
    )).toEqual({
      ok: true,
      payload: { frame: 30, label: 'late hit', payload: { strength: 2 } },
    })
    expect(buildUpdateMarkerPayload({}, { clip, current: { frame: 20 } }).error).toBe('empty_patch')
  })
})

describe('semantic marker display helpers', () => {
  it('keeps the fixed machine-readable type catalog', () => {
    expect(MARKER_TYPES).toHaveLength(7)
    expect(MARKER_TYPES).toContain('active_start')
    expect(MARKER_TYPES).toContain('instant')
    expect(MARKER_TYPES).toContain('hold')
  })

  it('sorts markers by frame and computes timeline position', () => {
    const markers = sortMarkers([
      { id: 'b', frame: 20, type: 'instant' },
      { id: 'a', frame: 10, type: 'note' },
      { id: 'c', frame: 20, type: 'hold' },
    ])
    expect(markers.map((marker) => marker.id)).toEqual(['a', 'c', 'b'])
    expect(markerTimelineStyle({ frame: 25 }, 100)).toEqual({ left: '25%' })
  })
})
