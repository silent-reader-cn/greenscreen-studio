import React, { useState, useRef, useCallback, useEffect } from 'react'
import { applyKeying, composeToCanvas, autoCropKeyed } from './lib/keying.js'
import UploadZone from './components/UploadZone.jsx'
import KeyingPanel from './components/KeyingPanel.jsx'
import LayoutPanel from './components/LayoutPanel.jsx'
import PreviewCanvas from './components/PreviewCanvas.jsx'
import VideoPanel from './components/VideoPanel.jsx'
import VideoPreview from './components/VideoPreview.jsx'
import ProfileSwitcher from './components/ProfileSwitcher.jsx'

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

const DEFAULT_SPRITE_PARAMS = {
  frameWidth: 128,
  frameHeight: 128,
  framesPerRow: 8,
  maxFrames: 64,
  sampleEvery: 1,
}

const DEFAULT_VIDEO_PARAMS = {
  mode: 'transparent',
  format: 'webm',
  exportMode: 'video',
  spriteParams: DEFAULT_SPRITE_PARAMS,
}

const DEFAULT_FRAME_RANGE = {
  startFrame: 0,
  endFrame: 0,
}

// ===== localStorage 持久化 =====
const STORAGE_KEY = 'greenscreen-studio-params'
const PROFILES_STORAGE_KEY = 'greenscreen-studio-profiles'

const cloneArray = (value, fallback) => (
  Array.isArray(value) && value.length === fallback.length ? [...value] : [...fallback]
)

function normalizeParams(params = {}) {
  const source = params || {}
  const keying = source.keying || {}
  const layout = source.layout || {}
  const video = source.video || {}
  const spriteParams = video.spriteParams || {}
  const frameRange = source.frameRange || {}

  return {
    keying: {
      ...DEFAULT_KEYING,
      ...keying,
      keyColor: cloneArray(keying.keyColor, DEFAULT_KEYING.keyColor),
    },
    layout: {
      ...DEFAULT_LAYOUT,
      ...layout,
      bgColor: cloneArray(layout.bgColor, DEFAULT_LAYOUT.bgColor),
    },
    video: {
      ...DEFAULT_VIDEO_PARAMS,
      ...video,
      spriteParams: {
        ...DEFAULT_SPRITE_PARAMS,
        ...spriteParams,
      },
    },
    frameRange: {
      startFrame: Math.max(0, Number(frameRange.startFrame) || 0),
      endFrame: Math.max(0, Number(frameRange.endFrame) || 0),
    },
  }
}

