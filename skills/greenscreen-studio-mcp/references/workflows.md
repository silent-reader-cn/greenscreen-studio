# Greenscreen Studio MCP Workflows

## Transparent PNG Character

1. Call `inspect_image` with the source image path.
2. Call `validate_processing_params` with `mode: "transparent"` and any requested layout changes.
3. Call `export_image`.
4. Verify `width`, `height`, `mode`, `outputSize`, and `outputPath`.

Minimal arguments:

```json
{
  "inputPath": "C:/assets/actor.png",
  "outputPath": "C:/assets/actor_transparent.png",
  "params": { "mode": "transparent" }
}
```

## Green-Screen PNG Character

Use `export_image` with `mode: "greenscreen"` when the output should remain on a solid key color for downstream compositing.

If the background should be a non-default key color, set both `keying.keyColor` and `layout.bgColor` to the same RGB triplet unless the user explicitly wants different values.

## Transparent Video

1. Call `probe_video`.
2. For quick validation, call `process_video` with a short `range`, such as frames 0 to 30.
3. For final output, remove `range` or set the approved loop range.

Video auto-crop scans the requested frame range and then reuses one stable anchor crop box for every exported frame, so changing silhouettes do not change the per-frame scaling basis.

Recommended formats:

- `webm`: compact transparent VP9 output.
- `mov`: ProRes 4444 with alpha for editing pipelines.

Example:

```json
{
  "inputPath": "C:/assets/actor.mp4",
  "outputPath": "C:/assets/actor_alpha.webm",
  "format": "webm",
  "params": { "mode": "transparent" }
}
```

## Green-Screen MP4 Video

Use `process_video` with `mode: "greenscreen"` and `format: "mp4"` for H.264 output on a solid key-color background.

Example:

```json
{
  "inputPath": "C:/assets/actor.mp4",
  "outputPath": "C:/assets/actor_standardized.mp4",
  "format": "mp4",
  "params": {
    "mode": "greenscreen",
    "layout": {
      "canvasWidth": 1080,
      "canvasHeight": 1920,
      "personWidth": 820,
      "personHeight": 1700
    }
  }
}
```

## Loop Candidate Search

1. Call `probe_video`.
2. Pick a `startFrame`, commonly 0 or the first clean pose.
3. Call `find_loop_end` with the same `params` intended for export so similarity is evaluated after processing.
4. Set `options.minSpacing` and `options.earlyFrameExclusion` high enough that adjacent or near-adjacent poses cannot be returned. For walking loops, start around 12 to 18 frames at 30 fps, then adjust by cadence.
5. Use `bestCandidate.frame` as `range.endFrame`, or present the candidate list if user judgment matters.
6. Inspect warnings. If the best candidate is suspiciously close to `startFrame`, prefer a later candidate or increase `earlyFrameExclusion`.
7. Call `process_video` with `range: { "startFrame": <start>, "endFrame": <candidate> }`.

Example options:

```json
{
  "maxSearch": 240,
  "step": 2,
  "hashSize": 16,
  "minSpacing": 16,
  "earlyFrameExclusion": 18,
  "maxCandidates": 8,
  "motionWeight": 0.35,
  "suspiciousCloseThreshold": 24
}
```

Returned candidates include `score`, `adjustedScore`, `motionScore`, and `valleyDepth`. Low visual score is useful, but prefer candidates with a good adjusted score and a plausible pose boundary.

## Sprite Sheet

1. Call `probe_video` to estimate frame count and choose sampling.
2. Choose cell size with `spriteParams.frameWidth` and `spriteParams.frameHeight`.
3. Set `framesPerRow` for the target atlas width.
4. Use `sampleEvery`, `range`, and `maxFrames` to control density.
5. Call `export_spritesheet`.

For previews, cap `maxFrames` to 16 or 32. For final game atlases, compute rows from `ceil(maxFrames / framesPerRow)` and verify the returned `sheetWidth` and `sheetHeight`.

## Exact-Frame Sprite Sheet

Use exact frames when an animation clip needs selected poses, for example `idle`, `walk_start`, `walk_loop`, or `walk_stop`.

