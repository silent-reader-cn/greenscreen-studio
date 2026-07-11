import React, { useEffect, useMemo, useRef, useState } from 'react'

function sortProfilesByUsage(profiles) {
  return [...profiles].sort((a, b) => (
    (b.useCount || 0) - (a.useCount || 0) ||
    (b.lastUsedAt || 0) - (a.lastUsedAt || 0) ||
    (b.updatedAt || 0) - (a.updatedAt || 0) ||
    (a.name || '').localeCompare(b.name || '', 'zh-Hans-CN')
  ))
}

export default function ProfileSwitcher({
  profiles,
  activeProfileId,
  onSelect,
  onCreate,
  onDelete,
}) {
  const [open, setOpen] = useState(false)
  const dropdownRef = useRef(null)

  const orderedProfiles = useMemo(() => sortProfilesByUsage(profiles), [profiles])
  const quickProfiles = orderedProfiles.slice(0, 3)
  const quickProfileIds = new Set(quickProfiles.map(profile => profile.id))
  const dropdownProfiles = orderedProfiles.filter(profile => !quickProfileIds.has(profile.id))
  const activeDropdownProfile = dropdownProfiles.find(profile => profile.id === activeProfileId)
  const canDelete = profiles.length > 1

  useEffect(() => {
    if (!open) return

    const handlePointerDown = (event) => {
      if (!dropdownRef.current?.contains(event.target)) {
        setOpen(false)
      }
    }
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') {
        setOpen(false)
      }
    }

    document.addEventListener('pointerdown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [open])

  const handleCreate = () => {
    const defaultName = `Profile ${profiles.length + 1}`
    const name = prompt('新建 profile 名称', defaultName)
    if (name === null) return
    onCreate(name)
  }

  const renderProfileButton = (profile, compact = false) => (
    <div
      key={profile.id}
      className={`profile-chip ${profile.id === activeProfileId ? 'active' : ''} ${compact ? 'compact' : ''}`}
      title={`使用 ${profile.useCount || 0} 次`}
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
          aria-label={`删除 profile ${profile.name}`}
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

  return (
    <div className="profile-switcher" aria-label="Profiles">
      <span className="profile-label">Profiles</span>

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
            更多{activeDropdownProfile ? ` · ${activeDropdownProfile.name}` : ''} ▾
          </button>

          {open && (
            <div className="profile-dropdown">
              <p className="profile-dropdown-title">其他 Profiles</p>
              {dropdownProfiles.map(profile => renderProfileButton(profile, true))}
            </div>
          )}
        </div>
      )}

      <button type="button" className="profile-add" onClick={handleCreate}>
        ＋ 新建
      </button>
    </div>
  )
}
