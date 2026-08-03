# 绿幕抠像算法研究报告（Chroma Keying Algorithms Research）

面向 greenscreen-studio 的算法选型与实现级数学细节。目标场景：
1. 背景**不纯**（灯光不均 → 绿色呈渐变）；
2. 前景含**半透明涟漪/波纹**（需要连续 alpha，而非二值掩码）；
3. 纯 JavaScript 逐像素实现（浏览器 Canvas / node-canvas，无外部依赖）；
4. ~500×500 帧可实时预览（每帧 25 万像素，JS 纯 CPU 单线程需 < ~30ms，可配合降采样预览 + Web Worker）。

所有公式均按 0..1 归一化通道值书写；8-bit 实现时乘以 255。

---

## 1. Vlahos 色差抠像（Difference Matte / Color Difference Keying）

**来源**：Petro Vlahos 的 Ultimatte 专利族，Alvy Ray Smith《Blue Screen Matting》(SIGGRAPH 1996) 做了系统梳理。

### 核心公式（绿幕版）

Vlahos 第一形式（蓝幕原版为 `α = 1 − a1·(B − a2·G)`），绿幕对偶写法：

```
excess = G − kb · max(R, B)          // kb ≈ 0.5..1.5，常用 1.0
α_raw  = 1 − clamp01(excess / K)     // K 为归一化尺度
α      = clamp01((α_raw − inner) / (outer − inner))   // 黑/白点裁剪，类似 Keylight 的 clip black/white
```

Smith 论文中的原始形式（蓝幕，Bf = 前景蓝通道观测值）：

```
α = 1 − a1·(Bf − a2·Gf)   （裁剪到 [0,1]）
```

其中 a1 控制抠除强度、0.5 ≤ a2 ≤ 1.5。

**关键性质**：`α` 由"绿色超出量"（green excess）线性导出，不是硬阈值 → **天然产生部分 alpha**。半透明波纹混合了绿色背景，其 G 通道会部分抬升，excess 介于 0 与满值之间 → 得到 0<α<1。

### 部分 alpha 推导
G 过量值 `g' = G − kb·max(R,B)` 本身就是混合比例的一阶近似：对纯背景 g' = Gk − kb·max(Rk,Bk)（满值），对纯前景 g' ≈ 0 或负，对 aF+(1−a)B 混合近似线性插值。

### 渐变背景处理
Vlahos 本身不处理渐变。工程做法：**对 g' 做黑/白点裁剪时，阈值不能全局固定**——需配合第 3 节的"每像素背景模型"（用局部采样的背景色 Bk(x,y) 的 g' 值做归一化分母），或先用一个宽 inner/outer 范围 + 后期腐蚀/扩张。

### UI 参数
- `keyBalance` kb：0.3–1.5（控制 "G 比 R/B 多多少算绿"）
- `clipBlack` / `clipWhite`：α 曲线的黑白裁剪点（0–1）
- `despillAmount`：见第 4/5 节

### 计算成本
每像素 ~10 次加减乘 + 2 次 max + clamp。500×500 = 250k 像素，JS 纯循环 **< 5ms**。完全适合实时。

### 参考
- Alvy Ray Smith, *Blue Screen Matting*, SIGGRAPH 96: https://alvyray.com/Papers/CG/blusig96.pdf
- Stanford CS148 lecture (含 Vlahos 假设 G=k2·B 的推导): https://graphics.stanford.edu/courses/cs148-08/lectures/imaging/imaging.pdf

---

## 2. OBS / FFmpeg 风格 YUV-CbCr 距离抠像

### FFmpeg `chromakey` 滤镜（vf_chromakey.c，已核对源码）

工作于 YUV 平面（亮度无关）。对每个像素取 3×3 邻域的 (U,V)：

```
diff = (1/9) · Σ_i sqrt( (U_i − Uk)² + (V_i − Vk)² ) / (255·√2)   // 归一化到 0..1
if blend > 0:
    α = clamp01((diff − similarity) / blend)      // 线性斜坡 → 部分 alpha
else:
    α = (diff > similarity) ? 1 : 0               // 硬阈值
```

