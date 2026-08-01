import React from 'react'
import { t } from '../i18n.js'
import { ControlSection, SliderField } from './ControlKit.jsx'

export default function KeyingPanel({ mobile = false, params, onChange }) {
  const update = (key, val) => onChange({ ...params, [key]: val })
  return (
    <section
      className={`parameter-panel keying-parameter-panel ${mobile ? 'mobile-keying-panel' : 'desktop-keying-panel'}`}
      aria-label={t('keying.title')}
    >
      <ControlSection title={t('keying.colorExtraction')}>
        <label className="control-color-field">
          <span>{t('keying.keyColor')}</span>
          <span className="control-color-input">
            <input
              type="color"
              aria-label={t('keying.keyColor')}
              value={`#${params.keyColor.map(c => c.toString(16).padStart(2, '0')).join('')}`}
              onChange={(event) => {
                const hex = event.target.value
                update('keyColor', [
                  parseInt(hex.slice(1, 3), 16),
                  parseInt(hex.slice(3, 5), 16),
                  parseInt(hex.slice(5, 7), 16),
                ])
              }}
            />
            <output>{`#${params.keyColor.map(c => c.toString(16).padStart(2, '0')).join('').toUpperCase()}`}</output>
          </span>
        </label>
        <SliderField label={t('keying.tolerance')} value={params.tolerance} min={0} max={100} step={1} onChange={(value) => update('tolerance', value)} />
        <SliderField label={t('keying.spillSuppression')} value={params.spillSuppression} min={0} max={100} step={1} onChange={(value) => update('spillSuppression', value)} />
      </ControlSection>

      <ControlSection title={t('keying.edgeProcessing')}>
        <SliderField label={t('keying.feather')} value={params.feather} min={0} max={100} step={1} onChange={(value) => update('feather', value)} />
        <SliderField label={t('keying.edgeShrink')} value={params.edgeShrink} min={0} max={50} step={1} unit="px" onChange={(value) => update('edgeShrink', value)} />
      </ControlSection>
    </section>
  )
}
