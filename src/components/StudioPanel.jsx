import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, Copy, ExternalLink, Play, Plus, RefreshCw, Trash2, X } from 'lucide-react'
import { t } from '../i18n.js'
import { useAppDialog } from './AppDialog.jsx'

const MAX_LOGS = 80

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: options.body ? { 'Content-Type': 'application/json', ...(options.headers || {}) } : options.headers,
    ...options,
  })
  const text = await res.text()
  let data = null
  try { data = text ? JSON.parse(text) : null } catch { data = { raw: text } }
  if (!res.ok) {
    const err = new Error(data?.error || res.statusText || 'request failed')
    err.status = res.status
    err.data = data
    throw err
  }
  return data
}

function mergeLogs(current, additions) {
  const byId = new Map(current.map((log) => [log.id, log]))
  for (const log of additions || []) {
    if (log?.id) byId.set(log.id, log)
  }
  return [...byId.values()]
    .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp))
    .slice(-MAX_LOGS)
}

function formatTime(value) {
  if (!value) return '—'
  try {
    return new Date(value).toLocaleTimeString()
  } catch {
    return String(value)
  }
}

function ProjectDetail({ bundle, openingAssetId, onDelete, onOpenAsset, onPreviewAsset }) {
  if (!bundle) return <p className="studio-empty">{t('studio.selectProject')}</p>

  return (
    <>
      <div className="studio-detail-head">
        <div>
          <h3>{bundle.project.name}</h3>
          <p>{bundle.project.description || t('studio.noDescription')}</p>
        </div>
        <button type="button" className="studio-danger-btn studio-delete-project-btn" onClick={onDelete} aria-label={t('studio.delete')} title={t('studio.delete')}>
          <Trash2 size={15} aria-hidden="true" />
          <span>{t('studio.delete')}</span>
        </button>
      </div>
      <div className="studio-meta-grid">
        <span className="studio-meta-item"><small>{t('studio.characterName')}</small><strong>{bundle.project.characterName || '—'}</strong></span>
        <span className="studio-meta-item"><small>{t('studio.assets')}</small><strong>{bundle.assets?.length || 0}</strong></span>
        <span className="studio-meta-item"><small>{t('studio.updated')}</small><strong>{formatTime(bundle.project.updatedAt)}</strong></span>
      </div>
      <div className="studio-section">
        <h4>{t('studio.recentAssets')}</h4>
        {(bundle.assets || []).map((asset) => (
          <div key={asset.id} className="studio-row">
            <span>{asset.role}/{asset.kind}</span>
            <code title={asset.path}>{asset.originalName || asset.path}</code>
            {asset.kind === 'video' && (
              <div className="studio-asset-actions">
                <button type="button" className="studio-primary-btn studio-asset-open" onClick={() => onOpenAsset(asset)} disabled={Boolean(openingAssetId)} aria-label={openingAssetId === asset.id ? t('studio.openingVideo') : t('studio.openInVideoKeying')} title={openingAssetId === asset.id ? t('studio.openingVideo') : t('studio.openInVideoKeying')}>
                  <ExternalLink size={14} aria-hidden="true" />
                  <span>{openingAssetId === asset.id ? t('studio.openingVideo') : t('studio.openInVideoKeying')}</span>
                </button>
                <button type="button" className="studio-mini-btn studio-asset-icon-action" onClick={() => onPreviewAsset(asset)} aria-label={t('studio.previewAsset')} title={t('studio.previewAsset')}>
                  <Play size={14} aria-hidden="true" />
                  <span>{t('studio.previewAsset')}</span>
                </button>
              </div>
            )}
          </div>
        ))}
        {(bundle.assets || []).length === 0 && <p className="studio-empty">{t('studio.noAssets')}</p>}
      </div>
    </>
  )
}

