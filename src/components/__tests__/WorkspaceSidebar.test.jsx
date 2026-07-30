// @vitest-environment jsdom

import React from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import WorkspaceSidebar from '../WorkspaceSidebar.jsx'
import { t } from '../../i18n.js'

describe('WorkspaceSidebar', () => {
  it('keeps image tools focused on source, keying, layout, and export', () => {
    const onToolChange = vi.fn()

    render(
      <WorkspaceSidebar
        activeTool="source"
        mediaMode="image"
        onToolChange={onToolChange}
      >
        <p>source panel</p>
      </WorkspaceSidebar>,
    )

    expect(screen.getByRole('navigation', { name: t('app.workspaceNavLabel') })).toBeTruthy()
    expect(screen.getByRole('button', { name: t('app.workspaceSource') }).getAttribute('aria-current')).toBe('page')
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
