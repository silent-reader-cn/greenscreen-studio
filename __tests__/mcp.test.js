import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { createCanvas } from 'canvas'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import {
  createGreenscreenMcpServer,
  exportGodotPoseImageFile,
  exportGodotSpriteFramesFile,
  exportImageFile,
  inspectImageFile,
  normalizeProcessingParams,
} from '../mcp/server.mjs'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'

const require = createRequire(import.meta.url)
const ffmpegPath = require('ffmpeg-static')
const { createProjectStore, ACTION_CLIP_EXPORT_TASK_TYPE } = require('../lib/projectStore.cjs')

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const projectRoot = path.resolve(__dirname, '..')

describe('Greenscreen Studio MCP helpers', () => {
  let tmpDir

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'greenscreen-mcp-test-'))
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('normalizes partial processing params with safe defaults', () => {
    const params = normalizeProcessingParams({
      keying: {
        keyColor: [0, 300, -10],
        tolerance: 999,
      },
      layout: {
        canvasWidth: 16.2,
        personHeight: -1,
        autoCrop: false,
      },
      region: {
        x: 3.2,
        y: -4,
        width: 20.7,
        height: 10.1,
      },
      mode: 'transparent',
    })

    expect(params.keying.keyColor).toEqual([0, 255, 0])
    expect(params.keying.tolerance).toBe(100)
    expect(params.layout.canvasWidth).toBe(16)
    expect(params.layout.personHeight).toBe(940)
    expect(params.layout.autoCrop).toBe(false)
    expect(params.layout.sourceCenterAnchor).toBe(true)
    expect(params.layout.sourceCharacterHeight).toBe(0)
    expect(params.region).toEqual({ x: 3, y: 0, width: 21, height: 10 })
    expect(params.mode).toBe('transparent')
  })

  it('keeps sourceCharacterHeight when provided', () => {
    const params = normalizeProcessingParams({
      layout: {
        sourceCharacterHeight: 520.6,
      },
    })

    expect(params.layout.sourceCharacterHeight).toBe(521)
  })

  it('exports a keyed PNG image and reports the generated file', async () => {
    const inputPath = path.join(tmpDir, 'source.png')
    const outputPath = path.join(tmpDir, 'export.png')
    await writeSampleGreenscreenPng(inputPath)

    const result = await exportImageFile({
      inputPath,
      outputPath,
      params: {
        mode: 'transparent',
        region: {
          x: 2,
          y: 1,
          width: 4,
          height: 6,
        },
        layout: {
          canvasWidth: 12,
          canvasHeight: 12,
          personWidth: 10,
          personHeight: 10,
        },
      },
    }, { projectRoot, baseDir: tmpDir })

    expect(result.outputPath).toBe(outputPath)
    expect(result.outputSize).toBeGreaterThan(0)
    expect(result.mode).toBe('transparent')
    expect(result.width).toBe(12)
    expect(result.height).toBe(12)
    expect(result.processingRegion).toMatchObject({
      applied: true,
      x: 2,
      y: 1,
      width: 4,
      height: 6,
      sourceWidth: 8,
      sourceHeight: 8,
    })
    expect(result.crop.sourceWidth).toBe(4)
    expect(result.crop.sourceHeight).toBe(6)
    expect(result.placement.scaledW).toBeGreaterThan(0)

    const exported = await inspectImageFile(outputPath, { baseDir: tmpDir })
    expect(exported.width).toBe(12)
    expect(exported.height).toBe(12)
  })

  it('refuses to overwrite outputs unless explicitly requested', async () => {
    const inputPath = path.join(tmpDir, 'source.png')
    const outputPath = path.join(tmpDir, 'existing.png')
    await writeSampleGreenscreenPng(inputPath)
    await fs.writeFile(outputPath, 'already here')

    await expect(exportImageFile({
      inputPath,
      outputPath,
    }, { projectRoot, baseDir: tmpDir })).rejects.toThrow('already exists')
  })

  it('exports a single green-screen pose image as a Godot scene + ZIP bundle', async () => {
    const inputPath = path.join(tmpDir, 'idle_SE.png')
    await writeSampleGreenscreenPng(inputPath)

    const result = await exportGodotPoseImageFile({
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
        loop: true,
      },
    }, { projectRoot, baseDir: tmpDir })

    expect(result.basename).toBe('wenning_idle_SE')
    expect(result.frameCount).toBe(1)
    expect(result.scene.defaultAnimation).toBe('idle_SE')
    expect(result.scene.anchor).toBe('feet')
    expect(result.placement).toEqual(expect.objectContaining({ anchor: 'feet' }))

    for (const filePath of [result.outputPath, result.atlasPath, result.scenePath, result.metadataPath, result.bundlePath]) {
      const stat = await fs.stat(filePath)
      expect(stat.size).toBeGreaterThan(0)
    }

    const sceneText = await fs.readFile(result.scenePath, 'utf8')
    expect(sceneText).toContain('animation = &"idle_SE"')
    expect(sceneText).toContain('offset = Vector2(0, -32)')
  })

  it('exports Godot scene + ZIP bundle alongside SpriteFrames artifacts', async () => {
    const inputPath = path.join(tmpDir, 'walk_SE.mp4')
    await writeSampleGreenscreenMp4(inputPath)

    const result = await exportGodotSpriteFramesFile({
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
          {
            name: 'walk_SE',
            inputPath,
            frames: [0, 2],
            fps: 6,
            loop: true,
          },
          {
            name: 'walk_SW',
            mirrorOf: 'walk_SE',
            fps: 6,
            loop: true,
          },
        ],
      },
    }, { projectRoot, baseDir: tmpDir })

    expect(result.basename).toBe('wenning_walk')
    expect(path.basename(result.outputPath)).toBe('wenning_walk.tres')
    expect(path.basename(result.bundlePath)).toBe('wenning_walk.zip')
    expect(result.frameCount).toBe(4)

    expect(result.scene.defaultAnimation).toBe('walk_SE')
    expect(result.scene.anchor).toBe('feet')

    for (const filePath of [result.outputPath, result.atlasPath, result.scenePath, result.metadataPath, result.bundlePath]) {
      const stat = await fs.stat(filePath)
      expect(stat.size).toBeGreaterThan(0)
    }

    const sceneText = await fs.readFile(result.scenePath, 'utf8')
    expect(sceneText).toContain('[node name="AnimatedSprite2D" type="AnimatedSprite2D"]')
    expect(sceneText).toContain(`path="${result.spriteFramesResourcePath}"`)
    expect(sceneText).toContain('offset = Vector2(0, -32)')

    const bundle = await fs.readFile(result.bundlePath)
    expect(bundle.subarray(0, 2).toString('utf8')).toBe('PK')
    expect(bundle.includes(Buffer.from(path.basename(result.scenePath)))).toBe(true)
    expect(bundle.includes(Buffer.from(path.basename(result.outputPath)))).toBe(true)
  })
})

