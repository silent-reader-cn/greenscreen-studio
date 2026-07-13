---
name: greenscreen-studio-mcp
description: "Use when Codex should operate the Greenscreen Studio local MCP server for green-screen image or video workflows: inspect media files, normalize keying/layout params, export transparent PNG/WebM/MOV or green-screen PNG/MP4/WebM/MOV outputs, find video loop end frames, export sprite sheets, or help configure this repo's MCP server for an MCP client."
---

# Greenscreen Studio MCP

## Overview

Use this skill to drive the Greenscreen Studio MCP server from an AI client. The server exposes the project's image keying, video processing, loop detection, sprite-sheet, and Godot character-animation pipeline through local stdio MCP tools.

The MCP entrypoint is `mcp/server.mjs` from the repository root. Prefer `npm run mcp` for manual smoke checks, and configure MCP clients with command `node` and args `["<repo>/mcp/server.mjs"]`.

## Workflow

1. Confirm dependencies are installed with `npm install` if `node_modules/` is missing.
2. Use MCP resources first when unsure:
   - Read `greenscreen://presets/default` for default params and presets.
   - Read `greenscreen://docs/workflows` for recommended tool sequences.
   - Read `greenscreen://schemas/processing-params` for accepted keying/layout fields.
3. Inspect before processing:
   - Images: call `inspect_image`.
   - Videos: call `probe_video`.
4. Normalize params with `validate_processing_params` before export when user-provided settings are partial, ambiguous, or generated.
5. Export with `export_image`, `process_video`, `export_spritesheet`, or `export_godot_spriteframes`.
6. Verify the returned `outputPath`, dimensions, mode, format, output size, cleanup stats, crop/placement metadata, and warnings. For videos, check the returned `progress.percent` and `result.frameCount`.

## Tool Routing

Read `references/tool-catalog.md` before invoking a tool you have not used in the current task or when exact arguments matter.

Read `references/workflows.md` for end-to-end tasks such as transparent character export, green-screen MP4 export, loop trimming, exact-frame sprite sheets, and Godot SpriteFrames generation.

Read `references/client-config.md` when the user asks how to connect this MCP server to a desktop MCP client.

## Operational Rules

- Use local file paths only. The MCP rejects URLs.
- Relative paths resolve from the MCP client's working directory; absolute paths are safer.
- Export tools create temp outputs when `outputPath` is omitted.
- Existing output files are protected by default. Pass `overwrite: true` only when the user asked to replace a file or the path is clearly scratch output.
- Transparent video supports `webm` and `mov`; green-screen video supports `mp4`, `webm`, and `mov`.
- Long video calls can exceed client request timeouts. For tests or previews, pass a small `range` such as `{ "startFrame": 0, "endFrame": 30 }`.
- Prefer preserving the same `params` across preview, loop detection, final export, and sprite sheet generation so results match.
- For game sprites, prefer `mode: "transparent"` and set `layout.anchor: "feet"` or `"bottom_center"` when a stable baseline matters. The default anchor remains `"center"` for backward compatibility.
- For exact clips such as `idle`, `walk_start`, `walk_loop`, and `walk_stop`, pass `spriteParams.frames` or Godot clip `frames` explicitly instead of relying on `sampleEvery`.
- Enable cleanup before auto-crop when tracking marks or dust expand the bounding box: `removePaleGreenMarkers`, `keepLargestComponent`, `removeSmallComponents`, and a suitable `minComponentPixels`.

## Parameter Defaults

Default keying targets bright green `[0, 255, 0]` with moderate tolerance, spill suppression, and feathering. Default layout exports a 1024 x 1024 canvas with a centered 760 x 940 person box and auto-crop enabled.

For a simple first pass, omit `params` and let the MCP defaults apply. Tune `keying.tolerance`, `keying.spillSuppression`, `keying.feather`, and `layout.personWidth/personHeight` after inspecting the first output.

## Godot SpriteFrames Defaults

For top-down or eight-direction Godot characters, a useful starting point is a 256 x 256 outer frame with a 160 x 160 safe area:

```json
{
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
    "fps": 12
  }
}
```

For five source directions, provide `down`, `down_right`, `right`, `up_right`, and `up`, then mirror `left`, `down_left`, and `up_left` from their right-facing counterparts in `animationGroups[].mirror`.
