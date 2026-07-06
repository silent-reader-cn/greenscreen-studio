/**
 * 绿幕抠像算法 — 前后端共享
 *
 * 接收 ImageData，返回抠像后的 ImageData（RGBA，绿幕区域 alpha=0）
 * 同一份代码前端 Canvas 预览和后端 node-canvas 导出共用，保证所见即所得。
 *
 * 参数说明：
 *   keyColor:        [r, g, b]  键控色，默认 [0, 255, 0] 纯绿
 *   tolerance:       0-100      色容差，越大扣得越多
 *   spillSuppression:0-100      去绿溢强度，去除边缘绿色污染
 *   feather:         0-100      边缘羽化，alpha 过渡柔和度
 *   edgeShrink:      0-50       边缘收缩，向内收掉杂边
 */

/**
 * 计算两个颜色在 RGB 空间的距离（归一化到 0-1）
 */
function colorDistance(r1, g1, b1, r2, g2, b2) {
  const dr = r1 - r2;
  const dg = g1 - g2;
  const db = b1 - b2;
  return Math.sqrt(dr * dr + dg * dg + db * db) / 441.67295593; // sqrt(255^2*3)
}

/**
 * 核心抠像函数
 * @param {ImageData} imageData - 输入图像数据
 * @param {Object} params - 抠像参数
 * @returns {ImageData} - 抠像后的图像数据（新对象，不修改原图）
 */
export function applyKeying(imageData, params) {
  const {
    keyColor = [0, 255, 0],
    tolerance = 30,
    spillSuppression = 40,
    feather = 15,
    edgeShrink = 0,
  } = params;

  const { data, width, height } = imageData;
  // 创建输出数据（深拷贝）
  const out = new Uint8ClampedArray(data);

  const [kr, kg, kb] = keyColor;

  // 将参数映射到算法内部范围
  // tolerance 0-100 → 色彩距离阈值 0.0-0.5
  const tolDist = (tolerance / 100) * 0.5;
  // feather 0-100 → 过渡带宽度（在距离空间）
  const featherWidth = (feather / 100) * 0.15;
  // edgeShrink 0-50 → 像素收缩数（后面处理）
  const shrinkPixels = Math.round(edgeShrink);

  // ===== Pass 1: 逐像素计算 alpha =====
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];

    const dist = colorDistance(r, g, b, kr, kg, kb);

    let alpha;
    if (dist < tolDist) {
      // 完全是绿幕 → 完全透明
      alpha = 0;
    } else if (dist > tolDist + featherWidth) {
      // 远离绿幕 → 完全不透明
      alpha = 255;
    } else {
      // 过渡带 → 线性插值
      const t = (dist - tolDist) / featherWidth;
      alpha = Math.round(t * 255);
    }

    out[i + 3] = alpha;
  }

  // ===== Pass 2: 去绿溢 =====
  // 对所有非完全透明的像素，抑制绿色通道
  if (spillSuppression > 0) {
    const spillFactor = spillSuppression / 100; // 0-1
    for (let i = 0; i < out.length; i += 4) {
      const a = out[i + 3];
      if (a === 0) continue; // 跳过透明像素

      const r = out[i];
      const g = out[i + 1];
      const b = out[i + 2];

      // 如果 G 是最大通道且有溢出（g > max(r,b)），压低 G
      const maxRB = Math.max(r, b);
      if (g > maxRB) {
        // 将 G 向 max(r,b) 拉近，拉多少由 spillFactor 决定
        const excess = g - maxRB;
        out[i + 1] = Math.round(g - excess * spillFactor);
      }
    }
  }

  // ===== Pass 3: 边缘收缩（可选）=====
  // 向内侵蚀 alpha 通道，去掉边缘杂色
  if (shrinkPixels > 0) {
    erodeAlpha(out, width, height, shrinkPixels);
  }

  // 返回纯数据对象（不依赖 ImageData 构造器，前后端通用）
  return { data: out, width, height };
}

/**
 * Alpha 通道侵蚀（向内收缩边缘）
 */
