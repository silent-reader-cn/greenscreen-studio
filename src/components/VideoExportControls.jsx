import React from 'react'
import { FlipHorizontal2, Maximize2, Trash2 } from 'lucide-react'
import { t } from '../i18n.js'
import { CompactActionGroup, CompactIconButton, ControlField, ControlSection, ToggleField } from './ControlKit.jsx'

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

export default function VideoExportControls({
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
              {mobile ? (
                <CompactIconButton icon={Maximize2} size="small" label={t('videoPanel.wholeVideo')} onClick={() => onRangeChange({ startFrame: 0, endFrame: totalFrames })} disabled={processing} />
              ) : (
                <button type="button" onClick={() => onRangeChange({ startFrame: 0, endFrame: totalFrames })} disabled={processing}>{t('videoPanel.wholeVideo')}</button>
              )}
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
                    {mobile ? (
                      <CompactActionGroup className="godot-clip-actions" label={t('videoPanel.clipActions', { name: clip.name })}>
                        {!clip.mirrorOf && <CompactIconButton icon={FlipHorizontal2} size="small" label={t('videoPanel.mirrorGodotClip')} onClick={() => handleMirrorGodotClip(clip)} disabled={processing} />}
                        <CompactIconButton icon={Trash2} size="small" tone="danger" label={t('videoPanel.deleteGodotClip', { name: clip.name })} onClick={() => handleRemoveGodotClip(clip.id)} disabled={processing} />
                      </CompactActionGroup>
                    ) : (
                      <div className="godot-clip-actions">
                        {!clip.mirrorOf && <button type="button" className="godot-clip-mirror" onClick={() => handleMirrorGodotClip(clip)} disabled={processing}>{t('videoPanel.mirrorGodotClip')}</button>}
                        <button type="button" className="godot-clip-delete" onClick={() => handleRemoveGodotClip(clip.id)} disabled={processing} aria-label={t('videoPanel.deleteGodotClip', { name: clip.name })}>×</button>
                      </div>
                    )}
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
