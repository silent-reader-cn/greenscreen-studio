import { applyKeying, measureAlphaHeight } from './keying.js'
import { cropImageData } from './region.js'
import { getMediaKind } from './mediaFiles.js'
import { t } from '../i18n.js'

export function putImageDataLike(ctx, imageData, x = 0, y = 0) {
  const canvasImageData = ctx.createImageData(imageData.width, imageData.height)
  canvasImageData.data.set(imageData.data)
  ctx.putImageData(canvasImageData, x, y)
}

export function getContainSize(contentSize, containerSize) {
  if (
    !contentSize ||
    !containerSize ||
    contentSize.w <= 0 ||
    contentSize.h <= 0 ||
    containerSize.w <= 0 ||
    containerSize.h <= 0
  ) {
    return null
  }

  const aspect = contentSize.w / contentSize.h
  const containerAspect = containerSize.w / containerSize.h

  if (aspect > containerAspect) {
    return {
      w: Math.max(1, Math.round(containerSize.w)),
      h: Math.max(1, Math.round(containerSize.w / aspect)),
    }
  }

  return {
    w: Math.max(1, Math.round(containerSize.h * aspect)),
    h: Math.max(1, Math.round(containerSize.h)),
  }
}

export function readImageIntrinsicMetadata(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    let settled = false

    const settle = (metadata) => {
      if (settled) return
      settled = true
      window.clearTimeout(timeoutId)
      URL.revokeObjectURL(url)
      resolve(metadata)
    }

    const timeoutId = window.setTimeout(() => settle({}), 2500)
    img.onload = () => settle({
      width: img.naturalWidth || img.width,
      height: img.naturalHeight || img.height,
    })
    img.onerror = () => settle({})
    img.src = url
  })
}

export function readVideoIntrinsicMetadata(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file)
    const video = document.createElement('video')
    let settled = false

    const settle = (metadata) => {
      if (settled) return
      settled = true
      window.clearTimeout(timeoutId)
      video.removeAttribute('src')
      video.load()
      URL.revokeObjectURL(url)
      resolve(metadata)
    }

    const timeoutId = window.setTimeout(() => settle({}), 2500)
    video.preload = 'metadata'
    video.muted = true
    video.onloadedmetadata = () => settle({
      width: video.videoWidth,
      height: video.videoHeight,
      duration: Number.isFinite(video.duration) ? video.duration : 0,
    })
    video.onerror = () => settle({})
    video.src = url
    video.load()
  })
}

export function readMediaIntrinsicMetadata(file, kind = getMediaKind(file)) {
  if (kind === 'image') return readImageIntrinsicMetadata(file)
  if (kind === 'video') return readVideoIntrinsicMetadata(file)
  return Promise.resolve({})
}

export function captureVideoFirstFrame(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const video = document.createElement('video')
    let settled = false

    const cleanup = () => {
      video.removeAttribute('src')
      video.load()
      URL.revokeObjectURL(url)
    }
    const settle = (fn, value) => {
      if (settled) return
      settled = true
      window.clearTimeout(timeoutId)
      cleanup()
      fn(value)
    }

    const timeoutId = window.setTimeout(() => {
      settle(reject, new Error(t('layout.autoDetectHeightFailed')))
    }, 5000)

    const capture = () => {
      try {
        if (!video.videoWidth || !video.videoHeight) {
          throw new Error(t('layout.autoDetectHeightFailed'))
        }
        const canvas = document.createElement('canvas')
        canvas.width = video.videoWidth
        canvas.height = video.videoHeight
        const ctx = canvas.getContext('2d')
        ctx.drawImage(video, 0, 0)
        settle(resolve, ctx.getImageData(0, 0, canvas.width, canvas.height))
      } catch (err) {
        settle(reject, err)
      }
    }

    video.preload = 'auto'
    video.muted = true
    video.playsInline = true
    // 始终测真实视频首帧（第 0 秒），不要使用用户设置的 startFrame / 当前预览帧。
    video.currentTime = 0
    video.addEventListener('loadeddata', () => capture(), { once: true })
    video.addEventListener('error', () => settle(reject, new Error(t('layout.autoDetectHeightFailed'))), { once: true })
    video.src = url
    video.load()
  })
}

export function measureSourceCharacterHeight(imageData, keyingParams, region) {
  const processingData = cropImageData(imageData, region)
  if (!processingData) return 0

  const keyed = applyKeying(processingData, keyingParams)
  return measureAlphaHeight(keyed, 10)
}
