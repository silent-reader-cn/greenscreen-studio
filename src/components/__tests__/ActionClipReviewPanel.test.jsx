// @vitest-environment jsdom

import React from 'react'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ActionClipReviewPanel from '../ActionClipReviewPanel.jsx'
import { t } from '../../i18n.js'

function jsonResponse(data, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status >= 400 ? 'request failed' : 'ok',
    text: async () => JSON.stringify(data),
  }
}

function createApiMock({ reviewWarningCount = 0 } = {}) {
  let clips = [
    { id: 'clip_1', assetId: 'asset_1', name: 'idle', startFrame: 0, endFrame: 12, loop: true, status: 'draft', version: 1 },
    { id: 'clip_2', assetId: 'asset_1', name: 'attack', startFrame: 12, endFrame: 30, loop: false, status: 'needs_review', version: 2 },
  ]

  return vi.fn(async (url, options = {}) => {
    const method = options.method || 'GET'
    if (method === 'GET') return jsonResponse({ clips })

    if (method === 'POST' && String(url).endsWith('/export-task')) {
      return jsonResponse({ id: 'task_1', payload: { type: 'action_clip_export' } }, 201)
    }

    if (method === 'POST' && String(url) === '/api/video/review-checks') {
      const body = JSON.parse(options.body)
      const clip = clips.find((entry) => entry.id === body.clipId)
      const report = {
        schemaVersion: 1,
        clip: { id: clip.id, version: clip.version },
        summary: {
          status: reviewWarningCount > 0 ? 'warning' : 'pass',
          warningCount: reviewWarningCount,
          passCount: 5 - reviewWarningCount,
          skippedCount: 0,
        },
        checks: [
          { id: 'foreground_area', status: reviewWarningCount > 0 ? 'warning' : 'pass' },
          { id: 'feet_anchor', status: 'pass' },
          { id: 'crop', status: 'pass' },
          { id: 'frame_jitter', status: 'pass' },
          { id: 'loop_boundary', status: 'pass' },
        ],
      }
      clips = clips.map((entry) => entry.id === body.clipId ? { ...entry, reviewChecks: report } : entry)
      return jsonResponse(report)
    }

    if (method === 'POST') {
      const body = JSON.parse(options.body)
      const clip = { id: 'clip_3', version: 1, ...body }
      clips = [...clips, clip]
      return jsonResponse(clip, 201)
    }

    const clipId = String(url).match(/\/clips\/([^/]+)$/)?.[1]
    if (method === 'PATCH' && clipId) {
      const body = JSON.parse(options.body)
      clips = clips.map((clip) => clip.id === clipId
        ? { ...clip, ...body, version: clip.version + 1 }
        : clip)
      return jsonResponse(clips.find((clip) => clip.id === clipId))
    }

    if (method === 'DELETE' && clipId) {
      clips = clips.filter((clip) => clip.id !== clipId)
      return jsonResponse({ ok: true })
    }

    return jsonResponse({ error: 'not found' }, 404)
  })
}

function renderPanel(overrides = {}) {
  const props = {
    projectId: 'project_1',
    assetId: 'asset_1',
    sourceLabel: 'hero.mp4',
    range: { startFrame: 30, endFrame: 48 },
    totalFrames: 90,
    videoJobId: 'video_job_1',
    keyingParams: { tolerance: 40 },
    layoutParams: { anchor: 'feet' },
    selectedClipIds: [],
    onSelectionChange: vi.fn(),
    onClipsChange: vi.fn(),
    onApplyClipRange: vi.fn(),
    ...overrides,
  }
  const view = render(<ActionClipReviewPanel {...props} />)
  return { ...view, props }
}

