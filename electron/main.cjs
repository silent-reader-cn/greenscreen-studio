/**
 * Electron 主进程
 *
 * 职责：
 *   - 创建 BrowserWindow (固定窗口尺寸)
 *   - 启动内置 Express 后端 (server.cjs)
 *   - 等端口 ready 后加载前端 URL
 *   - DEV: vite dev server (5174)
 *   - PROD: express (3001) 提供 dist 静态
 *   - 退出时清理子进程
 */

const { app, BrowserWindow, shell } = require('electron');
const path = require('path');
const { fork } = require('child_process');
const net = require('net');

const IS_DEV = process.env.NODE_ENV === 'development' || !app.isPackaged;

// Windows 上无显卡环境 GPU 进程容易崩（生产用户机器不一定有此问题，但加 disable-gpu 更稳）
if (process.platform === 'win32') {
  app.disableHardwareAcceleration();
}

let mainWindow = null;
let serverProcess = null;
let serverPort = 3001;

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

/**
 * 创建主窗口
 */
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    title: '绿幕素材标准化工具',
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

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  return mainWindow;
}

/**
 * 加载前端 URL
 */
function loadFrontend() {
  const url = IS_DEV
    ? 'http://localhost:5174'
    : `http://localhost:${serverPort}`;

  console.log(`  [electron] 加载前端: ${url}`);
  mainWindow.loadURL(url);
}

/**
 * App 就绪
 */
app.whenReady().then(async () => {
  createWindow();

  try {
    if (IS_DEV) {
      await waitForVite();
    } else {
      await startBackendServer();
    }
    loadFrontend();
  } catch (err) {
    console.error('  [electron] 启动失败:', err);
    mainWindow.webContents.executeJavaScript(
      `document.body.innerHTML = '<div style="padding:32px;font-family:sans-serif;color:#d33"><h2>启动失败</h2><pre style="white-space:pre-wrap">${err.message}</pre></div>';`
    );
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

/**
 * 退出时清理
 */
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    if (serverProcess) {
      serverProcess.kill();
      serverProcess = null;
    }
    app.quit();
  }
});

app.on('before-quit', () => {
  if (serverProcess) {
    try { serverProcess.kill(); } catch (e) {}
    serverProcess = null;
  }
});
