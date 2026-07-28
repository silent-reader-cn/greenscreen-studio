import { describe, expect, it } from 'vitest'
import {
  buildDirectionMirrorsFromSaved,
  buildSeNeQuadPack,
  buildSePairPack,
  parseAnimationBaseName,
} from '../directionPack.js'

const draft = {
  jobId: 'job-se',
  sourceLabel: 'walk_SE.mp4',
  fps: 12,
  loop: true,
  range: { startFrame: 0, endFrame: 10 },
  frames: [0, 3, 6],
  selectionMode: 'exact',
}

describe('parseAnimationBaseName', () => {
  it('strips known direction suffixes', () => {
    expect(parseAnimationBaseName('walk_SE')).toEqual({
      base: 'walk',
      direction: 'SE',
      fullName: 'walk_SE',
    })
    expect(parseAnimationBaseName('cast')).toEqual({
      base: 'cast',
      direction: null,
      fullName: 'cast',
    })
  })
})

describe('buildSePairPack', () => {
  it('creates SE source and SW mirror from the current draft', () => {
    let n = 0
    const result = buildSePairPack({
      existingClips: [],
      animationName: 'walk',
      draft,
      idFactory: () => `id-${++n}`,
    })
    expect(result.ok).toBe(true)
    expect(result.added).toEqual(['walk_SE', 'walk_SW'])
    expect(result.clips.map(c => ({ name: c.name, mirrorOf: c.mirrorOf || null, jobId: c.jobId }))).toEqual([
      { name: 'walk_SE', mirrorOf: null, jobId: 'job-se' },
      { name: 'walk_SW', mirrorOf: 'walk_SE', jobId: 'job-se' },
    ])
  })

  it('rejects duplicate names', () => {
    const result = buildSePairPack({
      existingClips: [{ name: 'walk_SE', jobId: 'x' }],
      animationName: 'walk_SE',
      draft,
    })
    expect(result.ok).toBe(false)
    expect(result.error).toBe('name_conflict')
  })
})

describe('buildDirectionMirrorsFromSaved', () => {
  it('expands SE+NE into SW+NW', () => {
    let n = 0
    const result = buildDirectionMirrorsFromSaved({
      existingClips: [
        { name: 'walk_SE', jobId: 'job-se', fps: 12, loop: true },
        { name: 'walk_NE', jobId: 'job-ne', fps: 12, loop: true },
      ],
      baseName: 'walk',
      idFactory: () => `id-${++n}`,
    })
    expect(result.ok).toBe(true)
    expect(result.mode).toBe('quad')
    expect(result.added).toEqual(['walk_SW', 'walk_NW'])
  })
})

describe('buildSeNeQuadPack', () => {
  it('saves current NE and completes the quad when SE already exists', () => {
    let n = 0
    const result = buildSeNeQuadPack({
      existingClips: [
        {
          name: 'walk_SE',
          jobId: 'job-se',
          sourceLabel: 'se.mp4',
          fps: 12,
          loop: true,
          frames: [0, 2],
          selectionMode: 'exact',
        },
      ],
      animationName: 'walk',
      draft: {
        ...draft,
        jobId: 'job-ne',
        sourceLabel: 'walk_NE.mp4',
        frames: [1, 4],
      },
      idFactory: () => `id-${++n}`,
    })
    expect(result.ok).toBe(true)
    expect(result.mode).toBe('quad')
    expect(result.added).toEqual(['walk_NE', 'walk_SW', 'walk_NW'])
    expect(result.clips.map(c => c.name)).toEqual(['walk_SE', 'walk_NE', 'walk_SW', 'walk_NW'])
  })
})
