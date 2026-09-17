'use strict';

/* Rat看图王 — 渲染层
   原则：渲染层只负责显示与交互；所有文件系统、解码、注册表操作都走 window.rat (preload)。*/

const R = window.rat;
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

// 未捕获错误留痕：主进程会把它们写进 userData/logs/rat.log，
// 自检脚本也能通过 window.__ratErrors 读到。（CSP 禁止内联脚本，所以放这里）
window.__ratErrors = [];
const noteError = (kind, msg, where) => {
  window.__ratErrors.push({ kind, msg: String(msg).slice(0, 400), where: String(where || '') });
  console.error('[rat] ' + kind + ': ' + msg + (where ? ' @' + where : ''));
};
window.addEventListener('error', (e) => noteError('error', e.message, (e.filename || '') + ':' + e.lineno));
window.addEventListener('unhandledrejection', (e) => noteError('rejection', e.reason && e.reason.message ? e.reason.message : e.reason));

// ------------------------------------------------------------------ 工具
const basename = (p) => { const i = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/')); return i >= 0 ? p.slice(i + 1) : p; };
const dirname = (p) => { const i = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/')); return i > 0 ? p.slice(0, i) : p; };
const extname = (p) => { const b = basename(p); const i = b.lastIndexOf('.'); return i > 0 ? b.slice(i).toLowerCase() : ''; };
// 路径等价比较：斜杠方向归一化 + 忽略大小写。
// 双击打开（Windows 反斜杠）与拖拽进入（D:/... 正斜杠）会给出不同形态的路径，
// 不归一化会导致 requestVector 的 meta.path 比对失败 → 矢量图永远停在「渲染中」。
const normPath = (p) => String(p).replace(/\//g, '\\').toLowerCase();
const samePath = (a, b) => normPath(a) === normPath(b);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

function fmtSize(n) {
  if (!n && n !== 0) return '—';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(2) + ' MB';
}

function fmtTime(ms) {
  if (!ms) return '—';
  const d = new Date(ms);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

const PREVIEW_EXT = new Set(['.cdr', '.cmx', '.psd', '.psb', '.tif', '.tiff', '.heic', '.heif',
  '.cr2', '.cr3', '.crw', '.nef', '.nrw', '.arw', '.srf', '.sr2', '.dng',
  '.orf', '.rw2', '.raf', '.pef', '.srw', '.mrw', '.x3f', '.raw']);
const CAD_EXT = new Set(['.dwg', '.dxf']);
// 矢量格式：缩略图与主画布必须同源同比例（不裁切），否则「预览」和「打开」两个样
const VECTOR_EXT = new Set(['.cdr', '.cmx', '.dwg', '.dxf']);
const NATIVE_EXT = new Set(['.jpg', '.jpeg', '.jfif', '.png', '.apng', '.webp', '.gif', '.bmp', '.ico', '.svg', '.avif']);
const NOPLUGIN_EXT = new Set(['.pdf', '.ai', '.eps', '.exr', '.hdr', '.tga', '.jxl', '.dds']);

function badgeOf(ext) {
  if (ext === '.cdr' || ext === '.cmx') return 'cdr';
  if (CAD_EXT.has(ext)) return 'cdr';          // CAD 与 CDR 共用紫色矢量徽标
  if (PREVIEW_EXT.has(ext)) return 'pv';
  return '';
}

// ------------------------------------------------------------------ 状态
const state = {
  files: [],
  index: -1,
  tabs: [],
  meta: null,
  folder: null,
  adj: { b: 0, c: 0, s: 0 },
  view: { z: 1, tx: 0, ty: 0, rot: 0, sx: 1, sy: 1 },
  crop: { on: false, ratio: 'free', box: null },
  lens: false,
  playing: false,
  timer: null,
  theme: 'light',
  outDir: null,
  batch: [],
  running: false,
  lastOp: '就绪',
};

const drawCache = new Map();

// ------------------------------------------------------------------ 小提示
let toastTimer = null;
function toast(msg, isErr) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.toggle('err', !!isErr);
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

function setOp(text) {
  state.lastOp = text;
  $('#sbOp').textContent = text;
}

// ------------------------------------------------------------------ 主题
function applyThemeAttr(dark) {
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  $('#btnTheme').innerHTML = `<svg class="ic"><use href="#i-${dark ? 'sun' : 'moon'}"/></svg>`;
  $$('#segTheme button').forEach((b) => {
    b.classList.toggle('on', (b.dataset.mode === 'dark') === dark && state.themeMode !== 'system');
  });
  if (state.themeMode === 'system') {
    $$('#segTheme button').forEach((b) => b.classList.toggle('on', b.dataset.mode === 'system'));
  }
  buildHistogram(state.histSource);
}

async function setTheme(mode) {
  state.themeMode = mode;
  const r = await R.setTheme(mode);
  applyThemeAttr(!!r.dark);
}

// ------------------------------------------------------------------ 屏幕
function go(name) {
  $$('.screen').forEach((s) => s.classList.toggle('on', s.id === 'screen-' + name));
  $$('.rail-btn').forEach((b) => b.classList.toggle('on', b.dataset.go === name));
  $('#app').dataset.screen = name;
  if (name === 'manage') renderGrid();
  if (name === 'compare') initCompare();
  if (name === 'batch') renderBatchRows();
}

// ------------------------------------------------------------------ 打开发
async function openPaths(paths) {
  const list = (paths || []).filter(Boolean);
  if (!list.length) return;
  const first = list[0];

  const asDir = await R.scanFolder(first);
  if (asDir && !asDir.error) {
    state.folder = first;
    state.files = asDir.files || [];
    state.index = state.files.length ? 0 : -1;
  } else {
    const dir = dirname(first);
    const scan = await R.scanFolder(dir);
    state.folder = dir;
    state.files = scan && scan.files ? scan.files : [];
    const i = state.files.findIndex((f) => samePath(f.path, first));
    if (i >= 0) {
      state.index = i;
    } else {
      state.files = [{
        path: first, name: basename(first), ext: extname(first), dir,
        size: 0, mtime: 0, kind: NATIVE_EXT.has(extname(first)) ? 'native' : 'preview',
      }];
      state.index = 0;
    }
    addTab(first);
  }

  renderFilm();
  renderGrid();
  if (state.index >= 0) await select(state.index);
  else {
    toast('这个文件夹里没有支持的图片', true);
    renderEmpty();
  }
}

function addTab(p) {
  state.tabs = [p, ...state.tabs.filter((t) => !samePath(t, p))].slice(0, 12);
  renderTabs();
}

function renderTabs() {
  const box = $('#tabs');
  box.innerHTML = '';
  state.tabs.forEach((p) => {
    const el = document.createElement('div');
    el.className = 'tab' + (state.meta && samePath(state.meta.path, p) ? ' on' : '');
    el.title = p;
    const dot = document.createElement('span');
    dot.className = 'dot';
    const nm = document.createElement('span');
    nm.className = 'nm';
    nm.textContent = basename(p);
    const x = document.createElement('span');
    x.className = 'x';
    x.textContent = '✕';
    x.title = '关闭标签';
    x.addEventListener('click', (e) => {
      e.stopPropagation();
      state.tabs = state.tabs.filter((t) => !samePath(t, p));
      renderTabs();
    });
    el.append(dot, nm, x);
    el.addEventListener('click', () => openPaths([p]));
    box.appendChild(el);
  });
}

// ------------------------------------------------------------------ 选中/加载
async function select(i) {
  if (i < 0 || i >= state.files.length) return;
  const f = state.files[i];
  const info = await R.openImage(f.path);

  if (!info || !info.ok) {
    state.index = i;
    state.meta = null;
    renderEmpty();
    const msg = info && info.message ? info.message : '无法打开这个文件';
    toast(msg, true);
    setOp('打开失败：' + msg);
    renderTabs();
    renderInfo(info);
    return;
  }

  state.index = i;
  state.meta = info;
  // 切换文件时把视图变换与调整重置（避免上一张的姿态串到下一张）
  state.view = { z: 1, tx: 0, ty: 0, rot: 0, sx: 1, sy: 1 };
  state.adj = { b: 0, c: 0, s: 0 };
  syncAdjustUI();
  exitCrop(true);
  stopLens();

  const img = $('#stage');
  const t0 = performance.now();
  img.classList.remove('anim');
  img.style.transform = 'none';
  $('#emptyHint').style.display = 'none';

  // 必须先挂回调再赋 src：图片命中缓存时 onload 可能同步触发
  if (info.kind === 'vector') {
    // CDR/CMX/DWG/DXF 没有可用的位图预览，直接等矢量 SVG（毫秒级）
    // 矢量图透明底，直接落在画布底色上；线条颜色由主进程按主题自适应生成
    img.removeAttribute('src');
    $('#emptyHint').style.display = '';
    setEmptyHint('矢量渲染中…', '正在把矢量内容转成 SVG');
    img.onload = () => {
      const ms = Math.round(performance.now() - t0);
      fit();
      $('#perfPill').innerHTML = `矢量 <b>${ms} ms</b>`;
      buildHistogram(f.path);
    };
    img.onerror = () => {
      setEmptyHint('矢量渲染失败', 'SVG 加载失败，请重试');
    };
    requestVector(f.path);
  } else {
    img.onload = () => {
      const ms = Math.round(performance.now() - t0);
      fit();
      $('#perfPill').innerHTML = `载入 <b>${ms} ms</b> · ${info.kind === 'preview' ? '内嵌预览' : '原生解码'}`;
      buildHistogram(f.path);
    };
    img.onerror = () => {
      renderEmpty();
      toast('这张图渲染失败了', true);
    };
    img.src = R.imageUrl(f.path);
    // 有内嵌预览的 CDR/CMX：保留预览作为最终显示。
    // 预览是 CorelDRAW 官方渲染，保真度最高；libcdr 转矢量有已知的降级
    // （嵌入位图被移出页面、字体/渐变缺失），热替换反而让画面变差 —— 不替换。
  }

  renderInfo(info);
  renderExif(f.path);
  renderFilm();
  renderTabs();
  updateStatus();
  $('#previewPill').style.display = info.kind === 'preview' ? '' : 'none';
  if (info.kind === 'preview') {
    $('#previewPill').textContent = '内嵌预览 · ' + (info.previewSource || '');
  }
}

// ---- CDR/CMX/DWG/DXF 矢量热替换 ---------------------------------------
// 主进程后台转 SVG；就绪后把画布换成真矢量。
// 若用户已切到别的文件（或 SVG 没生成出来），静默放弃，不影响浏览。
let vectorReqId = 0;
async function requestVector(p) {
  const ext = extname(p).toLowerCase();
  if (!['.cdr', '.cmx', '.dwg', '.dxf'].includes(ext)) return;
  const id = ++vectorReqId;
  let r = null;
  try {
    r = await R.cdrRender(p);
  } catch (e) {
    r = { ok: false, reason: String(e && e.message || e).slice(0, 120) };
  }
  if (id !== vectorReqId) return;                     // 已切走
  if (!r || !r.ok) {
    // 「vector」类文件没有预览可退 —— 明确告诉用户失败原因
    if (state.meta && samePath(state.meta.path, p) && state.meta.kind === 'vector') {
      setEmptyHint('矢量渲染失败', r && r.reason ? r.reason : '未知原因');
      toast('这个文件转不出矢量：' + (r && r.reason || '未知原因'), true);
    }
    return;                                           // 「preview」类继续用内嵌预览
  }
  if (!state.meta || !samePath(state.meta.path, p)) return;

  const img = $('#stage');
  const t0 = performance.now();
  img.onload = () => {
    const ms = Math.round(performance.now() - t0);
    fit();
    $('#perfPill').innerHTML = `矢量 <b>${ms} ms</b> · ${Math.round(r.width)}×${Math.round(r.height)}`;
    buildHistogram(p);
  };
  img.src = r.url;
  $('#emptyHint').style.display = 'none';   // 矢量已上屏，把「渲染中」提示彻底收掉
  state.meta.kind = 'vector';
  state.meta.width = Math.round(r.width) || state.meta.width;
  state.meta.height = Math.round(r.height) || state.meta.height;
  $('#previewPill').textContent = '矢量渲染 · ' + (r.format || 'LIBCDR');
  $('#previewPill').style.display = '';
  renderInfo(state.meta);
  setOp('矢量渲染完成' + (r.pages > 1 ? `（共 ${r.pages} 页）` : ''));
}

function prev() {
  if (!state.files.length) return;
  select((state.index - 1 + state.files.length) % state.files.length);
}

function next() {
  if (!state.files.length) return;
  select((state.index + 1) % state.files.length);
}

const EMPTY_HINT_TITLE = '把图片或文件夹拖进来';
const EMPTY_HINT_SUB = '或点左上角「打开」/「文件夹」　支持 JPG · PNG · WebP · GIF · BMP · AVIF · SVG · TIFF · PSD · CDR · DWG · RAW';

function setEmptyHint(title, sub) {
  const t = $('#emptyHint .eh-t');
  const s = $('#emptyHint .eh-s');
  if (t) t.textContent = title || EMPTY_HINT_TITLE;
  if (s) s.textContent = sub || EMPTY_HINT_SUB;
}

function renderEmpty() {
  $('#emptyHint').style.display = '';
  setEmptyHint();
  $('#stage').removeAttribute('src');
  $('#dimPill').textContent = '—';
  $('#sizePill').textContent = '—';
  $('#fmtPill').textContent = '—';
  $('#zoomVal').textContent = '—';
}

// ------------------------------------------------------------------ 视图变换
function updateStage(anim) {
  const img = $('#stage');
  const v = state.view;
  img.classList.toggle('anim', !!anim);
  img.style.filter = `brightness(${(1 + state.adj.b / 100 * 0.6).toFixed(3)}) `
    + `contrast(${(1 + state.adj.c / 100 * 0.9).toFixed(3)}) `
    + `saturate(${(1 + state.adj.s / 100).toFixed(3)})`;
  // -50%,-50% 先把图中心对齐到视口中心(#stage 被 absolute 定位在 50%/50%),
  // 之后 tx/ty 就是「图中心相对视口中心的偏移」—— 与 zoomAt/imageRect 的模型一致
  img.style.transform = `translate(-50%, -50%) translate(${v.tx}px, ${v.ty}px) scale(${v.z}) rotate(${v.rot}deg) scale(${v.sx}, ${v.sy})`;
  $('#zoomVal').textContent = Math.round(v.z * 100) + '%';
  if (state.crop.on) drawCrop();   // 缩放/平移后重算裁剪框位置
}

function vpSize() {
  const r = $('#viewport').getBoundingClientRect();
  return { w: r.width, h: r.height };
}

function fit() {
  const m = state.meta;
  if (!m || !m.width || !m.height) return;
  const { w, h } = vpSize();
  const pad = 24;
  const rot = Math.abs(state.view.rot) % 180 === 90;
  const iw = rot ? m.height : m.width;
  const ih = rot ? m.width : m.height;
  const z = Math.max(0.02, Math.min((w - pad) / iw, (h - pad) / ih));
  state.view.z = z;
  state.view.tx = 0;
  state.view.ty = 0;
  updateStage(true);
}

function oneToOne() {
  state.view.z = 1;
  state.view.tx = 0;
  state.view.ty = 0;
  updateStage(true);
}

function zoomAt(factor, cx, cy) {
  const { w, h } = vpSize();
  const px = (cx === undefined ? w / 2 : cx) - w / 2;
  const py = (cy === undefined ? h / 2 : cy) - h / 2;
  const v = state.view;
  const nz = clamp(v.z * factor, 0.02, 64);
  const k = nz / v.z;
  v.tx = px - (px - v.tx) * k;
  v.ty = py - (py - v.ty) * k;
  v.z = nz;
  updateStage();
}

function rotate(delta) {
  state.view.rot = (state.view.rot + delta) % 360;
  fit();
}

function flip(axis) {
  if (axis === 'h') state.view.sx *= -1;
  else state.view.sy *= -1;
  updateStage();
}

// ------------------------------------------------------------------ 调整 + 直方图
function syncAdjustUI() {
  for (const [id, key] of [['#adjBright', 'b'], ['#adjContrast', 'c'], ['#adjSat', 's']]) {
    $(id).value = state.adj[key];
    $(id + 'V').textContent = state.adj[key];
  }
}

function applyAdjust() {
  state.adj.b = +$('#adjBright').value;
  state.adj.c = +$('#adjContrast').value;
  state.adj.s = +$('#adjSat').value;
  syncAdjustUI();
  updateStage();
}

function resetAdjust() {
  state.adj = { b: 0, c: 0, s: 0 };
  syncAdjustUI();
  updateStage();
  setOp('已重置调整');
}

async function getDrawable(p) {
  if (drawCache.has(p)) return drawCache.get(p);
  const r = await R.imageBytes(p);
  if (!r || !r.ok) return null;
  const blob = new Blob([r.data], { type: r.mime || 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const img = new Image();
  const ok = await new Promise((res) => {
    img.onload = () => res(true);
    img.onerror = () => res(false);
    img.src = url;
  });
  if (!ok) {
    URL.revokeObjectURL(url);
    return null;
  }
  const rec = { url, w: img.naturalWidth, h: img.naturalHeight, img };
  if (drawCache.size > 8) {
    const k = drawCache.keys().next().value;
    const old = drawCache.get(k);
    URL.revokeObjectURL(old.url);
    drawCache.delete(k);
  }
  drawCache.set(p, rec);
  return rec;
}

function smallSample(d) {
  const max = 220;
  const scale = Math.min(1, max / Math.max(d.w, d.h));
  const w = Math.max(1, Math.round(d.w * scale));
  const h = Math.max(1, Math.round(d.h * scale));
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(d.img, 0, 0, w, h);
  return { ctx, w, h };
}

state.histSource = null;

async function buildHistogram(p) {
  state.histSource = p || null;
  const cv = $('#hist');
  const ctx = cv.getContext('2d');
  const W = cv.width;
  const H = cv.height;
  ctx.clearRect(0, 0, W, H);
  if (!p) return;

  const dark = document.documentElement.dataset.theme === 'dark';
  ctx.fillStyle = dark ? '#0a0d12' : '#eef0f4';
  ctx.fillRect(0, 0, W, H);

  const d = await getDrawable(p);
  if (!d) {
    ctx.fillStyle = dark ? '#6c7787' : '#8b93a3';
    ctx.font = '11px sans-serif';
    ctx.fillText('无法读取像素', 10, H / 2 + 4);
    return;
  }
  const { ctx: sctx, w, h } = smallSample(d);
  const data = sctx.getImageData(0, 0, w, h).data;

  const bins = new Array(64).fill(0);
  const rgb = [new Array(64).fill(0), new Array(64).fill(0), new Array(64).fill(0)];
  let sum = 0;
  let sum2 = 0;
  const n = w * h;
  for (let i = 0; i < n; i++) {
    const r = data[i * 4];
    const g = data[i * 4 + 1];
    const b = data[i * 4 + 2];
    const l = 0.299 * r + 0.587 * g + 0.114 * b;
    sum += l;
    sum2 += l * l;
    bins[Math.min(63, (l / 4) | 0)]++;
    rgb[0][Math.min(63, (r / 4) | 0)]++;
    rgb[1][Math.min(63, (g / 4) | 0)]++;
    rgb[2][Math.min(63, (b / 4) | 0)]++;
  }
  const mean = sum / n;
  const std = Math.sqrt(Math.max(0, sum2 / n - mean * mean));
  state.histStats = { mean, std };

  const peak = Math.max(...bins, 1);
  const colors = ['rgba(120,130,150,.55)', 'rgba(220,70,80,.45)', 'rgba(60,190,120,.45)', 'rgba(70,130,240,.45)'];
  const series = [bins, rgb[0], rgb[1], rgb[2]];
  for (let s = 0; s < series.length; s++) {
    ctx.beginPath();
    const src = series[s];
    const p2 = Math.max(...src, 1);
    for (let i = 0; i < 64; i++) {
      const x = (i / 63) * W;
      const y = H - (src[i] / p2) * (H - 6);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.lineTo(W, H);
    ctx.lineTo(0, H);
    ctx.closePath();
    ctx.fillStyle = colors[s];
    ctx.fill();
  }
}

function autoEnhance() {
  const st = state.histStats;
  if (!st) {
    toast('还没打开图片');
    return;
  }
  const b = clamp(Math.round((132 - st.mean) * 0.40), -40, 40);
  const c = clamp(Math.round((66 - st.std) * 0.55), -22, 32);
  state.adj = { b, c, s: 14 };
  syncAdjustUI();
  updateStage();
  setOp(`一键美化：亮度 ${b >= 0 ? '+' : ''}${b}，对比度 ${c >= 0 ? '+' : ''}${c}，饱和度 +14`);
}

// ------------------------------------------------------------------ 信息面板
function kv(rows) {
  return rows.map(([k, v, cls]) => {
    const val = (v === '' || v === null || v === undefined) ? '—' : String(v);
    const title = String(val).replace(/"/g, '&quot;');
    return `<div class="r"><span class="k">${k}</span><span class="v ${cls || ''}" title="${title}">${val}</span></div>`;
  }).join('');
}

function renderInfo(info) {
  const m = state.meta || info;
  if (!m || !m.path) {
    $('#kvInfo').innerHTML = '<div class="empty">未打开图片</div>';
    return;
  }
  const kindText = m.kind === 'preview' ? `内嵌预览（${m.previewSource || '嵌入图'}）` : '原生解码';
  const rows = [
    ['文件名', m.name, 'wrap'],
    ['格式', (m.format || '') + (m.kind === 'preview' ? ' · 预览' : '')],
    ['尺寸', m.width && m.height ? `${m.width} × ${m.height}` : '—'],
    ['体积', fmtSize(m.size)],
    ['修改时间', fmtTime(m.mtime)],
    ['读取方式', kindText, 'wrap'],
    ['所在目录', m.dir, 'wrap mono'],
  ];
  if (m.kind === 'preview' && m.originalSize && m.originalSize !== m.size) {
    rows.splice(4, 0, ['原文件体积', fmtSize(m.originalSize)]);
  }
  $('#kvInfo').innerHTML = kv(rows);
}

async function renderExif(p) {
  const e = await R.readExif(p);
  if (!e) {
    $('#kvExif').innerHTML = '<div class="empty">这个文件没有可读的 EXIF</div>';
    return;
  }
  const cam = [e.make, e.model].filter(Boolean).join(' ');
  const rows = [
    ['相机', cam],
    ['镜头', e.lens, 'wrap'],
    ['快门', e.exposure],
    ['光圈', e.aperture],
    ['ISO', e.iso],
    ['焦距', e.focal],
    ['拍摄时间', e.dateTime],
    ['方向', e.orientationText],
    ['软件', e.software, 'wrap'],
  ];
  $('#kvExif').innerHTML = kv(rows);
}

function updateStatus() {
  const m = state.meta;
  if (!m) {
    $('#sbFile').textContent = '未打开文件';
    return;
  }
  const pos = `${state.index + 1} / ${state.files.length}`;
  $('#sbFile').textContent = `${m.name}　·　${m.width && m.height ? m.width + '×' + m.height : '—'}　·　${fmtSize(m.size)}　·　${pos}`;
  $('#navCount').textContent = pos;
}

// ------------------------------------------------------------------ 胶片条
// 矢量缩略图：首次请求时 SVG 往往还没转好（404 灰块）。主进程收到请求会顺手起
// 后台转换，这里隔几秒重试几次 —— 让「预览」和「打开」显示同一份内容。
function attachVectorThumbRetry(img, f, w) {
  if (!VECTOR_EXT.has(String(f.ext || '').toLowerCase())) return;
  const delays = [1500, 3500, 7000];
  let tries = 0;
  img.addEventListener('error', () => {
    if (tries >= delays.length) return;
    const delay = delays[tries++];
    setTimeout(() => {
      img.src = R.thumbUrl(f.path, w) + '&retry=' + tries;
    }, delay);
  });
}

function renderFilm() {
  const box = $('#filmstrip');
  box.innerHTML = '';
  // 大文件夹只渲染当前附近的窗口，避免一次性创建上千个 DOM
  const total = state.files.length;
  const win = 60;
  let start = 0;
  let end = total;
  if (total > win) {
    start = clamp(state.index - win / 2, 0, total - win);
    end = start + win;
  }
  for (let i = start; i < end; i++) {
    const f = state.files[i];
    const el = document.createElement('div');
    el.className = 'thumb' + (i === state.index ? ' on' : '');
    el.title = f.name;
    const img = document.createElement('img');
    img.loading = 'lazy';
    img.decoding = 'async';
    // 矢量图纸：完整显示(不裁切)，并允许转换完成后重试
    if (VECTOR_EXT.has(String(f.ext || '').toLowerCase())) img.className = 'fit';
    attachVectorThumbRetry(img, f, 220);
    img.src = R.thumbUrl(f.path, 220);
    const nm = document.createElement('span');
    nm.className = 'nm';
    nm.textContent = f.name;
    el.append(img, nm);
    const b = badgeOf(f.ext);
    if (b) {
      const tag = document.createElement('span');
      tag.className = 'tag ' + b;
      tag.textContent = b === 'cdr' ? (CAD_EXT.has(f.ext) ? f.ext.slice(1).toUpperCase() : 'CDR')
        : (NATIVE_EXT.has(f.ext) ? '' : '预览');
      if (tag.textContent) el.appendChild(tag);
    }
    el.addEventListener('click', () => select(i));
    box.appendChild(el);
  }
  const cur = box.querySelector('.thumb.on');
  if (cur) cur.scrollIntoView({ block: 'nearest', inline: 'center' });
}

// ------------------------------------------------------------------ 管理（网格）
function renderGrid() {
  const g = $('#grid');
  const size = +$('#mgSize').value;
  g.style.setProperty('--cell', size + 'px');
  if (!state.files.length) {
    g.innerHTML = '';
    const d = document.createElement('div');
    d.className = 'grid-empty';
    d.textContent = '还没载入文件夹 —— 点上方「打开文件夹」，或直接把文件夹拖进窗口';
    g.appendChild(d);
    $('#mgCount').textContent = '0 项';
    return;
  }
  $('#mgCount').textContent = state.files.length + ' 项';
  const frag = document.createDocumentFragment();
  state.files.forEach((f, i) => {
    const cell = document.createElement('div');
    cell.className = 'cell' + (i === state.index ? ' on' : '');
    const pv = document.createElement('div');
    pv.className = 'pv';
    const img = document.createElement('img');
    img.loading = 'lazy';
    img.decoding = 'async';
    if (VECTOR_EXT.has(String(f.ext || '').toLowerCase())) img.className = 'fit';
    attachVectorThumbRetry(img, f, Math.max(240, size * 2));
    img.src = R.thumbUrl(f.path, Math.max(240, size * 2));
    img.alt = f.name;
    pv.appendChild(img);
    const b = badgeOf(f.ext);
    if (b) {
      const bd = document.createElement('span');
      bd.className = 'badge ' + b;
      bd.textContent = b === 'cdr' ? (CAD_EXT.has(f.ext) ? f.ext.slice(1).toUpperCase() : 'CDR')
        : (NATIVE_EXT.has(f.ext) ? f.ext.slice(1).toUpperCase() : '预览');
      pv.appendChild(bd);
    }
    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.innerHTML = `<div class="ttl"></div><div class="sub"><span></span><span></span></div>`;
    meta.querySelector('.ttl').textContent = f.name;
    meta.querySelector('.sub span:first-child').textContent = fmtSize(f.size);
    meta.querySelector('.sub span:last-child').textContent = fmtTime(f.mtime).slice(0, 10);
    cell.append(pv, meta);
    cell.addEventListener('click', () => { select(i); go('view'); });
    frag.appendChild(cell);
  });
  g.innerHTML = '';
  g.appendChild(frag);
}

// ------------------------------------------------------------------ 对比
function initCompare() {
  const opts = state.files.map((f, i) => `<option value="${i}">${f.name}</option>`).join('');
  const a = $('#cmpA');
  const b = $('#cmpB');
  a.innerHTML = opts;
  b.innerHTML = opts;
  if (state.files.length > 1) {
    a.value = String(state.index >= 0 ? state.index : 0);
    b.value = String((state.index + 1) % state.files.length);
  }
  syncCompare();
}

function syncCompare() {
  const a = state.files[+$('#cmpA').value];
  const b = state.files[+$('#cmpB').value];
  if (a) {
    $('#cmpImgA').src = R.imageUrl(a.path);
    $('#cmpLabelA').textContent = a.name;
  }
  if (b) {
    $('#cmpImgB').src = R.imageUrl(b.path);
    $('#cmpLabelB').textContent = b.name;
  }
}

// ------------------------------------------------------------------ 批量
function addBatch(files) {
  const list = files || state.files;
  state.batch = list.slice();
  renderBatchRows();
}

function renderBatchRows() {
  const box = $('#bRows');
  box.innerHTML = '';
  if (!state.batch.length) {
    const d = document.createElement('div');
    d.className = 'grid-empty';
    d.textContent = '还没载入文件 —— 先打开一个文件夹，或点下方「从当前文件夹载入」';
    box.appendChild(d);
    $('#bSummary').textContent = '—';
    return;
  }
  state.batch.forEach((f, i) => {
    const row = document.createElement('div');
    row.className = 'brow';
    row.dataset.i = String(i);
    row.innerHTML = `<span class="f"></span>
      <span class="pbar"><i></i></span>
      <span class="st"></span>
      <span class="o"></span>`;
    row.querySelector('.f').textContent = f.name;
    row.querySelector('.f').title = f.path;
    row.querySelector('.st').textContent = '等待';
    box.appendChild(row);
  });
  const total = state.batch.length;
  const bytes = state.batch.reduce((s, f) => s + (f.size || 0), 0);
  $('#bSummary').textContent = `共 ${total} 个文件 · ${fmtSize(bytes)}`;
}

function setRow(i, pct, stateText, out, cls) {
  const row = $(`.brow[data-i="${i}"]`);
  if (!row) return;
  const bar = row.querySelector('.pbar > i');
  bar.style.width = pct + '%';
  bar.className = cls || '';
  const st = row.querySelector('.st');
  st.textContent = stateText;
  st.className = 'st ' + (cls || '');
  if (out !== undefined) {
    const o = row.querySelector('.o');
    o.textContent = out;
    o.title = out;
  }
}

async function runBatch() {
  if (state.running) return;
  if (!state.batch.length) {
    toast('批量列表是空的', true);
    return;
  }
  if (!state.outDir) {
    state.outDir = (state.folder || dirname(state.batch[0].path)) + '\\Rat看图王导出';
    $('#bOutDir').textContent = state.outDir;
  }
  const type = $('#bFormat').value;
  const quality = +$('#bQuality').value / 100;
  const maxEdge = +$('#bMaxEdge').value || 0;
  const extMap = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
  const outExt = extMap[type] || 'jpg';

  state.running = true;
  $('#bRun').disabled = true;
  let okCount = 0;
  let errCount = 0;

  for (let i = 0; i < state.batch.length; i++) {
    const f = state.batch[i];
    setRow(i, 8, '读取…', '', 'run');
    try {
      const d = await getDrawable(f.path);
      if (!d) throw new Error('无法读取像素（可能是需要解码插件的格式）');
      setRow(i, 34, '转码…', '');

      let w = d.w;
      let h = d.h;
      if (maxEdge > 0 && Math.max(w, h) > maxEdge) {
        const k = maxEdge / Math.max(w, h);
        w = Math.max(1, Math.round(w * k));
        h = Math.max(1, Math.round(h * k));
      }
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      const ctx = c.getContext('2d');
      if (type === 'image/jpeg') {
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, w, h);
      }
      ctx.drawImage(d.img, 0, 0, w, h);

      const blob = await new Promise((res) => c.toBlob(res, type, quality));
      if (!blob) throw new Error('编码失败');
      const buf = await blob.arrayBuffer();
      setRow(i, 76, '写入…', '');

      const name = basename(f.path).replace(/\.[^.]+$/, '') + '.' + outExt;
      const target = state.outDir + '\\' + name;
      const wr = await R.writeFile(target, buf);
      if (!wr.ok) throw new Error(wr.error || '写入失败');
      okCount++;
      setRow(i, 100, '完成', fmtSize(wr.bytes), 'done');
    } catch (e) {
      errCount++;
      setRow(i, 100, '失败', String(e.message || e), 'err');
    }
    await new Promise((r) => setTimeout(r, 8));
  }

  state.running = false;
  $('#bRun').disabled = false;
  setOp(`批量转换完成：成功 ${okCount}，失败 ${errCount}　→　${state.outDir}`);
  toast(`批处理完成：成功 ${okCount} 个${errCount ? '，失败 ' + errCount + ' 个' : ''}`, errCount > 0);
}

// ------------------------------------------------------------------ 裁剪
// 裁剪框一律用「图像像素坐标」存储，渲染时再换算成视口坐标 ——
// 这样缩放、适应窗口之后框都不会跑偏。
function enterCrop() {
  const m = state.meta;
  if (!m) {
    toast('先打开一张图', true);
    return;
  }
  // 矢量文件在 SVG 就绪前宽高是 0（CDR 无内嵌预览 / DWG / DXF），裁剪框会退化成 0×0
  if (!m.width || !m.height) {
    toast('矢量内容还在渲染中，等画面出来再裁剪', true);
    return;
  }
  if (state.view.rot % 360 !== 0 || state.view.sx !== 1 || state.view.sy !== 1) {
    state.view.rot = 0;
    state.view.sx = 1;
    state.view.sy = 1;
    fit();
    toast('已重置旋转/翻转，便于按原图坐标裁剪');
  }
  state.crop.on = true;
  state.crop.rect = { x: m.width * 0.18, y: m.height * 0.18, w: m.width * 0.64, h: m.height * 0.64 };
  $('#cropBox').classList.add('show');
  $('#ratioRow').classList.remove('off');
  $('#btnCrop').classList.add('on');
  drawCrop();
  setOp('裁剪模式：拖动框体或四角，回车应用，Esc 取消');
}

function exitCrop(silent) {
  if (!state.crop.on) return;
  state.crop.on = false;
  state.crop.rect = null;
  $('#cropBox').classList.remove('show');
  $('#ratioRow').classList.add('off');
  $('#btnCrop').classList.remove('on');
  if (!silent) setOp('已退出裁剪');
}

function imageRect() {
  const { w: vw, h: vh } = vpSize();
  const m = state.meta;
  const dw = m.width * state.view.z;
  const dh = m.height * state.view.z;
  const cx = vw / 2 + state.view.tx;
  const cy = vh / 2 + state.view.ty;
  return { left: cx - dw / 2, top: cy - dh / 2, w: dw, h: dh, vw, vh };
}

function drawCrop() {
  const r = state.crop.rect;
  const m = state.meta;
  if (!r || !m) return;
  const img = imageRect();
  const z = state.view.z;
  const el = $('#cropBox');
  el.style.inset = 'auto';
  el.style.left = (img.left + r.x * z) + 'px';
  el.style.top = (img.top + r.y * z) + 'px';
  el.style.width = (r.w * z) + 'px';
  el.style.height = (r.h * z) + 'px';
  const pct = Math.round((r.w / m.width) * 100);
  $('#cropSize').textContent = `${Math.round(r.w)} × ${Math.round(r.h)} px · 占原图 ${pct}%`;
}

function cropAspect(r) {
  const m = state.meta;
  if (r === 'orig') return m.width / m.height;
  const [a, b] = r.split(':').map(Number);
  return a / b;
}

function setCropRatio(r) {
  state.crop.ratio = r;
  $$('#ratioRow button[data-r]').forEach((b) => b.classList.toggle('on', b.dataset.r === r));
  if (r === 'free' || !state.crop.rect) {
    drawCrop();
    return;
  }
  const m = state.meta;
  const ar = cropAspect(r);
  const cur = state.crop.rect;
  const cx = cur.x + cur.w / 2;
  const cy = cur.y + cur.h / 2;
  let w = cur.w;
  let h = w / ar;
  if (h > m.height) {
    h = m.height;
    w = h * ar;
  }
  if (w > m.width) {
    w = m.width;
    h = w / ar;
  }
  state.crop.rect = {
    x: clamp(cx - w / 2, 0, m.width - w),
    y: clamp(cy - h / 2, 0, m.height - h),
    w,
    h,
  };
  drawCrop();
}

async function applyCrop() {
  const m = state.meta;
  const r = state.crop.rect;
  if (!m || !r) return;
  const sx = clamp(Math.round(r.x), 0, m.width - 1);
  const sy = clamp(Math.round(r.y), 0, m.height - 1);
  const sw = clamp(Math.round(r.w), 1, m.width - sx);
  const sh = clamp(Math.round(r.h), 1, m.height - sy);
  if (sw < 4 || sh < 4) {
    toast('裁剪区域太小了', true);
    return;
  }
  const d = await getDrawable(m.path);
  if (!d) {
    toast('读不到像素，无法裁剪', true);
    return;
  }
  const c = document.createElement('canvas');
  c.width = sw;
  c.height = sh;
  c.getContext('2d').drawImage(d.img, sx, sy, sw, sh, 0, 0, sw, sh);
  const blob = await new Promise((res) => c.toBlob(res, 'image/png'));
  if (!blob) {
    toast('裁剪失败', true);
    return;
  }
  const base = basename(m.path).replace(/\.[^.]+$/, '');
  const target = await R.saveAs(dirname(m.path) + '\\' + base + '_裁剪.png', [
    { name: 'PNG', extensions: ['png'] },
    { name: 'JPEG', extensions: ['jpg', 'jpeg'] },
  ]);
  if (!target) return;
  const wr = await R.writeFile(target, await blob.arrayBuffer());
  if (wr.ok) {
    toast(`已裁剪为 ${sw}×${sh} 并保存`);
    setOp('裁剪已保存：' + target);
    exitCrop(true);
  } else {
    toast('保存失败：' + (wr.error || ''), true);
  }
}

// ------------------------------------------------------------------ 放大镜
function stopLens() {
  state.lens = false;
  $('#viewLens').classList.remove('show');
  $('#btnLens').classList.remove('on');
  $('#stage').classList.remove('lens-off');
}

function toggleLens() {
  if (!state.meta) return;
  state.lens = !state.lens;
  $('#viewLens').classList.toggle('show', state.lens);
  $('#btnLens').classList.toggle('on', state.lens);
  $('#stage').classList.toggle('lens-off', state.lens);
  setOp(state.lens ? '放大镜已开启（移动鼠标查看，L 关闭）' : '放大镜已关闭');
}

function moveLens(cx, cy) {
  if (!state.lens) return;
  const m = state.meta;
  if (!m) return;
  const lens = $('#viewLens');
  const size = 168;
  const zoom = 2.2;
  const img = imageRect();
  // 光标在图片坐标系中的位置
  const ix = (cx - img.left) / state.view.z;
  const iy = (cy - img.top) / state.view.z;
  lens.style.left = (cx - size / 2) + 'px';
  lens.style.top = (cy - size / 2) + 'px';
  lens.style.backgroundImage = `url("${R.imageUrl(m.path)}")`;
  lens.style.backgroundSize = `${m.width * state.view.z * zoom}px ${m.height * state.view.z * zoom}px`;
  lens.style.backgroundPosition = `${-ix * state.view.z * zoom + size / 2}px ${-iy * state.view.z * zoom + size / 2}px`;
}

// ------------------------------------------------------------------ 幻灯片
function togglePlay() {
  if (!state.files.length) return;
  state.playing = !state.playing;
  $('#viewport').classList.toggle('playing', state.playing);
  $('#btnSlides').classList.toggle('on', state.playing);
  clearInterval(state.timer);
  if (state.playing) {
    state.timer = setInterval(next, 2600);
    setOp('幻灯片放映中（空格或 Esc 退出）');
  } else {
    setOp('已退出放映');
  }
}

// ------------------------------------------------------------------ 右键菜单
const MENU = [
  ['适应窗口', 'i-fit', 'F', () => fit()],
  ['实际像素', 'i-one', 'Ctrl+1', () => oneToOne()],
  ['放大', 'i-plus', '+', () => zoomAt(1.2)],
  ['缩小', 'i-minus', '-', () => zoomAt(1 / 1.2)],
  ['sep'],
  ['左转 90°', 'i-ccw', ',', () => rotate(-90)],
  ['右转 90°', 'i-cw', '.', () => rotate(90)],
  ['水平翻转', 'i-fliph', 'H', () => flip('h')],
  ['垂直翻转', 'i-flipv', 'V', () => flip('v')],
  ['sep'],
  ['裁剪', 'i-crop', 'C', () => enterCrop()],
  ['放大镜', 'i-lens', 'L', () => toggleLens()],
  ['一键美化', 'i-wand', '', () => autoEnhance()],
  ['重置调整', 'i-reset', '', () => resetAdjust()],
  ['sep'],
  ['另存为…', 'i-save', 'Ctrl+S', () => saveAsCurrent()],
  ['复制文件路径', 'i-copy', '', () => copyPath()],
  ['在资源管理器中显示', 'i-folder', '', () => revealCurrent()],
  ['sep'],
  ['幻灯片放映', 'i-slides', '空格', () => togglePlay()],
  ['删除到回收站', 'i-trash', 'Del', () => trashCurrent(), 'danger'],
];

function showCtx(x, y) {
  const el = $('#ctxMenu');
  el.innerHTML = '';
  MENU.forEach((it) => {
    if (it[0] === 'sep') {
      const s = document.createElement('div');
      s.className = 'ctx-sep';
      el.appendChild(s);
      return;
    }
    const [label, icon, key, fn, cls] = it;
    const d = document.createElement('div');
    d.className = 'ctx-item' + (cls ? ' ' + cls : '') + (state.meta ? '' : ' disabled');
    d.innerHTML = `<svg class="ic"><use href="#${icon}"/></svg><span>${label}</span>`
      + (key ? `<span class="k">${key}</span>` : '');
    d.addEventListener('click', () => {
      hideCtx();
      if (state.meta || label === '幻灯片放映') fn();
    });
    el.appendChild(d);
  });
  el.classList.add('show');
  const r = el.getBoundingClientRect();
  el.style.left = Math.min(x, window.innerWidth - r.width - 8) + 'px';
  el.style.top = Math.min(y, window.innerHeight - r.height - 8) + 'px';
}

function hideCtx() {
  $('#ctxMenu').classList.remove('show');
}

// ------------------------------------------------------------------ 文件操作
async function saveAsCurrent() {
  const m = state.meta;
  if (!m) return;
  const d = await getDrawable(m.path);
  if (!d) {
    toast('这个格式没有可导出的像素', true);
    return;
  }
  const c = document.createElement('canvas');
  c.width = d.w;
  c.height = d.h;
  const ctx = c.getContext('2d');
  ctx.drawImage(d.img, 0, 0);
  const blob = await new Promise((res) => c.toBlob(res, 'image/png'));
  const base = basename(m.path).replace(/\.[^.]+$/, '');
  const target = await R.saveAs(dirname(m.path) + '\\' + base + '.png', [
    { name: 'PNG', extensions: ['png'] },
    { name: 'JPEG', extensions: ['jpg', 'jpeg'] },
    { name: 'WebP', extensions: ['webp'] },
  ]);
  if (!target) return;
  const wr = await R.writeFile(target, await blob.arrayBuffer());
  toast(wr.ok ? '已另存为 ' + basename(target) : '保存失败', !wr.ok);
  if (wr.ok) setOp('已另存：' + target);
}

async function copyPath() {
  if (!state.meta) return;
  try {
    await navigator.clipboard.writeText(state.meta.path);
    toast('路径已复制');
  } catch {
    toast('复制失败', true);
  }
}

function revealCurrent() {
  if (state.meta) R.reveal(state.meta.path);
}

async function trashCurrent() {
  const m = state.meta;
  if (!m) return;
  const r = await R.trash(m.path);
  if (!r.ok) {
    toast('删除失败：' + (r.error || ''), true);
    return;
  }
  toast('已移到回收站');
  setOp('已删除（移到回收站）：' + m.name);
  const wasIndex = state.index;
  state.files = state.files.filter((f) => !samePath(f.path, m.path));
  state.tabs = state.tabs.filter((t) => !samePath(t, m.path));
  renderFilm();
  renderGrid();
  if (!state.files.length) {
    state.meta = null;
    state.index = -1;
    renderEmpty();
    renderTabs();
    updateStatus();
  } else {
    select(clamp(wasIndex, 0, state.files.length - 1));
  }
}

// ------------------------------------------------------------------ 设置页
const FMT_TABLE = [
  ['JPG / JPEG', 'native', '内置 · Chromium 解码'],
  ['PNG / APNG', 'native', '内置 · 支持透明'],
  ['WebP', 'native', '内置 · 支持动画'],
  ['GIF', 'native', '内置 · 支持动画'],
  ['BMP', 'native', '内置'],
  ['ICO', 'native', '内置'],
  ['SVG', 'native', '内置 · 矢量'],
  ['AVIF', 'native', '内置'],
  ['TIFF / TIF', 'preview', '提取内嵌预览'],
  ['PSD / PSB', 'preview', '读取缩略图资源'],
  ['CDR / CMX', 'preview', '提取内嵌预览 + libcdr 全量矢量渲染'],
  ['DWG / DXF', 'cad', 'LibreDWG 矢量解析（原 Rat CAD Viewer 引擎）'],
  ['HEIC / HEIF', 'preview', '提取内嵌预览'],
  ['CR2 / CR3 / NEF / ARW / DNG 等 RAW', 'preview', '提取内嵌 JPEG 预览'],
  ['PDF / AI / EPS / EXR / TGA / JXL', 'no', '未支持（已在列表里排除）'],
];

const KEYS = [
  ['← / →', '上一张 / 下一张'],
  ['空格', '幻灯片放映开关'],
  ['+ / -', '放大 / 缩小'],
  ['F', '适应窗口'],
  ['Ctrl+1', '实际像素'],
  ['C', '裁剪模式'],
  ['回车', '应用裁剪'],
  ['Esc', '退出裁剪 / 放映'],
  ['L', '放大镜'],
  [', / .', '左转 / 右转 90°'],
  ['H / V', '水平 / 垂直翻转'],
  ['Del', '删除到回收站'],
  ['Ctrl+O', '打开图片'],
  ['Ctrl+S', '另存为'],
  ['Ctrl+D', '切换主题'],
  ['Ctrl+滚轮', '缩放'],
];

function renderSettings() {
  $('#fmtList').innerHTML = FMT_TABLE.map(([name, kind, note]) => {
    const cls = kind === 'native' ? '' : (kind === 'preview' || kind === 'cad') ? 'pv' : 'no';
    return `<span class="fmt ${cls}" title="${note}"><i></i>${name}</span>`;
  }).join('');

  $('#keyList').innerHTML = KEYS.map(([k, d]) =>
    `<div class="keyrow"><span class="kbd">${k}</span><span>${d}</span></div>`).join('');

  $('#aboutInfo').innerHTML = kv([
    ['程序版本', 'V' + (R.appVersion || '1.0.0')],
    ['Electron', R.versions.electron],
    ['Chromium', R.versions.chrome],
    ['Node', R.versions.node],
    ['平台', R.platform],
  ], 'kv-line');
}

async function refreshAssoc() {
  const s = await R.assocStatus();
  $('#assocInfo').innerHTML = kv([
    ['当前状态', s.registered ? '已注册为候选' : '未注册'],
    ['程序文件', s.exeName, 'wrap mono'],
    ['完整路径', s.exe, 'wrap mono'],
    ['关联扩展名', (s.extensions || []).length + ' 个'],
  ]);
  return s;
}

// ------------------------------------------------------------------ 事件绑定
function bind() {
  // 窗口
  $('#btnMin').addEventListener('click', () => R.winMinimize());
  $('#btnMax').addEventListener('click', () => R.winToggleMax());
  $('#btnClose').addEventListener('click', () => R.winClose());
  R.onWinState((s) => {
    $('#btnMax').innerHTML = `<svg class="ic"><use href="#i-${s.maximized ? 'restore' : 'max'}"/></svg>`;
  });

  // 导航
  $$('.rail-btn').forEach((b) => b.addEventListener('click', () => go(b.dataset.go)));

  // 打开
  const doOpen = async () => {
    const paths = await R.openFiles();
    if (paths && paths.length) openPaths(paths);
  };
  $('#btnOpen').addEventListener('click', doOpen);
  $('#btnAddTab').addEventListener('click', doOpen);
  $('#btnFolder').addEventListener('click', async () => {
    const d = await R.openFolder();
    if (d) openPaths([d]);
  });
  $('#btnFolder2').addEventListener('click', async () => {
    const d = await R.openFolder();
    if (d) openPaths([d]);
  });
  $('#btnCmpPick').addEventListener('click', async () => {
    const d = await R.openFolder();
    if (d) {
      await openPaths([d]);
      initCompare();
      toast('已在对比屏载入该文件夹');
    }
  });

  // 翻页
  $('#btnPrev').addEventListener('click', prev);
  $('#btnNext').addEventListener('click', next);
  $('#arrowPrev').addEventListener('click', prev);
  $('#arrowNext').addEventListener('click', next);

  // 缩放
  $('#btnZoomIn').addEventListener('click', () => zoomAt(1.2));
  $('#btnZoomOut').addEventListener('click', () => zoomAt(1 / 1.2));
  $('#btnFit').addEventListener('click', () => fit());
  $('#btnOne').addEventListener('click', () => oneToOne());
  $('#viewport').addEventListener('wheel', (e) => {
    e.preventDefault();
    const r = $('#viewport').getBoundingClientRect();
    zoomAt(e.deltaY < 0 ? 1.12 : 1 / 1.12, e.clientX - r.left, e.clientY - r.top);
  }, { passive: false });

  // 平移
  const vp = $('#viewport');
  let dragging = false;
  let lastX = 0;
  let lastY = 0;
  vp.addEventListener('mousedown', (e) => {
    if (e.button !== 0 || state.crop.on || state.lens) return;
    dragging = true;
    lastX = e.clientX;
    lastY = e.clientY;
    vp.classList.add('grabbing');
  });
  window.addEventListener('mousemove', (e) => {
    const r = vp.getBoundingClientRect();
    moveLens(e.clientX - r.left, e.clientY - r.top);
    if (!dragging) return;
    state.view.tx += e.clientX - lastX;
    state.view.ty += e.clientY - lastY;
    lastX = e.clientX;
    lastY = e.clientY;
    updateStage();
  });
  window.addEventListener('mouseup', () => {
    dragging = false;
    vp.classList.remove('grabbing');
  });
  vp.addEventListener('dblclick', () => {
    if (Math.abs(state.view.z - 1) < 0.02) fit();
    else oneToOne();
  });

  // 变换
  $('#btnRotL').addEventListener('click', () => rotate(-90));
  $('#btnRotR').addEventListener('click', () => rotate(90));
  $('#btnFlipH').addEventListener('click', () => flip('h'));
  $('#btnFlipV').addEventListener('click', () => flip('v'));

  // 裁剪
  $('#btnCrop').addEventListener('click', () => (state.crop.on ? exitCrop() : enterCrop()));
  $('#cropCancel').addEventListener('click', () => exitCrop());
  $('#cropApply').addEventListener('click', applyCrop);
  $$('#ratioRow button[data-r]').forEach((b) =>
    b.addEventListener('click', () => setCropRatio(b.dataset.r)));
  setupCropDrag();

  // 放大镜
  $('#btnLens').addEventListener('click', toggleLens);

  // 调整
  ['#adjBright', '#adjContrast', '#adjSat'].forEach((id) =>
    $(id).addEventListener('input', applyAdjust));
  $('#btnReset').addEventListener('click', resetAdjust);
  $('#btnReset2').addEventListener('click', resetAdjust);
  $('#btnWand').addEventListener('click', autoEnhance);

  // 其它
  $('#btnSlides').addEventListener('click', togglePlay);
  $('#btnSave').addEventListener('click', saveAsCurrent);
  $('#btnTrash').addEventListener('click', trashCurrent);
  $('#btnMore').addEventListener('click', (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    showCtx(r.left, r.bottom + 6);
  });

  // 右键
  vp.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    showCtx(e.clientX, e.clientY);
  });
  window.addEventListener('mousedown', (e) => {
    if (!e.target.closest('#ctxMenu')) hideCtx();
  });

  // 主题
  $('#btnTheme').addEventListener('click', () => {
    const dark = document.documentElement.dataset.theme === 'dark';
    setTheme(dark ? 'light' : 'dark');
  });
  $$('#segTheme button').forEach((b) =>
    b.addEventListener('click', () => setTheme(b.dataset.mode)));

  // 管理屏
  $('#mgSize').addEventListener('input', renderGrid);

  // 对比屏
  $('#cmpA').addEventListener('change', syncCompare);
  $('#cmpB').addEventListener('change', syncCompare);
  const split = $('#cmpSplit');
  const applySplit = () => {
    const v = split.value + '%';
    $('#cmpPaneB').style.setProperty('--split', v);
    $('#cmpHandle').style.setProperty('--split', v);
  };
  split.addEventListener('input', applySplit);
  applySplit();
  let splitDrag = false;
  $('#cmpHandle').addEventListener('mousedown', () => { splitDrag = true; });
  window.addEventListener('mousemove', (e) => {
    if (!splitDrag) return;
    const r = $('#cmpWrap').getBoundingClientRect();
    const pct = clamp(((e.clientX - r.left) / r.width) * 100, 0, 100);
    split.value = String(Math.round(pct));
    applySplit();
  });
  window.addEventListener('mouseup', () => { splitDrag = false; });

  // 批量屏
  $('#bQuality').addEventListener('input', () => {
    $('#bQualityV').textContent = $('#bQuality').value;
  });
  $('#bPickOut').addEventListener('click', async () => {
    const d = await R.openFolder();
    if (d) {
      state.outDir = d;
      $('#bOutDir').textContent = d;
    }
  });
  $('#bRun').addEventListener('click', runBatch);
  $('#bClear').addEventListener('click', () => {
    state.batch = [];
    renderBatchRows();
  });

  // 设置屏
  $('#btnAssoc').addEventListener('click', async () => {
    const r = await R.assocRegister();
    if (r.ok) {
      await refreshAssoc();
      toast(`已注册为候选看图程序（${r.extensions} 个扩展名）`);
      $('#assocHint').textContent = '下一步：点「② 打开系统默认应用页」，把扩展名逐个选成 Rat看图王。';
    } else {
      toast('注册失败：' + (r.error || ''), true);
    }
  });
  $('#btnAssocOpen').addEventListener('click', async () => {
    const r = await R.assocOpenSettings();
    if (r.ok) {
      toast('已打开系统「默认应用」页面');
      $('#assocHint').textContent = '在列表里找到「Rat看图王」，把 .jpg / .png 等扩展名逐个指定给它。';
    } else {
      toast('打不开系统设置，请手动搜索「默认应用」', true);
    }
  });
  $('#btnAssocOff').addEventListener('click', async () => {
    await R.assocUnregister();
    await refreshAssoc();
    toast('已注销文件关联');
  });
  $('#btnRevealExe').addEventListener('click', () => R.revealExe());

  // 拖拽
  const veil = $('#dropVeil');
  let dragDepth = 0;
  window.addEventListener('dragenter', (e) => {
    e.preventDefault();
    dragDepth++;
    if (state.meta || dragDepth === 1) veil.classList.add('show');
  });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('dragleave', (e) => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) veil.classList.remove('show');
  });
  window.addEventListener('drop', async (e) => {
    e.preventDefault();
    dragDepth = 0;
    veil.classList.remove('show');
    const paths = [];
    for (const f of e.dataTransfer.files) {
      const p = R.pathForFile(f);
      if (p) paths.push(p);
    }
    if (paths.length) openPaths(paths);
  });

  // 键盘
  window.addEventListener('keydown', onKey);

  // 主进程推来的打开请求（双击文件 / 第二实例）
  R.onOpenPath((p) => { if (p) openPaths([p]); });
  R.onSystemTheme((s) => {
    if (state.themeMode === 'system') applyThemeAttr(!!s.dark);
  });
}

function onKey(e) {
  if (e.target.matches('input, select, textarea')) return;
  const ctrl = e.ctrlKey || e.metaKey;
  if (ctrl && e.key.toLowerCase() === 'o') { e.preventDefault(); $('#btnOpen').click(); return; }
  if (ctrl && e.key.toLowerCase() === 's') { e.preventDefault(); saveAsCurrent(); return; }
  if (ctrl && e.key.toLowerCase() === 'd') { e.preventDefault(); $('#btnTheme').click(); return; }
  if (ctrl && e.key === '1') { e.preventDefault(); oneToOne(); return; }
  if (ctrl) return;

  switch (e.key) {
    case 'ArrowLeft': e.preventDefault(); prev(); break;
    case 'ArrowRight': e.preventDefault(); next(); break;
    case '+': case '=': e.preventDefault(); zoomAt(1.2); break;
    case '-': e.preventDefault(); zoomAt(1 / 1.2); break;
    case 'f': case 'F': fit(); break;
    case 'c': case 'C': state.crop.on ? exitCrop() : enterCrop(); break;
    case 'l': case 'L': toggleLens(); break;
    case 'h': case 'H': flip('h'); break;
    case 'v': case 'V': flip('v'); break;
    case ',': rotate(-90); break;
    case '.': rotate(90); break;
    case 'Delete': trashCurrent(); break;
    case ' ': e.preventDefault(); togglePlay(); break;
    case 'Enter': if (state.crop.on) applyCrop(); break;
    case 'Escape':
      if (state.crop.on) exitCrop();
      else if (state.lens) stopLens();
      else if (state.playing) togglePlay();
      else hideCtx();
      break;
    default: break;
  }
}

// ------------------------------------------------------------------ 裁剪框拖动
function setupCropDrag() {
  const box = $('#cropBox');
  let mode = null;
  let start = null;

  const onDown = (e, m) => {
    if (!state.crop.on || !state.crop.rect) return;
    e.preventDefault();
    e.stopPropagation();
    mode = m;
    start = { mx: e.clientX, my: e.clientY, rect: { ...state.crop.rect } };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const onMove = (e) => {
    if (!mode || !start) return;
    const m = state.meta;
    const z = state.view.z;
    // 鼠标位移换算到图像像素
    const dx = (e.clientX - start.mx) / z;
    const dy = (e.clientY - start.my) / z;
    const r = { ...start.rect };
    const minS = Math.max(8, 24 / z);

    if (mode === 'move') {
      r.x = clamp(start.rect.x + dx, 0, m.width - r.w);
      r.y = clamp(start.rect.y + dy, 0, m.height - r.h);
    } else {
      if (mode.includes('l')) {
        const nx = clamp(start.rect.x + dx, 0, start.rect.x + start.rect.w - minS);
        r.w = start.rect.w + (start.rect.x - nx);
        r.x = nx;
      }
      if (mode.includes('r')) {
        r.w = clamp(start.rect.w + dx, minS, m.width - start.rect.x);
      }
      if (mode.includes('t')) {
        const ny = clamp(start.rect.y + dy, 0, start.rect.y + start.rect.h - minS);
        r.h = start.rect.h + (start.rect.y - ny);
        r.y = ny;
      }
      if (mode.includes('b')) {
        r.h = clamp(start.rect.h + dy, minS, m.height - start.rect.y);
      }
      const ratio = state.crop.ratio;
      if (ratio !== 'free') {
        const ar = cropAspect(ratio);
        const draggingLeft = mode.includes('l');
        const draggingTop = mode.includes('t');
        // 以宽定高；超高则改以高定宽，并钉住被拖角的对角
        let nh = r.w / ar;
        if (r.y + nh <= m.height) {
          const bottom = r.y + r.h;
          r.h = nh;
          if (draggingTop) r.y = bottom - nh;
        } else {
          const nw = r.h * ar;
          const right = r.x + r.w;
          r.w = nw;
          if (draggingLeft) r.x = right - nw;
        }
      }
    }
    state.crop.rect = r;
    drawCrop();
  };

  const onUp = () => {
    mode = null;
    start = null;
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', onUp);
  };

  box.addEventListener('mousedown', (e) => {
    if (e.target.classList.contains('h')) return;
    onDown(e, 'move');
  });
  const cornerMap = { tl: 'lt', tr: 'rt', bl: 'lb', br: 'rb' };
  $$('#cropBox .h').forEach((h) => {
    const c = Array.from(h.classList).find((x) => cornerMap[x]);
    h.addEventListener('mousedown', (e) => onDown(e, cornerMap[c]));
  });
}

// ------------------------------------------------------------------ 启动
async function main() {
  renderSettings();
  bind();
  refreshAssoc();

  const t = await R.getTheme();
  state.themeMode = t.mode || 'light';
  applyThemeAttr(!!t.dark);
  $$('#segTheme button').forEach((b) => b.classList.toggle('on', b.dataset.mode === state.themeMode));

  // 主进程可能在 did-finish-load 时就推过一次；这里再主动取一次，两边都不会漏
  const pending = await R.pendingPath();
  if (pending) openPaths([pending]);

  updateStage();
  setOp('就绪');
}

window.addEventListener('DOMContentLoaded', main);
