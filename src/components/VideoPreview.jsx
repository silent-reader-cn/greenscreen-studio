import React, { useState, useRef, useCallback, useEffect } from 'react'
import { applyKeying, composeToCanvas, autoCropKeyed } from '../lib/keying.js'

const AUTO_LOOP_DETECT_KEY = 'greenscreen-studio-auto-loop-detect'

/**
 * 视频预览组件
 *
 * 三个状态：
 *   1. 无视频 → 占位提示
 *   2. 已上传未处理 → 时间轴选帧 + 实时抠像预览（滑块拖动即时生效）
 *   3. 处理完成 → <video> 播放器
 */
export default function VideoPreview({ videoFile, videoInfo, keyingParams, layoutParams, resultJobId, range, onRangeChange }) {
  const [frameTime, setFrameTime] = useState(0)        // 当前选中的时间点（秒）
  const [frameImageData, setFrameImageData] = useState(null)  // 当前帧的 ImageData
  const [loading, setLoading] = useState(false)
  const [previewTab, setPreviewTab] = useState('keying')  // 'keying' | 'composite'
  const [detecting, setDetecting] = useState(false)
  const [loopCandidates, setLoopCandidates] = useState(null) // [{frame, score}, ...]
  const [similarityHeatmap, setSimilarityHeatmap] = useState(null) // [{pct, opacity}, ...]
  const [scoreRange, setScoreRange] = useState(null) // {min, max} 用于全局归一化
  const [isLoopPlaying, setIsLoopPlaying] = useState(false)
  const [autoLoopDetect, setAutoLoopDetect] = useState(() => loadStoredBoolean(AUTO_LOOP_DETECT_KEY, false))
  const [loadedVideoJobId, setLoadedVideoJobId] = useState(null)
  const [containerSize, setContainerSize] = useState({ w: 0, h: 0 })

  const videoRef = useRef(null)
  const canvasRef = useRef(null)
  const wrapperRef = useRef(null)
  const tempCanvasRef = useRef(document.createElement('canvas'))
  const timelineTrackRef = useRef(null)
  const seekRef = useRef(false)  // 防止 seek 事件重入
  const scrubbingRef = useRef(false)
  const rangeRef = useRef(range)
  const detectRequestRef = useRef(0)
  const lastAutoDetectKeyRef = useRef('')
  const playbackRef = useRef({ playing: false, rafId: null })

  const duration = videoInfo?.duration || videoRef.current?.duration || 0
  const fps = videoInfo?.fps || 30
  const startFrame = range?.startFrame ?? 0
  const endFrame = range?.endFrame ?? 0
  const startPct = duration > 0 ? clamp((startFrame / fps / duration) * 100, 0, 100) : 0
  const endPct = duration > 0 ? clamp((endFrame / fps / duration) * 100, 0, 100) : 0
  const currentPct = duration > 0 ? clamp((frameTime / duration) * 100, 0, 100) : 0

  useEffect(() => {
    rangeRef.current = range
  }, [range])

  useEffect(() => {
    saveStoredBoolean(AUTO_LOOP_DETECT_KEY, autoLoopDetect)
  }, [autoLoopDetect])

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
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')
    ctx.drawImage(video, 0, 0)
    const imgData = ctx.getImageData(0, 0, w, h)
    setFrameImageData(imgData)
    return true
  }, [])

  const stopLoopPreview = useCallback(() => {
    playbackRef.current.playing = false
    if (playbackRef.current.rafId) {
      cancelAnimationFrame(playbackRef.current.rafId)
      playbackRef.current.rafId = null
    }
    const video = videoRef.current
    if (video) video.pause()
    setIsLoopPlaying(false)
  }, [])

  // ===== Seek 到指定时间并提取帧 =====
  const seekToFrame = useCallback((time) => {
    const video = videoRef.current
    if (!video || !video.videoWidth) return
    if (seekRef.current) return
    seekRef.current = true

    setLoading(true)
    video.currentTime = Math.min(time, video.duration || 0)
  }, [])

  const onSeeked = useCallback(() => {
    const captured = captureCurrentFrame()
    setLoading(false)
    seekRef.current = false
    if (!captured) return
  }, [captureCurrentFrame])

  const renderLoopFrame = useCallback(() => {
    const video = videoRef.current
    if (!video || !playbackRef.current.playing) return

    const fps = videoInfo?.fps || 30
    const startFrame = Math.max(0, range?.startFrame ?? 0)
    const endFrame = Math.max(range?.endFrame ?? startFrame + 1, startFrame + 1)
    const startTime = startFrame / fps
    const endTime = Math.min(video.duration || endFrame / fps, endFrame / fps)

    if (video.currentTime >= endTime) {
      video.currentTime = startTime
    }

    if (captureCurrentFrame()) {
      setFrameTime(video.currentTime)
    }

    playbackRef.current.rafId = requestAnimationFrame(renderLoopFrame)
  }, [captureCurrentFrame, range, videoInfo])

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

  const detectLoopEnd = useCallback(async (targetStartFrame = rangeRef.current?.startFrame ?? 0) => {
    stopLoopPreview()
    if (!videoInfo?.jobId) return

    const requestId = detectRequestRef.current + 1
    detectRequestRef.current = requestId
    const currentFps = videoInfo.fps || 30

    setDetecting(true)
    setLoopCandidates(null)
    try {
      const resp = await fetch('/api/video/find-loop-end', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId: videoInfo.jobId, startFrame: targetStartFrame })
      })
      if (!resp.ok) throw new Error('检测失败')
      const data = await resp.json()
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
        seekToFrame(nextEndFrame / currentFps)
        setFrameTime(nextEndFrame / currentFps)
      }
    } catch (err) {
      if (requestId === detectRequestRef.current) {
        console.error('循环检测失败:', err)
      }
    } finally {
      if (requestId === detectRequestRef.current) {
        setDetecting(false)
      }
    }
  }, [onRangeChange, seekToFrame, stopLoopPreview, videoInfo])

  useEffect(() => {
    if (!autoLoopDetect || !videoInfo?.jobId || loadedVideoJobId !== videoInfo.jobId) return
    const key = `${videoInfo.jobId}:${startFrame}`
    if (lastAutoDetectKeyRef.current === key) return

    lastAutoDetectKeyRef.current = key
    detectLoopEnd(startFrame)
  }, [autoLoopDetect, detectLoopEnd, loadedVideoJobId, startFrame, videoInfo?.jobId])

  // ===== 视频加载 =====
  useEffect(() => {
    stopLoopPreview()
    if (!videoFile) {
      setFrameImageData(null)
      setFrameTime(0)
      setLoopCandidates(null)
      setSimilarityHeatmap(null)
      setScoreRange(null)
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
    if (resultJobId) stopLoopPreview()
  }, [resultJobId, stopLoopPreview])

  // ===== 实时抠像预览（参数变化时重新渲染）=====
  useEffect(() => {
    if (!frameImageData) return
    const canvas = canvasRef.current
    if (!canvas) return

    let keyed = applyKeying(frameImageData, keyingParams)

    if (previewTab === 'keying') {
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
      if (layoutParams.autoCrop !== false) {
        keyed = autoCropKeyed(keyed)
      }
      canvas.width = layoutParams.canvasWidth
      canvas.height = layoutParams.canvasHeight
      const ctx = canvas.getContext('2d')
      composeToCanvas(ctx, keyed, layoutParams, tempCanvasRef.current)
    }
  }, [frameImageData, keyingParams, layoutParams, previewTab])

  // ===== Canvas CSS 尺寸自适应：按当前画布实际比例 contain，避免竖屏/合成画布被裁切 =====
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || containerSize.w <= 0 || containerSize.h <= 0 || canvas.width <= 0 || canvas.height <= 0) return

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

    canvas.style.width = `${Math.max(1, Math.round(cssW))}px`
    canvas.style.height = `${Math.max(1, Math.round(cssH))}px`
  }, [containerSize, frameImageData, keyingParams, layoutParams, previewTab])

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

  // ===== 处理完成后切换到播放器 =====
  if (resultJobId) {
    return (
      <div className="video-player-section">
        <video
          className="result-video"
          src={`/api/video/download/${resultJobId}`}
          controls
          autoPlay
          loop
        />
        <p className="player-hint">处理完成，点击播放预览效果</p>
      </div>
    )
  }

  // ===== 无视频占位 =====
  if (!videoFile) {
    return (
      <div className="video-preview-hint">
        <div className="placeholder-icon">🎬</div>
        <p>视频抠像参数与图片共用</p>
        <p className="hint">调整左侧参数后，上传视频并开始处理</p>
        <p className="hint">上传后可在此选帧实时预览抠像效果</p>
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

      {/* 预览 Tab */}
      <div className="preview-tabs">
        <button
          className={`mini-tab ${previewTab === 'keying' ? 'active' : ''}`}
          onClick={() => setPreviewTab('keying')}
        >抠像预览</button>
        <button
          className={`mini-tab ${previewTab === 'composite' ? 'active' : ''}`}
          onClick={() => setPreviewTab('composite')}
        >合成预览</button>
      </div>

      {/* Canvas 预览 */}
      <div className="frame-canvas-wrapper" ref={wrapperRef}>
        {loading && <div className="frame-loading">截帧中...</div>}
        <canvas ref={canvasRef} className="preview-canvas" />
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
            {/* 起点/终点标记针 */}
            {duration > 0 && videoInfo && (
              <>
                <div className="timeline-marker marker-start"
                  style={{ left: `${startPct}%` }}
                  title={`起点: 第 ${range.startFrame} 帧`}
                >
                  <span className="marker-label">{range.startFrame}</span>
                  <span className="marker-dot" />
                </div>
                <div className="timeline-marker marker-end"
                  style={{ left: `${endPct}%` }}
                  title={`终点: 第 ${range.endFrame} 帧`}
                >
                  <span className="marker-label">{range.endFrame}</span>
                  <span className="marker-dot" />
                </div>
              </>
            )}
            <div
              className="timeline-current-marker"
              style={{ left: `${currentPct}%` }}
              role="slider"
              tabIndex={duration > 0 ? 0 : -1}
              aria-label="当前预览帧"
              aria-valuemin={0}
              aria-valuemax={duration}
              aria-valuenow={frameTime}
              onKeyDown={onTimelineKeyDown}
            />
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

      {/* 标记起点 / 终点 / 自动检测按钮 */}
      {videoInfo && (
        <div className="timeline-mark-actions">
          <button
            className={`btn-mark btn-play-loop ${isLoopPlaying ? 'active' : ''}`}
            onClick={toggleLoopPreview}
            title="播放当前帧范围，循环预览区间效果"
          >{isLoopPlaying ? '暂停区间' : '播放区间'}</button>
          <button
            className="btn-mark"
            onClick={() => {
              stopLoopPreview()
              const fps = videoInfo.fps || 30
              const frame = Math.round(frameTime * fps)
              onRangeChange({ ...range, startFrame: Math.min(frame, range.endFrame) })
            }}
          >↑ 标记起点</button>
          <span className="mark-range-info">
            {range.startFrame} ~ {range.endFrame} 帧
          </span>
          <button
            className="btn-mark"
            onClick={() => {
              stopLoopPreview()
              const fps = videoInfo.fps || 30
              const frame = Math.round(frameTime * fps)
              onRangeChange({ ...range, endFrame: Math.max(frame, range.startFrame + 1) })
            }}
          >↓ 标记终点</button>
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
              aria-label="自动触发循环检测"
            />
            <span>{detecting ? '检测中...' : '自动循环'}</span>
          </button>
        </div>
      )}

      {/* 候选帧列表 */}
      {loopCandidates && loopCandidates.length > 0 && (
        <div className="loop-candidates">
          <span className="candidates-label">循环候选</span>
          <div className="candidates-list">
            {loopCandidates.length > 0 && (() => {
              // 用全局 scores 的 min/max 归一化到 0%-100%
              const mn = scoreRange?.min ?? Math.min(...loopCandidates.map(c => c.score))
              const mx = scoreRange?.max ?? Math.max(...loopCandidates.map(c => c.score))
              const scoreRangeVal = Math.max(mx - mn, 1)
              return loopCandidates.map((c, i) => {
                const activeEnd = c.frame === range.endFrame
                const activeStart = c.frame === range.startFrame
                const fps = videoInfo?.fps || 30
                const similarity = Math.round(100 * (mx - c.score) / scoreRangeVal)
                const totalFrames = videoInfo?.frameCount || Math.round(fps * duration) || range.endFrame
                const selectEndFrame = () => {
                  stopLoopPreview()
                  onRangeChange({ ...range, endFrame: Math.max(c.frame, range.startFrame + 1) })
                  seekToFrame(c.frame / fps)
                  setFrameTime(c.frame / fps)
                }
                const selectStartFrame = () => {
                  stopLoopPreview()
                  const nextEnd = Math.min(Math.max(range.endFrame, c.frame + 1), totalFrames)
                  const nextStart = Math.max(0, Math.min(c.frame, nextEnd - 1))
                  onRangeChange({ ...range, startFrame: nextStart, endFrame: nextEnd })
                  seekToFrame(c.frame / fps)
                  setFrameTime(c.frame / fps)
                }
                return (
                  <button
                    key={c.frame}
                    className={`candidate-chip ${activeEnd ? 'active active-end' : ''} ${activeStart ? 'active active-start' : ''} ${i === 0 ? 'best' : ''}`}
                    onClick={selectEndFrame}
                    onContextMenu={(event) => {
                      event.preventDefault()
                      selectStartFrame()
                    }}
                    title={`第 ${c.frame} 帧 · 相似度 ${similarity}%`}
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

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
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
