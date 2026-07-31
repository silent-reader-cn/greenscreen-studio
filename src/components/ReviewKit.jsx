import React, { useId } from 'react'
import { Check, CircleAlert, Minus, Plus } from 'lucide-react'
import { ActionButton } from './ControlKit.jsx'

export function ReviewHeader({ title, source, range, actions, mobile = false }) {
  return (
    <header className="review-workspace-header">
      <div className="review-workspace-heading">
        <span className="review-eyebrow">{title}</span>
        <strong title={source}>{source}</strong>
        {mobile && range}
      </div>
      {!mobile && range}
      <div className="review-workspace-header-actions">{actions}</div>
    </header>
  )
}

export function ReviewPane({ title, count, description, actions, children, className = '', as = 'section' }) {
  const Component = as
  return (
    <Component className={('review-pane ' + className).trim()}>
      {(title || description || actions) && (
        <header className="review-pane-header">
          <div className="review-pane-heading">
            <div className="review-pane-title-row">
              {title && <h3>{title}</h3>}
              {Number.isFinite(count) && <CountBadge>{count}</CountBadge>}
            </div>
            {description && <p>{description}</p>}
          </div>
          {actions && <div className="review-pane-actions">{actions}</div>}
        </header>
      )}
      <div className="review-pane-body">{children}</div>
    </Component>
  )
}

export function ReviewComposer({ title, range, children, actions }) {
  return (
    <section className="review-composer">
      <header className="review-composer-header">
        <strong>{title}</strong>
        {range}
      </header>
      <div className="review-composer-fields">{children}</div>
      {actions && <div className="review-composer-actions">{actions}</div>}
    </section>
  )
}

export function ReviewField({ label, children, wide = false, className = '' }) {
  const id = useId()
  const content = React.Children.map(children, (child) => (
    React.isValidElement(child) && typeof child.type === 'string' && ['input', 'select', 'textarea'].includes(child.type)
      ? React.cloneElement(child, { id: child.props.id || id })
      : child
  ))
  return (
    <div className={('review-field ' + (wide ? 'is-wide ' : '') + className).trim()}>
      <label htmlFor={id}>{label}</label>
      <div className="review-field-control">{content}</div>
    </div>
  )
}

export function ReviewRange({ start, end, label, compact = false }) {
  return (
    <span className={('review-range ' + (compact ? 'is-compact' : '')).trim()}>
      {label && <small>{label}</small>}
      <strong>{start}–{end}</strong>
    </span>
  )
}

export function CountBadge({ children }) {
  return <span className="review-count">{children}</span>
}

export function StatusBadge({ status, children }) {
  return <span className={'review-status status-' + status}>{children}</span>
}

export function MetaItem({ label, value }) {
  return (
    <span className="review-meta-item">
      <small>{label}</small>
      <strong>{value}</strong>
    </span>
  )
}

export function CheckBadge({ status, children }) {
  const Icon = status === 'pass' ? Check : status === 'warning' ? CircleAlert : Minus
  return (
    <span className={'review-check-badge status-' + status}>
      <Icon size={12} aria-hidden="true" />
      <span>{children}</span>
    </span>
  )
}

export function ReviewToolbar({ summary, children, mobile = false }) {
  return (
    <div className={'review-toolbar ' + (mobile ? 'is-mobile' : '')}>
      <span className="review-toolbar-summary">{summary}</span>
      <div className="review-toolbar-actions">{children}</div>
    </div>
  )
}

export function EmptyState({ title, description, action, compact = false }) {
  return (
    <div className={'review-empty ' + (compact ? 'is-compact' : '')}>
      <span className="review-empty-icon" aria-hidden="true"><Plus size={16} /></span>
      <div><strong>{title}</strong>{description && <p>{description}</p>}</div>
      {action}
    </div>
  )
}

export function ReviewIconAction({ label, icon, tone = 'secondary', ...props }) {
  return <ActionButton icon={icon} tone={tone} aria-label={label} title={label} {...props}>{label}</ActionButton>
}
