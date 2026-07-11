import React, { useState } from 'react'

export default function CollapsiblePanel({
  title,
  summary,
  defaultCollapsed = false,
  className = '',
  children,
}) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed)

  return (
    <section className={`panel collapsible-panel ${collapsed ? 'collapsed' : ''} ${className}`}>
      <button
        type="button"
        className="panel-toggle"
        onClick={() => setCollapsed(value => !value)}
        aria-expanded={!collapsed}
      >
        <span className="panel-title">{title}</span>
        {summary && <span className="panel-summary">{summary}</span>}
        <span className="panel-caret" aria-hidden="true">{collapsed ? '▸' : '▾'}</span>
      </button>

      {!collapsed && (
        <div className="panel-body">
          {children}
        </div>
      )}
    </section>
  )
}
