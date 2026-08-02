import React, { useState, useRef, useCallback, useEffect, useMemo } from 'react'
import {
  Download,
  Eye,
  FolderInput,
  Image as ImageIcon,
  Layers3,
  Moon,
  Sun,
  Upload,
  Video,
} from 'lucide-react'
import { applyKeying, composeToCanvas, autoCropKeyed } from './lib/keying.js'
import { clamp, cropImageData, getRegionOverlayStyle, makeRegionFromPoints } from './lib/region.js'
import KeyingPanel from './components/KeyingPanel.jsx'
import LayoutPanel from './components/LayoutPanel.jsx'
import PreviewCanvas from './components/PreviewCanvas.jsx'
import VideoPanel from './components/VideoPanel.jsx'
import VideoPreview from './components/VideoPreview.jsx'
import ProfileMenu from './components/ProfileMenu.jsx'
import StudioPanel from './components/StudioPanel.jsx'
import ActionClipReviewPanel from './components/ActionClipReviewPanel.jsx'
import WorkspaceSidebar from './components/WorkspaceSidebar.jsx'
import ClipboardImportDialog from './components/ClipboardImportDialog.jsx'
import FileMetaPanel from './components/FileMetaPanel.jsx'
import { useAppDialog } from './components/AppDialog.jsx'
import { ControlGrid, TextField } from './components/ControlKit.jsx'
import { t } from './i18n.js'

import {
  DEFAULT_FRAME_RANGE,
  getProfileParams,
  getUniqueProfileName,
  loadProfileState,
  makeProfile,
  resolveFrameRangeForVideo,
  saveParams,
  saveProfileState,
  sortProfilesByUsage,
} from './lib/appProfiles.js'
import { getBaseMediaMetadata, getClipboardMediaFile, getMediaKind, normalizeMediaFile } from './lib/mediaFiles.js'
import { captureVideoFirstFrame, getContainSize, measureSourceCharacterHeight, putImageDataLike, readMediaIntrinsicMetadata } from './lib/mediaCanvas.js'
import { applyTheme, getInitialTheme, storeTheme } from './lib/theme.js'

const MOBILE_SHEET_STEPS = ['collapsed', 'half', 'full']
const MOBILE_UI_QUERY = '(max-width: 900px)'

