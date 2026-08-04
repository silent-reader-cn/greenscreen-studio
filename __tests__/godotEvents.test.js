import { describe, expect, it } from 'vitest'
import { createRequire } from 'module'

const require = createRequire(import.meta.url)
const { buildGodotEvents, mapSourceFrame } = require('../godotEvents.cjs')

describe('Godot events artifact', () => {
  it('snapshots an approved clip and maps semantic markers to animation frames', () => {
    const payload = { hitbox: 'slash_a', damage: 12 }
    const artifact = buildGodotEvents({
      tracks: [{
        animationName: 'attack',
        animationFps: 10,
        sourceFps: 30,
        range: { startFrame: 10, endFrame: 20 },
        sourceFrames: [10, 12, 15, 19],
        clipBundle: {
          clip: {
            id: 'clip_attack',
            name: 'attack',
            version: 4,
            status: 'approved',
            startFrame: 10,
            endFrame: 20,
            loop: false,
          },
          markers: [
            { id: 'late', frame: 14, type: 'instant', label: 'damage', payload },
            { id: 'exact', frame: 12, type: 'active_start', label: '', payload: {} },
          ],
        },
      }],
    })

    payload.damage = 99
    expect(artifact).toMatchObject({
      schemaVersion: 1,
      frameConvention: { origin: 0, clipEndExclusive: true },
      godot: {
        methodTrackFormat: 'godot_animation_method_track_v1',
        dispatchMethod: 'dispatch_action_event',
        dispatcherNodePath: 'ActionEventDispatcher',
        eventArgumentType: 'Dictionary',
      },
      tracks: [{
        sourceTimebase: {
          unit: 'source_frame',
          framesPerSecond: 30,
          startFrame: 10,
          endFrame: 20,
          endFrameExclusive: true,
        },
        clip: {
          reviewed: true,
          id: 'clip_attack',
          version: 4,
          status: 'approved',
          range: { startFrame: 10, endFrame: 20 },
          loop: false,
        },
        animation: {
          name: 'attack',
          framesPerSecond: 10,
          frameCount: 4,
          sourceFrames: [10, 12, 15, 19],
        },
      }],
    })
    expect(artifact.tracks[0].events).toEqual([
      expect.objectContaining({
        id: 'exact',
        sourceFrame: 12,
        clipRelativeFrame: 2,
        animationFrame: 1,
        animationTimeSeconds: 0.1,
        mappedSourceFrame: 12,
        exactSourceFrame: true,
      }),
      expect.objectContaining({
        id: 'late',
        payload: { hitbox: 'slash_a', damage: 12 },
        sourceFrame: 14,
        clipRelativeFrame: 4,
        animationFrame: 2,
        animationTimeSeconds: 0.2,
        mappedSourceFrame: 15,
        exactSourceFrame: false,
      }),
    ])
    expect(artifact.tracks[0].godotMethodTrack).toEqual({
      format: 'godot_animation_method_track_v1',
      type: 'method',
      targetNodePath: 'ActionEventDispatcher',
      method: 'dispatch_action_event',
      keys: [
        {
          timeSeconds: 0.1,
          transition: 1,
          value: {
            method: 'dispatch_action_event',
            args: [expect.objectContaining({ id: 'exact', type: 'active_start', animationFrame: 1 })],
          },
        },
        {
          timeSeconds: 0.2,
          transition: 1,
          value: {
            method: 'dispatch_action_event',
            args: [expect.objectContaining({ id: 'late', payload: { hitbox: 'slash_a', damage: 12 } })],
          },
        },
      ],
    })
  })

  it('creates an empty synthetic track for generic exports', () => {
    const artifact = buildGodotEvents({
      tracks: [{
        animationName: 'idle',
        animationFps: 12,
        sourceFps: 24,
        range: { startFrame: 0, endFrame: 7 },
        sourceFrames: [0, 3, 6],
        loop: true,
      }],
    })

    expect(artifact.tracks[0]).toMatchObject({
      clip: {
        reviewed: false,
        id: null,
        name: 'idle',
        status: null,
        range: { startFrame: 0, endFrame: 7 },
        loop: true,
      },
      events: [],
      godotMethodTrack: { keys: [] },
    })
  })

  it('uses the next sampled frame and rejects a mismatched reviewed range', () => {
    expect(mapSourceFrame(4, [0, 3, 6])).toEqual({
      animationFrame: 2,
      mappedSourceFrame: 6,
      exactSourceFrame: false,
    })
    expect(() => buildGodotEvents({
      tracks: [{
        animationName: 'attack',
        sourceFrames: [0, 3, 6],
        range: { startFrame: 0, endFrame: 7 },
        clipBundle: {
          clip: { startFrame: 1, endFrame: 7 },
          markers: [],
        },
      }],
    })).toThrow(/range must match/)
  })
})
