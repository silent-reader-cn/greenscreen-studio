import React, { useState, useRef, useCallback, useEffect, useMemo } from 'react'
import { createPortal } from 'react-dom'
import CollapsiblePanel from './CollapsiblePanel.jsx'
import { formatBytes, t } from '../i18n.js'
import { parseExplicitFrameList } from '../lib/frameSelection.js'
import { shouldHandleDroppedVideo } from '../lib/droppedVideo.js'

const FMT_OPTIONS = [
  { value: 'webm', labelKey: 'videoPanel.transparentWebm', modes: ['transparent'] },
  { value: 'mov', labelKey: 'videoPanel.transparentMov', modes: ['transparent'] },
  { value: 'mp4', labelKey: 'videoPanel.greenscreenMp4', modes: ['greenscreen'] },
  { value: 'gif', labelKey: 'videoPanel.loopGif', modes: ['transparent', 'greenscreen'] },
]

const DEFAULT_SPRITE_PARAMS = {
  frameWidth: 128,
  frameHeight: 128,
  framesPerRow: 8,
  maxFrames: 64,
  sampleEvery: 1,
  selectionMode: 'sample',
  exactFramesText: '',
}

const DEFAULT_GODOT_PARAMS = {
  animationName: 'animation',
  safeAreaWidth: 160,
  safeAreaHeight: 160,
  fps: 12,
  loop: true,
}

const DEFAULT_VIDEO_PARAMS = {
  mode: 'transparent',
  format: 'webm',
  exportMode: 'video',
  spriteParams: DEFAULT_SPRITE_PARAMS,
  godotParams: DEFAULT_GODOT_PARAMS,
}

function isVideoFile(file) {
  const type = String(file?.type || '').toLowerCase()
  return type.startsWith('video/') || /\.(mp4|mov|m4v|webm|avi|mkv)$/i.test(file?.name || '')
}

function normalizeVideoParams(videoParams = {}) {
  const source = videoParams || {}
  return {
    ...DEFAULT_VIDEO_PARAMS,
    ...source,
    spriteParams: {
      ...DEFAULT_SPRITE_PARAMS,
      ...(source.spriteParams || {}),
    },
    godotParams: {
      ...DEFAULT_GODOT_PARAMS,
      ...(source.godotParams || {}),
    },
  }
}

