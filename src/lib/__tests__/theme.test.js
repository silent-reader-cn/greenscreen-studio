import { describe, expect, it, vi } from 'vitest'
import { applyTheme, getStoredTheme, getSystemTheme, storeTheme, THEME_STORAGE_KEY } from '../theme.js'

describe('theme preferences', () => {
  it('accepts only supported stored themes', () => {
    expect(getStoredTheme({ getItem: () => 'dark' })).toBe('dark')
    expect(getStoredTheme({ getItem: () => 'sepia' })).toBeNull()
  })

  it('resolves the operating system preference', () => {
    expect(getSystemTheme(() => ({ matches: true }))).toBe('dark')
    expect(getSystemTheme(() => ({ matches: false }))).toBe('light')
  })

  it('applies and stores a theme', () => {
    const meta = { setAttribute: vi.fn() }
    const root = {
      dataset: {},
      style: {},
      ownerDocument: { querySelector: () => meta },
    }
    const storage = { setItem: vi.fn() }

    applyTheme('dark', root)
    storeTheme('dark', storage)

    expect(root.dataset.theme).toBe('dark')
    expect(root.style.colorScheme).toBe('dark')
    expect(meta.setAttribute).toHaveBeenCalledWith('content', '#101417')
    expect(storage.setItem).toHaveBeenCalledWith(THEME_STORAGE_KEY, 'dark')
  })
})
