import { describe, expect, it } from 'vitest'
import { shouldHandleDroppedVideo } from '../droppedVideo.js'

describe('shouldHandleDroppedVideo', () => {
  it('handles a new file object exactly once', () => {
    const file = { name: 'clip.mp4' }
    expect(shouldHandleDroppedVideo(file, null)).toBe(true)
    expect(shouldHandleDroppedVideo(file, file)).toBe(false)
  })

  it('allows a different file object even when the filename matches', () => {
    expect(shouldHandleDroppedVideo({ name: 'clip.mp4' }, { name: 'clip.mp4' })).toBe(true)
  })

  it('ignores an empty drop value', () => {
    expect(shouldHandleDroppedVideo(null, null)).toBe(false)
  })
})