源码位置：`libavfilter/vf_chromakey.c` 中 `do_chromakey_pixel()`（第 48–67 行）。

**特点**：
- 只用色度 (CbCr)，对**亮度渐变天然鲁棒**——绿幕被照得不均匀时，U/V 变化远小于 Y，这是它对渐变背景有效的根本原因；
- 3×3 邻域平均 = 免费的去噪/边缘柔化；
- `blend` 斜坡给出部分 alpha，但斜坡是**在色度距离域线性**，不是混合比例的物理模型——半透明波纹的 α 精度一般，胜在稳定。

### OBS Studio `chroma_key_filter_v2.effect`（已核对源码，逐行）

```
cb = dot(rgb, [-0.100644, -0.338572, 0.439216]) + 0.501961   // BT.601 Cb
cr = dot(rgb, [ 0.439216, -0.398942, -0.040274]) + 0.501961  // BT.601 Cr
chromaDist = distance( (cb,cr), (cbk,crk) )                   // 关键：色度平面欧氏距离
baseMask   = chromaDist − similarity
fullMask   = pow( saturate(baseMask / smoothness), 1.5 )      // alpha（1.5 次幂曲线）
spillVal   = pow( saturate(baseMask / spill),      1.5 )      // 去溢出色权重
desat      = dot(rgb, [0.2126, 0.7152, 0.0722])               // Rec.709 亮度
rgb_out    = lerp( vec3(desat), rgb, spillVal )               // 越接近键色越去饱和
alpha     *= fullMask
```

OBS 原版还带 5 采样盒式滤波（GetBoxFilteredChromaDist，权 2,2,2,2 + 中心 1，除以 9），平滑边缘。Jim Fisher 的 WebGL 简化版（jameshfisher.com）去掉邻域采样，单像素即可，已在浏览器中实时验证。

**部分 alpha 推导**：`fullMask = ((d − s)/t)^1.5` —— 距离域 1.5 次幂斜坡。幂指数让半透明区"压暗"（α 偏低），视觉上波纹会显得更透明；可把指数也做成参数。

**渐变背景**：同 FFmpeg——色度域对亮度不敏感，是主要抗渐变机制。但对**色度也漂移**的严重渐变（如暖光打在绿幕一侧）仍会失效，需要第 3 节手段。

### UI 参数
- `keyColor`（拾色器）
- `similarity`：0–0.4（OBS 默认 ~0.08/400 量纲，归一化后）
- `smoothness`：0–0.3（α 斜坡宽度）
- `spill`：0–0.5（去溢色斜坡宽度，独立于 alpha，比全局 G 压制更聪明）
- 可选 `alphaPower`：1.0–3.0
- 可选 3×3 box filter 开关

### 计算成本
单像素版：2 次 3 维 dot + 1 次 2 维 distance + 2 次 pow —— 250k 像素 JS **5–10ms**。3×3 版 ×9 采样 → 40–80ms，预览可关，导出再开。完全适合实时。

### 参考
- FFmpeg 源码: https://github.com/FFmpeg/FFmpeg/blob/master/libavfilter/vf_chromakey.c
- OBS shader 源码: https://github.com/obsproject/obs-studio/blob/master/plugins/obs-filters/data/chroma_key_filter_v2.effect
- Jim Fisher WebGL 移植（含 GLSL 全文）: https://jameshfisher.com/2020/08/11/production-ready-green-screen-in-the-browser/
- FFmpeg 文档: https://ffmpeg.org/ffmpeg-filters.html#chromakey

---

## 3. 渐变/不均匀背景处理：每像素背景模型

这是针对"绿幕颜色不纯"的**正交增强**，可叠加在算法 1/2/4 之上。三种由简到繁的方案：

### 3a. 双色渐变插值（two-key lerp）——推荐，最省事

用户拾取两个背景色样点（如左上角亮绿 K0、右下角暗绿 K1）及其屏幕位置 p0、p1。对每个像素 x：

