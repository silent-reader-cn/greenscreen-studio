import React, { useState, useRef, useCallback, useEffect } from 'react'

const FMT_OPTIONS = [
  { value: 'webm', label: 'WebM (透明, VP9)', transparent: true },
  { value: 'mov', label: 'MOV (透明, ProRes 4444)', transparent: true },
  { value: 'mp4', label: 'MP4 (绿幕合成, H.264)', transparent: false },
]

export default function VideoPanel({ keyingParams, layoutParams, onVideoUpload, onVideoDone, range, onRangeChange }) {
  const [mode, setMode] = useState('transparent')      // 'transparent' | 'greenscreen'
  const [format, setFormat] = useState('webm')
  const [videoInfo, setVideoInfo] = useState(null)       // {jobId, width, height, fps, duration, hasAudio}
  const [uploading, setUploading] = useState(false)
  const [processing, setProcessing] = useState(false)
  const [progress, setProgress] = useState({ current: 0, total: 0, percent: 0 })
  const [status, setStatus] = useState('')               // 'idle'|'uploaded'|'processing'|'done'|'error'
  const [errorMsg, setErrorMsg] = useState('')
  const [downloadUrl, setDownloadUrl] = useState('')

  const inputRef = useRef(null)
  const pollTimerRef = useRef(null)
  const fileRef = useRef(null)

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

    try {
      // 发起处理
      const body = {
        jobId: videoInfo.jobId,
        params: { keying: keyingParams, layout: layoutParams, mode },
        format,
      }
      // 如果指定了帧范围，传入 range
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
        onDrop={(e) => { e.preventDefault(); handleFile(e.dataTransfer.files[0]) }}
        onDragOver={(e) => e.preventDefault()}
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

          {/* 帧范围 */}
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
      {status === 'done' && (
        <div className="success-msg">✅ 处理完成！点击下方下载</div>
      )}

      {/* 操作按钮 */}
      {videoInfo && (
        <div className="video-actions">
          {status === 'done' ? (
            <button className="btn-video-download" onClick={handleDownload}>
              ⬇ 下载视频 ({format.toUpperCase()})
            </button>
          ) : (
            <button
              className="btn-video-process"
              onClick={handleProcess}
              disabled={processing}
            >
              {processing ? '处理中...' : '🚀 开始处理'}
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
