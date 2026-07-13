import React from 'react'
import { t } from '../i18n.js'

export default function PreviewCanvas() {
  return (
    <div className="empty-preview">
      <div className="placeholder-icon">🖼️</div>
      <p>{t('preview.emptyImage')}</p>
      <p className="hint">{t('preview.emptyImageHint')}</p>
    </div>
  )
}