```json
{
  "inputPath": "C:/assets/walk_down.mp4",
  "outputPath": "C:/assets/walk_down_loop.png",
  "params": {
    "mode": "transparent",
    "layout": {
      "canvasWidth": 256,
      "canvasHeight": 256,
      "personWidth": 160,
      "personHeight": 160,
      "anchor": "feet"
    },
    "cleanup": {
      "removePaleGreenMarkers": true,
      "keepLargestComponent": true,
      "removeSmallComponents": true,
      "minComponentPixels": 48
    }
  },
  "spriteParams": {
    "frameWidth": 256,
    "frameHeight": 256,
    "framesPerRow": 6,
    "frames": [0, 6, 12, 19, 25, 31]
  }
}
```

Frame metadata is returned in ascending source-frame order and includes each atlas region, source video frame index, crop, placement, cleanup stats, and warnings.

## Godot SpriteFrames

Use `export_godot_spriteframes` when the desired result is a Godot `SpriteFrames` resource rather than a standalone PNG.

Recommended settings for a top-down character:

- Outer frame: 256 x 256.
- Character safe area: 160 x 160.
- `layout.anchor: "feet"` to keep a stable baseline.
- `mode: "transparent"`.
- Cleanup enabled before auto-crop when pale-green tracking dots or isolated pixels are present.

Example:

```json
{
  "outputPath": "C:/godot/project/characters/hero_spriteframes.tres",
  "atlasPath": "C:/godot/project/characters/hero_atlas.png",
  "metadataPath": "C:/godot/project/characters/hero_metadata.json",
  "params": {
    "mode": "transparent",
    "layout": {
      "anchor": "feet"
    },
    "cleanup": {
      "removePaleGreenMarkers": true,
      "keepLargestComponent": true,
      "removeSmallComponents": true,
      "minComponentPixels": 48
    }
  },
  "godot": {
    "frameWidth": 256,
    "frameHeight": 256,
    "safeAreaWidth": 160,
    "safeAreaHeight": 160,
    "framesPerRow": 8,
    "fps": 12,
    "godotProjectRoot": "C:/godot/project",
    "animationGroups": [
      {
        "name": "walk_loop",
        "fps": 12,
        "loop": true,
        "directions": {
          "down": { "inputPath": "C:/captures/down.mp4", "frames": [0, 6, 12, 18] },
          "down_right": { "inputPath": "C:/captures/down_right.mp4", "frames": [0, 6, 12, 18] },
          "right": { "inputPath": "C:/captures/right.mp4", "frames": [0, 6, 12, 18] },
          "up_right": { "inputPath": "C:/captures/up_right.mp4", "frames": [0, 6, 12, 18] },
          "up": { "inputPath": "C:/captures/up.mp4", "frames": [0, 6, 12, 18] }
        },
        "mirror": {
          "down_left": "down_right",
          "left": "right",
          "up_left": "up_right"
        }
      }
    ]
  }
}
```

For five source directions, capture or generate `down`, `down_right`, `right`, `up_right`, and `up`. Mirror `left` from `right`, `down_left` from `down_right`, and `up_left` from `up_right`. Keep `up` and `down` unmirrored unless the source art is symmetric enough for that to be intentional.

For full movement sets, use animation group names such as:

- `idle`
- `walk_start`
- `walk_loop` or `walk`
- `walk_stop`

The tool will produce Godot animation names such as `idle_down`, `walk_start_right`, `walk_loop_up_left`, and `walk_stop_down`.

## Artifact Cleanup

Cleanup runs after chroma keying and before auto-crop.

Use:

- `removePaleGreenMarkers: true` for pale-green tracking dots that survive RGB-distance keying.
- `keepLargestComponent: true` for a single character silhouette.
- `removeSmallComponents: true` with `minComponentPixels` around 32 to 96 for dust, marker fragments, or detached specks.
- Higher `minComponentPixels` only after verifying it does not remove small character parts such as hands, weapon tips, or hair.

## Verification Checklist

- Output path exists and has nonzero size.
- Image outputs report expected canvas dimensions.
- Video outputs report completed progress and a plausible `result.frameCount`.
- Chosen mode and format are compatible.
- If a user supplied explicit dimensions, the returned `params.layout` preserves them after normalization.
- Sprite and Godot exports report expected `frameCount`, `atlasDimensions`, per-frame regions, and source frame indexes.
- Check `cleanup` stats to confirm marker/component removal happened when enabled.
- Check warnings for suspicious loop candidates, empty foregrounds, out-of-canvas placement, or remaining foreground components.
