const GODOT_EVENT_DISPATCHER_FILENAME = 'action_event_dispatcher.gd';

function buildGodotEventDispatcherScript({ eventsResourcePath = 'res://events.json' } = {}) {
  const safeEventsPath = String(eventsResourcePath).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `extends Node
class_name GreenscreenActionEventDispatcher

signal action_event(event: Dictionary)

@export var sprite_path: NodePath = NodePath("..")
@export_file("*.json") var events_path: String = "${safeEventsPath}"

var _sprite: AnimatedSprite2D
var _tracks: Dictionary = {}
var _last_animation: StringName = &""
var _last_frame := -1

func _ready() -> void:
  _sprite = get_node_or_null(sprite_path) as AnimatedSprite2D
  if _sprite == null:
    push_warning("Action event dispatcher could not find an AnimatedSprite2D at " + String(sprite_path))
    return
  _load_events()
  _sprite.animation_changed.connect(_on_animation_changed)
  _sprite.frame_changed.connect(_on_frame_changed)
  _on_animation_changed()
  _on_frame_changed()

func dispatch_action_event(event: Dictionary) -> void:
  action_event.emit(event)

func _load_events() -> void:
  _tracks.clear()
  var file := FileAccess.open(events_path, FileAccess.READ)
  if file == null:
    push_warning("Action event dispatcher could not open " + events_path)
    return
  var document: Variant = JSON.parse_string(file.get_as_text())
  if not (document is Dictionary):
    push_warning("Action event dispatcher expected a JSON object in " + events_path)
    return
  for track_value: Variant in document.get("tracks", []):
    if not (track_value is Dictionary):
      continue
    var animation_value: Variant = track_value.get("animation", {})
    if not (animation_value is Dictionary):
      continue
    var animation_name := StringName(String(animation_value.get("name", "")))
    if not animation_name.is_empty():
      _tracks[animation_name] = track_value

func _on_animation_changed() -> void:
  _last_animation = _sprite.animation
  _last_frame = -1

func _on_frame_changed() -> void:
  var animation_name := _sprite.animation
  var animation_frame := _sprite.frame
  if animation_name != _last_animation:
    _last_animation = animation_name
    _last_frame = -1
  if animation_frame == _last_frame:
    return
  _last_frame = animation_frame
  var track_value: Variant = _tracks.get(animation_name, {})
  if not (track_value is Dictionary):
    return
  for event_value: Variant in track_value.get("events", []):
    if event_value is Dictionary and int(event_value.get("animationFrame", -1)) == animation_frame:
      dispatch_action_event(event_value)
`;
}

module.exports = {
  GODOT_EVENT_DISPATCHER_FILENAME,
  buildGodotEventDispatcherScript,
};
