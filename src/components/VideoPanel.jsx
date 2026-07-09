import React, { useState, useRef, useCallback, useEffect } from 'react'

const FMT_OPTIONS = [
  { value: 'webm', label: 'WebM (透明, VP9)', transparent: true },
  { value: 'mov', label: 'MOV (透明, ProRes 4444)', transparent: true },
  { value: 'mp4', label: 'MP4 (绿幕合成, H.264)', transparent: false },
]

export default function VideoPanel({ keyingParams, layoutParams, videoFile: propFile, videoInfo: propInfo, onVideoUpload, onVideoDone, droppedFile }) {
  const [mode, setMode] = useState('transparent')
  const [format, setFormat] = useState('webm')
  const [exportMode, setExportMode] = useState('video') // 'video' | 'spritesheet'
  const [videoInfo, setVideoInfo] = useState(propInfo || null)       // {jobId, width, height, fps, duration, hasAudio}
  const [uploading, setUploading] = useState(false)
  const [processing, setProcessing] = useState(false)
  const [progress, setProgress] = useState({ current: 0, total: 0, percent: 0 })
  const [status, setStatus] = useState(propInfo ? 'uploaded' : '')  // 从 props 恢复
  const [errorMsg, setErrorMsg] = useState('')

  // 精灵图参数
  const [spriteParams, setSpriteParams] = useState({
    frameWidth: 128,
    frameHeight: 128,
    framesPerRow: 8,
    maxFrames: 64,
    sampleEvery: 1,
  })
  const [downloadUrl, setDownloadUrl] = useState('')
  const [spriteSheetBlob, setSpriteSheetBlob] = useState(null)

  const inputRef = useRef(null)
  const pollTimerRef = useRef(null)
  const fileRef = useRef(propFile || null)  // 从 props 恢复

  // 格式选项根据 mode 过滤
  const availableFormats = FMT_OPTIONS.filter(f => mode === 'transparent' ? f.transparent : !f.transparent)

  // mode 切换时自动调整 format
  useEffect(() => {
    if (mode === 'transparent' && format === 'mp4') setFormat('webm')
    if (mode === 'greenscreen' && (format === 'webm' || format === 'mov')) setFormat('mp4')
  }, [mode])

  // 清理
  useEffect(() => {
    return () => {
      if (pollTimerRef.current) clearInterval(pollTimerRef.current)
      if (downloadUrl) URL.revokeObjectURL(downloadUrl)
    }
  }, [])

  // 处理外部拖入的视频文件
  useEffect(() => {
    if (droppedFile && droppedFile.type.startsWith('video/')) {
      // 清空之前的状态再处理新文件
      if (pollTimerRef.current) clearInterval(pollTimerRef.current)
      setVideoInfo(null)
      setStatus('')
      setProgress({ current: 0, total: 0, percent: 0 })
      setErrorMsg('')
      setDownloadUrl('')
      handleFile(droppedFile)
    }
  }, [droppedFile])

  const handleFile = useCallback(async (file) => {
    if (!file || !file.type.startsWith('video/')) return
    setUploading(true)
    setErrorMsg('')
    setStatus('idle')
    setVideoInfo(null)
    setDownloadUrl('')
    fileRef.current = file

    const formData = new FormData()
    formData.append('video', file)

    try {
      const resp = await fetch('/api/video/upload', { method: 'POST', body: formData })
      if (!resp.ok) throw new Error('上传失败')
      const data = await resp.json()
      setVideoInfo(data)
      setStatus('uploaded')
      // 通知 App：上传成功，传入 File 和视频信息，用于帧预览
      onVideoUpload?.(file, data)
    } catch (err) {
      setErrorMsg(err.message)
      setStatus('error')
    } finally {
      setUploading(false)
    }
  }, [])

  const handleProcess = async () => {
    if (!videoInfo) return
    setProcessing(true)
    setStatus('processing')
    setProgress({ current: 0, total: 0, percent: 0 })
    setErrorMsg('')
    setDownloadUrl('')
    setSpriteSheetBlob(null)

    if (exportMode === 'spritesheet') {
      // 精灵图导出模式：直接 POST 获取 PNG
      try {
        const resp = await fetch('/api/video/export-spritesheet', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jobId: videoInfo.jobId,
            params: { keying: keyingParams, layout: layoutParams },
            spriteParams,
          }),
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
      // 发起处理
      const resp = await fetch('/api/video/process', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jobId: videoInfo.jobId,
          params: { keying: keyingParams, layout: layoutParams, mode },
          format,
        })
      })
      if (!resp.ok) throw new Error('启动处理失败')
      const { taskId } = await resp.json()

      // 轮询进度
      pollTimerRef.current = setInterval(async () => {
        try {
          const pResp = await fetch(`/api/video/progress/${taskId}`)
          const pData = await pResp.json()

          if (pData.progress) {
            setProgress(pData.progress)
          }

          if (pData.status === 'done') {
            clearInterval(pollTimerRef.current)
            pollTimerRef.current = null
            setProcessing(false)
            setStatus('done')
            // 通知 App：处理完成，传入 jobId 用于预览播放
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
      // 精灵图直接下载（blob 已经在 spriteSheetBlob 里）
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
    if (pollTimerRef.current) clearInterval(pollTimerRef.current)
    setVideoInfo(null)
    setStatus('')
    setProgress({ current: 0, total: 0, percent: 0 })
    setErrorMsg('')
    setDownloadUrl('')
    if (inputRef.current) inputRef.current.value = ''
    onVideoUpload?.(null, null)  // 通知 App 清空预览
  }

  const fmtTime = (s) => {
    const m = Math.floor(s / 60)
    const sec = (s % 60).toFixed(1)
    return m > 0 ? `${m}分${sec}秒` : `${sec}秒`
  }

  return (
    <div className="panel video-panel">
      <h3>🎬 视频抠像</h3>

      {/* 上传区 */}
      <div
        className="video-drop-area"
        onClick={() => inputRef.current?.click()}
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
            <p>点击选择视频</p>
            <p className="hint">支持 MP4 / MOV / WebM / AVI</p>
            <p className="hint" style={{ marginTop: 6, color: '#bbb' }}>
              拖放文件到窗口任意位置也可上传
            </p>
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

      {/* 模式 + 格式选择 */}
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

          {exportMode === 'video' ? (<>
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
          </>) : (
            <div className="sprite-params">
              <div className="sprite-param-row">
                <label>帧宽度 (px)</label>
                <input
                  type="number"
                  min="8"
                  max="2048"
                  value={spriteParams.frameWidth}
                  onChange={e => setSpriteParams(p => ({ ...p, frameWidth: parseInt(e.target.value) || 128 }))}
                />
                <label>帧高度 (px)</label>
                <input
                  type="number"
                  min="8"
                  max="2048"
                  value={spriteParams.frameHeight}
                  onChange={e => setSpriteParams(p => ({ ...p, frameHeight: parseInt(e.target.value) || 128 }))}
                />
              </div>
              <div className="sprite-param-row">
                <label>每行帧数</label>
                <input
                  type="number"
                  min="1"
                  max="100"
                  value={spriteParams.framesPerRow}
                  onChange={e => setSpriteParams(p => ({ ...p, framesPerRow: parseInt(e.target.value) || 8 }))}
                />
                <label>最大帧数</label>
                <input
                  type="number"
                  min="1"
                  max="10000"
                  value={spriteParams.maxFrames}
                  onChange={e => setSpriteParams(p => ({ ...p, maxFrames: parseInt(e.target.value) || 64 }))}
                />
              </div>
              <div className="sprite-param-row">
                <label>采样间隔</label>
                <input
                  type="number"
                  min="1"
                  max="1000"
                  value={spriteParams.sampleEvery}
                  onChange={e => setSpriteParams(p => ({ ...p, sampleEvery: parseInt(e.target.value) || 1 }))}
                />
                <span className="sprite-hint">每隔 N 帧取一帧</span>
              </div>
            </div>
          )}
        </div>
      )}

      {/* 进度条 */}
      {processing && (
        <div className="progress-section">
          <div className="progress-bar-container">
            <div className="progress-bar" style={{ width: `${progress.percent}%` }} />
          </div>
          <p className="progress-text">
            {progress.percent}% ({progress.current}/{progress.total || '...'}帧)
          </p>
        </div>
      )}

      {/* 错误提示 */}
      {errorMsg && (
        <div className="error-msg">❌ {errorMsg}</div>
      )}

      {/* 完成提示 */}
      {status === 'done' && exportMode === 'video' && (
        <div className="success-msg">✅ 处理完成！点击下方下载</div>
      )}
      {status === 'done' && exportMode === 'spritesheet' && spriteSheetBlob && (
        <div className="success-msg">✅ 精灵图导出完成！({spriteSheetBlob.size > 1024 ? `${(spriteSheetBlob.size / 1024).toFixed(1)}KB` : `${spriteSheetBlob.size}B`}) 点击下方下载</div>
      )}

      {/* 操作按钮 */}
      {videoInfo && (
        <div className="video-actions">
          {status === 'done' ? (
            exportMode === 'spritesheet' ? (
              <button className="btn-video-download" onClick={handleDownload}>
                ⬇ 下载精灵图 PNG
              </button>
            ) : (
              <button className="btn-video-download" onClick={handleDownload}>
                ⬇ 下载视频 ({format.toUpperCase()})
              </button>
            )
          ) : (
            <button
              className="btn-video-process"
              onClick={handleProcess}
              disabled={processing}
            >
              {processing ? '处理中...' : exportMode === 'spritesheet' ? '🖼️ 生成精灵图' : '🚀 开始处理'}
            </button>
          )}
          <button className="btn-video-reset" onClick={handleReset} disabled={processing}>
            重新选择
          </button>
        </div>
      )}
    </div>
  )
}
