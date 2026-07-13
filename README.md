<div align="center">

# 绿幕素材标准化工具

**Greenscreen Studio** — 抠像 + 等比缩放 + 居中重排 + 导出

*把任意绿幕素材一键变成标准化尺寸的人物立绘*

![GitHub release (latest by tag)](https://img.shields.io/github/v/release/silent-reader-cn/greenscreen-studio)
![License](https://img.shields.io/badge/license-MIT-blue)
![Electron](https://img.shields.io/badge/Electron-43-47848F?logo=electron)
![React](https://img.shields.io/badge/React-18-61DAFB?logo=react)

[📥 下载桌面版](https://github.com/silent-reader-cn/greenscreen-studio/releases/latest) ·
[🔧 开发指南](#开发) ·
[📖 使用说明](#使用说明)

</div>

---

## 概述

这是一款面向**批量绿幕素材标准化**的桌面工具。游戏开发、视频制作中经常需要把一堆不同尺寸、不同姿势的绿幕人物素材统一成相同的画布尺寸和人物比例——本工具就是为此而生。

**一句话**：把一张带绿幕的图（或视频）丢进去，调好抠像参数，点导出，出来就是一张统一尺寸、人物居中等比缩放的成品图。

## 截图

> **TODO**: 加几张截图（主界面 / 抠像面板 / 视频处理）

## 功能特性

### 🎨 图片处理
- **绿幕抠像** — 基于色度键（Chroma Key），支持容差 / 溢出抑制 / 边缘羽化精细调节
- **等比缩放 + 居中排布** — 输出画布尺寸和人物尺寸独立设置，自动等比缩放并剧中
- **自动裁剪** — 自动裁掉四周多余透明区域，只保留人物有效区域（可关闭）
- **双输出模式** — 绿幕背景合成 / 透明背景 PNG 导出
- **参数持久化** — 抠像和布局参数自动保存到 `localStorage`，下次打开自动恢复

### 📹 视频处理
- **完整视频管线** — 上传视频 → 逐帧抠像 → 编码输出
- **输出格式** — 透明背景 WebM (VP9) / 绿幕合成 MP4 (H.264) / ProRes 4444 MOV
- **实时进度** — 后端每帧处理进度实时回传
- **在线预览** — 上传后选帧预览抠像效果，处理完直接播放结果

### 💻 桌面体验
- **Electron 桌面壳** — 免安装 Node 环境，下载即用
- **自带 ffmpeg** — 视频引擎打包在内，用户无需额外安装
- **NSIS 安装包 / 绿色版** 双输出

### 🤖 MCP 自动化
- **stdio MCP 服务器** — 通过 `mcp/server.mjs` 暴露本项目的图片/视频处理能力
- **完整工具集** — 支持图片检查与导出、视频探测与处理、循环帧检测、精灵图导出、参数校验
- **MCP Resources + Prompts** — 内置参数预设、处理流程说明、参数 schema 和标准化素材 prompt
- **配套 Codex Skill** — `skills/greenscreen-studio-mcp/` 提供 MCP 使用流程、工具目录和客户端配置参考

## 使用说明

### 图片模式

1. **上传图片** — 点击/拖拽任意绿幕图片到上传区
2. **调整抠像参数**
   - `keyColor`: 绿幕的 RGB 颜色（默认亮绿 `#00FF00`）
   - `tolerance`: 容差范围（越大越激进）
   - `spillSuppression`: 溢出抑制（去除人物边缘的绿色反光）
   - `feather`: 边缘羽化（让边缘更柔和）
   - `edgeShrink`: 边缘收缩（剪掉残留绿边）
3. **设置布局**
   - `canvasWidth/Height`: 输出画布尺寸
   - `personWidth/Height`: 人物在画布中的目标尺寸
   - `autoCrop`: 是否自动裁剪透明区域
   - 绿幕合成背景色使用抠像参数中的 `keyColor`
4. **导出** — 点击"导出"，支持绿幕合成图 / 透明 PNG 两模式

### 视频模式

1. 切换到「视频」标签
2. 上传视频文件
3. 调好抠像和布局参数（可在预览区拖选关键帧实时预览）
4. 选择输出格式（WebM / MOV / MP4）
5. 开始处理，等进度跑完直接预览或下载

### 键盘快捷键

在参数输入框中，所有滑块支持 **滚轮微调** 和 **左右方向键** 步进。

## 技术架构

```
┌─────────────────────────────────────────────────┐
│  Electron Shell (electron/main.cjs)             │
│  ┌─────────────────┐  ┌───────────────────────┐ │
│  │  React Frontend  │  │  Express Backend      │ │
│  │  (Vite + React)  │  │  (node-canvas)        │ │
│  │                  │  │                       │ │
│  │  UploadZone      │  │  POST /api/export     │ │
│  │  KeyingPanel     │  │  POST /api/video/*    │ │
│  │  LayoutPanel     │  │  GET  /api/health     │ │
│  │  PreviewCanvas   │  │                       │ │
│  │  VideoPanel      │  │  + ffmpeg 管线        │ │
│  └───────┬─────────┘  │  (videoProcessor.cjs) │ │
│          │             └───────────┬───────────┘ │
│          └─────────┬───────────────┘             │
│                    │                             │
│              HTTP proxy (vite dev)               │
│           or Express static (production)          │
└─────────────────────────────────────────────────┘
```

### 前端
- **React 18** + **Vite 6** — 现代前端框架
- **`src/lib/keying.js`** — 纯 JS 抠像算法（RGB 色度键 + 边缘羽化 + 溢出抑制），直接在前端预演，无需后端往返
- 界面极简灰白风格

### 后端
- **Express** — API 服务
- **node-canvas** — 服务器端 Canvas，处理抠像合成输出
- **`videoProcessor.cjs`** — ffmpeg 子进程管线：extract raw RGBA → JS 抠像 → encode

### 打包
- **Electron 43** — 桌面壳
- **electron-builder** — NSIS 安装包 + 绿色版
- **ffmpeg-static / ffprobe-static** — 自带的 ffmpeg，无需系统预装

## 开发

### 前置条件

- Node.js 18+
- （可选的）系统安装 ffmpeg — dev 环境优先用 `ffmpeg-static`，没有则回退到 PATH

### 本地开发

```bash
# 安装依赖
npm install

# 一键启动（Vite HMR + 后端 + Electron）
npm run dev
```

这会同时跑：
- Vite dev server （port 5174）
- Express 后端 （port 3001）
- Electron 窗口加载 Vite 的 HMR 页面

也可以分开开发：
```bash
npm run build     # 构建前端
npm run start     # 单独启动后端 + 静态服务
```

### 打包构建

```bash
# 一键打包 → release/ 目录
npm run package

# 或者只生成 unpacked 目录（速度快，用于验证）
npm run package:dir
```

打包产物：
| 文件 | 大小 | 说明 |
|------|------|------|
| `release/绿幕素材标准化工具-1.0.0-x64.exe` | ~145 MB | NSIS 安装包 |
| `release/绿幕素材标准化工具-1.0.0-portable.exe` | ~145 MB | 绿色便携版 |
| `release/win-unpacked/` | ~235 MB | 解压目录（调试用） |

> 体积大的原因是内嵌了 ffmpeg + ffprobe 可执行文件（共计 ~145 MB）。
> 后续可用 [ffmpeg-static 瘦身版](https://github.com/eugeneware/ffmpeg-static) 或下载时按需拉取来缩小。

### MCP 服务器

本项目内置本地 stdio MCP 服务器，可让支持 MCP 的 AI 客户端直接调用 Greenscreen Studio 的处理管线。

```bash
npm run mcp
```

通用 MCP 客户端配置示例：

```json
{
  "mcpServers": {
    "greenscreen-studio": {
      "command": "node",
      "args": ["C:/path/to/greenscreen-studio/mcp/server.mjs"],
      "cwd": "C:/path/to/greenscreen-studio"
    }
  }
}
```

主要工具：
- `get_project_info` — 查看 MCP 能力、默认参数和资源
- `inspect_image` / `export_image` — 图片尺寸检查与 PNG 标准化导出
- `probe_video` / `process_video` — 视频探测与 WebM/MOV/MP4 导出
- `find_loop_end` — 查找循环终点帧候选
- `export_spritesheet` — 导出视频帧精灵图 PNG

配套 skill 位于 `skills/greenscreen-studio-mcp/`，其中 `references/` 包含工具参数、典型工作流和客户端配置说明。

## 项目结构

```
greenscreen-studio/
├── electron/
│   ├── main.cjs          # Electron 主进程
│   └── preload.cjs       # 安全预加载桥
├── src/
│   ├── App.jsx           # 主应用
│   ├── components/       # UI 组件
│   │   ├── KeyingPanel.jsx    # 抠像参数面板
│   │   ├── LayoutPanel.jsx    # 布局参数面板
│   │   ├── PreviewCanvas.jsx  # 实时预览画布
│   │   ├── UploadZone.jsx     # 文件上传区
│   │   ├── VideoPanel.jsx     # 视频处理面板
│   │   └── VideoPreview.jsx   # 视频结果播放器
│   ├── lib/
│   │   ├── keying.js          # 抠像算法核心
│   │   └── canvas-polyfill.js # Canvas polyfill
│   ├── main.jsx               # React 入口
│   └── styles.css             # 全局样式
├── server.cjs           # Express 后端
├── videoProcessor.cjs   # ffmpeg 视频处理管线
├── mcp/
│   └── server.mjs       # Greenscreen Studio stdio MCP 服务器
├── skills/
│   └── greenscreen-studio-mcp/ # 配套 Codex skill
├── vite.config.js       # Vite 配置
└── package.json         # 依赖 + 构建脚本
```

## 抠像算法

`src/lib/keying.js` 实现了纯前端/后端通用的色度键抠像：

1. **Color Distance** — 计算每个像素到目标色（默认亮绿）的 RGB 欧氏距离
2. **Alpha 计算** — 在 tolerance 范围内从透明渐变到不透明
3. **Spill Suppression** — 检测并移除绿色溢出（沿色轮方向衰减）
4. **Feather** — 高斯模糊 alpha 通道实现边缘羽化
5. **Auto Crop** — 自动检测人物有效区域并裁掉透明边缘

## 许可

MIT —— 随便用，随便改。
