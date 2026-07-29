import { afterEach, describe, expect, it } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import AdmZip from 'adm-zip'
import { createRequire } from 'module'

const require = createRequire(import.meta.url)
const { createGodotBundle } = require('../godotBundle.cjs')
const tempDirs = []

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
})

describe('createGodotBundle', () => {
  it('supports explicit archive entry names while preserving legacy paths', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gss-godot-bundle-'))
    tempDirs.push(tempDir)
    const atlasPath = path.join(tempDir, 'hero_atlas.png')
    const uniqueEventsPath = path.join(tempDir, 'hero_job_123_events.json')
    const bundlePath = path.join(tempDir, 'hero.zip')
    fs.writeFileSync(atlasPath, 'atlas')
    fs.writeFileSync(uniqueEventsPath, '{"schemaVersion":1}')

    await createGodotBundle(bundlePath, [
      atlasPath,
      { path: uniqueEventsPath, name: 'events.json' },
    ])

    const entries = new AdmZip(bundlePath).getEntries().map((entry) => entry.entryName)
    expect(entries).toEqual(['hero_atlas.png', 'events.json'])
    expect(entries).not.toContain(path.basename(uniqueEventsPath))
  })
})
