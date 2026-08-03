import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, Layers3, Minus, Pencil, Plus, RefreshCw, Repeat2, Save, Trash2, X } from 'lucide-react'
import { t } from '../i18n.js'
import SemanticMarkerEditor from './SemanticMarkerEditor.jsx'
import { useAppDialog } from './AppDialog.jsx'
import { ActionButton, CompactActionGroup, CompactIconButton, ToggleField } from './ControlKit.jsx'
import { CheckBadge, EmptyState, MetaItem, ReviewComposer, ReviewField, ReviewPane, StatusBadge } from './ReviewKit.jsx'
import {
  availableClipStatuses,
  buildClipStatusTransition,
  buildCreateClipPayload,
  buildUpdateClipPayload,
  expandSelectionRange,
  isClipEditable,
  sortClipsForTimeline,
  suggestClipName,
  updateClipSelection,
} from '../lib/actionReviewClips.js'

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

function statusLabel(status) {
  return t(`review.status.${status}`)
}

/**
 * Persistent, expandable slice list for a project source video asset.
 * Create / edit / delete against /api/projects/:id/clips.
 */
export default function ActionClipReviewPanel({
  projectId,
  assetId,
  sourceLabel = '',
  range = null,
  totalFrames = 0,
  selectedClipIds = [],
  onSelectionChange,
  onClipsChange,
  onMarkersChange,
  onApplyClipRange,
  videoJobId = '',
  keyingParams = {},
  layoutParams = {},
  region = null,
  previewFrame = null,
  onSeekRequest,
  disabled = false,
  mobile = false,
}) {
  const dialog = useAppDialog()
  const [clips, setClips] = useState([])
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [nameDraft, setNameDraft] = useState('')
  const [loopDraft, setLoopDraft] = useState(false)
  const [composerOpen, setComposerOpen] = useState(() => !mobile)
  const [anchorId, setAnchorId] = useState(null)
  const [editingId, setEditingId] = useState('')
  const [editName, setEditName] = useState('')
  // Once the user edits (or clears) the name field, stop auto-filling suggestions.
  const nameTouchedRef = useRef(false)

  const orderedClips = useMemo(() => sortClipsForTimeline(clips), [clips])
  const selectedSet = useMemo(() => new Set(selectedClipIds.map(String)), [selectedClipIds])
  const primarySelected = orderedClips.find((clip) => selectedSet.has(String(clip.id))) || null

  useEffect(() => {
    if (!primarySelected) onMarkersChange?.([])
  }, [onMarkersChange, primarySelected])

  const refresh = useCallback(async () => {
    if (!projectId || !assetId) {
      setClips([])
      onClipsChange?.([])
      return
    }
    setLoading(true)
    setError('')
    try {
      const data = await api(`/api/projects/${projectId}/clips?assetId=${encodeURIComponent(assetId)}`)
      const next = sortClipsForTimeline(data.clips || [])
      setClips(next)
      onClipsChange?.(next)
    } catch (err) {
      setError(err.message || t('review.loadFailed'))
    } finally {
      setLoading(false)
    }
  }, [assetId, onClipsChange, projectId])

  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => {
    if (!nameTouchedRef.current && !nameDraft && sourceLabel) {
      setNameDraft(suggestClipName(sourceLabel, (clips?.length || 0) + 1))
    }
  }, [clips?.length, nameDraft, sourceLabel])

  const emitSelection = useCallback((ids, nextAnchor = anchorId) => {
    setAnchorId(nextAnchor)
    onSelectionChange?.(ids)
  }, [anchorId, onSelectionChange])

  const handleSelect = useCallback((clip, event) => {
    if (!clip?.id) return
    const id = String(clip.id)
    let next
    if (event?.shiftKey) {
      next = expandSelectionRange(orderedClips, anchorId || id, id)
    } else if (event?.metaKey || event?.ctrlKey) {
      next = updateClipSelection(selectedClipIds, id, { mode: 'toggle' })
    } else if (selectedClipIds.length === 1 && selectedSet.has(id)) {
      next = []
    } else {
      next = updateClipSelection(selectedClipIds, id, { mode: 'replace' })
    }
    emitSelection(next, id)
    if (next.includes(id) && !event?.shiftKey && !event?.metaKey && !event?.ctrlKey) {
      onApplyClipRange?.(clip)
    }
  }, [anchorId, emitSelection, onApplyClipRange, orderedClips, selectedClipIds, selectedSet])

  const handleCreate = useCallback(async () => {
    if (!projectId || !assetId || busy) return
    const built = buildCreateClipPayload({
      assetId,
      name: nameDraft,
      startFrame: range?.startFrame ?? 0,
      endFrame: range?.endFrame,
      loop: loopDraft,
      totalFrames: totalFrames || null,
    })
    if (!built.ok) {
      const map = {
        asset_required: t('review.assetRequired'),
        name_required: t('review.nameRequired'),
        range_invalid: t('review.rangeInvalid'),
        start_out_of_video: t('review.rangeOutOfVideo'),
        end_out_of_video: t('review.rangeOutOfVideo'),
      }
      setError(map[built.error] || built.error)
      return
    }
    setBusy(true)
    setError('')
    try {
      const clip = await api(`/api/projects/${projectId}/clips`, {
        method: 'POST',
        body: JSON.stringify(built.payload),
      })
      setNameDraft(suggestClipName(sourceLabel || clip.name, (clips.length || 0) + 2))
      await refresh()
      emitSelection([clip.id], clip.id)
      onApplyClipRange?.(clip)
    } catch (err) {
      setError(err.message || t('review.createFailed'))
    } finally {
      setBusy(false)
    }
  }, [
    assetId,
    busy,
    clips.length,
    emitSelection,
    loopDraft,
    nameDraft,
    onApplyClipRange,
    projectId,
    range,
    refresh,
    sourceLabel,
    totalFrames,
  ])

  const handleApplyRangeToClip = useCallback(async (clip) => {
    if (!projectId || !clip || !range || busy) return
    const built = buildUpdateClipPayload(
      { startFrame: range.startFrame, endFrame: range.endFrame },
      { current: clip, totalFrames: totalFrames || null },
    )
    if (!built.ok) {
      setError(built.error === 'range_invalid' ? t('review.rangeInvalid') : t('review.rangeOutOfVideo'))
      return
    }
    setBusy(true)
    setError('')
    try {
      await api(`/api/projects/${projectId}/clips/${clip.id}`, {
        method: 'PATCH',
        body: JSON.stringify(built.payload),
      })
      await refresh()
    } catch (err) {
      setError(err.data?.code === 'CLIP_RANGE_EXCLUDES_MARKERS'
        ? t('review.rangeExcludesMarkers')
        : (err.message || t('review.updateFailed')))
    } finally {
      setBusy(false)
    }
  }, [busy, projectId, range, refresh, totalFrames])

  const handleRename = useCallback(async (clip) => {
    if (!projectId || !clip || busy) return
    const built = buildUpdateClipPayload({ name: editName }, { current: clip })
    if (!built.ok) {
      setError(t('review.nameRequired'))
      return
    }
    setBusy(true)
    setError('')
    try {
      await api(`/api/projects/${projectId}/clips/${clip.id}`, {
        method: 'PATCH',
        body: JSON.stringify(built.payload),
      })
      setEditingId('')
      await refresh()
    } catch (err) {
      setError(err.message || t('review.updateFailed'))
    } finally {
      setBusy(false)
    }
  }, [busy, editName, projectId, refresh])

  const handleToggleLoop = useCallback(async (clip) => {
    if (!projectId || !clip || busy) return
    setBusy(true)
    setError('')
    try {
      await api(`/api/projects/${projectId}/clips/${clip.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ loop: !clip.loop }),
      })
      await refresh()
    } catch (err) {
      setError(err.message || t('review.updateFailed'))
    } finally {
      setBusy(false)
    }
  }, [busy, projectId, refresh])

  const handleStatusChange = useCallback(async (clip, nextStatus) => {
    if (!projectId || !clip || busy) return
    const built = buildClipStatusTransition(clip.status, nextStatus)
    if (!built.ok) {
      setError(t('review.statusTransitionInvalid'))
      return
    }
    setBusy(true)
    setError('')
    try {
      if (nextStatus === 'approved') {
        const report = await api('/api/video/review-checks', {
          method: 'POST',
          body: JSON.stringify({
            jobId: videoJobId,
            clipId: clip.id,
            params: { keying: keyingParams, layout: layoutParams, region },
          }),
        })
        if (report.summary?.warningCount > 0 && !await dialog.confirm(t('review.checks.confirmWarnings', {
          count: report.summary.warningCount,
        }), { title: t('review.checks.title'), tone: 'warning' })) {
          await refresh()
          return
        }
      }
      await api(`/api/projects/${projectId}/clips/${clip.id}`, {
        method: 'PATCH',
        body: JSON.stringify(built.payload),
      })
      await refresh()
    } catch (err) {
      setError(err.message || t('review.statusTransitionFailed'))
    } finally {
      setBusy(false)
    }
  }, [busy, dialog, keyingParams, layoutParams, projectId, refresh, region, videoJobId])

  const handleDeleteClip = useCallback(async (clip) => {
    if (!projectId || !clip?.id || busy) return
    if (!await dialog.confirm(t('review.deleteConfirm', { count: 1, names: clip.name }), {
      title: t('review.deleteClip'),
      tone: 'danger',
    })) return
    setBusy(true)
    setError('')
    try {
      await api(`/api/projects/${projectId}/clips/${clip.id}`, { method: 'DELETE' })
      emitSelection(selectedClipIds.filter((id) => String(id) !== String(clip.id)), null)
      await refresh()
    } catch (err) {
      setError(err.message || t('review.deleteFailed'))
    } finally {
      setBusy(false)
    }
  }, [busy, dialog, emitSelection, projectId, refresh, selectedClipIds])

  if (!projectId || !assetId) {
    return (
      <div className={'review-workspace review-workspace-empty ' + (mobile ? 'is-mobile' : 'is-desktop')}>
        <EmptyState title={t('review.title')} description={t('review.needProjectVideo')} />
      </div>
    )
  }

  const rangeStart = range?.startFrame ?? 0
  const rangeEnd = Math.max(0, (range?.endFrame ?? 0) - 1)

  const clipList = (
    <div className="review-clip-list" aria-label={t('review.clipList')}>
      {orderedClips.length === 0 && !loading && <EmptyState compact title={t('review.empty')} description={t('review.emptyHint')} />}
      {orderedClips.map((clip) => {
        const selected = selectedSet.has(String(clip.id))
        const primary = String(primarySelected?.id || '') === String(clip.id)
        const panelId = `review-clip-${clip.id}`
        return (
          <article key={clip.id} className={'review-clip-item ' + (selected ? 'selected ' : '') + (primary ? 'primary' : '')}>
            <button
              type="button"
              className="review-clip-summary"
              aria-expanded={primary}
              aria-controls={panelId}
              onClick={(event) => handleSelect(clip, event)}
            >
              <span className="review-clip-index" aria-hidden="true">{String(orderedClips.indexOf(clip) + 1).padStart(2, '0')}</span>
              <span className="review-clip-item-copy">
                <strong title={clip.name}>{clip.name}</strong>
              </span>
              <span className="review-clip-side">
                <StatusBadge status={clip.status}>{statusLabel(clip.status)}</StatusBadge>
                <ChevronDown className="review-clip-chevron" size={18} aria-hidden="true" />
              </span>
              <span className="review-clip-meta">
                <MetaItem label={t('review.frames')} value={clip.startFrame + '–' + Math.max(clip.startFrame, clip.endFrame - 1)} />
                <MetaItem label={t('review.duration')} value={Math.max(0, clip.endFrame - clip.startFrame)} />
                <MetaItem label={t('review.loop')} value={clip.loop ? t('common.yes') : t('common.no')} />
                <MetaItem label={t('review.version')} value={'v' + clip.version} />
              </span>
            </button>
            {primary && (
              <div id={panelId} className="review-clip-expanded">
                <div className="review-detail-summary">
                  {clip.reviewChecks?.checks && (
                    <div className="review-checks" aria-label={t('review.checks.title')}>
                      {clip.reviewChecks.checks.map((item) => <CheckBadge key={item.id} status={item.status}>{t('review.checks.' + item.id)}: {t('review.checks.status.' + item.status)}</CheckBadge>)}
                    </div>
                  )}
                  {editingId === clip.id ? (
                    <form className="review-rename-form" onSubmit={(event) => {
                      event.preventDefault()
                      void handleRename(clip)
                    }}>
                      <ReviewField label={t('review.name')} wide><input autoFocus value={editName} onChange={(event) => setEditName(event.target.value)} disabled={busy || !isClipEditable(clip.status)} /></ReviewField>
                      <div className="review-rename-actions">
                        <ActionButton icon={Save} tone="primary" type="submit" disabled={busy}>{t('review.saveName')}</ActionButton>
                        <ActionButton icon={X} onClick={() => setEditingId('')} disabled={busy}>{t('review.cancelEdit')}</ActionButton>
                      </div>
                    </form>
                  ) : (
                    <div className="review-clip-toolbar">
                      <label className="review-clip-status-control">
                        <span>{t('review.statusLabel')}</span>
                        <select className="review-status-select" aria-label={t('review.statusControl', { name: clip.name })} value={clip.status} onChange={(event) => void handleStatusChange(clip, event.target.value)} disabled={busy || availableClipStatuses(clip.status).length === 0}>
                          <option value={clip.status}>{statusLabel(clip.status)}</option>
                          {availableClipStatuses(clip.status).map((status) => <option key={status} value={status}>{statusLabel(status)}</option>)}
                        </select>
                      </label>
                      <CompactActionGroup className="review-clip-tool-actions" label={t('review.clipActions')}>
                        {isClipEditable(clip.status) && (
                          <>
                            <CompactIconButton size="small" icon={Pencil} label={t('review.rename')} onClick={() => {
                              setEditingId(clip.id)
                              setEditName(clip.name)
                            }} disabled={busy} />
                            <CompactIconButton size="small" icon={Repeat2} label={clip.loop ? t('review.unloop') : t('review.loop')} onClick={() => void handleToggleLoop(clip)} disabled={busy} />
                            <CompactIconButton size="small" icon={Layers3} label={t('review.updateRange')} onClick={() => void handleApplyRangeToClip(clip)} disabled={disabled || busy || !range} title={t('review.updateRangeHint')} />
                          </>
                        )}
                        <CompactIconButton size="small" icon={Trash2} label={t('review.deleteClip')} tone="danger" onClick={() => void handleDeleteClip(clip)} disabled={disabled || busy} />
                      </CompactActionGroup>
                    </div>
                  )}
                </div>
                <SemanticMarkerEditor projectId={projectId} clip={clip} mobile={mobile} disabled={disabled || busy || !isClipEditable(clip.status)} onMarkersChange={onMarkersChange} previewFrame={previewFrame} onSeekRequest={onSeekRequest} />
              </div>
            )}
          </article>
        )
      })}
    </div>
  )

  return (
    <div className={'review-workspace ' + (mobile ? 'is-mobile' : 'is-desktop')}>
      {error && <p className="review-clip-error" role="alert">{error}</p>}
      <div className="review-workspace-grid">
        <ReviewPane
          className="review-slices-pane"
          title={t('review.clipList')}
          count={orderedClips.length}
          description={t('review.listHint')}
          actions={(
            <>
              {mobile && (
                <CompactIconButton
                  size="small"
                  icon={composerOpen ? Minus : Plus}
                  label={t('review.createFromTimeline')}
                  onClick={() => setComposerOpen((v) => !v)}
                  aria-expanded={composerOpen}
                />
              )}
              <CompactIconButton
                size="small"
                icon={RefreshCw}
                label={loading ? t('review.loading') : t('review.refresh')}
                onClick={() => void refresh()}
                disabled={loading || busy}
              />
            </>
          )}
        >
          {(!mobile || composerOpen) && (
          <ReviewComposer title={t('review.createFromTimeline')} actions={
            <>
              <ToggleField label={t('review.loop')} checked={loopDraft} onChange={setLoopDraft} disabled={disabled || busy} />
              <ActionButton icon={Save} tone="primary" onClick={() => void handleCreate()} disabled={disabled || busy || !range || !(range.endFrame > range.startFrame)} aria-label={t('review.createFromRange', { start: rangeStart, end: rangeEnd })} title={t('review.createFromRange', { start: rangeStart, end: rangeEnd })}>{t('review.saveClip')}</ActionButton>
            </>
          }>
            <ReviewField label={t('review.name')} wide><input type="text" value={nameDraft} placeholder={t('review.namePlaceholder')} onChange={(event) => { nameTouchedRef.current = true; setNameDraft(event.target.value) }} disabled={disabled || busy} /></ReviewField>
          </ReviewComposer>
          )}
          {clipList}
        </ReviewPane>
      </div>
    </div>
  )
}
