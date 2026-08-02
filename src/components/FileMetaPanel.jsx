import React from 'react'
import { ChevronDown, FileText, RotateCcw } from 'lucide-react'
import { formatBytes, formatDuration, t } from '../i18n.js'
import { CompactIconButton } from './ControlKit.jsx'

export default function FileMetaPanel({
  mobile = false,
  mediaMode,
  imageFile,
  imageSize,
  imageRegion,
  videoRegion,
  regionSelectionMode,
  onSelectImageRegion,
  onResetImageRegion,
  onSelectVideoRegion,
  onResetVideoRegion,
  videoFile,
  videoInfo,
}) {
  const isImage = mediaMode === 'image'
  const file = isImage ? imageFile : videoFile
  const loaded = isImage ? imageSize.w > 0 : !!videoInfo
  const activeRegion = isImage ? imageRegion : videoRegion
  const onSelectRegion = isImage ? onSelectImageRegion : onSelectVideoRegion
  const onResetRegion = isImage ? onResetImageRegion : onResetVideoRegion
  const fullRegionLabel = isImage ? t('file.fullImage') : t('file.fullVideo')
  const summary = loaded
    ? (isImage ? `${imageSize.w}×${imageSize.h}` : `${videoInfo.width}×${videoInfo.height}`)
    : t('file.notLoaded')

  const content = loaded && file ? (
    <div className="file-meta-content">
      {mobile && <p className="file-meta-name" title={file.name}>{file.name}</p>}
      <div className="file-meta-grid">
        <span>{t('file.type')}</span>
        <strong>{isImage ? t('app.image') : t('app.video')}</strong>
        <span>{t('file.size')}</span>
        <strong>{formatBytes(file.size)}</strong>
        {isImage ? (
          <>
            <span>{t('file.dimensions')}</span>
            <strong>{imageSize.w} × {imageSize.h}</strong>
          </>
        ) : (
          <>
            <span>{t('file.dimensions')}</span>
            <strong>{videoInfo.width} × {videoInfo.height}</strong>
            <span>{t('file.duration')}</span>
            <strong>{formatDuration(videoInfo.duration)}</strong>
            <span>{t('file.fps')}</span>
            <strong>{videoInfo.fps} fps</strong>
            <span>{t('file.audio')}</span>
            <strong>{videoInfo.hasAudio ? t('common.yes') : t('common.no')}</strong>
          </>
        )}
      </div>
      {loaded && (
        <div className="file-region-tools">
          <div className="file-region-status">
            <span>{t('file.processingRegion')}</span>
            <strong>
              {activeRegion
                ? `${activeRegion.width} × ${activeRegion.height} @ ${activeRegion.x}, ${activeRegion.y}`
                : fullRegionLabel}
            </strong>
          </div>
          <div className="file-region-actions">
            {mobile ? (
              <CompactIconButton
                icon={RotateCcw}
                label={t('file.resetRegion')}
                onClick={onResetRegion}
                disabled={!activeRegion && !regionSelectionMode}
              />
            ) : (
              <button
                type="button"
                className="file-region-btn secondary"
                onClick={onResetRegion}
                disabled={!activeRegion && !regionSelectionMode}
              >
                {t('file.resetRegion')}
              </button>
            )}
            <button type="button" className="file-region-btn" onClick={onSelectRegion}>
              {regionSelectionMode
                ? t('file.reselectRegion')
                : activeRegion ? t('file.resetSelectedRegion') : t('file.selectRegion')}
            </button>
          </div>
        </div>
      )}
    </div>
  ) : (
    <div className="file-meta-empty">
      <p>{isImage ? t('file.noImage') : t('file.noVideo')}</p>
      <p className="hint">{t('file.emptyHint')}</p>
    </div>
  )

  if (mobile) {
    return (
      <details className="mobile-file-panel">
        <summary>
          <span className="mobile-file-summary-icon" aria-hidden="true"><FileText size={18} /></span>
          <span className="mobile-file-summary-copy">
            <strong>{t('file.details')}</strong>
            <small>{summary}</small>
          </span>
          <ChevronDown className="mobile-file-caret" size={18} aria-hidden="true" />
        </summary>
        <div className="mobile-file-body">{content}</div>
      </details>
    )
  }

  return (
    <section className="desktop-file-overview" aria-label={t('file.details')}>
      <header>
        <span className="desktop-file-overview-icon" aria-hidden="true"><FileText size={16} /></span>
        <h3>{t('file.details')}</h3>
        <span>{summary}</span>
      </header>
      <div className="desktop-file-overview-body">{content}</div>
    </section>
  )
}
