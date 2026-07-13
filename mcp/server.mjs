#!/usr/bin/env node

import fs from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as z from 'zod/v4';
import canvas from 'canvas';

const { createCanvas, Image } = canvas;
const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_PROJECT_ROOT = path.resolve(__dirname, '..');
const packageJson = require('../package.json');

const DEFAULT_KEYING = Object.freeze({
  keyColor: [0, 255, 0],
  tolerance: 30,
  spillSuppression: 40,
  feather: 15,
  edgeShrink: 0,
});

const DEFAULT_LAYOUT = Object.freeze({
  canvasWidth: 1024,
  canvasHeight: 1024,
  personWidth: 760,
  personHeight: 940,
  autoCrop: true,
});

const PRESETS = Object.freeze({
  portrait_square_1024: {
    description: 'Square portrait export for character standees and game UI.',
    params: {
      keying: DEFAULT_KEYING,
      layout: DEFAULT_LAYOUT,
      mode: 'greenscreen',
    },
  },
  transparent_character_1024: {
    description: 'Transparent PNG/WebM output with centered character framing.',
    params: {
      keying: DEFAULT_KEYING,
      layout: DEFAULT_LAYOUT,
      mode: 'transparent',
    },
  },
  vertical_video_1080x1920: {
    description: 'Vertical video canvas for short-form video composition.',
    params: {
      keying: DEFAULT_KEYING,
      layout: {
        canvasWidth: 1080,
        canvasHeight: 1920,
        personWidth: 820,
        personHeight: 1700,
        autoCrop: true,
      },
      mode: 'greenscreen',
    },
  },
  sprite_512_cells: {
    description: 'Sprite sheet cells suitable for small game animation previews.',
    params: {
      keying: DEFAULT_KEYING,
      layout: {
        canvasWidth: 512,
        canvasHeight: 512,
        personWidth: 420,
        personHeight: 480,
        autoCrop: true,
      },
      mode: 'transparent',
    },
    spriteParams: {
      frameWidth: 512,
      frameHeight: 512,
      framesPerRow: 8,
      sampleEvery: 2,
      maxFrames: 64,
    },
  },
});

const WORKFLOW_DOC = `# Greenscreen Studio MCP Workflows

Use this MCP when an agent has local image or video file paths and needs the Greenscreen Studio processing pipeline without opening the Electron app.

## Standard image export

1. Call \`inspect_image\` to confirm the file can be loaded and to learn its dimensions.
2. Choose a preset from \`greenscreen://presets/default\` or pass explicit \`params\`.
3. Call \`export_image\` with \`mode: "greenscreen"\` for a solid green background or \`mode: "transparent"\` for a transparent PNG.

## Standard video export

1. Call \`probe_video\` to get dimensions, fps, duration, frame count, and audio presence.
2. Choose output format:
   - transparent WebM: \`mode: "transparent"\`, \`format: "webm"\`
   - transparent ProRes: \`mode: "transparent"\`, \`format: "mov"\`
   - green-screen H.264: \`mode: "greenscreen"\`, \`format: "mp4"\`
3. Call \`process_video\`. Long videos can exceed some client timeouts; trim with \`range\` first when testing.

## Looping clips and sprites

Use \`find_loop_end\` after \`probe_video\` to identify similar end-frame candidates, then pass the selected \`range\` into \`process_video\` or \`export_spritesheet\`.
`;

const PARAM_SCHEMA_RESOURCE = Object.freeze({
  type: 'object',
  properties: {
    keying: {
      type: 'object',
      properties: {
        keyColor: { type: 'array', minItems: 3, maxItems: 3, items: { type: 'integer', minimum: 0, maximum: 255 } },
        tolerance: { type: 'number', minimum: 0, maximum: 100 },
        spillSuppression: { type: 'number', minimum: 0, maximum: 100 },
        feather: { type: 'number', minimum: 0, maximum: 100 },
        edgeShrink: { type: 'number', minimum: 0, maximum: 50 },
      },
    },
    layout: {
      type: 'object',
      properties: {
        canvasWidth: { type: 'integer', minimum: 1 },
        canvasHeight: { type: 'integer', minimum: 1 },
        personWidth: { type: 'integer', minimum: 1 },
        personHeight: { type: 'integer', minimum: 1 },
        autoCrop: { type: 'boolean' },
        bgColor: { type: 'array', minItems: 3, maxItems: 3, items: { type: 'integer', minimum: 0, maximum: 255 } },
      },
      required: ['canvasWidth', 'canvasHeight', 'personWidth', 'personHeight'],
    },
    mode: { enum: ['greenscreen', 'transparent'] },
  },
});

