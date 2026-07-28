import { describe, expect, it } from 'vitest'
import { parseExplicitFrameList } from '../frameSelection.js'

describe('parseExplicitFrameList', () => {
  it('accepts comma and whitespace separators and sorts unique frames', () => {
    expect(parseExplicitFrameList('19, 0  12,12\n6', 40)).toEqual({
      frames: [0, 6, 12, 19],
      invalidTokens: [],
      outOfRangeFrames: [],
      duplicatesRemoved: 1,
    })
  })

  it('reports invalid and out-of-range values without passing them through', () => {
    expect(parseExplicitFrameList('0, -1, 3.5, nope, 20', 20)).toEqual({
      frames: [0],
      invalidTokens: ['-1', '3.5', 'nope'],
      outOfRangeFrames: [20],
      duplicatesRemoved: 0,
    })
  })

  it('treats an empty value as interval sampling', () => {
    expect(parseExplicitFrameList('', 20)).toEqual({
      frames: [],
      invalidTokens: [],
      outOfRangeFrames: [],
      duplicatesRemoved: 0,
    })
  })
})
