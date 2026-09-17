'use strict';

const path = require('node:path');
const fsp = require('node:fs/promises');

// Chromium 能直接渲染的格式
const NATIVE = new Set([
  '.jpg', '.jpeg', '.jfif', '.png', '.apng', '.webp', '.gif', '.bmp', '.ico', '.svg', '.avif',
]);

// Chromium 不能直接渲染，但文件里通常内嵌了预览图（JPEG/BMP），可提取后显示
const PREVIEW = new Set([
  '.cdr', '.cmx', '.psd', '.psb',
  '.tif', '.tiff',
  '.heic', '.heif',
  '.cr2', '.cr3', '.crw', '.nef', '.nrw', '.arw', '.srf', '.sr2', '.dng',
  '.orf', '.rw2', '.raf', '.pef', '.srw', '.mrw', '.x3f', '.raw',
]);

// CAD 矢量（LibreDWG WASM 解析 → SVG）
const CAD = new Set([
  '.dwg', '.dxf',
]);

// 已知但本版不做（列出来是为了给用户明确提示，而不是静默忽略）
const KNOWN_UNSUPPORTED = new Set([
  '.pdf', '.ai', '.eps', '.exr', '.hdr', '.tga', '.jxl', '.dds', '.ktx',
]);

const ALL = new Set([...NATIVE, ...PREVIEW, ...CAD]);
const REGEX = new RegExp(
  '\\.(' + [...ALL].map((e) => e.slice(1)).join('|') + ')$', 'i'
);

const MIME = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.jfif': 'image/jpeg',
  '.png': 'image/png', '.apng': 'image/apng',
  '.webp': 'image/webp', '.gif': 'image/gif',
  '.bmp': 'image/bmp', '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml', '.avif': 'image/avif',
  '.tif': 'image/tiff', '.tiff': 'image/tiff',
  '.heic': 'image/heic', '.heif': 'image/heif',
  '.dwg': 'image/vnd.dwg', '.dxf': 'image/x-dxf',
};

function isSupported(file) {
  return REGEX.test(file);
}

function kind(ext) {
  if (NATIVE.has(ext)) return 'native';
  if (PREVIEW.has(ext)) return 'preview';
  if (CAD.has(ext)) return 'cad';
  return 'unsupported';
}

function mimeOf(p) {
  return MIME[path.extname(p).toLowerCase()] || 'application/octet-stream';
}

// 自然排序：IMG_2 排在 IMG_10 前面
function naturalCompare(a, b) {
  return a.localeCompare(b, 'zh-CN', { numeric: true, sensitivity: 'base' });
}

async function fileInfo(full, name) {
  const st = await fsp.stat(full);
  const ext = path.extname(name).toLowerCase();
  return {
    path: full,
    name,
    ext,
    dir: path.dirname(full),
    size: st.size,
    mtime: st.mtimeMs,
    kind: kind(ext),
  };
}

async function scanFolder(dir) {
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  const names = entries
    .filter((e) => e.isFile() && isSupported(e.name))
    .map((e) => e.name)
    .sort(naturalCompare);

  const out = [];
  for (const name of names) {
    try {
      out.push(await fileInfo(path.join(dir, name), name));
    } catch {
      // 单个文件读取失败不影响整体
    }
  }
  return out;
}

module.exports = {
  NATIVE, PREVIEW, CAD, KNOWN_UNSUPPORTED, ALL,
  isSupported, kind, mimeOf, scanFolder, fileInfo, naturalCompare,
};
