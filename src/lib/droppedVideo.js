export function shouldHandleDroppedVideo(file, handledFile) {
  return Boolean(file) && file !== handledFile
}
