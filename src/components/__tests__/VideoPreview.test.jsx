// @vitest-environment jsdom

import React from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import VideoPreview from '../VideoPreview.jsx'
import { t } from '../../i18n.js'

class ResizeObserverStub {
  observe() {}
  disconnect() {}
}

describe('VideoPreview mobile controls', () => {
  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', ResizeObserverStub)
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1))
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:preview-video')
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue()
  })

  afterEach(() => {
    document.querySelectorAll('[data-video-preview-test-target]').forEach(element => element.remove())
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('replaces the tall action rows with canvas playback and floating tools', () => {
    const onRangeChange = vi.fn()
    const mobileToolsTarget = document.createElement('div')
    mobileToolsTarget.dataset.videoPreviewTestTarget = 'true'
    document.body.appendChild(mobileToolsTarget)
    const { container } = render(
      <VideoPreview
        mobile
        mobileToolsTarget={mobileToolsTarget}
        videoFile={new File(['video'], 'clip.mp4', { type: 'video/mp4' })}
        videoInfo={{ jobId: 'job-1', duration: 10, fps: 24, frameCount: 240 }}
        keyingParams={{}}
        layoutParams={{}}
        range={{ startFrame: 0, endFrame: 84 }}
        onRangeChange={onRangeChange}
      />,
    )

    expect(container.querySelector('.timeline-mark-actions')).toBeNull()
    expect(container.querySelector('.loop-candidates')).toBeNull()
    expect(screen.getByRole('button', { name: t('preview.playRange') })).toBeTruthy()
    expect(screen.getByRole('toolbar', { name: t('preview.previewTools') })).toBeTruthy()
    expect(mobileToolsTarget.querySelector('.mobile-preview-menu > summary')).toBeTruthy()
    expect(screen.getByRole('button', { name: t('preview.autoLoopAria') }).getAttribute('aria-pressed')).toBe('false')

    const timeline = container.querySelector('.timeline-track-wrap')
    fireEvent.pointerDown(timeline, { pointerId: 1, pointerType: 'touch', clientX: 0 })
    expect(container.querySelector('.timeline-current-marker').classList.contains('is-scrubbing')).toBe(true)
    expect(container.querySelector('.timeline-current-frame-tip').textContent).toBe(t('preview.currentFrameTip', { frame: 0 }))
    fireEvent.pointerUp(timeline, { pointerId: 1, pointerType: 'touch' })
    expect(container.querySelector('.timeline-current-marker').classList.contains('is-scrubbing')).toBe(false)

    fireEvent.click(mobileToolsTarget.querySelector('.mobile-preview-menu > summary'))
    fireEvent.click(screen.getByRole('menuitem', { name: t('preview.markAsEnd') }))
    expect(onRangeChange).toHaveBeenCalledWith({ startFrame: 0, endFrame: 1 })
  })
})
