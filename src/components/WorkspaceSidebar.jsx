import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Clapperboard,
  Download,
  Frame,
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
  const dragRef = useRef(null)
  const initialWidth = useMemo(() => {
    if (typeof window === 'undefined') return 480
    const saved = Number(window.localStorage?.getItem('greenscreen.desktopSidebarWidth'))
    const viewportMaximum = Math.min(640, window.innerWidth * 0.52)
    if (Number.isFinite(saved) && saved >= 420 && saved <= 640) {
      return Math.round(Math.max(420, Math.min(viewportMaximum, saved)))
    }
    return Math.max(420, Math.min(580, Math.round(window.innerWidth * 0.39)))
  }, [])
  const [desktopWidth, setDesktopWidth] = useState(initialWidth)

  const clampDesktopWidth = useCallback((value) => {
    const viewportWidth = typeof window === 'undefined' ? 1440 : window.innerWidth
    return Math.round(Math.max(420, Math.min(Math.min(640, viewportWidth * 0.52), value)))
  }, [])

  useEffect(() => {
    const onPointerMove = (event) => {
      if (!dragRef.current) return
      setDesktopWidth(clampDesktopWidth(dragRef.current.width + event.clientX - dragRef.current.x))
    }
    const onPointerUp = () => {
      if (!dragRef.current) return
      dragRef.current = null
      document.body.classList.remove('workspace-resizing')
    }
    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', onPointerUp)
    return () => {
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerup', onPointerUp)
      document.body.classList.remove('workspace-resizing')
    }
  }, [clampDesktopWidth])

  useEffect(() => {
    if (window.innerWidth <= 900) return
    window.localStorage?.setItem('greenscreen.desktopSidebarWidth', String(desktopWidth))
  }, [desktopWidth])

  useEffect(() => {
    const onResize = () => {
      if (window.innerWidth <= 900) return
      setDesktopWidth(width => clampDesktopWidth(width))
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [clampDesktopWidth])

  return (
    <aside
      ref={sheetRef}
      className={`sidebar workspace-sidebar mobile-sheet-panel state-${mobileSheetState} ${mobileSheetDragging ? 'is-dragging' : ''}`}
      aria-label={t('app.workspaceNavLabel')}
      style={{ '--workspace-sidebar-width': `${desktopWidth}px` }}
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
          <span className="mobile-sheet-grip-wrap" aria-hidden="true">
            <span className="mobile-sheet-grip" />
          </span>
          <span className="visually-hidden">
            {t(currentTool.labelKey)} · {t(`app.mobileSheet${mobileSheetState[0].toUpperCase()}${mobileSheetState.slice(1)}`)}
          </span>
        </button>
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
      <div
        className="workspace-resize-handle"
        role="separator"
        aria-label={t('app.resizeWorkspace')}
        aria-orientation="vertical"
        aria-valuemin={420}
        aria-valuemax={640}
        aria-valuenow={desktopWidth}
        tabIndex={0}
        onPointerDown={(event) => {
          if (window.innerWidth <= 900) return
          event.preventDefault()
          dragRef.current = { x: event.clientX, width: desktopWidth }
          document.body.classList.add('workspace-resizing')
        }}
        onKeyDown={(event) => {
          if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
          event.preventDefault()
          setDesktopWidth(width => clampDesktopWidth(width + (event.key === 'ArrowRight' ? 16 : -16)))
        }}
      />
    </aside>
  )
}