function erodeAlpha(data, width, height, radius) {
  const original = new Uint8ClampedArray(data);
  const r = radius;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4 + 3; // alpha index

      // 检查周围 radius 范围内是否有透明像素
      let hasTransparent = false;
      for (let dy = -r; dy <= r && !hasTransparent; dy++) {
        for (let dx = -r; dx <= r && !hasTransparent; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
          // 只检查圆形范围
          if (dx * dx + dy * dy > r * r) continue;
          const nidx = (ny * width + nx) * 4 + 3;
          if (original[nidx] < 128) {
            hasTransparent = true;
          }
        }
      }

      // 如果附近有透明像素，当前像素也变透明（侵蚀）
      if (hasTransparent && original[idx] < 255) {
        data[idx] = 0;
      }
    }
  }
}

/**
 * 自动裁剪：找到 alpha > threshold 的 bounding box，裁掉透明边缘
 * 用于去掉原图中绿幕区域的干扰，让缩放基准是人物本身而非整张原图
 *
 * @param {Object} keyedData - 抠像后的数据 {data, width, height}
 * @param {number} threshold - alpha 阈值，默认 10
 * @returns {Object} 裁剪后的数据 {data, width, height}
 */
export function autoCropKeyed(keyedData, threshold = 10) {
  const { data, width, height } = keyedData;
  let minX = width, minY = height, maxX = 0, maxY = 0;
  let found = false;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const alpha = data[(y * width + x) * 4 + 3];
      if (alpha > threshold) {
        found = true;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  // 全透明或极小区域，不裁剪
  if (!found) return keyedData;

  const cropW = maxX - minX + 1;
  const cropH = maxY - minY + 1;
  const cropped = new Uint8ClampedArray(cropW * cropH * 4);

  for (let y = 0; y < cropH; y++) {
    for (let x = 0; x < cropW; x++) {
      const srcIdx = ((y + minY) * width + (x + minX)) * 4;
      const dstIdx = (y * cropW + x) * 4;
      cropped[dstIdx] = data[srcIdx];
      cropped[dstIdx + 1] = data[srcIdx + 1];
      cropped[dstIdx + 2] = data[srcIdx + 2];
      cropped[dstIdx + 3] = data[srcIdx + 3];
    }
  }

  return { data: cropped, width: cropW, height: cropH };
}

/**
 * 将抠像后的人物合成到绿幕画布上（居中 + 等比缩放）
 *
 * @param {Object} ctx - canvas 2d context（已创建好目标尺寸）
 * @param {ImageData} keyedImageData - 抠像后的人物 ImageData
 * @param {Object} layout - 布局参数
 *   canvasWidth, canvasHeight: 目标画布尺寸
 *   personWidth, personHeight: 人物目标框尺寸
 *   bgColor: [r, g, b] 绿幕底色
 * @param {Object} sourceCanvas - 临时 canvas，用于持有 keyedImageData
 */
export function composeToCanvas(ctx, keyedImageData, layout, tempCanvas) {
  const { canvasWidth, canvasHeight, personWidth, personHeight, bgColor } = layout;

  // 1. 填充绿幕底色
  ctx.fillStyle = `rgb(${bgColor[0]}, ${bgColor[1]}, ${bgColor[2]})`;
  ctx.fillRect(0, 0, canvasWidth, canvasHeight);

  // 2. 将 keyedImageData 放到临时 canvas 上
  // 适配两种输入：纯对象 {data,width,height} 或 ImageData 实例
  const srcW = keyedImageData.width;
  const srcH = keyedImageData.height;
  tempCanvas.width = srcW;
  tempCanvas.height = srcH;
  const tempCtx = tempCanvas.getContext('2d');

  // 统一转换为 ImageData 后 putImageData
  const imgData = tempCtx.createImageData(srcW, srcH);
  imgData.data.set(keyedImageData.data);
  tempCtx.putImageData(imgData, 0, 0);

  // 3. 等比缩放：取宽高比中较小的缩放比，确保人物放进 personWidth×personHeight 框内
  const scaleX = personWidth / srcW;
  const scaleY = personHeight / srcH;
  const scale = Math.min(scaleX, scaleY);

  const scaledW = Math.round(srcW * scale);
  const scaledH = Math.round(srcH * scale);

  // 4. 居中放置
  const offsetX = Math.round((canvasWidth - scaledW) / 2);
  const offsetY = Math.round((canvasHeight - scaledH) / 2);

  ctx.drawImage(tempCanvas, offsetX, offsetY, scaledW, scaledH);

  return { scaledW, scaledH, offsetX, offsetY };
}
