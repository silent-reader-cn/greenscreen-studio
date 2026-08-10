import React, { useEffect, useRef, useState } from 'react'
import { Lock } from 'lucide-react'
import { t } from '../i18n.js'
import { loginWithPassword } from '../lib/webuiAuthClient.js'

/**
 * 全屏登录页：WebUI 启用访问密码且未认证时由 App 渲染。
 * 登录成功后派发 'webui-authenticated' 事件，App 监听后切回主界面。
 */
export default function LoginScreen() {
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const inputRef = useRef(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const handleSubmit = async (event) => {
    event.preventDefault()
    if (busy) return
    setBusy(true)
    setError('')
    try {
      await loginWithPassword(password)
      window.dispatchEvent(new CustomEvent('webui-authenticated'))
    } catch (err) {
      setError(err.code === 'BAD_CREDENTIALS' ? t('webuiAuth.loginError') : t('webuiAuth.loginFailed'))
      setPassword('')
      inputRef.current?.focus()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="auth-login-screen">
      <form className="auth-login-card" onSubmit={handleSubmit}>
        <div className="auth-login-icon" aria-hidden="true">
          <Lock size={28} />
        </div>
        <h1 className="auth-login-title">{t('webuiAuth.loginTitle')}</h1>
        <p className="auth-login-subtitle">{t('webuiAuth.loginSubtitle')}</p>
        <label className="auth-login-field">
          <span>{t('webuiAuth.passwordLabel')}</span>
          <input
            ref={inputRef}
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="current-password"
            disabled={busy}
            aria-invalid={!!error}
          />
        </label>
        {error && <p className="auth-login-error" role="alert">{error}</p>}
        <button type="submit" className="auth-login-button" disabled={busy || !password}>
          {busy ? '...' : t('webuiAuth.loginButton')}
        </button>
      </form>
    </div>
  )
}