function createProfileId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID()
  }
  return `profile-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function makeProfile(name, params, overrides = {}) {
  const now = Date.now()
  const normalized = normalizeParams(params)
  return {
    id: overrides.id || createProfileId(),
    name: String(name || '').trim() || '未命名 Profile',
    keying: normalized.keying,
    layout: normalized.layout,
    video: normalized.video,
    frameRange: normalized.frameRange,
    useCount: overrides.useCount ?? 0,
    createdAt: overrides.createdAt || now,
    updatedAt: overrides.updatedAt || now,
    lastUsedAt: overrides.lastUsedAt || now,
  }
}

function normalizeProfile(profile, index = 0) {
  return makeProfile(profile?.name || `Profile ${index + 1}`, profile, {
    id: profile?.id || createProfileId(),
    useCount: Number(profile?.useCount) || 0,
    createdAt: Number(profile?.createdAt) || Date.now(),
    updatedAt: Number(profile?.updatedAt) || Date.now(),
    lastUsedAt: Number(profile?.lastUsedAt) || 0,
  })
}

function getProfileParams(profile) {
  return normalizeParams({
    keying: profile?.keying,
    layout: profile?.layout,
    video: profile?.video,
    frameRange: profile?.frameRange,
  })
}

function getVideoTotalFrames(info) {
  if (!info) return 0
  return info.frameCount || Math.round(info.fps * info.duration)
}

function resolveFrameRangeForVideo(range, info) {
  const normalized = normalizeParams({ frameRange: range }).frameRange
  const totalFrames = getVideoTotalFrames(info)
  if (!totalFrames) return normalized

  if (normalized.endFrame <= normalized.startFrame) {
    return { startFrame: 0, endFrame: totalFrames }
  }

  const startFrame = Math.min(normalized.startFrame, totalFrames)
  const endFrame = Math.min(Math.max(normalized.endFrame, startFrame), totalFrames)
  return { startFrame, endFrame }
}

function sortProfilesByUsage(profiles) {
  return [...profiles].sort((a, b) => (
    (b.useCount || 0) - (a.useCount || 0) ||
    (b.lastUsedAt || 0) - (a.lastUsedAt || 0) ||
    (b.updatedAt || 0) - (a.updatedAt || 0) ||
    (a.name || '').localeCompare(b.name || '', 'zh-Hans-CN')
  ))
}

function getUniqueProfileName(baseName, profiles) {
  const fallbackName = String(baseName || '').trim() || `Profile ${profiles.length + 1}`
  const existing = new Set(profiles.map(profile => profile.name))
  if (!existing.has(fallbackName)) return fallbackName

  let index = 2
  let nextName = `${fallbackName} ${index}`
  while (existing.has(nextName)) {
    index += 1
    nextName = `${fallbackName} ${index}`
  }
  return nextName
}

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

function loadProfileState() {
  try {
    const saved = localStorage.getItem(PROFILES_STORAGE_KEY)
    if (saved) {
      const parsed = JSON.parse(saved)
      const profiles = Array.isArray(parsed.profiles)
        ? parsed.profiles.map(normalizeProfile).filter(profile => profile.id)
        : []

      if (profiles.length > 0) {
        const activeProfileId = profiles.some(profile => profile.id === parsed.activeProfileId)
          ? parsed.activeProfileId
          : sortProfilesByUsage(profiles)[0].id
        return { profiles, activeProfileId }
      }
    }
  } catch (e) { /* ignore */ }

  const legacyParams = loadParams()
  const defaultProfile = makeProfile('默认', legacyParams, {
    id: 'default',
    useCount: 1,
  })
  return {
    profiles: [defaultProfile],
    activeProfileId: defaultProfile.id,
  }
}

function saveProfileState(profiles, activeProfileId) {
  try {
    localStorage.setItem(PROFILES_STORAGE_KEY, JSON.stringify({ profiles, activeProfileId }))
  } catch (e) { /* ignore */ }
}

function saveParams(keying, layout) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ keying, layout }))
  } catch (e) { /* ignore */ }
}

export default function App() {
  // ===== 从 localStorage 恢复 profiles / 参数 =====
  const initialProfileStateRef = useRef(null)
  if (!initialProfileStateRef.current) {
    initialProfileStateRef.current = loadProfileState()
  }
  const [profiles, setProfiles] = useState(() => initialProfileStateRef.current.profiles)
  const [activeProfileId, setActiveProfileId] = useState(() => initialProfileStateRef.current.activeProfileId)
  const initialActiveProfile = profiles.find(profile => profile.id === activeProfileId) || profiles[0]
  const initialParams = getProfileParams(initialActiveProfile)

  const [imageData, setImageData] = useState(null)
  const [imageSize, setImageSize] = useState({ w: 0, h: 0 })
  const [tab, setTab] = useState('keying')

  const [keyingParams, setKeyingParams] = useState(initialParams.keying)
  const [layoutParams, setLayoutParams] = useState(initialParams.layout)
  const [videoParams, setVideoParams] = useState(initialParams.video)

  const [exporting, setExporting] = useState(false)
  const [mediaMode, setMediaMode] = useState('image')  // 'image' | 'video'

  // 视频预览状态
  const [videoFile, setVideoFile] = useState(null)
  const [videoInfo, setVideoInfo] = useState(null)
  const [resultJobId, setResultJobId] = useState(null)

  // 全局拖放状态
  const [dragOver, setDragOver] = useState(false)
  const [droppedVideoFile, setDroppedVideoFile] = useState(null)

  // 视频帧范围
  const [frameRange, setFrameRange] = useState(initialParams.frameRange)
  const handleRangeChange = useCallback((range) => {
    setFrameRange(range)
  }, [])

  // 切换模式时保留另一边状态，避免 Tab 来回切换导致预览丢失
  const switchMode = (mode) => {
    setMediaMode(mode)
  }

  const handleSelectProfile = useCallback((profileId) => {
    const profile = profiles.find(item => item.id === profileId)
    if (!profile) return

    const nextParams = getProfileParams(profile)
    const now = Date.now()
    setActiveProfileId(profileId)
    setKeyingParams(nextParams.keying)
    setLayoutParams(nextParams.layout)
    setVideoParams(nextParams.video)
    setFrameRange(resolveFrameRangeForVideo(nextParams.frameRange, videoInfo))
    setProfiles(prev => prev.map(item => (
      item.id === profileId
        ? {
            ...item,
            useCount: (item.useCount || 0) + 1,
            lastUsedAt: now,
          }
        : item
    )))
  }, [profiles, videoInfo])

  const handleCreateProfile = useCallback((name) => {
    const profileName = getUniqueProfileName(name, profiles)
    const newProfile = makeProfile(profileName, {
      keying: keyingParams,
      layout: layoutParams,
      video: videoParams,
      frameRange,
    }, {
      useCount: 1,
    })

    setProfiles(prev => [...prev, newProfile])
    setActiveProfileId(newProfile.id)
  }, [frameRange, keyingParams, layoutParams, profiles, videoParams])

  const handleDeleteProfile = useCallback((profileId) => {
    const profile = profiles.find(item => item.id === profileId)
    if (!profile) return

    if (profiles.length <= 1) {
      alert('至少需要保留一个 profile')
      return
    }

    if (!confirm(`删除 profile「${profile.name}」？`)) return

    const remainingProfiles = profiles.filter(item => item.id !== profileId)
    setProfiles(remainingProfiles)

    if (profileId === activeProfileId) {
      const nextProfile = sortProfilesByUsage(remainingProfiles)[0]
      const nextParams = getProfileParams(nextProfile)
      setActiveProfileId(nextProfile.id)
      setKeyingParams(nextParams.keying)
      setLayoutParams(nextParams.layout)
      setVideoParams(nextParams.video)
      setFrameRange(resolveFrameRangeForVideo(nextParams.frameRange, videoInfo))
    }
  }, [activeProfileId, profiles, videoInfo])

  const handleVideoUpload = useCallback((file, info) => {
    setVideoFile(file)
    setVideoInfo(info)
    setResultJobId(null)
    // 新视频上传后重置帧范围为全视频
    if (info) {
      const totalFrames = info.frameCount || Math.round(info.fps * info.duration)
      setFrameRange({ startFrame: 0, endFrame: totalFrames })
    }
  }, [])

  const handleVideoDone = useCallback((jobId) => {
    setResultJobId(jobId)
  }, [])

  // ===== 参数变化时持久化到当前 profile =====
  useEffect(() => {
    const now = Date.now()
    setProfiles(prev => prev.map(profile => (
      profile.id === activeProfileId
        ? {
            ...profile,
            keying: { ...keyingParams },
            layout: { ...layoutParams },
            video: {
              ...videoParams,
              spriteParams: { ...videoParams.spriteParams },
            },
            frameRange: { ...frameRange },
            updatedAt: now,
          }
        : profile
    )))
    saveParams(keyingParams, layoutParams)
  }, [activeProfileId, frameRange, keyingParams, layoutParams, videoParams])

  useEffect(() => {
    saveProfileState(profiles, activeProfileId)
  }, [activeProfileId, profiles])

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
    if (!file || !file.type.startsWith('image/')) return
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

  // ===== 全局拖放事件（document 层拦截，防止浏览器直接打开文件）=====
  useEffect(() => {
    const isFileDrag = (event) => Array.from(event.dataTransfer?.types || []).includes('Files')

    const onDragOver = (event) => {
      if (!isFileDrag(event)) return
      event.preventDefault()
      setDragOver(true)
    }

    const onDragLeave = (event) => {
      if (!isFileDrag(event)) return
      event.preventDefault()
      if (event.relatedTarget === null || !document.querySelector('.app')?.contains(event.relatedTarget)) {
        setDragOver(false)
      }
    }

    const onDrop = (event) => {
      if (!isFileDrag(event)) return
      event.preventDefault()
      setDragOver(false)

      const file = event.dataTransfer?.files?.[0]
      if (!file) return

      if (file.type.startsWith('image/')) {
        switchMode('image')
        handleFileLoad(file)
      } else if (file.type.startsWith('video/')) {
        switchMode('video')
        setDroppedVideoFile(file)
      }
    }

    document.addEventListener('dragover', onDragOver)
    document.addEventListener('dragleave', onDragLeave)
    document.addEventListener('drop', onDrop)
    return () => {
      document.removeEventListener('dragover', onDragOver)
      document.removeEventListener('dragleave', onDragLeave)
      document.removeEventListener('drop', onDrop)
    }
  }, [handleFileLoad])

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
        <div className="header-copy">
          <h1>🎬 绿幕素材标准化工具</h1>
          <p>抠像 · 等比缩放 · 居中重排 · 导出</p>
        </div>
        <ProfileSwitcher
          profiles={profiles}
          activeProfileId={activeProfileId}
          onSelect={handleSelectProfile}
          onCreate={handleCreateProfile}
          onDelete={handleDeleteProfile}
        />
      </header>

      <main className="main">
        <aside className="sidebar">
          {mediaMode === 'image' ? (
            <UploadZone onFileLoad={handleFileLoad} imageSize={imageSize} />
          ) : (
            <VideoPanel
              keyingParams={keyingParams}
              layoutParams={layoutParams}
              videoParams={videoParams}
              onVideoParamsChange={setVideoParams}
              onVideoUpload={handleVideoUpload}
              onVideoDone={handleVideoDone}
              range={frameRange}
              onRangeChange={handleRangeChange}
              droppedFile={droppedVideoFile}
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
                range={frameRange}
                onRangeChange={handleRangeChange}
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

      {dragOver && (
        <div className="drop-overlay">
          <div className="drop-overlay-content">
            <span className="drop-overlay-icon">📁</span>
            <p className="drop-overlay-text">放开鼠标以加载文件</p>
            <p className="drop-overlay-hint">支持图片 PNG/JPG/WebP 或视频 MP4/MOV/WebM/AVI</p>
          </div>
        </div>
      )}
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