let videoProcessorModule = null;
let keyingModule = null;
let consoleRedirectInstalled = false;

const colorSchema = z
  .array(z.number().int().min(0).max(255))
  .length(3)
  .describe('RGB triplet such as [0, 255, 0].');

const keyingSchema = z.object({
  keyColor: colorSchema.optional(),
  tolerance: z.number().min(0).max(100).optional(),
  spillSuppression: z.number().min(0).max(100).optional(),
  feather: z.number().min(0).max(100).optional(),
  edgeShrink: z.number().min(0).max(50).optional(),
});

const layoutSchema = z.object({
  canvasWidth: z.number().int().positive().optional(),
  canvasHeight: z.number().int().positive().optional(),
  personWidth: z.number().int().positive().optional(),
  personHeight: z.number().int().positive().optional(),
  autoCrop: z.boolean().optional(),
  bgColor: colorSchema.optional(),
});

const processingParamsSchema = z.object({
  keying: keyingSchema.optional(),
  layout: layoutSchema.optional(),
  mode: z.enum(['greenscreen', 'transparent']).optional(),
});

const rangeSchema = z.object({
  startFrame: z.number().int().min(0),
  endFrame: z.number().int().positive(),
});

const loopOptionsSchema = z.object({
  maxSearch: z.number().int().positive().optional(),
  step: z.number().int().positive().optional(),
  hashSize: z.number().int().min(4).max(32).optional(),
  minSpacing: z.number().int().positive().optional(),
  maxCandidates: z.number().int().min(1).max(20).optional(),
});

const spriteParamsSchema = z.object({
  frameWidth: z.number().int().min(8),
  frameHeight: z.number().int().min(8),
  framesPerRow: z.number().int().min(1),
  maxFrames: z.number().int().positive().optional(),
  sampleEvery: z.number().int().positive().optional(),
});

export function installMcpSafeConsole() {
  if (consoleRedirectInstalled) return;
  consoleRedirectInstalled = true;
  console.log = (...args) => console.error(...args);
  console.info = (...args) => console.error(...args);
}

export function getCapabilities(projectRoot = DEFAULT_PROJECT_ROOT) {
  return {
    name: packageJson.name,
    version: packageJson.version,
    projectRoot,
    mcpServer: {
      command: 'node',
      args: [path.join(projectRoot, 'mcp', 'server.mjs')],
      transport: 'stdio',
    },
    tools: [
      'get_project_info',
      'validate_processing_params',
      'inspect_image',
      'export_image',
      'probe_video',
      'process_video',
      'find_loop_end',
      'export_spritesheet',
    ],
    resources: [
      'greenscreen://presets/default',
      'greenscreen://docs/workflows',
      'greenscreen://schemas/processing-params',
    ],
    prompts: ['standardize_greenscreen_asset'],
    defaultParams: normalizeProcessingParams(),
    presets: PRESETS,
  };
}

export function normalizeProcessingParams(input = {}) {
  const keying = {
    ...DEFAULT_KEYING,
    ...(input.keying || {}),
  };
  const layout = {
    ...DEFAULT_LAYOUT,
    ...(input.layout || {}),
  };

  return {
    keying: {
      keyColor: normalizeColor(keying.keyColor, DEFAULT_KEYING.keyColor),
      tolerance: clampNumber(keying.tolerance, 0, 100, DEFAULT_KEYING.tolerance),
      spillSuppression: clampNumber(keying.spillSuppression, 0, 100, DEFAULT_KEYING.spillSuppression),
      feather: clampNumber(keying.feather, 0, 100, DEFAULT_KEYING.feather),
      edgeShrink: clampNumber(keying.edgeShrink, 0, 50, DEFAULT_KEYING.edgeShrink),
    },
    layout: {
      canvasWidth: positiveInt(layout.canvasWidth, DEFAULT_LAYOUT.canvasWidth),
      canvasHeight: positiveInt(layout.canvasHeight, DEFAULT_LAYOUT.canvasHeight),
      personWidth: positiveInt(layout.personWidth, DEFAULT_LAYOUT.personWidth),
      personHeight: positiveInt(layout.personHeight, DEFAULT_LAYOUT.personHeight),
      autoCrop: layout.autoCrop !== false,
      ...(layout.bgColor ? { bgColor: normalizeColor(layout.bgColor, DEFAULT_KEYING.keyColor) } : {}),
    },
    mode: input.mode === 'transparent' ? 'transparent' : 'greenscreen',
  };
}

