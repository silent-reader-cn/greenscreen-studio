import { describe, expect, it } from 'vitest'
import {
  buildGodotExportBasename,
  parseAnimationBaseName,
  sanitizeNamePart,
} from '../godotNaming.js'

describe('sanitizeNamePart', () => {
  it('keeps CJK and collapses unsafe characters', () => {
    expect(sanitizeNamePart('温宁 walk!!')).toBe('温宁_walk')
    expect(sanitizeNamePart('___')).toBe('')
  })
})

describe('parseAnimationBaseName', () => {
  it('extracts direction suffixes', () => {
    expect(parseAnimationBaseName('walk_SE')).toEqual({
      base: 'walk',
      direction: 'SE',
      fullName: 'walk_SE',
    })
  })
})

describe('buildGodotExportBasename', () => {
  it('builds character_action for multi-direction packs', () => {
    expect(buildGodotExportBasename({
      characterName: '温宁',
      actionName: 'walk',
      animationNames: ['walk_SE', 'walk_NE', 'walk_SW', 'walk_NW'],
    })).toBe('温宁_walk')
  })

  it('builds character_action_direction for a single animation', () => {
    expect(buildGodotExportBasename({
      characterName: 'wenning',
      animationNames: ['cast_SE'],
    })).toBe('wenning_cast_SE')
  })

  it('prefers explicit exportName', () => {
    expect(buildGodotExportBasename({
      characterName: 'wenning',
      actionName: 'walk',
      exportName: 'boss_intro',
      animationNames: ['walk_SE'],
    })).toBe('boss_intro')
  })

  it('infers action from shared animation base names', () => {
    expect(buildGodotExportBasename({
      characterName: 'hero',
      animationNames: ['idle_SE', 'idle_SW'],
    })).toBe('hero_idle')
  })
})
