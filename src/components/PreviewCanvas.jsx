import React from 'react'
import { ImagePlus, Upload } from 'lucide-react'
import { t } from '../i18n.js'

export default function PreviewCanvas({ onChoose }) {
  return (
    <div className="empty-preview">
      <div className="placeholder-icon" aria-hidden="true"><ImagePlus size={30} /></div>
      <p>{t('app.noAsset')}</p>
      <button type="button" className="empty-preview-action" onClick={onChoose}>
        <Upload size={16} aria-hidden="true" />
        {t('app.importAsset')}
      </button>
    </div>
  )
}
