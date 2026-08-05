import React, { useState, useRef, useCallback, useEffect, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { ArrowDown, ArrowUp, Check, FileVideo, Flag, List, Repeat2, Upload } from 'lucide-react'
import { applyKeying, composeToCanvas, cropKeyedToBounds, expandBoundsToSourceCenter, findAlphaBounds } from '../lib/keying.js'
import { clamp, cropImageData, getRegionOverlayStyle, makeRegionFromPoints, normalizeRegion } from '../lib/region.js'
import { clipTimelineStyle } from '../lib/actionReviewClips.js'
import { markerTimelineStyle } from '../lib/actionReviewMarkers.js'
import { t } from '../i18n.js'

const AUTO_LOOP_DETECT_KEY = 'greenscreen-studio-auto-loop-detect'
const PREVIEW_STABLE_CROP_ALPHA_THRESHOLD = 10
const EMPTY_STABLE_PREVIEW_CROP = Object.freeze({ status: 'idle', bounds: null, scan: null })

// 解析 /api/video/find-loop-end 的 NDJSON 流式响应：
// 逐行读取，progress 行实时回调，result 行作为返回值；兼容旧版纯 JSON 响应
async function readStreamedDetection(resp, onProgress) {
  if (!resp.body || !resp.body.getReader) {
    return resp.json()
  }
  const reader = resp.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let result = null
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let nl
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim()
      buffer = buffer.slice(nl + 1)
      if (!line) continue
      let msg
      try {
        msg = JSON.parse(line)
      } catch {
        continue
      }
      if (msg.type === 'progress') {
        onProgress?.(msg)
      } else if (msg.type === 'error') {
        throw new Error(msg.error || t('preview.detectFailed'))
      } else if (msg.type === 'result') {
        result = msg
      } else {
        // 兼容：旧版整段纯 JSON 直接当结果
        result = msg
      }
    }
  }
  const rest = buffer.trim()
  if (!result && rest) {
    try {
      return JSON.parse(rest)
    } catch { /* 非 JSON 残留，忽略 */ }
  }
  if (!result) {
    throw new Error(t('preview.detectFailed'))
  }
  return result
}

// 圆圈进度条（SVG 环形），用于移动端自动检测按钮 loading 态
function CircularProgressRing({ percent = 0, size = 24, showText = false }) {
  const stroke = 3
  const r = (size - stroke) / 2
  const circumference = 2 * Math.PI * r
  const offset = circumference * (1 - clamp(percent, 0, 100) / 100)
  // 显示层防御：任何数据源（含后端异常）都不能让数字/aria 值超过 100
  const rounded = Math.round(clamp(percent, 0, 100))
  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      className="detect-progress-ring"
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={rounded}
      aria-label={t('preview.detecting')}
    >
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="currentColor" strokeOpacity={0.25} strokeWidth={stroke} />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke="currentColor"
        strokeWidth={stroke}
        strokeLinecap="round"
        strokeDasharray={circumference}
        strokeDashoffset={offset}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
      />
      {showText && (
        <text
          x="50%"
          y="50%"
          dominantBaseline="central"
          textAnchor="middle"
          fontSize={Math.max(6, size * 0.32)}
          fontWeight={700}
          fill="currentColor"
        >
          {rounded}
        </text>
      )}
    </svg>
  )
}

function mergeAlphaBounds(current, next) {
  if (!next) return current || null
  if (!current) return { ...next }
  return {
    minX: Math.min(current.minX, next.minX),
    minY: Math.min(current.minY, next.minY),
    maxX: Math.max(current.maxX, next.maxX),
    maxY: Math.max(current.maxY, next.maxY),
  }
}

function getStableCropCenterAxes(layout = {}) {
  const anchor = layout.anchor || 'center'
  return {
    x: true,
    y: anchor === 'center',
  }
}

function frameIndexesInRange(startFrame, endFrame) {
  const start = Math.max(0, Math.round(startFrame))
  const end = Math.max(start + 1, Math.round(endFrame))
  const count = end - start
  return Array.from({ length: count }, (_, i) => start + i)
}

function waitForVideoEvent(video, eventName) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      video.removeEventListener(eventName, onEvent)
      video.removeEventListener('error', onError)
    }
    const onEvent = () => {
      cleanup()
      resolve()
    }
    const onError = () => {
      cleanup()
      reject(new Error('video preview scan failed'))
    }
    video.addEventListener(eventName, onEvent, { once: true })
    video.addEventListener('error', onError, { once: true })
  })
}

async function seekVideoToTime(video, time) {
  const target = Math.max(0, Math.min(time, video.duration || time))
  if (video.readyState >= 2 && Math.abs(video.currentTime - target) < 0.0005) {
    return
  }
  video.currentTime = target
  await waitForVideoEvent(video, 'seeked')
}

/**
 * 视频预览组件
 *
 * 三个状态：
 *   1. 无视频 → 占位提示
 *   2. 已上传未处理 → 时间轴选帧 + 实时抠像预览（滑块拖动即时生效）
 *   3. 处理完成 → <video> 播放器
 */
