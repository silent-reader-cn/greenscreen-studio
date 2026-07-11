import React, { useState, useRef, useCallback, useEffect, useMemo } from 'react'
import { applyKeying, composeToCanvas, autoCropKeyed } from './lib/keying.js'
import KeyingPanel from './components/KeyingPanel.jsx'
import LayoutPanel from './components/LayoutPanel.jsx'
import PreviewCanvas from './components/PreviewCanvas.jsx'
import VideoPanel from './components/VideoPanel.jsx'
import VideoPreview from './components/VideoPreview.jsx'
import ProfileSwitcher from './components/ProfileSwitcher.jsx'
import CollapsiblePanel from './components/CollapsiblePanel.jsx'

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

function formatBytes(bytes) {
  if (!bytes) return '未知大小'
  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes
  let unitIndex = 0
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex += 1
  }
  return `${value.toFixed(value >= 10 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`
}

function formatDuration(seconds) {
  if (!seconds) return '0秒'
  const minutes = Math.floor(seconds / 60)
  const rest = (seconds % 60).toFixed(1)
  return minutes > 0 ? `${minutes}分${rest}秒` : `${rest}秒`
}

const IMAGE_MIME_BY_EXT = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  bmp: 'image/bmp',
  avif: 'image/avif',
}

const VIDEO_MIME_BY_EXT = {
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  m4v: 'video/x-m4v',
  webm: 'video/webm',
  avi: 'video/x-msvideo',
  mkv: 'video/x-matroska',
}

const MIME_BY_EXT = {
  ...IMAGE_MIME_BY_EXT,
  ...VIDEO_MIME_BY_EXT,
}

const EXT_BY_MIME = Object.entries(MIME_BY_EXT).reduce((acc, [ext, mime]) => {
  acc[mime] = ext
  return acc
}, {})

function getFileExtension(name = '') {
  const match = String(name).toLowerCase().match(/\.([a-z0-9]+)$/)
  return match ? match[1] : ''
}

function getMediaKind(file) {
  if (!file) return null

  const type = String(file.type || '').toLowerCase()
  if (type.startsWith('image/')) return 'image'
  if (type.startsWith('video/')) return 'video'

  const ext = getFileExtension(file.name)
  if (IMAGE_MIME_BY_EXT[ext]) return 'image'
  if (VIDEO_MIME_BY_EXT[ext]) return 'video'

  return null
}

function getMimeTypeForFile(file, kind) {
  const existingType = String(file?.type || '').toLowerCase()
  if (existingType.startsWith('image/') || existingType.startsWith('video/')) return existingType

  const ext = getFileExtension(file?.name)
  if (MIME_BY_EXT[ext]) return MIME_BY_EXT[ext]
  if (existingType) return existingType

  return kind === 'image' ? 'image/png' : kind === 'video' ? 'video/mp4' : ''
}

function createClipboardFileName(kind, type) {
  const ext = EXT_BY_MIME[String(type || '').toLowerCase()] || (kind === 'image' ? 'png' : 'mp4')
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  return `clipboard-${kind}-${stamp}.${ext}`
}

function normalizeMediaFile(file, knownKind = getMediaKind(file)) {
  if (!file || !knownKind) return null

  const type = getMimeTypeForFile(file, knownKind)
  const name = file.name || createClipboardFileName(knownKind, type)

  if (file.name && String(file.type || '').toLowerCase() === type) return file

  return new File([file], name, {
    type,
    lastModified: file.lastModified || Date.now(),
  })
}

function getClipboardMediaFile(clipboardData) {
  const files = Array.from(clipboardData?.files || [])
  const file = files.find(item => getMediaKind(item))
  if (file) return normalizeMediaFile(file)

  const items = Array.from(clipboardData?.items || [])
  for (const item of items) {
    if (item.kind !== 'file') continue
    const candidate = item.getAsFile()
    const kind = getMediaKind(candidate)
    if (kind) return normalizeMediaFile(candidate, kind)
  }

  return null
}

