function dHashRaw(rawBuf, w, h) {
  const hashBits = (w - 1) * h; // hashSize * hashSize
  const hashBytes = Buffer.alloc(Math.ceil(hashBits / 8));
  let byteIdx = hashBytes.length - 1; // 从最后一个字节开始（大端）
  let bitIdx = 0;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w - 1; x++) {
      const idxL = (y * w + x) * 4;
      const idxR = (y * w + x + 1) * 4;
      const lumL = 0.299 * rawBuf[idxL] + 0.587 * rawBuf[idxL + 1] + 0.114 * rawBuf[idxL + 2];
      const lumR = 0.299 * rawBuf[idxR] + 0.587 * rawBuf[idxR + 1] + 0.114 * rawBuf[idxR + 2];

      if (lumL < lumR) {
        hashBytes[byteIdx] |= (1 << bitIdx);
      }
      bitIdx++;
      if (bitIdx >= 8) {
        bitIdx = 0;
        byteIdx--;
      }
    }
  }

  return hashBytes;
}

/**
 * 计算两个 dHash 之间的汉明距离（越低越相似）
 *
 * 本质上是 XOR 后数 1-bit 的数量。
 */
function hammingDistance(a, b) {
  const len = Math.min(a.length, b.length);
  let dist = 0;
  for (let i = 0; i < len; i++) {
    let xor = a[i] ^ b[i];
    while (xor) {
      dist += xor & 1;
      xor >>= 1;
    }
  }
  return dist;
}

/**
 * 从相似度分数数组中，用「窗口分区 + 最小间距」筛选出最佳候选帧。
 *
 * 策略：
 *   a) 找出所有局部极小值（比左右相邻更相似的帧）
 *   b) 将搜索范围分成 N 个等宽窗口
 *   c) 每个窗口取最佳候选，保证候选覆盖整个时间轴
 *   d) 对距离起始帧太近的候选加惩罚
 *   e) 返回最多 maxCandidates 个候选，按分数排序
 *
 * @param {Array<{frame:number,score:number}>} scores
 * @param {Object} options
 * @param {number} options.minSpacing - 最小帧间距
 * @param {number} options.maxCandidates - 最多返回几个
 * @param {number} options.startFrame - 起始帧号
 * @param {number} options.endFrame - 搜索范围结束帧
 * @returns {Array<{frame:number,score:number}>}
 */
function pickLoopCandidates(scores, {
  minSpacing,
  earlyFrameExclusion = minSpacing,
  maxCandidates,
  startFrame,
  endFrame,
  motionWeight = 0.35,
}) {
  if (scores.length === 0) return [];

  const sf = startFrame ?? 0;
  const minCandidateFrame = sf + Math.max(minSpacing, earlyFrameExclusion);
  const eligibleScores = scores
    .filter(s => s.frame - sf >= minSpacing && s.frame >= minCandidateFrame)
    .sort((a, b) => a.frame - b.frame);
  if (eligibleScores.length === 0) return [];

  // a) 找局部极小值（比左右都低或相等）
  const localMinima = [];
  for (let i = 0; i < eligibleScores.length; i++) {
    const prev = eligibleScores[i - 1];
    const current = eligibleScores[i];
    const next = eligibleScores[i + 1];
    const leftOk = !prev || current.score <= prev.score;
    const rightOk = !next || current.score <= next.score;
    if (leftOk && rightOk) {
      localMinima.push(enrichLoopScore(current, prev, next, motionWeight));
    }
  }
  const pool = localMinima.length > 0
    ? localMinima
    : eligibleScores.map((score, index) => enrichLoopScore(score, eligibleScores[index - 1], eligibleScores[index + 1], motionWeight));

  // b) 分成 N 个等宽窗口（N = maxCandidates），每个窗口取最佳
  const ef = endFrame ?? (pool.length > 0 ? pool[pool.length - 1].frame : sf + 1);
  const searchLen = Math.max(1, ef - minCandidateFrame + 1);
  const windowSize = searchLen / maxCandidates;

  const candidates = [];
  for (let w = 0; w < maxCandidates; w++) {
    const wStart = minCandidateFrame + Math.floor(w * windowSize);
    const wEnd = minCandidateFrame + Math.floor((w + 1) * windowSize);

    // 该窗口内的候选帧（局部极小值 + 距起始帧足够远）
    const inWindow = pool.filter(s =>
      s.frame >= minCandidateFrame &&
      s.frame >= wStart && s.frame < wEnd
    );

    if (inWindow.length === 0) continue;

    // 选窗口内最佳（综合相似度和局部运动/姿态可用性）
    inWindow.sort((a, b) => a.adjustedScore - b.adjustedScore);
    let best = inWindow[0];

    candidates.push({
      frame: best.frame,
      score: best.score,
      adjustedScore: best.adjustedScore,
      motionScore: best.motionScore,
      valleyDepth: best.valleyDepth,
      window: w,
    });
  }

  // 按调整后分数排序，取 top maxCandidates
  candidates.sort((a, b) => a.adjustedScore - b.adjustedScore);
  const topCandidates = candidates.slice(0, maxCandidates);

  // 用 minSpacing 做最终去重
  const deduped = [];
  for (const c of topCandidates) {
    const tooClose = deduped.some(d => Math.abs(d.frame - c.frame) < minSpacing);
    if (!tooClose) {
      deduped.push(c);
    }
  }

  // 按综合分排序返回，保留原始视觉分和运动辅助分
  return deduped
    .sort((a, b) => a.adjustedScore - b.adjustedScore)
    .map(c => ({
      frame: c.frame,
      score: c.score,
      adjustedScore: c.adjustedScore,
      motionScore: c.motionScore,
      valleyDepth: c.valleyDepth,
    }));
}

function enrichLoopScore(score, prev, next, motionWeight) {
  const neighborScores = [prev, next].filter(Boolean).map(s => s.score);
  const valleyDepth = neighborScores.length > 0
    ? Math.max(0, Math.min(...neighborScores) - score.score)
    : 0;
  const neighborMotion = neighborScores.length > 0
    ? neighborScores.reduce((sum, neighborScore) => sum + Math.abs(neighborScore - score.score), 0) / neighborScores.length
    : 0;
  const motionScore = valleyDepth + neighborMotion * 0.25;
  return {
    ...score,
    valleyDepth,
    motionScore,
    adjustedScore: Math.max(0, score.score - motionScore * motionWeight),
  };
}

function buildLoopWarnings(candidates, startFrame, {
  minSpacing,
  earlyFrameExclusion = minSpacing,
  suspiciousCloseThreshold = Math.max(minSpacing * 2, 24),
}) {
  const warnings = [];
  const exclusionFrames = Math.max(minSpacing, earlyFrameExclusion);
  if (candidates.some(candidate => candidate.frame - startFrame < exclusionFrames)) {
    warnings.push(`A candidate violated the ${exclusionFrames}-frame early exclusion window.`);
  }
  const best = candidates[0];
  if (best && best.frame - startFrame <= suspiciousCloseThreshold) {
    warnings.push(`Best loop candidate is only ${best.frame - startFrame} frames after startFrame; inspect it before using as a loop endpoint.`);
  }
  return warnings;
}

module.exports = {
  dHashRaw,
  hammingDistance,
  pickLoopCandidates,
  buildLoopWarnings,
};
