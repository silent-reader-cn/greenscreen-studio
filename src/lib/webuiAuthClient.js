/**
 * WebUI 访问密码 — 前端客户端（2026-08-10）
 *
 * - token 存 localStorage（key greenscreen-studio-auth-token）
 * - installAuthFetch() 在 main.jsx 调用：包装 window.fetch，自动附加
 *   Authorization: Bearer <token>；业务 API 返回 401 时派发
 *   'webui-unauthorized' 事件（App 监听后切到登录页）
 * - /api/auth/* 自身请求不附加 token、不触发 unauthorized（登录接口 401 = 密码错）
 */

const TOKEN_KEY = 'greenscreen-studio-auth-token'

export function getAuthToken() {
  try {
    return localStorage.getItem(TOKEN_KEY)
  } catch {
    return null
  }
}

export function setAuthToken(token) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token)
    else localStorage.removeItem(TOKEN_KEY)
  } catch {
    /* ignore */
  }
}

export function clearAuthToken() {
  setAuthToken(null)
}

const isAuthApi = (url) => url.startsWith('/api/auth/login')

export function installAuthFetch() {
  if (typeof window === 'undefined' || window.__authFetchInstalled) return
  window.__authFetchInstalled = true

  const originalFetch = window.fetch.bind(window)

  window.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : (input && input.url ? input.url : '')
    const isApi = url.startsWith('/api/')

    let requestInit = init
    if (isApi && !isAuthApi(url)) {
      const token = getAuthToken()
      if (token) {
        const headers = new Headers(init.headers || {})
        if (!headers.has('Authorization')) headers.set('Authorization', `Bearer ${token}`)
        requestInit = { ...init, headers }
      }
    }

    const response = await originalFetch(input, requestInit)

    // 业务 API 401 → token 缺失/失效 → 通知 App 锁定
    if (isApi && !isAuthApi(url) && response.status === 401) {
      clearAuthToken()
      window.dispatchEvent(new CustomEvent('webui-unauthorized'))
    }
    return response
  }
}

/** 查询后端认证状态（不抛异常，失败按未启用处理） */
export async function fetchAuthStatus() {
  try {
    const resp = await fetch('/api/auth/status')
    if (!resp.ok) return { enabled: false, authenticated: false }
    return await resp.json()
  } catch {
    return { enabled: false, authenticated: false }
  }
}

/** 登录：成功返回 token，失败抛 Error（含 code） */
export async function loginWithPassword(password) {
  const resp = await fetch('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  })
  const data = await resp.json().catch(() => ({}))
  if (!resp.ok) {
    const err = new Error(data.error || 'login failed')
    err.code = data.code
    throw err
  }
  setAuthToken(data.token)
  return data.token
}
