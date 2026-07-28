import { describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { exportGodotPoseImageFile, exportGodotSpriteFramesFile } from '../mcp/server.mjs'

const require = createRequire(import.meta.url)
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const { smokeGodotZip } = require('../godotSmoke.cjs')
const ffmpegPath = require('ffmpeg-static')

const godotPath = 'D:/godot/Godot_v4.6.3-stable_win64_console.exe'
const hasGodot = await fs.access(godotPath).then(() => true).catch(() => false)

describe.skipIf(!hasGodot)('Godot ZIP smoke', () => {
  it('extracts a single-pose bundle and loads its AnimatedSprite2D scene in Godot', async () => {
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'greenscreen-godot-pose-smoke-'))
    const inputPath = path.join(workDir, 'idle_SE.png')
    const { createCanvas } = require('canvas')
    const canvas = createCanvas(64, 64)
    const ctx = canvas.getContext('2d')
    ctx.fillStyle = 'rgb(0, 255, 0)'
    ctx.fillRect(0, 0, 64, 64)
    ctx.fillStyle = 'rgb(30, 70, 220)'
    ctx.fillRect(24, 8, 16, 48)
    await fs.writeFile(inputPath, canvas.toBuffer('image/png'))

    const exported = await exportGodotPoseImageFile({
      inputPath,
      overwrite: true,
      params: {
        mode: 'transparent',
        keying: { keyColor: [0, 255, 0], tolerance: 40 },
      },
      godot: {
        characterName: 'wenning',
        actionName: 'idle',
        animationName: 'idle_SE',
        frameWidth: 64,
        frameHeight: 64,
        safeAreaWidth: 64,
        safeAreaHeight: 64,
        fps: 6,
      },
    }, { projectRoot, baseDir: workDir })

    const result = await smokeGodotZip({
      bundlePath: exported.bundlePath,
      godotPath,
      workDir,
    })

    expect(result.scenePath).toBe('wenning_idle_SE.tscn')
    expect(result.nodeType).toBe('AnimatedSprite2D')
    expect(result.animation).toBe('idle_SE')
    expect(result.animationNames).toEqual(['idle_SE'])
  }, 30_000)

  it('extracts a real exported bundle and loads its AnimatedSprite2D scene in Godot', async () => {
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'greenscreen-godot-smoke-'))
    const inputPath = path.join(workDir, 'walk_SE.mp4')
    const ffmpeg = spawnSync(ffmpegPath, [
      '-y',
      '-f', 'lavfi',
      '-i', 'color=c=0x00ff00:s=64x64:r=6:d=1',
      '-vf', 'drawbox=x=24:y=8:w=16:h=48:color=red:t=fill',
      '-an',
      inputPath,
    ], { encoding: 'utf8' })
    expect(ffmpeg.status).toBe(0)

    const exported = await exportGodotSpriteFramesFile({
      overwrite: true,
      params: {
        mode: 'transparent',
        keying: { keyColor: [0, 255, 0], tolerance: 40 },
      },
      godot: {
        characterName: 'wenning',
        actionName: 'walk',
        frameWidth: 64,
        frameHeight: 64,
        safeAreaWidth: 64,
        safeAreaHeight: 64,
        fps: 6,
        animations: [
          { name: 'walk_SE', inputPath, frames: [0, 2], fps: 6, loop: true },
          { name: 'walk_SW', mirrorOf: 'walk_SE', fps: 6, loop: true },
        ],
      },
    }, { projectRoot, baseDir: workDir })

    const result = await smokeGodotZip({
      bundlePath: exported.bundlePath,
      godotPath,
      workDir,
    })

    expect(result.scenePath).toBe('wenning_walk.tscn')
    expect(result.nodeType).toBe('AnimatedSprite2D')
    expect(result.animation).toBe('walk_SE')
    expect(result.animationNames).toEqual(expect.arrayContaining(['walk_SE', 'walk_SW']))
    expect(result.extractedFiles).toEqual(expect.arrayContaining([
      'wenning_walk_atlas.png',
      'wenning_walk.tres',
      'wenning_walk.tscn',
      'wenning_walk_metadata.json',
    ]))
  }, 30_000)
})