export function resolveLocalPath(targetPath, { baseDir = process.cwd(), mustExist = false, label = 'path' } = {}) {
  if (!targetPath || typeof targetPath !== 'string') {
    throw new Error(`${label} is required`);
  }
  if (/^[a-z]+:\/\//i.test(targetPath)) {
    throw new Error(`${label} must be a local file path, not a URL`);
  }

  const resolved = path.resolve(baseDir, targetPath);
  if (mustExist && !existsSync(resolved)) {
    throw new Error(`${label} does not exist: ${resolved}`);
  }
  return resolved;
}

export async function inspectImageFile(inputPath, options = {}) {
  const filePath = resolveLocalPath(inputPath, { ...options, mustExist: true, label: 'inputPath' });
  assertFile(filePath, 'inputPath');
  const buffer = await fs.readFile(filePath);
  const image = new Image();
  image.src = buffer;

  return {
    inputPath: filePath,
    width: image.width,
    height: image.height,
    size: buffer.length,
    mimeType: guessImageMime(filePath),
  };
}

export async function exportImageFile(args, options = {}) {
  const inputPath = resolveLocalPath(args.inputPath, { ...options, mustExist: true, label: 'inputPath' });
  assertFile(inputPath, 'inputPath');

  const params = normalizeProcessingParams(args.params || {});
  const outputPath = await resolveOutputPath(args.outputPath, {
    baseDir: options.baseDir,
    defaultExt: 'png',
    defaultPrefix: 'greenscreen_image',
    overwrite: args.overwrite === true,
  });

  const { applyKeying, composeToCanvas, autoCropKeyed } = await loadKeying(options.projectRoot);
  const inputBuffer = await fs.readFile(inputPath);
  const image = new Image();
  image.src = inputBuffer;

  const srcCanvas = createCanvas(image.width, image.height);
  const srcCtx = srcCanvas.getContext('2d');
  srcCtx.drawImage(image, 0, 0);

  let keyedData = applyKeying(srcCtx.getImageData(0, 0, image.width, image.height), params.keying);
  if (params.layout.autoCrop !== false) {
    keyedData = autoCropKeyed(keyedData);
  }

  const { canvasWidth, canvasHeight } = params.layout;
  const outCanvas = createCanvas(canvasWidth, canvasHeight);
  const outCtx = outCanvas.getContext('2d');
  const tempCanvas = createCanvas(Math.max(1, keyedData.width), Math.max(1, keyedData.height));

  let placement;
  if (params.mode === 'transparent') {
    placement = drawTransparent(outCtx, keyedData, params.layout, tempCanvas);
  } else {
    placement = composeToCanvas(outCtx, keyedData, params.layout, tempCanvas, params.keying.keyColor);
  }

  const outputBuffer = outCanvas.toBuffer('image/png');
  await fs.writeFile(outputPath, outputBuffer);
  const stat = await fs.stat(outputPath);

  return {
    inputPath,
    outputPath,
    outputUri: pathToFileURL(outputPath).href,
    mode: params.mode,
    width: canvasWidth,
    height: canvasHeight,
    outputSize: stat.size,
    source: {
      width: image.width,
      height: image.height,
    },
    keyed: {
      width: keyedData.width,
      height: keyedData.height,
    },
    placement,
    params,
  };
}

export async function probeVideoFile(inputPath, options = {}) {
  const filePath = resolveLocalPath(inputPath, { ...options, mustExist: true, label: 'inputPath' });
  assertFile(filePath, 'inputPath');
  const { probeVideo } = loadVideoProcessor(options.projectRoot);
  const info = await probeVideo(filePath);
  return {
    inputPath: filePath,
    ...info,
  };
}