export default function App() {
  const dialog = useAppDialog()
  const [theme, setTheme] = useState(getInitialTheme)
  const [mobileUi, setMobileUi] = useState(() => (
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia(MOBILE_UI_QUERY).matches
      : false
  ))

  useEffect(() => {
    applyTheme(theme)
  }, [theme])

  const toggleTheme = useCallback(() => {
    setTheme(current => {
      const nextTheme = current === 'dark' ? 'light' : 'dark'
      storeTheme(nextTheme)
      return nextTheme
    })
  }, [])

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return undefined
    const query = window.matchMedia(MOBILE_UI_QUERY)
    const update = () => setMobileUi(query.matches)
    update()
    query.addEventListener?.('change', update)
    return () => query.removeEventListener?.('change', update)
  }, [])
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
  const [imageGodotExporting, setImageGodotExporting] = useState(false)
  const [imageGodotExport, setImageGodotExport] = useState(null)
  const [imageGodotError, setImageGodotError] = useState('')
  const [mediaMode, setMediaMode] = useState('image')  // 'image' | 'video'
  // Mobile: keep the preview visible while settings use a three-stage bottom sheet.
  const [mobileSheetState, setMobileSheetState] = useState('half')
  const [mobileSheetDragging, setMobileSheetDragging] = useState(false)
  const [activeTool, setActiveTool] = useState('keying')
  const appRef = useRef(null)
  const mobileSheetRef = useRef(null)
  const mobileSheetDragRef = useRef(null)
  const mobileSheetClickSuppressedRef = useRef(false)
  const [videoDockTarget, setVideoDockTarget] = useState(null)
  const [mobilePreviewToolsTarget, setMobilePreviewToolsTarget] = useState(null)
  const videoDockRef = useRef(null)
  const mobilePreviewToolsRef = useRef(null)
  const fileInputRef = useRef(null)
  const [clipboardImport, setClipboardImport] = useState(null)
  const clipboardImportRequestRef = useRef(0)

  // 视频预览状态
  const [videoFile, setVideoFile] = useState(null)
  const [videoInfo, setVideoInfo] = useState(null)
  const [videoRegion, setVideoRegion] = useState(null)
  const [resultJobId, setResultJobId] = useState(null)
  const [resultVideoFormat, setResultVideoFormat] = useState(null)

  // 全局拖放状态
  const [dragOver, setDragOver] = useState(false)
  const [droppedVideoFiles, setDroppedVideoFiles] = useState(null)
  const [reviewContext, setReviewContext] = useState(null) // { projectId, assetId, sourceLabel }
  const [reviewClips, setReviewClips] = useState([])
  const [reviewMarkers, setReviewMarkers] = useState([])
  const [selectedReviewClipIds, setSelectedReviewClipIds] = useState([])
  const [previewFrame, setPreviewFrame] = useState(null)
  const [markerSeekRequest, setMarkerSeekRequest] = useState(null)

  const handleMarkerSeek = useCallback((frame) => {
    setMarkerSeekRequest({ frame, nonce: Date.now() })
  }, [])
  const pendingProjectVideoRef = useRef(null)

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
  const videoProcessingSize = videoInfo
    ? videoRegion
      ? { w: videoRegion.width, h: videoRegion.height }
      : { w: videoInfo.width, h: videoInfo.height }
    : { w: 0, h: 0 }
  const layoutInputSize = mediaMode === 'video' ? videoProcessingSize : processingImageSize

  // 切换模式时保留另一边状态，避免 Tab 来回切换导致预览丢失
  const switchMode = useCallback((mode) => {
    setMediaMode(mode)
    setActiveTool('keying')
    setRegionSelectionMode(false)
    setRegionDraft(null)
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

  const handleDeleteProfile = useCallback(async (profileId) => {
    const profile = profiles.find(item => item.id === profileId)
    if (!profile) return

    if (profiles.length <= 1) {
      await dialog.alert(t('profile.keepOne'), { title: t('profile.label'), tone: 'warning' })
      return
    }

    if (!await dialog.confirm(t('profile.deleteConfirm', { name: profile.name }), {
      title: t('profile.deleteLabel', { name: profile.name }),
      tone: 'danger',
    })) return

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
  }, [activeProfileId, dialog, profiles, videoInfo])

  const handleVideoUpload = useCallback((file, info) => {
    setVideoFile(file)
    setVideoInfo(info)
    setVideoRegion(null)
    setRegionSelectionMode(false)
    setRegionDraft(null)
    setResultJobId(null)
    setResultVideoFormat(null)
    const isPendingProjectVideo = Boolean(file && pendingProjectVideoRef.current === file)
    pendingProjectVideoRef.current = null
    if (!isPendingProjectVideo) {
      setReviewContext(null)
      setReviewClips([])
      setReviewMarkers([])
      setSelectedReviewClipIds([])
    }
    // 新视频上传后重置帧范围为全视频
    if (info) {
      const totalFrames = info.frameCount || Math.round(info.fps * info.duration)
      setFrameRange({ startFrame: 0, endFrame: totalFrames })
    } else {
      setFrameRange({ ...DEFAULT_FRAME_RANGE })
    }
  }, [])

  const handleOpenProjectVideo = useCallback((payload) => {
    const file = payload?.file || payload
    if (!file) return
    const nextContext = payload?.projectId && payload?.assetId
      ? {
          projectId: payload.projectId,
          assetId: payload.assetId,
          sourceLabel: payload.asset?.originalName || file.name || '',
        }
      : null
    setReviewContext(nextContext)
    setReviewClips([])
    setReviewMarkers([])
    setSelectedReviewClipIds([])
    pendingProjectVideoRef.current = nextContext ? file : null
    switchMode('video')
    setPreviewMode('keying')
    setMobileSheetState('collapsed')
    setDroppedVideoFiles([file])
  }, [switchMode])

  const handleApplyReviewClipRange = useCallback((clip) => {
    if (!clip) return
    setFrameRange({
      startFrame: Math.max(0, Number(clip.startFrame) || 0),
      endFrame: Math.max(0, Number(clip.endFrame) || 0),
    })
  }, [])

  useEffect(() => {
    setVideoDockTarget(videoDockRef.current)
    setMobilePreviewToolsTarget(mobilePreviewToolsRef.current)
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
    if (previewMode !== 'keying' && regionSelectionMode) {
      regionDragRef.current = null
      setRegionDraft(null)
      setRegionSelectionMode(false)
    }
  }, [previewMode, regionSelectionMode])

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
    setMobileSheetState('collapsed')
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

  const beginVideoRegionSelection = useCallback(() => {
    if (!videoInfo) return

    setMediaMode('video')
    setPreviewMode('keying')
    setMobileSheetState('collapsed')
    setResultJobId(null)
    setResultVideoFormat(null)
    setVideoRegion(null)
    setRegionDraft(null)
    setRegionSelectionMode(true)

    window.requestAnimationFrame(() => {
      document.querySelector('.frame-canvas-wrapper')?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    })
  }, [videoInfo])

  const resetVideoRegion = useCallback(() => {
    setVideoRegion(null)
    setRegionDraft(null)
    setRegionSelectionMode(false)
    setResultJobId(null)
    setResultVideoFormat(null)
  }, [])

  const handleAutoDetectSourceCharacterHeight = useCallback(async () => {
    if (mediaMode !== 'video' || !videoFile) return

    try {
      // 始终基于真实视频首帧测量，不读取 frameRange.startFrame / 当前预览帧。
      const firstFrame = await captureVideoFirstFrame(videoFile)
      const height = measureSourceCharacterHeight(firstFrame, keyingParams, videoRegion)

      if (height <= 0) {
        await dialog.alert(t('layout.autoDetectHeightNoForeground'), { title: t('layout.sourceCharacterHeight'), tone: 'warning' })
        return
      }
      setLayoutParams(prev => ({ ...prev, sourceCharacterHeight: height }))
    } catch (err) {
      await dialog.alert(`${t('layout.autoDetectHeightFailed')}: ${err.message}`, { title: t('layout.sourceCharacterHeight'), tone: 'danger' })
    }
  }, [dialog, keyingParams, mediaMode, videoFile, videoRegion])

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
    setImageGodotExport(null)
    setImageGodotError('')
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

  const handleMediaFiles = useCallback((rawFiles) => {
    const videos = []
    const images = []

    for (const raw of Array.from(rawFiles || [])) {
      const kind = getMediaKind(raw)
      const file = normalizeMediaFile(raw, kind)
      if (!file || !kind) continue
      if (kind === 'video') videos.push(file)
      else if (kind === 'image') images.push(file)
    }

    if (videos.length > 0) {
      switchMode('video')
      setDroppedVideoFiles(videos)
      setMobileSheetState('collapsed')
      return
    }

    if (images.length > 0) {
      switchMode('image')
      handleFileLoad(images[0])
      setMobileSheetState('collapsed')
    }
  }, [handleFileLoad, switchMode])

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
      setDroppedVideoFiles([file])
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

      handleMediaFiles(event.dataTransfer?.files)
    }

    document.addEventListener('dragover', onDragOver)
    document.addEventListener('dragleave', onDragLeave)
    document.addEventListener('drop', onDrop)
    return () => {
      document.removeEventListener('dragover', onDragOver)
      document.removeEventListener('dragleave', onDragLeave)
      document.removeEventListener('drop', onDrop)
    }
  }, [handleMediaFiles])

  // ===== 导出 =====
  const handleExportGodotPose = async () => {
    if (!imageFile) return
    setImageGodotExporting(true)
    setImageGodotError('')
    setImageGodotExport(null)

    try {
      const formData = new FormData()
      formData.append('image', imageFile, imageFile.name || 'pose.png')
      formData.append('params', JSON.stringify({
        keying: keyingParams,
        layout: layoutParams,
        cleanup: {},
        region: imageRegion,
        mode: 'transparent',
      }))
      formData.append('godot', JSON.stringify({
        ...videoParams.godotParams,
        frameWidth: 256,
        frameHeight: 256,
        safeAreaWidth: 160,
        safeAreaHeight: 160,
      }))

      const response = await fetch('/api/export-godot-pose', {
        method: 'POST',
        body: formData,
      })
      if (!response.ok) {
        const error = await response.json().catch(() => ({}))
        throw new Error(error.error || t('app.godotPoseExportFailed'))
      }
      setImageGodotExport(await response.json())
    } catch (error) {
      setImageGodotError(error.message)
    } finally {
      setImageGodotExporting(false)
    }
  }

  const handleDownloadGodotPose = async (artifact = 'bundle') => {
    if (!imageGodotExport?.exportId || !imageGodotExport.artifacts?.[artifact]) return
    try {
      const response = await fetch(`/api/godot-pose-artifact/${imageGodotExport.exportId}/${artifact}`)
      if (!response.ok) throw new Error(t('app.godotPoseDownloadFailed'))
      const blob = await response.blob()
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = imageGodotExport.artifacts[artifact].filename
      anchor.click()
      setTimeout(() => URL.revokeObjectURL(url), 10_000)
    } catch (error) {
      setImageGodotError(error.message)
    }
  }

  const updateImageGodotParam = (field, value) => {
    setVideoParams(prev => ({
      ...prev,
      godotParams: {
        ...prev.godotParams,
        [field]: value,
      },
    }))
  }

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
      if (!resp.ok) throw new Error(t('app.exportFailed'))
      const resultBlob = await resp.blob()
      const url = URL.createObjectURL(resultBlob)
      const a = document.createElement('a')
      a.href = url
      a.download = `export_${mode}_${Date.now()}.png`
      a.click()
      URL.revokeObjectURL(url)
    } catch (err) {
      await dialog.alert(`${t('app.exportFailed')}: ${err.message}`, { title: t('app.exportActions'), tone: 'danger' })
    } finally {
      setExporting(false)
    }
  }

  const currentAssetName = mediaMode === 'video' ? videoFile?.name : imageFile?.name
  const openFilePicker = () => fileInputRef.current?.click()

  const handleWorkspaceToolChange = useCallback((tool) => {
    setActiveTool(tool)
    setMobileSheetState((state) => state === 'collapsed' ? 'half' : state)
  }, [])

  const handleMobileSheetPointerDown = useCallback((event) => {
    const sheet = mobileSheetRef.current
    const app = appRef.current
    if (!sheet || !app || event.button > 0) return

    const containerHeight = sheet.parentElement?.getBoundingClientRect().height || window.innerHeight
    mobileSheetDragRef.current = {
      pointerId: event.pointerId,
      startY: event.clientY,
      startHeight: sheet.getBoundingClientRect().height,
      containerHeight,
      startState: mobileSheetState,
    }
    mobileSheetClickSuppressedRef.current = false
    app.style.setProperty('--mobile-sheet-drag-height', `${sheet.getBoundingClientRect().height}px`)
    setMobileSheetDragging(true)
    event.currentTarget.setPointerCapture?.(event.pointerId)
    event.preventDefault()
  }, [mobileSheetState])

  const handleMobileSheetPointerMove = useCallback((event) => {
    const drag = mobileSheetDragRef.current
    const app = appRef.current
    if (!drag || drag.pointerId !== event.pointerId || !app) return

    const minHeight = Math.min(86, drag.containerHeight)
    const maxHeight = Math.max(minHeight, drag.containerHeight - 8)
    const nextHeight = Math.max(
      minHeight,
      Math.min(maxHeight, drag.startHeight - (event.clientY - drag.startY)),
    )
    app.style.setProperty('--mobile-sheet-drag-height', `${Math.round(nextHeight)}px`)
    event.preventDefault()
  }, [])

  const finishMobileSheetDrag = useCallback((event) => {
    const drag = mobileSheetDragRef.current
    const app = appRef.current
    const sheet = mobileSheetRef.current
    if (!drag || drag.pointerId !== event.pointerId) return

    const deltaY = event.clientY - drag.startY
    const currentHeight = sheet?.getBoundingClientRect().height || drag.startHeight
    const currentIndex = MOBILE_SHEET_STEPS.indexOf(drag.startState)
    let nextIndex = currentIndex

    if (Math.abs(deltaY) >= 48) {
      nextIndex = Math.max(0, Math.min(MOBILE_SHEET_STEPS.length - 1, currentIndex + (deltaY < 0 ? 1 : -1)))
    } else {
      const ratio = currentHeight / Math.max(1, drag.containerHeight)
      nextIndex = ratio < 0.28 ? 0 : ratio > 0.72 ? 2 : 1
    }

    setMobileSheetState(MOBILE_SHEET_STEPS[nextIndex])
    mobileSheetClickSuppressedRef.current = Math.abs(deltaY) > 8
    setMobileSheetDragging(false)
    mobileSheetDragRef.current = null
    app?.style.removeProperty('--mobile-sheet-drag-height')
    event.currentTarget.releasePointerCapture?.(event.pointerId)
  }, [])

  const handleMobileSheetHandleClick = useCallback(() => {
    if (mobileSheetClickSuppressedRef.current) {
      mobileSheetClickSuppressedRef.current = false
      return
    }
    setMobileSheetState((state) => {
      const currentIndex = MOBILE_SHEET_STEPS.indexOf(state)
      return MOBILE_SHEET_STEPS[(Math.max(0, currentIndex) + 1) % MOBILE_SHEET_STEPS.length]
    })
  }, [])

  useEffect(() => {
    if (!mobileSheetDragging) return undefined

    document.addEventListener('pointermove', handleMobileSheetPointerMove, { passive: false })
    document.addEventListener('pointerup', finishMobileSheetDrag)
    document.addEventListener('pointercancel', finishMobileSheetDrag)
    return () => {
      document.removeEventListener('pointermove', handleMobileSheetPointerMove)
      document.removeEventListener('pointerup', finishMobileSheetDrag)
      document.removeEventListener('pointercancel', finishMobileSheetDrag)
    }
  }, [finishMobileSheetDrag, handleMobileSheetPointerMove, mobileSheetDragging])

  return (
    <div
      ref={appRef}
      className={`app mobile-sheet-${mobileSheetState} ${mobileSheetDragging ? 'mobile-sheet-dragging' : ''}`}
    >
      <header className="header">
        <div className="header-brand">
          <ProfileMenu
            profiles={profiles}
            activeProfileId={activeProfileId}
            onSelect={handleSelectProfile}
            onCreate={handleCreateProfile}
            onRename={handleRenameProfile}
            onDelete={handleDeleteProfile}
          />
          <div className="header-copy">
            <h1>{t('app.title')}</h1>
            <p title={currentAssetName || t('app.noAsset')}>
              {currentAssetName || t('app.noAsset')}
            </p>
          </div>
        </div>
        <div className="header-actions">
          <StudioPanel onOpenVideoAsset={handleOpenProjectVideo} />
          <button
            type="button"
            className="theme-toggle"
            onClick={toggleTheme}
            aria-label={theme === 'dark' ? t('app.switchToLightMode') : t('app.switchToDarkMode')}
            title={theme === 'dark' ? t('app.switchToLightMode') : t('app.switchToDarkMode')}
          >
            {theme === 'dark'
              ? <Sun size={16} aria-hidden="true" />
              : <Moon size={16} aria-hidden="true" />}
          </button>
          <button type="button" className="header-import-btn" onClick={openFilePicker} aria-label={t('app.importAsset')}>
            <Upload size={16} aria-hidden="true" />
            <span>{t('app.importAsset')}</span>
          </button>
        </div>
      </header>

      <input
        ref={fileInputRef}
        className="visually-hidden"
        type="file"
        accept="image/*,video/*,.mov,.mkv,.avi"
        multiple
        onChange={(event) => {
          handleMediaFiles(event.target.files)
          event.target.value = ''
        }}
      />

      <main className="main">
        <WorkspaceSidebar
          sheetRef={mobileSheetRef}
          activeTool={activeTool}
          mediaMode={mediaMode}
          mobileSheetState={mobileSheetState}
          mobileSheetDragging={mobileSheetDragging}
          onMobileSheetStateChange={setMobileSheetState}
          onMobileSheetPointerDown={handleMobileSheetPointerDown}
          onMobileSheetPointerMove={handleMobileSheetPointerMove}
          onMobileSheetPointerUp={finishMobileSheetDrag}
          onMobileSheetHandleClick={handleMobileSheetHandleClick}
          onToolChange={handleWorkspaceToolChange}
        >
          <section
            className="workspace-panel workspace-panel-review"
            hidden={activeTool !== 'review'}
            aria-label={t('app.workspaceReview')}
          >
            {mediaMode === 'video' && (
                <ActionClipReviewPanel
                  mobile={mobileUi}
                  projectId={reviewContext?.projectId || ''}
                  assetId={reviewContext?.assetId || ''}
                  sourceLabel={reviewContext?.sourceLabel || videoFile?.name || ''}
                  range={frameRange}
                  totalFrames={videoInfo?.frameCount || Math.round((videoInfo?.fps || 0) * (videoInfo?.duration || 0)) || 0}
                  selectedClipIds={selectedReviewClipIds}
                  onSelectionChange={setSelectedReviewClipIds}
                  onClipsChange={setReviewClips}
                  onMarkersChange={setReviewMarkers}
                  onApplyClipRange={handleApplyReviewClipRange}
                  videoJobId={videoInfo?.jobId || ''}
                  keyingParams={keyingParams}
                  layoutParams={layoutParams}
                  region={videoRegion}
                  previewFrame={previewFrame}
                  onSeekRequest={handleMarkerSeek}
                />
            )}
          </section>

          <section
            className="workspace-panel workspace-panel-keying"
            hidden={activeTool !== 'keying'}
            aria-label={t('app.workspaceKeying')}
          >
            <KeyingPanel mobile={mobileUi} params={keyingParams} onChange={setKeyingParams} />
          </section>

          <section
            className="workspace-panel workspace-panel-layout"
            hidden={activeTool !== 'layout'}
            aria-label={t('app.workspaceLayout')}
          >
              <LayoutPanel
                params={layoutParams}
                onChange={setLayoutParams}
                imageSize={layoutInputSize}
                mobile={mobileUi}
                canAutoDetectSourceCharacterHeight={mediaMode === 'video' && Boolean(videoFile)}
                onAutoDetectSourceCharacterHeight={handleAutoDetectSourceCharacterHeight}
              />
          </section>

          <section
            className="workspace-panel workspace-panel-export"
            hidden={activeTool !== 'export'}
            aria-label={t('app.workspaceExport')}
          >
            <FileMetaPanel
              mobile={mobileUi}
              mediaMode={mediaMode}
              imageFile={imageFile}
              imageSize={imageSize}
              imageRegion={imageRegion}
              videoRegion={videoRegion}
              regionSelectionMode={regionSelectionMode}
              onSelectImageRegion={beginImageRegionSelection}
              onResetImageRegion={resetImageRegion}
              onSelectVideoRegion={beginVideoRegionSelection}
              onResetVideoRegion={resetVideoRegion}
              videoFile={videoFile}
              videoInfo={videoInfo}
            />
            {mediaMode === 'video' && (
              <VideoPanel
                mobile={mobileUi}
                keyingParams={keyingParams}
                layoutParams={layoutParams}
                videoParams={videoParams}
                onVideoParamsChange={setVideoParams}
                onVideoUpload={handleVideoUpload}
                range={frameRange}
                onRangeChange={handleRangeChange}
                region={videoRegion}
                droppedFiles={droppedVideoFiles}
                dockTarget={videoDockTarget}
                reviewProjectId={reviewContext?.projectId || ''}
                reviewAssetId={reviewContext?.assetId || ''}
                reviewClipId={reviewClips.find((clip) => selectedReviewClipIds.some((id) => String(id) === String(clip.id)))?.id || ''}
              />
            )}

            <div className="sidebar-dock workspace-export-actions">
              <p className="dock-label">{t('app.exportActions')}</p>
              {mediaMode === 'image' ? (
                <div className="dock-actions">
                  {!imageData && (
                    <p className="dock-hint">{t('app.imageExportHint')}</p>
                  )}
                  <button
                    className="dock-btn dock-btn-primary"
                    onClick={() => handleExport('greenscreen')}
                    disabled={!processingImageData || exporting}
                  >
                    <Download size={15} aria-hidden="true" />
                    {exporting ? t('app.exporting') : t('app.exportGreenscreen')}
                  </button>
                  <button
                    className="dock-btn dock-btn-secondary"
                    onClick={() => handleExport('transparent')}
                    disabled={!processingImageData || exporting}
                  >
                    <Download size={15} aria-hidden="true" />
                    {exporting ? t('app.exporting') : t('app.exportTransparent')}
                  </button>
                  <details className="image-godot-export" aria-label={t('app.godotPoseTitle')}>
                    <summary>{t('app.godotPoseTitle')}</summary>
                    <div className="image-godot-body">
                      <ControlGrid className="image-godot-fields">
                        <TextField label={t('app.godotPoseCharacter')} value={videoParams.godotParams.characterName} onChange={(value) => updateImageGodotParam('characterName', value)} />
                        <TextField label={t('app.godotPoseAction')} value={videoParams.godotParams.actionName} onChange={(value) => updateImageGodotParam('actionName', value)} />
                        <TextField wide label={t('app.godotPoseAnimation')} value={videoParams.godotParams.animationName} onChange={(value) => updateImageGodotParam('animationName', value)} />
                      </ControlGrid>
                      <button
                        className="dock-btn dock-btn-primary"
                        onClick={handleExportGodotPose}
                        disabled={!imageFile || imageGodotExporting}
                      >{imageGodotExporting ? t('app.exporting') : t('app.exportGodotPose')}</button>
                      {imageGodotError && <p className="image-godot-error">{imageGodotError}</p>}
                      {imageGodotExport && (
                        <div className="image-godot-result">
                          <span>{t('app.godotPoseDone', { name: imageGodotExport.basename })}</span>
                          <div className="image-godot-downloads">
                            <button type="button" onClick={() => handleDownloadGodotPose('bundle')}>{t('app.downloadGodotPoseBundle')}</button>
                            <button type="button" onClick={() => handleDownloadGodotPose('scene')}>{t('app.downloadGodotPoseScene')}</button>
                          </div>
                        </div>
                      )}
                    </div>
                  </details>
                </div>
              ) : (
                <div ref={videoDockRef} className="dock-portal-target" />
              )}
            </div>
          </section>
        </WorkspaceSidebar>

        <section className="preview-area">
          <div className="tab-bar">
            <div className="mode-switcher" aria-label={t('app.mobileNavLabel')}>
              <button
                className={`mode-btn ${mediaMode === 'image' ? 'active' : ''}`}
                onClick={() => switchMode('image')}
                aria-pressed={mediaMode === 'image'}
                aria-label={t('app.image')}
                title={t('app.image')}
              >
                <ImageIcon size={15} aria-hidden="true" />
                <span>{t('app.image')}</span>
              </button>
              <button
                className={`mode-btn ${mediaMode === 'video' ? 'active' : ''}`}
                onClick={() => switchMode('video')}
                aria-pressed={mediaMode === 'video'}
                aria-label={t('app.video')}
                title={t('app.video')}
              >
                <Video size={15} aria-hidden="true" />
                <span>{t('app.video')}</span>
              </button>
            </div>
            <div className="preview-toolbar-end">
              <div className="preview-mode-tabs">
                <button
                  className={`tab ${previewMode === 'keying' ? 'active' : ''}`}
                  onClick={() => setPreviewMode('keying')}
                  aria-pressed={previewMode === 'keying'}
                  aria-label={t('app.keyingPreview')}
                  title={t('app.keyingPreview')}
                >
                  <Eye size={15} aria-hidden="true" />
                  <span>{t('app.keyingPreview')}</span>
                </button>
                <button
                  className={`tab ${previewMode === 'composite' ? 'active' : ''}`}
                  onClick={() => setPreviewMode('composite')}
                  aria-pressed={previewMode === 'composite'}
                  aria-label={t('app.compositePreview')}
                  title={t('app.compositePreview')}
                >
                  <Layers3 size={15} aria-hidden="true" />
                  <span>{t('app.compositePreview')}</span>
                </button>
              </div>
              <div ref={mobilePreviewToolsRef} className="mobile-preview-tools-target" />
            </div>
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
                  <PreviewCanvas onChoose={openFilePicker} />
                )
              ) : (
                <VideoPreview
                  mobile={mobileUi}
                  mobileToolsTarget={mobilePreviewToolsTarget}
                  videoFile={videoFile}
                  videoInfo={videoInfo}
                  keyingParams={keyingParams}
                  layoutParams={layoutParams}
                  previewMode={previewMode}
                  resultJobId={resultJobId}
                  resultFormat={resultVideoFormat}
                  range={frameRange}
                  onRangeChange={handleRangeChange}
                  region={videoRegion}
                  regionSelectionMode={regionSelectionMode && mediaMode === 'video'}
                  onRegionChange={setVideoRegion}
                  onRegionSelectionComplete={() => setRegionSelectionMode(false)}
                  reviewClips={reviewClips}
                  reviewMarkers={reviewMarkers}
                  selectedReviewClipIds={selectedReviewClipIds}
                  onPreviewFrameChange={setPreviewFrame}
                  seekRequest={markerSeekRequest}
                  onChoose={openFilePicker}
                  onSelectReviewClip={(clip, event) => {
                    if (!clip?.id) return
                    const id = String(clip.id)
                    if (event?.shiftKey || event?.metaKey || event?.ctrlKey) {
                      setSelectedReviewClipIds((prev) => {
                        const set = new Set(prev.map(String))
                        if (set.has(id)) set.delete(id)
                        else set.add(id)
                        return [...set]
                      })
                    } else {
                      setSelectedReviewClipIds([id])
                      handleApplyReviewClipRange(clip)
                    }
                  }}
                />
              )}
            </div>
          </section>
        </main>

      {dragOver && (
        <div className="drop-overlay">
          <div className="drop-overlay-content">
            <span className="drop-overlay-icon"><FolderInput size={34} aria-hidden="true" /></span>
            <p className="drop-overlay-text">{t('app.dropText')}</p>
            <p className="drop-overlay-hint">{t('app.dropHint')}</p>
            <p className="drop-overlay-hint">{t('app.dropMultiHint')}</p>
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
