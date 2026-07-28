import { describe, expect, it } from 'vitest'
import {
  classifyDirectionVideos,
  detectActionBaseFromFilename,
  detectDirectionFromFilename,
} from '../directionImport.js'

describe('detectDirectionFromFilename', () => {
  it('parses common SE/NE filename styles', () => {
    expect(detectDirectionFromFilename('walk_SE.mp4')).toBe('SE')
    expect(detectDirectionFromFilename('walk-NE.mov')).toBe('NE')
    expect(detectDirectionFromFilename('SE_walk.webm')).toBe('SE')
    expect(detectDirectionFromFilename('walk SE.mp4')).toBe('SE')
    expect(detectDirectionFromFilename('温宁_walk_SW.mp4')).toBe('SW')
  })

  it('returns null when no direction token exists', () => {
    expect(detectDirectionFromFilename('idle_loop.mp4')).toBeNull()
  })
})

describe('detectActionBaseFromFilename', () => {
  it('strips direction tokens from the basename', () => {
    expect(detectActionBaseFromFilename('walk_SE.mp4')).toBe('walk')
    expect(detectActionBaseFromFilename('cast-NE.mp4')).toBe('cast')
    expect(detectActionBaseFromFilename('SE_walk.mp4')).toBe('walk')
  })
})

describe('classifyDirectionVideos', () => {
  it('orders SE before NE and marks auto-pack ready', () => {
    const files = [
      { name: 'walk_NE.mp4' },
      { name: 'walk_SE.mp4' },
      { name: 'notes.txt' },
    ]
    const result = classifyDirectionVideos(files)
    expect(result.sourceItems.map(item => item.direction)).toEqual(['SE', 'NE'])
    expect(result.actionBase).toBe('walk')
    expect(result.canAutoPack).toBe(true)
    expect(result.isMulti).toBe(true)
  })

  it('keeps single undirected video usable without auto pack directions', () => {
    const result = classifyDirectionVideos([{ name: 'idle.mp4' }])
    expect(result.sourceItems).toEqual([])
    expect(result.withoutDirection).toHaveLength(1)
    expect(result.canAutoPack).toBe(false)
  })
})
