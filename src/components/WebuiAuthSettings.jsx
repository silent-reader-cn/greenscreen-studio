import React, { useCallback, useEffect, useState } from 'react'
import { Save, X } from 'lucide-react'
import { t } from '../i18n.js'

/**
 * WebUI 访问密码设置浮层（header 齿轮按钮打开）。
 *
 * - 读取 GET /api/auth/config 显示当前开关状态
 * - 保存 PATCH /api/auth/config：
 *   - 未启用 → 开启：只需新密码（首次初始化）
 *   - 已启用 → 改密码：currentPassword + 新密码；关闭：currentPassword
 * - 保存成功后 token 不失效（配置改动不影响已签发 token）
 */
export default function WebuiAuthSettings({ onClose }) {
  const [enabled, setEnabled] = useState(false)
  const [initialEnabled, setInitialEnabled] = useState(false)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [password, setPassword] = useState('')
  const [currentPassword, setCurrentPassword] = useState('')
  const [message, setMessage] = useState(null) // { kind: 'ok' | 'err', text }

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const resp = await fetch('/api/auth/config')
        if (!resp.ok) throw new Error(`status ${resp.status}`)
        const data = await resp.json()
        if (!cancelled) {
          setEnabled(!!data.enabled)
          setInitialEnabled(!!data.enabled)
        }
      } catch {
        if (!cancelled) setMessage({ kind: 'err', text: t('webuiAuth.saveFailed') })
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [])

  const handleSave = useCallback(async () => {
    if (busy) return
    setBusy(true)
    setMessage(null)
    try {
      const body = { enabled }
      if (enabled) {
        if (!password || password.length < 4) {
          setMessage({ kind: 'err', text: t('webuiAuth.tooShort') })
          return
        }
        body.password = password
        if (initialEnabled) body.currentPassword = currentPassword // 已启用 → 改密码需验证
      } else {
        if (initialEnabled) body.currentPassword = currentPassword // 已启用 → 关闭需验证
      }

      const resp = await fetch('/api/auth/config', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await resp.json().catch(() => ({}))
      if (!resp.ok) {
        if (data.code === 'CURRENT_PASSWORD_REQUIRED') {
          setMessage({ kind: 'err', text: t('webuiAuth.currentPasswordWrong') })
        } else if (data.code === 'PASSWORD_TOO_SHORT') {
          setMessage({ kind: 'err', text: t('webuiAuth.tooShort') })
        } else {
          setMessage({ kind: 'err', text: t('webuiAuth.saveFailed') })
        }
        return
      }
      setInitialEnabled(!!data.enabled)
      setPassword('')
      setCurrentPassword('')
      setMessage({ kind: 'ok', text: t('webuiAuth.saved') })
    } catch {
      setMessage({ kind: 'err', text: t('webuiAuth.saveFailed') })
    } finally {
      setBusy(false)
    }
  }, [busy, enabled, initialEnabled, password, currentPassword])

  return (
    <div className="auth-settings-backdrop" onClick={onClose}>
      <div
        className="auth-settings-card"
        role="dialog"
        aria-modal="true"
        aria-label={t('webuiAuth.settingsTitle')}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="auth-settings-header">
          <strong>{t('webuiAuth.settingsTitle')}</strong>
          <button type="button" className="auth-settings-close" onClick={onClose} aria-label={t('studio.close')}>
            <X size={16} aria-hidden="true" />
          </button>
        </div>

        {loading ? (
          <p className="auth-settings-loading">...</p>
        ) : (
          <>
            <p className="auth-settings-hint">{t('webuiAuth.settingsHint')}</p>

            <label className="auth-settings-toggle">
              <input
                type="checkbox"
                checked={enabled}
                onChange={(event) => setEnabled(event.target.checked)}
              />
              <span>{t('webuiAuth.enableLabel')}</span>
            </label>

            {enabled && (
              <label className="auth-settings-field">
                <span>{t('webuiAuth.newPasswordLabel')}</span>
                <input
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  autoComplete="new-password"
                />
              </label>
            )}

            {initialEnabled && (
              <label className="auth-settings-field">
                <span>{t('webuiAuth.currentPasswordLabel')}</span>
                <input
                  type="password"
                  value={currentPassword}
                  onChange={(event) => setCurrentPassword(event.target.value)}
                  autoComplete="current-password"
                />
              </label>
            )}
            {initialEnabled && (
              <p className="auth-settings-field-hint">{t('webuiAuth.currentPasswordHint')}</p>
            )}

            {message && <p className={`auth-settings-message ${message.kind}`}>{message.text}</p>}

            <div className="auth-settings-actions">
              <button type="button" className="auth-settings-save" onClick={handleSave} disabled={busy}>
                <Save size={15} aria-hidden="true" />
                <span>{t('webuiAuth.saveButton')}</span>
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
