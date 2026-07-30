import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { buildActionClipReviewChecks, findLoopBoundaryScore } = require('../reviewChecks.cjs')

function healthyInput(overrides = {}) {
  const clip = {
    id: 'clip_1',
    version: 3,
    status: 'needs_review',
    startFrame: 10,
    endFrame: 20,
    loop: true,
    ...(overrides.clip || {}),
  }
  return {
    clip,
    generatedAt: '2026-07-30T00:00:00.000Z',
    stableCrop: {
      scan: {
        scannedFrameCount: 10,
        rawBounds: { x: 20, y: 10, width: 40, height: 70 },
        metrics: {
          sampleFrameCount: 10,
          foregroundFrameCount: 10,
          foregroundAreaRatio: { min: 0.2, max: 0.3, mean: 0.25 },
          edgeContacts: { left: 0, right: 0, top: 0, bottom: 0, frameCount: 0 },
          feet: { maxBottomDeltaRatio: 0.02 },
          jitter: { maxCenterDeltaRatio: 0.02, maxAreaChangeRatio: 0.1 },
        },
      },
    },
    loopResult: {
      candidates: [{ frame: 19, score: 12 }],
      scores: [{ frame: 19, score: 12 }],
      warnings: [],
    },
    layout: { anchor: 'feet' },
    ...overrides,
    clip,
  }
}

function checkById(report, id) {
  return report.checks.find((entry) => entry.id === id)
}

describe('action clip automated review checks', () => {
  it('passes healthy foreground, crop, anchor, jitter, and loop-boundary metrics', () => {
    const report = buildActionClipReviewChecks(healthyInput())

    expect(report).toMatchObject({
      schemaVersion: 1,
      generatedAt: '2026-07-30T00:00:00.000Z',
      clip: { id: 'clip_1', version: 3, status: 'needs_review', startFrame: 10, endFrame: 20, loop: true },
      summary: { status: 'pass', warningCount: 0, passCount: 5, skippedCount: 0 },
    })
    expect(report.checks.map((entry) => [entry.id, entry.status])).toEqual([
      ['foreground_area', 'pass'],
      ['feet_anchor', 'pass'],
      ['crop', 'pass'],
      ['frame_jitter', 'pass'],
      ['loop_boundary', 'pass'],
    ])
  })

  it('warns when foreground frames are missing or the subject touches a source edge', () => {
    const input = healthyInput()
    input.stableCrop.scan.metrics.foregroundFrameCount = 8
    input.stableCrop.scan.metrics.edgeContacts = { left: 2, right: 0, top: 0, bottom: 0, frameCount: 2 }
    const report = buildActionClipReviewChecks(input)

    expect(checkById(report, 'foreground_area')).toMatchObject({ status: 'warning', code: 'foreground_missing_frames' })
    expect(checkById(report, 'crop')).toMatchObject({ status: 'warning', code: 'crop_touches_source_edge' })
    expect(report.summary).toMatchObject({ status: 'warning', warningCount: 2 })
  })

  it('distinguishes missing foreground from too-small and too-large foreground area', () => {
    const missing = healthyInput()
    missing.stableCrop.scan.rawBounds = null
    missing.stableCrop.scan.metrics.sampleFrameCount = 0
    missing.stableCrop.scan.metrics.foregroundFrameCount = 0
    expect(checkById(buildActionClipReviewChecks(missing), 'foreground_area')).toMatchObject({
      status: 'warning',
      code: 'foreground_not_scanned',
    })

    const small = healthyInput()
    small.stableCrop.scan.metrics.foregroundAreaRatio = { min: 0.001, max: 0.002, mean: 0.0015 }
    expect(checkById(buildActionClipReviewChecks(small), 'foreground_area').code).toBe('foreground_too_small')

    const large = healthyInput()
    large.stableCrop.scan.metrics.foregroundAreaRatio = { min: 0.7, max: 0.9, mean: 0.8 }
    expect(checkById(buildActionClipReviewChecks(large), 'foreground_area').code).toBe('foreground_too_large')
  })

  it('warns for a disabled or unstable feet anchor', () => {
    const disabled = healthyInput({ layout: { anchor: 'center' } })
    expect(checkById(buildActionClipReviewChecks(disabled), 'feet_anchor')).toMatchObject({
      status: 'warning',
      code: 'feet_anchor_disabled',
    })

    const unstable = healthyInput()
    unstable.stableCrop.scan.metrics.feet.maxBottomDeltaRatio = 0.2
    expect(checkById(buildActionClipReviewChecks(unstable), 'feet_anchor')).toMatchObject({
      status: 'warning',
      code: 'feet_anchor_unstable',
    })
  })

  it('warns for center and foreground-area jumps', () => {
    const centerJump = healthyInput()
    centerJump.stableCrop.scan.metrics.jitter.maxCenterDeltaRatio = 0.2
    expect(checkById(buildActionClipReviewChecks(centerJump), 'frame_jitter')).toMatchObject({
      status: 'warning',
      code: 'frame_center_jump',
    })

    const areaJump = healthyInput()
    areaJump.stableCrop.scan.metrics.jitter.maxAreaChangeRatio = 0.5
    expect(checkById(buildActionClipReviewChecks(areaJump), 'frame_jitter')).toMatchObject({
      status: 'warning',
      code: 'frame_area_jump',
    })
  })

  it('warns for a missing or mismatched loop boundary and skips non-loop clips', () => {
    expect(findLoopBoundaryScore({ scores: [{ frame: 19, score: 54 }] }, 20)).toBe(54)

    const mismatch = healthyInput({ loopResult: { scores: [{ frame: 19, score: 54 }], candidates: [], warnings: [] } })
    expect(checkById(buildActionClipReviewChecks(mismatch), 'loop_boundary')).toMatchObject({
      status: 'warning',
      code: 'loop_boundary_mismatch',
    })

    const missing = healthyInput({ loopResult: { scores: [], candidates: [], warnings: [] } })
    expect(checkById(buildActionClipReviewChecks(missing), 'loop_boundary').code).toBe('loop_boundary_missing')

    const nonLoop = healthyInput({ clip: { loop: false }, loopResult: null })
    expect(checkById(buildActionClipReviewChecks(nonLoop), 'loop_boundary')).toMatchObject({
      status: 'skipped',
      code: 'loop_not_enabled',
    })
    expect(buildActionClipReviewChecks(nonLoop).summary).toMatchObject({ passCount: 4, skippedCount: 1 })
  })
})
