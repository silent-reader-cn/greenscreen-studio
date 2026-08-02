// @vitest-environment jsdom

import React from 'react'
import { render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import VideoExportControls from '../VideoExportControls.jsx'

function renderControls() {
  return render(
    <VideoExportControls
      mobile
      exportMode="video"
      setExportMode={vi.fn()}
      mode="transparent"
      setMode={vi.fn()}
      availableFormats={[{ value: 'webm', labelKey: 'videoPanel.formatWebm' }]}
      format="webm"
      setFormat={vi.fn()}
      range={{ startFrame: 0, endFrame: 240 }}
      onRangeChange={vi.fn()}
      videoInfo={{ frameCount: 240, fps: 24, duration: 10 }}
      processing={false}
      spriteParams={{ selectionMode: 'sample', exactFramesText: '' }}
      setSpriteParams={vi.fn()}
      usesExactFrames={false}
      explicitFrameError=""
      explicitFrameSelection={{ frames: [] }}
      godotParams={{}}
      setGodotParams={vi.fn()}
      godotClips={[]}
      clipPreviews={{}}
      sourceVideos={{}}
    />,
  )
}

describe('VideoExportControls frame range layout', () => {
  it('marks the frame range section and its balanced input grid explicitly', () => {
    const { container } = renderControls()

    const section = container.querySelector('.mobile-frame-range-section')
    const grid = container.querySelector('.mobile-frame-range-grid')

    expect(section).not.toBeNull()
    expect(grid).not.toBeNull()
    expect(section.contains(grid)).toBe(true)
    expect(grid.querySelectorAll('input[type="number"]')).toHaveLength(2)
    expect(section.querySelector('.mobile-range-summary')).not.toBeNull()
  })
})
