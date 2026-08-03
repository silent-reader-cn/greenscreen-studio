import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Check, Layers3, Pencil, Plus, Search, Trash2 } from 'lucide-react'
import { t, uiLanguage } from '../i18n.js'
import { isProjectProfile } from '../lib/appProfiles.js'
import { useAppDialog } from './AppDialog.jsx'

function sortProfiles(profiles) {
  return [...profiles].sort((a, b) => (
    (b.useCount || 0) - (a.useCount || 0) ||
    (b.lastUsedAt || 0) - (a.lastUsedAt || 0) ||
    (b.updatedAt || 0) - (a.updatedAt || 0) ||
    (a.name || '').localeCompare(b.name || '', uiLanguage === 'zh' ? 'zh-Hans-CN' : 'en-US')
  ))
}

export default function ProfileMenu({
  profiles,
  activeProfileId,
  onSelect,
  onCreate,
  onRename,
  onDelete,
}) {
  const dialog = useAppDialog()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const menuRef = useRef(null)
  const orderedProfiles = useMemo(() => sortProfiles(profiles), [profiles])
  const visibleProfiles = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase()
    return normalizedQuery
      ? orderedProfiles.filter(profile => profile.name.toLocaleLowerCase().includes(normalizedQuery))
      : orderedProfiles
  }, [orderedProfiles, query])
  const activeProfile = profiles.find(profile => profile.id === activeProfileId) || profiles[0]
  const canDelete = profiles.length > 1

  useEffect(() => {
    if (!open) return undefined

    const handlePointerDown = (event) => {
      if (!menuRef.current?.contains(event.target)) setOpen(false)
    }
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') setOpen(false)
    }

    document.addEventListener('pointerdown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [open])

  const handleCreate = async () => {
    const name = await dialog.prompt(
      t('profile.createPrompt'),
      `Profile ${profiles.length + 1}`,
      { title: t('profile.add') },
    )
    if (name !== null) onCreate(name)
  }

  const handleRename = async (profile) => {
    const name = await dialog.prompt(t('profile.renamePrompt'), profile.name, { title: t('profile.rename') })
    if (name === null) return
    const nextName = String(name || '').trim()
    if (nextName && nextName !== profile.name) onRename(profile.id, nextName)
  }

  return (
    <div className="profile-menu" ref={menuRef}>
      <button
        type="button"
        className={`header-brand-mark profile-menu-trigger ${open ? 'active' : ''}`}
        onClick={() => setOpen(value => !value)}
        aria-label={`${t('profile.label')}: ${activeProfile?.name || ''}`}
        aria-expanded={open}
        aria-haspopup="menu"
      >
        <Layers3 size={19} strokeWidth={1.8} aria-hidden="true" />
      </button>

      {open && (
        <div className="profile-menu-popover" role="menu" aria-label={t('profile.label')}>
          <header className="profile-menu-header">
            <div>
              <span>{t('profile.label')}</span>
              <strong title={activeProfile?.name}>{activeProfile?.name}</strong>
            </div>
            <button type="button" className="profile-menu-add" onClick={() => void handleCreate()} aria-label={t('profile.add')} title={t('profile.add')}>
              <Plus size={17} aria-hidden="true" />
            </button>
          </header>
          <label className="profile-menu-search">
            <Search size={15} aria-hidden="true" />
            <input
              type="search"
              value={query}
              onChange={event => setQuery(event.target.value)}
              placeholder={t('profile.search')}
              aria-label={t('profile.search')}
            />
          </label>

          <div className="profile-menu-list">
            {visibleProfiles.map(profile => {
              const active = profile.id === activeProfileId
              const locked = isProjectProfile(profile) // 项目内置：不可重命名/删除
              return (
                <div key={profile.id} className={`profile-menu-row ${active ? 'active' : ''} ${locked ? 'locked' : ''}`}>
                  <button
                    type="button"
                    className="profile-menu-select"
                    role="menuitemradio"
                    aria-checked={active}
                    onClick={() => {
                      onSelect(profile.id)
                      setOpen(false)
                    }}
                  >
                    <span className="profile-menu-check" aria-hidden="true">
                      {active && <Check size={15} />}
                    </span>
                    <span title={profile.name}>{profile.name}</span>
                  </button>
                  {!locked && (
                    <>
                      <button type="button" className="profile-menu-action" onClick={() => void handleRename(profile)} aria-label={`${t('profile.rename')}: ${profile.name}`} title={t('profile.rename')}>
                        <Pencil size={15} aria-hidden="true" />
                      </button>
                      <button
                        type="button"
                        className="profile-menu-action danger"
                        onClick={() => onDelete(profile.id)}
                        disabled={!canDelete}
                        aria-label={t('profile.deleteLabel', { name: profile.name })}
                        title={t('profile.deleteLabel', { name: profile.name })}
                      >
                        <Trash2 size={15} aria-hidden="true" />
                      </button>
                    </>
                  )}
                </div>
              )
            })}
            {visibleProfiles.length === 0 && <p className="profile-menu-empty">{t('profile.noResults')}</p>}
          </div>
        </div>
      )}
    </div>
  )
}
