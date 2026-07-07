/**
 * Electron 预加载脚本
 *
 * 当前应用主要逻辑在浏览器端（React + Express API），
 * 此文件保留作为安全扩展点。现在仅暴露一个空对象。
 */

const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  isElectron: true,
  platform: process.platform,
});
