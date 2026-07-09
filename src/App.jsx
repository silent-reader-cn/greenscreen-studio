import React, { useState, useRef, useCallback, useEffect } from 'react'
import { applyKeying, composeToCanvas, autoCropKeyed } from './lib/keying.js'
import UploadZone from './components/UploadZone.jsx'
import KeyingPanel from './components/KeyingPanel.jsx'
import LayoutPanel from './components/LayoutPanel.jsx'
import PreviewCanvas from './components/PreviewCanvas.jsx'
import VideoPanel from './components/VideoPanel.jsx'
import VideoPreview from './components/VideoPreview.jsx'

// ===== 默认参数 =====
const DEFAULT_KEYING = {
  keyColor: [0, 255, 0],
  tolerance: 30,
  spillSuppression: 40,
  feather: 15,
  edgeShrink: 0,
}

const DEFAULT_LAYOUT = {
  canvasWidth: 1280,
  canvasHeight: 720,
  personWidth: 960,
  personHeight: 540,
  bgColor: [0, 255, 0],
  autoCrop: true,
}

// ===== localStorage 持久化 =====
const STORAGE_KEY = 'greenscreen-studio-params'

function loadParams() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (saved) {
      const parsed = JSON.parse(saved)
      return {
        keying: { ...DEFAULT_KEYING, ...parsed.keying },
        layout: { ...DEFAULT_LAYOUT, ...parsed.layout },
      }
    }
  } catch (e) { /* ignore */ }
  return { keying: DEFAULT_KEYING, layout: DEFAULT_LAYOUT }
}

function saveParams(keying, layout) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ keying, layout }))
  } catch (e) { /* ignore */ }
}

