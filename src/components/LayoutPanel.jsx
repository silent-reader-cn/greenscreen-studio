import React from 'react'
import CollapsiblePanel from './CollapsiblePanel.jsx'

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
    <CollapsiblePanel title="📐 布局参数" summary={summary}>
      <div className="layout-group">
        <p className="group-label">画布尺寸</p>
        <div className="dual-input">
          <NumberInput
            label="宽"
            value={params.canvasWidth}
            onChange={(v) => update('canvasWidth', v)}
          />
          <span className="x-sign">×</span>
          <NumberInput
            label="高"
            value={params.canvasHeight}
            onChange={(v) => update('canvasHeight', v)}
          />
        </div>
      </div>

      <div className="layout-group">
        <p className="group-label">人物尺寸（目标框）</p>
        <div className="dual-input">
          <NumberInput
            label="宽"
            value={params.personWidth}
            onChange={(v) => update('personWidth', v)}
          />
          <span className="x-sign">×</span>
          <NumberInput
            label="高"
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
          <span>自动裁剪透明边缘</span>
        </label>
        <p className="toggle-hint">裁掉绿幕区域，缩放基准为人物本身</p>
      </div>

      {imageSize.w > 0 && (
        <div className="info-box">
          <p>输入: {imageSize.w}×{imageSize.h}</p>
          <p>画布: {params.canvasWidth}×{params.canvasHeight}</p>
          <p>人物框: {params.personWidth}×{params.personHeight}</p>
          <p className="calc-result">
            缩放比: 1:{(Math.min(
              params.personWidth / imageSize.w,
              params.personHeight / imageSize.h
            )).toFixed(3)}
          </p>
          {params.autoCrop !== false && (
            <p className="calc-result" style={{color: '#666'}}>自动裁剪: 开启</p>
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
