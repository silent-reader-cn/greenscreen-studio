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
  exportImageFile,
  inspectImageFile,
  normalizeProcessingParams,
} from '../mcp/server.mjs'

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
    expect(params.region).toEqual({ x: 3, y: 0, width: 21, height: 10 })
    expect(params.mode).toBe('transparent')
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
})

describe('Greenscreen Studio MCP protocol surface', () => {
  it('exposes tools, resources, prompts, and project info over MCP', async () => {
    const server = createGreenscreenMcpServer({ projectRoot, baseDir: projectRoot })
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
        'probe_video',
        'process_video',
        'find_loop_end',
        'export_spritesheet',
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
