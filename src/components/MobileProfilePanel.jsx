import React from 'react'
import { Pencil, Plus, Trash2 } from 'lucide-react'
import { t } from '../i18n.js'
import { useAppDialog } from './AppDialog.jsx'

export default function MobileProfilePanel({
  profiles,
  activeProfileId,
  onSelect,
  onCreate,
  onRename,
  onDelete,
}) {
  const dialog = useAppDialog()
  const activeProfile = profiles.find(profile => profile.id === activeProfileId) || profiles[0]

  const createProfile = async () => {
    const name = await dialog.prompt(t('profile.createPrompt'), `Profile ${profiles.length + 1}`, { title: t('profile.add') })
    if (name !== null) onCreate(name)
  }

  const renameProfile = async () => {
    if (!activeProfile) return
    const name = await dialog.prompt(t('profile.renamePrompt'), activeProfile.name, { title: t('profile.rename') })
    if (name !== null) onRename(activeProfile.id, name)
  }

  return (
    <section className="mobile-profile-panel" aria-label={t('profile.label')}>
      <header className="mobile-section-heading">
        <strong>{t('profile.label')}</strong>
        <button type="button" className="mobile-icon-button" onClick={() => void createProfile()} aria-label={t('profile.add')} title={t('profile.add')}>
          <Plus size={18} aria-hidden="true" />
        </button>
      </header>
      <div className="mobile-profile-control">
        <select value={activeProfileId} onChange={event => onSelect(event.target.value)} aria-label={t('profile.label')}>
          {profiles.map(profile => (
            <option key={profile.id} value={profile.id}>{profile.name}</option>
          ))}
        </select>
        <button type="button" className="mobile-icon-button" onClick={() => void renameProfile()} aria-label={t('profile.rename')} title={t('profile.rename')}>
          <Pencil size={17} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="mobile-icon-button danger"
          onClick={() => activeProfile && onDelete(activeProfile.id)}
          disabled={profiles.length <= 1}
          aria-label={activeProfile ? t('profile.deleteLabel', { name: activeProfile.name }) : t('profile.deleteLabel', { name: '' })}
          title={activeProfile ? t('profile.deleteLabel', { name: activeProfile.name }) : ''}
        >
          <Trash2 size={17} aria-hidden="true" />
        </button>
      </div>
    </section>
  )
}
