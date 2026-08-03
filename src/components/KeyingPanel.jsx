import React from 'react'
import { t } from '../i18n.js'
import { ControlSection, SliderField } from './ControlKit.jsx'

const ALGORITHM_IDS = ['classic', 'vlahos', 'chroma', 'saturation']

const toHex = (rgb) => `#${rgb.map(c => c.toString(16).padStart(2, '0')).join('')}`
const fromHex = (hex) => [
  parseInt(hex.slice(1, 3), 16),
  parseInt(hex.slice(3, 5), 16),
  parseInt(hex.slice(5, 7), 16),
]

function ColorField({ label, value, onChange }) {
  return (
    <label className="control-color-field">
      <span>{label}</span>
      <span className="control-color-input">
        <input
          type="color"
          aria-label={label}
          value={toHex(value)}
          onChange={(event) => onChange(fromHex(event.target.value))}
        />
        <output>{toHex(value).toUpperCase()}</output>
      </span>
    </label>
  )
}

export default function KeyingPanel({ mobile = false, params, onChange }) {
  const update = (key, val) => onChange({ ...params, [key]: val })
  const algorithm = ALGORITHM_IDS.includes(params.algorithm) ? params.algorithm : 'classic'
  const supportsGradient = algorithm !== 'classic'

  const algorithmSelect = (
    <select
      className="keying-algorithm-select"
      aria-label={t('keying.algorithm')}
      value={algorithm}
      onChange={(event) => update('algorithm', event.target.value)}
    >
      {ALGORITHM_IDS.map((id) => (
        <option key={id} value={id}>{t(`keying.algorithms.${id}`)}</option>
      ))}
    </select>
  )

  return (
    <section
      className={`parameter-panel keying-parameter-panel ${mobile ? 'mobile-keying-panel' : 'desktop-keying-panel'}`}
      aria-label={t('keying.title')}
    >
      <ControlSection title={t('keying.colorExtraction')} actions={algorithmSelect}>
        <ColorField
          label={t('keying.keyColor')}
          value={params.keyColor}
          onChange={(value) => update('keyColor', value)}
        />
        {supportsGradient && (
          <>
            <label className="control-toggle-field keying-gradient-toggle">
              <input
                type="checkbox"
                checked={params.gradientKey === true}
                onChange={(event) => update('gradientKey', event.target.checked)}
              />
              <span>{t('keying.gradientKey')}</span>
            </label>
            {params.gradientKey === true && (
              <ColorField
                label={t('keying.keyColor2')}
                value={params.keyColor2 || [0, 180, 0]}
                onChange={(value) => update('keyColor2', value)}
              />
            )}
          </>
        )}

        {algorithm === 'classic' && (
          <>
            <SliderField label={t('keying.tolerance')} value={params.tolerance} min={0} max={100} step={1} onChange={(value) => update('tolerance', value)} />
            <SliderField label={t('keying.spillSuppression')} value={params.spillSuppression} min={0} max={100} step={1} onChange={(value) => update('spillSuppression', value)} />
          </>
        )}

        {algorithm === 'vlahos' && (
          <>
            <SliderField label={t('keying.keyBalance')} value={params.keyBalance ?? 80} min={20} max={150} step={1} onChange={(value) => update('keyBalance', value)} />
            <SliderField label={t('keying.clipBlack')} value={params.clipBlack ?? 0} min={0} max={100} step={1} onChange={(value) => update('clipBlack', value)} />
            <SliderField label={t('keying.clipWhite')} value={params.clipWhite ?? 100} min={0} max={100} step={1} onChange={(value) => update('clipWhite', value)} />
            <SliderField label={t('keying.spillSuppression')} value={params.spillSuppression} min={0} max={100} step={1} onChange={(value) => update('spillSuppression', value)} />
          </>
        )}

        {algorithm === 'chroma' && (
          <>
            <SliderField label={t('keying.similarity')} value={params.similarity ?? 20} min={0} max={100} step={1} onChange={(value) => update('similarity', value)} />
            <SliderField label={t('keying.spill')} value={params.spill ?? 50} min={0} max={100} step={1} onChange={(value) => update('spill', value)} />
            <SliderField label={t('keying.spillSuppression')} value={params.spillSuppression} min={0} max={100} step={1} onChange={(value) => update('spillSuppression', value)} />
          </>
        )}

        {algorithm === 'saturation' && (
          <>
            <SliderField label={t('keying.keyBalance')} value={params.keyBalance ?? 50} min={0} max={100} step={1} onChange={(value) => update('keyBalance', value)} />
            <SliderField label={t('keying.clipBlack')} value={params.clipBlack ?? 0} min={0} max={100} step={1} onChange={(value) => update('clipBlack', value)} />
            <SliderField label={t('keying.clipWhite')} value={params.clipWhite ?? 100} min={0} max={100} step={1} onChange={(value) => update('clipWhite', value)} />
            <SliderField label={t('keying.spillSuppression')} value={params.spillSuppression} min={0} max={100} step={1} onChange={(value) => update('spillSuppression', value)} />
          </>
        )}
      </ControlSection>

      <ControlSection title={t('keying.edgeProcessing')}>
        <SliderField label={t('keying.feather')} value={params.feather} min={0} max={100} step={1} onChange={(value) => update('feather', value)} />
        <SliderField label={t('keying.edgeShrink')} value={params.edgeShrink} min={0} max={50} step={1} unit="px" onChange={(value) => update('edgeShrink', value)} />
      </ControlSection>
    </section>
  )
}
