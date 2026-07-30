import React from 'react'
import { Ruler } from 'lucide-react'
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
      onChange={(e) => {
        const raw = e.target.value
        if (raw === '' || raw === '-') {
          onChange(min)
          return
        }
        const n = Number(raw)
        if (!Number.isFinite(n)) {
          onChange(min)
          return
        }
        onChange(Math.max(min, Math.min(max, Math.round(n))))
      }}
    />
  </div>
)

export default function LayoutPanel({
  params,
  onChange,
  imageSize,
  canAutoDetectSourceCharacterHeight = false,
  onAutoDetectSourceCharacterHeight,
}) {
  const update = (key, val) => onChange({ ...params, [key]: val })
  const summary = `${params.canvasWidth}×${params.canvasHeight}`
  const sourceCharacterHeight = Math.max(0, Math.round(Number(params.sourceCharacterHeight) || 0))
  const lockedScale = sourceCharacterHeight > 0
    ? params.personHeight / sourceCharacterHeight
    : null
  const fitScale = imageSize.w > 0 && imageSize.h > 0
    ? Math.min(params.personWidth / imageSize.w, params.personHeight / imageSize.h)
    : null
  const previewScale = lockedScale ?? fitScale

  return (
    <CollapsiblePanel
      title={<span className="panel-title-content"><Ruler size={15} />{t('layout.title')}</span>}
      summary={summary}
    >
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

      <div className="layout-group">
        <p
          className={`group-label ${canAutoDetectSourceCharacterHeight ? 'dblclick-label' : ''}`}
          title={canAutoDetectSourceCharacterHeight ? t('layout.sourceCharacterHeightAutoDetectTitle') : undefined}
          onDoubleClick={canAutoDetectSourceCharacterHeight ? onAutoDetectSourceCharacterHeight : undefined}
        >
          {t('layout.sourceCharacterHeight')}
        </p>
        <NumberInput
          label={t('layout.px')}
          value={sourceCharacterHeight}
          min={0}
          max={9999}
          onChange={(v) => update('sourceCharacterHeight', v)}
        />
        <p className="toggle-hint">{t('layout.sourceCharacterHeightHint')}</p>
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

      <div className="toggle-row">
        <label className="toggle-label">
          <input
            type="checkbox"
            checked={params.sourceCenterAnchor !== false}
            disabled={params.autoCrop === false}
            onChange={(e) => update('sourceCenterAnchor', e.target.checked)}
          />
          <span>{t('layout.sourceCenterAnchor')}</span>
        </label>
        <p className="toggle-hint">{t('layout.sourceCenterAnchorHint')}</p>
      </div>

      {imageSize.w > 0 && (
        <div className="info-box">
          <p>{t('layout.input')}: {imageSize.w}×{imageSize.h}</p>
          <p>{t('layout.canvas')}: {params.canvasWidth}×{params.canvasHeight}</p>
          <p>{t('layout.characterBox')}: {params.personWidth}×{params.personHeight}</p>
          {sourceCharacterHeight > 0 && (
            <p>{t('layout.sourceCharacterHeight')}: {sourceCharacterHeight}px</p>
          )}
          <p className="calc-result">
            {t('layout.scale')}: {previewScale != null ? `1:${previewScale.toFixed(3)}` : '—'}
            {sourceCharacterHeight > 0 ? ` (${t('layout.scaleLocked')})` : ''}
          </p>
          {params.autoCrop !== false && (
            <p className="calc-result calc-result-muted">{t('layout.autoCropOn')}</p>
          )}
          {params.autoCrop !== false && params.sourceCenterAnchor !== false && (
            <p className="calc-result calc-result-muted">{t('layout.sourceCenterAnchorOn')}</p>
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