function getBaseMediaMetadata(file, kind = getMediaKind(file)) {
  return {
    kind,
    name: file?.name || createClipboardFileName(kind, file?.type),
    mimeType: file?.type || '未知',
    size: file?.size || 0,
    lastModified: file?.lastModified || 0,
  }
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

function normalizeRegion(region, imageData) {
  if (!region || !imageData) return null

  const x = clamp(Math.floor(region.x), 0, imageData.width)
  const y = clamp(Math.floor(region.y), 0, imageData.height)
  const width = clamp(Math.ceil(region.width), 0, imageData.width - x)
  const height = clamp(Math.ceil(region.height), 0, imageData.height - y)

  if (width <= 0 || height <= 0) return null
  return { x, y, width, height }
}

function makeRegionFromPoints(start, end, imageData) {
  if (!start || !end || !imageData) return null

  const x1 = clamp(Math.floor(Math.min(start.x, end.x)), 0, imageData.width)
  const y1 = clamp(Math.floor(Math.min(start.y, end.y)), 0, imageData.height)
  const x2 = clamp(Math.ceil(Math.max(start.x, end.x)), 0, imageData.width)
  const y2 = clamp(Math.ceil(Math.max(start.y, end.y)), 0, imageData.height)

  return normalizeRegion({
    x: x1,
    y: y1,
    width: x2 - x1,
    height: y2 - y1,
  }, imageData)
}

function cropImageData(imageData, region) {
  const normalized = normalizeRegion(region, imageData)
  if (!normalized) return imageData
  if (
    normalized.x === 0 &&
    normalized.y === 0 &&
    normalized.width === imageData.width &&
    normalized.height === imageData.height
  ) {
    return imageData
  }

  const { x: cropX, y: cropY, width: cropW, height: cropH } = normalized
  const cropped = new Uint8ClampedArray(cropW * cropH * 4)

  for (let y = 0; y < cropH; y++) {
    const srcRow = ((cropY + y) * imageData.width + cropX) * 4
    const dstRow = y * cropW * 4
    cropped.set(imageData.data.subarray(srcRow, srcRow + cropW * 4), dstRow)
  }

  return { data: cropped, width: cropW, height: cropH }
}

function putImageDataLike(ctx, imageData, x = 0, y = 0) {
  const canvasImageData = ctx.createImageData(imageData.width, imageData.height)
  canvasImageData.data.set(imageData.data)
  ctx.putImageData(canvasImageData, x, y)
}

function getRegionOverlayStyle(region, imageData) {
  const normalized = normalizeRegion(region, imageData)
  if (!normalized || !imageData) return null

  return {
    left: `${(normalized.x / imageData.width) * 100}%`,
    top: `${(normalized.y / imageData.height) * 100}%`,
    width: `${(normalized.width / imageData.width) * 100}%`,
    height: `${(normalized.height / imageData.height) * 100}%`,
  }
}

function getContainSize(contentSize, containerSize) {
  if (
    !contentSize ||
    !containerSize ||
    contentSize.w <= 0 ||
    contentSize.h <= 0 ||
    containerSize.w <= 0 ||
    containerSize.h <= 0
  ) {
    return null
  }

  const aspect = contentSize.w / contentSize.h
  const containerAspect = containerSize.w / containerSize.h

  if (aspect > containerAspect) {
    return {
      w: Math.max(1, Math.round(containerSize.w)),
      h: Math.max(1, Math.round(containerSize.w / aspect)),
    }
  }

  return {
    w: Math.max(1, Math.round(containerSize.h * aspect)),
    h: Math.max(1, Math.round(containerSize.h)),
  }
}

function readImageIntrinsicMetadata(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    let settled = false

    const settle = (metadata) => {
      if (settled) return
      settled = true
      window.clearTimeout(timeoutId)
      URL.revokeObjectURL(url)
      resolve(metadata)
    }

    const timeoutId = window.setTimeout(() => settle({}), 2500)
    img.onload = () => settle({
      width: img.naturalWidth || img.width,
      height: img.naturalHeight || img.height,
    })
    img.onerror = () => settle({})
    img.src = url
  })
}

