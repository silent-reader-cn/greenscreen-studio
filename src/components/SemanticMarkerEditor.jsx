import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Info, Pencil, Plus, RefreshCw, Save, Trash2, X } from 'lucide-react'
import { t } from '../i18n.js'
import { useAppDialog } from './AppDialog.jsx'
import { CompactActionGroup, CompactIconButton, ResponsiveActionButton } from './ControlKit.jsx'
import { CountBadge, EmptyState, ReviewField, ReviewRange } from './ReviewKit.jsx'
import {
  MARKER_TYPES,
  buildCreateMarkerPayload,
  buildUpdateMarkerPayload,
  sortMarkers,
} from '../lib/actionReviewMarkers.js'

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: options.body ? { 'Content-Type': 'application/json', ...(options.headers || {}) } : options.headers,
    ...options,
  })
  const text = await res.text()
  let data = null
  try { data = text ? JSON.parse(text) : null } catch { data = { raw: text } }
  if (!res.ok) throw new Error(data?.error || res.statusText || 'request failed')
  return data
}

function payloadText(payload) {
  return JSON.stringify(payload || {}, null, 2)
}

function markerTypeLabel(type) {
  return t(`review.markerTypes.${type}`) || type
}

function validationMessage(error) {
  const messages = {
    frame_invalid: t('review.marker.frameInvalid'),
    frame_outside_clip: t('review.marker.frameOutsideClip'),
    type_invalid: t('review.marker.typeInvalid'),
    payload_invalid_json: t('review.marker.payloadInvalidJson'),
    payload_not_object: t('review.marker.payloadNotObject'),
  }
  return messages[error] || error
}

