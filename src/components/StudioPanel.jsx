import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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

export default function StudioPanel({ onOpenVideoAsset }) {
  const dialog = useAppDialog()
  const [open, setOpen] = useState(false)
  const [tab, setTab] = useState('projects') // projects | collab | mcp
  const [projects, setProjects] = useState([])
  const [selectedId, setSelectedId] = useState('')
  const [bundle, setBundle] = useState(null)
  const [mcpStatus, setMcpStatus] = useState({ connected: false, state: 'disconnected' })
  const [mcpConfig, setMcpConfig] = useState(null)
  const [logs, setLogs] = useState([])
  const [streamState, setStreamState] = useState('idle')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [newName, setNewName] = useState('')
  const [newCharacter, setNewCharacter] = useState('')
  const [taskTitle, setTaskTitle] = useState('')
  const [taskDesc, setTaskDesc] = useState('')
  const [messageBody, setMessageBody] = useState('')
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
    logEndRef.current?.scrollIntoView?.({ block: 'end' })
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
      setSelectedId('')
      setBundle(null)
      await refreshProjects()
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  const handleCreateTask = async () => {
    if (!selectedId || !taskTitle.trim()) return
    setBusy(true)
    try {
      await api(`/api/projects/${selectedId}/tasks`, {
        method: 'POST',
        body: JSON.stringify({
          title: taskTitle.trim(),
          description: taskDesc.trim(),
          assignee: 'ai',
          priority: 'normal',
        }),
      })
      setTaskTitle('')
      setTaskDesc('')
      await refreshBundle(selectedId)
      setTab('collab')
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  const handleInspectAsset = async (asset) => {
    if (!selectedId || busy) return
    setBusy(true)
    setError('')
    try {
      const label = asset.originalName || asset.path
      await api(`/api/projects/${selectedId}/tasks`, {
        method: 'POST',
        body: JSON.stringify({
          title: t('studio.inspectAssetTask', { name: label }),
          description: t('studio.inspectAssetDescription', { name: label }),
          assignee: 'ai',
          priority: 'normal',
          payload: { assetId: asset.id, assetKind: asset.kind },
        }),
      })
      await refreshBundle(selectedId)
      setPreviewAsset(null)
      setTab('collab')
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
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

  const handlePostMessage = async () => {
    if (!selectedId || !messageBody.trim()) return
    setBusy(true)
    try {
      await api(`/api/projects/${selectedId}/messages`, {
        method: 'POST',
        body: JSON.stringify({
          author: 'human',
          body: messageBody.trim(),
        }),
      })
      setMessageBody('')
      await refreshBundle(selectedId)
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  const handleCompleteTask = async (taskId) => {
    setBusy(true)
    try {
      await api(`/api/collab/tasks/${taskId}/complete`, {
        method: 'POST',
        body: JSON.stringify({
          status: 'done',
          author: 'human',
          message: t('studio.taskMarkedDone'),
        }),
      })
      await refreshBundle(selectedId)
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
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
              <button type="button" className="studio-mini-btn" onClick={() => void refreshAll()} disabled={busy}>
                {t('studio.refresh')}
              </button>
              <button type="button" className="studio-mini-btn" onClick={() => setOpen(false)}>
                {t('studio.close')}
              </button>
            </div>
          </div>

          <div className="studio-tabs">
            <button type="button" className={tab === 'projects' ? 'active' : ''} onClick={() => setTab('projects')}>
              {t('studio.tabProjects')}
            </button>
            <button type="button" className={tab === 'collab' ? 'active' : ''} onClick={() => setTab('collab')}>
              {t('studio.tabCollab')}
            </button>
            <button type="button" className={tab === 'mcp' ? 'active' : ''} onClick={() => setTab('mcp')}>
              {t('studio.tabMcp')}
            </button>
          </div>

          {error && <p className="studio-error">{error}</p>}

          {tab === 'projects' && (
            <div className="studio-body">
              <div className="studio-create-row">
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
                <button type="button" className="studio-primary-btn" onClick={() => void handleCreateProject()} disabled={busy}>
                  {t('studio.create')}
                </button>
              </div>

              <div className="studio-split">
                <div className="studio-list">
                  {projects.length === 0 && <p className="studio-empty">{t('studio.noProjects')}</p>}
                  {projects.map((project) => (
                    <button
                      key={project.id}
                      type="button"
                      className={`studio-list-item ${project.id === selectedId ? 'active' : ''}`}
                      onClick={() => setSelectedId(project.id)}
                    >
                      <strong>{project.name}</strong>
                      <span>{project.characterName || project.id.slice(0, 12)}</span>
                    </button>
                  ))}
                </div>

                <div className="studio-detail">
                  {!bundle ? (
                    <p className="studio-empty">{t('studio.selectProject')}</p>
                  ) : (
                    <>
                      <div className="studio-detail-head">
                        <div>
                          <h3>{bundle.project.name}</h3>
                          <p>{bundle.project.description || t('studio.noDescription')}</p>
                        </div>
                        <button type="button" className="studio-danger-btn" onClick={() => void handleDeleteProject()}>
                          {t('studio.delete')}
                        </button>
                      </div>
                      <div className="studio-meta-grid">
                        <span>{t('studio.characterName')}</span>
                        <strong>{bundle.project.characterName || '—'}</strong>
                        <span>{t('studio.assets')}</span>
                        <strong>{bundle.assets?.length || 0}</strong>
                        <span>{t('studio.tasks')}</span>
                        <strong>{bundle.tasks?.length || 0}</strong>
                        <span>{t('studio.updated')}</span>
                        <strong>{formatTime(bundle.project.updatedAt)}</strong>
                      </div>
                      <div className="studio-section">
                        <h4>{t('studio.recentAssets')}</h4>
                        {(bundle.assets || []).slice(0, 8).map((asset) => (
                          <div key={asset.id} className="studio-row">
                            <span>{asset.role}/{asset.kind}</span>
                            <code title={asset.path}>{asset.originalName || asset.path}</code>
                            {asset.kind === 'video' && (
                              <div className="studio-asset-actions">
                                <button type="button" className="studio-primary-btn" onClick={() => void handleOpenVideoAsset(asset)} disabled={Boolean(openingAssetId)}>
                                  {openingAssetId === asset.id ? t('studio.openingVideo') : t('studio.openInVideoKeying')}
                                </button>
                                <button type="button" className="studio-mini-btn" onClick={() => setPreviewAsset(asset)}>
                                  {t('studio.previewAsset')}
                                </button>
                                <button type="button" className="studio-mini-btn" onClick={() => void handleInspectAsset(asset)} disabled={busy}>
                                  {t('studio.inspectAsset')}
                                </button>
                              </div>
                            )}
                          </div>
                        ))}
                        {(bundle.assets || []).length === 0 && <p className="studio-empty">{t('studio.noAssets')}</p>}
                      </div>
                    </>
                  )}
                </div>
              </div>
            </div>
          )}

          {tab === 'collab' && (
            <div className="studio-body">
              {!selectedId ? (
                <p className="studio-empty">{t('studio.selectProject')}</p>
              ) : (
                <>
                  <div className="studio-create-col">
                    <input
                      value={taskTitle}
                      onChange={(e) => setTaskTitle(e.target.value)}
                      placeholder={t('studio.taskTitle')}
                    />
                    <textarea
                      value={taskDesc}
                      onChange={(e) => setTaskDesc(e.target.value)}
                      placeholder={t('studio.taskDescription')}
                      rows={2}
                    />
                    <button type="button" className="studio-primary-btn" onClick={() => void handleCreateTask()} disabled={busy}>
                      {t('studio.createTask')}
                    </button>
                  </div>

                  <div className="studio-section">
                    <h4>{t('studio.openTasks')}</h4>
                    {(bundle?.tasks || []).filter((task) => !['done', 'cancelled'].includes(task.status)).map((task) => (
                      <div key={task.id} className="studio-task">
                        <div>
                          <strong>{task.title}</strong>
                          <p>{task.description || t('studio.noDescription')}</p>
                          <span className="studio-chip">{task.status} · {task.assignee} · {task.priority}</span>
                        </div>
                        {task.status !== 'done' && (
                          <button type="button" className="studio-mini-btn" onClick={() => void handleCompleteTask(task.id)}>
                            {t('studio.markDone')}
                          </button>
                        )}
                      </div>
                    ))}
                    {(bundle?.tasks || []).filter((task) => !['done', 'cancelled'].includes(task.status)).length === 0 && (
                      <p className="studio-empty">{t('studio.noTasks')}</p>
                    )}
                  </div>

                  <div className="studio-section">
                    <h4>{t('studio.messages')}</h4>
                    <div className="studio-messages">
                      {(bundle?.messages || []).map((msg) => (
                        <div key={msg.id} className="studio-message">
                          <strong>{msg.author}</strong>
                          <span>{formatTime(msg.createdAt)}</span>
                          <p>{msg.body}</p>
                        </div>
                      ))}
                      {(bundle?.messages || []).length === 0 && <p className="studio-empty">{t('studio.noMessages')}</p>}
                    </div>
                    <div className="studio-create-row">
                      <input
                        value={messageBody}
                        onChange={(e) => setMessageBody(e.target.value)}
                        placeholder={t('studio.messagePlaceholder')}
                      />
                      <button type="button" className="studio-primary-btn" onClick={() => void handlePostMessage()} disabled={busy}>
                        {t('studio.send')}
                      </button>
                    </div>
                  </div>
                </>
              )}
            </div>
          )}

          {tab === 'mcp' && (
            <div className="studio-body">
              <div className="studio-meta-grid">
                <span>{t('studio.status')}</span>
                <strong className={mcpStatus.connected ? 'ok' : ''}>
                  {mcpStatus.connected ? t('studio.connected') : t('studio.disconnected')}
                </strong>
                <span>{t('studio.sessions')}</span>
                <strong>{mcpStatus.activeSessionCount || 0}</strong>
                <span>{t('studio.lastTool')}</span>
                <strong>{mcpStatus.lastTool || '—'}</strong>
                <span>{t('studio.lastSeen')}</span>
                <strong>{formatTime(mcpStatus.lastSeenAt)}</strong>
              </div>

              <div className="studio-section">
                <div className="studio-detail-head">
                  <h4>{t('studio.mcpConfig')}</h4>
                  <button type="button" className="studio-mini-btn" onClick={() => void copyMcpConfig()}>
                    {copied ? t('studio.copied') : t('studio.copyJson')}
                  </button>
                </div>
                <pre className="studio-code">{mcpConfig?.formats?.json || t('studio.loading')}</pre>
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
              <button type="button" className="studio-mini-btn" onClick={() => void handleInspectAsset(previewAsset)} disabled={busy}>
                {t('studio.inspectAsset')}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