export async function processVideoFile(args, options = {}) {
  const inputPath = resolveLocalPath(args.inputPath, { ...options, mustExist: true, label: 'inputPath' });
  assertFile(inputPath, 'inputPath');

  const params = normalizeProcessingParams(args.params || {});
  const outputExt = args.outputPath ? path.extname(args.outputPath).slice(1).toLowerCase() : '';
  const format = normalizeVideoFormat(args.format || outputExt, params.mode);
  assertVideoFormatForMode(format, params.mode);
  const outputPath = await resolveOutputPath(args.outputPath, {
    baseDir: options.baseDir,
    defaultExt: format,
    defaultPrefix: 'greenscreen_video',
    overwrite: args.overwrite === true,
  });

  const ext = path.extname(outputPath).slice(1).toLowerCase();
  if (ext !== format) {
    throw new Error(`outputPath extension .${ext} does not match requested format ${format}`);
  }

  const processingParams = {
    ...params,
    ...(args.range ? { range: args.range } : {}),
  };

  const { processVideo } = loadVideoProcessor(options.projectRoot);
  let lastProgress = { current: 0, total: 0, percent: 0 };
  const result = await processVideo(inputPath, outputPath, processingParams, (current, total) => {
    const percent = total > 0 ? Math.round((current / total) * 100) : 0;
    lastProgress = { current, total, percent };
  });
  const stat = await fs.stat(outputPath);

  return {
    inputPath,
    outputPath,
    outputUri: pathToFileURL(outputPath).href,
    format,
    mode: params.mode,
    progress: lastProgress,
    result: {
      ...result,
      outputSize: stat.size,
    },
    params: processingParams,
  };
}

export async function findLoopEndForVideo(args, options = {}) {
  const inputPath = resolveLocalPath(args.inputPath, { ...options, mustExist: true, label: 'inputPath' });
  assertFile(inputPath, 'inputPath');

  const { probeVideo, findLoopEndFrame } = loadVideoProcessor(options.projectRoot);
  const info = args.videoInfo || await probeVideo(inputPath);
  const fps = Number(info.fps);
  const totalFrames = Number(info.frameCount || Math.round(info.duration * fps));

  if (!Number.isFinite(fps) || fps <= 0) {
    throw new Error('videoInfo.fps is required and must be positive');
  }
  if (!Number.isFinite(totalFrames) || totalFrames <= 1) {
    throw new Error('Unable to determine total frame count');
  }
  if (args.startFrame < 0 || args.startFrame >= totalFrames - 1) {
    throw new Error(`startFrame must be between 0 and ${totalFrames - 2}`);
  }

  const normalizedParams = args.params ? normalizeProcessingParams(args.params) : null;
  const result = await findLoopEndFrame(inputPath, args.startFrame, fps, totalFrames, {
    ...(args.options || {}),
    ...(normalizedParams ? { params: normalizedParams } : {}),
    sourceWidth: info.width,
    sourceHeight: info.height,
  });

  return {
    inputPath,
    startFrame: args.startFrame,
    fps,
    totalFrames,
    candidates: result.candidates,
    scores: result.scores,
    bestCandidate: result.candidates[0] || null,
    options: args.options || {},
    params: normalizedParams,
  };
}

export async function exportSpriteSheetFile(args, options = {}) {
  const inputPath = resolveLocalPath(args.inputPath, { ...options, mustExist: true, label: 'inputPath' });
  assertFile(inputPath, 'inputPath');

  const params = normalizeProcessingParams(args.params || {});
  const spriteParams = {
    sampleEvery: 1,
    ...args.spriteParams,
  };
  const outputPath = await resolveOutputPath(args.outputPath, {
    baseDir: options.baseDir,
    defaultExt: 'png',
    defaultPrefix: 'greenscreen_spritesheet',
    overwrite: args.overwrite === true,
  });

  const { exportSpriteSheet } = loadVideoProcessor(options.projectRoot);
  const result = await exportSpriteSheet(inputPath, params, spriteParams);
  await fs.writeFile(outputPath, result.buffer);
  const stat = await fs.stat(outputPath);

  return {
    inputPath,
    outputPath,
    outputUri: pathToFileURL(outputPath).href,
    frameCount: result.frameCount,
    sheetWidth: result.sheetWidth,
    sheetHeight: result.sheetHeight,
    cols: result.cols,
    rows: result.rows,
    outputSize: stat.size,
    params,
    spriteParams,
  };
}