export default function StudioPanel({ onOpenVideoAsset }) {
  const dialog = useAppDialog()
  const [open, setOpen] = useState(false)
  const [tab, setTab] = useState('projects') // projects | mcp
  const [projects, setProjects] = useState([])
  const [selectedId, setSelectedId] = useState('')
  const [expandedProjectId, setExpandedProjectId] = useState('')
  const [bundle, setBundle] = useState(null)
  const [mcpStatus, setMcpStatus] = useState({ connected: false, state: 'disconnected' })
  const [mcpConfig, setMcpConfig] = useState(null)
  const [logs, setLogs] = useState([])
  const [streamState, setStreamState] = useState('idle')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [newName, setNewName] = useState('')
  const [newCharacter, setNewCharacter] = useState('')
  const [copied, setCopied] = useState(false)
  const [previewAsset, setPreviewAsset] = useState(null)
  const [openingAssetId, setOpeningAssetId] = useState('')
  const logEndRef = useRef(null)

  const selected = useMemo(
    () => projects.find((p) => p.id === selectedId) || null,
    [projects, selectedId],
  )

  const refreshProjects = useCallback(async () => {
    const data = await api('/api/projects')
    setProjects(data.projects || [])
    if (!selectedId && data.projects?.[0]?.id) {
      setSelectedId(data.projects[0].id)
    }
  }, [selectedId])

  const refreshBundle = useCallback(async (projectId = selectedId) => {
    if (!projectId) {
      setBundle(null)
      return
    }
    const data = await api(`/api/projects/${projectId}`)
    setBundle(data)
  }, [selectedId])

  const refreshMcp = useCallback(async () => {
    const [status, config, logData] = await Promise.all([
      api('/api/mcp/status'),
      api('/api/mcp/config'),
      api('/api/mcp/logs?limit=80'),
    ])
    setMcpStatus(status)
    setMcpConfig(config)
    setLogs(logData.logs || [])
  }, [])

  const refreshAll = useCallback(async () => {
    setBusy(true)
    setError('')
    try {
      await Promise.all([refreshProjects(), refreshMcp()])
      if (selectedId) await refreshBundle(selectedId)
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }, [refreshProjects, refreshMcp, refreshBundle, selectedId])

  useEffect(() => {
    if (!open) return undefined
    void refreshAll()
  }, [open, refreshAll])

  useEffect(() => {
    if (!open || !selectedId) return undefined
    void refreshBundle(selectedId).catch((err) => setError(err.message))
  }, [open, selectedId, refreshBundle])

  useEffect(() => {
    if (!open) return undefined
    const source = new EventSource('/api/mcp/events')
    setStreamState('connecting')
    source.onopen = () => setStreamState('live')
    source.onerror = () => setStreamState('reconnecting')
    source.addEventListener('status', (event) => {
      try { setMcpStatus(JSON.parse(event.data)) } catch { /* ignore */ }
    })
    source.addEventListener('log', (event) => {
      try {
        const entry = JSON.parse(event.data)
        setLogs((prev) => mergeLogs(prev, [entry]))
      } catch { /* ignore */ }
    })
    source.addEventListener('logs', (event) => {
      try {
        const payload = JSON.parse(event.data)
        setLogs((prev) => mergeLogs(prev, payload.logs || []))
      } catch { /* ignore */ }
    })
    source.addEventListener('data-changed', () => {
      void refreshProjects()
      if (selectedId) void refreshBundle(selectedId)
    })
    return () => source.close()
  }, [open, refreshProjects, refreshBundle, selectedId])

  useEffect(() => {
    const logList = logEndRef.current?.parentElement
    if (logList) logList.scrollTop = logList.scrollHeight
  }, [logs, open, tab])

  const handleCreateProject = async () => {
    if (!newName.trim()) return
    setBusy(true)
    setError('')
    try {
      const project = await api('/api/projects', {
        method: 'POST',
        body: JSON.stringify({
          name: newName.trim(),
          characterName: newCharacter.trim(),
        }),
      })
      setNewName('')
      setNewCharacter('')
      await refreshProjects()
      setSelectedId(project.id)
      setExpandedProjectId(project.id)
      setTab('projects')
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  const handleDeleteProject = async () => {
    if (!selectedId) return
    if (!await dialog.confirm(t('studio.deleteConfirm', { name: selected?.name || selectedId }), {
      title: t('studio.delete'),
      tone: 'danger',
    })) return
    setBusy(true)
    try {
      await api(`/api/projects/${selectedId}`, { method: 'DELETE' })
      setExpandedProjectId('')
      setSelectedId('')
      setBundle(null)
      await refreshProjects()
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  const handleProjectToggle = (projectId) => {
    if (expandedProjectId === projectId) {
      setExpandedProjectId('')
      return
    }
    if (projectId !== selectedId) setBundle(null)
    setSelectedId(projectId)
    setExpandedProjectId(projectId)
  }

  const handleOpenVideoAsset = async (asset) => {
    if (!selectedId || !onOpenVideoAsset || openingAssetId) return
    setOpeningAssetId(asset.id)
    setError('')
    try {
      const response = await fetch(`/api/projects/${selectedId}/assets/${asset.id}/content`)
      if (!response.ok) throw new Error(t('studio.openVideoFailed'))
      const blob = await response.blob()
      const type = blob.type || asset.mimeType || 'video/mp4'
      const file = new File([blob], asset.originalName || 'project-video.mp4', {
        type,
        lastModified: Date.parse(asset.createdAt) || Date.now(),
      })
      setPreviewAsset(null)
      setOpen(false)
      onOpenVideoAsset({
        file,
        projectId: selectedId,
        assetId: asset.id,
        asset,
      })
    } catch (err) {
      setError(err.message || t('studio.openVideoFailed'))
    } finally {
      setOpeningAssetId('')
    }
  }

  const copyMcpConfig = async () => {
    const text = mcpConfig?.formats?.json || ''
    if (!text) return
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch (err) {
      setError(err.message)
    }
  }

  useEffect(() => {
    if (!open) return undefined

    const handleKeyDown = (event) => {
      if (event.key === 'Escape') setOpen(false)
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [open])

  return (
    <>
      <button
        type="button"
        className={`studio-toggle ${open ? 'active' : ''}`}
        onClick={() => setOpen((v) => !v)}
        title={t('studio.panelTitle')}
      >
        {t('studio.panelShort')}
        <span className={`studio-dot ${mcpStatus.connected ? 'on' : 'off'}`} />
      </button>

      {open && (
        <>
          <div className="studio-drawer-backdrop" aria-hidden="true" onClick={() => setOpen(false)} />
          <div className="studio-drawer" role="dialog" aria-modal="true" aria-label={t('studio.panelTitle')}>
          <div className="studio-drawer-header">
            <div>
              <strong>{t('studio.panelTitle')}</strong>
              <p className="studio-sub">
                {t('studio.stream')}: {streamState}
                {' · '}
                MCP {mcpStatus.connected ? t('studio.connected') : t('studio.disconnected')}
                {mcpStatus.lastTool ? ` · ${mcpStatus.lastTool}` : ''}
              </p>
            </div>
            <div className="studio-header-actions">
              <button type="button" className="studio-mini-btn studio-icon-btn" onClick={() => void refreshAll()} disabled={busy} aria-label={t('studio.refresh')} title={t('studio.refresh')}>
                <RefreshCw size={15} aria-hidden="true" />
                <span>{t('studio.refresh')}</span>
              </button>
              <button type="button" className="studio-mini-btn studio-icon-btn" onClick={() => setOpen(false)} aria-label={t('studio.close')} title={t('studio.close')}>
                <X size={16} aria-hidden="true" />
                <span>{t('studio.close')}</span>
              </button>
            </div>
          </div>

          <div className="studio-tabs" role="tablist" aria-label={t('studio.panelTitle')}>
            <button type="button" role="tab" aria-selected={tab === 'projects'} className={tab === 'projects' ? 'active' : ''} onClick={() => setTab('projects')}>
              {t('studio.tabProjects')}
            </button>
            <button type="button" role="tab" aria-selected={tab === 'mcp'} className={tab === 'mcp' ? 'active' : ''} onClick={() => setTab('mcp')}>
              {t('studio.tabMcp')}
            </button>
          </div>

          {error && <p className="studio-error">{error}</p>}

          {tab === 'projects' && (
            <div className="studio-body studio-body-projects">
              <div className="studio-create-row studio-project-create">
                <input
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder={t('studio.projectName')}
                />
                <input
                  value={newCharacter}
                  onChange={(e) => setNewCharacter(e.target.value)}
                  placeholder={t('studio.characterName')}
                />
                <button type="button" className="studio-primary-btn studio-create-project-btn" onClick={() => void handleCreateProject()} disabled={busy} aria-label={t('studio.create')} title={t('studio.create')}>
                  <Plus size={15} aria-hidden="true" />
                  <span>{t('studio.create')}</span>
                </button>
              </div>

              <div className="studio-split">
                <div className="studio-list">
                  {projects.length === 0 && <p className="studio-empty">{t('studio.noProjects')}</p>}
                  {projects.map((project) => {
                    const expanded = project.id === expandedProjectId
                    const summary = project.description || project.characterName || t('studio.noDescription')
                    return (
                      <article key={project.id} className={`studio-project-item ${expanded ? 'expanded' : ''}`}>
                        <button
                          type="button"
                          className={`studio-list-item ${project.id === selectedId ? 'active' : ''}`}
                          aria-expanded={expanded}
                          aria-controls={`studio-project-${project.id}`}
                          onClick={() => handleProjectToggle(project.id)}
                        >
                          <span className="studio-project-summary">
                            <strong>{project.name}</strong>
                            <span>{summary}</span>
                          </span>
                          <span className="studio-project-updated">
                            <small>{formatTime(project.updatedAt)}</small>
                            <ChevronDown size={15} aria-hidden="true" />
                          </span>
                        </button>
                        {expanded && project.id === selectedId && (
                          <div id={`studio-project-${project.id}`} className="studio-project-expanded studio-detail">
                            <ProjectDetail
                              bundle={bundle}
                              openingAssetId={openingAssetId}
                              onDelete={() => void handleDeleteProject()}
                              onOpenAsset={(asset) => void handleOpenVideoAsset(asset)}
                              onPreviewAsset={setPreviewAsset}
                            />
                          </div>
                        )}
                      </article>
                    )
                  })}
                </div>

                <div className="studio-detail studio-desktop-detail">
                  <ProjectDetail
                    bundle={bundle}
                    openingAssetId={openingAssetId}
                    onDelete={() => void handleDeleteProject()}
                    onOpenAsset={(asset) => void handleOpenVideoAsset(asset)}
                    onPreviewAsset={setPreviewAsset}
                  />
                </div>
              </div>
            </div>
          )}

          {tab === 'mcp' && (
            <div className="studio-body studio-body-mcp">
              <div className="studio-meta-grid">
                <span className="studio-meta-item"><small>{t('studio.status')}</small><strong className={mcpStatus.connected ? 'ok' : ''}>{mcpStatus.connected ? t('studio.connected') : t('studio.disconnected')}</strong></span>
                <span className="studio-meta-item"><small>{t('studio.sessions')}</small><strong>{mcpStatus.activeSessionCount || 0}</strong></span>
                <span className="studio-meta-item"><small>{t('studio.lastTool')}</small><strong>{mcpStatus.lastTool || '—'}</strong></span>
                <span className="studio-meta-item"><small>{t('studio.lastSeen')}</small><strong>{formatTime(mcpStatus.lastSeenAt)}</strong></span>
              </div>

              <div className="studio-section">
                <div className="studio-detail-head">
                  <h4>{t('studio.mcpConfig')}</h4>
                </div>
                <div className="studio-code-wrap">
                  <pre className="studio-code">{mcpConfig?.formats?.json || t('studio.loading')}</pre>
                  <button type="button" className="studio-mini-btn studio-copy-config-btn" onClick={() => void copyMcpConfig()}>
                    <Copy size={14} aria-hidden="true" />
                    <span>{copied ? t('studio.copied') : t('studio.copyJson')}</span>
                  </button>
                </div>
              </div>

              <div className="studio-section">
                <h4>{t('studio.liveLogs')}</h4>
                <div className="studio-logs">
                  {logs.map((log) => (
                    <div key={log.id} className={`studio-log level-${log.level || 'info'}`}>
                      <span>{formatTime(log.timestamp)}</span>
                      <strong>{log.tool || log.type || 'event'}</strong>
                      <p>{log.message}</p>
                    </div>
                  ))}
                  {logs.length === 0 && <p className="studio-empty">{t('studio.noLogs')}</p>}
                  <div ref={logEndRef} />
                </div>
              </div>
            </div>
          )}
          </div>
        </>
      )}

      {previewAsset && selectedId && (
        <div className="studio-media-modal" role="dialog" aria-modal="true" aria-label={t('studio.assetPreviewTitle')}>
          <div className="studio-media-backdrop" onClick={() => setPreviewAsset(null)} />
          <div className="studio-media-dialog">
            <div className="studio-detail-head">
              <div>
                <h3>{previewAsset.originalName || previewAsset.path}</h3>
                <p>{previewAsset.role}/{previewAsset.kind}</p>
              </div>
              <button type="button" className="studio-mini-btn" onClick={() => setPreviewAsset(null)}>
                {t('studio.close')}
              </button>
            </div>
            {previewAsset.kind === 'video' ? (
              <video className="studio-media-player" controls playsInline src={`/api/projects/${selectedId}/assets/${previewAsset.id}/content`} />
            ) : (
              <img className="studio-media-image" src={`/api/projects/${selectedId}/assets/${previewAsset.id}/content`} alt={previewAsset.originalName || t('studio.assetPreviewTitle')} />
            )}
            <div className="studio-media-actions">
              {previewAsset.kind === 'video' && (
                <button type="button" className="studio-primary-btn" onClick={() => void handleOpenVideoAsset(previewAsset)} disabled={Boolean(openingAssetId)}>
                  {openingAssetId === previewAsset.id ? t('studio.openingVideo') : t('studio.openInVideoKeying')}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  )
}
