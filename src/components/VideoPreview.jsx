import React, { useState, useRef, useCallback, useEffect } from 'react'
import { applyKeying, composeToCanvas, autoCropKeyed } from '../lib/keying.js'

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

  const videoRef = useRef(null)
  const canvasRef = useRef(null)
  const tempCanvasRef = useRef(document.createElement('canvas'))
  const seekRef = useRef(false)  // 防止 seek 事件重入

  // ===== 视频加载 =====
  useEffect(() => {
    if (!videoFile) {
      setFrameImageData(null)
      setFrameTime(0)
      return
    }
    const video = videoRef.current
    if (!video) return

    const url = URL.createObjectURL(videoFile)
    video.src = url

    const onLoaded = () => {
      // 加载完后 seek 到第一帧
      seekToFrame(0)
    }
    video.addEventListener('loadeddata', onLoaded)

    return () => {
      video.removeEventListener('loadeddata', onLoaded)
      URL.revokeObjectURL(url)
    }
  }, [videoFile])

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
    const video = videoRef.current
    if (!video || !video.videoWidth) {
      seekRef.current = false
      return
    }

    // 截取当前帧到 canvas
    const w = video.videoWidth
    const h = video.videoHeight
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')
    ctx.drawImage(video, 0, 0)
    const imgData = ctx.getImageData(0, 0, w, h)
    setFrameImageData(imgData)
    setLoading(false)
    seekRef.current = false
  }, [])

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
  const duration = videoInfo?.duration || videoRef.current?.duration || 0

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
      <div className="frame-canvas-wrapper">
        {loading && <div className="frame-loading">截帧中...</div>}
        <canvas ref={canvasRef} className="preview-canvas" />
      </div>

      {/* 时间轴帧选择器 */}
      <div className="timeline-bar">
        <span className="time-label">{formatTime(frameTime)}</span>
        <div className="timeline-track-wrap">
          <div className="timeline-range-indicator" 
            style={{
              left: `${duration > 0 ? (range.startFrame / (videoInfo?.fps || 30) / duration * 100) : 0}%`,
              width: `${duration > 0 ? ((range.endFrame - range.startFrame) / (videoInfo?.fps || 30) / duration * 100) : 0}%`
            }}
          />
          <input
            type="range"
            className="timeline-slider"
            min={0}
            max={duration || 0}
            step={0.01}
            value={frameTime}
            onChange={(e) => {
              const t = Number(e.target.value)
              setFrameTime(t)
              seekToFrame(t)
            }}
          />
        </div>
        <span className="time-label">{formatTime(duration)}</span>
      </div>

      {/* 标记起点 / 终点按钮 */}
      {videoInfo && (
        <div className="timeline-mark-actions">
          <button
            className="btn-mark"
            onClick={() => {
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
              const fps = videoInfo.fps || 30
              const frame = Math.round(frameTime * fps)
              onRangeChange({ ...range, endFrame: Math.max(frame, range.startFrame + 1) })
            }}
          >↓ 标记终点</button>
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

function drawCheckerboard(ctx, w, h) {
  const size = 20
  for (let y = 0; y < h; y += size) {
    for (let x = 0; x < w; x += size) {
      ctx.fillStyle = ((x / size + y / size) % 2 === 0) ? '#e0e0e0' : '#c0c0c0'
      ctx.fillRect(x, y, size, size)
    }
  }
}