describe('ActionClipReviewPanel', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', createApiMock())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('loads clips and supports replace, toggle, and shift-range selection', async () => {
    const { props, rerender } = renderPanel()
    const idle = await screen.findByText('idle')
    const attack = screen.getByText('attack')

    expect(screen.queryByRole('button', { name: t('review.rename') })).toBeNull()

    fireEvent.click(idle)
    expect(props.onSelectionChange).toHaveBeenLastCalledWith(['clip_1'])
    expect(props.onApplyClipRange).toHaveBeenCalledWith(expect.objectContaining({ id: 'clip_1' }))

    rerender(<ActionClipReviewPanel {...props} selectedClipIds={['clip_1']} />)
    expect(screen.getByRole('button', { name: t('review.rename') })).toBeTruthy()
    fireEvent.click(screen.getByText('attack'), { ctrlKey: true })
    expect(props.onSelectionChange).toHaveBeenLastCalledWith(['clip_1', 'clip_2'])

    fireEvent.click(screen.getByText('idle'), { shiftKey: true })
    expect(props.onSelectionChange).toHaveBeenLastCalledWith(['clip_1', 'clip_2'])
  })

  it('creates, renames, updates the range, and deletes clips through the API', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    const onSelectionChange = vi.fn()
    const { rerender, props } = renderPanel({ onSelectionChange })
    await screen.findByText('idle')

    const nameInput = screen.getByPlaceholderText(t('review.namePlaceholder'))
    fireEvent.change(nameInput, { target: { value: 'recovery' } })
    fireEvent.click(screen.getByRole('button', { name: t('review.createFromRange', { start: 30, end: 47 }) }))
    await screen.findByText('recovery')
    expect(onSelectionChange).toHaveBeenLastCalledWith(['clip_3'])

    rerender(<ActionClipReviewPanel {...props} selectedClipIds={['clip_3']} />)

    const recoveryItem = screen.getByText('recovery').closest('[role="option"]')
    fireEvent.click(within(recoveryItem).getByRole('button', { name: t('review.rename') }))
    const editInput = within(recoveryItem).getByDisplayValue('recovery')
    fireEvent.change(editInput, { target: { value: 'recover_fast' } })
    fireEvent.click(within(recoveryItem).getByRole('button', { name: t('review.saveName') }))
    await screen.findByText('recover_fast')

    rerender(
      <ActionClipReviewPanel
        projectId="project_1"
        assetId="asset_1"
        sourceLabel="hero.mp4"
        range={{ startFrame: 32, endFrame: 50 }}
        totalFrames={90}
        selectedClipIds={['clip_3']}
        onSelectionChange={onSelectionChange}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: t('review.updateRange') }))
    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith(
        '/api/projects/project_1/clips/clip_3',
        expect.objectContaining({
          method: 'PATCH',
          body: JSON.stringify({ startFrame: 32, endFrame: 50 }),
        }),
      )
    })

    fireEvent.click(screen.getByRole('button', { name: t('review.deleteSelected') }))
    await waitFor(() => expect(screen.queryByText('recover_fast')).toBeNull())
    expect(confirm).toHaveBeenCalledOnce()
  })

  it('moves through review states and locks approved clip content', async () => {
    renderPanel({ selectedClipIds: ['clip_1'] })
    await screen.findByText('idle')

    let statusSelect = screen.getByLabelText(t('review.statusControl', { name: 'idle' }))
    fireEvent.change(statusSelect, { target: { value: 'needs_review' } })
    await waitFor(() => {
      statusSelect = screen.getByLabelText(t('review.statusControl', { name: 'idle' }))
      expect(statusSelect.value).toBe('needs_review')
    })

    fireEvent.change(statusSelect, { target: { value: 'approved' } })
    await waitFor(() => {
      statusSelect = screen.getByLabelText(t('review.statusControl', { name: 'idle' }))
      expect(statusSelect.value).toBe('approved')
    })
    expect(fetch).toHaveBeenCalledWith('/api/video/review-checks', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({
        jobId: 'video_job_1',
        clipId: 'clip_1',
        params: { keying: { tolerance: 40 }, layout: { anchor: 'feet' }, region: null },
      }),
    }))
    expect(screen.getByText(`${t('review.checks.foreground_area')}: ${t('review.checks.status.pass')}`)).toBeTruthy()

    const idleItem = screen.getByText('idle').closest('[role="option"]')
    expect(within(idleItem).getByRole('button', { name: t('review.rename') }).disabled).toBe(true)
    expect(within(idleItem).getByRole('button', { name: t('review.unloop') }).disabled).toBe(true)
    fireEvent.click(within(idleItem).getByRole('button', { name: t('review.queueExportTask') }))
    await waitFor(() => expect(fetch).toHaveBeenCalledWith(
      '/api/projects/project_1/clips/clip_1/export-task',
      expect.objectContaining({ method: 'POST' }),
    ))
    expect(screen.getByRole('button', { name: t('review.updateRange') }).disabled).toBe(true)
    expect(screen.getByRole('button', { name: t('review.marker.newMarker') }).disabled).toBe(true)
  })

  it('requires confirmation before approving a clip with automated warnings', async () => {
    vi.stubGlobal('fetch', createApiMock({ reviewWarningCount: 1 }))
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    renderPanel({ selectedClipIds: ['clip_2'] })
    await screen.findByText('attack')

    const statusSelect = screen.getByLabelText(t('review.statusControl', { name: 'attack' }))
    fireEvent.change(statusSelect, { target: { value: 'approved' } })

    await waitFor(() => expect(confirm).toHaveBeenCalledWith(t('review.checks.confirmWarnings', { count: 1 })))
    expect(screen.getByLabelText(t('review.statusControl', { name: 'attack' })).value).toBe('needs_review')
    expect(fetch).not.toHaveBeenCalledWith(
      '/api/projects/project_1/clips/clip_2',
      expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ status: 'approved' }) }),
    )
    expect(screen.getByText(`${t('review.checks.foreground_area')}: ${t('review.checks.status.warning')}`)).toBeTruthy()
  })
})
