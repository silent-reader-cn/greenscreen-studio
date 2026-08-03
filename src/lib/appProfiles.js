import { t, uiLanguage } from '../i18n.js'

const DEFAULT_KEYING = {
  algorithm: 'classic',
  keyColor: [0, 255, 0],
  keyColor2: [0, 180, 0],
  gradientKey: false,
  tolerance: 30,
  spillSuppression: 40,
  feather: 15,
  edgeShrink: 0,
  keyBalance: 80,
  clipBlack: 0,
  clipWhite: 100,
  similarity: 20,
  spill: 50,
}

export const DEFAULT_LAYOUT = {
  canvasWidth: 1280,
  canvasHeight: 720,
  personWidth: 960,
  personHeight: 540,
  bgColor: [0, 255, 0],
  autoCrop: true,
  sourceCenterAnchor: true,
  // 0 = 自动 fit 人物框；>0 = 源画面人物站立身高（px），跨段统一 scale
  sourceCharacterHeight: 0,
}

export const DEFAULT_SPRITE_PARAMS = {
  frameWidth: 128,
  frameHeight: 128,
  framesPerRow: 8,
  maxFrames: 64,
  sampleEvery: 1,
  selectionMode: 'sample',
  exactFramesText: '',
}

export const DEFAULT_GODOT_PARAMS = {
  characterName: '',
  actionName: '',
  exportName: '',
  animationName: 'animation',
  safeAreaWidth: 160,
  safeAreaHeight: 160,
  fps: 12,
  loop: true,
}

export const DEFAULT_VIDEO_PARAMS = {
  mode: 'transparent',
  format: 'webm',
  exportMode: 'video',
  spriteParams: DEFAULT_SPRITE_PARAMS,
  godotParams: DEFAULT_GODOT_PARAMS,
}

export const DEFAULT_FRAME_RANGE = {
  startFrame: 0,
  endFrame: 0,
}

// ===== 项目内置 profile（绑定项目，存后端 projects.params.profile）=====
export const PROJECT_PROFILE_ID_PREFIX = 'project:'

export function isProjectProfile(profile) {
  return Boolean(profile && typeof profile.id === 'string' && profile.id.startsWith(PROJECT_PROFILE_ID_PREFIX))
}

export function getProjectIdFromProfile(profile) {
  return isProjectProfile(profile) ? profile.id.slice(PROJECT_PROFILE_ID_PREFIX.length) : null
}

export function makeProjectProfileId(projectId) {
  return `${PROJECT_PROFILE_ID_PREFIX}${projectId}`
}

// 从任意参数构建项目内置 profile。sourceParams 可为 null（用默认值）。
export function makeProjectProfile(projectId, projectName, sourceParams = null) {
  const profile = makeProfile(t('profile.projectBuiltInName', { name: projectName }), sourceParams, {
    id: makeProjectProfileId(projectId),
  })
  profile.isProjectProfile = true
  profile.projectId = projectId
  return profile
}

// 序列化：profile → projects.params.profile 存储结构（去掉运行时字段）
export function profileToProjectParams(profile) {
  if (!profile) return null
  return {
    name: profile.name,
    keying: profile.keying,
    layout: profile.layout,
    video: profile.video,
    frameRange: profile.frameRange,
    updatedAt: profile.updatedAt || Date.now(),
  }
}

// 反序列化：projects.params.profile → profile（无则返回 null）
export function projectProfileFromParams(projectId, projectName, params = null) {
  const stored = params?.profile
  if (!stored || typeof stored !== 'object') return null
  return makeProjectProfile(projectId, projectName, stored)
}

// localStorage 持久化
export const STORAGE_KEY = 'greenscreen-studio-params'
export const PROFILES_STORAGE_KEY = 'greenscreen-studio-profiles'

const cloneArray = (value, fallback) => (
  Array.isArray(value) && value.length === fallback.length ? [...value] : [...fallback]
)

export function normalizeParams(params = {}) {
  const source = params || {}
  const keying = source.keying || {}
  const layout = source.layout || {}
  const video = source.video || {}
  const spriteParams = video.spriteParams || {}
  const frameRange = source.frameRange || {}

  return {
    keying: {
      ...DEFAULT_KEYING,
      ...keying,
      keyColor: cloneArray(keying.keyColor, DEFAULT_KEYING.keyColor),
      keyColor2: cloneArray(keying.keyColor2, DEFAULT_KEYING.keyColor2),
      gradientKey: keying.gradientKey === true,
    },
    layout: {
      ...DEFAULT_LAYOUT,
      ...layout,
      bgColor: cloneArray(layout.bgColor, DEFAULT_LAYOUT.bgColor),
      sourceCharacterHeight: Math.max(0, Math.round(Number(layout.sourceCharacterHeight) || 0)),
    },
    video: {
      ...DEFAULT_VIDEO_PARAMS,
      ...video,
      spriteParams: {
        ...DEFAULT_SPRITE_PARAMS,
        ...spriteParams,
      },
      godotParams: {
        ...DEFAULT_GODOT_PARAMS,
        ...(video.godotParams || {}),
      },
    },
    frameRange: {
      startFrame: Math.max(0, Number(frameRange.startFrame) || 0),
      endFrame: Math.max(0, Number(frameRange.endFrame) || 0),
    },
  }
}

