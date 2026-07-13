import React from 'react'
import CollapsiblePanel from './CollapsiblePanel.jsx'
import { t } from '../i18n.js'

const NumberInput = ({ label, value, onChange, min = 1, max = 9999 }) => (
  <div className="input-row">
    <label>{label}</label>
    <input
      type="number"
      value={value}
      min={min}
      max={max}
      onChange={(e) => onChange(Math.max(min, Math.min(max, Number(e.target.value) || min)))}
    />
  </div>
)

export default function LayoutPanel({ params, onChange, imageSize }) {
  const update = (key, val) => onChange({ ...params, [key]: val })
  const summary = `${params.canvasWidth}×${params.canvasHeight}`

  return (
    <CollapsiblePanel title={`📐 ${t('layout.title')}`} summary={summary}>
      <div className="layout-group">
        <p className="group-label">{t('layout.canvasSize')}</p>
        <div className="dual-input">
          <NumberInput
            label={t('layout.width')}
            value={params.canvasWidth}
            onChange={(v) => update('canvasWidth', v)}
          />
          <span className="x-sign">×</span>
          <NumberInput
            label={t('layout.height')}
            value={params.canvasHeight}
            onChange={(v) => update('canvasHeight', v)}
          />
        </div>
      </div>

      <div className="layout-group">
        <p className="group-label">{t('layout.characterSize')}</p>
        <div className="dual-input">
          <NumberInput
            label={t('layout.width')}
            value={params.personWidth}
            onChange={(v) => update('personWidth', v)}
          />
          <span className="x-sign">×</span>
          <NumberInput
            label={t('layout.height')}
            value={params.personHeight}
            onChange={(v) => update('personHeight', v)}
          />
        </div>
      </div>

      <div className="toggle-row">
        <label className="toggle-label">
          <input
            type="checkbox"
            checked={params.autoCrop !== false}
            onChange={(e) => update('autoCrop', e.target.checked)}
          />
          <span>{t('layout.autoCrop')}</span>
        </label>
        <p className="toggle-hint">{t('layout.autoCropHint')}</p>
      </div>

      {imageSize.w > 0 && (
        <div className="info-box">
          <p>{t('layout.input')}: {imageSize.w}×{imageSize.h}</p>
          <p>{t('layout.canvas')}: {params.canvasWidth}×{params.canvasHeight}</p>
          <p>{t('layout.characterBox')}: {params.personWidth}×{params.personHeight}</p>
          <p className="calc-result">
            {t('layout.scale')}: 1:{(Math.min(
              params.personWidth / imageSize.w,
              params.personHeight / imageSize.h
            )).toFixed(3)}
          </p>
          {params.autoCrop !== false && (
            <p className="calc-result" style={{color: '#666'}}>{t('layout.autoCropOn')}</p>
          )}
        </div>
      )}

      <div className="preset-row">
        <button className="btn-preset" onClick={() => onChange({ ...params, canvasWidth: 1280, canvasHeight: 720 })}>
          1280×720
        </button>
        <button className="btn-preset" onClick={() => onChange({ ...params, canvasWidth: 1920, canvasHeight: 1080 })}>
          1920×1080
        </button>
        <button className="btn-preset" onClick={() => onChange({ ...params, canvasWidth: 1000, canvasHeight: 1000 })}>
          1000×1000
        </button>
      </div>
    </CollapsiblePanel>
  )
}
