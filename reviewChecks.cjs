const DEFAULT_REVIEW_THRESHOLDS = Object.freeze({
  minimumForegroundCoverage: 0.98,
  minimumForegroundAreaRatio: 0.005,
  maximumForegroundAreaRatio: 0.85,
  maximumBottomDeltaRatio: 0.08,
  maximumCenterDeltaRatio: 0.06,
  maximumAreaChangeRatio: 0.35,
  maximumLoopBoundaryScore: 48,
});

function check(id, status, code, details = {}) {
  return { id, status, code, details };
}

function findLoopBoundaryScore(loopResult, endFrame) {
  const boundaryFrame = Math.max(0, Number(endFrame) - 1);
  return (loopResult?.scores || []).find((entry) => entry.frame === boundaryFrame)?.score ?? null;
}

function buildActionClipReviewChecks({
  clip,
  stableCrop,
  loopResult = null,
  layout = {},
  thresholds = {},
  generatedAt = new Date().toISOString(),
} = {}) {
  if (!clip?.id) throw new Error('review checks require a clip');
  const limits = { ...DEFAULT_REVIEW_THRESHOLDS, ...(thresholds || {}) };
  const metrics = stableCrop?.scan?.metrics || {};
  const sampleFrameCount = Number(metrics.sampleFrameCount ?? stableCrop?.scan?.scannedFrameCount ?? 0);
  const foregroundFrameCount = Number(metrics.foregroundFrameCount ?? stableCrop?.scan?.foregroundFrameCount ?? 0);
  const coverage = sampleFrameCount > 0 ? foregroundFrameCount / sampleFrameCount : 0;
  const area = metrics.foregroundAreaRatio || { min: 0, max: 0, mean: 0 };
  const edgeContactFrameCount = Number(metrics.edgeContacts?.frameCount || 0);
  const maxBottomDeltaRatio = Number(metrics.feet?.maxBottomDeltaRatio || 0);
  const maxCenterDeltaRatio = Number(metrics.jitter?.maxCenterDeltaRatio || 0);
  const maxAreaChangeRatio = Number(metrics.jitter?.maxAreaChangeRatio || 0);
  const loopBoundaryScore = clip.loop ? findLoopBoundaryScore(loopResult, clip.endFrame) : null;

  const checks = [];
  const foregroundWarning = sampleFrameCount === 0
    ? 'foreground_not_scanned'
    : coverage < limits.minimumForegroundCoverage
      ? 'foreground_missing_frames'
      : area.mean < limits.minimumForegroundAreaRatio
        ? 'foreground_too_small'
        : area.max > limits.maximumForegroundAreaRatio ? 'foreground_too_large' : null;
  checks.push(check('foreground_area', foregroundWarning ? 'warning' : 'pass', foregroundWarning || 'foreground_area_ok', {
    sampleFrameCount,
    foregroundFrameCount,
    coverage,
    area,
  }));

  checks.push(check(
    'feet_anchor',
    layout.anchor !== 'feet' || maxBottomDeltaRatio > limits.maximumBottomDeltaRatio ? 'warning' : 'pass',
    layout.anchor !== 'feet' ? 'feet_anchor_disabled'
      : maxBottomDeltaRatio > limits.maximumBottomDeltaRatio ? 'feet_anchor_unstable' : 'feet_anchor_ok',
    { anchor: layout.anchor || 'center', maxBottomDeltaRatio },
  ));

  checks.push(check(
    'crop',
    !stableCrop?.scan?.rawBounds || edgeContactFrameCount > 0 ? 'warning' : 'pass',
    !stableCrop?.scan?.rawBounds ? 'crop_no_foreground'
      : edgeContactFrameCount > 0 ? 'crop_touches_source_edge' : 'crop_ok',
    { edgeContactFrameCount, edgeContacts: metrics.edgeContacts || null, rawBounds: stableCrop?.scan?.rawBounds || null },
  ));

  checks.push(check(
    'frame_jitter',
    maxCenterDeltaRatio > limits.maximumCenterDeltaRatio || maxAreaChangeRatio > limits.maximumAreaChangeRatio ? 'warning' : 'pass',
    maxCenterDeltaRatio > limits.maximumCenterDeltaRatio ? 'frame_center_jump'
      : maxAreaChangeRatio > limits.maximumAreaChangeRatio ? 'frame_area_jump' : 'frame_jitter_ok',
    { maxCenterDeltaRatio, maxAreaChangeRatio },
  ));

  checks.push(clip.loop
    ? check(
        'loop_boundary',
        loopBoundaryScore == null || loopBoundaryScore > limits.maximumLoopBoundaryScore ? 'warning' : 'pass',
        loopBoundaryScore == null ? 'loop_boundary_missing'
          : loopBoundaryScore > limits.maximumLoopBoundaryScore ? 'loop_boundary_mismatch' : 'loop_boundary_ok',
        {
          boundaryFrame: clip.endFrame - 1,
          score: loopBoundaryScore,
          candidates: loopResult?.candidates || [],
          warnings: loopResult?.warnings || [],
        },
      )
    : check('loop_boundary', 'skipped', 'loop_not_enabled', { boundaryFrame: clip.endFrame - 1 }));

  return {
    schemaVersion: 1,
    generatedAt,
    clip: {
      id: clip.id,
      version: clip.version,
      status: clip.status,
      startFrame: clip.startFrame,
      endFrame: clip.endFrame,
      loop: Boolean(clip.loop),
    },
    summary: {
      status: checks.some((item) => item.status === 'warning') ? 'warning' : 'pass',
      warningCount: checks.filter((item) => item.status === 'warning').length,
      passCount: checks.filter((item) => item.status === 'pass').length,
      skippedCount: checks.filter((item) => item.status === 'skipped').length,
    },
    thresholds: limits,
    checks,
  };
}

module.exports = {
  DEFAULT_REVIEW_THRESHOLDS,
  buildActionClipReviewChecks,
  findLoopBoundaryScore,
};
