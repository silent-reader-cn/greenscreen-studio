import React, { useState, useRef, useCallback, useEffect } from 'react'
import { createPortal } from 'react-dom'
import CollapsiblePanel from './CollapsiblePanel.jsx'
import { formatBytes, t } from '../i18n.js'

const FMT_OPTIONS = [
  { value: 'webm', labelKey: 'videoPanel.transparentWebm', transparent: true },
  { value: 'mov', labelKey: 'videoPanel.transparentMov', transparent: true },
  { value: 'mp4', labelKey: 'videoPanel.greenscreenMp4', transparent: false },
]

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
  }
}

export default function VideoPanel({
  keyingParams,
  layoutParams,
  videoParams,
  onVideoParamsChange,
  onVideoUpload,
  onVideoDone,
  range,
  onRangeChange,
  droppedFile,
  dockTarget,
}) {
  const safeVideoParams = normalizeVideoParams(videoParams)
  const { mode, format, exportMode, spriteParams } = safeVideoParams
  const summary = exportMode === 'spritesheet'
    ? t('videoPanel.spriteSummary', { width: spriteParams.frameWidth, height: spriteParams.frameHeight })
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

  const pollTimerRef = useRef(null)

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
    onVideoParamsChange?.(nextParams)
  }, [onVideoParamsChange, safeVideoParams])

  const setMode = useCallback((nextMode) => {
    updateVideoParams({ mode: nextMode })
  }, [updateVideoParams])

  const setFormat = useCallback((nextFormat) => {
    updateVideoParams({ format: nextFormat })
  }, [updateVideoParams])

  const setExportMode = useCallback((nextExportMode) => {
    updateVideoParams({ exportMode: nextExportMode })
  }, [updateVideoParams])

  const setSpriteParams = useCallback((updater) => {
    const nextSpriteParams = typeof updater === 'function'
      ? updater(spriteParams)
      : updater
    updateVideoParams({ spriteParams: nextSpriteParams })
  }, [spriteParams, updateVideoParams])

  const availableFormats = FMT_OPTIONS.filter(f => mode === 'transparent' ? f.transparent : !f.transparent)

  useEffect(() => {
    if (mode === 'transparent' && format === 'mp4') setFormat('webm')
    if (mode === 'greenscreen' && (format === 'webm' || format === 'mov')) setFormat('mp4')
  }, [mode, format])

  useEffect(() => {
    return () => {
      if (pollTimerRef.current) clearInterval(pollTimerRef.current)
      if (downloadUrl) URL.revokeObjectURL(downloadUrl)
    }
  }, [downloadUrl])

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
  }, [])

  const handleFile = useCallback(async (file) => {
    if (!isVideoFile(file)) return
    setUploading(true)
    setErrorMsg('')
    setStatus('idle')
    setVideoInfo(null)
    setDownloadUrl('')
    setSpriteSheetBlob(null)

    const formData = new FormData()
    formData.append('video', file)

    try {
      const resp = await fetch('/api/video/upload', { method: 'POST', body: formData })
      if (!resp.ok) throw new Error(t('videoPanel.uploadFailed'))
      const data = await resp.json()
      setVideoInfo(data)
      setStatus('uploaded')
      onVideoUpload?.(file, data)
    } catch (err) {
      setErrorMsg(err.message)
      setStatus('error')
    } finally {
      setUploading(false)
    }
  }, [onVideoUpload])

  useEffect(() => {
    if (isVideoFile(droppedFile)) {
      resetForNewFile()
      handleFile(droppedFile)
    }
  }, [droppedFile, handleFile, resetForNewFile])

  const handleProcess = async () => {
    if (!videoInfo) return
    setProcessing(true)
    setStatus('processing')
    setProgress({ current: 0, total: 0, percent: 0 })
    setErrorMsg('')
    setDownloadUrl('')
    setSpriteSheetBlob(null)

    if (exportMode === 'spritesheet') {
      try {
        const resp = await fetch('/api/video/export-spritesheet', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jobId: videoInfo.jobId,
            params: { keying: keyingParams, layout: layoutParams },
            spriteParams,
          })
        })
        if (!resp.ok) {
          const errData = await resp.json().catch(() => ({}))
          throw new Error(errData.error || t('videoPanel.spriteExportFailed'))
        }
        const blob = await resp.blob()
        setSpriteSheetBlob(blob)
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
        params: { keying: keyingParams, layout: layoutParams, mode },
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
            setProcessing(false)
            setStatus('done')
            onVideoDone?.(videoInfo.jobId, format)
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

  const handleReset = () => {
    resetForNewFile()
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

      {videoInfo ? (
        <>
          {status === 'done' ? (
            exportMode === 'spritesheet' ? (
              <button className="dock-btn dock-btn-primary" onClick={handleDownload}>⬇ {t('videoPanel.downloadSprite')}</button>
            ) : (
              <button className="dock-btn dock-btn-primary" onClick={handleDownload}>⬇ {t('videoPanel.downloadVideo', { format: format.toUpperCase() })}</button>
            )
          ) : (
            <button className="dock-btn dock-btn-primary" onClick={handleProcess} disabled={processing}>
              {processing ? t('videoPanel.processing') : exportMode === 'spritesheet' ? `🖼️ ${t('videoPanel.generateSprite')}` : `🚀 ${t('videoPanel.start')}`}
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
            ) : (
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
                <div className="sprite-param-row">
                  <label>{t('videoPanel.sampleEvery')}</label>
                  <input type="number" min="1" max="1000" value={spriteParams.sampleEvery} onChange={e => setSpriteParams(p => ({ ...p, sampleEvery: parseInt(e.target.value) || 1 }))} />
                  <span className="sprite-hint">{t('videoPanel.sampleHint')}</span>
                </div>
              </div>
            )}
          </div>
        </CollapsiblePanel>
      )}

      {dockTarget ? createPortal(dockContent, dockTarget) : null}
    </>
  )
}
