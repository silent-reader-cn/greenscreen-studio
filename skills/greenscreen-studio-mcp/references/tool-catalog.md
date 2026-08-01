# Greenscreen Studio MCP Tool Catalog

Use these tools through the `greenscreen-studio` MCP server.

## get_project_info

Return server version, project root, default params, presets, resources, prompts, and available tools.

Arguments: none.

Use first when a client needs discovery or configuration hints.

## validate_processing_params

Normalize partial keying/layout params.

Arguments:

```json
{
  "params": {
    "keying": {
      "keyColor": [0, 255, 0],
      "tolerance": 30,
      "spillSuppression": 40,
      "feather": 15,
      "edgeShrink": 0
    },
    "layout": {
      "canvasWidth": 1024,
      "canvasHeight": 1024,
      "personWidth": 760,
      "personHeight": 940,
      "autoCrop": true,
      "bgColor": [0, 255, 0],
      "anchor": "center",
      "anchorOffset": { "x": 0, "y": 0 }
    },
    "cleanup": {
      "removePaleGreenMarkers": false,
      "removeSmallComponents": false,
      "keepLargestComponent": false,
      "minComponentPixels": 64,
      "alphaThreshold": 10
    },
    "region": {
      "x": 120,
      "y": 80,
      "width": 640,
      "height": 560
    },
    "mode": "greenscreen"
  }
}
```

`mode` is `greenscreen` or `transparent`. Missing fields use defaults.

`layout.anchor` is `center`, `bottom_center`, or `feet`. `feet` aligns the cropped character's bottom to the centered `personWidth` x `personHeight` safe-area bottom, which is useful for Godot sprites.

Cleanup runs after chroma keying and before auto-crop, so removed markers and components do not affect scaling or placement.

`region` is optional and limits processing to a source pixel rectangle before keying, cleanup, auto-crop, and layout. Use it to match the WebUI video processing-region selector.

## inspect_image

Load a local image and return dimensions, file size, and MIME guess.

Arguments:

```json
{ "inputPath": "C:/path/source.png" }
```

## export_image

Apply chroma keying, auto-crop, centering, and scaling to an image. Always writes PNG.

Arguments:

```json
{
  "inputPath": "C:/path/source.png",
  "outputPath": "C:/path/output.png",
  "params": {
    "mode": "transparent",
    "layout": {
      "canvasWidth": 1024,
      "canvasHeight": 1024,
      "personWidth": 760,
      "personHeight": 940
    }
  },
  "overwrite": false
}
```

If `outputPath` is omitted, the tool creates a temp PNG and returns the path.

## probe_video

Run ffprobe and return width, height, fps, duration, frame count, audio presence, and codec.

Arguments:

```json
{ "inputPath": "C:/path/source.mp4" }
```

Call before `process_video`, `find_loop_end`, or `export_spritesheet`.

## process_video

Apply the frame-by-frame Greenscreen Studio video pipeline and write a processed video.

Arguments:

```json
{
  "inputPath": "C:/path/source.mp4",
  "outputPath": "C:/path/output.webm",
  "format": "webm",
  "params": {
    "mode": "transparent",
    "keying": {
      "tolerance": 35,
      "spillSuppression": 45,
      "feather": 12
    },
    "layout": {
      "canvasWidth": 1024,
      "canvasHeight": 1024,
      "personWidth": 760,
      "personHeight": 940,
      "autoCrop": true
    },
    "region": {
      "x": 120,
      "y": 80,
      "width": 640,
      "height": 560
    }
  },
  "range": {
    "startFrame": 0,
    "endFrame": 120
  },
  "overwrite": false
}
```

Transparent mode supports `webm` and `mov`. Green-screen mode supports `mp4`, `webm`, and `mov`. If `format` is omitted, transparent defaults to `webm`, green-screen defaults to `mp4`.

## find_loop_end

Find candidate end frames that visually match a chosen start frame. It can compare raw frames or processed preview frames when `params` are provided.

Arguments:

```json
{
  "inputPath": "C:/path/source.mp4",
  "startFrame": 0,
  "params": {
    "mode": "greenscreen",
    "layout": {
      "canvasWidth": 1024,
      "canvasHeight": 1024,
      "personWidth": 760,
      "personHeight": 940
    }
  },
  "options": {
    "maxSearch": 300,
    "step": 2,
    "hashSize": 16,
    "minSpacing": 12,
    "earlyFrameExclusion": 18,
    "maxCandidates": 5,
    "motionWeight": 0.35,
    "suspiciousCloseThreshold": 24
  }
}
```

