// @vitest-environment jsdom

import React from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import WorkspaceSidebar from '../WorkspaceSidebar.jsx'
import { t } from '../../i18n.js'

describe('WorkspaceSidebar', () => {
  it('keeps image tools focused on keying, layout, and export', () => {
    const onToolChange = vi.fn()

    render(
      <WorkspaceSidebar
        activeTool="keying"
        mediaMode="image"
        onToolChange={onToolChange}
      >
        <p>keying panel</p>
      </WorkspaceSidebar>,
    )

    expect(screen.getByRole('navigation', { name: t('app.workspaceNavLabel') })).toBeTruthy()
    expect(screen.queryByRole('button', { name: t('app.workspaceSource') })).toBeNull()
    expect(screen.getByRole('button', { name: t('app.workspaceKeying') }).getAttribute('aria-current')).toBe('page')
    expect(screen.queryByRole('button', { name: t('app.workspaceReview') })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: t('app.workspaceLayout') }))
    expect(onToolChange).toHaveBeenCalledWith('layout')
  })

  it('adds the review workspace for video without removing shared tools', () => {
    render(
      <WorkspaceSidebar
        activeTool="review"
        mediaMode="video"
        onToolChange={() => {}}
      >
        <p>review panel</p>
      </WorkspaceSidebar>,
    )

    expect(screen.getByRole('button', { name: t('app.workspaceReview') }).getAttribute('aria-current')).toBe('page')
    expect(screen.getByRole('button', { name: t('app.workspaceExport') })).toBeTruthy()
    expect(screen.getByText(t('app.video'))).toBeTruthy()
  })

  it('supports keyboard resizing and persists the desktop workspace width', () => {
    window.localStorage.removeItem('greenscreen.desktopSidebarWidth')
    const { container } = render(
      <WorkspaceSidebar
        activeTool="layout"
        mediaMode="image"
        onToolChange={() => {}}
      >
        <p>layout panel</p>
      </WorkspaceSidebar>,
    )

    const sidebar = container.querySelector('.workspace-sidebar')
    const separator = screen.getByRole('separator', { name: t('app.resizeWorkspace') })
    const before = Number(separator.getAttribute('aria-valuenow'))

    fireEvent.keyDown(separator, { key: 'ArrowRight' })

    expect(separator.getAttribute('aria-valuenow')).toBe(String(before + 16))
    expect(sidebar.style.getPropertyValue('--workspace-sidebar-width')).toBe(`${before + 16}px`)
    expect(window.localStorage.getItem('greenscreen.desktopSidebarWidth')).toBe(String(before + 16))
  })

  it('does not overwrite the saved desktop width while mounted on mobile', () => {
    const originalWidth = window.innerWidth
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 })
    window.localStorage.setItem('greenscreen.desktopSidebarWidth', '560')

    render(
      <WorkspaceSidebar
        activeTool="keying"
        mediaMode="image"
        onToolChange={() => {}}
      >
        <p>keying panel</p>
      </WorkspaceSidebar>,
    )

    expect(window.localStorage.getItem('greenscreen.desktopSidebarWidth')).toBe('560')
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: originalWidth })
  })

  it('exposes the three-stage mobile parameter sheet controls', () => {
    const onMobileSheetHandleClick = vi.fn()

    render(
      <WorkspaceSidebar
        activeTool="keying"
        mediaMode="image"
        mobileSheetState="half"
        onMobileSheetHandleClick={onMobileSheetHandleClick}
        onToolChange={() => {}}
      >
        <p>keying panel</p>
      </WorkspaceSidebar>,
    )

    const dragHandle = screen.getByRole('button', { name: t('app.mobileSheetDragLabel') })
    expect(dragHandle.textContent).toContain(t('app.mobileSheetHalf'))
    expect(dragHandle.querySelector('.visually-hidden')).toBeTruthy()
    fireEvent.click(dragHandle)
    expect(onMobileSheetHandleClick).toHaveBeenCalledOnce()
    expect(screen.queryByRole('button', { name: t('app.mobileSheetCollapse') })).toBeNull()
    expect(screen.queryByRole('button', { name: t('app.mobileSheetExpand') })).toBeNull()
  })
})
