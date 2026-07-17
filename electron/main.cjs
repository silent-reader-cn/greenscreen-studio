/**
 * Electron 主进程
 *
 * 职责：
 *   - 创建 BrowserWindow (固定窗口尺寸)
 *   - 启动内置 Express 后端 (server.cjs)
 *   - 等端口 ready 后加载前端 URL
 *   - 常驻系统托盘，关闭窗口时最小化到托盘
 *   - DEV: vite dev server (5174)
 *   - PROD: express (3001) 提供 dist 静态
 *   - 退出时清理子进程
 */

const { app, BrowserWindow, shell, Tray, Menu, nativeImage, dialog } = require('electron');
const path = require('path');
const { fork } = require('child_process');
const net = require('net');

const APP_NAME = '绿幕素材标准化工具';
const APP_ID = 'com.yuzu.greenscreen-studio';
const SILENT_START_ARG = '--silent-start';
const IS_DEV = process.env.NODE_ENV === 'development' || !app.isPackaged;
const IS_PACKAGED_APP = app.isPackaged;
const IS_SILENT_STARTUP = process.argv.includes(SILENT_START_ARG);

// Windows 上无显卡环境 GPU 进程容易崩（生产用户机器不一定有此问题，但加 disable-gpu 更稳）
if (process.platform === 'win32') {
  app.setAppUserModelId(APP_ID);
  app.disableHardwareAcceleration();
}

let mainWindow = null;
let tray = null;
let serverProcess = null;
let serverPort = 3001;
let backendReady = false;
let isQuitting = false;
let frontendLoaded = false;

function getAssetPath(fileName) {
  return path.join(__dirname, 'assets', fileName);
}

function loadIcon(fileName) {
  const image = nativeImage.createFromPath(getAssetPath(fileName));
  return image.isEmpty() ? null : image;
}

function getFrontendUrl() {
  return IS_DEV
    ? 'http://localhost:5174'
    : `http://localhost:${serverPort}`;
}

function getLoginItemQueryOptions() {
  return {
    path: process.execPath,
  };
}

function buildLoginItemSettings(enabled) {
  const settings = {
    openAtLogin: enabled,
    path: process.execPath,
  };

  if (!enabled) return settings;

  if (process.platform === 'darwin') {
    settings.openAsHidden = true;
  } else {
    settings.args = [SILENT_START_ARG];
  }

  return settings;
}

function loginItemUsesSilentStartup(settings) {
  if (!settings || !settings.openAtLogin) return false;

  if (process.platform === 'darwin') {
    return !!settings.openAsHidden;
  }

  if (process.platform === 'win32') {
    return Array.isArray(settings.launchItems) && settings.launchItems.some((item) => {
      return item.path === process.execPath && Array.isArray(item.args) && item.args.includes(SILENT_START_ARG);
    });
  }

  return Array.isArray(settings.args) && settings.args.includes(SILENT_START_ARG);
}

/**
 * 等待 TCP 端口可连接
 */
function waitForPort(port, host = '127.0.0.1', timeoutMs = 30000) {
  const startTime = Date.now();
  return new Promise((resolve, reject) => {
    const tryConnect = () => {
      const socket = new net.Socket();
      socket.setTimeout(2000);
      socket.once('connect', () => {
        socket.destroy();
        resolve();
      });
      socket.once('error', () => {
        socket.destroy();
        if (Date.now() - startTime > timeoutMs) {
          reject(new Error(`等待端口 ${port} 超时`));
        } else {
          setTimeout(tryConnect, 300);
        }
      });
      socket.connect(port, host);
    };
    tryConnect();
  });
}

/**
 * 启动 Express 后端子进程（仅生产模式）
 * Vite dev 模式下 server 由 dev:server 启动，Electron 不再拉一份
 */
function startBackendServer() {
  if (IS_DEV) return Promise.resolve();

  serverPort = process.env.PORT ? parseInt(process.env.PORT) : 3001;

  const serverPath = path.join(__dirname, '..', 'server.cjs');

  console.log(`  [electron] 启动后端: node ${serverPath} (port ${serverPort})`);

  serverProcess = fork(serverPath, [], {
    env: { ...process.env, PORT: String(serverPort) },
    stdio: 'inherit',
  });

  serverProcess.on('exit', (code, signal) => {
    console.log(`  [electron] 后端进程退出 code=${code} signal=${signal}`);
    serverProcess = null;
  });

  serverProcess.on('error', (err) => {
    console.error('  [electron] 后端进程错误:', err);
  });

  return waitForPort(serverPort);
}

/**
 * 等 vite dev server 就绪（dev 模式）
 */
function waitForVite() {
  return waitForPort(5174);
}

async function showMainWindow() {
  try {
    if (!mainWindow) {
      createWindow({ show: false });
    }

    if (backendReady && !frontendLoaded) {
      await loadFrontend();
    }

    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.moveTop();
    mainWindow.focus();
    refreshTrayMenu();
  } catch (err) {
    console.error('  [electron] 显示主窗口失败:', err);
    dialog.showErrorBox('打开主窗口失败', err.message);
  }
}

function hideMainWindow() {
  if (!mainWindow) return;
  mainWindow.hide();
  refreshTrayMenu();
}

function openFrontendInBrowser() {
  shell.openExternal(getFrontendUrl());
}

