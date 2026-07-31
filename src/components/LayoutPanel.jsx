import React from 'react'
import { t } from '../i18n.js'
import { ControlGrid, ControlSection, HelpButton, NumberField, SegmentedControl, StatusStrip, ToggleField } from './ControlKit.jsx'

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
            <HelpButton label={t('layout.sourceCharacterHeightHint')} />
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
      <ControlSection title={t('layout.canvasSize')}>
        <ControlGrid>
          <NumberField label={t('layout.width')} value={params.canvasWidth} min={1} onChange={(value) => update('canvasWidth', value)} suffix="px" />
          <NumberField label={t('layout.height')} value={params.canvasHeight} min={1} onChange={(value) => update('canvasHeight', value)} suffix="px" />
        </ControlGrid>
        <SegmentedControl
          label={t('layout.canvasPresets')}
          columns={3}
          value={`${params.canvasWidth}x${params.canvasHeight}`}
          options={[
            { value: '1280x720', label: '1280×720' },
            { value: '1920x1080', label: '1920×1080' },
            { value: '1000x1000', label: '1000×1000' },
          ]}
          onChange={(value) => {
            const [canvasWidth, canvasHeight] = value.split('x').map(Number)
            onChange({ ...params, canvasWidth, canvasHeight })
          }}
        />
      </ControlSection>

      <ControlSection title={t('layout.characterSize')}>
        <ControlGrid>
          <NumberField label={t('layout.width')} value={params.personWidth} min={1} onChange={(value) => update('personWidth', value)} suffix="px" />
          <NumberField label={t('layout.height')} value={params.personHeight} min={1} onChange={(value) => update('personHeight', value)} suffix="px" />
        </ControlGrid>
        <NumberField
          label={t('layout.sourceCharacterHeight')}
          value={sourceCharacterHeight}
          min={0}
          max={9999}
          suffix="px"
          wide
          help={t('layout.sourceCharacterHeightHint')}
          className={canAutoDetectSourceCharacterHeight ? 'dblclick-label' : ''}
          onChange={(value) => update('sourceCharacterHeight', value)}
        />
        {canAutoDetectSourceCharacterHeight && (
          <button type="button" className="control-inline-action" onClick={onAutoDetectSourceCharacterHeight}>
            {t('layout.autoDetectSourceHeight')}
          </button>
        )}
      </ControlSection>

      <ControlSection title={t('layout.positioning')}>
        <ToggleField label={t('layout.autoCrop')} help={t('layout.autoCropHint')} checked={params.autoCrop !== false} onChange={(checked) => update('autoCrop', checked)} />
        <ToggleField label={t('layout.sourceCenterAnchor')} help={t('layout.sourceCenterAnchorHint')} checked={params.sourceCenterAnchor !== false} disabled={params.autoCrop === false} onChange={(checked) => update('sourceCenterAnchor', checked)} />
      </ControlSection>

      {imageSize.w > 0 && <StatusStrip items={[
        { label: t('layout.input'), value: `${imageSize.w}×${imageSize.h}` },
        { label: t('layout.scale'), value: `${previewScale != null ? `1:${previewScale.toFixed(3)}` : '—'}${sourceCharacterHeight > 0 ? ` · ${t('layout.scaleLocked')}` : ''}`, emphasis: true },
      ]} />}
    </section>
  )
}
