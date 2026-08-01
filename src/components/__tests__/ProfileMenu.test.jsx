// @vitest-environment jsdom

import React from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import ProfileMenu from '../ProfileMenu.jsx'
import { AppDialogProvider } from '../AppDialog.jsx'
import { t } from '../../i18n.js'

describe('ProfileMenu', () => {
  it('opens from the brand icon and supports selecting and deleting profiles', () => {
    const onSelect = vi.fn()
    const onDelete = vi.fn()

    render(
      <AppDialogProvider>
        <ProfileMenu
          profiles={[{ id: 'default', name: '默认' }, { id: 'cinema', name: '电影' }]}
          activeProfileId="default"
          onSelect={onSelect}
          onCreate={vi.fn()}
          onRename={vi.fn()}
          onDelete={onDelete}
        />
      </AppDialogProvider>,
    )

    const trigger = screen.getByRole('button', { name: `${t('profile.label')}: 默认` })
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(trigger)
    fireEvent.change(screen.getByRole('searchbox', { name: t('profile.search') }), { target: { value: '电影' } })

    fireEvent.click(screen.getByRole('menuitemradio', { name: '电影' }))
    expect(onSelect).toHaveBeenCalledWith('cinema')

    fireEvent.click(trigger)
    fireEvent.click(screen.getByRole('button', { name: t('profile.deleteLabel', { name: '电影' }) }))
    expect(onDelete).toHaveBeenCalledWith('cinema')
  })
})