```
t      = clamp01( dot(x − p0, p1 − p0) / |p1 − p0|² )   // 沿 p0→p1 轴投影
K(x)   = lerp(K0, K1, t)                                 // 每像素键色（可加第二轴做双线性 4 点）
```

然后以 K(x) 替代全局键色，跑算法 1 或 2。对线性光照渐变效果很好。**成本几乎为零**（每像素 +3 mul + 1 dot）。

### 3b. 背景板差分（difference matte / clean plate）

若可拍一张无人空背景帧 B(x)（本项目是 AI 生成/游戏素材，通常能拿到或合成出"干净背景"），则：

```
D(x)  = |C(x) − B(x)|  的某种范数（建议色度+亮度联合：D = w_c·‖ΔUV‖ + w_y·|ΔY|）
α(x)  = clamp01((D − t0) / (t1 − t0))
F(x)  = (C − (1−α)·B) / max(α, ε)      // 精确颜色解混，见第 4 节
```

这是 After Effects "Difference Matte" 的原理，也是 Jim Fisher 的 "step-away" WebGL 方案。**对渐变完美**（渐变被 B 吸收），同时给出最准的半透明前景颜色。缺点：需要背景板输入；前景与背景同色的区域（深绿波纹）会漏抠 → 需 t0/t1 + 最小差分兜底。

### 3c. Blender Keying Screen 式 RBF 背景重建

Blender 的 Keying Screen 节点：用户在背景上点若干采样标记（marker）(p_i, K_i)，用**高斯径向基函数插值**重建整幅渐变键色图（源码 `compositor_keying_screen.glsl`，已核对）：

```
w_i(x) = exp( −‖x − p_i‖² / smoothness² )
K(x)   = Σ w_i(x)·K_i / Σ w_i(x)
```

N 个标记 → 每像素 O(N) 次 exp。N≤16、500×500 时 JS **~15–40ms**（exp 是大头；可用 `exp` 查找表或先低分辨率算 K 图再双线性放大，降到 <5ms）。适合"用户点几下就建模"的交互，比 3a 鲁棒、比 3b 不需要干净板。

### 推荐组合
- **默认 3a**（双色插值，参数最少：两个拾色 + 自动轴向）；
- 有干净背景时启用 **3b**（导出级质量）；
- 3c 作为高级选项可后置。

---

## 4. 颜色解混 / 前景去污染（Unpremultiply & Decontamination）

合成方程（Porter-Duff over）：

```
C = α·F + (1−α)·B      （逐通道，B 为背景色/键色）
```

已知 C、α、B，求 F：

```
F = (C − (1−α)·B) / max(α, ε)     // ε≈1/255 防除零
```

**问题**：直接用上式会把"绿色反光/溢色"也算进 F（半透明像素里混的不是纯背景色 B 还有镜面反弹绿）。且 α 很小时数值爆炸 → 噪声放大。

### 实用两阶段方案（导出路径用）

1. **限制器 + 解混**（Smith/Vlahos 标准做法）：
   - 先 despill 限制 G 通道（见第 5 节），得到去绿 C'；
   - 再 `F = (C' − (1−α)·K(x)) / max(α, ε)`，K(x) 为第 3 节的每像素键色；
   - `clamp(F, 0, 1)`，并对 α < α_min（如 0.05）的像素不除，直接置透明黑（straight alpha）或做邻域颜色扩散（edge color bleeding / "去边"）。

2. **边缘颜色填充**（color bleeding/inpainting）：α<0.05 区域的 RGB 无意义，从 α≥0.5 的最近邻扩散填充（几次 3×3 迭代即可），避免合成时出现黑/绿边。Photoshop "Remove Matte"、GIMP erode-then-propagate 同款思路。

### 关键实现注意：premultiplied vs straight
Canvas 的 `getImageData` 返回 **unpremultiplied（straight）**，`putImageData` 也按 straight 解释，但内部存储/合成是 premultiplied，α 很小的像素 RGB 会被量化损失。OBS shader 里也有对应处理（采样后先 `rgb /= a`，输出前 `rgb *= a`）。建议：**内部管线全程用 premultiplied 浮点数组计算，最后一步再转回 8-bit**；或至少 α<1/255 的像素 RGB 强制写边缘扩散色而非原始值。

