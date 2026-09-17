'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

const on = (channel) => (cb) => {
  const handler = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};

contextBridge.exposeInMainWorld('rat', {
  // ---- 窗口 ----
  winMinimize: () => ipcRenderer.invoke('win:minimize'),
  winToggleMax: () => ipcRenderer.invoke('win:toggleMax'),
  winClose: () => ipcRenderer.invoke('win:close'),
  onWinState: on('win:state'),

  // ---- 文件与目录 ----
  openFiles: () => ipcRenderer.invoke('dialog:openFiles'),
  openFolder: () => ipcRenderer.invoke('dialog:openFolder'),
  saveAs: (suggested, filters) => ipcRenderer.invoke('dialog:saveAs', suggested, filters),
  scanFolder: (dir) => ipcRenderer.invoke('fs:scanFolder', dir),
  openImage: (p) => ipcRenderer.invoke('image:open', p),
  imageBytes: (p) => ipcRenderer.invoke('image:bytes', p),
  // ---- CDR/CMX 矢量渲染 ----
  cdrRender: (p) => ipcRenderer.invoke('cdr:render', p),
  onCdrVector: on('cdr:vector'),

  // ---- EXIF ----
  readExif: (p) => ipcRenderer.invoke('exif:read', p),
  writeFile: (p, arrayBuffer) => ipcRenderer.invoke('file:write', p, arrayBuffer),
  trash: (p) => ipcRenderer.invoke('file:trash', p),
  reveal: (p) => ipcRenderer.invoke('shell:reveal', p),
  openExternal: (u) => ipcRenderer.invoke('shell:openExternal', u),
  revealExe: () => ipcRenderer.invoke('shell:revealExe'),

  // ---- 资源 URL（走自定义协议，避免 base64 膨胀）----
  imageUrl: (p) => 'ratfile://img?p=' + encodeURIComponent(p),
  thumbUrl: (p, w) => 'ratfile://thumb?p=' + encodeURIComponent(p) + '&w=' + (w || 220),

  // ---- 主题 ----
  setTheme: (mode) => ipcRenderer.invoke('theme:set', mode),
  getTheme: () => ipcRenderer.invoke('theme:get'),
  onSystemTheme: on('system:theme'),

  // ---- 文件关联 / 默认程序 ----
  assocRegister: () => ipcRenderer.invoke('assoc:register'),
  assocUnregister: () => ipcRenderer.invoke('assoc:unregister'),
  assocStatus: () => ipcRenderer.invoke('assoc:status'),
  assocOpenSettings: () => ipcRenderer.invoke('assoc:openSettings'),

  // ---- 外部请求打开文件（双击文件 / 命令行 / 拖到图标上）----
  onOpenPath: on('app:openPath'),
  pendingPath: () => ipcRenderer.invoke('app:pendingPath'),

  // ---- 拖拽进来时取真实路径（Electron 32+ 唯一安全途径）----
  pathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file) || '';
    } catch {
      return '';
    }
  },

  platform: process.platform,
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  },

  // ---- 程序版本（主进程通过 additionalArguments 注入，语义化版本，不含 V 前缀）----
  appVersion: (() => {
    const hit = process.argv.find((a) => a.startsWith('--rat-app-version='));
    return hit ? hit.slice('--rat-app-version='.length) : '1.0.0';
  })(),
});
