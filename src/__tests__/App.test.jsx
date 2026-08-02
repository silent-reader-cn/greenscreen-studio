// @vitest-environment jsdom

import React from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from '../App.jsx'
import { AppDialogProvider } from '../components/AppDialog.jsx'
import { t } from '../i18n.js'
import { THEME_STORAGE_KEY } from '../lib/theme.js'

class ResizeObserverStub {
  observe() {}
  disconnect() {}
}

class ImageStub {
  width = 2
  height = 2

  set src(value) {
    this._src = value
    queueMicrotask(() => this.onload?.())
  }

  get src() {
    return this._src
  }
}

const imageDataStub = () => ({
  width: 2,
  height: 2,
  data: new Uint8ClampedArray(16),
})

describe('App shell', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.stubGlobal('ResizeObserver', ResizeObserverStub)
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1))
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    vi.stubGlobal('Image', ImageStub)
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:test-image')
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => ({
      clearRect: vi.fn(),
      createImageData: vi.fn(() => imageDataStub()),
      drawImage: vi.fn(),
      fillRect: vi.fn(),
      getImageData: vi.fn(() => imageDataStub()),
      putImageData: vi.fn(),
    }))
    vi.stubGlobal('matchMedia', vi.fn(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })))
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('renders the initial image workspace without runtime errors', () => {
    render(
      <AppDialogProvider>
        <App />
      </AppDialogProvider>,
    )

    expect(screen.getByRole('button', { name: t('app.image') })).toBeTruthy()
    expect(screen.getByRole('button', { name: t('app.video') })).toBeTruthy()
    expect(screen.getAllByRole('button', { name: t('app.importAsset') }).length).toBeGreaterThan(0)
  })

  it('switches theme and persists the preference', () => {
    render(
      <AppDialogProvider>
        <App />
      </AppDialogProvider>,
    )

    const toggle = screen.getByRole('button', { name: t('app.switchToDarkMode') })
    expect(document.documentElement.dataset.theme).toBe('light')

    fireEvent.click(toggle)

    expect(document.documentElement.dataset.theme).toBe('dark')
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark')
    expect(screen.getByRole('button', { name: t('app.switchToLightMode') })).toBeTruthy()
  })

  it('restores a persisted dark theme', () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'dark')

    render(
      <AppDialogProvider>
        <App />
      </AppDialogProvider>,
    )

    expect(document.documentElement.dataset.theme).toBe('dark')
    expect(screen.getByRole('button', { name: t('app.switchToLightMode') })).toBeTruthy()
  })

  it('loads an image and renders its preview without runtime errors', async () => {
    const { container } = render(
      <AppDialogProvider>
        <App />
      </AppDialogProvider>,
    )
    const input = container.querySelector('input[type="file"]')
    const file = new File(['image'], 'test.png', { type: 'image/png' })

    fireEvent.change(input, { target: { files: [file] } })

    await waitFor(() => {
      expect(screen.getByText('test.png')).toBeTruthy()
      expect(container.querySelector('canvas.preview-canvas')).toBeTruthy()
    })
  })
})
