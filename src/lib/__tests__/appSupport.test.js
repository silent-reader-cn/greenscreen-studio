// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { getContainSize } from '../mediaCanvas.js'
import { getMediaKind, getMimeTypeForFile } from '../mediaFiles.js'
import {
  getProjectIdFromProfile,
  isProjectProfile,
  loadProfileState,
  makeProfile,
  makeProjectProfile,
  normalizeParams,
  profileToProjectParams,
  projectProfileFromParams,
  resolveFrameRangeForVideo,
} from '../appProfiles.js'

describe('app profile parameters', () => {
  it('normalizes nested defaults without sharing color arrays', () => {
    const first = normalizeParams({
      keying: { tolerance: 42 },
      layout: { sourceCharacterHeight: 19.6 },
      video: { spriteParams: { framesPerRow: 4 } },
    })
    const second = normalizeParams()

    expect(first.keying.tolerance).toBe(42)
    expect(first.layout.sourceCharacterHeight).toBe(20)
    expect(first.video.spriteParams.framesPerRow).toBe(4)
    expect(first.video.spriteParams.frameWidth).toBe(128)
    expect(first.keying.keyColor).not.toBe(second.keying.keyColor)
    expect(first.layout.bgColor).not.toBe(second.layout.bgColor)
  })

  it('clamps saved frame ranges to the current video', () => {
    expect(resolveFrameRangeForVideo({ startFrame: 8, endFrame: 80 }, { frameCount: 40 })).toEqual({
      startFrame: 8,
      endFrame: 40,
    })
    expect(resolveFrameRangeForVideo({ startFrame: 12, endFrame: 12 }, { fps: 24, duration: 2 })).toEqual({
      startFrame: 0,
      endFrame: 48,
    })
  })
})

describe('media file helpers', () => {
  it('recognizes media by MIME type or extension', () => {
    expect(getMediaKind({ name: 'still.bin', type: 'image/png' })).toBe('image')
    expect(getMediaKind({ name: 'clip.MOV', type: '' })).toBe('video')
    expect(getMediaKind({ name: 'notes.txt', type: 'text/plain' })).toBeNull()
    expect(getMimeTypeForFile({ name: 'clip.webm', type: '' }, 'video')).toBe('video/webm')
  })

  it('fits content inside a preview container without changing its aspect ratio', () => {
    expect(getContainSize({ w: 1920, h: 1080 }, { w: 800, h: 800 })).toEqual({ w: 800, h: 450 })
    expect(getContainSize({ w: 600, h: 1200 }, { w: 800, h: 600 })).toEqual({ w: 300, h: 600 })
    expect(getContainSize({ w: 0, h: 1200 }, { w: 800, h: 600 })).toBeNull()
  })
})

describe('project built-in profile', () => {
  it('marks a built-in profile by its project: prefix id', () => {
    const builtIn = makeProjectProfile('proj_abc', '温宁 L5', normalizeParams())
    expect(isProjectProfile(builtIn)).toBe(true)
    expect(getProjectIdFromProfile(builtIn)).toBe('proj_abc')
    expect(builtIn.name).toContain('温宁 L5')

    const standalone = makeProfile('剪影导出', normalizeParams())
    expect(isProjectProfile(standalone)).toBe(false)
    expect(getProjectIdFromProfile(standalone)).toBeNull()
  })

  it('round-trips through the projects.params.profile storage shape', () => {
    const builtIn = makeProjectProfile('proj_abc', '温宁 L5', {
      keying: { tolerance: 42 },
      layout: { canvasWidth: 256, sourceCharacterHeight: 520 },
    })
    const stored = profileToProjectParams(builtIn)
    expect(stored.keying.tolerance).toBe(42)
    expect(stored.layout.sourceCharacterHeight).toBe(520)
    expect(stored).not.toHaveProperty('id')

    const restored = projectProfileFromParams('proj_abc', '温宁 L5', { profile: stored })
    expect(restored).not.toBeNull()
    expect(isProjectProfile(restored)).toBe(true)
    expect(getProjectIdFromProfile(restored)).toBe('proj_abc')
    expect(restored.keying.tolerance).toBe(42)
    expect(restored.layout.canvasWidth).toBe(256)
  })

  it('returns null when params carry no project profile', () => {
    expect(projectProfileFromParams('proj_abc', '温宁 L5', { keying: {} })).toBeNull()
    expect(projectProfileFromParams('proj_abc', '温宁 L5')).toBeNull()
  })

  it('loadProfileState drops leftover project built-in profiles', () => {
    const standalone = makeProfile('剪影导出', normalizeParams())
    const builtIn = makeProjectProfile('proj_abc', '温宁 L5', normalizeParams())
    localStorage.setItem('greenscreen-studio-profiles', JSON.stringify({
      profiles: [standalone, { ...builtIn, isProjectProfile: true }],
      activeProfileId: builtIn.id,
    }))
    const state = loadProfileState()
    expect(state.profiles.some((item) => item.id === builtIn.id)).toBe(false)
    expect(state.profiles.some((item) => item.id === standalone.id)).toBe(true)
  })
})
