import React, { useRef } from 'react'

export default function UploadZone({ onFileLoad, imageSize }) {
  const inputRef = useRef(null)

  const handleFile = (file) => {
    if (file && file.type.startsWith('image/')) {
      onFileLoad(file)
    }
  }

  const hasImage = imageSize.w > 0

  return (
    <div className="panel upload-zone">
      <h3>📁 素材上传</h3>
      <div
        className={`drop-area ${hasImage ? 'loaded' : ''}`}
        onClick={() => inputRef.current?.click()}
      >
        {hasImage ? (
          <>
            <p>✅ 图片已加载</p>
            <p className="hint">点击重新选择</p>
          </>
        ) : (
          <>
            <p>点击选择图片</p>
            <p className="hint">支持 PNG / JPG / WebP</p>
            <p className="hint" style={{ marginTop: 6, color: '#bbb' }}>
              拖放文件到窗口任意位置也可上传
            </p>
          </>
        )}
        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          style={{ display: 'none' }}
          onChange={(e) => handleFile(e.target.files[0])}
        />
      </div>
      {hasImage && (
        <div className="image-info">
          原图尺寸: <strong>{imageSize.w} × {imageSize.h}</strong>
        </div>
      )}
    </div>
  )
}
