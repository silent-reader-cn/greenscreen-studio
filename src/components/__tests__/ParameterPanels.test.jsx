// @vitest-environment jsdom

import React from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import KeyingPanel from '../KeyingPanel.jsx'
import LayoutPanel from '../LayoutPanel.jsx'
import { t } from '../../i18n.js'

describe('compact parameter panels', () => {
  it('renders keying controls directly without a redundant collapsible card', () => {
    const onChange = vi.fn()
    const { container } = render(
      <KeyingPanel
        params={{
          keyColor: [0, 255, 0],
          tolerance: 30,
          spillSuppression: 40,
          feather: 15,
          edgeShrink: 0,
        }}
        onChange={onChange}
      />,
    )

    expect(container.querySelector('.collapsible-panel')).toBeNull()
    const tolerance = screen.getByRole('slider', { name: t('keying.tolerance') })
    fireEvent.change(tolerance, { target: { value: '46' } })
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ tolerance: 46 }))
  })

  it('keeps layout controls semantic and exposes help without persistent hint blocks', () => {
    const onChange = vi.fn()
    const { container } = render(
      <LayoutPanel
        params={{
          canvasWidth: 1280,
          canvasHeight: 720,
          personWidth: 320,
          personHeight: 640,
          sourceCharacterHeight: 0,
          autoCrop: true,
          sourceCenterAnchor: true,
        }}
        onChange={onChange}
        imageSize={{ w: 1920, h: 1080 }}
      />,
    )

    expect(container.querySelector('.collapsible-panel')).toBeNull()
    expect(screen.getAllByRole('group')).toHaveLength(2)
    expect(screen.getByRole('button', { name: t('layout.autoCropHint') })).toBeTruthy()
    expect(container.querySelector('.toggle-hint')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: '1000×1000' }))
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({
      canvasWidth: 1000,
      canvasHeight: 1000,
    }))
  })
})
