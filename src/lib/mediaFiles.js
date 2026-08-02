import { t } from '../i18n.js'

const IMAGE_MIME_BY_EXT = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  bmp: 'image/bmp',
  avif: 'image/avif',
}

export const VIDEO_MIME_BY_EXT = {
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  m4v: 'video/x-m4v',
  webm: 'video/webm',
  avi: 'video/x-msvideo',
  mkv: 'video/x-matroska',
}

export const MIME_BY_EXT = {
  ...IMAGE_MIME_BY_EXT,
  ...VIDEO_MIME_BY_EXT,
}

export const EXT_BY_MIME = Object.entries(MIME_BY_EXT).reduce((acc, [ext, mime]) => {
  acc[mime] = ext
  return acc
}, {})

export function getFileExtension(name = '') {
  const match = String(name).toLowerCase().match(/\.([a-z0-9]+)$/)
  return match ? match[1] : ''
}

export function getMediaKind(file) {
  if (!file) return null

  const type = String(file.type || '').toLowerCase()
  if (type.startsWith('image/')) return 'image'
  if (type.startsWith('video/')) return 'video'

  const ext = getFileExtension(file.name)
  if (IMAGE_MIME_BY_EXT[ext]) return 'image'
  if (VIDEO_MIME_BY_EXT[ext]) return 'video'

  return null
}

export function getMimeTypeForFile(file, kind) {
  const existingType = String(file?.type || '').toLowerCase()
  if (existingType.startsWith('image/') || existingType.startsWith('video/')) return existingType

  const ext = getFileExtension(file?.name)
  if (MIME_BY_EXT[ext]) return MIME_BY_EXT[ext]
  if (existingType) return existingType

  return kind === 'image' ? 'image/png' : kind === 'video' ? 'video/mp4' : ''
}

export function createClipboardFileName(kind, type) {
  const ext = EXT_BY_MIME[String(type || '').toLowerCase()] || (kind === 'image' ? 'png' : 'mp4')
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  return `clipboard-${kind}-${stamp}.${ext}`
}

export function normalizeMediaFile(file, knownKind = getMediaKind(file)) {
  if (!file || !knownKind) return null

  const type = getMimeTypeForFile(file, knownKind)
  const name = file.name || createClipboardFileName(knownKind, type)

  if (file.name && String(file.type || '').toLowerCase() === type) return file

  return new File([file], name, {
    type,
    lastModified: file.lastModified || Date.now(),
  })
}

export function getClipboardMediaFile(clipboardData) {
  const files = Array.from(clipboardData?.files || [])
  const file = files.find(item => getMediaKind(item))
  if (file) return normalizeMediaFile(file)

  const items = Array.from(clipboardData?.items || [])
  for (const item of items) {
    if (item.kind !== 'file') continue
    const candidate = item.getAsFile()
    const kind = getMediaKind(candidate)
    if (kind) return normalizeMediaFile(candidate, kind)
  }

  return null
}

export function getBaseMediaMetadata(file, kind = getMediaKind(file)) {
  return {
    kind,
    name: file?.name || createClipboardFileName(kind, file?.type),
    mimeType: file?.type || t('common.unknown'),
    size: file?.size || 0,
    lastModified: file?.lastModified || 0,
  }
}
