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
    expect(container.querySelectorAll('.control-section')).toHaveLength(3)
    expect(screen.getByRole('group', { name: t('layout.canvasPresets') })).toBeTruthy()
    expect(screen.getByRole('button', { name: t('layout.autoCropHint') })).toBeTruthy()
    expect(container.querySelector('.toggle-hint')).toBeNull()
    expect(container.querySelector('.layout-auto-detect-action')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: '1024×1024' }))
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({
      canvasWidth: 1024,
      canvasHeight: 1024,
    }))

    onChange.mockClear()
    fireEvent.click(screen.getByRole('button', { name: t('layout.autoCropHint') }))
    expect(onChange).not.toHaveBeenCalled()
  })

  it('keeps automatic source-height detection as a compact title action', () => {
    const onAutoDetect = vi.fn()
    const { container } = render(
      <LayoutPanel
        params={{
          canvasWidth: 1280,
          canvasHeight: 720,
          personWidth: 320,
          personHeight: 640,
          sourceCharacterHeight: 480,
          autoCrop: true,
          sourceCenterAnchor: true,
        }}
        onChange={vi.fn()}
        imageSize={{ w: 1920, h: 1080 }}
        canAutoDetectSourceCharacterHeight
        onAutoDetectSourceCharacterHeight={onAutoDetect}
      />,
    )

    const detectButton = screen.getByRole('button', { name: t('layout.autoDetectSourceHeight') })
    expect(detectButton.classList.contains('layout-auto-detect-action')).toBe(true)
    expect(container.querySelector('.control-inline-action')).toBeNull()
    expect(container.textContent).not.toContain(t('layout.scaleLocked'))
    fireEvent.click(detectButton)
    expect(onAutoDetect).toHaveBeenCalledTimes(1)
  })

  it('renders the dedicated mobile layout and keeps desktop fieldsets out of the mobile DOM', () => {
    const onChange = vi.fn()
    const { container } = render(
      <LayoutPanel
        mobile
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

    expect(container.querySelector('.mobile-layout-panel')).toBeTruthy()
    expect(container.querySelectorAll('.mobile-size-section')).toHaveLength(1)
    expect(container.querySelectorAll('.mobile-size-group')).toHaveLength(2)
    expect(container.querySelector('fieldset')).toBeNull()
    expect(screen.getByRole('spinbutton', { name: t('layout.px') })).toBeTruthy()

    const presetMenu = container.querySelector('.mobile-preset-menu')
    fireEvent.click(presetMenu.querySelector('summary'))
    expect(presetMenu.open).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: '1024×1024' }))
    expect(presetMenu.open).toBe(false)
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({
      canvasWidth: 1024,
      canvasHeight: 1024,
    }))
  })

  it('does not render a reset action on mobile keying controls', () => {
    const { container } = render(
      <KeyingPanel
        mobile
        params={{ keyColor: [0, 255, 0], tolerance: 30, spillSuppression: 40, feather: 15, edgeShrink: 0 }}
        onChange={vi.fn()}
      />,
    )

    expect(container.querySelector('.mobile-keying-panel')).toBeTruthy()
    expect(container.querySelector('.desktop-keying-panel')).toBeNull()
    expect(screen.queryByRole('button', { name: t('keying.reset') })).toBeNull()
  })

  it('switches keying algorithm via combo box and swaps parameter controls', () => {
    const onChange = vi.fn()
    const base = { keyColor: [0, 255, 0], tolerance: 30, spillSuppression: 40, feather: 15, edgeShrink: 0 }
    const { rerender } = render(<KeyingPanel params={base} onChange={onChange} />)

    // 默认 classic：有色容差，无相似度
    expect(screen.getByRole('slider', { name: t('keying.tolerance') })).toBeTruthy()
    expect(screen.queryByRole('slider', { name: t('keying.similarity') })).toBeNull()

    // combo box 在「颜色提取」标题行右侧
    const select = screen.getByRole('combobox', { name: t('keying.algorithm') })
    fireEvent.change(select, { target: { value: 'chroma' } })
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ algorithm: 'chroma' }))

    // 切到 chroma：渲染 similarity + spill + 渐变开关，隐藏 tolerance
    rerender(<KeyingPanel params={{ ...base, algorithm: 'chroma', similarity: 20, spill: 50 }} onChange={onChange} />)
    expect(screen.getByRole('slider', { name: t('keying.similarity') })).toBeTruthy()
    expect(screen.getByRole('slider', { name: t('keying.spill') })).toBeTruthy()
    expect(screen.queryByRole('slider', { name: t('keying.tolerance') })).toBeNull()

    // 渐变开关 → keyColor2 拾色出现
    expect(screen.queryByText(t('keying.keyColor2'))).toBeNull()
    fireEvent.click(screen.getByRole('checkbox'))
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ gradientKey: true }))
    rerender(<KeyingPanel params={{ ...base, algorithm: 'chroma', similarity: 20, spill: 50, gradientKey: true, keyColor2: [0, 180, 0] }} onChange={onChange} />)
    expect(screen.getByText(t('keying.keyColor2'))).toBeTruthy()
  })
})