export default function SemanticMarkerEditor({
  projectId,
  clip,
  disabled = false,
  onMarkersChange,
  mobile = false,
  previewFrame = null,
  onSeekRequest,
}) {
  const dialog = useAppDialog()
  const [markers, setMarkers] = useState([])
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [typeDraft, setTypeDraft] = useState('active_start')
  const [frameDraft, setFrameDraft] = useState(clip?.startFrame ?? 0)
  const [labelDraft, setLabelDraft] = useState('')
  const [createOpen, setCreateOpen] = useState(false)
  const [editingId, setEditingId] = useState('')
  const [editDraft, setEditDraft] = useState(null)
  const requestVersionRef = useRef(0)
  const frameInputFocusedRef = useRef(false)
  const seekDebounceRef = useRef(null)

  const orderedMarkers = useMemo(() => sortMarkers(markers), [markers])

  const refresh = useCallback(async () => {
    const requestVersion = ++requestVersionRef.current
    if (!projectId || !clip?.id) {
      setMarkers([])
      onMarkersChange?.([])
      return
    }
    setLoading(true)
    setError('')
    try {
      const bundle = await api(`/api/projects/${projectId}/clips/${clip.id}`)
      if (requestVersion !== requestVersionRef.current) return
      const next = sortMarkers(bundle.markers || [])
      setMarkers(next)
      onMarkersChange?.(next)
    } catch (err) {
      if (requestVersion === requestVersionRef.current) {
        setError(err.message || t('review.marker.loadFailed'))
      }
    } finally {
      if (requestVersion === requestVersionRef.current) setLoading(false)
    }
  }, [clip?.id, onMarkersChange, projectId])

  useEffect(() => {
    void refresh()
    return () => { requestVersionRef.current += 1 }
  }, [refresh])

  useEffect(() => {
    setMarkers([])
    onMarkersChange?.([])
    setFrameDraft(clip?.startFrame ?? 0)
    setCreateOpen(false)
    setEditingId('')
    setEditDraft(null)
  }, [clip?.endFrame, clip?.id, clip?.startFrame, onMarkersChange])

  // 预览帧 → 新增表单帧号（表单打开且输入框未聚焦时实时跟随）
  useEffect(() => {
    if (!createOpen || frameInputFocusedRef.current) return
    if (typeof previewFrame !== 'number' || !Number.isFinite(previewFrame) || previewFrame < 0) return
    setFrameDraft(previewFrame)
  }, [createOpen, previewFrame])

  // 帧号输入 → 预览跳转（防抖，避免打字过程中反复 seek）
  const handleFrameDraftChange = useCallback((value) => {
    setFrameDraft(value)
    const frame = Number(value)
    if (!Number.isFinite(frame)) return
    if (seekDebounceRef.current) clearTimeout(seekDebounceRef.current)
    seekDebounceRef.current = setTimeout(() => {
      seekDebounceRef.current = null
      onSeekRequest?.(frame)
    }, 150)
  }, [onSeekRequest])

  useEffect(() => () => {
    if (seekDebounceRef.current) clearTimeout(seekDebounceRef.current)
  }, [])

  const handleSeekToMarker = useCallback((marker) => {
    if (disabled || busy) return
    onSeekRequest?.(marker.frame)
  }, [busy, disabled, onSeekRequest])

  const handleCreate = useCallback(async () => {
    if (!projectId || !clip?.id || disabled || busy) return
    const built = buildCreateMarkerPayload({
      frame: frameDraft,
      type: typeDraft,
      label: labelDraft,
    }, { clip })
    if (!built.ok) {
      setError(validationMessage(built.error))
      return
    }
    setBusy(true)
    setError('')
    try {
      await api(`/api/projects/${projectId}/clips/${clip.id}/markers`, {
        method: 'POST',
        body: JSON.stringify(built.payload),
      })
      setLabelDraft('')
      await refresh()
      setCreateOpen(false)
    } catch (err) {
      setError(err.message || t('review.marker.createFailed'))
    } finally {
      setBusy(false)
    }
  }, [busy, clip, disabled, frameDraft, labelDraft, projectId, refresh, typeDraft])

  const beginEdit = useCallback((marker) => {
    setEditingId(marker.id)
    // 人编辑不修改 JSON 荷载（AI 走 API 维护 payload），编辑时保持原 payload 不变
    setEditDraft({
      frame: marker.frame,
      type: marker.type,
      label: marker.label || '',
    })
    setError('')
  }, [])

  const handleViewPayload = useCallback((marker) => {
    void dialog.alert(payloadText(marker.payload), { title: t('review.marker.payloadTitle') })
  }, [dialog])

  const handleSave = useCallback(async (marker) => {
    if (!projectId || !clip?.id || !editDraft || disabled || busy) return
    const built = buildUpdateMarkerPayload(editDraft, { clip, current: marker })
    if (!built.ok) {
      setError(validationMessage(built.error))
      return
    }
    setBusy(true)
    setError('')
    try {
      await api(`/api/projects/${projectId}/clips/${clip.id}/markers/${marker.id}`, {
        method: 'PATCH',
        body: JSON.stringify(built.payload),
      })
      setEditingId('')
      setEditDraft(null)
      await refresh()
    } catch (err) {
      setError(err.message || t('review.marker.updateFailed'))
    } finally {
      setBusy(false)
    }
  }, [busy, clip, disabled, editDraft, projectId, refresh])

  const handleDelete = useCallback(async (marker) => {
    if (!projectId || !clip?.id || disabled || busy) return
    if (!await dialog.confirm(t('review.marker.deleteConfirm', {
      type: markerTypeLabel(marker.type),
      frame: marker.frame,
    }), { title: t('review.marker.delete'), tone: 'danger' })) return
    setBusy(true)
    setError('')
    try {
      await api(`/api/projects/${projectId}/clips/${clip.id}/markers/${marker.id}`, { method: 'DELETE' })
      await refresh()
    } catch (err) {
      setError(err.message || t('review.marker.deleteFailed'))
    } finally {
      setBusy(false)
    }
  }, [busy, clip?.id, dialog, disabled, projectId, refresh])

  if (!clip) return null

  const minFrame = clip.startFrame
  const maxFrame = Math.max(clip.startFrame, clip.endFrame - 1)

  return (
    <section className={'review-marker-editor ' + (mobile ? 'is-mobile' : 'is-desktop')} aria-label={t('review.marker.title')}>
      <div className="review-marker-head">
        <div className="review-marker-head-copy">
          <div className="review-marker-title-row">
            <h4>{t('review.marker.title')}</h4>
            <CountBadge>{orderedMarkers.length}</CountBadge>
          </div>
          <p>{t('review.marker.sectionHint')}</p>
        </div>
        <div className="review-marker-head-actions">
          <CompactIconButton
            size="small"
            icon={RefreshCw}
            label={loading ? t('review.marker.loading') : t('review.refresh')}
            onClick={() => void refresh()}
            disabled={loading || busy}
          />
          <CompactIconButton
            size="small"
            icon={createOpen ? X : Plus}
            label={createOpen ? t('review.marker.closeCreate') : t('review.marker.newMarker')}
            tone={createOpen ? 'secondary' : 'primary'}
            className="review-marker-add-toggle"
            aria-expanded={createOpen}
            onClick={() => setCreateOpen((open) => !open)}
            disabled={disabled || busy}
          />
        </div>
      </div>

      {createOpen && <div className="review-marker-create">
        <div className="review-marker-create-title review-marker-wide">
          <div><strong>{t('review.marker.createTitle')}</strong><span>{t('review.marker.createHint', { start: minFrame, end: maxFrame })}</span></div>
          <ReviewRange label={t('review.marker.validRange')} start={minFrame} end={maxFrame} compact />
        </div>
        <ReviewField label={t('review.marker.type')}>
          <select value={typeDraft} onChange={(event) => setTypeDraft(event.target.value)} disabled={disabled || busy}>
            {MARKER_TYPES.map((type) => <option key={type} value={type}>{markerTypeLabel(type)}</option>)}
          </select>
        </ReviewField>
        <ReviewField label={t('review.marker.frame')}>
          <input
            type="number"
            min={minFrame}
            max={maxFrame}
            step="1"
            value={frameDraft}
            onChange={(event) => handleFrameDraftChange(event.target.value)}
            onFocus={() => { frameInputFocusedRef.current = true }}
            onBlur={() => { frameInputFocusedRef.current = false }}
            disabled={disabled || busy}
          />
        </ReviewField>
        <ReviewField label={t('review.marker.label')} wide>
          <input
            type="text"
            value={labelDraft}
            placeholder={t('review.marker.labelPlaceholder')}
            onChange={(event) => setLabelDraft(event.target.value)}
            disabled={disabled || busy}
          />
        </ReviewField>
        <div className="review-marker-create-actions review-marker-wide">
          <ResponsiveActionButton
            mobile={mobile}
            icon={Plus}
            label={t('review.marker.add')}
            tone="primary"
            onClick={() => void handleCreate()}
            disabled={disabled || busy}
          />
        </div>
      </div>}

      {error && <p className="review-clip-error">{error}</p>}

      <div className="review-marker-list">
        {orderedMarkers.length === 0 && !loading && <EmptyState compact title={t('review.marker.empty')} description={t('review.marker.emptyHint')} />}
        {orderedMarkers.map((marker) => {
          const editing = editingId === marker.id && editDraft
          return (
            <div className="review-marker-row" key={marker.id}>
              {editing ? (
                <div className="review-marker-edit">
                  <ReviewField label={t('review.marker.type')}>
                    <select value={editDraft.type} onChange={(event) => setEditDraft((prev) => ({ ...prev, type: event.target.value }))} disabled={disabled || busy}>
                      {MARKER_TYPES.map((type) => <option key={type} value={type}>{markerTypeLabel(type)}</option>)}
                    </select>
                  </ReviewField>
                  <ReviewField label={t('review.marker.frame')}>
                    <input type="number" min={minFrame} max={maxFrame} step="1" value={editDraft.frame} onChange={(event) => setEditDraft((prev) => ({ ...prev, frame: event.target.value }))} disabled={disabled || busy} />
                  </ReviewField>
                  <ReviewField label={t('review.marker.label')} wide>
                    <input type="text" value={editDraft.label} onChange={(event) => setEditDraft((prev) => ({ ...prev, label: event.target.value }))} disabled={disabled || busy} />
                  </ReviewField>
                  <CompactActionGroup className="review-marker-actions" label={t('review.marker.editActions')}>
                    <ResponsiveActionButton mobile={mobile} icon={Save} label={t('review.marker.save')} tone="primary" onClick={() => void handleSave(marker)} disabled={disabled || busy} />
                    <ResponsiveActionButton
                      mobile={mobile}
                      icon={X}
                      label={t('review.marker.cancel')}
                      onClick={() => {
                        setEditingId('')
                        setEditDraft(null)
                      }}
                      disabled={disabled || busy}
                    />
                  </CompactActionGroup>
                </div>
              ) : (
                <>
                  <div
                    className="review-marker-summary"
                    role="button"
                    tabIndex={0}
                    title={t('review.marker.seekTo', { frame: marker.frame })}
                    aria-label={t('review.marker.seekTo', { frame: marker.frame })}
                    onClick={() => handleSeekToMarker(marker)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault()
                        handleSeekToMarker(marker)
                      }
                    }}
                  >
                    <span className={`review-marker-dot type-${marker.type}`} aria-hidden="true" />
                    <strong>{markerTypeLabel(marker.type)}</strong>
                    <span>{t('review.marker.atFrame', { frame: marker.frame })}</span>
                    {marker.label && <span className="review-marker-label">{marker.label}</span>}
                    {Object.keys(marker.payload || {}).length > 0 && (
                      <button
                        type="button"
                        className="review-marker-payload-toggle"
                        title={t('review.marker.payloadView')}
                        aria-label={t('review.marker.payloadView')}
                        onClick={(event) => {
                          event.stopPropagation()
                          handleViewPayload(marker)
                        }}
                      >
                        <Info size={13} />
                      </button>
                    )}
                  </div>
                  <CompactActionGroup className="review-marker-actions" label={t('review.marker.rowActions', { type: markerTypeLabel(marker.type), frame: marker.frame })}>
                    <ResponsiveActionButton mobile={mobile} icon={Pencil} label={t('review.marker.edit')} onClick={() => beginEdit(marker)} disabled={disabled || busy} />
                    <ResponsiveActionButton mobile={mobile} icon={Trash2} label={t('review.marker.delete')} tone="danger" onClick={() => void handleDelete(marker)} disabled={disabled || busy} />
                  </CompactActionGroup>
                </>
              )}
            </div>
          )
        })}
      </div>
    </section>
  )
}
