// @vitest-environment jsdom

import React from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import MobileProfilePanel from '../MobileProfilePanel.jsx'
import { AppDialogProvider } from '../AppDialog.jsx'
import { t } from '../../i18n.js'

describe('MobileProfilePanel', () => {
  it('uses one mobile selector with compact edit actions', () => {
    const onSelect = vi.fn()
    const onDelete = vi.fn()
    const { container } = render(
      <AppDialogProvider>
        <MobileProfilePanel
          profiles={[{ id: 'default', name: '默认' }, { id: 'cinema', name: '电影' }]}
          activeProfileId="default"
          onSelect={onSelect}
          onCreate={vi.fn()}
          onRename={vi.fn()}
          onDelete={onDelete}
        />
      </AppDialogProvider>,
    )

    expect(container.querySelectorAll('select')).toHaveLength(1)
    fireEvent.change(screen.getByRole('combobox', { name: t('profile.label') }), { target: { value: 'cinema' } })
    expect(onSelect).toHaveBeenCalledWith('cinema')

    fireEvent.click(screen.getByRole('button', { name: t('profile.deleteLabel', { name: '默认' }) }))
    expect(onDelete).toHaveBeenCalledWith('default')
  })
})