### 成本
解混每像素 ~8 次乘除 + clamp，**< 3ms**；边缘扩散每次迭代 ~2ms，3–5 次足够。

### 参考
- Smith SIGGRAPH 96（Vlahos 假设下解 F 的完整推导）: https://alvyray.com/Papers/CG/blusig96.pdf
- Alpha compositing 基础: https://ciechanow.ski/alpha-compositing
- UCC matting lecture slides（Vlahos 假设、三方程两未知）: http://www.ucccs.info/ucc/ucc4/ucc2014/2014%20Study/CS4405/Slides/L05-print[Digital%20Compositing,%20Alpha%20Channels.Blending,%20Keying,%20Rig%20Removal,%20The%20Matting%20Problem,%20Vlahos%20Assumption,%20Triangulation%20Matting].pdf

---

## 5. 其他开源方案精要

### 5a. Blender Keying 节点（compositor_keying_compute_matte.glsl，已核对源码）

**饱和度比模型**，支持每像素键色（配合 3c 的 keying screen）：

```
// 用键色的通道排序：主通道 = 键色最大通道（绿幕=G），其余两通道按大小排序 mid/min
weighted_avg = lerp(mid, min, key_balance)            // key_balance∈[0,1]，0.5=平均
sat(c)       = (c[main] − weighted_avg) · |1 − weighted_avg|

if sat(input) < 0:            α = 1                    // 主通道不同 → 纯前景
elif sat(input) ≥ sat(key):   α = 0                    // 比背景还"绿" → 纯背景
else:                         α = 1 − sat(input)/sat(key)   // 线性 → 部分 alpha
```

Despill（旧版实现，wiki 已核对）：

```
avg = (r + g + b − g) / 2 = (r+b)/2                    // 非主通道均值
amount = g − avg
if strength·amount > 0: g_out = g − strength·amount    // 即 g = min(g, 加权均值族)
```

**优点**：主通道自适应（蓝幕/红幕同一代码）、每像素键色、饱和度域 α 比距离域更符合感知。**成本**：每像素 ~15 次运算，JS **< 8ms**。非常适合作为第三档算法。

参考：
- 手册: https://docs.blender.org/manual/en/latest/compositing/types/keying/keying.html
- 实现笔记: https://wiki.blender.jp/Dev:Ref/Release_Notes/2.64/Keying/Implementation
- 源码: https://github.com/blender/blender/blob/main/source/blender/compositor/shaders/compositor_keying_compute_matte.glsl

### 5b. Despill 算法族（Ben McEwan 总结，Nuke 表达式形式，已核对原文）

全部一行实现、零成本，作为**可选后处理**叠加：

| 名称 | 公式（绿幕） |
|---|---|
| Average | `g' = min(g, (r+b)/2)` |
| Double Blue Average | `g' = min(g, (2b+r)/3)` |
| Double Red Average | `g' = min(g, (b+2r)/3)` |
| Blue Limit | `g' = min(g, b)` |
| Red Limit | `g' = min(g, r)` |

工程化建议：做 `despillAmount ∈ [0,1]` 插值 `g_final = lerp(g, g', amount)`，并只对 α<1 的边缘像素全量应用、α=1 区域按 strength 弱应用（Blender keying 节点的做法），避免把前景里真实的绿（衣服、道具）一并抹掉。OBS 的 spill 去饱和法（第 2 节）是另一条路线，可二选一。

### 5c. Primatte（参考，不建议实现）
Photodex 专利：RGB 空间内以键色为中心构建 128 面多面体，逐点判断在核/壳/外部区域决定 α 与颜色修正。质量顶级但实现复杂（需交互式"清理背景/前景"采样迭代），不适合本项目的轻量定位。参考：https://learn.foundry.com/nuke/content/comp_environment/keying_with_primatte/how_primatte_works.html

---

