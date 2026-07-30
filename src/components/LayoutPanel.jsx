import React from 'react'
import { CircleHelp } from 'lucide-react'
import { t } from '../i18n.js'

const NumberInput = ({ label, value, onChange, min = 1, max = 9999 }) => (
  <label className="input-row">
    <span>{label}</span>
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
  </label>
)

const ParameterHelp = ({ text }) => (
  <button
    type="button"
    className="parameter-help"
    data-tip={text}
    title={text}
    aria-label={text}
  >
    <CircleHelp size={14} aria-hidden="true" />
  </button>
)

export default function LayoutPanel({
  params,
  onChange,
  imageSize,
  canAutoDetectSourceCharacterHeight = false,
  onAutoDetectSourceCharacterHeight,
}) {
  const update = (key, val) => onChange({ ...params, [key]: val })
  const sourceCharacterHeight = Math.max(0, Math.round(Number(params.sourceCharacterHeight) || 0))
  const lockedScale = sourceCharacterHeight > 0
    ? params.personHeight / sourceCharacterHeight
    : null
  const fitScale = imageSize.w > 0 && imageSize.h > 0
    ? Math.min(params.personWidth / imageSize.w, params.personHeight / imageSize.h)
    : null
  const previewScale = lockedScale ?? fitScale

  return (
    <section className="parameter-panel layout-parameter-panel" aria-label={t('layout.title')}>
      <fieldset className="layout-group">
        <legend className="group-label">{t('layout.canvasSize')}</legend>
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
        <div className="preset-row" aria-label={t('layout.canvasSize')}>
          <button type="button" className="btn-preset" onClick={() => onChange({ ...params, canvasWidth: 1280, canvasHeight: 720 })}>
            1280×720
          </button>
          <button type="button" className="btn-preset" onClick={() => onChange({ ...params, canvasWidth: 1920, canvasHeight: 1080 })}>
            1920×1080
          </button>
          <button type="button" className="btn-preset" onClick={() => onChange({ ...params, canvasWidth: 1000, canvasHeight: 1000 })}>
            1000×1000
          </button>
        </div>
      </fieldset>

      <fieldset className="layout-group">
        <legend className="group-label">{t('layout.characterSize')}</legend>
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
      </fieldset>

      <div className="layout-group source-height-group">
        <div className="parameter-group-heading">
          <span
          className={`group-label ${canAutoDetectSourceCharacterHeight ? 'dblclick-label' : ''}`}
          title={canAutoDetectSourceCharacterHeight ? t('layout.sourceCharacterHeightAutoDetectTitle') : undefined}
          onDoubleClick={canAutoDetectSourceCharacterHeight ? onAutoDetectSourceCharacterHeight : undefined}
          >
            {t('layout.sourceCharacterHeight')}
          </span>
          <ParameterHelp text={t('layout.sourceCharacterHeightHint')} />
        </div>
        <NumberInput
          label={t('layout.px')}
          value={sourceCharacterHeight}
          min={0}
          max={9999}
          onChange={(v) => update('sourceCharacterHeight', v)}
        />
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
        <ParameterHelp text={t('layout.autoCropHint')} />
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
        <ParameterHelp text={t('layout.sourceCenterAnchorHint')} />
      </div>

      {imageSize.w > 0 && (
        <div className="layout-status" aria-live="polite">
          <span>{t('layout.input')}: {imageSize.w}×{imageSize.h}</span>
          <strong>
            {t('layout.scale')}: {previewScale != null ? `1:${previewScale.toFixed(3)}` : '—'}
            {sourceCharacterHeight > 0 ? ` (${t('layout.scaleLocked')})` : ''}
          </strong>
          {params.autoCrop !== false && (
            <span>{t('layout.autoCropOn')}</span>
          )}
          {params.autoCrop !== false && params.sourceCenterAnchor !== false && (
            <span>{t('layout.sourceCenterAnchorOn')}</span>
          )}
        </div>
      )}
    </section>
  )
}
