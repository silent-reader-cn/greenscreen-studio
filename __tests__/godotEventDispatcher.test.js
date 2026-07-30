import { describe, expect, it } from 'vitest'
import { createRequire } from 'module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const require = createRequire(import.meta.url)
const {
  GODOT_EVENT_DISPATCHER_FILENAME,
  buildGodotEventDispatcherScript,
} = require('../godotEventDispatcher.cjs')
const godotPath = 'D:/godot/Godot_v4.6.3-stable_win64_console.exe'
const hasGodot = fs.existsSync(godotPath)

describe('Godot action event dispatcher reference', () => {
  it('builds a minimal AnimatedSprite2D dispatcher for the exported event document', () => {
    const script = buildGodotEventDispatcherScript()

    expect(GODOT_EVENT_DISPATCHER_FILENAME).toBe('action_event_dispatcher.gd')
    expect(script).toContain('class_name GreenscreenActionEventDispatcher')
    expect(script).toContain('signal action_event(event: Dictionary)')
    expect(script).toContain('@export var sprite_path: NodePath = NodePath("..")')
    expect(script).toContain('@export_file("*.json") var events_path: String = "res://events.json"')
    expect(script).toContain('func dispatch_action_event(event: Dictionary) -> void:')
    expect(script).toContain('_sprite.animation_changed.connect(_on_animation_changed)')
    expect(script).toContain('_sprite.frame_changed.connect(_on_frame_changed)')
    expect(script).toContain('int(event_value.get("animationFrame", -1)) == animation_frame')
  })

  it('escapes a custom Godot resource path', () => {
    const script = buildGodotEventDispatcherScript({ eventsResourcePath: 'res://action\"events.json' })
    expect(script).toContain('res://action\\\"events.json')
  })

  it.skipIf(!hasGodot)('loads the generated dispatcher script in Godot', () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gss-dispatcher-godot-'))
    try {
      fs.writeFileSync(path.join(workDir, 'project.godot'), 'config_version=5\n', 'utf8')
      fs.writeFileSync(
        path.join(workDir, GODOT_EVENT_DISPATCHER_FILENAME),
        buildGodotEventDispatcherScript(),
        'utf8',
      )
      fs.writeFileSync(path.join(workDir, 'verify.gd'), `extends SceneTree

func _init() -> void:
  var dispatcher_script := load("res://${GODOT_EVENT_DISPATCHER_FILENAME}")
  if dispatcher_script == null:
    quit(1)
    return
  print("DISPATCHER_SCRIPT_OK")
  quit(0)
`, 'utf8')

      const result = spawnSync(godotPath, [
        '--headless',
        '--path', workDir,
        '-s', 'res://verify.gd',
      ], { encoding: 'utf8', windowsHide: true })
      expect(`${result.stdout}\n${result.stderr}`).toContain('DISPATCHER_SCRIPT_OK')
      expect(result.status).toBe(0)
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true })
    }
  }, 30_000)
})
