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
4. Use `bestCandidate.frame` as `range.endFrame`, or present the candidate list if user judgment matters.
5. Call `process_video` with `range: { "startFrame": <start>, "endFrame": <candidate> }`.

## Sprite Sheet

1. Call `probe_video` to estimate frame count and choose sampling.
2. Choose cell size with `spriteParams.frameWidth` and `spriteParams.frameHeight`.
3. Set `framesPerRow` for the target atlas width.
4. Use `sampleEvery` and `maxFrames` to control density.
5. Call `export_spritesheet`.

For previews, cap `maxFrames` to 16 or 32. For final game atlases, compute rows from `ceil(maxFrames / framesPerRow)` and verify the returned `sheetWidth` and `sheetHeight`.

## Verification Checklist

- Output path exists and has nonzero size.
- Image outputs report expected canvas dimensions.
- Video outputs report completed progress and a plausible `result.frameCount`.
- Chosen mode and format are compatible.
- If a user supplied explicit dimensions, the returned `params.layout` preserves them after normalization.
