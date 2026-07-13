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
      "bgColor": [0, 255, 0]
    },
    "mode": "greenscreen"
  }
}
```

`mode` is `greenscreen` or `transparent`. Missing fields use defaults.

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
    "maxCandidates": 5
  }
}
```

Use the best candidate as `range.endFrame` for a looping export, but prefer showing candidates when the user should decide.

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
    "maxFrames": 64
  },
  "overwrite": false
}
```

The output reports `frameCount`, `sheetWidth`, `sheetHeight`, `cols`, and `rows`.
