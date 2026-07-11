import React, { useState, useRef, useCallback, useEffect } from 'react'
import { createPortal } from 'react-dom'

const FMT_OPTIONS = [
  { value: 'webm', label: 'WebM (透明, VP9)', transparent: true },
  { value: 'mov', label: 'MOV (透明, ProRes 4444)', transparent: true },
  { value: 'mp4', label: 'MP4 (绿幕合成, H.264)', transparent: false },
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

  const [videoInfo, setVideoInfo] = useState(null)       // {jobId, width, height, fps, duration, hasAudio}
  const [uploading, setUploading] = useState(false)
  const [processing, setProcessing] = useState(false)
  const [progress, setProgress] = useState({ current: 0, total: 0, percent: 0 })
  const [status, setStatus] = useState('')               // 'idle'|'uploaded'|'processing'|'done'|'error'
  const [errorMsg, setErrorMsg] = useState('')
  const [downloadUrl, setDownloadUrl] = useState('')
  const [spriteSheetBlob, setSpriteSheetBlob] = useState(null)

  const inputRef = useRef(null)
  const pollTimerRef = useRef(null)
  const fileRef = useRef(null)

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
    if (!file || !file.type.startsWith('video/')) return
    setUploading(true)
    setErrorMsg('')
    setStatus('idle')
    setVideoInfo(null)
    setDownloadUrl('')
    setSpriteSheetBlob(null)
    fileRef.current = file

    const formData = new FormData()
    formData.append('video', file)

    try {
      const resp = await fetch('/api/video/upload', { method: 'POST', body: formData })
      if (!resp.ok) throw new Error('上传失败')
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
    if (droppedFile && droppedFile.type.startsWith('video/')) {
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
          throw new Error(errData.error || '精灵图导出失败')
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
      if (!resp.ok) throw new Error('启动处理失败')
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
            setErrorMsg(pData.error || '处理失败')
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
      if (!resp.ok) throw new Error('下载失败')
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
    if (inputRef.current) inputRef.current.value = ''
    onVideoUpload?.(null, null)
  }

  const fmtTime = (s) => {
    const m = Math.floor(s / 60)
    const sec = (s % 60).toFixed(1)
    return m > 0 ? `${m}分${sec}秒` : `${sec}秒`
  }

  const dockContent = (
    <div className="dock-actions">
      {!videoInfo && (
        <p className="dock-hint">
          {uploading ? '视频上传中，完成后可开始处理' : '上传视频后可在这里处理或下载结果'}
        </p>
      )}

      {videoInfo && processing && (
        <div className="dock-progress">
          <div className="progress-bar-container">
            <div className="progress-bar" style={{ width: `${progress.percent}%` }} />
          </div>
          <p className="progress-text">
            {progress.percent}% ({progress.current}/{progress.total || '...'}帧)
          </p>
        </div>
      )}

      {videoInfo && errorMsg && <div className="dock-message error-msg">❌ {errorMsg}</div>}

      {videoInfo && status === 'done' && exportMode === 'video' && (
        <div className="dock-message success-msg">✅ 处理完成，可下载视频</div>
      )}
      {videoInfo && status === 'done' && exportMode === 'spritesheet' && spriteSheetBlob && (
        <div className="dock-message success-msg">
          ✅ 精灵图完成（{spriteSheetBlob.size > 1024 ? `${(spriteSheetBlob.size / 1024).toFixed(1)}KB` : `${spriteSheetBlob.size}B`}）
        </div>
      )}

      {videoInfo ? (
        <>
          {status === 'done' ? (
            exportMode === 'spritesheet' ? (
              <button className="dock-btn dock-btn-primary" onClick={handleDownload}>⬇ 下载精灵图 PNG</button>
            ) : (
              <button className="dock-btn dock-btn-primary" onClick={handleDownload}>⬇ 下载视频 ({format.toUpperCase()})</button>
            )
          ) : (
            <button className="dock-btn dock-btn-primary" onClick={handleProcess} disabled={processing}>
              {processing ? '处理中...' : exportMode === 'spritesheet' ? '🖼️ 生成精灵图' : '🚀 开始处理'}
            </button>
          )}
          <button className="dock-btn dock-btn-secondary" onClick={handleReset} disabled={processing}>重新选择</button>
        </>
      ) : (
        <>
          <button className="dock-btn dock-btn-primary" disabled>{uploading ? '上传中...' : '🚀 开始处理'}</button>
          <button className="dock-btn dock-btn-secondary" disabled>重新选择</button>
        </>
      )}
    </div>
  )

  return (
    <>
      <div className="panel video-panel">
        <h3>🎬 视频抠像</h3>

        <div
          className="video-drop-area"
          onClick={() => inputRef.current?.click()}
          onDrop={(e) => { e.preventDefault(); e.stopPropagation(); handleFile(e.dataTransfer.files[0]) }}
          onDragOver={(e) => { e.preventDefault(); e.stopPropagation() }}
        >
          {uploading ? (
            <p className="uploading-text">上传中...</p>
          ) : videoInfo ? (
            <div className="video-info-display">
              <p className="video-name">{fileRef.current?.name || '视频文件'}</p>
              <p className="video-meta">
                {videoInfo.width}×{videoInfo.height} · {videoInfo.fps}fps · {fmtTime(videoInfo.duration)}
                {videoInfo.hasAudio ? ' · 🔊有音轨' : ' · 🔇无音轨'}
              </p>
            </div>
          ) : (
            <>
              <p>点击或拖拽视频到此处</p>
              <p className="hint">支持 MP4 / MOV / WebM / AVI</p>
              <p className="hint" style={{ marginTop: 6, color: '#bbb' }}>也可拖到窗口任意位置自动切换到视频模式</p>
            </>
          )}
          <input
            ref={inputRef}
            type="file"
            accept="video/*"
            style={{ display: 'none' }}
            onChange={(e) => handleFile(e.target.files[0])}
          />
        </div>

        {videoInfo && (
          <div className="video-options">
            <div className="opt-group">
              <p className="opt-label">导出类型</p>
              <div className="opt-buttons">
                <button
                  className={`opt-btn ${exportMode === 'video' ? 'active' : ''}`}
                  onClick={() => setExportMode('video')}
                >视频导出</button>
                <button
                  className={`opt-btn ${exportMode === 'spritesheet' ? 'active' : ''}`}
                  onClick={() => setExportMode('spritesheet')}
                >精灵图导出</button>
              </div>
            </div>

            {exportMode === 'video' ? (
              <>
                <div className="opt-group">
                  <p className="opt-label">输出模式</p>
                  <div className="opt-buttons">
                    <button
                      className={`opt-btn ${mode === 'transparent' ? 'active' : ''}`}
                      onClick={() => setMode('transparent')}
                    >透明背景</button>
                    <button
                      className={`opt-btn ${mode === 'greenscreen' ? 'active' : ''}`}
                      onClick={() => setMode('greenscreen')}
                    >绿幕合成</button>
                  </div>
                </div>

                <div className="opt-group">
                  <p className="opt-label">输出格式</p>
                  <div className="opt-buttons">
                    {availableFormats.map(f => (
                      <button
                        key={f.value}
                        className={`opt-btn ${format === f.value ? 'active' : ''}`}
                        onClick={() => setFormat(f.value)}
                      >{f.label}</button>
                    ))}
                  </div>
                </div>

                <div className="opt-group range-group">
                  <p className="opt-label">帧范围</p>
                  <div className="range-inputs">
                    <div className="range-field">
                      <label>起始</label>
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
                      <label>结束</label>
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
                    {range.endFrame - range.startFrame} 帧
                    {range.startFrame > 0 || range.endFrame < (videoInfo.frameCount || Math.round(videoInfo.fps * videoInfo.duration)) ? ' (局部)' : ' (全视频)'}
                    <button
                      className="btn-range-reset"
                      onClick={() => {
                        const total = videoInfo.frameCount || Math.round(videoInfo.fps * videoInfo.duration)
                        onRangeChange({ startFrame: 0, endFrame: total })
                      }}
                      disabled={processing}
                    >全视频</button>
                  </div>
                </div>
              </>
            ) : (
              <div className="sprite-params">
                <div className="sprite-param-row">
                  <label>帧宽度</label>
                  <input type="number" min="8" max="2048" value={spriteParams.frameWidth} onChange={e => setSpriteParams(p => ({ ...p, frameWidth: parseInt(e.target.value) || 128 }))} />
                  <label>帧高度</label>
                  <input type="number" min="8" max="2048" value={spriteParams.frameHeight} onChange={e => setSpriteParams(p => ({ ...p, frameHeight: parseInt(e.target.value) || 128 }))} />
                </div>
                <div className="sprite-param-row">
                  <label>每行帧数</label>
                  <input type="number" min="1" max="100" value={spriteParams.framesPerRow} onChange={e => setSpriteParams(p => ({ ...p, framesPerRow: parseInt(e.target.value) || 8 }))} />
                  <label>最大帧数</label>
                  <input type="number" min="1" max="10000" value={spriteParams.maxFrames} onChange={e => setSpriteParams(p => ({ ...p, maxFrames: parseInt(e.target.value) || 64 }))} />
                </div>
                <div className="sprite-param-row">
                  <label>采样间隔</label>
                  <input type="number" min="1" max="1000" value={spriteParams.sampleEvery} onChange={e => setSpriteParams(p => ({ ...p, sampleEvery: parseInt(e.target.value) || 1 }))} />
                  <span className="sprite-hint">每隔 N 帧取一帧</span>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {dockTarget ? createPortal(dockContent, dockTarget) : null}
    </>
  )
}