## 6. 集成建议：Combo-box 算法集（推荐 3 + 1）

| 档位 | 算法 | 适用 | 预览成本 (500²) |
|---|---|---|---|
| **A. 经典色差 (Vlahos)** | 第 1 节 + 3a 渐变键色 + 5b despill | 默认档；波纹半透明最好；公式简单可解释 | ~5ms |
| **B. 色度距离 (OBS/FFmpeg)** | 第 2 节 OBS 版（单像素）+ 3a | 亮度不均严重的素材；参数最少最稳 | ~8ms |
| **C. 饱和度比 (Blender)** | 第 5a 节 + 3a/3c 键色图 | 导出级质量；主通道自适应 | ~8ms |
| **D. 背景板差分（可选，需干净板）** | 第 3b + 第 4 节精确解混 | 有背景帧时质量天花板 | ~10ms |

**公共参数**（所有档共享 UI）：`keyColor`（或双色/四点拾取）、`gradientMode`（off / two-point / plate）、`clipBlack/clipWhite`、`despillMode`（off / average / blue-limit / OBS-desaturate）、`despillAmount`、`edgeColorBleed`（开关）。

**逐档参数**：
- A：`keyBalance kb`、`alphaPower`
- B：`similarity`、`smoothness`、`spill`、box-filter 开关
- C：`keyBalance`、`screenSmoothness`（3c 的 RBF 宽度，若启用）
- D：`t0/t1`、亮度权重 `w_y`

**管线建议**（每像素，顺序固定）：
1. 构建每像素键色 K(x)（3a 双色插值，<1ms）
2. 按所选算法算 α
3. clip black/white 重塑 α
4. despill（5b 之一，按 amount 混合）
5. （导出路径）第 4 节解混 F + 边缘颜色扩散；预览路径直接输出 straight RGBA

**性能预算**：250k 像素 × (α 计算 ~10 flops + despill ~6 + 解混 ~8) ≈ 6–10ms/帧 JS 单线程，60fps 预览无压力；Web Worker + ImageData 分块可进一步并行。预览时 box-filter 与边缘扩散可关，导出时全开。

---

## 参考链接汇总

1. Alvy Ray Smith, Blue Screen Matting (SIGGRAPH 96): https://alvyray.com/Papers/CG/blusig96.pdf
2. FFmpeg chromakey 源码: https://github.com/FFmpeg/FFmpeg/blob/master/libavfilter/vf_chromakey.c
3. FFmpeg chromakey 文档: https://ffmpeg.org/ffmpeg-filters.html#chromakey
4. OBS chroma_key_filter_v2.effect 源码: https://github.com/obsproject/obs-studio/blob/master/plugins/obs-filters/data/chroma_key_filter_v2.effect
5. Jim Fisher, Production-ready green screen in the browser (OBS→GLSL 移植): https://jameshfisher.com/2020/08/11/production-ready-green-screen-in-the-browser/
6. Blender Keying 节点手册: https://docs.blender.org/manual/en/latest/compositing/types/keying/keying.html
7. Blender Keying 实现笔记 (2.64): https://wiki.blender.jp/Dev:Ref/Release_Notes/2.64/Keying/Implementation
8. Blender keying shaders 源码: https://github.com/blender/blender/tree/main/source/blender/compositor/shaders (compositor_keying_*.glsl)
9. Ben McEwan, Deconstructing Despill Algorithms: https://benmcewan.com/blog/understanding-despill-algorithms
10. Stanford CS148, Image Compositing (Vlahos 推导): https://graphics.stanford.edu/courses/cs148-08/lectures/imaging/imaging.pdf
11. Ciechanowski, Alpha Compositing (premultiplied 陷阱): https://ciechanow.ski/alpha-compositing
12. Foundry, How Primatte Works: https://learn.foundry.com/nuke/content/comp_environment/keying_with_primatte/how_primatte_works.html
13. Adobe AE Color Difference Key / Difference Matte: https://helpx.adobe.com/after-effects/desktop/animate-in-after-effects/work-with-keying-effects/keying-effects.html
