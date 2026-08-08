# Repository Guidelines

## Project Overview

Greenscreen Studio — 绿幕人物素材标准化工具：抠像（chroma keying）+ 画布/布局归一化 + 视频处理 + 精灵图（sprite sheet）+ Godot `SpriteFrames` 导出。桌面应用（Electron）+ 本地 MCP 工具链（供 AI/Codex 自动化素材流程）。MIT，作者柚子，仓库 `silent-reader-cn/greenscreen-studio`。

## Project Structure & Module Organization

Single-repo web app (no `client/`/`server/` split):

- `src/` — Vite + React 18 前端。UI 组件在 `src/components/`（PascalCase `*.jsx`），业务逻辑在 `src/lib/`（`keying.js` 抠像算法、`actionReviewClips.js` / `actionReviewMarkers.js` 切片与语义标记、`appProfiles.js` 处理参数 profile、`godotNaming.js` / `directionPack.js` / `directionImport.js` 方向命名与导出、`theme.js` 明暗主题）。i18n 在 `src/i18n.js`（en+zh 双字典），样式在 `src/styles/`。
- `server.cjs` — Express 后端（单文件）：`/api/export`（图片抠像导出）、`/api/export-godot-pose`、`/api/video/*`（上传/处理/进度/预览/下载/循环检测 NDJSON 流/精灵图导出/审查检查/Godot SpriteFrames 导出）、`/api/health`。静态托管 `dist/`。
- `mcp/server.mjs` — MCP 入口（stdio），注册 17 个工具 + 4 个资源 + 1 个 prompt（`registerLoggedTool` 计数；客户端框架工具 4 个自动附加，共 21）。
- `lib/` — 后端辅助模块（CommonJS `.cjs`）：`paths.cjs`（数据根目录，尊重 `GSS_DATA_DIR` env，默认 `<repo>/data`）、`projectStore.cjs`（SQLite 项目存储，含 action_clips 白名单）、`studioApi.cjs`、`videoLoopAnalysis.cjs`、`videoFrameGeometry.cjs`、`mcpRuntime.cjs`。
- `electron/` — Electron 桌面壳（`main.cjs` / `preload.cjs`，CommonJS），`assets/` 图标。
- `__tests__/` — Vitest 测试（`*.test.js`）。
- `docs/` — 设计文档（`chroma-key-algorithms-research.md` 抠像算法研究、`action-asset-review-workbench-todo.md`）。
- `skills/greenscreen-studio-mcp/` — 仓库内置 MCP 操作 skill。
- `data/` — 运行时数据（SQLite `greenscreen.db` + 项目素材文件），**gitignored，不可恢复，需手动备份**。

## Ports & Runtime Modes

| Port | 角色 | 说明 |
|---|---|---|
| 5174 | Vite dev (HMR) | `npm run dev:client`；改前端代码即时生效 |
| 3001 | server.cjs dev | `npm run dev:server`；可自行 `Stop-Process` 后重启 |
| 20003 | server.cjs 生产 | `PORT` 默认 20003，`express.static` 服务 `dist/`；**NSSM 服务 `GreenscreenStudio`（SYSTEM 权限，`nssm restart`/`Stop-Process` 均 Access Denied → 需用户管理员 `net stop GreenscreenStudio && net start GreenscreenStudio`）** |

关键边界：
- 只改 `src/` 前端：必须 `npx vite build`（用 background+notify_on_complete 跑，或 `node node_modules/vite/bin/vite.js build`），20003 才会更新；dev 环境走 HMR 无需 build。
- 改 `server.cjs` / `lib/*.cjs` / `videoProcessor.cjs`：必须重启对应实例（3001 自重启，20003 需管理员）。
- `find-loop-end` 是 NDJSON 流式响应（`progress` → `result`/`error`）；后端有模块级 hash 缓存（重启即清）。

## Build, Test, and Development Commands

```bash
npm ci                          # install from root (single package)
npm run dev                     # concurrently: vite (5174) + server (3001) + electron
npm run dev:client              # vite only
npm run dev:server              # node server.cjs only (port 3001)
npm run build                   # vite build → dist/
npm test                        # vitest run (全量，~31 文件 209 测试)
npm run test:watch              # watch mode
npm run test:godot-smoke        # godot smoke only
npm run package                 # vite build + electron-builder (nsis + portable → release/)
npm run mcp                     # node mcp/server.mjs (stdio)
npm start                       # node server.cjs (production, port 20003)
```

## Coding Style & Naming Conventions

