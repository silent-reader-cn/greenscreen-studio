import React from 'react'
import CollapsiblePanel from './CollapsiblePanel.jsx'
import { t } from '../i18n.js'

const Slider = ({ label, value, min, max, step, unit, onChange }) => (
  <div className="slider-row">
    <label>{label}</label>
    <div className="slider-control">
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <span className="slider-value">{value}{unit}</span>
    </div>
  </div>
)

export default function KeyingPanel({ params, onChange }) {
  const update = (key, val) => onChange({ ...params, [key]: val })
  const summary = t('keying.summary', { tolerance: params.tolerance, feather: params.feather })

  return (
    <CollapsiblePanel title={`🎨 ${t('keying.title')}`} summary={summary}>
      <div className="color-row">
        <label>{t('keying.keyColor')}</label>
        <input
          type="color"
          value={`#${params.keyColor.map(c => c.toString(16).padStart(2, '0')).join('')}`}
          onChange={(e) => {
            const hex = e.target.value
            const r = parseInt(hex.slice(1, 3), 16)
            const g = parseInt(hex.slice(3, 5), 16)
            const b = parseInt(hex.slice(5, 7), 16)
            update('keyColor', [r, g, b])
          }}
        />
      </div>

      <Slider
        label={t('keying.tolerance')}
        value={params.tolerance}
        min={0} max={100} step={1} unit=""
        onChange={(v) => update('tolerance', v)}
      />
      <Slider
        label={t('keying.spillSuppression')}
        value={params.spillSuppression}
        min={0} max={100} step={1} unit=""
        onChange={(v) => update('spillSuppression', v)}
      />
      <Slider
        label={t('keying.feather')}
        value={params.feather}
        min={0} max={100} step={1} unit=""
        onChange={(v) => update('feather', v)}
      />
      <Slider
        label={t('keying.edgeShrink')}
        value={params.edgeShrink}
        min={0} max={50} step={1} unit="px"
        onChange={(v) => update('edgeShrink', v)}
      />

      <button
        className="btn-reset"
        onClick={() => onChange({
          keyColor: [0, 255, 0],
          tolerance: 30,
          spillSuppression: 40,
          feather: 15,
          edgeShrink: 0,
        })}
      >{t('keying.reset')}</button>
    </CollapsiblePanel>
  )
}
