import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { t } from '../i18n.js'
import {
  buildCreateClipPayload,
  buildUpdateClipPayload,
  expandSelectionRange,
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
  onApplyClipRange,
  disabled = false,
}) {
  const [clips, setClips] = useState([])
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [nameDraft, setNameDraft] = useState('')
  const [loopDraft, setLoopDraft] = useState(false)
  const [anchorId, setAnchorId] = useState(null)
  const [editingId, setEditingId] = useState('')
  const [editName, setEditName] = useState('')

  const orderedClips = useMemo(() => sortClipsForTimeline(clips), [clips])
  const selectedSet = useMemo(() => new Set(selectedClipIds.map(String)), [selectedClipIds])
  const primarySelected = orderedClips.find((clip) => selectedSet.has(String(clip.id))) || null

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
    if (event?.shiftKey) {
      next = expandSelectionRange(orderedClips, anchorId || id, id)
    } else if (event?.metaKey || event?.ctrlKey) {
      next = updateClipSelection(selectedClipIds, id, { mode: 'toggle' })
    } else {
      next = updateClipSelection(selectedClipIds, id, { mode: 'replace' })
    }
    emitSelection(next, id)
    if (!event?.shiftKey && !event?.metaKey && !event?.ctrlKey) {
      onApplyClipRange?.(clip)
    }
  }, [anchorId, emitSelection, onApplyClipRange, orderedClips, selectedClipIds])

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
      setError(err.message || t('review.updateFailed'))
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

  const handleDeleteSelected = useCallback(async () => {
    if (!projectId || selectedClipIds.length === 0 || busy) return
    const names = orderedClips
      .filter((clip) => selectedSet.has(String(clip.id)))
      .map((clip) => clip.name)
      .join(', ')
    if (!window.confirm(t('review.deleteConfirm', { count: selectedClipIds.length, names }))) return
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
  }, [busy, emitSelection, orderedClips, projectId, refresh, selectedClipIds, selectedSet])

  if (!projectId || !assetId) {
    return (
      <div className="review-clip-panel review-clip-panel-empty">
        <h3>{t('review.title')}</h3>
        <p className="hint">{t('review.needProjectVideo')}</p>
      </div>
    )
  }

  return (
    <div className="review-clip-panel">
      <div className="review-clip-head">
        <div>
          <h3>{t('review.title')}</h3>
          <p className="hint">{t('review.subtitle', { source: sourceLabel || assetId })}</p>
        </div>
        <button type="button" className="studio-mini-btn" onClick={() => void refresh()} disabled={loading || busy}>
          {loading ? t('review.loading') : t('review.refresh')}
        </button>
      </div>

      <div className="review-clip-create">
        <input
          type="text"
          value={nameDraft}
          placeholder={t('review.namePlaceholder')}
          onChange={(e) => setNameDraft(e.target.value)}
          disabled={disabled || busy}
        />
        <label className="review-loop-toggle">
          <input
            type="checkbox"
            checked={loopDraft}
            onChange={(e) => setLoopDraft(e.target.checked)}
            disabled={disabled || busy}
          />
          {t('review.loop')}
        </label>
        <button
          type="button"
          className="studio-primary-btn"
          onClick={() => void handleCreate()}
          disabled={disabled || busy || !range || !(range.endFrame > range.startFrame)}
        >
          {t('review.createFromRange', {
            start: range?.startFrame ?? 0,
            end: Math.max(0, (range?.endFrame ?? 0) - 1),
          })}
        </button>
      </div>

      <div className="review-clip-bulk">
        <span className="hint">
          {selectedClipIds.length > 0
            ? t('review.selectedCount', { count: selectedClipIds.length })
            : t('review.selectHint')}
        </span>
        <div className="review-clip-bulk-actions">
          <button
            type="button"
            className="studio-mini-btn"
            onClick={() => void handleApplyRangeToSelected()}
            disabled={disabled || busy || !primarySelected || !range}
            title={t('review.updateRangeHint')}
          >
            {t('review.updateRange')}
          </button>
          <button
            type="button"
            className="studio-danger-btn"
            onClick={() => void handleDeleteSelected()}
            disabled={disabled || busy || selectedClipIds.length === 0}
          >
            {t('review.deleteSelected')}
          </button>
        </div>
      </div>

      {error && <p className="review-clip-error">{error}</p>}

      <div className="review-clip-list" role="listbox" aria-multiselectable="true" aria-label={t('review.title')}>
        {orderedClips.length === 0 && !loading && (
          <p className="studio-empty">{t('review.empty')}</p>
        )}
        {orderedClips.map((clip) => {
          const selected = selectedSet.has(String(clip.id))
          const editing = editingId === clip.id
          return (
            <div
              key={clip.id}
              role="option"
              aria-selected={selected}
              className={`review-clip-item ${selected ? 'selected' : ''}`}
              onClick={(event) => handleSelect(clip, event)}
            >
              <div className="review-clip-main">
                {editing ? (
                  <form
                    className="review-clip-edit-row"
                    onClick={(e) => e.stopPropagation()}
                    onSubmit={(e) => {
                      e.preventDefault()
                      void handleRename(clip)
                    }}
                  >
                    <input
                      autoFocus
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      disabled={busy}
                    />
                    <button type="submit" className="studio-mini-btn" disabled={busy}>{t('review.saveName')}</button>
                    <button
                      type="button"
                      className="studio-mini-btn"
                      onClick={() => setEditingId('')}
                      disabled={busy}
                    >
                      {t('review.cancelEdit')}
                    </button>
                  </form>
                ) : (
                  <>
                    <strong>{clip.name}</strong>
                    <span>
                      {t('review.clipMeta', {
                        start: clip.startFrame,
                        end: Math.max(clip.startFrame, clip.endFrame - 1),
                        status: statusLabel(clip.status),
                        version: clip.version,
                        loop: clip.loop ? t('common.yes') : t('common.no'),
                      })}
                    </span>
                  </>
                )}
              </div>
              <div className="review-clip-actions" onClick={(e) => e.stopPropagation()}>
                <button
                  type="button"
                  className="studio-mini-btn"
                  onClick={() => {
                    setEditingId(clip.id)
                    setEditName(clip.name)
                  }}
                  disabled={busy}
                >
                  {t('review.rename')}
                </button>
                <button
                  type="button"
                  className="studio-mini-btn"
                  onClick={() => void handleToggleLoop(clip)}
                  disabled={busy}
                >
                  {clip.loop ? t('review.unloop') : t('review.loop')}
                </button>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