export function createProfileId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID()
  }
  return `profile-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

export function makeProfile(name, params, overrides = {}) {
  const now = Date.now()
  const normalized = normalizeParams(params)
  const rawName = String(name || '').trim()
  return {
    id: overrides.id || createProfileId(),
    name: localizeBuiltInProfileName(overrides.id, rawName || t('profile.untitled')),
    keying: normalized.keying,
    layout: normalized.layout,
    video: normalized.video,
    frameRange: normalized.frameRange,
    useCount: overrides.useCount ?? 0,
    createdAt: overrides.createdAt || now,
    updatedAt: overrides.updatedAt || now,
    lastUsedAt: overrides.lastUsedAt || now,
  }
}

export function normalizeProfile(profile, index = 0) {
  const id = profile?.id || createProfileId()
  return makeProfile(profile?.name || `Profile ${index + 1}`, profile, {
    id,
    useCount: Number(profile?.useCount) || 0,
    createdAt: Number(profile?.createdAt) || Date.now(),
    updatedAt: Number(profile?.updatedAt) || Date.now(),
    lastUsedAt: Number(profile?.lastUsedAt) || 0,
  })
}

export function getProfileParams(profile) {
  return normalizeParams({
    keying: profile?.keying,
    layout: profile?.layout,
    video: profile?.video,
    frameRange: profile?.frameRange,
  })
}

export function getVideoTotalFrames(info) {
  if (!info) return 0
  return info.frameCount || Math.round(info.fps * info.duration)
}

export function resolveFrameRangeForVideo(range, info) {
  const normalized = normalizeParams({ frameRange: range }).frameRange
  const totalFrames = getVideoTotalFrames(info)
  if (!totalFrames) return normalized

  if (normalized.endFrame <= normalized.startFrame) {
    return { startFrame: 0, endFrame: totalFrames }
  }

  const startFrame = Math.min(normalized.startFrame, totalFrames)
  const endFrame = Math.min(Math.max(normalized.endFrame, startFrame), totalFrames)
  return { startFrame, endFrame }
}

export function localizeBuiltInProfileName(id, name) {
  if (id === 'default' && ['默认', 'Default'].includes(name)) {
    return t('profile.defaultName')
  }
  return name
}

export function sortProfilesByUsage(profiles) {
  return [...profiles].sort((a, b) => (
    (b.useCount || 0) - (a.useCount || 0) ||
    (b.lastUsedAt || 0) - (a.lastUsedAt || 0) ||
    (b.updatedAt || 0) - (a.updatedAt || 0) ||
    (a.name || '').localeCompare(b.name || '', uiLanguage === 'zh' ? 'zh-Hans-CN' : 'en-US')
  ))
}

export function getUniqueProfileName(baseName, profiles) {
  const fallbackName = String(baseName || '').trim() || `Profile ${profiles.length + 1}`
  const existing = new Set(profiles.map(profile => profile.name))
  if (!existing.has(fallbackName)) return fallbackName

  let index = 2
  let nextName = `${fallbackName} ${index}`
  while (existing.has(nextName)) {
    index += 1
    nextName = `${fallbackName} ${index}`
  }
  return nextName
}

export function loadParams() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (saved) {
      const parsed = JSON.parse(saved)
      return {
        keying: { ...DEFAULT_KEYING, ...parsed.keying },
        layout: { ...DEFAULT_LAYOUT, ...parsed.layout },
      }
    }
  } catch (e) { /* ignore */ }
  return { keying: DEFAULT_KEYING, layout: DEFAULT_LAYOUT }
}

export function loadProfileState() {
  try {
    const saved = localStorage.getItem(PROFILES_STORAGE_KEY)
    if (saved) {
      const parsed = JSON.parse(saved)
      // 项目内置 profile 只在项目上下文存在，刷新/重启后必须从列表剔除，
      // 否则会留下幽灵条目（无 projectProfile 状态匹配）。
      const profiles = Array.isArray(parsed.profiles)
        ? parsed.profiles.map(normalizeProfile).filter(profile => profile.id && !isProjectProfile(profile))
        : []

      if (profiles.length > 0) {
        const activeProfileId = profiles.some(profile => profile.id === parsed.activeProfileId)
          ? parsed.activeProfileId
          : sortProfilesByUsage(profiles)[0].id
        return { profiles, activeProfileId }
      }
    }
  } catch (e) { /* ignore */ }

  const legacyParams = loadParams()
  const defaultProfile = makeProfile(t('profile.defaultName'), legacyParams, {
    id: 'default',
    useCount: 1,
  })
  return {
    profiles: [defaultProfile],
    activeProfileId: defaultProfile.id,
  }
}

export function saveProfileState(profiles, activeProfileId) {
  try {
    localStorage.setItem(PROFILES_STORAGE_KEY, JSON.stringify({ profiles, activeProfileId }))
  } catch (e) { /* ignore */ }
}

export function saveParams(keying, layout) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ keying, layout }))
  } catch (e) { /* ignore */ }
}