export function createGreenscreenMcpServer(options = {}) {
  const projectRoot = path.resolve(options.projectRoot || DEFAULT_PROJECT_ROOT);
  const baseDir = path.resolve(options.baseDir || process.cwd());
  const server = new McpServer({
    name: 'greenscreen-studio',
    version: packageJson.version,
  });

  const context = { projectRoot, baseDir };

  server.registerTool('get_project_info', {
    title: 'Get Greenscreen Studio MCP Info',
    description: 'Return project paths, default processing parameters, presets, resources, prompts, and available MCP tools.',
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    outputSchema: {
      name: z.string(),
      version: z.string(),
      projectRoot: z.string(),
      mcpServer: z.object({
        command: z.string(),
        args: z.array(z.string()),
        transport: z.string(),
      }),
      tools: z.array(z.string()),
      resources: z.array(z.string()),
      prompts: z.array(z.string()),
      defaultParams: z.object({
        keying: keyingSchema,
        layout: layoutSchema,
        mode: z.enum(['greenscreen', 'transparent']),
      }),
      presets: z.record(z.string(), z.unknown()),
    },
  }, async () => toolResult(getCapabilities(projectRoot)));

  server.registerTool('validate_processing_params', {
    title: 'Validate Greenscreen Processing Params',
    description: 'Normalize partial keying/layout parameters and return the exact values that export tools will use.',
    inputSchema: {
      params: processingParamsSchema.optional(),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    outputSchema: {
      params: z.object({
        keying: keyingSchema,
        layout: layoutSchema,
        mode: z.enum(['greenscreen', 'transparent']),
      }),
    },
  }, async ({ params }) => toolResult({ params: normalizeProcessingParams(params || {}) }));

  server.registerTool('inspect_image', {
    title: 'Inspect Image',
    description: 'Load a local image file and return width, height, size, and guessed MIME type before export.',
    inputSchema: {
      inputPath: z.string().describe('Local path to a source image file. Relative paths resolve from the client working directory.'),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    outputSchema: {
      inputPath: z.string(),
      width: z.number(),
      height: z.number(),
      size: z.number(),
      mimeType: z.string(),
    },
  }, async ({ inputPath }) => toolResult(await inspectImageFile(inputPath, context)));

  server.registerTool('export_image', {
    title: 'Export Image',
    description: 'Apply Greenscreen Studio chroma keying, auto-crop, scaling, and centering to a local image and write a PNG.',
    inputSchema: {
      inputPath: z.string().describe('Local path to the source image.'),
      outputPath: z.string().optional().describe('PNG output path. If omitted, a temp file is created.'),
      params: processingParamsSchema.optional().describe('Keying/layout/mode parameters. Missing fields use project defaults.'),
      overwrite: z.boolean().optional().describe('Allow replacing outputPath when it already exists. Defaults to false.'),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
  }, async (args) => toolResult(await exportImageFile(args, context), { filePath: true }));

  server.registerTool('probe_video', {
    title: 'Probe Video',
    description: 'Run ffprobe on a local video and return width, height, fps, duration, frame count, codec, and audio presence.',
    inputSchema: {
      inputPath: z.string().describe('Local path to a source video file.'),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  }, async ({ inputPath }) => toolResult(await probeVideoFile(inputPath, context)));

  server.registerTool('process_video', {
    title: 'Process Video',
    description: 'Apply Greenscreen Studio frame processing to a local video and write WebM, MOV, or MP4 output.',
    inputSchema: {
      inputPath: z.string().describe('Local path to the source video.'),
      outputPath: z.string().optional().describe('Output path. Extension must match format if provided.'),
      format: z.enum(['webm', 'mov', 'mp4']).optional().describe('Output container. Defaults to webm for transparent mode, mp4 for green-screen mode.'),
      params: processingParamsSchema.optional(),
      range: rangeSchema.optional().describe('Optional frame range [startFrame, endFrame) for trimming or tests.'),
      overwrite: z.boolean().optional().describe('Allow replacing outputPath when it already exists. Defaults to false.'),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
  }, async (args) => toolResult(await processVideoFile(args, context), { filePath: true }));

  server.registerTool('find_loop_end', {
    title: 'Find Loop End Frame',
    description: 'Find frame candidates that visually match a start frame for looping video clips, optionally after keying/layout preview processing.',
    inputSchema: {
      inputPath: z.string().describe('Local path to the source video.'),
      startFrame: z.number().int().min(0),
      params: processingParamsSchema.optional().describe('Optional preview keying/layout settings used before similarity hashing.'),
      options: loopOptionsSchema.optional(),
      videoInfo: z.object({
        width: z.number().optional(),
        height: z.number().optional(),
        fps: z.number(),
        duration: z.number(),
        frameCount: z.number().nullable().optional(),
      }).optional().describe('Optional probe_video result to avoid probing twice.'),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  }, async (args) => toolResult(await findLoopEndForVideo(args, context)));

  server.registerTool('export_spritesheet', {
    title: 'Export Sprite Sheet',
    description: 'Sample keyed video frames into a PNG sprite sheet with configurable cell size, rows, sampling rate, and max frames.',
    inputSchema: {
      inputPath: z.string().describe('Local path to the source video.'),
      outputPath: z.string().optional().describe('PNG output path. If omitted, a temp file is created.'),
      params: processingParamsSchema.optional().describe('Keying/layout parameters used for each sampled frame.'),
      spriteParams: spriteParamsSchema.describe('Sprite sheet layout and sampling parameters.'),
      overwrite: z.boolean().optional().describe('Allow replacing outputPath when it already exists. Defaults to false.'),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
  }, async (args) => toolResult(await exportSpriteSheetFile(args, context), { filePath: true }));

  registerResources(server);
  registerPrompts(server);

  return server;
}

function registerResources(server) {
  server.registerResource('processing-presets', 'greenscreen://presets/default', {
    title: 'Greenscreen Processing Presets',
    description: 'Default keying/layout values and reusable processing presets.',
    mimeType: 'application/json',
  }, async (uri) => ({
    contents: [{
      uri: uri.href,
      mimeType: 'application/json',
      text: JSON.stringify({ defaultParams: normalizeProcessingParams(), presets: PRESETS }, null, 2),
    }],
  }));

  server.registerResource('workflow-guide', 'greenscreen://docs/workflows', {
    title: 'Greenscreen MCP Workflow Guide',
    description: 'Recommended tool sequences for image exports, video exports, loops, and sprite sheets.',
    mimeType: 'text/markdown',
  }, async (uri) => ({
    contents: [{
      uri: uri.href,
      mimeType: 'text/markdown',
      text: WORKFLOW_DOC,
    }],
  }));

  server.registerResource('processing-param-schema', 'greenscreen://schemas/processing-params', {
    title: 'Processing Parameter Schema',
    description: 'JSON schema for keying, layout, and mode parameters accepted by the MCP tools.',
    mimeType: 'application/schema+json',
  }, async (uri) => ({
    contents: [{
      uri: uri.href,
      mimeType: 'application/schema+json',
      text: JSON.stringify(PARAM_SCHEMA_RESOURCE, null, 2),
    }],
  }));
}

function registerPrompts(server) {
  server.registerPrompt('standardize_greenscreen_asset', {
    title: 'Standardize Greenscreen Asset',
    description: 'Plan and run the right Greenscreen Studio MCP tools for a local image or video.',
    argsSchema: {
      mediaPath: z.string().describe('Local path to the source image or video.'),
      goal: z.string().optional().describe('Desired output, for example transparent PNG, green-screen MP4, looping clip, or sprite sheet.'),
      outputPath: z.string().optional().describe('Preferred output path.'),
    },
  }, async ({ mediaPath, goal, outputPath }) => ({
    description: 'Use Greenscreen Studio MCP to inspect, choose parameters, export, and verify a local green-screen asset.',
    messages: [{
      role: 'user',
      content: {
        type: 'text',
        text: [
          `Use the Greenscreen Studio MCP tools for ${mediaPath}.`,
          goal ? `Goal: ${goal}.` : 'Infer whether this is an image or video and choose the appropriate export flow.',
          outputPath ? `Write the result to ${outputPath}.` : 'Use a clear temp output path if no destination is specified.',
          'Read greenscreen://docs/workflows when unsure, validate params before export, and return the output path plus any important settings.',
        ].join(' '),
      },
    }],
  }));
}

function toolResult(payload, options = {}) {
  const content = [{
    type: 'text',
    text: JSON.stringify(payload, null, 2),
  }];

  if (options.filePath && payload.outputPath) {
    content.push({
      type: 'resource_link',
      uri: pathToFileURL(payload.outputPath).href,
      name: path.basename(payload.outputPath),
      mimeType: mimeTypeForOutput(payload.outputPath),
      description: 'Generated Greenscreen Studio output file',
    });
  }

  return {
    content,
    structuredContent: payload,
  };
}

async function resolveOutputPath(outputPath, { baseDir = process.cwd(), defaultExt, defaultPrefix, overwrite }) {
  let resolved;
  if (outputPath) {
    resolved = resolveLocalPath(outputPath, { baseDir, label: 'outputPath' });
    if (!path.extname(resolved)) {
      resolved = `${resolved}.${defaultExt}`;
    }
  } else {
    const tmpDir = path.join(os.tmpdir(), 'greenscreen-studio-mcp');
    resolved = path.join(tmpDir, `${defaultPrefix}_${Date.now()}.${defaultExt}`);
  }

  const ext = path.extname(resolved).slice(1).toLowerCase();
  if (ext !== defaultExt) {
    throw new Error(`outputPath must use .${defaultExt}, got .${ext || '(none)'}`);
  }
  if (existsSync(resolved) && !overwrite) {
    throw new Error(`outputPath already exists: ${resolved}. Pass overwrite: true to replace it.`);
  }
  await fs.mkdir(path.dirname(resolved), { recursive: true });
  return resolved;
}

async function loadKeying(projectRoot = DEFAULT_PROJECT_ROOT) {
  if (!keyingModule) {
    const keyingUrl = pathToFileURL(path.join(projectRoot, 'src', 'lib', 'keying.js')).href;
    keyingModule = await import(keyingUrl);
  }
  return keyingModule;
}

function loadVideoProcessor(projectRoot = DEFAULT_PROJECT_ROOT) {
  if (!videoProcessorModule) {
    videoProcessorModule = require(path.join(projectRoot, 'videoProcessor.cjs'));
  }
  return videoProcessorModule;
}

function drawTransparent(ctx, keyedData, layout, tempCanvas) {
  tempCanvas.width = keyedData.width;
  tempCanvas.height = keyedData.height;
  const tempCtx = tempCanvas.getContext('2d');
  const imageData = tempCtx.createImageData(keyedData.width, keyedData.height);
  imageData.data.set(keyedData.data);
  tempCtx.putImageData(imageData, 0, 0);

  const scale = Math.min(layout.personWidth / keyedData.width, layout.personHeight / keyedData.height);
  const scaledW = Math.round(keyedData.width * scale);
  const scaledH = Math.round(keyedData.height * scale);
  const offsetX = Math.round((layout.canvasWidth - scaledW) / 2);
  const offsetY = Math.round((layout.canvasHeight - scaledH) / 2);
  ctx.drawImage(tempCanvas, offsetX, offsetY, scaledW, scaledH);

  return { scaledW, scaledH, offsetX, offsetY };
}

function normalizeColor(value, fallback) {
  if (!Array.isArray(value) || value.length !== 3) return [...fallback];
  return value.map((channel, index) => {
    const fallbackValue = fallback[index];
    return Math.max(0, Math.min(255, Math.round(Number.isFinite(Number(channel)) ? Number(channel) : fallbackValue)));
  });
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}

function positiveInt(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return Math.max(1, Math.round(number));
}

function assertFile(filePath, label) {
  const stat = statSync(filePath);
  if (!stat.isFile()) {
    throw new Error(`${label} must be a file: ${filePath}`);
  }
}

function normalizeVideoFormat(format, mode) {
  if (format) return format.toLowerCase();
  return mode === 'transparent' ? 'webm' : 'mp4';
}

function assertVideoFormatForMode(format, mode) {
  const allowed = mode === 'transparent' ? ['webm', 'mov'] : ['mp4', 'webm', 'mov'];
  if (!allowed.includes(format)) {
    throw new Error(`${mode} mode supports ${allowed.join(', ')} output, got ${format}`);
  }
}

function guessImageMime(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const map = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
  };
  return map[ext] || 'application/octet-stream';
}

function mimeTypeForOutput(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const map = {
    '.png': 'image/png',
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.mov': 'video/quicktime',
  };
  return map[ext] || 'application/octet-stream';
}

async function main() {
  installMcpSafeConsole();
  const server = createGreenscreenMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Greenscreen Studio MCP server running on stdio');
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  main().catch((error) => {
    console.error('Greenscreen Studio MCP server failed:', error);
    process.exit(1);
  });
}
