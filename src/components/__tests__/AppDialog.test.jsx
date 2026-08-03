// @vitest-environment jsdom

import React, { useState } from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { AppDialogProvider, useAppDialog } from '../AppDialog.jsx'
import { t } from '../../i18n.js'

function DialogHarness() {
  const dialog = useAppDialog()
  const [result, setResult] = useState('')

  return (
    <>
      <button type="button" onClick={async () => setResult(String(await dialog.confirm('Delete this item?')))}>
        Open confirm
      </button>
      <button type="button" onClick={async () => setResult(String(await dialog.prompt('Profile name', 'Default')))}>
        Open prompt
      </button>
      <button type="button" onClick={async () => setResult(String(await dialog.choose('Pick one?', {
        title: 'Pick',
        options: [
          { label: 'Alpha', value: 'alpha' },
          { label: 'Beta', value: 'beta', tone: 'danger' },
        ],
      }))) || 'null'}>
        Open choose
      </button>
      <output aria-label="dialog result">{result}</output>
    </>
  )
}

function renderHarness() {
  return render(
    <AppDialogProvider>
      <DialogHarness />
    </AppDialogProvider>,
  )
}

describe('AppDialogProvider', () => {
  it('resolves confirm actions from both buttons', async () => {
    renderHarness()

    fireEvent.click(screen.getByRole('button', { name: 'Open confirm' }))
    fireEvent.click(screen.getByRole('button', { name: t('common.cancel') }))
    await waitFor(() => expect(screen.getByLabelText('dialog result').textContent).toBe('false'))

    fireEvent.click(screen.getByRole('button', { name: 'Open confirm' }))
    fireEvent.click(screen.getByRole('button', { name: t('common.confirm') }))
    await waitFor(() => expect(screen.getByLabelText('dialog result').textContent).toBe('true'))
  })

  it('focuses prompt input and submits the trimmed value', async () => {
    renderHarness()

    fireEvent.click(screen.getByRole('button', { name: 'Open prompt' }))
    const input = screen.getByRole('textbox', { name: 'Profile name' })
    expect(document.activeElement).toBe(input)
    fireEvent.change(input, { target: { value: '  Mobile profile  ' } })
    fireEvent.click(screen.getByRole('button', { name: t('common.confirm') }))

    await waitFor(() => expect(screen.getByLabelText('dialog result').textContent).toBe('Mobile profile'))
  })

  it('treats Escape as a safe cancellation', async () => {
    renderHarness()

    fireEvent.click(screen.getByRole('button', { name: 'Open confirm' }))
    expect(screen.getByRole('dialog')).toBeTruthy()
    fireEvent.keyDown(document, { key: 'Escape' })

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(screen.getByLabelText('dialog result').textContent).toBe('false')
  })

  it('resolves choose actions to the selected option value', async () => {
    renderHarness()

    fireEvent.click(screen.getByRole('button', { name: 'Open choose' }))
    expect(screen.getByRole('dialog')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Alpha' }))
    await waitFor(() => expect(screen.getByLabelText('dialog result').textContent).toBe('alpha'))

    fireEvent.click(screen.getByRole('button', { name: 'Open choose' }))
    fireEvent.click(screen.getByRole('button', { name: 'Beta' }))
    await waitFor(() => expect(screen.getByLabelText('dialog result').textContent).toBe('beta'))
  })

  it('resolves choose dismissal (Escape) to null', async () => {
    renderHarness()

    fireEvent.click(screen.getByRole('button', { name: 'Open choose' }))
    fireEvent.keyDown(document, { key: 'Escape' })

    await waitFor(() => expect(screen.getByLabelText('dialog result').textContent).toBe('null'))
  })
})
