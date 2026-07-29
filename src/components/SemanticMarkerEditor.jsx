import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { t } from '../i18n.js'
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
  return t(`review.markerTypes.${type}`)
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
}) {
  const [markers, setMarkers] = useState([])
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [typeDraft, setTypeDraft] = useState('hit')
  const [frameDraft, setFrameDraft] = useState(clip?.startFrame ?? 0)
  const [labelDraft, setLabelDraft] = useState('')
  const [payloadDraft, setPayloadDraft] = useState('{}')
  const [editingId, setEditingId] = useState('')
  const [editDraft, setEditDraft] = useState(null)
  const requestVersionRef = useRef(0)

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
    setEditingId('')
    setEditDraft(null)
  }, [clip?.endFrame, clip?.id, clip?.startFrame, onMarkersChange])

  const handleCreate = useCallback(async () => {
    if (!projectId || !clip?.id || busy) return
    const built = buildCreateMarkerPayload({
      frame: frameDraft,
      type: typeDraft,
      label: labelDraft,
      payloadText: payloadDraft,
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
      setPayloadDraft('{}')
      await refresh()
    } catch (err) {
      setError(err.message || t('review.marker.createFailed'))
    } finally {
      setBusy(false)
    }
  }, [busy, clip, frameDraft, labelDraft, payloadDraft, projectId, refresh, typeDraft])

  const beginEdit = useCallback((marker) => {
    setEditingId(marker.id)
    setEditDraft({
      frame: marker.frame,
      type: marker.type,
      label: marker.label || '',
      payloadText: payloadText(marker.payload),
    })
    setError('')
  }, [])

  const handleSave = useCallback(async (marker) => {
    if (!projectId || !clip?.id || !editDraft || busy) return
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
  }, [busy, clip, editDraft, projectId, refresh])

  const handleDelete = useCallback(async (marker) => {
    if (!projectId || !clip?.id || busy) return
    if (!window.confirm(t('review.marker.deleteConfirm', {
      type: markerTypeLabel(marker.type),
      frame: marker.frame,
    }))) return
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
  }, [busy, clip?.id, projectId, refresh])

  if (!clip) return null

  const minFrame = clip.startFrame
  const maxFrame = Math.max(clip.startFrame, clip.endFrame - 1)

  return (
    <section className="review-marker-editor" aria-label={t('review.marker.title')}>
      <div className="review-marker-head">
        <div>
          <h4>{t('review.marker.title')}</h4>
          <p className="hint">{t('review.marker.clipRange', {
            name: clip.name,
            start: minFrame,
            end: maxFrame,
          })}</p>
        </div>
        <button type="button" className="studio-mini-btn" onClick={() => void refresh()} disabled={loading || busy}>
          {loading ? t('review.marker.loading') : t('review.refresh')}
        </button>
      </div>

      <div className="review-marker-create">
        <label>
          <span>{t('review.marker.type')}</span>
          <select value={typeDraft} onChange={(event) => setTypeDraft(event.target.value)} disabled={disabled || busy}>
            {MARKER_TYPES.map((type) => <option key={type} value={type}>{markerTypeLabel(type)}</option>)}
          </select>
        </label>
        <label>
          <span>{t('review.marker.frame')}</span>
          <input
            type="number"
            min={minFrame}
            max={maxFrame}
            step="1"
            value={frameDraft}
            onChange={(event) => setFrameDraft(event.target.value)}
            disabled={disabled || busy}
          />
        </label>
        <label className="review-marker-wide">
          <span>{t('review.marker.label')}</span>
          <input
            type="text"
            value={labelDraft}
            placeholder={t('review.marker.labelPlaceholder')}
            onChange={(event) => setLabelDraft(event.target.value)}
            disabled={disabled || busy}
          />
        </label>
        <label className="review-marker-wide">
          <span>{t('review.marker.payload')}</span>
          <textarea
            rows="2"
            value={payloadDraft}
            placeholder={t('review.marker.payloadPlaceholder')}
            onChange={(event) => setPayloadDraft(event.target.value)}
            disabled={disabled || busy}
          />
        </label>
        <button type="button" className="studio-primary-btn review-marker-wide" onClick={() => void handleCreate()} disabled={disabled || busy}>
          {t('review.marker.add')}
        </button>
      </div>

      {error && <p className="review-clip-error">{error}</p>}

      <div className="review-marker-list">
        {orderedMarkers.length === 0 && !loading && <p className="studio-empty">{t('review.marker.empty')}</p>}
        {orderedMarkers.map((marker) => {
          const editing = editingId === marker.id && editDraft
          return (
            <div className="review-marker-row" key={marker.id}>
              {editing ? (
                <div className="review-marker-edit">
                  <select
                    aria-label={t('review.marker.type')}
                    value={editDraft.type}
                    onChange={(event) => setEditDraft((prev) => ({ ...prev, type: event.target.value }))}
                    disabled={busy}
                  >
                    {MARKER_TYPES.map((type) => <option key={type} value={type}>{markerTypeLabel(type)}</option>)}
                  </select>
                  <input
                    aria-label={t('review.marker.frame')}
                    type="number"
                    min={minFrame}
                    max={maxFrame}
                    step="1"
                    value={editDraft.frame}
                    onChange={(event) => setEditDraft((prev) => ({ ...prev, frame: event.target.value }))}
                    disabled={busy}
                  />
                  <input
                    aria-label={t('review.marker.label')}
                    type="text"
                    value={editDraft.label}
                    onChange={(event) => setEditDraft((prev) => ({ ...prev, label: event.target.value }))}
                    disabled={busy}
                  />
                  <textarea
                    aria-label={t('review.marker.payload')}
                    rows="2"
                    value={editDraft.payloadText}
                    onChange={(event) => setEditDraft((prev) => ({ ...prev, payloadText: event.target.value }))}
                    disabled={busy}
                  />
                  <div className="review-marker-actions">
                    <button type="button" className="studio-mini-btn" onClick={() => void handleSave(marker)} disabled={busy}>{t('review.marker.save')}</button>
                    <button
                      type="button"
                      className="studio-mini-btn"
                      onClick={() => {
                        setEditingId('')
                        setEditDraft(null)
                      }}
                      disabled={busy}
                    >
                      {t('review.marker.cancel')}
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <div className="review-marker-summary">
                    <span className={`review-marker-dot type-${marker.type}`} aria-hidden="true" />
                    <strong>{markerTypeLabel(marker.type)}</strong>
                    <span>{t('review.marker.atFrame', { frame: marker.frame })}</span>
                    {marker.label && <span className="review-marker-label">{marker.label}</span>}
                    <code>{JSON.stringify(marker.payload || {})}</code>
                  </div>
                  <div className="review-marker-actions">
                    <button type="button" className="studio-mini-btn" onClick={() => beginEdit(marker)} disabled={busy}>{t('review.marker.edit')}</button>
                    <button type="button" className="studio-danger-btn" onClick={() => void handleDelete(marker)} disabled={busy}>{t('review.marker.delete')}</button>
                  </div>
                </>
              )}
            </div>
          )
        })}
      </div>
    </section>
  )
}
