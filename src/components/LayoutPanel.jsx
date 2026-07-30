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

const MobileNumberField = ({ label, value, onChange, min = 1, max = 9999, suffix }) => (
  <label className="mobile-number-field">
    <span>{label}</span>
    <input
      type="number"
      value={value}
      min={min}
      max={max}
      aria-label={label}
      onChange={(event) => {
        const number = Number(event.target.value)
        onChange(Number.isFinite(number) ? Math.max(min, Math.min(max, Math.round(number))) : min)
      }}
    />
    {suffix && <small>{suffix}</small>}
  </label>
)

function MobileLayoutPanel({
  params,
  onChange,
  imageSize,
  sourceCharacterHeight,
  previewScale,
  canAutoDetectSourceCharacterHeight,
  onAutoDetectSourceCharacterHeight,
}) {
  const update = (key, value) => onChange({ ...params, [key]: value })
  const presets = [[1280, 720], [1920, 1080], [1000, 1000]]

  return (
    <section className="mobile-layout-panel" aria-label={t('layout.title')}>
      <section className="mobile-layout-section">
        <header className="mobile-section-heading"><strong>{t('layout.canvasSize')}</strong></header>
        <div className="mobile-dimension-row">
          <MobileNumberField label={t('layout.width')} value={params.canvasWidth} onChange={value => update('canvasWidth', value)} />
          <span className="mobile-dimension-sign" aria-hidden="true">×</span>
          <MobileNumberField label={t('layout.height')} value={params.canvasHeight} onChange={value => update('canvasHeight', value)} />
        </div>
        <div className="mobile-preset-grid" aria-label={t('layout.canvasSize')}>
          {presets.map(([width, height]) => (
            <button
              key={`${width}x${height}`}
              type="button"
              className={params.canvasWidth === width && params.canvasHeight === height ? 'active' : ''}
              onClick={() => onChange({ ...params, canvasWidth: width, canvasHeight: height })}
            >
              {width}×{height}
            </button>
          ))}
        </div>
      </section>

      <section className="mobile-layout-section">
        <header className="mobile-section-heading"><strong>{t('layout.characterSize')}</strong></header>
        <div className="mobile-dimension-row">
          <MobileNumberField label={t('layout.width')} value={params.personWidth} onChange={value => update('personWidth', value)} />
          <span className="mobile-dimension-sign" aria-hidden="true">×</span>
          <MobileNumberField label={t('layout.height')} value={params.personHeight} onChange={value => update('personHeight', value)} />
        </div>
      </section>

      <section className="mobile-layout-section mobile-layout-options">
        <div className="mobile-source-height">
          <div className="mobile-section-heading">
            <strong
              className={canAutoDetectSourceCharacterHeight ? 'dblclick-label' : ''}
              onDoubleClick={canAutoDetectSourceCharacterHeight ? onAutoDetectSourceCharacterHeight : undefined}
            >
              {t('layout.sourceCharacterHeight')}
            </strong>
            <ParameterHelp text={t('layout.sourceCharacterHeightHint')} />
          </div>
          <MobileNumberField label={t('layout.px')} suffix="px" value={sourceCharacterHeight} min={0} onChange={value => update('sourceCharacterHeight', value)} />
        </div>

        <label className="mobile-toggle-control">
          <span>{t('layout.autoCrop')}</span>
          <input type="checkbox" checked={params.autoCrop !== false} onChange={event => update('autoCrop', event.target.checked)} />
        </label>
        <label className="mobile-toggle-control">
          <span>{t('layout.sourceCenterAnchor')}</span>
          <input type="checkbox" checked={params.sourceCenterAnchor !== false} disabled={params.autoCrop === false} onChange={event => update('sourceCenterAnchor', event.target.checked)} />
        </label>
      </section>

      {imageSize.w > 0 && (
        <div className="mobile-layout-status" aria-live="polite">
          <span>{t('layout.input')} {imageSize.w}×{imageSize.h}</span>
          <strong>{t('layout.scale')} {previewScale != null ? `1:${previewScale.toFixed(3)}` : '—'}</strong>
        </div>
      )}
    </section>
  )
}

export default function LayoutPanel({
  params,
  onChange,
  imageSize,
  mobile = false,
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

  if (mobile) {
    return (
      <MobileLayoutPanel
        params={params}
        onChange={onChange}
        imageSize={imageSize}
        sourceCharacterHeight={sourceCharacterHeight}
        previewScale={previewScale}
        canAutoDetectSourceCharacterHeight={canAutoDetectSourceCharacterHeight}
        onAutoDetectSourceCharacterHeight={onAutoDetectSourceCharacterHeight}
      />
    )
  }

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
