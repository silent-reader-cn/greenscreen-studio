import React from 'react'
import { Image as ImageIcon, Video } from 'lucide-react'
import { formatBytes, formatDateTime, formatDuration, t } from '../i18n.js'

export default function ClipboardImportDialog({ importItem, onCancel, onConfirm }) {
  const { metadata, loading } = importItem
  const isImage = metadata.kind === 'image'
  const kindLabel = isImage ? t('app.image') : t('app.video')
  const dimensionLabel = metadata.width && metadata.height
    ? `${metadata.width} × ${metadata.height}`
    : loading ? t('common.loading') : t('common.unknown')
  const durationLabel = metadata.duration
    ? formatDuration(metadata.duration)
    : loading ? t('common.loading') : t('common.unknown')
  const dateLabel = metadata.lastModified
    ? formatDateTime(metadata.lastModified)
    : t('common.unknown')

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
          <span className="clipboard-modal-icon" aria-hidden="true">
            {isImage ? <ImageIcon size={20} /> : <Video size={20} />}
          </span>
          <div>
            <h2 id="clipboard-import-title">{t('clipboard.title')}</h2>
            <p>{t('clipboard.body', { kind: kindLabel })}</p>
          </div>
        </div>

        <dl className="clipboard-meta-grid">
          <dt>{t('clipboard.type')}</dt>
          <dd>{kindLabel}</dd>
          <dt>{t('clipboard.fileName')}</dt>
          <dd title={metadata.name}>{metadata.name}</dd>
          <dt>MIME</dt>
          <dd>{metadata.mimeType}</dd>
          <dt>{t('clipboard.size')}</dt>
          <dd>{formatBytes(metadata.size)}</dd>
          <dt>{t('clipboard.dimensions')}</dt>
          <dd>{dimensionLabel}</dd>
          {!isImage && (
            <>
              <dt>{t('clipboard.duration')}</dt>
              <dd>{durationLabel}</dd>
            </>
          )}
          <dt>{t('clipboard.modified')}</dt>
          <dd>{dateLabel}</dd>
        </dl>

        <div className="clipboard-modal-actions">
          <button type="button" className="clipboard-btn secondary" onClick={onCancel}>{t('common.cancel')}</button>
          <button type="button" className="clipboard-btn primary" onClick={onConfirm}>{t('common.import')}</button>
        </div>
      </div>
    </div>
  )
}
