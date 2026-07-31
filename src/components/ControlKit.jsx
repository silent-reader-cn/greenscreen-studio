import React, { useId } from 'react'
import { CircleHelp } from 'lucide-react'

export function HelpButton({ label }) {
  if (!label) return null

  return (
    <button
      type="button"
      className="control-help"
      data-tip={label}
      title={label}
      aria-label={label}
      onClick={(event) => {
        event.preventDefault()
        event.stopPropagation()
      }}
    >
      <CircleHelp size={15} aria-hidden="true" />
    </button>
  )
}

export function ControlSection({ title, description, actions, children, className = '' }) {
  return (
    <section className={`control-section ${className}`.trim()}>
      {(title || description || actions) && (
        <header className="control-section-header">
          <div className="control-section-heading">
            {title && <h3>{title}</h3>}
            {description && <p>{description}</p>}
          </div>
          {actions && <div className="control-section-actions">{actions}</div>}
        </header>
      )}
      <div className="control-section-body">{children}</div>
    </section>
  )
}

export function ControlGrid({ children, columns = 2, className = '' }) {
  return (
    <div
      className={`control-grid control-grid-${columns} ${className}`.trim()}
      style={{ '--control-grid-columns': columns }}
    >
      {children}
    </div>
  )
}

export function ControlField({ label, hint, help, wide = false, children, className = '' }) {
  const inputId = useId()
  const labelledChildren = React.Children.map(children, child => {
    if (!React.isValidElement(child) || typeof child.type !== 'string') return child
    if (!['input', 'select', 'textarea'].includes(child.type)) return child
    return React.cloneElement(child, { id: child.props.id || inputId })
  })

  return (
    <div className={`control-field ${wide ? 'wide' : ''} ${className}`.trim()}>
      <span className="control-field-label">
        <label htmlFor={inputId}>{label}</label>
        <HelpButton label={help} />
      </span>
      <span className="control-field-input">{labelledChildren}</span>
      {hint && <small className="control-field-hint">{hint}</small>}
    </div>
  )
}

function normalizeNumber(raw, min, max, fallback) {
  const value = Number(raw)
  if (!Number.isFinite(value)) return fallback
  return Math.max(min, Math.min(max, Math.round(value)))
}

export function NumberField({
  label,
  value,
  onChange,
  min = 0,
  max = 9999,
  step = 1,
  suffix,
  hint,
  help,
  wide = false,
  disabled = false,
  className = '',
}) {
  return (
    <ControlField label={label} hint={hint} help={help} wide={wide} className={className}>
      <input
        type="number"
        value={value}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        aria-label={label}
        onChange={(event) => onChange(normalizeNumber(event.target.value, min, max, min))}
      />
      {suffix && <span className="control-input-suffix">{suffix}</span>}
    </ControlField>
  )
}

export function TextField({
  label,
  value,
  onChange,
  placeholder,
  hint,
  help,
  wide = false,
  disabled = false,
  className = '',
}) {
  return (
    <ControlField label={label} hint={hint} help={help} wide={wide} className={className}>
      <input
        type="text"
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        aria-label={label}
        onChange={(event) => onChange(event.target.value)}
      />
    </ControlField>
  )
}

export function SliderField({ label, value, min, max, step, unit = '', onChange }) {
  return (
    <label className="control-slider-field">
      <span className="control-slider-label">{label}</span>
      <input
        type="range"
        aria-label={label}
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      <output>{value}{unit}</output>
    </label>
  )
}

export function SegmentedControl({ label, value, options, onChange, columns, className = '' }) {
  return (
    <div
      className={`control-segments ${className}`.trim()}
      role="group"
      aria-label={label}
      style={columns ? { '--segment-columns': columns } : undefined}
    >
      {options.map(option => (
        <button
          key={option.value}
          type="button"
          className={value === option.value ? 'active' : ''}
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

export function ToggleField({ label, description, checked, disabled = false, onChange, help }) {
  return (
    <div className={`control-toggle ${disabled ? 'is-disabled' : ''}`}>
      <span className="control-toggle-copy">
        <span className="control-toggle-title">{label}</span>
        {description && <small>{description}</small>}
      </span>
      <HelpButton label={help} />
      <label className="control-toggle-switch" aria-label={label}>
        <input
          type="checkbox"
          checked={checked}
          disabled={disabled}
          onChange={(event) => onChange(event.target.checked)}
        />
        <span className="control-switch" aria-hidden="true" />
      </label>
    </div>
  )
}

export function ActionButton({ icon: Icon, tone = 'secondary', children, className = '', ...props }) {
  return (
    <button type="button" className={`control-action tone-${tone} ${className}`.trim()} {...props}>
      {Icon && <Icon size={15} aria-hidden="true" />}
      <span>{children}</span>
    </button>
  )
}

export function CompactIconButton({
  icon: Icon,
  label,
  tone = 'secondary',
  size = 'regular',
  className = '',
  title,
  ...props
}) {
  return (
    <button
      type="button"
      className={('compact-icon-action tone-' + tone + ' size-' + size + ' ' + className).trim()}
      aria-label={label}
      title={title || label}
      {...props}
    >
      {Icon && <Icon size={size === 'small' ? 15 : 17} aria-hidden="true" />}
    </button>
  )
}

export function ResponsiveActionButton({ mobile = false, icon, label, children, ...props }) {
  if (mobile) {
    return <CompactIconButton icon={icon} label={label || children} {...props} />
  }
  return <ActionButton icon={icon} {...props}>{children || label}</ActionButton>
}

export function CompactActionGroup({ children, className = '', label }) {
  return (
    <div className={('compact-action-group ' + className).trim()} role="group" aria-label={label}>
      {children}
    </div>
  )
}

export function StatusStrip({ items, className = '' }) {
  return (
    <div className={`control-status-strip ${className}`.trim()} aria-live="polite">
      {items.filter(Boolean).map((item, index) => (
        <span key={`${item.label}-${index}`} className={item.emphasis ? 'emphasis' : ''}>
          {item.label && <small>{item.label}</small>}
          <strong>{item.value}</strong>
        </span>
      ))}
    </div>
  )
}
