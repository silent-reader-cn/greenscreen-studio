const GODOT_EVENTS_SCHEMA_VERSION = 1;

function copyJsonObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return JSON.parse(JSON.stringify(value));
}

function normalizeRange(range, frames) {
  const startFrame = Number.isInteger(range?.startFrame)
    ? range.startFrame
    : frames[0];
  const endFrame = Number.isInteger(range?.endFrame)
    ? range.endFrame
    : frames[frames.length - 1] + 1;
  if (!Number.isInteger(startFrame) || !Number.isInteger(endFrame) || endFrame <= startFrame) {
    throw new Error('Godot event tracks require a valid source frame range');
  }
  return { startFrame, endFrame };
}

function mapSourceFrame(sourceFrame, sourceFrames) {
  let animationFrame = sourceFrames.findIndex((frame) => frame >= sourceFrame);
  if (animationFrame < 0) animationFrame = sourceFrames.length - 1;
  return {
    animationFrame,
    mappedSourceFrame: sourceFrames[animationFrame],
    exactSourceFrame: sourceFrames[animationFrame] === sourceFrame,
  };
}

function buildTrack(track) {
  const sourceFrames = Array.isArray(track?.sourceFrames)
    ? track.sourceFrames.filter(Number.isInteger)
    : [];
  if (sourceFrames.length === 0) {
    throw new Error('Godot event tracks require at least one source frame');
  }

  const range = normalizeRange(track.range, sourceFrames);
  const animationName = String(track.animationName || '').trim();
  if (!animationName) throw new Error('Godot event tracks require an animation name');

  const animationFps = Math.max(1, Number(track.animationFps) || 1);
  const sourceFps = Math.max(1, Number(track.sourceFps) || animationFps);
  const clipBundle = track.clipBundle || null;
  const clip = clipBundle?.clip || null;
  if (clip && (clip.startFrame !== range.startFrame || clip.endFrame !== range.endFrame)) {
    throw new Error('Reviewed clip range must match the exported source range');
  }

  const clipSnapshot = clip
    ? {
        reviewed: true,
        id: clip.id,
        name: clip.name,
        version: clip.version,
        status: clip.status,
        range: { startFrame: clip.startFrame, endFrame: clip.endFrame },
        loop: Boolean(clip.loop),
      }
    : {
        reviewed: false,
        id: null,
        name: animationName,
        version: null,
        status: null,
        range,
        loop: track.loop !== false,
      };

  const markers = clipBundle?.markers || [];
  const events = [...markers]
    .sort((a, b) => a.frame - b.frame || String(a.id).localeCompare(String(b.id)))
    .map((marker) => {
      const mapped = mapSourceFrame(marker.frame, sourceFrames);
      return {
        id: marker.id,
        type: marker.type,
        label: marker.label || '',
        payload: copyJsonObject(marker.payload),
        sourceFrame: marker.frame,
        clipRelativeFrame: marker.frame - range.startFrame,
        sourceTimeSeconds: (marker.frame - range.startFrame) / sourceFps,
        animationFrame: mapped.animationFrame,
        animationTimeSeconds: mapped.animationFrame / animationFps,
        mappedSourceFrame: mapped.mappedSourceFrame,
        exactSourceFrame: mapped.exactSourceFrame,
      };
    });

  return {
    sourceTimebase: {
      unit: 'source_frame',
      framesPerSecond: sourceFps,
      startFrame: range.startFrame,
      endFrame: range.endFrame,
      endFrameExclusive: true,
    },
    clip: clipSnapshot,
    animation: {
      name: animationName,
      framesPerSecond: animationFps,
      frameCount: sourceFrames.length,
      sourceFrames: [...sourceFrames],
    },
    events,
  };
}

function buildGodotEvents({ tracks = [] } = {}) {
  if (!Array.isArray(tracks) || tracks.length === 0) {
    throw new Error('Godot events require at least one animation track');
  }
  return {
    schemaVersion: GODOT_EVENTS_SCHEMA_VERSION,
    frameConvention: {
      origin: 0,
      clipStartInclusive: true,
      clipEndExclusive: true,
    },
    tracks: tracks.map(buildTrack),
  };
}

module.exports = {
  GODOT_EVENTS_SCHEMA_VERSION,
  buildGodotEvents,
  mapSourceFrame,
};
