# 绿幕素材标准化工具 — Electron 打包说明

## 项目结构

```
greenscreen-studio/
├── electron/
│   ├── main.cjs        # Electron 主进程（启动后端 + 创建窗口）
│   └── preload.cjs     # 安全桥
├── src/                # React 前端
├── dist/               # vite 构建产物（被 main.cjs 通过 express 静态服务）
├── server.cjs          # Express 后端（图片抠像 + 视频处理）
├── videoProcessor.cjs  # ffmpeg 视频管线
├── vite.config.js      # base: './' 让产物可用 file:// 和 http 加载
└── package.json        # dev / build / package / package:dir 脚本
```

## 命令速查

```bash
# 开发（Vite HMR + 后端 + Electron 一起开）
npm run dev

# 仅打包前端（产物到 dist/）
npm run build

# 打包成 .exe（NSIS 安装包 + portable 绿色版，到 release/）
npm run package

# 仅打包 unpacked 目录（用于快速验证，不出安装包）
npm run package:dir

# 单独启动后端（不开窗口）
npm run start
```

## 打包产物

`npm run package` 会在 `release/` 输出：

- **`绿幕素材标准化工具-1.0.0-x64.exe`** — NSIS 安装包，约 145 MB
  - 默认装到 `%LOCALAPPDATA%\Programs\绿幕素材标准化工具`
  - 可选安装路径，会创建桌面 + 开始菜单快捷方式
  - 自带卸载器
- **`绿幕素材标准化工具-1.0.0-portable.exe`** — 绿色版，约 145 MB
  - 双击即可运行，无安装步骤
  - 适合 U 盘 / 临时派发

也可以进 `release/win-unpacked/` 看解压目录（235 MB），含 `绿幕素材标准化工具.exe`。

## 关键设计

1. **ffmpeg 自带**：`ffmpeg-static` 和 `ffprobe-static` 通过 `extraResources` 拷贝到
   `resources/bin/`，`videoProcessor.cjs` 用 `process.resourcesPath` 解析路径。
   打包后体积大（约 145 MB），好处是用户机器不需要预装 ffmpeg。

2. **node-canvas**：electron-builder 用 `@electron/rebuild` 自动重新编译匹配 Electron 的
   Node ABI（已自动处理，无需手动跑 `electron-rebuild`）。

3. **dev vs prod**：
   - **dev**：`concurrently` 三进程并行 — vite (5174) + node server (3001) + electron。
     Electron 主进程等 5174 + 3001 都 ready 后加载 `http://localhost:5174`。
   - **prod**：Electron 主进程 fork 出 `node server.cjs` 子进程（3001 端口），
     自己 serve `dist/`。窗口加载 `http://localhost:3001`。

4. **安全**：预加载用 `contextIsolation: true`，无 `nodeIntegration`，无 IPC 桥
   （应用是纯前端 + 后端 REST，Electron 只是个壳子）。

## 常见问题

**Q: 启动后白屏？**
A: 确认 `dist/` 不是空的（要先 `npm run build`）。看 dev tools: 打包后的 exe 右键 → 属性 →
兼容性 → 不需要改。直接看主进程日志：在命令行 `绿幕素材标准化工具.exe` 启动会输出 `[electron]` 日志。

**Q: 视频处理报错 "ffmpeg not found"？**
A: 检查 `resources/bin/ffmpeg.exe` 和 `ffprobe.exe` 是否存在。

**Q: 想换 icon？**
A: 放一个 256×256 的 `build/icon.ico`（electron-builder 默认会找这个路径），
重新 `npm run package`。
