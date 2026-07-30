import React from 'react'
import {
  Clapperboard,
  Download,
  Frame,
  Maximize2,
  Minimize2,
  SlidersHorizontal,
  Upload,
  WandSparkles,
} from 'lucide-react'
import { t } from '../i18n.js'

const TOOL_DEFINITIONS = [
  { id: 'source', icon: Upload, labelKey: 'app.workspaceSource' },
  { id: 'keying', icon: WandSparkles, labelKey: 'app.workspaceKeying' },
  { id: 'layout', icon: Frame, labelKey: 'app.workspaceLayout' },
  { id: 'review', icon: Clapperboard, labelKey: 'app.workspaceReview', videoOnly: true },
  { id: 'export', icon: Download, labelKey: 'app.workspaceExport' },
]

export default function WorkspaceSidebar({
  sheetRef,
  activeTool,
  mediaMode,
  mobileSheetState = 'half',
  mobileSheetDragging = false,
  onMobileSheetStateChange = () => {},
  onMobileSheetPointerDown = () => {},
  onMobileSheetPointerMove = () => {},
  onMobileSheetPointerUp = () => {},
  onMobileSheetHandleClick = () => {},
  onToolChange,
  children,
}) {
  const tools = TOOL_DEFINITIONS.filter(tool => !tool.videoOnly || mediaMode === 'video')
  const currentTool = tools.find(tool => tool.id === activeTool) || tools[0]
  const CurrentIcon = currentTool.icon || SlidersHorizontal

  return (
    <aside
      ref={sheetRef}
      className={`sidebar workspace-sidebar mobile-sheet-panel state-${mobileSheetState} ${mobileSheetDragging ? 'is-dragging' : ''}`}
      aria-label={t('app.workspaceNavLabel')}
    >
      <header className="mobile-sheet-handle">
        <button
          type="button"
          className="mobile-sheet-drag-target"
          onPointerDown={onMobileSheetPointerDown}
          onPointerMove={onMobileSheetPointerMove}
          onPointerUp={onMobileSheetPointerUp}
          onPointerCancel={onMobileSheetPointerUp}
          onClick={onMobileSheetHandleClick}
          aria-label={t('app.mobileSheetDragLabel')}
        >
          <span className="mobile-sheet-grip" aria-hidden="true" />
          <span className="mobile-sheet-current">
            <CurrentIcon size={17} strokeWidth={1.8} aria-hidden="true" />
            <strong>{t(currentTool.labelKey)}</strong>
            <small>{t(`app.mobileSheet${mobileSheetState[0].toUpperCase()}${mobileSheetState.slice(1)}`)}</small>
          </span>
        </button>
        <div className="mobile-sheet-actions">
          <button
            type="button"
            onClick={() => onMobileSheetStateChange('collapsed')}
            disabled={mobileSheetState === 'collapsed'}
            aria-label={t('app.mobileSheetCollapse')}
          >
            <Minimize2 size={17} aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={() => onMobileSheetStateChange(mobileSheetState === 'full' ? 'half' : 'full')}
            aria-label={mobileSheetState === 'full' ? t('app.mobileSheetHalf') : t('app.mobileSheetExpand')}
          >
            <Maximize2 size={17} aria-hidden="true" />
          </button>
        </div>
      </header>
      <nav className="workspace-rail" aria-label={t('app.workspaceNavLabel')}>
        {tools.map(({ id, icon: Icon, labelKey }) => {
          const active = id === currentTool.id
          const label = t(labelKey)
          return (
            <button
              key={id}
              type="button"
              className={`workspace-tool-btn ${active ? 'active' : ''}`}
              onClick={() => onToolChange(id)}
              aria-current={active ? 'page' : undefined}
              title={label}
            >
              <Icon size={19} strokeWidth={1.8} aria-hidden="true" />
              <span>{label}</span>
            </button>
          )
        })}
      </nav>

      <div className="workspace-inspector">
        <header className="workspace-inspector-header">
          <span className="workspace-inspector-icon" aria-hidden="true">
            <CurrentIcon size={17} strokeWidth={1.8} />
          </span>
          <h2>{t(currentTool.labelKey)}</h2>
          <span className={`workspace-media-badge mode-${mediaMode}`}>
            {mediaMode === 'video' ? t('app.video') : t('app.image')}
          </span>
        </header>

        <div className="workspace-panel-stack">{children}</div>
      </div>
    </aside>
  )
}
