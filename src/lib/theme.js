export const THEME_STORAGE_KEY = 'greenscreen-studio-theme'
export const DARK_MODE_QUERY = '(prefers-color-scheme: dark)'

export function getStoredTheme(storage = globalThis.localStorage) {
  try {
    const theme = storage?.getItem(THEME_STORAGE_KEY)
    return theme === 'light' || theme === 'dark' ? theme : null
  } catch {
    return null
  }
}

export function getSystemTheme(matchMedia = globalThis.matchMedia) {
  return typeof matchMedia === 'function' && matchMedia(DARK_MODE_QUERY).matches
    ? 'dark'
    : 'light'
}

export function getInitialTheme() {
  return getStoredTheme() || getSystemTheme()
}

export function applyTheme(theme, root = globalThis.document?.documentElement) {
  if (!root) return
  root.dataset.theme = theme
  root.style.colorScheme = theme
  root.ownerDocument?.querySelector('meta[name="theme-color"]')?.setAttribute(
    'content',
    theme === 'dark' ? '#101417' : '#eef1f4',
  )
}

export function storeTheme(theme, storage = globalThis.localStorage) {
  try {
    storage?.setItem(THEME_STORAGE_KEY, theme)
  } catch {
    // Theme switching should continue to work when storage is unavailable.
  }
}
