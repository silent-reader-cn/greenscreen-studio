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
    { id: 'marker_1', clipId: 'clip_1', frame: 12, type: 'windup_end', label: 'startup', payload: { startupFrames: 3 } },
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

    fireEvent.click(screen.getByRole('button', { name: t('review.marker.newMarker') }))
    // 创建表单不再提供 JSON 荷载编辑框（AI 走 API 维护 payload，人不需要改）
    expect(document.querySelectorAll('.review-marker-create textarea')).toHaveLength(0)
    fireEvent.change(screen.getByLabelText(t('review.marker.type')), { target: { value: 'active_start' } })
    fireEvent.change(screen.getByLabelText(t('review.marker.frame')), { target: { value: '24' } })
    fireEvent.change(screen.getByLabelText(t('review.marker.label')), { target: { value: 'damage window' } })
    fireEvent.click(screen.getByRole('button', { name: t('review.marker.add') }))
    await screen.findByText('damage window')

    let markerRow = screen.getByText('damage window').closest('.review-marker-row')
    fireEvent.click(within(markerRow).getByRole('button', { name: t('review.marker.edit') }))
    expect(within(markerRow).queryByLabelText(t('review.marker.payload'))).toBeNull()
    fireEvent.change(within(markerRow).getByLabelText(t('review.marker.type')), { target: { value: 'instant' } })
    fireEvent.change(within(markerRow).getByLabelText(t('review.marker.frame')), { target: { value: '27' } })
    fireEvent.change(within(markerRow).getByLabelText(t('review.marker.label')), { target: { value: 'impact moved' } })
    fireEvent.click(within(markerRow).getByRole('button', { name: t('review.marker.save') }))
    await screen.findByText('impact moved')

    expect(fetch).toHaveBeenCalledWith(
      '/api/projects/project_1/clips/clip_1/markers/marker_2',
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({
          frame: 27,
          type: 'instant',
          label: 'impact moved',
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

  it('syncs the new-marker frame draft with the preview frame', async () => {
    const onSeekRequest = vi.fn()
    const { rerender } = render(
      <SemanticMarkerEditor
        projectId="project_1"
        clip={{ id: 'clip_1', name: 'attack', startFrame: 10, endFrame: 40 }}
        previewFrame={20}
        onSeekRequest={onSeekRequest}
      />,
    )
    await screen.findByText('startup')

    // 表单未打开时不跟随
    expect(screen.queryByLabelText(t('review.marker.frame'))).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: t('review.marker.newMarker') }))
    expect(screen.getByLabelText(t('review.marker.frame')).value).toBe('20')

    // 预览帧变化 → 表单帧号实时跟随
    rerender(
      <SemanticMarkerEditor
        projectId="project_1"
        clip={{ id: 'clip_1', name: 'attack', startFrame: 10, endFrame: 40 }}
        previewFrame={33}
        onSeekRequest={onSeekRequest}
      />,
    )
    expect(screen.getByLabelText(t('review.marker.frame')).value).toBe('33')
  })

  it('seeks the preview when a marker row is clicked', async () => {
    const onSeekRequest = vi.fn()
    render(
      <SemanticMarkerEditor
        projectId="project_1"
        clip={{ id: 'clip_1', name: 'attack', startFrame: 10, endFrame: 40 }}
        onSeekRequest={onSeekRequest}
      />,
    )
    const row = (await screen.findByText('startup')).closest('.review-marker-row')
    fireEvent.click(within(row).getByRole('button', { name: t('review.marker.seekTo', { frame: 12 }) }))
    expect(onSeekRequest).toHaveBeenCalledWith(12)
  })

  it('debounces frame draft input into a single seek request', async () => {
    const onSeekRequest = vi.fn()
    render(
      <SemanticMarkerEditor
        projectId="project_1"
        clip={{ id: 'clip_1', name: 'attack', startFrame: 10, endFrame: 40 }}
        previewFrame={20}
        onSeekRequest={onSeekRequest}
      />,
    )
    await screen.findByText('startup')
    fireEvent.click(screen.getByRole('button', { name: t('review.marker.newMarker') }))
    const frameInput = screen.getByLabelText(t('review.marker.frame'))
    fireEvent.change(frameInput, { target: { value: '25' } })
    fireEvent.change(frameInput, { target: { value: '26' } })

    // 防抖窗口内不触发
    expect(onSeekRequest).not.toHaveBeenCalled()
    await waitFor(() => expect(onSeekRequest).toHaveBeenCalledTimes(1))
    expect(onSeekRequest).toHaveBeenCalledWith(26)
  })

  it('shows a payload viewer toggle for markers carrying JSON payload', async () => {
    const alert = vi.spyOn(window, 'alert').mockReturnValue(undefined)
    render(
      <SemanticMarkerEditor
        projectId="project_1"
        clip={{ id: 'clip_1', name: 'attack', startFrame: 10, endFrame: 40 }}
        onMarkersChange={vi.fn()}
      />,
    )
    await screen.findByText('startup')

    // 带荷载的 marker 显示查看按钮；点击弹出荷载内容
    const toggle = screen.getByRole('button', { name: t('review.marker.payloadView') })
    expect(toggle).toBeTruthy()
    fireEvent.click(toggle)
    expect(alert).toHaveBeenCalledWith(expect.stringContaining('"startupFrames": 3'))
  })
})
