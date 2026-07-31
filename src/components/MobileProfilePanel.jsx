import React from 'react'
import { Pencil, Plus, Trash2 } from 'lucide-react'
import { t } from '../i18n.js'
import { useAppDialog } from './AppDialog.jsx'
import { CompactIconButton } from './ControlKit.jsx'

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
        <CompactIconButton icon={Plus} size="small" onClick={() => void createProfile()} label={t('profile.add')} />
      </header>
      <div className="mobile-profile-control">
        <select value={activeProfileId} onChange={event => onSelect(event.target.value)} aria-label={t('profile.label')}>
          {profiles.map(profile => (
            <option key={profile.id} value={profile.id}>{profile.name}</option>
          ))}
        </select>
        <CompactIconButton icon={Pencil} onClick={() => void renameProfile()} label={t('profile.rename')} />
        <CompactIconButton
          icon={Trash2}
          tone="danger"
          onClick={() => activeProfile && onDelete(activeProfile.id)}
          disabled={profiles.length <= 1}
          label={activeProfile ? t('profile.deleteLabel', { name: activeProfile.name }) : t('profile.deleteLabel', { name: '' })}
        />
      </div>
    </section>
  )
}
