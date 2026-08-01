// @vitest-environment jsdom

import React from 'react'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import SemanticMarkerEditor from '../SemanticMarkerEditor.jsx'
import { t } from '../../i18n.js'

function jsonResponse(data, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status >= 400 ? 'request failed' : 'ok',
    text: async () => JSON.stringify(data),
  }
}

function createMarkerApiMock() {
  let markers = [
    { id: 'marker_1', clipId: 'clip_1', frame: 12, type: 'windup_end', label: 'startup', payload: {} },
  ]

  return vi.fn(async (url, options = {}) => {
    const method = options.method || 'GET'
    if (method === 'GET') {
      return jsonResponse({
        clip: { id: 'clip_1', startFrame: 10, endFrame: 40 },
        markers,
      })
    }
    if (method === 'POST' && String(url).endsWith('/markers')) {
      const body = JSON.parse(options.body)
      const marker = { id: 'marker_2', clipId: 'clip_1', ...body }
      markers = [...markers, marker]
      return jsonResponse(marker, 201)
    }

    const markerId = String(url).match(/\/markers\/([^/]+)$/)?.[1]
    if (method === 'PATCH' && markerId) {
      const body = JSON.parse(options.body)
      markers = markers.map((marker) => marker.id === markerId ? { ...marker, ...body } : marker)
      return jsonResponse(markers.find((marker) => marker.id === markerId))
    }
    if (method === 'DELETE' && markerId) {
      markers = markers.filter((marker) => marker.id !== markerId)
      return jsonResponse({ ok: true })
    }
    return jsonResponse({ error: 'not found' }, 404)
  })
}

describe('SemanticMarkerEditor', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', createMarkerApiMock())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('loads, creates, moves, edits, and deletes typed markers', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    const onMarkersChange = vi.fn()
    render(
      <SemanticMarkerEditor
        projectId="project_1"
        clip={{ id: 'clip_1', name: 'attack', startFrame: 10, endFrame: 40 }}
        onMarkersChange={onMarkersChange}
      />,
    )

    await screen.findByText('startup')
    expect(screen.getByRole('button', { name: t('review.marker.newMarker') }).classList.contains('compact-icon-action')).toBe(true)
    expect(screen.getByRole('button', { name: t('review.refresh') }).classList.contains('compact-icon-action')).toBe(true)
    expect(onMarkersChange).toHaveBeenLastCalledWith([
      expect.objectContaining({ id: 'marker_1', frame: 12, type: 'windup_end' }),
    ])

    expect(screen.queryByLabelText(t('review.marker.payload'))).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: t('review.marker.newMarker') }))
    fireEvent.change(screen.getByLabelText(t('review.marker.type')), { target: { value: 'active_start' } })
    fireEvent.change(screen.getByLabelText(t('review.marker.frame')), { target: { value: '24' } })
    fireEvent.change(screen.getByLabelText(t('review.marker.label')), { target: { value: 'damage window' } })
    fireEvent.change(screen.getByLabelText(t('review.marker.payload')), { target: { value: '{"hitbox":"slash_a"}' } })
    fireEvent.click(screen.getByRole('button', { name: t('review.marker.add') }))
    await screen.findByText('damage window')

    let markerRow = screen.getByText('damage window').closest('.review-marker-row')
    fireEvent.click(within(markerRow).getByRole('button', { name: t('review.marker.edit') }))
    fireEvent.change(within(markerRow).getByLabelText(t('review.marker.type')), { target: { value: 'hit' } })
    fireEvent.change(within(markerRow).getByLabelText(t('review.marker.frame')), { target: { value: '27' } })
    fireEvent.change(within(markerRow).getByLabelText(t('review.marker.label')), { target: { value: 'impact moved' } })
    fireEvent.change(within(markerRow).getByLabelText(t('review.marker.payload')), { target: { value: '{"damage":2}' } })
    fireEvent.click(within(markerRow).getByRole('button', { name: t('review.marker.save') }))
    await screen.findByText('impact moved')

    expect(fetch).toHaveBeenCalledWith(
      '/api/projects/project_1/clips/clip_1/markers/marker_2',
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({
          frame: 27,
          type: 'hit',
          label: 'impact moved',
          payload: { damage: 2 },
        }),
      }),
    )

    markerRow = screen.getByText('impact moved').closest('.review-marker-row')
    fireEvent.click(within(markerRow).getByRole('button', { name: t('review.marker.delete') }))
    await waitFor(() => expect(screen.queryByText('impact moved')).toBeNull())
    expect(confirm).toHaveBeenCalledOnce()
  })

  it('uses compact icon actions on mobile while keeping accessible labels', async () => {
    const { container } = render(
      <SemanticMarkerEditor
        mobile
        projectId="project_1"
        clip={{ id: 'clip_1', name: 'attack', startFrame: 10, endFrame: 40 }}
        onMarkersChange={vi.fn()}
      />,
    )

    await screen.findByText('startup')
    expect(container.querySelectorAll('.review-marker-row .compact-icon-action')).toHaveLength(2)
    expect(screen.getByRole('button', { name: t('review.marker.newMarker') }).classList.contains('compact-icon-action')).toBe(true)
    expect(screen.getByRole('button', { name: t('review.refresh') }).classList.contains('compact-icon-action')).toBe(true)
  })
})