function readVideoIntrinsicMetadata(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file)
    const video = document.createElement('video')
    let settled = false

    const settle = (metadata) => {
      if (settled) return
      settled = true
      window.clearTimeout(timeoutId)
      video.removeAttribute('src')
      video.load()
      URL.revokeObjectURL(url)
      resolve(metadata)
    }

    const timeoutId = window.setTimeout(() => settle({}), 2500)
    video.preload = 'metadata'
    video.muted = true
    video.onloadedmetadata = () => settle({
      width: video.videoWidth,
      height: video.videoHeight,
      duration: Number.isFinite(video.duration) ? video.duration : 0,
    })
    video.onerror = () => settle({})
    video.src = url
    video.load()
  })
}

function readMediaIntrinsicMetadata(file, kind = getMediaKind(file)) {
  if (kind === 'image') return readImageIntrinsicMetadata(file)
  if (kind === 'video') return readVideoIntrinsicMetadata(file)
  return Promise.resolve({})
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
  const [imageFile, setImageFile] = useState(null)
  const [imageSize, setImageSize] = useState({ w: 0, h: 0 })
  const [imageRegion, setImageRegion] = useState(null)
  const [regionSelectionMode, setRegionSelectionMode] = useState(false)
  const [regionDraft, setRegionDraft] = useState(null)
  const [imagePreviewContainerSize, setImagePreviewContainerSize] = useState({ w: 0, h: 0 })
  const [previewMode, setPreviewMode] = useState('keying')

  const [keyingParams, setKeyingParams] = useState(initialParams.keying)
  const [layoutParams, setLayoutParams] = useState(initialParams.layout)
  const [videoParams, setVideoParams] = useState(initialParams.video)

  const [exporting, setExporting] = useState(false)
  const [mediaMode, setMediaMode] = useState('image')  // 'image' | 'video'
  const [videoDockTarget, setVideoDockTarget] = useState(null)
  const videoDockRef = useRef(null)
  const [clipboardImport, setClipboardImport] = useState(null)
  const clipboardImportRequestRef = useRef(0)

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

  const processingImageData = useMemo(
    () => cropImageData(imageData, imageRegion),
    [imageData, imageRegion]
  )
  const processingImageSize = processingImageData
    ? { w: processingImageData.width, h: processingImageData.height }
    : imageSize
  const canSelectImageRegion = Boolean(
    imageData &&
    mediaMode === 'image' &&
    previewMode === 'keying' &&
    regionSelectionMode
  )
  const imagePreviewContentSize = processingImageData
    ? previewMode === 'composite'
      ? { w: layoutParams.canvasWidth, h: layoutParams.canvasHeight }
      : { w: processingImageData.width, h: processingImageData.height }
    : null
  const imagePreviewDisplaySize = getContainSize(imagePreviewContentSize, imagePreviewContainerSize)
  const imagePreviewStageStyle = imagePreviewDisplaySize
    ? {
        width: `${imagePreviewDisplaySize.w}px`,
        height: `${imagePreviewDisplaySize.h}px`,
      }
    : undefined

  // 切换模式时保留另一边状态，避免 Tab 来回切换导致预览丢失
  const switchMode = useCallback((mode) => {
    setMediaMode(mode)
    if (mode !== 'image') {
      setRegionSelectionMode(false)
      setRegionDraft(null)
    }
  }, [])

  const openClipboardImportPrompt = useCallback((file) => {
    const kind = getMediaKind(file)
    const mediaFile = normalizeMediaFile(file, kind)
    if (!mediaFile || !kind) return

    const requestId = clipboardImportRequestRef.current + 1
    clipboardImportRequestRef.current = requestId

    setClipboardImport({
      requestId,
      file: mediaFile,
      metadata: getBaseMediaMetadata(mediaFile, kind),
      loading: true,
    })

    readMediaIntrinsicMetadata(mediaFile, kind).then((intrinsicMetadata) => {
      setClipboardImport(prev => (
        prev?.requestId === requestId
          ? {
              ...prev,
              metadata: {
                ...prev.metadata,
                ...intrinsicMetadata,
              },
              loading: false,
            }
          : prev
      ))
    })
  }, [])

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

  const handleRenameProfile = useCallback((profileId, name) => {
    const nextName = String(name || '').trim()
    if (!nextName) return

    setProfiles(prev => {
      const targetProfile = prev.find(item => item.id === profileId)
      if (!targetProfile) return prev

      const existingProfiles = prev.filter(item => item.id !== profileId)
      const uniqueName = getUniqueProfileName(nextName, existingProfiles)
      const now = Date.now()

      return prev.map(item => (
        item.id === profileId
          ? {
              ...item,
              name: uniqueName,
              updatedAt: now,
            }
          : item
      ))
    })
  }, [])

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
    } else {
      setFrameRange({ ...DEFAULT_FRAME_RANGE })
    }
  }, [])

  const handleVideoDone = useCallback((jobId) => {
    setResultJobId(jobId)
  }, [])

  useEffect(() => {
    setVideoDockTarget(videoDockRef.current)
  }, [mediaMode])

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
  const imagePreviewWrapperRef = useRef(null)
  const previewRef = useRef(null)
  const tempCanvasRef = useRef(document.createElement('canvas'))
  const regionDragRef = useRef(null)

  useEffect(() => {
    if (mediaMode !== 'image' || !imageData) return undefined

    const wrapper = imagePreviewWrapperRef.current
    if (!wrapper) return undefined

    const updateSize = () => {
      const style = window.getComputedStyle(wrapper)
      const paddingX = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight)
      const paddingY = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom)
      const w = Math.max(0, wrapper.clientWidth - paddingX)
      const h = Math.max(0, wrapper.clientHeight - paddingY)
      setImagePreviewContainerSize(prev => (
        prev.w === w && prev.h === h ? prev : { w, h }
      ))
    }

    updateSize()
    const observer = new ResizeObserver(updateSize)
    observer.observe(wrapper)
    return () => observer.disconnect()
  }, [imageData, mediaMode])

  const getCanvasPoint = useCallback((event) => {
    const canvas = previewRef.current
    if (!canvas) return null

    const rect = canvas.getBoundingClientRect()
    if (!rect.width || !rect.height) return null

    return {
      x: clamp((event.clientX - rect.left) * (canvas.width / rect.width), 0, canvas.width),
      y: clamp((event.clientY - rect.top) * (canvas.height / rect.height), 0, canvas.height),
    }
  }, [])

  const beginImageRegionSelection = useCallback(() => {
    if (!imageData) return

    setMediaMode('image')
    setPreviewMode('keying')
    setImageRegion(null)
    setRegionDraft(null)
    setRegionSelectionMode(true)

    window.requestAnimationFrame(() => {
      previewRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    })
  }, [imageData])

  const handleRegionPointerDown = useCallback((event) => {
    if (!canSelectImageRegion) return

    const point = getCanvasPoint(event)
    if (!point) return

    event.preventDefault()
    event.currentTarget.setPointerCapture?.(event.pointerId)
    regionDragRef.current = {
      origin: point,
      pointerId: event.pointerId,
    }
    setRegionDraft({ x: point.x, y: point.y, width: 0, height: 0 })
  }, [canSelectImageRegion, getCanvasPoint])

  const handleRegionPointerMove = useCallback((event) => {
    if (!canSelectImageRegion || !regionDragRef.current) return

    const point = getCanvasPoint(event)
    if (!point) return

    event.preventDefault()
    setRegionDraft(makeRegionFromPoints(regionDragRef.current.origin, point, imageData))
  }, [canSelectImageRegion, getCanvasPoint, imageData])

  const handleRegionPointerUp = useCallback((event) => {
    if (!canSelectImageRegion || !regionDragRef.current) return

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
    const nextRegion = makeRegionFromPoints(drag.origin, point, imageData)
    setRegionDraft(null)

    if (!nextRegion || nextRegion.width < 4 || nextRegion.height < 4) return

    setImageRegion(nextRegion)
    setRegionSelectionMode(false)
  }, [canSelectImageRegion, getCanvasPoint, imageData])

  const handleRegionPointerCancel = useCallback((event) => {
    if (regionDragRef.current?.pointerId === event.pointerId) {
      regionDragRef.current = null
      setRegionDraft(null)
    }
  }, [])

  const resetImageRegion = useCallback(() => {
    regionDragRef.current = null
    setImageRegion(null)
    setRegionDraft(null)
    setRegionSelectionMode(false)
  }, [])

  const renderPreview = useCallback(() => {
    if (!processingImageData) return
    const canvas = previewRef.current
    if (!canvas) return

    // 抠像
    let keyed = applyKeying(processingImageData, keyingParams)

    if (previewMode === 'keying') {
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
      composeToCanvas(ctx, keyed, layoutParams, tempCanvasRef.current, keyingParams.keyColor)
    }
  }, [processingImageData, keyingParams, layoutParams, previewMode])

  useEffect(() => {
    renderPreview()
  }, [renderPreview, mediaMode])

  // ===== 文件加载 =====
  const handleFileLoad = useCallback((file) => {
    const kind = getMediaKind(file)
    if (kind !== 'image') return

    const sourceFile = normalizeMediaFile(file, kind)
    if (!sourceFile) return
    setImageFile(sourceFile)
    setImageRegion(null)
    setRegionSelectionMode(false)
    setRegionDraft(null)
    const img = new Image()
    const url = URL.createObjectURL(sourceFile)
    img.onload = () => {
      const canvas = document.createElement('canvas')
      canvas.width = img.width
      canvas.height = img.height
      const ctx = canvas.getContext('2d')
      ctx.drawImage(img, 0, 0)
      const data = ctx.getImageData(0, 0, img.width, img.height)
      setImageData(data)
      setImageSize({ w: img.width, h: img.height })
      URL.revokeObjectURL(url)
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
    }
    img.src = url
  }, [])

  const handleCancelClipboardImport = useCallback(() => {
    clipboardImportRequestRef.current += 1
    setClipboardImport(null)
  }, [])

  const handleConfirmClipboardImport = useCallback(() => {
    const file = clipboardImport?.file
    const kind = getMediaKind(file)
    if (!file || !kind) return

    setClipboardImport(null)

    if (kind === 'image') {
      switchMode('image')
      handleFileLoad(file)
      return
    }

    if (kind === 'video') {
      switchMode('video')
      setDroppedVideoFile(file)
    }
  }, [clipboardImport, handleFileLoad, switchMode])

  // ===== 全局粘贴事件（检测剪切板图片/视频后先确认）=====
  useEffect(() => {
    const onPaste = (event) => {
      const file = getClipboardMediaFile(event.clipboardData)
      if (!file) return

      event.preventDefault()
      event.stopPropagation()
      openClipboardImportPrompt(file)
    }

    document.addEventListener('paste', onPaste)
    return () => {
      document.removeEventListener('paste', onPaste)
    }
  }, [openClipboardImportPrompt])

  useEffect(() => {
    if (!clipboardImport) return undefined

    const onKeyDown = (event) => {
      if (event.key === 'Escape') {
        handleCancelClipboardImport()
      }
    }

    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [clipboardImport, handleCancelClipboardImport])

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

      const droppedFile = event.dataTransfer?.files?.[0]
      const kind = getMediaKind(droppedFile)
      const file = normalizeMediaFile(droppedFile, kind)
      if (!file || !kind) return

      if (kind === 'image') {
        switchMode('image')
        handleFileLoad(file)
      } else if (kind === 'video') {
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
  }, [handleFileLoad, switchMode])

  // ===== 导出 =====
  const handleExport = async (mode) => {
    if (!processingImageData) return
    setExporting(true)
    try {
      const formData = new FormData()
      // 从当前处理输入重建图片文件
      const canvas = document.createElement('canvas')
      canvas.width = processingImageData.width
      canvas.height = processingImageData.height
      putImageDataLike(canvas.getContext('2d'), processingImageData)
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
          onRename={handleRenameProfile}
          onDelete={handleDeleteProfile}
        />
      </header>

      <main className="main">
        <aside className="sidebar">
          <div className="sidebar-scroll">
            <FileMetaPanel
              mediaMode={mediaMode}
              imageFile={imageFile}
              imageSize={imageSize}
              imageRegion={imageRegion}
              regionSelectionMode={regionSelectionMode}
              onSelectImageRegion={beginImageRegionSelection}
              onResetImageRegion={resetImageRegion}
              videoFile={videoFile}
              videoInfo={videoInfo}
            />
            {mediaMode === 'video' && (
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
                dockTarget={videoDockTarget}
              />
            )}
            <KeyingPanel params={keyingParams} onChange={setKeyingParams} />
            <LayoutPanel params={layoutParams} onChange={setLayoutParams} imageSize={processingImageSize} />
          </div>

          <div className="sidebar-dock">
            <p className="dock-label">导出操作</p>
            {mediaMode === 'image' ? (
              <div className="dock-actions">
                {!imageData && (
                  <p className="dock-hint">拖入或粘贴图片后可导出当前参数下的结果</p>
                )}
                <button
                  className="dock-btn dock-btn-primary"
                  onClick={() => handleExport('greenscreen')}
                  disabled={!processingImageData || exporting}
                >{exporting ? '导出中...' : '💾 导出绿幕合成图'}</button>
                <button
                  className="dock-btn dock-btn-secondary"
                  onClick={() => handleExport('transparent')}
                  disabled={!processingImageData || exporting}
                >{exporting ? '导出中...' : '💾 导出透明 PNG'}</button>
              </div>
            ) : (
              <div ref={videoDockRef} className="dock-portal-target" />
            )}
          </div>
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
            <button
              className={`tab ${previewMode === 'keying' ? 'active' : ''}`}
              onClick={() => setPreviewMode('keying')}
            >抠像预览</button>
            <button
              className={`tab ${previewMode === 'composite' ? 'active' : ''}`}
              onClick={() => setPreviewMode('composite')}
            >合成预览</button>
          </div>
          <div className="canvas-wrapper" ref={imagePreviewWrapperRef}>
            {mediaMode === 'image' ? (
              imageData ? (
                <div
                  className={`preview-stage ${canSelectImageRegion ? 'selecting' : ''}`}
                  style={imagePreviewStageStyle}
                >
                  <canvas
                    ref={previewRef}
                    className="preview-canvas"
                    onPointerDown={handleRegionPointerDown}
                    onPointerMove={handleRegionPointerMove}
                    onPointerUp={handleRegionPointerUp}
                    onPointerCancel={handleRegionPointerCancel}
                  />
                  {canSelectImageRegion && regionDraft && (
                    <div
                      className="region-selection-box"
                      style={getRegionOverlayStyle(regionDraft, processingImageData)}
                    />
                  )}
                </div>
              ) : (
                <PreviewCanvas />
              )
            ) : (
              <VideoPreview
                videoFile={videoFile}
                videoInfo={videoInfo}
                keyingParams={keyingParams}
                layoutParams={layoutParams}
                previewMode={previewMode}
                resultJobId={resultJobId}
                range={frameRange}
                onRangeChange={handleRangeChange}
              />
            )}
          </div>
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
      {clipboardImport && (
        <ClipboardImportDialog
          importItem={clipboardImport}
          onCancel={handleCancelClipboardImport}
          onConfirm={handleConfirmClipboardImport}
        />
      )}
    </div>
  )
}

