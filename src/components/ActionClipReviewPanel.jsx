import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { Layers3, ListChecks, Pencil, RefreshCw, Repeat2, Save, Trash2, UploadCloud, X } from 'lucide-react'
import { t } from '../i18n.js'
import SemanticMarkerEditor from './SemanticMarkerEditor.jsx'
import { useAppDialog } from './AppDialog.jsx'
import { ActionButton, ToggleField } from './ControlKit.jsx'
import { CheckBadge, EmptyState, MetaItem, ReviewComposer, ReviewField, ReviewHeader, ReviewPane, ReviewRange, ReviewToolbar, StatusBadge } from './ReviewKit.jsx'
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
 * Persistent action-clip review list for a project source video asset.
 * Create / edit / delete / multi-select against /api/projects/:id/clips.
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
  const [anchorId, setAnchorId] = useState(null)
  const [editingId, setEditingId] = useState('')
  const [editName, setEditName] = useState('')
  const [selectionMode, setSelectionMode] = useState(false)

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
    if (!nameDraft && sourceLabel) {
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
    if (mobile && selectionMode) {
      next = updateClipSelection(selectedClipIds, id, { mode: 'toggle' })
    } else if (event?.shiftKey) {
      next = expandSelectionRange(orderedClips, anchorId || id, id)
    } else if (event?.metaKey || event?.ctrlKey) {
      next = updateClipSelection(selectedClipIds, id, { mode: 'toggle' })
    } else {
      next = updateClipSelection(selectedClipIds, id, { mode: 'replace' })
    }
    emitSelection(next, id)
    if (!selectionMode && !event?.shiftKey && !event?.metaKey && !event?.ctrlKey) {
      onApplyClipRange?.(clip)
    }
  }, [anchorId, emitSelection, mobile, onApplyClipRange, orderedClips, selectedClipIds, selectionMode])

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

  const handleApplyRangeToSelected = useCallback(async () => {
    if (!projectId || !primarySelected || !range || busy) return
    const built = buildUpdateClipPayload(
      { startFrame: range.startFrame, endFrame: range.endFrame },
      { current: primarySelected, totalFrames: totalFrames || null },
    )
    if (!built.ok) {
      setError(built.error === 'range_invalid' ? t('review.rangeInvalid') : t('review.rangeOutOfVideo'))
      return
    }
    setBusy(true)
    setError('')
    try {
      await api(`/api/projects/${projectId}/clips/${primarySelected.id}`, {
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
  }, [busy, primarySelected, projectId, range, refresh, totalFrames])

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

  const handleQueueExportTask = useCallback(async (clip) => {
    if (!projectId || !clip || busy) return
    setBusy(true)
    setError('')
    try {
      await api(`/api/projects/${projectId}/clips/${clip.id}/export-task`, {
        method: 'POST',
        body: JSON.stringify({}),
      })
      await refresh()
    } catch (err) {
      setError(err.message || t('review.exportTaskFailed'))
    } finally {
      setBusy(false)
    }
  }, [busy, projectId, refresh])

  const handleDeleteSelected = useCallback(async () => {
    if (!projectId || selectedClipIds.length === 0 || busy) return
    const names = orderedClips
      .filter((clip) => selectedSet.has(String(clip.id)))
      .map((clip) => clip.name)
      .join(', ')
    if (!await dialog.confirm(t('review.deleteConfirm', { count: selectedClipIds.length, names }), {
      title: t('review.deleteSelected'),
      tone: 'danger',
    })) return
    setBusy(true)
    setError('')
    try {
      for (const id of selectedClipIds) {
        await api(`/api/projects/${projectId}/clips/${id}`, { method: 'DELETE' })
      }
      emitSelection([], null)
      await refresh()
    } catch (err) {
      setError(err.message || t('review.deleteFailed'))
    } finally {
      setBusy(false)
    }
  }, [busy, dialog, emitSelection, orderedClips, projectId, refresh, selectedClipIds, selectedSet])

  if (!projectId || !assetId) {
    return (
      <div className={'review-workspace review-workspace-empty ' + (mobile ? 'is-mobile' : 'is-desktop')}>
        <EmptyState title={t('review.title')} description={t('review.needProjectVideo')} />
      </div>
    )
  }

  const rangeStart = range?.startFrame ?? 0
  const rangeEnd = Math.max(0, (range?.endFrame ?? 0) - 1)
  const rangeBadge = <ReviewRange label={t('review.timelineRange')} start={rangeStart} end={rangeEnd} compact={mobile} />
  const selectionSummary = selectedClipIds.length > 0
    ? t('review.selectedCount', { count: selectedClipIds.length })
    : (mobile ? t('review.touchSelectHint') : t('review.selectHint'))

  const clipList = (
    <div className="review-clip-list" role="listbox" aria-multiselectable="true" aria-label={t('review.title')}>
      {orderedClips.length === 0 && !loading && <EmptyState compact title={t('review.empty')} description={t('review.emptyHint')} />}
      {orderedClips.map((clip) => {
        const selected = selectedSet.has(String(clip.id))
        const primary = String(primarySelected?.id || '') === String(clip.id)
        return (
          <div key={clip.id} role="option" tabIndex={0} aria-selected={selected} className={'review-clip-item ' + (selected ? 'selected ' : '') + (primary ? 'primary' : '')} onClick={(event) => handleSelect(clip, event)} onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault()
              handleSelect(clip, event)
            }
          }}>
            <span className="review-selection-mark" aria-hidden="true">{selected ? '✓' : ''}</span>
            <div className="review-clip-item-copy">
              <strong title={clip.name}>{clip.name}</strong>
              <div className="review-clip-meta">
                <MetaItem label={t('review.frames')} value={clip.startFrame + '–' + Math.max(clip.startFrame, clip.endFrame - 1)} />
                <MetaItem label={t('review.version')} value={'v' + clip.version} />
                <MetaItem label={t('review.loop')} value={clip.loop ? t('common.yes') : t('common.no')} />
              </div>
            </div>
            <StatusBadge status={clip.status}>{statusLabel(clip.status)}</StatusBadge>
          </div>
        )
      })}
    </div>
  )

  const detailPane = primarySelected ? (
    <ReviewPane className="review-detail-pane" title={t('review.clipDetails')} description={t('review.detailSubtitle', { name: primarySelected.name })} actions={<StatusBadge status={primarySelected.status}>{statusLabel(primarySelected.status)}</StatusBadge>}>
      <div className="review-detail-summary">
        <div className="review-detail-meta">
          <MetaItem label={t('review.frames')} value={primarySelected.startFrame + '–' + Math.max(primarySelected.startFrame, primarySelected.endFrame - 1)} />
          <MetaItem label={t('review.duration')} value={Math.max(0, primarySelected.endFrame - primarySelected.startFrame)} />
          <MetaItem label={t('review.version')} value={'v' + primarySelected.version} />
          <MetaItem label={t('review.loop')} value={primarySelected.loop ? t('common.yes') : t('common.no')} />
        </div>
        {primarySelected.reviewChecks?.checks && (
          <div className="review-checks" aria-label={t('review.checks.title')}>
            {primarySelected.reviewChecks.checks.map((item) => <CheckBadge key={item.id} status={item.status}>{t('review.checks.' + item.id)}: {t('review.checks.status.' + item.status)}</CheckBadge>)}
          </div>
        )}
        {editingId === primarySelected.id ? (
          <form className="review-rename-form" onSubmit={(event) => {
            event.preventDefault()
            void handleRename(primarySelected)
          }}>
            <ReviewField label={t('review.name')} wide><input autoFocus value={editName} onChange={(event) => setEditName(event.target.value)} disabled={busy || !isClipEditable(primarySelected.status)} /></ReviewField>
            <div className="review-rename-actions">
              <ActionButton icon={Save} tone="primary" type="submit" disabled={busy}>{t('review.saveName')}</ActionButton>
              <ActionButton icon={X} onClick={() => setEditingId('')} disabled={busy}>{t('review.cancelEdit')}</ActionButton>
            </div>
          </form>
        ) : (
          <div className="review-detail-actions">
            <ActionButton icon={Pencil} onClick={() => {
              setEditingId(primarySelected.id)
              setEditName(primarySelected.name)
            }} disabled={busy || !isClipEditable(primarySelected.status)} title={!isClipEditable(primarySelected.status) ? t('review.reviewLocked') : undefined}>{t('review.rename')}</ActionButton>
            <ActionButton icon={Repeat2} onClick={() => void handleToggleLoop(primarySelected)} disabled={busy || !isClipEditable(primarySelected.status)} title={!isClipEditable(primarySelected.status) ? t('review.reviewLocked') : undefined}>{primarySelected.loop ? t('review.unloop') : t('review.loop')}</ActionButton>
            <ReviewField label={t('review.statusLabel')} className="review-status-field">
              <select className="review-status-select" aria-label={t('review.statusControl', { name: primarySelected.name })} value={primarySelected.status} onChange={(event) => void handleStatusChange(primarySelected, event.target.value)} disabled={busy || availableClipStatuses(primarySelected.status).length === 0}>
                <option value={primarySelected.status}>{statusLabel(primarySelected.status)}</option>
                {availableClipStatuses(primarySelected.status).map((status) => <option key={status} value={status}>{statusLabel(status)}</option>)}
              </select>
            </ReviewField>
            {primarySelected.status === 'approved' && <ActionButton icon={UploadCloud} onClick={() => void handleQueueExportTask(primarySelected)} disabled={busy || disabled}>{t('review.queueExportTask')}</ActionButton>}
          </div>
        )}
      </div>
      <SemanticMarkerEditor projectId={projectId} clip={primarySelected} mobile={mobile} disabled={disabled || busy || !isClipEditable(primarySelected.status)} onMarkersChange={onMarkersChange} />
    </ReviewPane>
  ) : (
    <ReviewPane className="review-detail-pane review-detail-empty" title={t('review.clipDetails')}>
      <EmptyState title={t('review.noSelection')} description={mobile ? t('review.noSelectionMobileHint') : t('review.noSelectionHint')} />
    </ReviewPane>
  )

  return (
    <div className={'review-workspace ' + (mobile ? 'is-mobile' : 'is-desktop')}>
      <ReviewHeader title={t('review.title')} source={sourceLabel || assetId} mobile={mobile} range={rangeBadge} actions={<ActionButton icon={RefreshCw} aria-label={t('review.refresh')} title={t('review.refresh')} onClick={() => void refresh()} disabled={loading || busy}>{loading ? t('review.loading') : t('review.refresh')}</ActionButton>} />
      {error && <p className="review-clip-error" role="alert">{error}</p>}
      <div className="review-workspace-grid">
        <ReviewPane className="review-library-pane" title={t('review.clipLibrary')} count={orderedClips.length} description={selectionSummary} actions={mobile && orderedClips.length > 0 ? (
          <ActionButton icon={selectionMode ? X : ListChecks} tone={selectionMode ? 'primary' : 'secondary'} aria-pressed={selectionMode} onClick={() => {
            setSelectionMode((value) => !value)
            if (selectionMode) emitSelection([], null)
          }}>{selectionMode ? t('review.exitMultiSelect') : t('review.multiSelect')}</ActionButton>
        ) : null}>
          <ReviewComposer title={t('review.createFromTimeline')} actions={
            <>
              <ToggleField label={t('review.loop')} checked={loopDraft} onChange={setLoopDraft} disabled={disabled || busy} />
              <ActionButton icon={Save} tone="primary" onClick={() => void handleCreate()} disabled={disabled || busy || !range || !(range.endFrame > range.startFrame)} aria-label={t('review.createFromRange', { start: rangeStart, end: rangeEnd })} title={t('review.createFromRange', { start: rangeStart, end: rangeEnd })}>{t('review.saveClip')}</ActionButton>
            </>
          }>
            <ReviewField label={t('review.name')} wide><input type="text" value={nameDraft} placeholder={t('review.namePlaceholder')} onChange={(event) => setNameDraft(event.target.value)} disabled={disabled || busy} /></ReviewField>
          </ReviewComposer>
          {(selectedClipIds.length > 0 || (!mobile && orderedClips.length > 0)) && (
            <ReviewToolbar mobile={mobile} summary={selectionSummary}>
              <ActionButton icon={Layers3} onClick={() => void handleApplyRangeToSelected()} disabled={disabled || busy || !primarySelected || !isClipEditable(primarySelected.status) || !range} title={t('review.updateRangeHint')}>{t('review.updateRange')}</ActionButton>
              <ActionButton icon={Trash2} tone="danger" onClick={() => void handleDeleteSelected()} disabled={disabled || busy || selectedClipIds.length === 0}>{t('review.deleteSelected')}</ActionButton>
            </ReviewToolbar>
          )}
          {clipList}
        </ReviewPane>
        {detailPane}
      </div>
    </div>
  )
}
