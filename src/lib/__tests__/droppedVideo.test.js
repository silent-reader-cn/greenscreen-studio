import { describe, expect, it } from 'vitest'
import {
  droppedVideosKey,
  shouldHandleDroppedVideo,
  shouldHandleDroppedVideos,
} from '../droppedVideo.js'

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

describe('shouldHandleDroppedVideos', () => {
  it('dedupes multi-file drops by name/size/mtime key', () => {
    const files = [
      { name: 'walk_SE.mp4', size: 10, lastModified: 1 },
      { name: 'walk_NE.mp4', size: 20, lastModified: 2 },
    ]
    const key = droppedVideosKey(files)
    expect(shouldHandleDroppedVideos(files, null)).toBe(true)
    expect(shouldHandleDroppedVideos(files, key)).toBe(false)
  })
})