function ClipboardImportDialog({ importItem, onCancel, onConfirm }) {
  const { metadata, loading } = importItem
  const isImage = metadata.kind === 'image'
  const kindLabel = isImage ? '图片' : '视频'
  const dimensionLabel = metadata.width && metadata.height
    ? `${metadata.width} × ${metadata.height}`
    : loading ? '读取中...' : '未知'
  const durationLabel = metadata.duration
    ? formatDuration(metadata.duration)
    : loading ? '读取中...' : '未知'
  const dateLabel = metadata.lastModified
    ? new Intl.DateTimeFormat('zh-CN', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      }).format(new Date(metadata.lastModified))
    : '未知'

  return (
    <div className="clipboard-modal-backdrop" onClick={onCancel}>
      <div
        className="clipboard-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="clipboard-import-title"
        onClick={event => event.stopPropagation()}
      >
        <div className="clipboard-modal-header">
          <span className="clipboard-modal-icon" aria-hidden="true">{isImage ? '🖼️' : '🎬'}</span>
          <div>
            <h2 id="clipboard-import-title">从剪切板导入素材？</h2>
            <p>检测到剪切板包含{kindLabel}内容，确认后会替换当前{kindLabel}素材。</p>
          </div>
        </div>

        <dl className="clipboard-meta-grid">
          <dt>内容类型</dt>
          <dd>{kindLabel}</dd>
          <dt>文件名</dt>
          <dd title={metadata.name}>{metadata.name}</dd>
          <dt>MIME</dt>
          <dd>{metadata.mimeType}</dd>
          <dt>大小</dt>
          <dd>{formatBytes(metadata.size)}</dd>
          <dt>尺寸</dt>
          <dd>{dimensionLabel}</dd>
          {!isImage && (
            <>
              <dt>时长</dt>
              <dd>{durationLabel}</dd>
            </>
          )}
          <dt>修改时间</dt>
          <dd>{dateLabel}</dd>
        </dl>

        <div className="clipboard-modal-actions">
          <button type="button" className="clipboard-btn secondary" onClick={onCancel}>取消</button>
          <button type="button" className="clipboard-btn primary" onClick={onConfirm}>导入</button>
        </div>
      </div>
    </div>
  )
}

