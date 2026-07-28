export function shouldHandleDroppedVideo(file, handledFile) {
  return Boolean(file) && file !== handledFile
}

export function shouldHandleDroppedVideos(files, handledKey) {
  const list = Array.from(files || []).filter(Boolean)
  if (list.length === 0) return false
  if (list.length === 1) return shouldHandleDroppedVideo(list[0], handledKey)
  const key = list.map(file => `${file.name}:${file.size}:${file.lastModified || 0}`).join('|')
  return key !== handledKey
}

export function droppedVideosKey(files) {
  const list = Array.from(files || []).filter(Boolean)
  if (list.length === 0) return null
  if (list.length === 1) return list[0]
  return list.map(file => `${file.name}:${file.size}:${file.lastModified || 0}`).join('|')
}
