import React, { useState, useRef, useCallback, useEffect, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { Download, RefreshCw, Sparkles } from 'lucide-react'
import { formatBytes, t } from '../i18n.js'
import { parseExplicitFrameList } from '../lib/frameSelection.js'
import { shouldHandleDroppedVideo, shouldHandleDroppedVideos, droppedVideosKey } from '../lib/droppedVideo.js'
import {
  buildDirectionMirrorsFromSaved,
  buildSeNeQuadPack,
  buildSePairPack,
  buildSourceClip,
  parseAnimationBaseName,
} from '../lib/directionPack.js'
import { classifyDirectionVideos } from '../lib/directionImport.js'
import { buildGodotExportBasename } from '../lib/godotNaming.js'
import { ControlField, ControlSection, ToggleField } from './ControlKit.jsx'

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
  characterName: '',
  actionName: '',
  exportName: '',
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

function ExportSection({ title, children, className = '' }) {
  return (
    <ControlSection title={title} className={`mobile-export-section ${className}`.trim()}>
      {children}
    </ControlSection>
  )
}

function ExportField({ label, children, wide = false, hint }) {
  return (
    <ControlField label={label} hint={hint} wide={wide} className="mobile-export-field">
      {children}
    </ControlField>
  )
}

function VideoExportControls({
  mobile = false,
  exportMode, setExportMode, mode, setMode, availableFormats, format, setFormat,
  range, onRangeChange, videoInfo, processing, spriteParams, setSpriteParams,
  usesExactFrames, explicitFrameError, explicitFrameSelection, godotParams,
  setGodotParams, exportBasename, handleSaveGodotClip, handleSePairPack,
  handleSeNeQuadPack, handleExpandDirectionMirrors, godotClips, clipPreviews,
  sourceVideos, handleMirrorGodotClip, handleRemoveGodotClip,
}) {
  const totalFrames = videoInfo.frameCount || Math.round(videoInfo.fps * videoInfo.duration)
  const selectionControls = (
    <>
      <div className="mobile-export-segments two">
        <button type="button" className={!usesExactFrames ? 'active' : ''} onClick={() => setSpriteParams(p => ({ ...p, selectionMode: 'sample' }))}>{t('videoPanel.intervalSampling')}</button>
        <button type="button" className={usesExactFrames ? 'active' : ''} onClick={() => setSpriteParams(p => ({ ...p, selectionMode: 'exact' }))}>{t('videoPanel.exactFrames')}</button>
      </div>
      {usesExactFrames ? (
        <ExportField
          wide
          label={t('videoPanel.exactFramesLabel')}
          hint={explicitFrameError || t('videoPanel.exactFramesCount', { count: explicitFrameSelection.frames.length })}
        >
          <input
            type="text"
            value={spriteParams.exactFramesText}
            placeholder={t('videoPanel.exactFramesPlaceholder')}
            onChange={event => setSpriteParams(p => ({ ...p, exactFramesText: event.target.value }))}
          />
        </ExportField>
      ) : null}
    </>
  )

  return (
    <div className={`video-export-controls mobile-video-options ${mobile ? 'is-mobile' : 'is-desktop'}`}>
      <ExportSection title={t('videoPanel.exportType')} className="mobile-export-mode-card">
        <div className="mobile-export-segments three">
          <button type="button" className={exportMode === 'video' ? 'active' : ''} onClick={() => setExportMode('video')}>{t('videoPanel.videoExport')}</button>
          <button type="button" className={exportMode === 'spritesheet' ? 'active' : ''} onClick={() => setExportMode('spritesheet')}>{t('videoPanel.spriteExport')}</button>
          <button type="button" className={exportMode === 'godot' ? 'active' : ''} onClick={() => setExportMode('godot')}>{t('videoPanel.godotExportShort')}</button>
        </div>
      </ExportSection>

      {exportMode === 'video' && (
        <>
          <ExportSection title={t('videoPanel.outputMode')}>
            <div className="mobile-export-segments two">
              <button type="button" className={mode === 'transparent' ? 'active' : ''} onClick={() => setMode('transparent')}>{t('videoPanel.transparentBg')}</button>
              <button type="button" className={mode === 'greenscreen' ? 'active' : ''} onClick={() => setMode('greenscreen')}>{t('videoPanel.greenscreenComposite')}</button>
            </div>
            <div className="mobile-export-segments formats" aria-label={t('videoPanel.outputFormat')}>
              {availableFormats.map(option => (
                <button type="button" key={option.value} className={format === option.value ? 'active' : ''} onClick={() => setFormat(option.value)}>{t(option.labelKey)}</button>
              ))}
            </div>
          </ExportSection>
          <ExportSection title={t('videoPanel.frameRange')}>
            <div className="mobile-export-grid">
              <ExportField label={t('videoPanel.startFrame')}>
                <input type="number" min={0} max={range.endFrame} value={range.startFrame} disabled={processing} onChange={event => { const value = Math.max(0, parseInt(event.target.value) || 0); onRangeChange({ ...range, startFrame: Math.min(value, range.endFrame) }) }} />
              </ExportField>
              <ExportField label={t('videoPanel.endFrame')}>
                <input type="number" min={range.startFrame} value={range.endFrame} disabled={processing} onChange={event => { const value = parseInt(event.target.value) || 0; onRangeChange({ ...range, endFrame: Math.max(value, range.startFrame) }) }} />
              </ExportField>
            </div>
            <div className="mobile-range-summary">
              <span>{range.endFrame - range.startFrame} {t('common.frames')} · {range.startFrame > 0 || range.endFrame < totalFrames ? t('common.partial') : t('common.allVideo')}</span>
              <button type="button" onClick={() => onRangeChange({ startFrame: 0, endFrame: totalFrames })} disabled={processing}>{t('videoPanel.wholeVideo')}</button>
            </div>
          </ExportSection>
        </>
      )}

      {exportMode === 'spritesheet' && (
        <>
          <ExportSection title={t('videoPanel.frameSettings')}>
            <div className="mobile-export-grid">
              <ExportField label={t('videoPanel.frameWidth')}><input type="number" min="8" max="2048" value={spriteParams.frameWidth} onChange={event => setSpriteParams(p => ({ ...p, frameWidth: parseInt(event.target.value) || 128 }))} /></ExportField>
              <ExportField label={t('videoPanel.frameHeight')}><input type="number" min="8" max="2048" value={spriteParams.frameHeight} onChange={event => setSpriteParams(p => ({ ...p, frameHeight: parseInt(event.target.value) || 128 }))} /></ExportField>
              <ExportField label={t('videoPanel.framesPerRow')}><input type="number" min="1" max="100" value={spriteParams.framesPerRow} onChange={event => setSpriteParams(p => ({ ...p, framesPerRow: parseInt(event.target.value) || 8 }))} /></ExportField>
              <ExportField label={t('videoPanel.maxFrames')}><input type="number" min="1" max="10000" value={spriteParams.maxFrames} onChange={event => setSpriteParams(p => ({ ...p, maxFrames: parseInt(event.target.value) || 64 }))} /></ExportField>
            </div>
          </ExportSection>
          <ExportSection title={t('videoPanel.samplingSettings')}>
            {selectionControls}
            {!usesExactFrames && (
              <ExportField wide label={t('videoPanel.sampleEvery')} hint={t('videoPanel.sampleHint')}>
                <input type="number" min="1" max="1000" value={spriteParams.sampleEvery} onChange={event => setSpriteParams(p => ({ ...p, sampleEvery: parseInt(event.target.value) || 1 }))} />
              </ExportField>
            )}
          </ExportSection>
        </>
      )}

      {exportMode === 'godot' && (
        <>
          <ExportSection title={t('videoPanel.frameSettings')}>
            <div className="mobile-export-grid">
              <ExportField label={t('videoPanel.frameWidth')}><input type="number" min="8" max="2048" value={spriteParams.frameWidth} onChange={event => setSpriteParams(p => ({ ...p, frameWidth: parseInt(event.target.value) || 256 }))} /></ExportField>
              <ExportField label={t('videoPanel.frameHeight')}><input type="number" min="8" max="2048" value={spriteParams.frameHeight} onChange={event => setSpriteParams(p => ({ ...p, frameHeight: parseInt(event.target.value) || 256 }))} /></ExportField>
              <ExportField label={t('videoPanel.safeAreaWidth')}><input type="number" min="1" max={spriteParams.frameWidth} value={godotParams.safeAreaWidth} onChange={event => setGodotParams(p => ({ ...p, safeAreaWidth: parseInt(event.target.value) || 160 }))} /></ExportField>
              <ExportField label={t('videoPanel.safeAreaHeight')}><input type="number" min="1" max={spriteParams.frameHeight} value={godotParams.safeAreaHeight} onChange={event => setGodotParams(p => ({ ...p, safeAreaHeight: parseInt(event.target.value) || 160 }))} /></ExportField>
              <ExportField label={t('videoPanel.framesPerRow')}><input type="number" min="1" max="100" value={spriteParams.framesPerRow} onChange={event => setSpriteParams(p => ({ ...p, framesPerRow: parseInt(event.target.value) || 8 }))} /></ExportField>
              <ExportField label={t('videoPanel.godotFps')}><input type="number" min="1" max="120" value={godotParams.fps} onChange={event => setGodotParams(p => ({ ...p, fps: parseInt(event.target.value) || 12 }))} /></ExportField>
            </div>
          </ExportSection>
          <ExportSection title={t('videoPanel.namingSettings')}>
            <div className="mobile-export-grid">
              <ExportField label={t('videoPanel.characterName')}><input type="text" value={godotParams.characterName} placeholder={t('videoPanel.characterNamePlaceholder')} onChange={event => setGodotParams(p => ({ ...p, characterName: event.target.value }))} /></ExportField>
              <ExportField label={t('videoPanel.actionName')}><input type="text" value={godotParams.actionName} placeholder={t('videoPanel.actionNamePlaceholder')} onChange={event => setGodotParams(p => ({ ...p, actionName: event.target.value }))} /></ExportField>
              <ExportField wide label={t('videoPanel.exportName')} hint={t('videoPanel.exportNameHint', { name: exportBasename })}><input type="text" value={godotParams.exportName} placeholder={exportBasename} onChange={event => setGodotParams(p => ({ ...p, exportName: event.target.value }))} /></ExportField>
              <ExportField wide label={t('videoPanel.animationName')}><input type="text" value={godotParams.animationName} onChange={event => setGodotParams(p => ({ ...p, animationName: event.target.value }))} /></ExportField>
            </div>
            <ToggleField label={t('videoPanel.godotLoop')} checked={godotParams.loop} onChange={checked => setGodotParams(p => ({ ...p, loop: checked }))} />
          </ExportSection>
          <ExportSection title={t('videoPanel.samplingSettings')}>
            {selectionControls}
            {!usesExactFrames && (
              <div className="mobile-export-grid">
                <ExportField label={t('videoPanel.sampleEvery')}><input type="number" min="1" max="1000" value={spriteParams.sampleEvery} onChange={event => setSpriteParams(p => ({ ...p, sampleEvery: parseInt(event.target.value) || 1 }))} /></ExportField>
                <ExportField label={t('videoPanel.maxFrames')}><input type="number" min="1" max="10000" value={spriteParams.maxFrames} onChange={event => setSpriteParams(p => ({ ...p, maxFrames: parseInt(event.target.value) || 64 }))} /></ExportField>
              </div>
            )}
          </ExportSection>
          <ExportSection title={t('videoPanel.animationSettings')} className="mobile-godot-tools">
            <button type="button" className="mobile-godot-save" onClick={handleSaveGodotClip} disabled={processing || Boolean(explicitFrameError)}>{t('videoPanel.saveGodotClip')}</button>
            <div className="mobile-godot-pack-grid">
              <button type="button" onClick={handleSePairPack} disabled={processing || Boolean(explicitFrameError) || !videoInfo}>{t('videoPanel.packSePair')}</button>
              <button type="button" onClick={handleSeNeQuadPack} disabled={processing || Boolean(explicitFrameError) || !videoInfo}>{t('videoPanel.packSeNe')}</button>
              <button type="button" onClick={handleExpandDirectionMirrors} disabled={processing || godotClips.length === 0}>{t('videoPanel.packExpandMirrors')}</button>
            </div>
            <p className="mobile-export-hint">{godotClips.length > 0 ? t('videoPanel.savedClipCount', { count: godotClips.length }) : t('videoPanel.noSavedClips')}</p>
            <p className="mobile-export-hint">{t('videoPanel.packWorkflowHint')}</p>
            {godotClips.length > 0 && (
              <div className="godot-clip-list">
                {godotClips.map(clip => (
                  <div className="godot-clip-item" key={clip.id}>
                    <div className="godot-clip-thumb" aria-hidden={!clipPreviews[clip.id]}>{clipPreviews[clip.id] ? <img src={clipPreviews[clip.id]} alt="" /> : <span className="godot-clip-thumb-empty">{t('videoPanel.clipPreviewLoading')}</span>}</div>
                    <div className="godot-clip-main"><strong>{clip.name}</strong><span>{clip.mirrorOf ? t('videoPanel.clipMirrorOf', { name: clip.mirrorOf }) : (clip.sourceLabel || sourceVideos[clip.jobId]?.label || clip.jobId || t('videoPanel.clipSourceUnknown'))}</span></div>
                    <div className="godot-clip-actions">
                      {!clip.mirrorOf && <button type="button" className="godot-clip-mirror" onClick={() => handleMirrorGodotClip(clip)} disabled={processing}>{t('videoPanel.mirrorGodotClip')}</button>}
                      <button type="button" className="godot-clip-delete" onClick={() => handleRemoveGodotClip(clip.id)} disabled={processing} aria-label={t('videoPanel.deleteGodotClip', { name: clip.name })}>×</button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </ExportSection>
        </>
      )}
    </div>
  )
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
  droppedFiles,
  dockTarget,
  reviewProjectId = '',
  reviewAssetId = '',
  reviewClipId = '',
  mobile = false,
}) {
  const safeVideoParams = normalizeVideoParams(videoParams)
  const { mode, format, exportMode, spriteParams, godotParams } = safeVideoParams

  const [videoInfo, setVideoInfo] = useState(null)       // {jobId, width, height, fps, duration, hasAudio}
  const [uploading, setUploading] = useState(false)
  const [processing, setProcessing] = useState(false)
  const [progress, setProgress] = useState({ current: 0, total: 0, percent: 0 })
  const [status, setStatus] = useState('')               // 'idle'|'uploaded'|'processing'|'done'|'error'
  const [errorMsg, setErrorMsg] = useState('')
  const [downloadUrl, setDownloadUrl] = useState('')
  const [spriteSheetBlob, setSpriteSheetBlob] = useState(null)
  const [godotExport, setGodotExport] = useState(null)
  const [godotClips, setGodotClips] = useState([])
  const [sourceVideos, setSourceVideos] = useState({})
  const [clipPreviews, setClipPreviews] = useState({})
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

  const exportBasename = useMemo(() => buildGodotExportBasename({
    characterName: godotParams.characterName,
    actionName: godotParams.actionName,
    exportName: godotParams.exportName,
    animationNames: godotClips.length > 0
      ? godotClips.map(clip => clip.name)
      : [godotParams.animationName],
    fallbackPrefix: godotParams.animationName || 'godot_export',
  }), [
    godotClips,
    godotParams.actionName,
    godotParams.animationName,
    godotParams.characterName,
    godotParams.exportName,
  ])

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
    godotClips,
    reviewClipId,
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
    godotClips,
    reviewClipId,
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

  const handleSaveGodotClip = useCallback(() => {
    const name = String(godotParams.animationName || '').trim()
    if (!name) {
      setErrorMsg(t('videoPanel.clipNameRequired'))
      return
    }
    if (!videoInfo?.jobId) {
      setErrorMsg(t('videoPanel.clipSourceRequired'))
      return
    }
    if (godotClips.some(clip => clip.name === name)) {
      setErrorMsg(t('videoPanel.clipNameDuplicate', { name }))
      return
    }
    if (explicitFrameError) {
      setErrorMsg(explicitFrameError)
      return
    }

    const clip = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      name,
      jobId: videoInfo.jobId,
      sourceLabel: videoInfo.originalName || videoInfo.filename || videoInfo.jobId,
      fps: godotParams.fps,
      loop: godotParams.loop,
      range: range ? { startFrame: range.startFrame, endFrame: range.endFrame } : undefined,
      frames: usesExactFrames ? [...explicitFrameSelection.frames] : undefined,
      sampleEvery: usesExactFrames ? undefined : spriteParams.sampleEvery,
      maxFrames: usesExactFrames ? undefined : spriteParams.maxFrames,
      selectionMode: usesExactFrames ? 'exact' : 'sample',
    }
    setGodotClips(clips => [...clips, clip])
    setSourceVideos(prev => ({
      ...prev,
      [videoInfo.jobId]: {
        jobId: videoInfo.jobId,
        label: clip.sourceLabel,
        frameCount: totalFrames,
      },
    }))
    setErrorMsg('')
  }, [explicitFrameError, explicitFrameSelection.frames, godotClips, godotParams, range, spriteParams.maxFrames, spriteParams.sampleEvery, totalFrames, usesExactFrames, videoInfo])

  const handleRemoveGodotClip = useCallback((clipId) => {
    setGodotClips(clips => {
      const next = clips.filter(clip => clip.id !== clipId)
      const retainedJobIds = new Set(
        next.flatMap(clip => [clip.jobId, ...(clip.mirrorOf ? [] : [])].filter(Boolean))
      )
      // Keep source videos that are still referenced by remaining clips or the active preview.
      setSourceVideos(prev => {
        const kept = {}
        for (const [jobId, info] of Object.entries(prev)) {
          if (retainedJobIds.has(jobId) || jobId === activeJobIdRef.current) kept[jobId] = info
        }
        return kept
      })
      return next
    })
    setErrorMsg('')
  }, [])

  const handleMirrorGodotClip = useCallback((sourceClip) => {
    const name = String(godotParams.animationName || '').trim()
    if (!name) {
      setErrorMsg(t('videoPanel.clipNameRequired'))
      return
    }
    if (godotClips.some(clip => clip.name === name)) {
      setErrorMsg(t('videoPanel.clipNameDuplicate', { name }))
      return
    }
    if (name === sourceClip.name) {
      setErrorMsg(t('videoPanel.clipMirrorSameName'))
      return
    }

    const clip = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      name,
      jobId: sourceClip.jobId,
      sourceLabel: sourceClip.sourceLabel,
      fps: sourceClip.fps,
      loop: sourceClip.loop,
      mirrorOf: sourceClip.name,
      selectionMode: 'mirror',
    }
    setGodotClips(clips => [...clips, clip])
    setErrorMsg('')
  }, [godotClips, godotParams.animationName])

  const currentDraftClip = useMemo(() => {
    if (!videoInfo?.jobId) return null
    return {
      jobId: videoInfo.jobId,
      sourceLabel: videoInfo.originalName || videoInfo.filename || videoInfo.jobId,
      fps: godotParams.fps,
      loop: godotParams.loop,
      range: range ? { startFrame: range.startFrame, endFrame: range.endFrame } : undefined,
      frames: usesExactFrames ? [...explicitFrameSelection.frames] : undefined,
      sampleEvery: usesExactFrames ? undefined : spriteParams.sampleEvery,
      maxFrames: usesExactFrames ? undefined : spriteParams.maxFrames,
      selectionMode: usesExactFrames ? 'exact' : 'sample',
      error: explicitFrameError || '',
    }
  }, [
    explicitFrameError,
    explicitFrameSelection.frames,
    godotParams.fps,
    godotParams.loop,
    range,
    spriteParams.maxFrames,
    spriteParams.sampleEvery,
    usesExactFrames,
    videoInfo,
  ])

  const applyDirectionPackResult = useCallback((result) => {
    if (!result.ok) {
      if (result.error === 'name_required') setErrorMsg(t('videoPanel.clipNameRequired'))
      else if (result.error === 'source_required') setErrorMsg(t('videoPanel.clipSourceRequired'))
      else if (result.error === 'name_conflict') {
        setErrorMsg(t('videoPanel.packNameConflict', {
          names: (result.conflict || []).join(', '),
        }))
      } else if (result.error === 'se_required') setErrorMsg(t('videoPanel.packSeRequired'))
      else if (result.error === 'nothing_to_add') setErrorMsg(t('videoPanel.packNothingToAdd'))
      else if (result.error === 'se_ne_exist') setErrorMsg(t('videoPanel.packSeNeExist'))
      else if (typeof result.error === 'string' && result.error) setErrorMsg(result.error)
      else setErrorMsg(t('videoPanel.packFailed'))
      return
    }

    setGodotClips(result.clips)
    if (videoInfo?.jobId) {
      setSourceVideos(prev => ({
        ...prev,
        [videoInfo.jobId]: {
          jobId: videoInfo.jobId,
          label: videoInfo.originalName || videoInfo.filename || videoInfo.jobId,
          frameCount: totalFrames,
        },
      }))
    }
    setErrorMsg('')
  }, [totalFrames, videoInfo])

  const handleSePairPack = useCallback(() => {
    applyDirectionPackResult(buildSePairPack({
      existingClips: godotClips,
      animationName: godotParams.animationName,
      draft: currentDraftClip,
    }))
  }, [applyDirectionPackResult, currentDraftClip, godotClips, godotParams.animationName])

  const handleSeNeQuadPack = useCallback(() => {
    applyDirectionPackResult(buildSeNeQuadPack({
      existingClips: godotClips,
      animationName: godotParams.animationName,
      draft: currentDraftClip,
    }))
  }, [applyDirectionPackResult, currentDraftClip, godotClips, godotParams.animationName])

  const handleExpandDirectionMirrors = useCallback(() => {
    applyDirectionPackResult(buildDirectionMirrorsFromSaved({
      existingClips: godotClips,
      baseName: godotParams.animationName,
    }))
  }, [applyDirectionPackResult, godotClips, godotParams.animationName])

  const resolveClipPreviewRequest = useCallback((clip) => {
    if (!clip) return null
    if (clip.mirrorOf) {
      const sourceClip = godotClips.find(item => item.name === clip.mirrorOf)
      if (!sourceClip?.jobId) return null
      const sourceFrameIndex = Array.isArray(sourceClip.frames) && sourceClip.frames.length > 0
        ? sourceClip.frames[0]
        : (sourceClip.range?.startFrame ?? 0)
      return {
        clipId: clip.id,
        jobId: sourceClip.jobId,
        sourceFrameIndex,
        flipH: true,
      }
    }
    if (!clip.jobId) return null
    const sourceFrameIndex = Array.isArray(clip.frames) && clip.frames.length > 0
      ? clip.frames[0]
      : (clip.range?.startFrame ?? 0)
    return {
      clipId: clip.id,
      jobId: clip.jobId,
      sourceFrameIndex,
      flipH: clip.flipH === true,
    }
  }, [godotClips])

  useEffect(() => {
    if (exportMode !== 'godot' || godotClips.length === 0) {
      setClipPreviews(prev => {
        for (const url of Object.values(prev)) {
          if (url) URL.revokeObjectURL(url)
        }
        return {}
      })
      return undefined
    }

    let cancelled = false
    const controllers = []

    const loadPreviews = async () => {
      const next = {}
      const activeIds = new Set(godotClips.map(clip => clip.id))

      for (const clip of godotClips) {
        const request = resolveClipPreviewRequest(clip)
        if (!request) continue
        const controller = new AbortController()
        controllers.push(controller)
        try {
          const resp = await fetch('/api/video/godot-clip-preview', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            signal: controller.signal,
            body: JSON.stringify({
              jobId: request.jobId,
              sourceFrameIndex: request.sourceFrameIndex,
              flipH: request.flipH,
              params: { keying: keyingParams, layout: layoutParams, region },
              spriteParams: {
                frameWidth: Math.min(96, spriteParams.frameWidth || 96),
                frameHeight: Math.min(96, spriteParams.frameHeight || 96),
              },
              godot: {
                safeAreaWidth: godotParams.safeAreaWidth,
                safeAreaHeight: godotParams.safeAreaHeight,
              },
            }),
          })
          if (!resp.ok) continue
          const blob = await resp.blob()
          if (cancelled) return
          next[clip.id] = URL.createObjectURL(blob)
        } catch (err) {
          if (err?.name === 'AbortError') return
        }
      }

      if (cancelled) {
        for (const url of Object.values(next)) URL.revokeObjectURL(url)
        return
      }

      setClipPreviews(prev => {
        for (const [id, url] of Object.entries(prev)) {
          if (!activeIds.has(id) || next[id]) URL.revokeObjectURL(url)
        }
        return next
      })
    }

    loadPreviews()
    return () => {
      cancelled = true
      for (const controller of controllers) controller.abort()
    }
  }, [
    exportMode,
    godotClips,
    godotParams.safeAreaHeight,
    godotParams.safeAreaWidth,
    keyingParams,
    layoutParams,
    region,
    resolveClipPreviewRequest,
    spriteParams.frameHeight,
    spriteParams.frameWidth,
  ])

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
    if (!isVideoFile(file)) return null
    const previousJobId = activeJobIdRef.current
    const previousStillNeeded = godotClips.some(clip => clip.jobId === previousJobId)
    setUploading(true)
    setErrorMsg('')
    setStatus('idle')
    setVideoInfo(null)
    setDownloadUrl('')
    setSpriteSheetBlob(null)
    setGodotExport(null)
    setCompletedExportSignature('')
    if (previousJobId && !previousStillNeeded) {
      cleanupVideoJob(previousJobId)
      setSourceVideos(prev => {
        if (!prev[previousJobId]) return prev
        const next = { ...prev }
        delete next[previousJobId]
        return next
      })
    }

    const formData = new FormData()
    formData.append('video', file)
    if (reviewProjectId && reviewAssetId) {
      formData.append('projectId', reviewProjectId)
      formData.append('assetId', reviewAssetId)
    }

    try {
      const resp = await fetch('/api/video/upload', { method: 'POST', body: formData })
      if (!resp.ok) throw new Error(t('videoPanel.uploadFailed'))
      const data = await resp.json()
      const label = file.name || data.originalName || data.filename || data.jobId
      const info = { ...data, originalName: label }
      activeJobIdRef.current = data.jobId
      setVideoInfo(info)
      setSourceVideos(prev => ({
        ...prev,
        [data.jobId]: {
          jobId: data.jobId,
          label,
          frameCount: data.frameCount || Math.round((data.fps || 0) * (data.duration || 0)),
        },
      }))
      setStatus('uploaded')
      onVideoUpload?.(file, data)
      return info
    } catch (err) {
      setErrorMsg(err.message)
      setStatus('error')
      return null
    } finally {
      setUploading(false)
    }
  }, [cleanupVideoJob, godotClips, onVideoUpload, reviewAssetId, reviewProjectId])

  const uploadVideoQuiet = useCallback(async (file) => {
    if (!isVideoFile(file)) return null
    const formData = new FormData()
    formData.append('video', file)
    const resp = await fetch('/api/video/upload', { method: 'POST', body: formData })
    if (!resp.ok) throw new Error(t('videoPanel.uploadFailed'))
    const data = await resp.json()
    const label = file.name || data.originalName || data.filename || data.jobId
    return { ...data, originalName: label }
  }, [])

  const handleDroppedVideos = useCallback(async (files) => {
    const list = Array.from(files || []).filter(isVideoFile)
    if (list.length === 0) return

    if (list.length === 1) {
      await handleFile(list[0])
      return
    }

    const classified = classifyDirectionVideos(list)
    setUploading(true)
    setErrorMsg('')
    setStatus('idle')
    setDownloadUrl('')
    setSpriteSheetBlob(null)
    setGodotExport(null)
    setCompletedExportSignature('')

    try {
      // Prefer source-direction videos for auto packs; fall back to all videos.
      const uploadList = classified.sourceItems.length > 0
        ? classified.sourceItems
        : classified.items.map(item => ({ ...item, direction: item.direction || null }))

      const uploaded = []
      for (const item of uploadList) {
        const info = await uploadVideoQuiet(item.file)
        if (!info) continue
        uploaded.push({ ...item, info })
        setSourceVideos(prev => ({
          ...prev,
          [info.jobId]: {
            jobId: info.jobId,
            label: info.originalName,
            frameCount: info.frameCount || Math.round((info.fps || 0) * (info.duration || 0)),
          },
        }))
      }

      if (uploaded.length === 0) {
        throw new Error(t('videoPanel.uploadFailed'))
      }

      // Keep the last uploaded video as the active preview/source.
      const active = uploaded[uploaded.length - 1]
      activeJobIdRef.current = active.info.jobId
      setVideoInfo(active.info)
      setStatus('uploaded')
      onVideoUpload?.(active.file, active.info)

      // Auto-fill action name when empty or still default.
      const inferredAction = classified.actionBase
        || detectActionFromUploaded(uploaded)
      if (inferredAction) {
        const currentAction = String(godotParams.actionName || '').trim()
        const currentAnim = String(godotParams.animationName || '').trim()
        const shouldSetAction = !currentAction
        const shouldSetAnim = !currentAnim || currentAnim === 'animation' || currentAnim === DEFAULT_GODOT_PARAMS.animationName
        if (shouldSetAction || shouldSetAnim) {
          onVideoParamsChange?.({
            ...safeVideoParams,
            godotParams: {
              ...safeVideoParams.godotParams,
              actionName: shouldSetAction ? inferredAction : safeVideoParams.godotParams.actionName,
              animationName: shouldSetAnim ? inferredAction : safeVideoParams.godotParams.animationName,
            },
          })
        }
      }

      // Build Godot clips for directed sources and expand mirrors when SE+NE are both present.
      const directedUploads = uploaded.filter(item => item.direction && item.isSourceDirection !== false && ['SE', 'NE', 'S', 'N', 'E', 'W'].includes(item.direction))
      if (directedUploads.length > 0) {
        // Ensure Godot export mode so the pack is immediately visible/exportable.
        if (exportMode !== 'godot') {
          onVideoParamsChange?.({
            ...safeVideoParams,
            exportMode: 'godot',
            godotParams: {
              ...safeVideoParams.godotParams,
              actionName: inferredAction || safeVideoParams.godotParams.actionName,
              animationName: inferredAction || safeVideoParams.godotParams.animationName,
            },
          })
        }

        const actionBase = inferredAction || parseAnimationBaseName(godotParams.animationName).base || 'animation'
        let nextClips = [...godotClips]
        const added = []

        for (const item of directedUploads) {
          const clipName = `${actionBase}_${item.direction}`
          if (nextClips.some(clip => clip.name === clipName)) continue
          const frameCount = item.info.frameCount || Math.round((item.info.fps || 0) * (item.info.duration || 0))
          const clip = buildSourceClip({
            name: clipName,
            jobId: item.info.jobId,
            sourceLabel: item.info.originalName,
            fps: godotParams.fps,
            loop: godotParams.loop,
            range: { startFrame: 0, endFrame: frameCount },
            frames: undefined,
            sampleEvery: spriteParams.sampleEvery,
            maxFrames: spriteParams.maxFrames,
            selectionMode: 'sample',
          })
          nextClips = [...nextClips, clip]
          added.push(clipName)
        }

        const hasSe = nextClips.some(clip => clip.name === `${actionBase}_SE`)
        const hasNe = nextClips.some(clip => clip.name === `${actionBase}_NE`)
        if (hasSe || hasNe) {
          const mirrored = buildDirectionMirrorsFromSaved({
            existingClips: nextClips,
            baseName: actionBase,
          })
          if (mirrored.ok) {
            nextClips = mirrored.clips
            added.push(...(mirrored.added || []))
          }
        }

        setGodotClips(nextClips)
      }

      if (classified.withoutDirection.length > 0 && classified.sourceItems.length > 0) {
        // Non-blocking hint: some files lacked direction tokens.
        setErrorMsg(t('videoPanel.batchImportPartial', {
          count: classified.sourceItems.length,
          skipped: classified.withoutDirection.length,
        }))
      }
    } catch (err) {
      setErrorMsg(err.message)
      setStatus('error')
    } finally {
      setUploading(false)
    }
  }, [
    exportMode,
    godotClips,
    godotParams.actionName,
    godotParams.animationName,
    godotParams.fps,
    godotParams.loop,
    handleFile,
    onVideoParamsChange,
    onVideoUpload,
    safeVideoParams,
    spriteParams.maxFrames,
    spriteParams.sampleEvery,
    uploadVideoQuiet,
  ])

  function detectActionFromUploaded(uploaded) {
    for (const item of uploaded) {
      if (item.actionBase) return item.actionBase
    }
    return null
  }

  useEffect(() => {
    const files = Array.isArray(droppedFiles)
      ? droppedFiles
      : droppedFiles
        ? [droppedFiles]
        : []
    if (!shouldHandleDroppedVideos(files, handledDroppedFileRef.current)) return
    handledDroppedFileRef.current = droppedVideosKey(files)
    if (files.length === 1) {
      resetForNewFile()
      handleFile(files[0])
      return
    }
    // Multi-file drops keep existing directed clips so SE/NE packs can accumulate.
    handleDroppedVideos(files)
  }, [droppedFiles, handleDroppedVideos, handleFile, resetForNewFile])

  const handleProcess = async () => {
    if (!videoInfo) return
    const needsCurrentSelection = exportMode === 'spritesheet' || (exportMode === 'godot' && godotClips.length === 0)
    if (needsCurrentSelection && explicitFrameError) {
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
            clipId: reviewClipId || undefined,
            params: { keying: keyingParams, layout: layoutParams, region },
            spriteParams: {
              ...spriteParams,
              frames: selectedFrames,
              maxFrames: usesExactFrames ? undefined : spriteParams.maxFrames,
              range: range ? { startFrame: range.startFrame, endFrame: range.endFrame } : undefined,
            },
            godot: {
              ...godotParams,
              animations: godotClips.length > 0
                ? godotClips.map(({ id, selectionMode, sourceLabel, ...clip }) => {
                    if (clip.mirrorOf) {
                      return {
                        name: clip.name,
                        fps: clip.fps,
                        loop: clip.loop,
                        mirrorOf: clip.mirrorOf,
                      }
                    }
                    return {
                      name: clip.name,
                      jobId: clip.jobId,
                      fps: clip.fps,
                      loop: clip.loop,
                      range: clip.range,
                      frames: clip.frames,
                      sampleEvery: clip.sampleEvery,
                      maxFrames: clip.maxFrames,
                      flipH: clip.flipH,
                    }
                  })
                : undefined,
            },
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
    const jobIds = new Set([
      activeJobIdRef.current,
      ...Object.keys(sourceVideos),
      ...godotClips.map(clip => clip.jobId),
    ].filter(Boolean))
    activeJobIdRef.current = null
    handledDroppedFileRef.current = null
    setGodotClips([])
    setSourceVideos({})
    resetForNewFile()
    for (const jobId of jobIds) cleanupVideoJob(jobId)
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
              <button className="dock-btn dock-btn-primary" onClick={handleDownload}><Download size={16} aria-hidden="true" />{t('videoPanel.downloadSprite')}</button>
            ) : exportMode === 'godot' && godotExport ? (
              <div className="godot-downloads">
                <button className="dock-btn dock-btn-primary" onClick={() => handleDownloadGodotArtifact('bundle')}>{t('videoPanel.downloadGodotBundle')}</button>
                <button className="dock-btn dock-btn-primary" onClick={() => handleDownloadGodotArtifact('atlas')}>{t('videoPanel.downloadGodotAtlas')}</button>
                <button className="dock-btn dock-btn-primary" onClick={() => handleDownloadGodotArtifact('spriteframes')}>{t('videoPanel.downloadGodotSpriteFrames')}</button>
                <button className="dock-btn dock-btn-primary" onClick={() => handleDownloadGodotArtifact('scene')}>{t('videoPanel.downloadGodotScene')}</button>
                <button className="dock-btn dock-btn-secondary" onClick={() => handleDownloadGodotArtifact('events')}>{t('videoPanel.downloadGodotEvents')}</button>
                <button className="dock-btn dock-btn-secondary" onClick={() => handleDownloadGodotArtifact('metadata')}>{t('videoPanel.downloadGodotMetadata')}</button>
              </div>
            ) : (
              <button className="dock-btn dock-btn-primary" onClick={handleDownload}><Download size={16} aria-hidden="true" />{t('videoPanel.downloadVideo', { format: format.toUpperCase() })}</button>
            )
          ) : (
            <button className="dock-btn dock-btn-primary" onClick={handleProcess} disabled={processing}>
              <Sparkles size={16} aria-hidden="true" />
              {processing ? t('videoPanel.processing') : exportMode === 'spritesheet' ? t('videoPanel.generateSprite') : exportMode === 'godot' ? t('videoPanel.generateGodot') : t('videoPanel.start')}
            </button>
          )}
          <button className="dock-btn dock-btn-secondary" onClick={handleReset} disabled={processing}><RefreshCw size={16} aria-hidden="true" />{t('videoPanel.chooseAgain')}</button>
        </>
      ) : (
        <>
          <button className="dock-btn dock-btn-primary" disabled><Sparkles size={16} aria-hidden="true" />{uploading ? t('videoPanel.uploading') : t('videoPanel.start')}</button>
          <button className="dock-btn dock-btn-secondary" disabled><RefreshCw size={16} aria-hidden="true" />{t('videoPanel.chooseAgain')}</button>
        </>
      )}
    </div>
  )

  return (
    <>
      {videoInfo && (
        <section
          className={`parameter-panel video-parameter-panel ${mobile ? 'mobile-video-parameter-panel' : 'desktop-video-parameter-panel'}`}
          aria-label={t('videoPanel.title')}
        >
          <VideoExportControls
            mobile={mobile}
            exportMode={exportMode}
            setExportMode={setExportMode}
            mode={mode}
            setMode={setMode}
            availableFormats={availableFormats}
            format={format}
            setFormat={setFormat}
            range={range}
            onRangeChange={onRangeChange}
            videoInfo={videoInfo}
            processing={processing}
            spriteParams={spriteParams}
            setSpriteParams={setSpriteParams}
            usesExactFrames={usesExactFrames}
            explicitFrameError={explicitFrameError}
            explicitFrameSelection={explicitFrameSelection}
            godotParams={godotParams}
            setGodotParams={setGodotParams}
            exportBasename={exportBasename}
            handleSaveGodotClip={handleSaveGodotClip}
            handleSePairPack={handleSePairPack}
            handleSeNeQuadPack={handleSeNeQuadPack}
            handleExpandDirectionMirrors={handleExpandDirectionMirrors}
            godotClips={godotClips}
            clipPreviews={clipPreviews}
            sourceVideos={sourceVideos}
            handleMirrorGodotClip={handleMirrorGodotClip}
            handleRemoveGodotClip={handleRemoveGodotClip}
          />
        </section>
      )}

      {dockTarget ? createPortal(dockContent, dockTarget) : null}
    </>
  )
}
