import React, { useEffect, useMemo, useRef, useState } from 'react'
import { t, uiLanguage } from '../i18n.js'

function sortProfilesByUsage(profiles) {
  return [...profiles].sort((a, b) => (
    (b.useCount || 0) - (a.useCount || 0) ||
    (b.lastUsedAt || 0) - (a.lastUsedAt || 0) ||
    (b.updatedAt || 0) - (a.updatedAt || 0) ||
    (a.name || '').localeCompare(b.name || '', uiLanguage === 'zh' ? 'zh-Hans-CN' : 'en-US')
  ))
}

function estimateTextWidth(text) {
  return Array.from(String(text || '')).reduce((total, char) => (
    total + (char.charCodeAt(0) > 255 ? 13 : 7)
  ), 0)
}

function estimateProfileChipWidth(profile, canDelete) {
  const textWidth = Math.min(104, Math.max(36, estimateTextWidth(profile.name)))
  return Math.min(150, textWidth + 23 + (canDelete ? 22 : 0) + 2)
}

function getQuickProfileCount(profiles, containerWidth, canDelete) {
  if (profiles.length <= 0) return 0
  if (containerWidth <= 0) return Math.min(3, profiles.length)

  const labelWidth = 58
  const addWidth = 70
  const outerGap = 8
  const quickGap = 6
  const moreWidth = 104

  for (let count = profiles.length; count >= 1; count--) {
    const chipWidth = profiles
      .slice(0, count)
      .reduce((total, profile) => total + estimateProfileChipWidth(profile, canDelete), 0)
    const chipGaps = Math.max(0, count - 1) * quickGap
    const hasMore = count < profiles.length
    const groupCount = 3 + (hasMore ? 1 : 0)
    const totalWidth = labelWidth + addWidth + chipWidth + chipGaps +
      (hasMore ? moreWidth : 0) + Math.max(0, groupCount - 1) * outerGap

    if (totalWidth <= containerWidth) return count
  }

  return 1
}

export default function ProfileSwitcher({
  profiles,
  activeProfileId,
  onSelect,
  onCreate,
  onRename,
  onDelete,
}) {
  const [open, setOpen] = useState(false)
  const [contextMenu, setContextMenu] = useState(null)
  const [switcherWidth, setSwitcherWidth] = useState(0)
  const switcherRef = useRef(null)
  const dropdownRef = useRef(null)
  const contextMenuRef = useRef(null)

  const orderedProfiles = useMemo(() => sortProfilesByUsage(profiles), [profiles])
  const canDelete = profiles.length > 1
  const quickProfileCount = useMemo(
    () => getQuickProfileCount(orderedProfiles, switcherWidth, canDelete),
    [canDelete, orderedProfiles, switcherWidth]
  )
  const quickProfiles = orderedProfiles.slice(0, quickProfileCount)
  const quickProfileIds = new Set(quickProfiles.map(profile => profile.id))
  const dropdownProfiles = orderedProfiles.filter(profile => !quickProfileIds.has(profile.id))
  const activeDropdownProfile = dropdownProfiles.find(profile => profile.id === activeProfileId)

  useEffect(() => {
    const switcher = switcherRef.current
    if (!switcher) return undefined

    const updateWidth = () => {
      const width = switcher.getBoundingClientRect().width
      setSwitcherWidth(prev => (prev === width ? prev : width))
    }

    updateWidth()
    const observer = new ResizeObserver(updateWidth)
    observer.observe(switcher)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (!open && !contextMenu) return

    const handlePointerDown = (event) => {
      if (open && !dropdownRef.current?.contains(event.target)) {
        setOpen(false)
      }
      if (contextMenu && !contextMenuRef.current?.contains(event.target)) {
        setContextMenu(null)
      }
    }
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') {
        setOpen(false)
        setContextMenu(null)
      }
    }

    document.addEventListener('pointerdown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [contextMenu, open])

  const handleCreate = () => {
    const defaultName = `Profile ${profiles.length + 1}`
    const name = prompt(t('profile.createPrompt'), defaultName)
    if (name === null) return
    onCreate(name)
  }

  const handleRename = (profile) => {
    const name = prompt(t('profile.renamePrompt'), profile.name)
    if (name === null) return
    const nextName = String(name || '').trim()
    if (!nextName || nextName === profile.name) return
    onRename(profile.id, nextName)
  }

  const handleProfileContextMenu = (event, profile) => {
    event.preventDefault()
    event.stopPropagation()
    setOpen(false)
    setContextMenu({
      profileId: profile.id,
      x: Math.max(8, Math.min(event.clientX, window.innerWidth - 132)),
      y: Math.max(8, Math.min(event.clientY, window.innerHeight - 44)),
    })
  }

  const renderProfileButton = (profile, compact = false) => (
    <div
      key={profile.id}
      className={`profile-chip ${profile.id === activeProfileId ? 'active' : ''} ${compact ? 'compact' : ''}`}
      title={t('profile.useCount', { count: profile.useCount || 0 })}
      onContextMenu={(event) => handleProfileContextMenu(event, profile)}
    >
      <button
        type="button"
        className="profile-chip-main"
        onClick={() => {
          onSelect(profile.id)
          if (compact) setOpen(false)
        }}
      >
        {profile.name}
      </button>
      {canDelete && (
        <button
          type="button"
          className="profile-chip-delete"
          aria-label={t('profile.deleteLabel', { name: profile.name })}
          onClick={(event) => {
            event.stopPropagation()
            onDelete(profile.id)
          }}
        >
          ×
        </button>
      )}
    </div>
  )

  const contextProfile = contextMenu
    ? profiles.find(profile => profile.id === contextMenu.profileId)
    : null

  return (
    <div className="profile-switcher" aria-label={t('profile.label')} ref={switcherRef}>
      <span className="profile-label">{t('profile.label')}</span>

      <div className="profile-quick-list">
        {quickProfiles.map(profile => renderProfileButton(profile))}
      </div>

      {dropdownProfiles.length > 0 && (
        <div className="profile-more" ref={dropdownRef}>
          <button
            type="button"
            className={`profile-more-btn ${activeDropdownProfile ? 'active' : ''}`}
            onClick={() => setOpen(prev => !prev)}
          >
            {t('profile.more')}{activeDropdownProfile ? ` · ${activeDropdownProfile.name}` : ''} ▾
          </button>

          {open && (
            <div className="profile-dropdown">
              <p className="profile-dropdown-title">{t('profile.otherProfiles')}</p>
              {dropdownProfiles.map(profile => renderProfileButton(profile, true))}
            </div>
          )}
        </div>
      )}

      <button type="button" className="profile-add" onClick={handleCreate}>
        {t('profile.add')}
      </button>

      {contextMenu && contextProfile && (
        <div
          ref={contextMenuRef}
          className="profile-context-menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onPointerDown={event => event.stopPropagation()}
        >
          <button
            type="button"
            onClick={() => {
              setContextMenu(null)
              handleRename(contextProfile)
            }}
          >
            {t('profile.rename')}
          </button>
        </div>
      )}
    </div>
  )
}