Use the best candidate as `range.endFrame` for a looping export, but prefer showing candidates when the user should decide. Candidates inside `max(minSpacing, earlyFrameExclusion)` frames from `startFrame` are excluded. Returned candidates include visual `score`, `adjustedScore`, `motionScore`, and `valleyDepth`, plus warnings if the best match is suspiciously close.

## export_spritesheet

Sample keyed video frames and write a PNG sprite sheet.

Arguments:

```json
{
  "inputPath": "C:/path/source.mp4",
  "outputPath": "C:/path/spritesheet.png",
  "params": {
    "mode": "transparent",
    "layout": {
      "canvasWidth": 512,
      "canvasHeight": 512,
      "personWidth": 420,
      "personHeight": 480
    }
  },
  "spriteParams": {
    "frameWidth": 512,
    "frameHeight": 512,
    "framesPerRow": 8,
    "sampleEvery": 2,
    "maxFrames": 64,
    "range": {
      "startFrame": 0,
      "endFrame": 120
    }
  },
  "overwrite": false
}
```

For exact animation clips, use `frames` instead of sampled selection:

```json
{
  "spriteParams": {
    "frameWidth": 256,
    "frameHeight": 256,
    "framesPerRow": 6,
    "frames": [0, 6, 12, 19, 25, 31]
  }
}
```

`range` is end-exclusive. If `frames` and `range` are both supplied, explicit frames outside the range are omitted. Metadata is returned in deterministic ascending source-frame order.

The output reports `frameCount`, `sheetWidth`, `sheetHeight`, `cols`, `rows`, `atlasDimensions`, per-frame `region`, per-frame `sourceFrameIndex`, `crop`, `placement`, cleanup stats, selection metadata, and warnings.

## export_godot_spriteframes

Export a Godot-ready atlas PNG, SpriteFrames `.tres`, feet-anchored AnimatedSprite2D `.tscn`, metadata JSON, and ZIP bundle.

Arguments:

```json
{
  "outputPath": "C:/godot/project/characters/wenning_walk.tres",
  "atlasPath": "C:/godot/project/characters/wenning_walk_atlas.png",
  "scenePath": "C:/godot/project/characters/wenning_walk.tscn",
  "metadataPath": "C:/godot/project/characters/wenning_walk_metadata.json",
  "bundlePath": "C:/godot/project/characters/wenning_walk.zip",
  "params": {
    "mode": "transparent",
    "layout": {
      "anchor": "feet",
      "sourceCharacterHeight": 520
    },
    "cleanup": {
      "removePaleGreenMarkers": true,
      "keepLargestComponent": true,
      "removeSmallComponents": true,
      "minComponentPixels": 48
    }
  },
  "godot": {
    "characterName": "wenning",
    "actionName": "walk",
    "frameWidth": 256,
    "frameHeight": 256,
    "safeAreaWidth": 160,
    "safeAreaHeight": 160,
    "framesPerRow": 8,
    "fps": 12,
    "godotProjectRoot": "C:/godot/project",
    "animationGroups": [
      {
        "name": "walk",
        "fps": 12,
        "loop": true,
        "directions": {
          "SE": { "inputPath": "C:/captures/walk_SE.mp4", "frames": [0, 6, 12, 18] },
          "NE": { "inputPath": "C:/captures/walk_NE.mp4", "frames": [0, 6, 12, 18] }
        },
        "mirror": {
          "SW": "SE",
          "NW": "NE"
        }
      }
    ]
  },
  "overwrite": false
}
```

Flat `animations` are also supported for clips named exactly as desired, such as `idle_SE`, `walk_start_NE`, `walk_loop_SE`, and `walk_stop_NW`. Use `mirrorOf` on a flat animation to generate a horizontally flipped copy of an earlier animation.

When `outputPath` is omitted, the tool chooses a basename from:

- multi-direction pack: `character_action`
- single animation: `character_action_direction`
- explicit override: `godot.exportName`

The returned metadata includes basename, atlas dimensions, animation names, scene defaults, per-frame regions, per-frame source video frame indexes, flip flags, keying/layout params used, crop/placement information, cleanup statistics, and warnings. The ZIP contains the atlas, `.tres`, `.tscn`, and metadata as sibling files.