function isOpenAtLoginEnabled() {
  try {
    return app.getLoginItemSettings(getLoginItemQueryOptions()).openAtLogin;
  } catch (err) {
    console.error('  [electron] 读取开机启动状态失败:', err);
    return false;
  }
}

function ensureSilentAutostartSetting() {
  if (!IS_PACKAGED_APP) return;

  try {
    const settings = app.getLoginItemSettings(getLoginItemQueryOptions());
    if (settings.openAtLogin && !loginItemUsesSilentStartup(settings)) {
      app.setLoginItemSettings(buildLoginItemSettings(true));
    }
  } catch (err) {
    console.error('  [electron] 修正静默开机启动失败:', err);
  }
}

function setOpenAtLogin(enabled) {
  try {
    app.setLoginItemSettings(buildLoginItemSettings(enabled));
  } catch (err) {
    console.error('  [electron] 设置开机启动失败:', err);
    dialog.showErrorBox('设置开机启动失败', err.message);
  } finally {
    refreshTrayMenu();
  }
}

function quitApplication() {
  isQuitting = true;
  if (tray) {
    tray.destroy();
    tray = null;
  }
  stopBackendServer();
  app.quit();
}

function buildTrayMenu() {
  const windowVisible = !!mainWindow && mainWindow.isVisible();

  return Menu.buildFromTemplate([
    {
      label: windowVisible ? '隐藏主窗口' : '显示主窗口',
      click: windowVisible ? hideMainWindow : showMainWindow,
    },
    {
      label: '在浏览器打开',
      enabled: backendReady,
      click: openFrontendInBrowser,
    },
    {
      label: backendReady ? `服务地址: ${getFrontendUrl()}` : '后端启动中...',
      enabled: false,
    },
    { type: 'separator' },
    {
      label: '静默开机启动',
      type: 'checkbox',
      checked: isOpenAtLoginEnabled(),
      click: (menuItem) => setOpenAtLogin(menuItem.checked),
    },
    { type: 'separator' },
    {
      label: '退出',
      click: quitApplication,
    },
  ]);
}

function refreshTrayMenu() {
  if (tray) {
    tray.setContextMenu(buildTrayMenu());
  }
}

function createTray() {
  if (tray) return tray;

  const icon = loadIcon('tray.png') || loadIcon('icon.png') || nativeImage.createEmpty();
  tray = new Tray(icon);
  tray.setToolTip(`${APP_NAME}\n左键显示/隐藏，右键打开菜单`);
  tray.on('click', () => {
    if (mainWindow?.isVisible()) {
      hideMainWindow();
    } else {
      void showMainWindow();
    }
  });
  tray.on('double-click', () => { void showMainWindow(); });
  refreshTrayMenu();
  return tray;
}

function stopBackendServer() {
  if (serverProcess) {
    try { serverProcess.kill(); } catch (e) {}
    serverProcess = null;
  }
}

/**
 * 创建主窗口
 */
function createWindow({ show = false } = {}) {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    title: APP_NAME,
    icon: getAssetPath(process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
    show,
    backgroundColor: '#f5f5f0', // 极简灰白风，避免白闪
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });

  // 外部链接用系统浏览器打开
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('close', (event) => {
    if (isQuitting) return;
    event.preventDefault();
    hideMainWindow();
  });

  mainWindow.on('show', refreshTrayMenu);
  mainWindow.on('hide', refreshTrayMenu);

  mainWindow.on('closed', () => {
    mainWindow = null;
    refreshTrayMenu();
  });

  return mainWindow;
}

/**
 * 加载前端 URL
 */
function loadFrontend() {
  const url = getFrontendUrl();

  console.log(`  [electron] 加载前端: ${url}`);
  if (!mainWindow) return Promise.resolve();

  return mainWindow.loadURL(url).then(() => {
    frontendLoaded = true;
    refreshTrayMenu();
  });
}

/**
 * App 就绪
 */
const gotSingleInstanceLock = app.requestSingleInstanceLock();

if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => { void showMainWindow(); });

  app.whenReady().then(async () => {
    createTray();
    if (IS_PACKAGED_APP) {
      ensureSilentAutostartSetting();
    }

    if (!IS_SILENT_STARTUP) {
      createWindow({ show: false });
    }

    try {
      if (IS_DEV) {
        await waitForVite();
      } else {
        await startBackendServer();
      }
      backendReady = true;
      refreshTrayMenu();

      if (mainWindow && !frontendLoaded) {
        await loadFrontend();
        if (!IS_SILENT_STARTUP) {
          showMainWindow();
        }
      }
    } catch (err) {
      console.error('  [electron] 启动失败:', err);
      if (mainWindow) {
        mainWindow.webContents.executeJavaScript(
          `document.body.innerHTML = '<div style="padding:32px;font-family:sans-serif;color:#d33"><h2>启动失败</h2><pre style="white-space:pre-wrap">${err.message}</pre></div>';`
        );
      } else {
        dialog.showErrorBox('启动失败', err.message);
      }
    }

  app.on('activate', () => {
    void showMainWindow();
  });
  });

  /**
   * 关闭窗口时默认留在托盘，只有菜单“退出”或系统退出才真正结束进程。
   */
  app.on('window-all-closed', () => {
    if (isQuitting) app.quit();
  });

  app.on('before-quit', () => {
    isQuitting = true;
    stopBackendServer();
    if (tray) {
      tray.destroy();
      tray = null;
    }
  });
}
