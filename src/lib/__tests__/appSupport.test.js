import { describe, expect, it } from 'vitest'
import { getContainSize } from '../mediaCanvas.js'
import { getMediaKind, getMimeTypeForFile } from '../mediaFiles.js'
import { normalizeParams, resolveFrameRangeForVideo } from '../appProfiles.js'

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