export default function App() {
  // ===== 从 localStorage 恢复参数 =====
  const initial = loadParams()
  const [imageData, setImageData] = useState(null)
  const [imageSize, setImageSize] = useState({ w: 0, h: 0 })
  const [tab, setTab] = useState('keying')

  const [keyingParams, setKeyingParams] = useState(initial.keying)
  const [layoutParams, setLayoutParams] = useState(initial.layout)

  const [exporting, setExporting] = useState(false)
  const [mediaMode, setMediaMode] = useState('image')  // 'image' | 'video'

  // 视频预览状态
  const [videoFile, setVideoFile] = useState(null)
  const [videoInfo, setVideoInfo] = useState(null)
  const [resultJobId, setResultJobId] = useState(null)  // 处理完成后用于播放

  // 切换模式时保留另一边的文件状态（不销毁）
  const switchMode = (mode) => {
    setMediaMode(mode)
  }

  const handleVideoUpload = useCallback((file, info) => {
    setVideoFile(file)
    setVideoInfo(info)
    setResultJobId(null)
  }, [])

  const handleVideoDone = useCallback((jobId) => {
    setResultJobId(jobId)
  }, [])

  // ===== 参数变化时持久化 =====
  useEffect(() => {
    saveParams(keyingParams, layoutParams)
  }, [keyingParams, layoutParams])

  // ===== 实时预览 =====
  const previewRef = useRef(null)
  const tempCanvasRef = useRef(document.createElement('canvas'))

  const renderPreview = useCallback(() => {
    if (!imageData) return
    const canvas = previewRef.current
    if (!canvas) return

    // 抠像
    let keyed = applyKeying(imageData, keyingParams)

    if (tab === 'keying') {
      // 抠像预览：显示抠像结果（棋盘格背景）
      canvas.width = keyed.width
      canvas.height = keyed.height
      const ctx = canvas.getContext('2d')
      drawCheckerboard(ctx, keyed.width, keyed.height)
      const imgData = ctx.createImageData(keyed.width, keyed.height)
      imgData.data.set(keyed.data)
      ctx.putImageData(imgData, 0, 0)
    } else {
      // 合成预览：绿幕画布 + 缩放人物
      // 自动裁剪（如果开启）
      if (layoutParams.autoCrop !== false) {
        keyed = autoCropKeyed(keyed)
      }
      const { canvasWidth, canvasHeight } = layoutParams
      canvas.width = canvasWidth
      canvas.height = canvasHeight
      const ctx = canvas.getContext('2d')
      composeToCanvas(ctx, keyed, layoutParams, tempCanvasRef.current)
    }
  }, [imageData, keyingParams, layoutParams, tab])

  useEffect(() => {
    renderPreview()
  }, [renderPreview, mediaMode])

  // ===== 文件加载 =====
  const handleFileLoad = useCallback((file) => {
    const img = new Image()
    img.onload = () => {
      const canvas = document.createElement('canvas')
      canvas.width = img.width
      canvas.height = img.height
      const ctx = canvas.getContext('2d')
      ctx.drawImage(img, 0, 0)
      const data = ctx.getImageData(0, 0, img.width, img.height)
      setImageData(data)
      setImageSize({ w: img.width, h: img.height })
    }
    img.src = URL.createObjectURL(file)
  }, [])

  // ===== 导出 =====
  const handleExport = async (mode) => {
    if (!imageData) return
    setExporting(true)
    try {
      const formData = new FormData()
      // 从 imageData 重建图片文件
      const canvas = document.createElement('canvas')
      canvas.width = imageData.width
      canvas.height = imageData.height
      canvas.getContext('2d').putImageData(imageData, 0, 0)
      const blob = await new Promise(res => canvas.toBlob(res, 'image/png'))
      formData.append('image', blob, 'source.png')
      formData.append('params', JSON.stringify({
        keying: keyingParams,
        layout: layoutParams,
        mode
      }))

      const resp = await fetch('/api/export', { method: 'POST', body: formData })
      if (!resp.ok) throw new Error('导出失败')
      const resultBlob = await resp.blob()
      const url = URL.createObjectURL(resultBlob)
      const a = document.createElement('a')
      a.href = url
      a.download = `export_${mode}_${Date.now()}.png`
      a.click()
      URL.revokeObjectURL(url)
    } catch (err) {
      alert('导出失败: ' + err.message)
    } finally {
      setExporting(false)
    }
  }

  return (
    <div className="app">
      <header className="header">
        <h1>🎬 绿幕素材标准化工具</h1>
        <p>抠像 · 等比缩放 · 居中重排 · 导出</p>
      </header>

      <main className="main">
        <aside className="sidebar">
          {mediaMode === 'image' ? (
            <UploadZone onFileLoad={handleFileLoad} imageSize={imageSize} />
          ) : (
            <VideoPanel
              keyingParams={keyingParams}
              layoutParams={layoutParams}
              videoFile={videoFile}
              videoInfo={videoInfo}
              onVideoUpload={handleVideoUpload}
              onVideoDone={handleVideoDone}
            />
          )}
          <KeyingPanel params={keyingParams} onChange={setKeyingParams} />
          <LayoutPanel params={layoutParams} onChange={setLayoutParams} imageSize={imageSize} />
        </aside>

        <section className="preview-area">
          <div className="tab-bar">
            <div className="mode-switcher">
              <button
                className={`mode-btn ${mediaMode === 'image' ? 'active' : ''}`}
                onClick={() => switchMode('image')}
              >🖼️ 图片</button>
              <button
                className={`mode-btn ${mediaMode === 'video' ? 'active' : ''}`}
                onClick={() => switchMode('video')}
              >🎬 视频</button>
            </div>
            {mediaMode === 'image' && (
              <>
                <button
                  className={`tab ${tab === 'keying' ? 'active' : ''}`}
                  onClick={() => setTab('keying')}
                >抠像预览</button>
                <button
                  className={`tab ${tab === 'composite' ? 'active' : ''}`}
                  onClick={() => setTab('composite')}
                >合成预览</button>
              </>
            )}
          </div>
          <div className="canvas-wrapper">
            {mediaMode === 'image' ? (
              imageData ? (
                <canvas ref={previewRef} className="preview-canvas" />
              ) : (
                <PreviewCanvas />
              )
            ) : (
              <VideoPreview
                videoFile={videoFile}
                videoInfo={videoInfo}
                keyingParams={keyingParams}
                layoutParams={layoutParams}
                resultJobId={resultJobId}
              />
            )}
          </div>
          {mediaMode === 'image' && imageData && (
            <div className="export-bar">
              <button
                className="btn-export"
                onClick={() => handleExport('greenscreen')}
                disabled={exporting}
              >{exporting ? '导出中...' : '💾 导出绿幕合成图'}</button>
              <button
                className="btn-export btn-secondary"
                onClick={() => handleExport('transparent')}
                disabled={exporting}
              >{exporting ? '导出中...' : '💾 导出透明PNG'}</button>
            </div>
          )}
        </section>
      </main>
    </div>
  )
}

// 棋盘格背景（透明区域指示）
function drawCheckerboard(ctx, w, h) {
  const size = 20
  for (let y = 0; y < h; y += size) {
    for (let x = 0; x < w; x += size) {
      ctx.fillStyle = ((x / size + y / size) % 2 === 0) ? '#e0e0e0' : '#c0c0c0'
      ctx.fillRect(x, y, size, size)
    }
  }
}
