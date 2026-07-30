import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, CheckCircle2, MessageSquareText } from 'lucide-react'
import { t } from '../i18n.js'

const AppDialogContext = createContext(null)

const standaloneDialog = {
  alert: async (message) => globalThis.alert?.(message),
  confirm: async (message) => globalThis.confirm?.(message) ?? false,
  prompt: async (message, defaultValue = '') => globalThis.prompt?.(message, defaultValue) ?? null,
}

const RESULT_BY_TYPE = { alert: true, confirm: false, prompt: null }

export function AppDialogProvider({ children }) {
  const [dialog, setDialog] = useState(null)
  const inputRef = useRef(null)

  const open = useCallback((options) => new Promise((resolve) => {
    setDialog({
      type: 'alert',
      title: '',
      message: '',
      defaultValue: '',
      tone: 'default',
      ...options,
      resolve,
    })
  }), [])

  const finish = useCallback((value) => {
    setDialog((current) => {
      current?.resolve(value)
      return null
    })
  }, [])

  useEffect(() => {
    if (!dialog) return undefined
    const handleKeyDown = (event) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      finish(RESULT_BY_TYPE[dialog.type])
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [dialog, finish])

  useEffect(() => {
    if (dialog?.type === 'prompt') inputRef.current?.focus()
  }, [dialog])

  const api = useMemo(() => ({
    alert: (message, options = {}) => open({ ...options, type: 'alert', message }),
    confirm: (message, options = {}) => open({ ...options, type: 'confirm', message }),
    prompt: (message, defaultValue = '', options = {}) => open({
      ...options,
      type: 'prompt',
      message,
      defaultValue,
    }),
  }), [open])

  const Icon = dialog?.tone === 'danger' || dialog?.tone === 'warning'
    ? AlertTriangle
    : dialog?.type === 'alert'
      ? CheckCircle2
      : MessageSquareText

  return (
    <AppDialogContext.Provider value={api}>
      {children}
      {dialog && (
        <div className="app-dialog-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget) finish(RESULT_BY_TYPE[dialog.type])
        }}>
          <form
            className={`app-dialog tone-${dialog.tone}`}
            role="dialog"
            aria-modal="true"
            aria-labelledby="app-dialog-title"
            onSubmit={(event) => {
              event.preventDefault()
              if (dialog.type === 'prompt') {
                finish(String(inputRef.current?.value || '').trim())
              } else {
                finish(true)
              }
            }}
          >
            <div className="app-dialog-heading">
              <span className="app-dialog-icon" aria-hidden="true"><Icon size={19} /></span>
              <div>
                <h2 id="app-dialog-title">{dialog.title || t('common.confirm')}</h2>
                <p>{dialog.message}</p>
              </div>
            </div>
            {dialog.type === 'prompt' && (
              <input
                ref={inputRef}
                className="app-dialog-input"
                defaultValue={dialog.defaultValue}
                aria-label={dialog.message}
                maxLength={120}
              />
            )}
            <div className="app-dialog-actions">
              {dialog.type !== 'alert' && (
                <button type="button" className="app-dialog-btn secondary" onClick={() => finish(RESULT_BY_TYPE[dialog.type])}>
                  {t('common.cancel')}
                </button>
              )}
              <button type="submit" className={`app-dialog-btn primary ${dialog.tone === 'danger' ? 'danger' : ''}`}>
                {dialog.confirmLabel || (dialog.type === 'alert' ? t('common.ok') : t('common.confirm'))}
              </button>
            </div>
          </form>
        </div>
      )}
    </AppDialogContext.Provider>
  )
}

export function useAppDialog() {
  const value = useContext(AppDialogContext)
  return value || standaloneDialog
}
