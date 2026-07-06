import React from 'react'

export default function PreviewCanvas() {
  return (
    <div className="empty-preview">
      <div className="placeholder-icon">🖼️</div>
      <p>上传图片后在此预览</p>
      <p className="hint">支持抠像预览和合成预览两种模式</p>
    </div>
  )
}