describe('Greenscreen Studio MCP protocol surface', () => {
  it('exposes tools, resources, prompts, and project info over MCP', async () => {
    const protocolTmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'greenscreen-mcp-protocol-'))
    const store = createProjectStore({ dataDir: protocolTmpDir, fresh: true })
    const sourcePath = path.join(protocolTmpDir, 'mcp-source.mp4')
    await fs.writeFile(sourcePath, 'video bytes')
    const project = store.createProject({ name: 'MCP Project' })
    const asset = store.addAsset(project.id, {
      kind: 'video',
      role: 'source',
      filePath: sourcePath,
      originalName: 'mcp-source.mp4',
      mimeType: 'video/mp4',
    })
    const clip = store.createActionClip(project.id, { assetId: asset.id, name: 'attack_SE', startFrame: 0, endFrame: 12 })
    store.addActionMarker(clip.id, { frame: 6, type: 'hit', payload: { hitbox: 'slash_a' } })
    store.updateActionClip(clip.id, { status: 'needs_review' })
    store.updateActionClip(clip.id, { status: 'approved' })

    const server = createGreenscreenMcpServer({ projectRoot, baseDir: projectRoot, dataDir: protocolTmpDir, store })
    const client = new Client({ name: 'greenscreen-mcp-test-client', version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()

    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ])

    try {
      const tools = await client.listTools()
      const toolNames = tools.tools.map(tool => tool.name)
      expect(toolNames).toEqual(expect.arrayContaining([
        'get_project_info',
        'inspect_image',
        'export_image',
        'export_godot_pose_image',
        'probe_video',
        'process_video',
        'find_loop_end',
        'export_spritesheet',
        'export_godot_spriteframes',
        'create_action_clip_export_task',
      ]))

      const resources = await client.listResources()
      expect(resources.resources.map(resource => resource.uri)).toEqual(expect.arrayContaining([
        'greenscreen://presets/default',
        'greenscreen://docs/workflows',
        'greenscreen://schemas/processing-params',
      ]))
      const schema = await client.readResource({ uri: 'greenscreen://schemas/processing-params' })
      const schemaJson = JSON.parse(schema.contents[0].text)
      expect(schemaJson.properties.region.required).toEqual(['x', 'y', 'width', 'height'])

      const prompts = await client.listPrompts()
      expect(prompts.prompts.map(prompt => prompt.name)).toContain('standardize_greenscreen_asset')

      const info = await client.callTool({ name: 'get_project_info', arguments: {} })
      expect(info.structuredContent.name).toBe('greenscreen-studio')
            expect(info.structuredContent.tools).toContain('process_video')
            expect(info.structuredContent.tools).toContain('list_projects')
            expect(info.structuredContent.tools).toContain('create_action_clip_export_task')
            expect(info.structuredContent.tools).toContain('claim_next_task')
            expect(info.structuredContent.resources).toContain('greenscreen://studio/overview')

      const queued = await client.callTool({
        name: 'create_action_clip_export_task',
        arguments: { projectId: project.id, clipId: clip.id, request: { target: 'godot' } },
      })
      expect(queued.structuredContent.payload).toMatchObject({
        type: ACTION_CLIP_EXPORT_TASK_TYPE,
        clipId: clip.id,
        clip: { status: 'approved' },
        markers: [expect.objectContaining({ type: 'hit', payload: { hitbox: 'slash_a' } })],
      })

      const claimed = await client.callTool({
        name: 'claim_next_task',
        arguments: { projectId: project.id, workerId: 'mcp-agent' },
      })
      expect(claimed.structuredContent.claimed).toBe(true)
      expect(claimed.structuredContent.task.id).toBe(queued.structuredContent.id)

      const validated = await client.callTool({
        name: 'validate_processing_params',
        arguments: {
          params: {
            mode: 'transparent',
            region: { x: 5, y: 6, width: 7, height: 8 },
          },
        },
      })
      expect(validated.structuredContent.params.region).toEqual({ x: 5, y: 6, width: 7, height: 8 })
    } finally {
      await client.close()
      await server.close()
      store.close()
      await fs.rm(protocolTmpDir, { recursive: true, force: true })
    }
  })
})

async function writeSampleGreenscreenPng(filePath) {
  const canvas = createCanvas(8, 8)
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = 'rgb(0, 255, 0)'
  ctx.fillRect(0, 0, 8, 8)
  ctx.fillStyle = 'rgb(20, 60, 220)'
  ctx.fillRect(2, 1, 4, 6)
  await fs.writeFile(filePath, canvas.toBuffer('image/png'))
}

async function writeSampleGreenscreenMp4(filePath) {
  const result = spawnSync(ffmpegPath, [
    '-y',
    '-f', 'lavfi',
    '-i', 'color=c=0x00ff00:s=64x64:r=6:d=1',
    '-vf', 'drawbox=x=24:y=8:w=16:h=48:color=red:t=fill',
    '-an',
    filePath,
  ], { encoding: 'utf8' })
  if (result.status !== 0) {
    throw new Error(result.stderr || 'failed to create sample greenscreen mp4')
  }
}