export default function VideoPreview({
  videoFile,
  videoInfo,
  keyingParams,
  layoutParams,
  previewMode = 'keying',
  mobile = false,
  mobileToolsTarget = null,
  resultJobId,
  resultFormat,
  range,
  onRangeChange,
  region,
  regionSelectionMode = false,
  onRegionChange,
  onRegionSelectionComplete,
  reviewClips = [],
  reviewMarkers = [],
  selectedReviewClipIds = [],
  onSelectReviewClip,
  onChoose,
  onPreviewFrameChange,
  seekRequest,
}) {
  const [frameTime, setFrameTime] = useState(0)        // 当前选中的时间点（秒）
  const [frameImageData, setFrameImageData] = useState(null)  // 当前帧的 ImageData
  const [loading, setLoading] = useState(false)
  const [detecting, setDetecting] = useState(false)
  const [detectProgress, setDetectProgress] = useState(null) // {current,total,percent}|null 相似度检测进度
  const [loopCandidates, setLoopCandidates] = useState(null) // [{frame, score}, ...]
  const [similarityHeatmap, setSimilarityHeatmap] = useState(null) // [{pct, opacity}, ...]
  const [similarityScores, setSimilarityScores] = useState(null) // [{frame, score, displayOnly}, ...]
  const [scoreRange, setScoreRange] = useState(null) // {min, max} 用于全局归一化
  const [isLoopPlaying, setIsLoopPlaying] = useState(false)
  const [isTimelineScrubbing, setIsTimelineScrubbing] = useState(false)
  const [autoLoopDetect, setAutoLoopDetect] = useState(() => loadStoredBoolean(AUTO_LOOP_DETECT_KEY, false))
  const [loadedVideoJobId, setLoadedVideoJobId] = useState(null)
  const [containerSize, setContainerSize] = useState({ w: 0, h: 0 })
  const [canvasDisplaySize, setCanvasDisplaySize] = useState(null)
  const [regionDraft, setRegionDraft] = useState(null)
  const [stablePreviewCrop, setStablePreviewCrop] = useState(EMPTY_STABLE_PREVIEW_CROP)

  const videoRef = useRef(null)
  const canvasRef = useRef(null)
  const wrapperRef = useRef(null)
  const tempCanvasRef = useRef(document.createElement('canvas'))
  const captureCanvasRef = useRef(document.createElement('canvas'))
  const timelineTrackRef = useRef(null)
  const mobileMarkerMenuRef = useRef(null)
  const mobileCandidateMenuRef = useRef(null)
  const seekRef = useRef(false)  // 防止 seek 事件重入
  const pendingSeekRef = useRef(null)  // seek 进行中被丢弃的请求，seeked 后补执行
  const scrubbingRef = useRef(false)
  const regionDragRef = useRef(null)
  const rangeRef = useRef(range)
  const detectRequestRef = useRef(0)
  const lastAutoDetectKeyRef = useRef('')
  const autoDetectTimerRef = useRef(null)
  const playbackRef = useRef({ playing: false, rafId: null, loopSeekPending: false })
  const stableCropRequestRef = useRef(0)
  const stableCropFrameCacheRef = useRef({ key: '', sourceWidth: 0, sourceHeight: 0, frames: new Map() })

  const duration = videoInfo?.duration || videoRef.current?.duration || 0
  const fps = videoInfo?.fps || 30
  const startFrame = range?.startFrame ?? 0
  const endFrame = range?.endFrame ?? 0
  const totalFrames = videoInfo?.frameCount || Math.round(fps * duration) || 0
  const selectedReviewSet = useMemo(
    () => new Set((selectedReviewClipIds || []).map(String)),
    [selectedReviewClipIds],
  )
  const startPct = duration > 0 ? clamp((startFrame / fps / duration) * 100, 0, 100) : 0
  const endPct = duration > 0 ? clamp((endFrame / fps / duration) * 100, 0, 100) : 0
  const currentPct = duration > 0 ? clamp((frameTime / duration) * 100, 0, 100) : 0
  const currentFrame = clamp(Math.round(frameTime * fps), 0, totalFrames)
  // 当前帧相似度（与热力图同归一化：相对全量扫描分数）
  const currentSimilarity = useMemo(() => {
    if (!similarityScores?.length) return null
    const entry = similarityScores.find(s => s.frame === currentFrame)
    if (!entry) return null
    const minScore = Math.min(...similarityScores.map(s => s.score))
    const maxScore = Math.max(...similarityScores.map(s => s.score))
    const scoreSpan = maxScore - minScore
    if (scoreSpan <= 0) return 100
    return clamp(Math.round(100 * (maxScore - entry.score) / scoreSpan), 0, 100)
  }, [similarityScores, currentFrame])
  const loopCandidateItems = useMemo(() => {
    if (!loopCandidates?.length) return []
    const minScore = scoreRange?.min ?? Math.min(...loopCandidates.map(candidate => candidate.score))
    const maxScore = scoreRange?.max ?? Math.max(...loopCandidates.map(candidate => candidate.score))
    const scoreSpan = maxScore - minScore
    return loopCandidates.map((candidate, index) => ({
      ...candidate,
      best: index === 0,
      similarity: scoreSpan <= 0
        ? 100
        : clamp(Math.round(100 * (maxScore - candidate.score) / scoreSpan), 0, 100),
    }))
  }, [loopCandidates, scoreRange])
  const processingFrameImageData = useMemo(
    () => cropImageData(frameImageData, region),
    [frameImageData, region]
  )
  const canSelectRegion = Boolean(
    videoInfo &&
    frameImageData &&
    previewMode === 'keying' &&
    regionSelectionMode &&
    !resultJobId
  )
  const loopDetectionParams = useMemo(() => ({
    keying: keyingParams,
    layout: layoutParams,
    mode: 'greenscreen',
    ...(region ? { region } : {}),
  }), [keyingParams, layoutParams, region])
  const loopDetectionSignature = useMemo(
    () => JSON.stringify(loopDetectionParams),
    [loopDetectionParams]
  )
  const stablePreviewFrameCacheKey = useMemo(() => JSON.stringify({
    jobId: videoInfo?.jobId || '',
    keying: keyingParams,
    layoutAutoCrop: layoutParams.autoCrop !== false,
    region,
  }), [keyingParams, layoutParams.autoCrop, region, videoInfo?.jobId])

  useEffect(() => {
    rangeRef.current = range
  }, [range])

  useEffect(() => {
    saveStoredBoolean(AUTO_LOOP_DETECT_KEY, autoLoopDetect)
  }, [autoLoopDetect])

  useEffect(() => {
    if (!mobile) return undefined
    const closeMenus = (event) => {
      for (const menuRef of [mobileMarkerMenuRef, mobileCandidateMenuRef]) {
        const menu = menuRef.current
        if (menu?.open && !menu.contains(event.target)) menu.open = false
      }
    }
    document.addEventListener('pointerdown', closeMenus)
    return () => document.removeEventListener('pointerdown', closeMenus)
  }, [mobile])

  useEffect(() => {
    if (!regionSelectionMode) {
      regionDragRef.current = null
      setRegionDraft(null)
    }
  }, [regionSelectionMode])

  // ===== 监听预览容器尺寸变化，用于计算 canvas 的 contain 尺寸 =====
  useEffect(() => {
    const wrapper = wrapperRef.current
    if (!wrapper || resultJobId || !videoFile) return

    const updateSize = () => {
      const rect = wrapper.getBoundingClientRect()
      setContainerSize({ w: rect.width, h: rect.height })
    }
    updateSize()

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (!entry) return
      const { width, height } = entry.contentRect
      setContainerSize({ w: width, h: height })
    })
    observer.observe(wrapper)
    return () => observer.disconnect()
  }, [resultJobId, videoFile])

  // ===== 从当前视频时间截取一帧 =====
  const captureCurrentFrame = useCallback(() => {
    const video = videoRef.current
    if (!video || !video.videoWidth) return false

    const w = video.videoWidth
    const h = video.videoHeight
    const canvas = captureCanvasRef.current
    if (canvas.width !== w) canvas.width = w
    if (canvas.height !== h) canvas.height = h
    const ctx = canvas.getContext('2d')
    ctx.drawImage(video, 0, 0)
    const imgData = ctx.getImageData(0, 0, w, h)
    setFrameImageData(imgData)
    return true
  }, [])

  const stopLoopPreview = useCallback(() => {
    playbackRef.current.playing = false
    playbackRef.current.loopSeekPending = false
    if (playbackRef.current.rafId) {
      cancelAnimationFrame(playbackRef.current.rafId)
      playbackRef.current.rafId = null
    }
    const video = videoRef.current
    if (video) video.pause()
    setIsLoopPlaying(false)
  }, [])

  // ===== Seek 到指定时间并提取帧 =====
  // 注意：seek 进行中（seekRef=true）会丢弃新请求，但记录到 pendingSeekRef，
  // 等 seeked 后补执行 —— 保证快速拖动时间轴时视频最终收敛到最新位置
  // （否则 onSeeked 会把 frameTime 回拉到旧位置，导致标记起点/终点标到靠前帧）
  const seekToFrame = useCallback((time, { force = false } = {}) => {
    const video = videoRef.current
    if (!video || !video.videoWidth) return
    if (seekRef.current && !force) {
      pendingSeekRef.current = time
      return
    }
    seekRef.current = true
    pendingSeekRef.current = null

    setLoading(true)
    video.currentTime = Math.min(time, video.duration || 0)
  }, [])

  // ===== 外部跳转请求（点击 marker 列表 / 输入帧号）=====
  useEffect(() => {
    if (!seekRequest || !seekRequest.nonce) return
    const currentFps = videoInfo?.fps || 30
    stopLoopPreview()
    seekToFrame(seekRequest.frame / currentFps, { force: true })
    setFrameTime(seekRequest.frame / currentFps)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seekRequest])

  // ===== 当前帧变化通知外部（播放中节流 250ms，其余实时）=====
  const lastFrameNotifyRef = useRef({ time: 0, frame: -1 })
  useEffect(() => {
    const currentFps = videoInfo?.fps || 30
    const frame = Math.round(frameTime * currentFps)
    const last = lastFrameNotifyRef.current
    const now = performance.now()
    if (frame === last.frame) return
    if (isLoopPlaying && now - last.time < 250) return
    last.time = now
    last.frame = frame
    onPreviewFrameChange?.(frame)
  }, [frameTime, isLoopPlaying, onPreviewFrameChange, videoInfo?.fps])

  const renderLoopFrame = useCallback(() => {
    const video = videoRef.current
    if (!video || !playbackRef.current.playing) return
    if (playbackRef.current.loopSeekPending) return

    const fps = videoInfo?.fps || 30
    const currentRange = rangeRef.current || {}
    const startFrame = Math.max(0, currentRange.startFrame ?? 0)
    const endFrame = Math.max(currentRange.endFrame ?? startFrame + 1, startFrame + 1)
    const startTime = startFrame / fps
    const endTime = Math.min(video.duration || endFrame / fps, endFrame / fps)

    if (video.currentTime >= endTime) {
      playbackRef.current.loopSeekPending = true
      playbackRef.current.rafId = null
      video.currentTime = startTime
      return
    }

    if (captureCurrentFrame()) {
      setFrameTime(video.currentTime)
    }

    playbackRef.current.rafId = requestAnimationFrame(renderLoopFrame)
  }, [captureCurrentFrame, videoInfo])

  const onSeeked = useCallback(() => {
    const video = videoRef.current
    const wasLoopSeek = playbackRef.current.loopSeekPending
    const captured = captureCurrentFrame()
    setLoading(false)
    seekRef.current = false

    if (captured && video) {
      setFrameTime(video.currentTime)
    }

    // 补执行拖动期间被丢弃的 seek，让预览收敛到最新帧
    const pending = pendingSeekRef.current
    pendingSeekRef.current = null
    if (pending != null && !wasLoopSeek && video && video.videoWidth) {
      seekRef.current = true
      setLoading(true)
      video.currentTime = Math.min(pending, video.duration || 0)
      return
    }

    if (wasLoopSeek) {
      playbackRef.current.loopSeekPending = false
      if (playbackRef.current.playing && video) {
        video.play().catch(() => {})
        playbackRef.current.rafId = requestAnimationFrame(renderLoopFrame)
      }
    }
  }, [captureCurrentFrame, renderLoopFrame])

  const toggleLoopPreview = useCallback(async () => {
    if (isLoopPlaying) {
      stopLoopPreview()
      return
    }

    const video = videoRef.current
    if (!video || !videoInfo) return

    const fps = videoInfo.fps || 30
    const startFrame = Math.max(0, range?.startFrame ?? 0)
    const endFrame = Math.max(range?.endFrame ?? startFrame + 1, startFrame + 1)
    const startTime = startFrame / fps
    const endTime = Math.min(video.duration || endFrame / fps, endFrame / fps)

    if (video.currentTime < startTime || video.currentTime >= endTime) {
      video.currentTime = startTime
      setFrameTime(startTime)
    }

    try {
      setLoading(false)
      playbackRef.current.playing = true
      setIsLoopPlaying(true)
      await video.play()
      playbackRef.current.rafId = requestAnimationFrame(renderLoopFrame)
    } catch (err) {
      console.error('区间循环播放失败:', err)
      stopLoopPreview()
    }
  }, [isLoopPlaying, range, renderLoopFrame, stopLoopPreview, videoInfo])

  // 标记时读「用户实际指向的时间」而非可能滞后的 frameTime state：
  // 快速拖动时间轴时 seek 是异步的（未落地的目标记在 pendingSeekRef），
  // 优先取 pendingSeekRef，其次 video.currentTime，最后才回退 frameTime
  const getPreviewVideoTime = useCallback(() => {
    const video = videoRef.current
    if (video && video.videoWidth) {
      return pendingSeekRef.current ?? video.currentTime
    }
    return frameTime
  }, [frameTime])

  const markCurrentFrameAsStart = useCallback(() => {
    stopLoopPreview()
    const currentFps = videoInfo?.fps || 30
    const currentTime = getPreviewVideoTime()
    const frame = Math.round(currentTime * currentFps)
    setFrameTime(currentTime)
    // 起点不能 ≥ 终点：若标记位置在终点之后，把终点顺延（与 selectLoopCandidateStart 同策略），
    // 避免「标了却落在旧终点上」导致标不到当前帧
    const nextEnd = Math.min(Math.max(range.endFrame, frame + 1), totalFrames)
    const nextStart = Math.max(0, Math.min(frame, nextEnd - 1))
    onRangeChange({ ...range, startFrame: nextStart, endFrame: nextEnd })
  }, [frameTime, getPreviewVideoTime, onRangeChange, range, stopLoopPreview, totalFrames, videoInfo?.fps])

  const markCurrentFrameAsEnd = useCallback(() => {
    stopLoopPreview()
    const currentFps = videoInfo?.fps || 30
    const currentTime = getPreviewVideoTime()
    const frame = Math.round(currentTime * currentFps)
    setFrameTime(currentTime)
    // 终点不能 ≤ 起点：若标记位置在起点之前，把起点顺延（对称策略）
    const nextStart = Math.max(0, Math.min(range.startFrame, frame - 1))
    const nextEnd = Math.max(frame, nextStart + 1)
    onRangeChange({ ...range, startFrame: nextStart, endFrame: nextEnd })
  }, [frameTime, getPreviewVideoTime, onRangeChange, range, stopLoopPreview, totalFrames, videoInfo?.fps])

  const selectLoopCandidateEnd = useCallback((frame) => {
    const currentFps = videoInfo?.fps || 30
    stopLoopPreview()
    onRangeChange({ ...range, endFrame: Math.max(frame, range.startFrame + 1) })
    seekToFrame(frame / currentFps, { force: true })
    setFrameTime(frame / currentFps)
  }, [onRangeChange, range, seekToFrame, stopLoopPreview, videoInfo?.fps])

  const selectLoopCandidateStart = useCallback((frame) => {
    const currentFps = videoInfo?.fps || 30
    const nextEnd = Math.min(Math.max(range.endFrame, frame + 1), totalFrames)
    const nextStart = Math.max(0, Math.min(frame, nextEnd - 1))
    stopLoopPreview()
    onRangeChange({ ...range, startFrame: nextStart, endFrame: nextEnd })
    seekToFrame(nextStart / currentFps, { force: true })
    setFrameTime(nextStart / currentFps)
  }, [onRangeChange, range, seekToFrame, stopLoopPreview, totalFrames, videoInfo?.fps])

  const toggleStagePlayback = useCallback(() => {
    if (!mobile || canSelectRegion) return
    void toggleLoopPreview()
  }, [canSelectRegion, mobile, toggleLoopPreview])

  const handleStagePlaybackKeyDown = useCallback((event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    toggleStagePlayback()
  }, [toggleStagePlayback])

  const detectLoopEnd = useCallback(async (
    targetStartFrame = rangeRef.current?.startFrame ?? 0,
    { seekToCandidate = true } = {}
  ) => {
    stopLoopPreview()
    if (!videoInfo?.jobId) return

    const requestId = detectRequestRef.current + 1
    detectRequestRef.current = requestId
    const currentFps = videoInfo.fps || 30

    setDetecting(true)
    setLoopCandidates(null)
    setDetectProgress({ current: 0, total: 0, percent: 0 })
    try {
      const resp = await fetch('/api/video/find-loop-end', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jobId: videoInfo.jobId,
          startFrame: targetStartFrame,
          params: loopDetectionParams,
        })
      })
      if (!resp.ok) throw new Error(t('preview.detectFailed'))
      // NDJSON 流式响应：进度行实时更新，最后一行是 result（兼容旧版纯 JSON）
      const data = await readStreamedDetection(resp, (progress) => {
        if (requestId === detectRequestRef.current) setDetectProgress(progress)
      })
      if (requestId !== detectRequestRef.current) return

      const candidates = data.candidates || []
      const scores = data.scores || []
      setLoopCandidates(candidates)

      if (scores.length > 0) {
        const totalFrames = videoInfo.frameCount || Math.round(videoInfo.fps * videoInfo.duration)
        const minScore = Math.min(...scores.map(s => s.score))
        const maxScore = Math.max(...scores.map(s => s.score))
        const heatmapScoreRange = Math.max(maxScore - minScore, 1)
        const candidateScores = scores.filter(s => !s.displayOnly)
        const scoreBase = candidateScores.length > 0 ? candidateScores : scores
        const scoreMin = Math.min(...scoreBase.map(s => s.score))
        const scoreMax = Math.max(...scoreBase.map(s => s.score))

        setScoreRange({ min: scoreMin, max: scoreMax })
        setSimilarityScores(scores)
        setSimilarityHeatmap(scores.map(s => ({
          pct: (s.frame / totalFrames) * 100,
          opacity: 1 - (s.score - minScore) / heatmapScoreRange,
          displayOnly: !!s.displayOnly,
        })))
      } else {
        setScoreRange(null)
        setSimilarityHeatmap(null)
      }

      if (candidates.length > 0) {
        const currentRange = rangeRef.current || {}
        const nextEndFrame = candidates[0].frame
        onRangeChange({ ...currentRange, endFrame: nextEndFrame })
        if (seekToCandidate) {
          seekToFrame(nextEndFrame / currentFps, { force: true })
          setFrameTime(nextEndFrame / currentFps)
        }
      }
    } catch (err) {
      if (requestId === detectRequestRef.current) {
        console.error('循环检测失败:', err)
      }
    } finally {
      if (requestId === detectRequestRef.current) {
        setDetecting(false)
        setDetectProgress(null)
      }
    }
  }, [loopDetectionParams, onRangeChange, seekToFrame, stopLoopPreview, videoInfo])

  useEffect(() => {
    if (!videoInfo?.jobId) return
    detectRequestRef.current += 1
    setDetecting(false)
    setLoopCandidates(null)
    setSimilarityHeatmap(null)
    setSimilarityScores(null)
    setScoreRange(null)
    setDetectProgress(null)
  }, [loopDetectionSignature, videoInfo?.jobId])

  useEffect(() => {
    if (!autoLoopDetect || !videoInfo?.jobId || loadedVideoJobId !== videoInfo.jobId) return
    const key = `${videoInfo.jobId}:${startFrame}:${loopDetectionSignature}`
    if (lastAutoDetectKeyRef.current === key) return

    if (autoDetectTimerRef.current) {
      clearTimeout(autoDetectTimerRef.current)
    }

    autoDetectTimerRef.current = setTimeout(() => {
      if (lastAutoDetectKeyRef.current === key) return
      lastAutoDetectKeyRef.current = key
      detectLoopEnd(startFrame, { seekToCandidate: false })
    }, 450)

    return () => {
      if (autoDetectTimerRef.current) {
        clearTimeout(autoDetectTimerRef.current)
        autoDetectTimerRef.current = null
      }
    }
  }, [autoLoopDetect, detectLoopEnd, loadedVideoJobId, loopDetectionSignature, startFrame, videoInfo?.jobId])

  // ===== 视频加载 =====
  useEffect(() => {
    stopLoopPreview()
    if (!videoFile) {
      setFrameImageData(null)
      setFrameTime(0)
      setLoopCandidates(null)
      setSimilarityHeatmap(null)
      setSimilarityScores(null)
      setScoreRange(null)
      setDetectProgress(null)
      setLoadedVideoJobId(null)
      return
    }
    const video = videoRef.current
    if (!video) return

    setLoadedVideoJobId(null)
    const url = URL.createObjectURL(videoFile)
    video.src = url

    const onLoaded = () => {
      // 加载完后 seek 到第一帧
      seekToFrame(0)
      setLoadedVideoJobId(videoInfo?.jobId ?? '')
    }
    video.addEventListener('loadeddata', onLoaded)

    return () => {
      video.removeEventListener('loadeddata', onLoaded)
      URL.revokeObjectURL(url)
    }
  }, [seekToFrame, stopLoopPreview, videoFile, videoInfo?.jobId])

  useEffect(() => () => stopLoopPreview(), [stopLoopPreview])

  useEffect(() => {
    if (regionSelectionMode) stopLoopPreview()
  }, [regionSelectionMode, stopLoopPreview])

  useEffect(() => () => {
    if (autoDetectTimerRef.current) {
      clearTimeout(autoDetectTimerRef.current)
    }
  }, [])

  useEffect(() => {
    if (resultJobId) stopLoopPreview()
  }, [resultJobId, stopLoopPreview])

  useEffect(() => {
    stableCropRequestRef.current += 1
    const requestId = stableCropRequestRef.current
    setStablePreviewCrop({
      status: layoutParams.autoCrop === false ? 'disabled' : 'scanning',
      bounds: null,
      scan: null,
    })

    if (!videoFile || !videoInfo || previewMode !== 'composite' || layoutParams.autoCrop === false) {
      return undefined
    }

    let cancelled = false
    let objectUrl = ''
    const scanVideo = document.createElement('video')
    scanVideo.muted = true
    scanVideo.preload = 'auto'
    const scanCanvas = document.createElement('canvas')

    const scan = async () => {
      objectUrl = URL.createObjectURL(videoFile)
      scanVideo.src = objectUrl
      await waitForVideoEvent(scanVideo, 'loadeddata')
      if (cancelled || requestId !== stableCropRequestRef.current) return

      const sourceWidth = scanVideo.videoWidth
      const sourceHeight = scanVideo.videoHeight
      const normalizedRegion = normalizeRegion(region, { width: sourceWidth, height: sourceHeight })
      const processingWidth = normalizedRegion?.width || sourceWidth
      const processingHeight = normalizedRegion?.height || sourceHeight
      scanCanvas.width = sourceWidth
      scanCanvas.height = sourceHeight
      const ctx = scanCanvas.getContext('2d')
      const currentFps = videoInfo.fps || 30
      const totalFrames = videoInfo.frameCount || Math.round(currentFps * (videoInfo.duration || scanVideo.duration || 0))
      const scanStart = Math.max(0, Math.min(startFrame, Math.max(0, totalFrames - 1)))
      const scanEnd = Math.max(scanStart + 1, Math.min(endFrame || totalFrames, totalFrames))
      const frames = frameIndexesInRange(scanStart, scanEnd)

      let frameCache = stableCropFrameCacheRef.current
      if (
        frameCache.key !== stablePreviewFrameCacheKey ||
        frameCache.sourceWidth !== sourceWidth ||
        frameCache.sourceHeight !== sourceHeight
      ) {
        frameCache = {
          key: stablePreviewFrameCacheKey,
          sourceWidth,
          sourceHeight,
          frames: new Map(),
        }
        stableCropFrameCacheRef.current = frameCache
      }

      const missingFrames = frames.filter(frame => !frameCache.frames.has(frame))
      let newlyScannedFrameCount = 0

      for (const frame of missingFrames) {
        if (cancelled || requestId !== stableCropRequestRef.current) return
        const time = Math.min(frame / currentFps, scanVideo.duration || frame / currentFps)
        await seekVideoToTime(scanVideo, time)
        if (cancelled || requestId !== stableCropRequestRef.current) return

        ctx.drawImage(scanVideo, 0, 0)
        let imageData = ctx.getImageData(0, 0, sourceWidth, sourceHeight)
        imageData = cropImageData(imageData, region)
        const keyed = applyKeying(imageData, keyingParams)
        const frameBounds = findAlphaBounds(keyed, PREVIEW_STABLE_CROP_ALPHA_THRESHOLD)
        frameCache.frames.set(frame, { bounds: frameBounds })
        newlyScannedFrameCount += 1
      }

      let bounds = null
      let scannedFrameCount = 0
      let foregroundFrameCount = 0

      for (const frame of frames) {
        const cached = frameCache.frames.get(frame)
        if (!cached) continue
        bounds = mergeAlphaBounds(bounds, cached.bounds)
        scannedFrameCount += 1
        if (cached.bounds) foregroundFrameCount += 1
      }
      const displayBounds = layoutParams.sourceCenterAnchor !== false
        ? expandBoundsToSourceCenter(bounds, processingWidth, processingHeight, getStableCropCenterAxes(layoutParams))
        : bounds

      if (!cancelled && requestId === stableCropRequestRef.current) {
        setStablePreviewCrop({
          status: 'ready',
          bounds: displayBounds,
          scan: {
            startFrame: scanStart,
            endFrame: scanEnd,
            scannedFrameCount,
            foregroundFrameCount,
            cachedFrameCount: scannedFrameCount - newlyScannedFrameCount,
            newlyScannedFrameCount,
            rawBounds: bounds,
            sourceCenterAnchor: {
              enabled: layoutParams.sourceCenterAnchor !== false,
              axes: getStableCropCenterAxes(layoutParams),
              sourceWidth: processingWidth,
              sourceHeight: processingHeight,
            },
          },
        })
      }
    }

    scan().catch((err) => {
      if (!cancelled && requestId === stableCropRequestRef.current) {
        console.error('稳定裁剪预览扫描失败:', err)
        setStablePreviewCrop({
          status: 'error',
          bounds: null,
          scan: null,
        })
      }
    })

    return () => {
      cancelled = true
      scanVideo.removeAttribute('src')
      scanVideo.load()
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [endFrame, keyingParams, layoutParams.anchor, layoutParams.autoCrop, layoutParams.sourceCenterAnchor, previewMode, region, stablePreviewFrameCacheKey, startFrame, videoFile, videoInfo])

  // ===== 实时抠像预览（参数变化时重新渲染）=====
  useEffect(() => {
    if (!processingFrameImageData) return
    const canvas = canvasRef.current
    if (!canvas) return

    let keyed = applyKeying(processingFrameImageData, keyingParams)

    if (previewMode === 'keying') {
      // 抠像预览：棋盘格背景
      canvas.width = keyed.width
      canvas.height = keyed.height
      const ctx = canvas.getContext('2d')
      drawCheckerboard(ctx, keyed.width, keyed.height)
      const imgData = ctx.createImageData(keyed.width, keyed.height)
      imgData.data.set(keyed.data)
      ctx.putImageData(imgData, 0, 0)
    } else {
      // 合成预览：绿幕画布 + 缩放人物
      canvas.width = layoutParams.canvasWidth
      canvas.height = layoutParams.canvasHeight
      const ctx = canvas.getContext('2d')
      if (layoutParams.autoCrop !== false) {
        // The stable union crop prevents placement drift after its scan finishes.
        // While it is scanning or unavailable, keep composing from the current
        // frame instead of rendering a misleading green-only placeholder.
        keyed = cropKeyedToBounds(
          keyed,
          stablePreviewCrop.status === 'ready' ? stablePreviewCrop.bounds : null,
          PREVIEW_STABLE_CROP_ALPHA_THRESHOLD,
        )
      }
      composeToCanvas(ctx, keyed, layoutParams, tempCanvasRef.current, keyingParams.keyColor)
    }
  }, [processingFrameImageData, keyingParams, layoutParams, previewMode, stablePreviewCrop])

  // ===== Canvas CSS 尺寸自适应：按当前画布实际比例 contain，避免竖屏/合成画布被裁切 =====
  useEffect(() => {
    const canvas = canvasRef.current
    if (!processingFrameImageData || !canvas || containerSize.w <= 0 || containerSize.h <= 0 || canvas.width <= 0 || canvas.height <= 0) {
      setCanvasDisplaySize(null)
      return
    }

    const aspect = canvas.width / canvas.height
    const containerAspect = containerSize.w / containerSize.h
    let cssW
    let cssH

    if (aspect > containerAspect) {
      cssW = containerSize.w
      cssH = containerSize.w / aspect
    } else {
      cssH = containerSize.h
      cssW = containerSize.h * aspect
    }

    const nextSize = {
      w: Math.max(1, Math.round(cssW)),
      h: Math.max(1, Math.round(cssH)),
    }
    setCanvasDisplaySize(prev => (
      prev?.w === nextSize.w && prev?.h === nextSize.h ? prev : nextSize
    ))
  }, [containerSize, processingFrameImageData, keyingParams, layoutParams, previewMode])

  // ===== 帧选择器拖拽：按可见轨道计算，保证 0% / 100% 能落到两端 =====
  const timeFromTimelineX = useCallback((clientX) => {
    const track = timelineTrackRef.current
    if (!track || duration <= 0) return 0
    const rect = track.getBoundingClientRect()
    if (rect.width <= 0) return 0
    const pct = clamp((clientX - rect.left) / rect.width, 0, 1)
    return pct * duration
  }, [duration])

  const scrubTimelineTo = useCallback((clientX) => {
    if (duration <= 0) return
    stopLoopPreview()
    const t = timeFromTimelineX(clientX)
    setFrameTime(t)
    seekToFrame(t)
  }, [duration, seekToFrame, stopLoopPreview, timeFromTimelineX])

  const onTimelinePointerDown = useCallback((event) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return
    event.preventDefault()
    scrubbingRef.current = true
    setIsTimelineScrubbing(true)
    event.currentTarget.setPointerCapture?.(event.pointerId)
    scrubTimelineTo(event.clientX)
  }, [scrubTimelineTo])

  const onTimelinePointerMove = useCallback((event) => {
    if (!scrubbingRef.current) return
    event.preventDefault()
    scrubTimelineTo(event.clientX)
  }, [scrubTimelineTo])

  const stopScrubbingTimeline = useCallback((event) => {
    scrubbingRef.current = false
    setIsTimelineScrubbing(false)
    event.currentTarget.releasePointerCapture?.(event.pointerId)
  }, [])

  const nudgeTimeline = useCallback((delta) => {
    if (duration <= 0) return
    stopLoopPreview()
    const t = clamp(frameTime + delta, 0, duration)
    setFrameTime(t)
    seekToFrame(t)
  }, [duration, frameTime, seekToFrame, stopLoopPreview])

  const onTimelineKeyDown = useCallback((event) => {
    if (event.key === 'ArrowLeft') {
      event.preventDefault()
      nudgeTimeline(event.shiftKey ? -1 : -0.01)
    } else if (event.key === 'ArrowRight') {
      event.preventDefault()
      nudgeTimeline(event.shiftKey ? 1 : 0.01)
    } else if (event.key === 'Home') {
      event.preventDefault()
      nudgeTimeline(-duration)
    } else if (event.key === 'End') {
      event.preventDefault()
      nudgeTimeline(duration)
    }
  }, [duration, nudgeTimeline])

  const getCanvasPoint = useCallback((event) => {
    const canvas = canvasRef.current
    if (!canvas) return null

    const rect = canvas.getBoundingClientRect()
    if (!rect.width || !rect.height) return null

    return {
      x: clamp((event.clientX - rect.left) * (canvas.width / rect.width), 0, canvas.width),
      y: clamp((event.clientY - rect.top) * (canvas.height / rect.height), 0, canvas.height),
    }
  }, [])

  const handleRegionPointerDown = useCallback((event) => {
    if (!canSelectRegion) return

    const point = getCanvasPoint(event)
    if (!point) return

    event.preventDefault()
    event.currentTarget.setPointerCapture?.(event.pointerId)
    regionDragRef.current = {
      origin: point,
      pointerId: event.pointerId,
    }
    setRegionDraft({ x: point.x, y: point.y, width: 0, height: 0 })
  }, [canSelectRegion, getCanvasPoint])

  const handleRegionPointerMove = useCallback((event) => {
    if (!canSelectRegion || !regionDragRef.current) return

    const point = getCanvasPoint(event)
    if (!point) return

    event.preventDefault()
    setRegionDraft(makeRegionFromPoints(regionDragRef.current.origin, point, frameImageData))
  }, [canSelectRegion, frameImageData, getCanvasPoint])

  const handleRegionPointerUp = useCallback((event) => {
    if (!canSelectRegion || !regionDragRef.current) return

    const point = getCanvasPoint(event)
    const drag = regionDragRef.current
    regionDragRef.current = null
    if (event.currentTarget.hasPointerCapture?.(drag.pointerId)) {
      event.currentTarget.releasePointerCapture(drag.pointerId)
    }

    if (!point) {
      setRegionDraft(null)
      return
    }

    event.preventDefault()
    const nextRegion = makeRegionFromPoints(drag.origin, point, frameImageData)
    setRegionDraft(null)

    if (!nextRegion || nextRegion.width < 4 || nextRegion.height < 4) return

    onRegionChange?.(nextRegion)
    onRegionSelectionComplete?.()
  }, [canSelectRegion, frameImageData, getCanvasPoint, onRegionChange, onRegionSelectionComplete])

  const handleRegionPointerCancel = useCallback((event) => {
    if (regionDragRef.current?.pointerId === event.pointerId) {
      regionDragRef.current = null
      setRegionDraft(null)
    }
  }, [])

  // ===== 处理完成后切换到播放器 =====
  if (resultJobId) {
    const resultSrc = `/api/video/preview/${resultJobId}`
    return (
      <div className="video-player-section">
        {resultFormat === 'gif' ? (
          <img
            className="result-video"
            src={resultSrc}
            alt={t('preview.processedHint')}
          />
        ) : (
          <video
            className="result-video"
            src={resultSrc}
            controls
            autoPlay
            loop
          />
        )}
        <p className="player-hint">{t('preview.processedHint')}</p>
      </div>
    )
  }

  // ===== 无视频占位 =====
  if (!videoFile) {
    return (
      <div className="video-preview-hint">
        <div className="placeholder-icon" aria-hidden="true"><FileVideo size={30} /></div>
        <p>{t('app.noAsset')}</p>
        <button type="button" className="empty-preview-action" onClick={onChoose}>
          <Upload size={16} aria-hidden="true" />
          {t('app.importAsset')}
        </button>
      </div>
    )
  }

  // ===== 帧选择 + 实时预览 =====
  return (
    <div className="video-frame-preview">
      {/* 隐藏的 video 元素用于 seek 截帧 */}
      <video
        ref={videoRef}
        onSeeked={onSeeked}
        style={{ display: 'none' }}
        preload="auto"
        muted
      />

      {/* Canvas 预览 */}
      <div className="frame-canvas-wrapper" ref={wrapperRef}>
        {loading && <div className="frame-loading">{t('preview.loadingFrame')}</div>}
        <div
          className={`video-preview-stage ${canSelectRegion ? 'selecting' : ''} ${mobile && !canSelectRegion ? 'is-playable' : ''}`}
          style={canvasDisplaySize
            ? { width: `${canvasDisplaySize.w}px`, height: `${canvasDisplaySize.h}px` }
            : undefined}
          role={mobile && !canSelectRegion ? 'button' : undefined}
          tabIndex={mobile && !canSelectRegion ? 0 : undefined}
          aria-label={mobile && !canSelectRegion ? (isLoopPlaying ? t('preview.pauseRange') : t('preview.playRange')) : undefined}
          onClick={toggleStagePlayback}
          onKeyDown={handleStagePlaybackKeyDown}
          onPointerDown={handleRegionPointerDown}
          onPointerMove={handleRegionPointerMove}
          onPointerUp={handleRegionPointerUp}
          onPointerCancel={handleRegionPointerCancel}
        >
          <canvas ref={canvasRef} className="preview-canvas" />
          {canSelectRegion && regionDraft && (
            <div
              className="region-selection-box"
              style={getRegionOverlayStyle(regionDraft, frameImageData)}
            />
          )}
        </div>

        {mobile && videoInfo && !canSelectRegion && mobileToolsTarget && createPortal((
          <div className="mobile-preview-tools" role="toolbar" aria-label={t('preview.previewTools')}>
            <details
              className="mobile-preview-tool mobile-preview-menu"
              ref={mobileMarkerMenuRef}
              onToggle={(event) => {
                if (event.currentTarget.open && mobileCandidateMenuRef.current) {
                  mobileCandidateMenuRef.current.open = false
                }
              }}
            >
              <summary className="mobile-preview-icon-btn" aria-label={t('preview.markFrame')} title={t('preview.markFrame')}>
                <Flag size={18} aria-hidden="true" />
              </summary>
              <div className="mobile-preview-popover mobile-marker-menu" role="menu" aria-label={t('preview.markFrame')}>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    markCurrentFrameAsStart()
                    mobileMarkerMenuRef.current.open = false
                  }}
                >
                  <ArrowUp size={16} aria-hidden="true" />
                  <span>{t('preview.markAsStart')}</span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    markCurrentFrameAsEnd()
                    mobileMarkerMenuRef.current.open = false
                  }}
                >
                  <ArrowDown size={16} aria-hidden="true" />
                  <span>{t('preview.markAsEnd')}</span>
                </button>
              </div>
            </details>

            <button
              type="button"
              className={`mobile-preview-icon-btn mobile-auto-loop-btn ${autoLoopDetect ? 'active' : ''}`}
              aria-label={t('preview.autoLoopAria')}
              aria-pressed={autoLoopDetect}
              title={detecting ? t('preview.detecting') : t('preview.autoLoop')}
              onClick={() => setAutoLoopDetect(current => !current)}
              disabled={detecting}
            >
              {detecting
                ? <CircularProgressRing percent={detectProgress?.percent ?? 0} size={24} showText />
                : <Repeat2 size={18} aria-hidden="true" />}
            </button>

            {loopCandidateItems.length > 0 && (
              <details
                className="mobile-preview-tool mobile-preview-menu"
                ref={mobileCandidateMenuRef}
                onToggle={(event) => {
                  if (event.currentTarget.open && mobileMarkerMenuRef.current) {
                    mobileMarkerMenuRef.current.open = false
                  }
                }}
              >
                <summary className="mobile-preview-icon-btn" aria-label={t('preview.loopCandidates')} title={t('preview.loopCandidates')}>
                  <List size={18} aria-hidden="true" />
                  <span className="mobile-preview-tool-badge">{loopCandidateItems.length}</span>
                </summary>
                <div className="mobile-preview-popover mobile-candidate-menu" role="menu" aria-label={t('preview.loopCandidates')}>
                  {loopCandidateItems.map(candidate => {
                    const active = candidate.frame === range.endFrame
                    return (
                      <button
                        type="button"
                        role="menuitem"
                        key={candidate.frame}
                        className={`${active ? 'active' : ''} ${candidate.best ? 'best' : ''}`}
                        aria-label={t('preview.candidateTitle', { frame: candidate.frame, similarity: candidate.similarity })}
                        onClick={() => {
                          selectLoopCandidateEnd(candidate.frame)
                          mobileCandidateMenuRef.current.open = false
                        }}
                      >
                        <span className="mobile-candidate-main">
                          <strong>{candidate.frame}f</strong>
                          <small>{formatTime(candidate.frame / fps)}</small>
                        </span>
                        <span className="mobile-candidate-score">{candidate.similarity}%</span>
                        {active && <Check size={15} aria-hidden="true" />}
                      </button>
                    )
                  })}
                </div>
              </details>
            )}
          </div>
        ), mobileToolsTarget)}
      </div>

      {/* 时间轴帧选择器 */}
      <div className="timeline-bar">
        <span className="time-label">{formatTime(frameTime)}</span>
        <div className="timeline-track-column">
          <div
            ref={timelineTrackRef}
            className="timeline-track-wrap"
            onPointerDown={onTimelinePointerDown}
            onPointerMove={onTimelinePointerMove}
            onPointerUp={stopScrubbingTimeline}
            onPointerCancel={stopScrubbingTimeline}
          >
            <div className="timeline-track-base" />
            <div className="timeline-range-indicator" 
              style={{
                left: `${startPct}%`,
                width: `${Math.max(0, endPct - startPct)}%`
              }}
            />
            {totalFrames > 0 && reviewClips.length > 0 && (
              <div className="timeline-review-clips" aria-hidden="false">
                {reviewClips.map((clip) => {
                  const style = clipTimelineStyle(clip, totalFrames)
                  const selected = selectedReviewSet.has(String(clip.id))
                  return (
                    <button
                      key={clip.id}
                      type="button"
                      className={`timeline-review-clip ${selected ? 'selected' : ''} status-${clip.status || 'draft'}`}
                      style={style}
                      title={`${clip.name} · ${clip.startFrame}-${Math.max(clip.startFrame, (clip.endFrame || 0) - 1)} · ${clip.status}`}
                      onClick={(event) => {
                        event.stopPropagation()
                        onSelectReviewClip?.(clip, event)
                      }}
                    >
                      <span>{clip.name}</span>
                    </button>
                  )
                })}
              </div>
            )}
            {totalFrames > 0 && reviewMarkers.length > 0 && (
              <div className="timeline-semantic-markers">
                {reviewMarkers.map((marker) => (
                  <button
                    key={marker.id}
                    type="button"
                    className={`timeline-semantic-marker type-${marker.type}`}
                    style={markerTimelineStyle(marker, totalFrames)}
                    title={`${t(`review.markerTypes.${marker.type}`)} · ${t('review.marker.atFrame', { frame: marker.frame })}${marker.label ? ` · ${marker.label}` : ''}`}
                    aria-label={`${t(`review.markerTypes.${marker.type}`)} ${t('review.marker.atFrame', { frame: marker.frame })}`}
                    onClick={(event) => {
                      event.stopPropagation()
                      seekToFrame(marker.frame / fps, { force: true })
                      setFrameTime(marker.frame / fps)
                    }}
                  />
                ))}
              </div>
            )}
            {/* 起点/终点标记针 */}
            {duration > 0 && videoInfo && (
              <>
                <div className="timeline-marker marker-start"
                  style={{ left: `${startPct}%` }}
                  title={t('preview.markerStart', { frame: range.startFrame })}
                >
                  <span className="marker-label">{range.startFrame}</span>
                  <span className="marker-dot" />
                </div>
                <div className="timeline-marker marker-end"
                  style={{ left: `${endPct}%` }}
                  title={t('preview.markerEnd', { frame: range.endFrame })}
                >
                  <span className="marker-label">{range.endFrame}</span>
                  <span className="marker-dot" />
                </div>
              </>
            )}
            <div
              className={`timeline-current-marker ${isTimelineScrubbing ? 'is-scrubbing' : ''}`}
              style={{ left: `${currentPct}%` }}
              role="slider"
              tabIndex={duration > 0 ? 0 : -1}
              aria-label={t('preview.currentFrame')}
              aria-valuemin={0}
              aria-valuemax={duration}
              aria-valuenow={frameTime}
              onKeyDown={onTimelineKeyDown}
            >
              <span className="timeline-current-frame-tip">
                {t('preview.currentFrameTip', { frame: currentFrame })}
                {currentSimilarity != null && t('preview.currentFrameSimilarityTip', { similarity: currentSimilarity })}
              </span>
            </div>
          </div>
          {/* 相似度热力图 */}
          {similarityHeatmap && (
            <div className="timeline-heatmap">
              {similarityHeatmap.map((h, i) => (
                <div
                  key={i}
                  className="heatmap-bar"
                  style={{
                    left: `${h.pct}%`,
                    opacity: Math.max(0.08, h.opacity),
                  }}
                />
              ))}
            </div>
          )}
        </div>
        <span className="time-label">{formatTime(duration)}</span>
      </div>

      {/* 相似度检测进度条（桌面端，时间轴下方细条） */}
      {detecting && detectProgress && !mobile && (
        <div
          className="detect-progress-track"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={clamp(detectProgress.percent, 0, 100)}
          aria-label={t('preview.detecting')}
        >
          <div
            className="detect-progress-fill"
            style={{ width: `${clamp(detectProgress.percent, 0, 100)}%` }}
          />
        </div>
      )}

      {/* 标记起点 / 终点 / 自动检测按钮 */}
      {videoInfo && !mobile && (
        <div className="timeline-mark-actions">
          <button
            className={`btn-mark btn-play-loop ${isLoopPlaying ? 'active' : ''}`}
            onClick={toggleLoopPreview}
            title={t('preview.loopPreviewTitle')}
          >{isLoopPlaying ? t('preview.pauseRange') : t('preview.playRange')}</button>
          <button
            className="btn-mark"
            onClick={markCurrentFrameAsStart}
          >{t('preview.markStart')}</button>
          <span className="mark-range-info">
            {range.startFrame} ~ {range.endFrame} {t('common.frames')}
          </span>
          <button
            className="btn-mark"
            onClick={markCurrentFrameAsEnd}
          >{t('preview.markEnd')}</button>
          <button
            className="btn-mark btn-loop"
            onClick={() => detectLoopEnd(range.startFrame)}
            disabled={detecting}
          >
            <input
              type="checkbox"
              className="loop-auto-checkbox"
              checked={autoLoopDetect}
              onClick={(event) => event.stopPropagation()}
              onChange={(event) => setAutoLoopDetect(event.target.checked)}
              disabled={detecting}
              aria-label={t('preview.autoLoopAria')}
            />
            <span>{detecting ? `${t('preview.detecting')}${detectProgress != null ? ` ${clamp(detectProgress.percent, 0, 100)}%` : ''}` : t('preview.autoLoop')}</span>
          </button>
        </div>
      )}

      {/* 候选帧列表 */}
      {!mobile && loopCandidates && loopCandidates.length > 0 && (
        <div className="loop-candidates">
          <span className="candidates-label">{t('preview.loopCandidates')}</span>
          <div className="candidates-list">
            {loopCandidates.length > 0 && (() => {
              // 用全局 scores 的 min/max 归一化到 0%-100%
              const mn = scoreRange?.min ?? Math.min(...loopCandidates.map(c => c.score))
              const mx = scoreRange?.max ?? Math.max(...loopCandidates.map(c => c.score))
              const scoreRangeVal = mx - mn
              return loopCandidates.map((c, i) => {
                const activeEnd = c.frame === range.endFrame
                const activeStart = c.frame === range.startFrame
                const fps = videoInfo?.fps || 30
                const similarity = scoreRangeVal <= 0
                  ? 100
                  : clamp(Math.round(100 * (mx - c.score) / scoreRangeVal), 0, 100)
                return (
                  <button
                    key={c.frame}
                    className={`candidate-chip ${activeEnd ? 'active active-end' : ''} ${activeStart ? 'active active-start' : ''} ${i === 0 ? 'best' : ''}`}
                    onClick={() => selectLoopCandidateEnd(c.frame)}
                    onContextMenu={(event) => {
                      event.preventDefault()
                      selectLoopCandidateStart(c.frame)
                    }}
                    title={t('preview.candidateTitle', { frame: c.frame, similarity })}
                  >
                    <span className="chip-frame">{c.frame}f</span>
                    <span className="chip-time">{formatTime(c.frame / fps)}</span>
                    <span className="chip-score">{similarity}%</span>
                  </button>
                )
              })
            })()}
          </div>
        </div>
      )}
    </div>
  )
}

function formatTime(s) {
  if (!s || isNaN(s)) return '0:00'
  const m = Math.floor(s / 60)
  const sec = Math.floor(s % 60)
  return `${m}:${sec.toString().padStart(2, '0')}`
}

function loadStoredBoolean(key, fallback) {
  try {
    const value = localStorage.getItem(key)
    if (value == null) return fallback
    return value === 'true'
  } catch (e) {
    return fallback
  }
}

function saveStoredBoolean(key, value) {
  try {
    localStorage.setItem(key, String(value))
  } catch (e) { /* ignore */ }
}

function drawCheckerboard(ctx, w, h) {
  const size = 20
  for (let y = 0; y < h; y += size) {
    for (let x = 0; x < w; x += size) {
      ctx.fillStyle = ((x / size + y / size) % 2 === 0) ? '#e0e0e0' : '#c0c0c0'
      ctx.fillRect(x, y, size, size)
    }
  }
}
