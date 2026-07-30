const { spawn } = require('child_process');
const fs = require('fs/promises');
const path = require('path');
const AdmZip = require('adm-zip');

const REQUIRED_EXTENSIONS = new Set(['.png', '.tres', '.tscn', '.json']);
const RESULT_PREFIX = 'GREenscreenGodotSmoke:';

function assertSafeZipEntry(entryName) {
  const normalized = String(entryName || '').replace(/\\/g, '/');
  if (!normalized || normalized.startsWith('/') || normalized.includes('../')) {
    throw new Error(`Unsafe ZIP entry: ${entryName}`);
  }
  return normalized;
}

function collectBundleEntries(bundlePath) {
  const zip = new AdmZip(bundlePath);
  const entries = zip.getEntries().filter(entry => !entry.isDirectory);
  if (entries.length === 0) throw new Error('Godot ZIP contains no files');

  const names = entries.map(entry => assertSafeZipEntry(entry.entryName));
  const extensions = new Set(names.map(name => path.extname(name).toLowerCase()));
  for (const extension of REQUIRED_EXTENSIONS) {
    if (!extensions.has(extension)) throw new Error(`Godot ZIP is missing ${extension} artifact`);
  }

  const scenes = names.filter(name => path.extname(name).toLowerCase() === '.tscn');
  if (scenes.length !== 1) {
    throw new Error(`Godot ZIP must contain exactly one .tscn scene; found ${scenes.length}`);
  }

  return { zip, names, scenePath: scenes[0] };
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
}

function escapeGdString(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function buildSmokeScript(scenePath, { validateEvents = false } = {}) {
  const resourcePath = `res://${scenePath}`;
  const eventValidation = validateEvents ? `
  var events_file := FileAccess.open("res://events.json", FileAccess.READ)
  if events_file == null:
    fail("Could not open res://events.json")
    return
  var event_document: Variant = JSON.parse_string(events_file.get_as_text())
  if not (event_document is Dictionary):
    fail("events.json root is not a Dictionary")
    return
  var tracks: Array = event_document.get("tracks", [])
  if tracks.is_empty() or not (tracks[0] is Dictionary):
    fail("events.json has no importable track")
    return
  var track: Dictionary = tracks[0]
  var events: Array = track.get("events", [])
  if events.is_empty() or not (events[0] is Dictionary):
    fail("events.json has no semantic event")
    return
  var expected_event: Dictionary = events[0]
  var dispatcher_script := load("res://action_event_dispatcher.gd")
  if dispatcher_script == null:
    fail("Could not load action_event_dispatcher.gd")
    return
  var dispatcher: Node = dispatcher_script.new()
  dispatcher.name = "ActionEventDispatcher"
  dispatcher.connect("action_event", Callable(self, "_on_action_event"))
  sprite.add_child(dispatcher)
  await process_frame
  var event_animation: Dictionary = track.get("animation", {})
  sprite.animation = StringName(String(event_animation.get("name", animation_name)))
  sprite.frame = int(expected_event.get("animationFrame", -1))
  await process_frame
  if received_event.is_empty():
    fail("Dispatcher did not emit the expected semantic event")
    return
  if String(received_event.get("id", "")) != String(expected_event.get("id", "")):
    fail("Dispatcher emitted the wrong semantic event")
    return
` : '';
  return `extends SceneTree

const RESULT_PREFIX := "${RESULT_PREFIX}"
const SCENE_PATH := "${escapeGdString(resourcePath)}"

var received_event: Dictionary = {}

func fail(message: String) -> void:
  push_error(message)
  print(RESULT_PREFIX + JSON.stringify({"error": message}))
  quit(1)

func _on_action_event(event: Dictionary) -> void:
  received_event = event

func _init() -> void:
  var packed := load(SCENE_PATH)
  if packed == null or not (packed is PackedScene):
    fail("Could not load PackedScene: " + SCENE_PATH)
    return

  var node: Node = packed.instantiate()
  if not (node is AnimatedSprite2D):
    fail("Root node is not AnimatedSprite2D: " + node.get_class())
    return

  var sprite := node as AnimatedSprite2D
  if sprite.sprite_frames == null:
    fail("AnimatedSprite2D has no SpriteFrames resource")
    return

  var animation_name := String(sprite.animation)
  if animation_name.is_empty():
    fail("AnimatedSprite2D has no default animation")
    return
  if not sprite.sprite_frames.has_animation(StringName(animation_name)):
    fail("SpriteFrames is missing default animation: " + animation_name)
    return

  root.add_child(sprite)
  sprite.pause()
${eventValidation}

  print(RESULT_PREFIX + JSON.stringify({
    "nodeType": node.get_class(),
    "animation": animation_name,
    "autoplay": String(sprite.autoplay),
    "animationNames": sprite.sprite_frames.get_animation_names(),
    "eventId": String(received_event.get("id", "")),
    "eventType": String(received_event.get("type", "")),
  }))
  quit(0)
`;
}

async function smokeGodotZip({ bundlePath, godotPath, workDir }) {
  if (!bundlePath) throw new Error('bundlePath is required');
  if (!godotPath) throw new Error('godotPath is required');
  await fs.access(bundlePath);
  await fs.access(godotPath);

  const baseDir = workDir || path.dirname(bundlePath);
  await fs.mkdir(baseDir, { recursive: true });
  const projectDir = await fs.mkdtemp(path.join(baseDir, 'godot-smoke-'));
  const { zip, names, scenePath } = collectBundleEntries(bundlePath);
  const validateEvents = names.includes('events.json') && names.includes('action_event_dispatcher.gd');
  zip.extractAllTo(projectDir, true);

  await fs.writeFile(path.join(projectDir, 'project.godot'), `; Engine configuration file.\n; Generated by Greenscreen Studio smoke validation.\nconfig_version=5\n\n[application]\nconfig/name="Greenscreen Studio Export Smoke"\n`, 'utf8');
  await fs.writeFile(path.join(projectDir, 'smoke.gd'), buildSmokeScript(scenePath, { validateEvents }), 'utf8');

  // Generate Godot's import cache before resource loading, matching first open in a real project.
  const importResult = await run(godotPath, ['--headless', '--path', projectDir, '--import'], { cwd: projectDir });
  if (importResult.code !== 0) {
    const detail = `${importResult.stdout}\n${importResult.stderr}`.trim().slice(-4000);
    throw new Error(`Godot import failed: ${detail || `exit ${importResult.code}`}`);
  }

  const result = await run(godotPath, ['--headless', '--path', projectDir, '-s', 'res://smoke.gd'], { cwd: projectDir });
  const combined = `${result.stdout}\n${result.stderr}`;
  const line = combined.split(/\r?\n/).find(value => value.startsWith(RESULT_PREFIX));
  const payload = line ? JSON.parse(line.slice(RESULT_PREFIX.length)) : null;

  if (result.code !== 0 || payload?.error || !payload) {
    const engineLog = combined.trim().slice(-4000);
    const detail = payload?.error
      ? `${payload.error}\n${engineLog}`
      : engineLog || `Godot exited ${result.code}`;
    throw new Error(`Godot smoke failed: ${detail}`);
  }

  return {
    projectDir,
    scenePath,
    extractedFiles: names,
    nodeType: payload.nodeType,
    animation: payload.animation,
    autoplay: payload.autoplay,
    animationNames: payload.animationNames,
    eventId: payload.eventId || null,
    eventType: payload.eventType || null,
    eventsValidated: validateEvents,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

module.exports = {
  collectBundleEntries,
  smokeGodotZip,
};