export default function VideoPanel({
  keyingParams,
  layoutParams,
  videoParams,
  onVideoParamsChange,
  onVideoUpload,
  range,
  onRangeChange,
  region,
  droppedFile,
  dockTarget,
}) {
  const safeVideoParams = normalizeVideoParams(videoParams)
  const { mode, format, exportMode, spriteParams, godotParams } = safeVideoParams
  const summary = exportMode === 'spritesheet'
    ? t('videoPanel.spriteSummary', { width: spriteParams.frameWidth, height: spriteParams.frameHeight })
    : exportMode === 'godot'
      ? t('videoPanel.godotSummary', { width: spriteParams.frameWidth, height: spriteParams.frameHeight, name: godotParams.animationName })
      : t('videoPanel.videoSummary', {
          format: format.toUpperCase(),
          mode: mode === 'transparent' ? t('videoPanel.transparent') : t('videoPanel.greenscreen'),
        })

  const [videoInfo, setVideoInfo] = useState(null)       // {jobId, width, height, fps, duration, hasAudio}
  const [uploading, setUploading] = useState(false)
  const [processing, setProcessing] = useState(false)
  const [progress, setProgress] = useState({ current: 0, total: 0, percent: 0 })
  const [status, setStatus] = useState('')               // 'idle'|'uploaded'|'processing'|'done'|'error'
  const [errorMsg, setErrorMsg] = useState('')
  const [downloadUrl, setDownloadUrl] = useState('')
  const [spriteSheetBlob, setSpriteSheetBlob] = useState(null)
  const [godotExport, setGodotExport] = useState(null)
  const [completedExportSignature, setCompletedExportSignature] = useState('')
  const totalFrames = videoInfo?.frameCount || Math.round((videoInfo?.fps || 0) * (videoInfo?.duration || 0))
  const usesExactFrames = spriteParams.selectionMode === 'exact'
  const explicitFrameSelection = useMemo(
    () => parseExplicitFrameList(spriteParams.exactFramesText, totalFrames || Infinity),
    [spriteParams.exactFramesText, totalFrames]
  )
  const exactFramesOutsideRange = usesExactFrames && range
    ? explicitFrameSelection.frames.filter(frame => frame < range.startFrame || frame >= range.endFrame)
    : []
  const explicitFrameError = usesExactFrames
    ? explicitFrameSelection.invalidTokens.length > 0
      ? t('videoPanel.exactFramesInvalid', { values: explicitFrameSelection.invalidTokens.join(', ') })
      : explicitFrameSelection.outOfRangeFrames.length > 0
        ? t('videoPanel.exactFramesOutOfVideo', { values: explicitFrameSelection.outOfRangeFrames.join(', '), max: Math.max(0, totalFrames - 1) })
        : exactFramesOutsideRange.length > 0
          ? t('videoPanel.exactFramesOutOfRange', { values: exactFramesOutsideRange.join(', '), start: range.startFrame, end: range.endFrame - 1 })
          : explicitFrameSelection.frames.length === 0
            ? t('videoPanel.exactFramesRequired')
            : ''
    : ''

  const pollTimerRef = useRef(null)
  const activeJobIdRef = useRef(null)
  const handledDroppedFileRef = useRef(null)

  const exportSignature = useMemo(() => JSON.stringify({
    jobId: videoInfo?.jobId || '',
    keyingParams,
    layoutParams,
    mode,
    format,
    exportMode,
    spriteParams,
    godotParams,
    range: range ? { startFrame: range.startFrame, endFrame: range.endFrame } : null,
    region,
  }), [
    videoInfo?.jobId,
    keyingParams,
    layoutParams,
    mode,
    format,
    exportMode,
    spriteParams,
    godotParams,
    range,
    region,
  ])

  const updateVideoParams = useCallback((patch) => {
    const nextParams = {
      ...safeVideoParams,
      ...patch,
    }
    if (patch.spriteParams) {
      nextParams.spriteParams = {
        ...DEFAULT_SPRITE_PARAMS,
        ...patch.spriteParams,
      }
    }
    if (patch.godotParams) {
      nextParams.godotParams = {
        ...DEFAULT_GODOT_PARAMS,
        ...patch.godotParams,
      }
    }
    onVideoParamsChange?.(nextParams)
  }, [onVideoParamsChange, safeVideoParams])

  const setMode = useCallback((nextMode) => {
    updateVideoParams({ mode: nextMode })
  }, [updateVideoParams])

  const setFormat = useCallback((nextFormat) => {
    updateVideoParams({ format: nextFormat })
  }, [updateVideoParams])

  const setExportMode = useCallback((nextExportMode) => {
    const patch = { exportMode: nextExportMode }
    if (
      nextExportMode === 'godot' &&
      exportMode !== 'godot' &&
      spriteParams.frameWidth === 128 &&
      spriteParams.frameHeight === 128
    ) {
      patch.spriteParams = { ...spriteParams, frameWidth: 256, frameHeight: 256 }
    }
    updateVideoParams(patch)
  }, [exportMode, spriteParams, updateVideoParams])

  const setSpriteParams = useCallback((updater) => {
    const nextSpriteParams = typeof updater === 'function'
      ? updater(spriteParams)
      : updater
    updateVideoParams({ spriteParams: nextSpriteParams })
  }, [spriteParams, updateVideoParams])

  const setGodotParams = useCallback((updater) => {
    const nextGodotParams = typeof updater === 'function'
      ? updater(godotParams)
      : updater
    updateVideoParams({ godotParams: nextGodotParams })
  }, [godotParams, updateVideoParams])

  const availableFormats = FMT_OPTIONS.filter(f => f.modes.includes(mode))

  useEffect(() => {
    const formats = FMT_OPTIONS.filter(f => f.modes.includes(mode))
    if (!formats.some(f => f.value === format)) {
      setFormat(formats[0]?.value || 'webm')
    }
  }, [mode, format, setFormat])

  useEffect(() => {
    return () => {
      if (pollTimerRef.current) clearInterval(pollTimerRef.current)
      if (downloadUrl) URL.revokeObjectURL(downloadUrl)
    }
  }, [downloadUrl])

  useEffect(() => {
    if (status !== 'done' || !completedExportSignature) return
    if (exportSignature === completedExportSignature) return

    setStatus('uploaded')
    setProgress({ current: 0, total: 0, percent: 0 })
    setErrorMsg('')
    setSpriteSheetBlob(null)
    setGodotExport(null)
  }, [completedExportSignature, exportSignature, status])

  const cleanupVideoJob = useCallback((jobId) => {
    if (!jobId) return
    fetch(`/api/video/${encodeURIComponent(jobId)}`, { method: 'DELETE' }).catch(() => {})
  }, [])

  const resetForNewFile = useCallback(() => {
    if (pollTimerRef.current) {
      clearInterval(pollTimerRef.current)
      pollTimerRef.current = null
    }
    setVideoInfo(null)
    setStatus('')
    setProgress({ current: 0, total: 0, percent: 0 })
    setErrorMsg('')
    setDownloadUrl('')
    setSpriteSheetBlob(null)
    setGodotExport(null)
    setCompletedExportSignature('')
  }, [])

  const handleFile = useCallback(async (file) => {
    if (!isVideoFile(file)) return
    const previousJobId = activeJobIdRef.current
    setUploading(true)
    setErrorMsg('')
    setStatus('idle')
    setVideoInfo(null)
    setDownloadUrl('')
    setSpriteSheetBlob(null)
    setGodotExport(null)
    setCompletedExportSignature('')
    cleanupVideoJob(previousJobId)

    const formData = new FormData()
    formData.append('video', file)

    try {
      const resp = await fetch('/api/video/upload', { method: 'POST', body: formData })
      if (!resp.ok) throw new Error(t('videoPanel.uploadFailed'))
      const data = await resp.json()
      activeJobIdRef.current = data.jobId
      setVideoInfo(data)
      setStatus('uploaded')
      onVideoUpload?.(file, data)
    } catch (err) {
      setErrorMsg(err.message)
      setStatus('error')
    } finally {
      setUploading(false)
    }
  }, [cleanupVideoJob, onVideoUpload])

  useEffect(() => {
    if (!isVideoFile(droppedFile) || !shouldHandleDroppedVideo(droppedFile, handledDroppedFileRef.current)) return
    handledDroppedFileRef.current = droppedFile
    resetForNewFile()
    handleFile(droppedFile)
  }, [droppedFile, handleFile, resetForNewFile])

  const handleProcess = async () => {
    if (!videoInfo) return
    if ((exportMode === 'spritesheet' || exportMode === 'godot') && explicitFrameError) {
      setErrorMsg(explicitFrameError)
      setStatus('error')
      return
    }
    const selectedFrames = usesExactFrames ? explicitFrameSelection.frames : undefined
    const currentExportSignature = exportSignature
    setProcessing(true)
    setStatus('processing')
    setProgress({ current: 0, total: 0, percent: 0 })
    setErrorMsg('')
    setDownloadUrl('')
    setSpriteSheetBlob(null)
    setGodotExport(null)
    setCompletedExportSignature('')

    if (exportMode === 'spritesheet') {
      try {
        const resp = await fetch('/api/video/export-spritesheet', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jobId: videoInfo.jobId,
            params: { keying: keyingParams, layout: layoutParams, region },
            spriteParams: {
              ...spriteParams,
              frames: selectedFrames,
              maxFrames: usesExactFrames ? undefined : spriteParams.maxFrames,
              range: range ? { startFrame: range.startFrame, endFrame: range.endFrame } : undefined,
            },
          })
        })
        if (!resp.ok) {
          const errData = await resp.json().catch(() => ({}))
          throw new Error(errData.error || t('videoPanel.spriteExportFailed'))
        }
        const blob = await resp.blob()
        setSpriteSheetBlob(blob)
        setCompletedExportSignature(currentExportSignature)
        setProcessing(false)
        setStatus('done')
      } catch (err) {
        setProcessing(false)
        setStatus('error')
        setErrorMsg(err.message)
      }
      return
    }

    if (exportMode === 'godot') {
      try {
        const resp = await fetch('/api/video/export-godot-spriteframes', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jobId: videoInfo.jobId,
            params: { keying: keyingParams, layout: layoutParams, region },
            spriteParams: {
              ...spriteParams,
              frames: selectedFrames,
              maxFrames: usesExactFrames ? undefined : spriteParams.maxFrames,
              range: range ? { startFrame: range.startFrame, endFrame: range.endFrame } : undefined,
            },
            godot: godotParams,
          }),
        })
        if (!resp.ok) {
          const errData = await resp.json().catch(() => ({}))
          throw new Error(errData.error || t('videoPanel.godotExportFailed'))
        }
        setGodotExport(await resp.json())
        setCompletedExportSignature(currentExportSignature)
        setProcessing(false)
        setStatus('done')
      } catch (err) {
        setProcessing(false)
        setStatus('error')
        setErrorMsg(err.message)
      }
      return
    }

    try {
      const body = {
        jobId: videoInfo.jobId,
        params: { keying: keyingParams, layout: layoutParams, mode, region },
        format,
      }
      const totalFrames = videoInfo.frameCount || Math.round(videoInfo.fps * videoInfo.duration)
      if (range && (range.startFrame > 0 || range.endFrame < totalFrames)) {
        body.range = { startFrame: range.startFrame, endFrame: range.endFrame }
      }
      const resp = await fetch('/api/video/process', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      })
      if (!resp.ok) throw new Error(t('videoPanel.startFailed'))
      const { taskId } = await resp.json()

      pollTimerRef.current = setInterval(async () => {
        try {
          const pResp = await fetch(`/api/video/progress/${taskId}`)
          const pData = await pResp.json()

          if (pData.progress) setProgress(pData.progress)

          if (pData.status === 'done') {
            clearInterval(pollTimerRef.current)
            pollTimerRef.current = null
            setCompletedExportSignature(currentExportSignature)
            setProcessing(false)
            setStatus('done')
          } else if (pData.status === 'error') {
            clearInterval(pollTimerRef.current)
            pollTimerRef.current = null
            setProcessing(false)
            setStatus('error')
            setErrorMsg(pData.error || t('videoPanel.processingFailed'))
          }
        } catch (e) { /* ignore poll errors */ }
      }, 1000)
    } catch (err) {
      setProcessing(false)
      setStatus('error')
      setErrorMsg(err.message)
    }
  }

  const handleDownload = async () => {
    if (!videoInfo) return
    if (exportMode === 'spritesheet' && status === 'done') {
      if (!spriteSheetBlob) return
      const url = URL.createObjectURL(spriteSheetBlob)
      const a = document.createElement('a')
      a.href = url
      a.download = `spritesheet_${spriteParams.frameWidth}x${spriteParams.frameHeight}_${Date.now()}.png`
      a.click()
      setTimeout(() => URL.revokeObjectURL(url), 10000)
      return
    }
    try {
      const resp = await fetch(`/api/video/download/${videoInfo.jobId}`)
      if (!resp.ok) throw new Error(t('videoPanel.downloadFailed'))
      const blob = await resp.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `export_${format}_${Date.now()}.${format}`
      a.click()
      setTimeout(() => URL.revokeObjectURL(url), 10000)
    } catch (err) {
      setErrorMsg(err.message)
    }
  }

  const handleDownloadGodotArtifact = async (artifact) => {
    if (!videoInfo || !godotExport?.artifacts?.[artifact]) return
    try {
      const resp = await fetch(`/api/video/godot-artifact/${videoInfo.jobId}/${artifact}`)
      if (!resp.ok) throw new Error(t('videoPanel.godotDownloadFailed'))
      const blob = await resp.blob()
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = godotExport.artifacts[artifact].filename
      anchor.click()
      setTimeout(() => URL.revokeObjectURL(url), 10000)
    } catch (err) {
      setErrorMsg(err.message)
    }
  }

  const handleReset = () => {
    const jobId = activeJobIdRef.current
    activeJobIdRef.current = null
    handledDroppedFileRef.current = null
    resetForNewFile()
    cleanupVideoJob(jobId)
    onVideoUpload?.(null, null)
  }

  const dockContent = (
    <div className="dock-actions">
      {!videoInfo && (
        <p className="dock-hint">
          {uploading ? t('videoPanel.uploadingHint') : t('videoPanel.emptyHint')}
        </p>
      )}

      {videoInfo && processing && (
        <div className="dock-progress">
          <div className="progress-bar-container">
            <div className="progress-bar" style={{ width: `${progress.percent}%` }} />
          </div>
          <p className="progress-text">
            {t('videoPanel.progress', { percent: progress.percent, current: progress.current, total: progress.total || '...' })}
          </p>
        </div>
      )}

      {videoInfo && errorMsg && <div className="dock-message error-msg">❌ {errorMsg}</div>}

      {videoInfo && status === 'done' && exportMode === 'video' && (
        <div className="dock-message success-msg">✅ {t('videoPanel.videoDone')}</div>
      )}
      {videoInfo && status === 'done' && exportMode === 'spritesheet' && spriteSheetBlob && (
        <div className="dock-message success-msg">
          ✅ {t('videoPanel.spriteDone', { size: formatBytes(spriteSheetBlob.size) })}
        </div>
      )}
      {videoInfo && status === 'done' && exportMode === 'godot' && godotExport && (
        <div className="dock-message success-msg">
          {t('videoPanel.godotDone', { frames: godotExport.frameCount })}
        </div>
      )}

      {videoInfo ? (
        <>
          {status === 'done' ? (
            exportMode === 'spritesheet' ? (
              <button className="dock-btn dock-btn-primary" onClick={handleDownload}>⬇ {t('videoPanel.downloadSprite')}</button>
            ) : exportMode === 'godot' && godotExport ? (
              <div className="godot-downloads">
                <button className="dock-btn dock-btn-primary" onClick={() => handleDownloadGodotArtifact('atlas')}>{t('videoPanel.downloadGodotAtlas')}</button>
                <button className="dock-btn dock-btn-primary" onClick={() => handleDownloadGodotArtifact('spriteframes')}>{t('videoPanel.downloadGodotSpriteFrames')}</button>
                <button className="dock-btn dock-btn-secondary" onClick={() => handleDownloadGodotArtifact('metadata')}>{t('videoPanel.downloadGodotMetadata')}</button>
              </div>
            ) : (
              <button className="dock-btn dock-btn-primary" onClick={handleDownload}>⬇ {t('videoPanel.downloadVideo', { format: format.toUpperCase() })}</button>
            )
          ) : (
            <button className="dock-btn dock-btn-primary" onClick={handleProcess} disabled={processing}>
              {processing ? t('videoPanel.processing') : exportMode === 'spritesheet' ? t('videoPanel.generateSprite') : exportMode === 'godot' ? t('videoPanel.generateGodot') : t('videoPanel.start')}
            </button>
          )}
          <button className="dock-btn dock-btn-secondary" onClick={handleReset} disabled={processing}>🔁 {t('videoPanel.chooseAgain')}</button>
        </>
      ) : (
        <>
          <button className="dock-btn dock-btn-primary" disabled>{uploading ? t('videoPanel.uploading') : `🚀 ${t('videoPanel.start')}`}</button>
          <button className="dock-btn dock-btn-secondary" disabled>🔁 {t('videoPanel.chooseAgain')}</button>
        </>
      )}
    </div>
  )

  return (
    <>
      {videoInfo && (
        <CollapsiblePanel title={`🎬 ${t('videoPanel.title')}`} summary={summary} className="video-panel">
          <div className="video-options">
            <div className="opt-group">
              <p className="opt-label">{t('videoPanel.exportType')}</p>
              <div className="opt-buttons">
                <button
                  className={`opt-btn ${exportMode === 'video' ? 'active' : ''}`}
                  onClick={() => setExportMode('video')}
                >{t('videoPanel.videoExport')}</button>
                <button
                  className={`opt-btn ${exportMode === 'spritesheet' ? 'active' : ''}`}
                  onClick={() => setExportMode('spritesheet')}
                >{t('videoPanel.spriteExport')}</button>
                <button
                  className={`opt-btn ${exportMode === 'godot' ? 'active' : ''}`}
                  onClick={() => setExportMode('godot')}
                >{t('videoPanel.godotExport')}</button>
              </div>
            </div>

            {exportMode === 'video' ? (
              <>
                <div className="opt-group">
                  <p className="opt-label">{t('videoPanel.outputMode')}</p>
                  <div className="opt-buttons">
                    <button
                      className={`opt-btn ${mode === 'transparent' ? 'active' : ''}`}
                      onClick={() => setMode('transparent')}
                    >{t('videoPanel.transparentBg')}</button>
                    <button
                      className={`opt-btn ${mode === 'greenscreen' ? 'active' : ''}`}
                      onClick={() => setMode('greenscreen')}
                    >{t('videoPanel.greenscreenComposite')}</button>
                  </div>
                </div>

                <div className="opt-group">
                  <p className="opt-label">{t('videoPanel.outputFormat')}</p>
                  <div className="opt-buttons">
                    {availableFormats.map(f => (
                      <button
                        key={f.value}
                        className={`opt-btn ${format === f.value ? 'active' : ''}`}
                        onClick={() => setFormat(f.value)}
                      >{t(f.labelKey)}</button>
                    ))}
                  </div>
                </div>

                <div className="opt-group range-group">
                  <p className="opt-label">{t('videoPanel.frameRange')}</p>
                  <div className="range-inputs">
                    <div className="range-field">
                      <label>{t('videoPanel.startFrame')}</label>
                      <input
                        type="number"
                        className="range-num"
                        min={0}
                        max={range.endFrame}
                        value={range.startFrame}
                        onChange={(e) => {
                          const v = Math.max(0, parseInt(e.target.value) || 0)
                          onRangeChange({ ...range, startFrame: Math.min(v, range.endFrame) })
                        }}
                        disabled={processing}
                      />
                    </div>
                    <span className="range-sep">→</span>
                    <div className="range-field">
                      <label>{t('videoPanel.endFrame')}</label>
                      <input
                        type="number"
                        className="range-num"
                        min={range.startFrame}
                        value={range.endFrame}
                        onChange={(e) => {
                          const v = parseInt(e.target.value) || 0
                          onRangeChange({ ...range, endFrame: Math.max(v, range.startFrame) })
                        }}
                        disabled={processing}
                      />
                    </div>
                  </div>
                  <div className="range-info">
                    {range.endFrame - range.startFrame} {t('common.frames')}
                    {range.startFrame > 0 || range.endFrame < (videoInfo.frameCount || Math.round(videoInfo.fps * videoInfo.duration)) ? ` (${t('common.partial')})` : ` (${t('common.allVideo')})`}
                    <button
                      className="btn-range-reset"
                      onClick={() => {
                        const total = videoInfo.frameCount || Math.round(videoInfo.fps * videoInfo.duration)
                        onRangeChange({ startFrame: 0, endFrame: total })
                      }}
                      disabled={processing}
                    >{t('videoPanel.wholeVideo')}</button>
                  </div>
                </div>
              </>
            ) : exportMode === 'spritesheet' ? (
              <div className="sprite-params">
                <div className="sprite-param-row">
                  <label>{t('videoPanel.frameWidth')}</label>
                  <input type="number" min="8" max="2048" value={spriteParams.frameWidth} onChange={e => setSpriteParams(p => ({ ...p, frameWidth: parseInt(e.target.value) || 128 }))} />
                  <label>{t('videoPanel.frameHeight')}</label>
                  <input type="number" min="8" max="2048" value={spriteParams.frameHeight} onChange={e => setSpriteParams(p => ({ ...p, frameHeight: parseInt(e.target.value) || 128 }))} />
                </div>
                <div className="sprite-param-row">
                  <label>{t('videoPanel.framesPerRow')}</label>
                  <input type="number" min="1" max="100" value={spriteParams.framesPerRow} onChange={e => setSpriteParams(p => ({ ...p, framesPerRow: parseInt(e.target.value) || 8 }))} />
                  <label>{t('videoPanel.maxFrames')}</label>
                  <input type="number" min="1" max="10000" value={spriteParams.maxFrames} onChange={e => setSpriteParams(p => ({ ...p, maxFrames: parseInt(e.target.value) || 64 }))} />
                </div>
                <div className="frame-selection-mode">
                  <button
                    className={`opt-btn ${!usesExactFrames ? 'active' : ''}`}
                    onClick={() => setSpriteParams(p => ({ ...p, selectionMode: 'sample' }))}
                  >{t('videoPanel.intervalSampling')}</button>
                  <button
                    className={`opt-btn ${usesExactFrames ? 'active' : ''}`}
                    onClick={() => setSpriteParams(p => ({ ...p, selectionMode: 'exact' }))}
                  >{t('videoPanel.exactFrames')}</button>
                </div>
                {usesExactFrames ? (
                  <div className="exact-frame-field">
                    <label>{t('videoPanel.exactFramesLabel')}</label>
                    <input
                      type="text"
                      value={spriteParams.exactFramesText}
                      placeholder={t('videoPanel.exactFramesPlaceholder')}
                      onChange={e => setSpriteParams(p => ({ ...p, exactFramesText: e.target.value }))}
                    />
                    <span className={explicitFrameError ? 'exact-frame-error' : 'sprite-hint'}>
                      {explicitFrameError || t('videoPanel.exactFramesCount', { count: explicitFrameSelection.frames.length })}
                    </span>
                  </div>
                ) : (
                  <div className="sprite-param-row">
                    <label>{t('videoPanel.sampleEvery')}</label>
                    <input type="number" min="1" max="1000" value={spriteParams.sampleEvery} onChange={e => setSpriteParams(p => ({ ...p, sampleEvery: parseInt(e.target.value) || 1 }))} />
                    <span className="sprite-hint">{t('videoPanel.sampleHint')}</span>
                  </div>
                )}
              </div>
            ) : (
              <div className="sprite-params">
                <div className="sprite-param-row">
                  <label>{t('videoPanel.frameWidth')}</label>
                  <input type="number" min="8" max="2048" value={spriteParams.frameWidth} onChange={e => setSpriteParams(p => ({ ...p, frameWidth: parseInt(e.target.value) || 256 }))} />
                  <label>{t('videoPanel.frameHeight')}</label>
                  <input type="number" min="8" max="2048" value={spriteParams.frameHeight} onChange={e => setSpriteParams(p => ({ ...p, frameHeight: parseInt(e.target.value) || 256 }))} />
                </div>
                <div className="sprite-param-row">
                  <label>{t('videoPanel.safeAreaWidth')}</label>
                  <input type="number" min="1" max={spriteParams.frameWidth} value={godotParams.safeAreaWidth} onChange={e => setGodotParams(p => ({ ...p, safeAreaWidth: parseInt(e.target.value) || 160 }))} />
                  <label>{t('videoPanel.safeAreaHeight')}</label>
                  <input type="number" min="1" max={spriteParams.frameHeight} value={godotParams.safeAreaHeight} onChange={e => setGodotParams(p => ({ ...p, safeAreaHeight: parseInt(e.target.value) || 160 }))} />
                </div>
                <div className="sprite-param-row">
                  <label>{t('videoPanel.framesPerRow')}</label>
                  <input type="number" min="1" max="100" value={spriteParams.framesPerRow} onChange={e => setSpriteParams(p => ({ ...p, framesPerRow: parseInt(e.target.value) || 8 }))} />
                  <label>{t('videoPanel.godotFps')}</label>
                  <input type="number" min="1" max="120" value={godotParams.fps} onChange={e => setGodotParams(p => ({ ...p, fps: parseInt(e.target.value) || 12 }))} />
                </div>
                <div className="sprite-param-row">
                  <label>{t('videoPanel.animationName')}</label>
                  <input className="godot-name-input" type="text" value={godotParams.animationName} onChange={e => setGodotParams(p => ({ ...p, animationName: e.target.value }))} />
                  <label className="sprite-checkbox"><input type="checkbox" checked={godotParams.loop} onChange={e => setGodotParams(p => ({ ...p, loop: e.target.checked }))} /> {t('videoPanel.godotLoop')}</label>
                </div>
                <div className="frame-selection-mode">
                  <button
                    className={`opt-btn ${!usesExactFrames ? 'active' : ''}`}
                    onClick={() => setSpriteParams(p => ({ ...p, selectionMode: 'sample' }))}
                  >{t('videoPanel.intervalSampling')}</button>
                  <button
                    className={`opt-btn ${usesExactFrames ? 'active' : ''}`}
                    onClick={() => setSpriteParams(p => ({ ...p, selectionMode: 'exact' }))}
                  >{t('videoPanel.exactFrames')}</button>
                </div>
                {usesExactFrames ? (
                  <div className="exact-frame-field">
                    <label>{t('videoPanel.exactFramesLabel')}</label>
                    <input
                      type="text"
                      value={spriteParams.exactFramesText}
                      placeholder={t('videoPanel.exactFramesPlaceholder')}
                      onChange={e => setSpriteParams(p => ({ ...p, exactFramesText: e.target.value }))}
                    />
                    <span className={explicitFrameError ? 'exact-frame-error' : 'sprite-hint'}>
                      {explicitFrameError || t('videoPanel.exactFramesCount', { count: explicitFrameSelection.frames.length })}
                    </span>
                  </div>
                ) : (
                  <div className="sprite-param-row">
                    <label>{t('videoPanel.sampleEvery')}</label>
                    <input type="number" min="1" max="1000" value={spriteParams.sampleEvery} onChange={e => setSpriteParams(p => ({ ...p, sampleEvery: parseInt(e.target.value) || 1 }))} />
                    <label>{t('videoPanel.maxFrames')}</label>
                    <input type="number" min="1" max="10000" value={spriteParams.maxFrames} onChange={e => setSpriteParams(p => ({ ...p, maxFrames: parseInt(e.target.value) || 64 }))} />
                  </div>
                )}
              </div>
            )}
          </div>
        </CollapsiblePanel>
      )}

      {dockTarget ? createPortal(dockContent, dockTarget) : null}
    </>
  )
}