- 两空格缩进、分号、单引号。前端 `src/` 用 ES modules；`server.cjs`、`lib/*.cjs`、`electron/*.cjs`、`godot*.cjs`、`reviewChecks.cjs` 用 CommonJS；`mcp/server.mjs` 用 ES modules。
- React 组件 PascalCase（`VideoPreview.jsx`），函数/变量 camelCase，路由模块小写文件名。
- i18n：新 UI 文案必须同时加 `src/i18n.js` 的 en+zh 两个字典（同一 key）；**改完字典跑 key 重复校验**（`node -e` 抓字典块查重复，patch 模糊匹配可能误配相近中文串）。
- 主题：颜色一律用 `theme.css` 的 CSS 变量（`--workspace-*`），禁止硬编码亮色；暗黑模式覆盖统一追加在 `theme.css` 末尾 `:root[data-theme='dark']` 块（theme.css 最后加载，追加即赢）。
- 行尾：仓库文件行尾混用（部分 JSX 是 CRLF）。改文件后 `git diff` 检查行尾噪声；LF 污染用 `sed -i 's/\r$//' <file>` 修复；CRLF 密集单行 JSX 上 patch 失败时改用 Python bytes 精确替换并断言 `raw.count(old) == 1`。

## Data & Storage Layers

- **配置** = `C:\Users\Admin\AppData\Local\hermes\config.yaml` 的 `mcp_servers.greenscreen-studio`（启动命令 + `GSS_DATA_DIR` env）+ `mcp/server.mjs` 内硬编码 `DEFAULT_KEYING` / `DEFAULT_LAYOUT` / `PRESETS`（**无独立配置文件，改默认值=改代码**）。
- **user profile（前端偏好）** = 浏览器 localStorage，key `greenscreen-studio-profiles`（纯前端，换浏览器即丢）。
- **项目数据** = `data/greenscreen.db`（SQLite 5 表：projects/assets/jobs/action_clips/action_markers）+ `data/projects/<id>/{sources,exports,artifacts}/`。**`data/` 在 `.gitignore`，不进版本控制**。
- 语义标记（用户标注的 clip 帧位）存在 SQLite `action_markers`（`windup_end`/`hold`/`active_start`/`active_end`/`recovery_start`/`instant`/`note` 七种，定义唯一来源 `src/lib/actionReviewMarkers.js`）；marker 的 frame 是视频绝对帧，转 Godot 动画索引 = `marker.frame − clip.start_frame`。

## Testing Guidelines

- 测试在 `__tests__/`（`*.test.js`），Vitest + Testing Library + jsdom。
- 组件交互先写单测再 E2E；`src/components/__tests__/SemanticMarkerEditor.test.jsx` 有 fetch mock 基建，`ActionClipReviewPanel.test.jsx` 有 `createApiMock`/`renderPanel` 基建，新行为直接复用。
- localStorage 相关单测文件头加 `// @vitest-environment jsdom`。
- CSS 修复验证：playwright `browser_evaluate` 里用 `getComputedStyle` + `getBoundingClientRect` 数值断言优先，截图仅兜底。
- 改动 marker 类型需同步 6 处：`actionReviewMarkers.js` 定义 + `lib/projectStore.cjs` 服务端白名单 + i18n en/zh + CSS `type-*` 颜色 + SemanticMarkerEditor 默认 typeDraft + 测试。

## Commit & Pull Request Guidelines

- Conventional Commits：`feat:` / `fix:` / `style:` / `chore:`，祈使句，单改动。例：`feat: include markers in get_project clip bundles`。
- 用户流程：任务前先 commit 当前状态；提交前 `git status` 检查；只 `git add` 具体文件；视觉改动经 E2E 数值断言全绿后自动 commit。
- PR 说明用户可见行为、验证命令、UI 改动附截图；打包/数据格式/API 契约变更显式说明。
- 发布：`npm run package` 前跑全量测试；electron-builder 有火绒 HIPS 锁 `.pak` 的 EPERM 坑（需补丁 app-builder-lib）。

## Known Pitfalls

- `search_files` 用 `/d/...` 绝对路径会 IO 失败 → 用 terminal `cd` 到项目根后 `rg -n <pattern> <dir>`。
- `npx vite build` 前台会被 terminal 误判为长驻进程 → background=true + notify_on_complete。
- `read_file` 会把含中文的 CRLF 文件误判 binary → 用 `sed -n 'a,bp' <file>` 读。
- CDP 拦截残留（Fetch.enable / page.route / Network.emulateNetworkConditions）刷新不消失，会锁死页面 → `Fetch.disable` + `page.unrouteAll()` + 重置网络条件，仍异常就 `browser_close` 重开。
- `browser_run_code_unsafe` 是 Node 沙箱（无 `document`/`setTimeout`/`require`）；页面内 JS 一律用 `browser_evaluate`。
- 前端受控 input 设值要过 React 原生 setter + 派发 `input`/`change` 事件，直接 `input.value = x` 不触发 onChange。
- 后端进度累加器（find-loop-end）绝不能用 `done += done`（绝对进度当增量 → percent 爆表到 10000+）；按段偏移拼接，前端显示层再 `clamp(percent, 0, 100)` 防御。