function FileMetaPanel({
  mediaMode,
  imageFile,
  imageSize,
  imageRegion,
  regionSelectionMode,
  onSelectImageRegion,
  onResetImageRegion,
  videoFile,
  videoInfo,
}) {
  const isImage = mediaMode === 'image'
  const file = isImage ? imageFile : videoFile
  const loaded = isImage ? imageSize.w > 0 : !!videoInfo
  const summary = loaded
    ? (isImage ? `${imageSize.w}×${imageSize.h}` : `${videoInfo.width}×${videoInfo.height}`)
    : '未载入'

  return (
    <CollapsiblePanel
      title="📄 当前素材"
      summary={summary}
      defaultCollapsed
      className="file-meta-panel"
    >
      {loaded && file ? (
        <div className="file-meta-content">
          <p className="file-meta-name" title={file.name}>{file.name}</p>
          <div className="file-meta-grid">
            <span>类型</span>
            <strong>{isImage ? '图片' : '视频'}</strong>
            <span>大小</span>
            <strong>{formatBytes(file.size)}</strong>
            {isImage ? (
              <>
                <span>尺寸</span>
                <strong>{imageSize.w} × {imageSize.h}</strong>
              </>
            ) : (
              <>
                <span>尺寸</span>
                <strong>{videoInfo.width} × {videoInfo.height}</strong>
                <span>时长</span>
                <strong>{formatDuration(videoInfo.duration)}</strong>
                <span>帧率</span>
                <strong>{videoInfo.fps} fps</strong>
                <span>音轨</span>
                <strong>{videoInfo.hasAudio ? '有' : '无'}</strong>
              </>
            )}
          </div>
          {isImage && (
            <div className="file-region-tools">
              <div className="file-region-status">
                <span>处理区域</span>
                <strong>
                  {imageRegion
                    ? `${imageRegion.width} × ${imageRegion.height} @ ${imageRegion.x}, ${imageRegion.y}`
                    : '整张图片'}
                </strong>
              </div>
              <div className="file-region-actions">
                <button
                  type="button"
                  className="file-region-btn secondary"
                  onClick={onResetImageRegion}
                  disabled={!imageRegion && !regionSelectionMode}
                >
                  复位
                </button>
                <button
                  type="button"
                  className="file-region-btn"
                  onClick={onSelectImageRegion}
                >
                  {regionSelectionMode
                    ? '重新框选处理区域'
                    : imageRegion ? '重新设定处理区域' : '设定处理区域'}
                </button>
              </div>
            </div>
          )}
        </div>
      ) : (
        <div className="file-meta-empty">
          <p>{isImage ? '暂无图片素材' : '暂无视频素材'}</p>
          <p className="hint">把图片或视频拖到窗口任意位置，或直接粘贴即可载入</p>
        </div>
      )}
    </CollapsiblePanel>
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
