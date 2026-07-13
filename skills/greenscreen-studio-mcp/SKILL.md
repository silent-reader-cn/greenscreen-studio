---
name: greenscreen-studio-mcp
description: "Use when Codex should operate the Greenscreen Studio local MCP server for green-screen image or video workflows: inspect media files, normalize keying/layout params, export transparent PNG/WebM/MOV or green-screen PNG/MP4/WebM/MOV outputs, find video loop end frames, export sprite sheets, or help configure this repo's MCP server for an MCP client."
---

# Greenscreen Studio MCP

## Overview

Use this skill to drive the Greenscreen Studio MCP server from an AI client. The server exposes the project's image keying, video processing, loop detection, and sprite-sheet pipeline through local stdio MCP tools.

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
5. Export with `export_image`, `process_video`, or `export_spritesheet`.
6. Verify the returned `outputPath`, dimensions, mode, format, and output size. For videos, check the returned `progress.percent` and `result.frameCount`.

## Tool Routing

Read `references/tool-catalog.md` before invoking a tool you have not used in the current task or when exact arguments matter.

Read `references/workflows.md` for end-to-end tasks such as transparent character export, green-screen MP4 export, loop trimming, and sprite-sheet generation.

Read `references/client-config.md` when the user asks how to connect this MCP server to a desktop MCP client.

## Operational Rules

- Use local file paths only. The MCP rejects URLs.
- Relative paths resolve from the MCP client's working directory; absolute paths are safer.
- Export tools create temp outputs when `outputPath` is omitted.
- Existing output files are protected by default. Pass `overwrite: true` only when the user asked to replace a file or the path is clearly scratch output.
- Transparent video supports `webm` and `mov`; green-screen video supports `mp4`, `webm`, and `mov`.
- Long video calls can exceed client request timeouts. For tests or previews, pass a small `range` such as `{ "startFrame": 0, "endFrame": 30 }`.
- Prefer preserving the same `params` across preview, loop detection, final export, and sprite sheet generation so results match.

## Parameter Defaults

Default keying targets bright green `[0, 255, 0]` with moderate tolerance, spill suppression, and feathering. Default layout exports a 1024 x 1024 canvas with a centered 760 x 940 person box and auto-crop enabled.

For a simple first pass, omit `params` and let the MCP defaults apply. Tune `keying.tolerance`, `keying.spillSuppression`, `keying.feather`, and `layout.personWidth/personHeight` after inspecting the first output.
