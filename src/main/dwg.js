'use strict';

// DWG/DXF 矢量渲染通道（功能并入自 Rat CAD Viewer）。
//
// 架构：LibreDWG WASM（.dwg）+ 纯 JS 文本解析（.dxf）→ 内部几何桶 → SVG →
// 复用 CDR 的 ratfile://svg 通道交给 Chromium 渲染。缩放/平移/直方图全复用。
// 缓存键 = 路径 + mtime + size（文件没变不重转），与 cdr.js 同一模式。

const path = require('node:path');
const fsp = require('node:fs/promises');
const crypto = require('node:crypto');
const parser = require('./dwg-parser');
const { parseDxf } = require('./dxf-parser');

const VECTOR_EXT = new Set(['.dwg', '.dxf']);
const TIMEOUT_MS = 60_000;               // 大图纸解析上限
const MAX_INPUT_BYTES = 256 * 1024 * 1024;
const MAX_SVG_BYTES = 48 * 1024 * 1024;  // SVG 体积上限，防止极端图纸撑爆内存

let cfg = { wasmDir: '', cacheDir: '' };
const inflight = new Map();              // `${abs}` -> Promise

function init(opts) {
  const next = { ...cfg, ...opts };
  if (next.wasmDir !== cfg.wasmDir) parser.initWasmDir(next.wasmDir);
  cfg = next;
}

function supported(p) {
  const s = String(p || '').toLowerCase();
  return VECTOR_EXT.has(s) || VECTOR_EXT.has(path.extname(s));
}

function keys(abs, st, dark) {
  const k = crypto
    .createHash('sha1')
    .update(`${abs.toLowerCase()}|${st.mtimeMs}|${st.size}|dwg8|${dark ? 'd' : 'l'}`)
    .digest('hex');
  return {
    svg: path.join(cfg.cacheDir, k + '.svg'),
    meta: path.join(cfg.cacheDir, k + '.json'),
  };
}

// 命中缓存（且文件未变化）时直接返回，不重解析
async function peek(abs, dark) {
  if (!cfg.cacheDir) return null;
  try {
    const st = await fsp.stat(abs);
    const { svg, meta } = keys(abs, st, dark);
    const [mSvg, mMeta] = await Promise.all([
      fsp.stat(svg).catch(() => null),
      fsp.stat(meta).catch(() => null),
    ]);
    if (mSvg && mMeta && mSvg.size > 0) {
      const info = JSON.parse(await fsp.readFile(meta, 'utf8'));
      return { ...info, svgPath: svg, cached: true };
    }
  } catch {
    // 文件不存在 / 缓存读取失败都当未命中
  }
  return null;
}

/* ============================ 几何桶 → SVG ============================ */

// 图元颜色按主题自适应：透明底 + 深色主题时，把深色线条提亮，才看得见
function fixColor(hex, dark) {
  const h = String(hex || '').replace('#', '');
  if (h.length !== 6) return dark ? '#e5e7eb' : '#1f2937';
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  if (dark) {
    if (lum < 0.18) return '#e5e7eb';              // 近黑 → 浅灰
    if (lum < 0.32) return '#9aa4b2';
    return '#' + h;                                // 彩色/亮色保持
  }
  if (lum > 0.82) return '#1f2937';
  if (lum > 0.70) return '#374151';
  return '#' + h;
}

function arcPath(cx, cy, r, a0, a1) {
  let sweep = a1 - a0;
  while (sweep <= 0) sweep += Math.PI * 2;
  while (sweep > Math.PI * 2 + 1e-9) sweep -= Math.PI * 2;
  const x0 = cx + r * Math.cos(a0);
  const y0 = cy + r * Math.sin(a0);
  const x1 = cx + r * Math.cos(a0 + sweep);
  const y1 = cy + r * Math.sin(a0 + sweep);
  const large = sweep > Math.PI ? 1 : 0;
  return `M ${x0.toFixed(2)} ${y0.toFixed(2)} A ${r.toFixed(2)} ${r.toFixed(2)} 0 ${large} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}

function f2(v) { return Math.round(v * 100) / 100; }

/* ---------- 稳健边界：定位主体，剔除远处孤立内容 ---------- */
// 真实图纸常有远离主体的杂点或残留的孤立图块，直接 min/max 会把视口撑到
// 百万级 —— 主体被摊成一条线，fit 之后就是「空白画布」。
// 实测 LH-03：主体和杂块相距仅 ~1700 单位，但全范围 510 万 —— 单轮粗网格
// 根本分辨不出。做法：多轮聚类，网格随包围盒收缩越分越细，直到收敛。
function robustBounds(conv) {
  const fb = conv.bounds;
  const xs = [];
  const ys = [];
  const push = (x, y) => { xs.push(x); ys.push(y); };
  for (const B of conv.buckets) {
    const segs = B.segs;
    for (let i = 0; i + 1 < segs.length; i += 2) push(segs[i], segs[i + 1]);
    const cs = B.circles;
    for (let i = 0; i + 2 < cs.length; i += 3) push(cs[i], cs[i + 1]);
    const as = B.arcs;
    for (let i = 0; i + 4 < as.length; i += 5) push(as[i], as[i + 1]);
    for (const p of B.polys) {
      for (let i = 0; i + 1 < p.length; i += 2) push(p[i], p[i + 1]);
    }
    const ps = B.points;
    for (let i = 0; i + 1 < ps.length; i += 2) push(ps[i], ps[i + 1]);
    for (const t of B.texts) push(t.x, t.y);
  }
  const N = xs.length;
  if (N < 32) return fb;                         // 图元太少，直接用原始边界

  // 采样上限（超大图保险起见限一步长）
  const stride = Math.max(1, Math.ceil(N / 400000));
  const px = [], py = [];
  for (let i = 0; i < N; i += stride) { px.push(xs[i]); py.push(ys[i]); }
  const M = px.length;

  const G = 32;
  // 单轮聚类：在 box 内建 32×32 网格，取图元最多的连通块（8-连通）的包围盒。
  // 最大块占比 < 50% 视为结构异常，返回 null 让调用方停止收缩。
  const clusterPass = (box) => {
    const idx = [];
    for (let i = 0; i < M; i++) {
      if (px[i] >= box.x0 && px[i] <= box.x1 && py[i] >= box.y0 && py[i] <= box.y1) idx.push(i);
    }
    const inBox = idx.length;
    if (inBox < 32) return null;
    const w = box.x1 - box.x0, h = box.y1 - box.y0;
    if (!(w > 0) || !(h > 0)) return null;
    const cellCount = new Array(G * G).fill(0);
    for (const i of idx) {
      const ix = Math.min(G - 1, Math.max(0, Math.floor((px[i] - box.x0) / w * G)));
      const iy = Math.min(G - 1, Math.max(0, Math.floor((py[i] - box.y0) / h * G)));
      cellCount[iy * G + ix]++;
    }
    const solidThresh = Math.max(2, inBox * 0.0008);
    const solid = cellCount.map((c) => c >= solidThresh);
    const seen = new Array(G * G).fill(false);
    let best = null;
    for (let s = 0; s < G * G; s++) {
      if (!solid[s] || seen[s]) continue;
      const queue = [s];
      seen[s] = true;
      const cells = [];
      let pts = 0;
      while (queue.length) {
        const c = queue.pop();
        cells.push(c);
        pts += cellCount[c];
        const cx = c % G, cy = (c / G) | 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = cx + dx, ny = cy + dy;
            if (nx < 0 || ny < 0 || nx >= G || ny >= G) continue;
            const ni = ny * G + nx;
            if (solid[ni] && !seen[ni]) { seen[ni] = true; queue.push(ni); }
          }
        }
      }
      if (!best || pts > best.pts) best = { cells, pts, inBox };
    }
    if (!best || best.pts < inBox * 0.5) return null;
    let x0 = G, y0 = G, x1 = -1, y1 = -1;
    for (const c of best.cells) {
      const cx = c % G, cy = (c / G) | 0;
      if (cx < x0) x0 = cx;
      if (cx > x1) x1 = cx;
      if (cy < y0) y0 = cy;
      if (cy > y1) y1 = cy;
    }
    x0 = Math.max(0, x0 - 1); y0 = Math.max(0, y0 - 1);
    x1 = Math.min(G - 1, x1 + 1); y1 = Math.min(G - 1, y1 + 1);
    return {
      x0: box.x0 + x0 / G * w, x1: box.x0 + (x1 + 1) / G * w,
      y0: box.y0 + y0 / G * h, y1: box.y0 + (y1 + 1) / G * h,
    };
  };

  let box = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  for (let i = 0; i < M; i++) {
    if (px[i] < box.x0) box.x0 = px[i];
    if (px[i] > box.x1) box.x1 = px[i];
    if (py[i] < box.y0) box.y0 = py[i];
    if (py[i] > box.y1) box.y1 = py[i];
  }
  const countIn = (bx) => {
    let c = 0;
    for (let i = 0; i < M; i++) {
      if (px[i] >= bx.x0 && px[i] <= bx.x1 && py[i] >= bx.y0 && py[i] <= bx.y1) c++;
    }
    return c;
  };
  // 收敛循环：每轮网格都是当前包围盒的 1/32，主体与杂块的距离每轮「放大」32 倍。
  // 安全阀：某一轮把点丢掉太多（网格变细后主体被切碎）→ 立即停用上一轮结果，
  // 否则会把主体收缩成 77×3 这种碎片（实测踩过）。
  let inside = M;
  for (let pass = 0; pass < 6; pass++) {
    const nb = clusterPass(box);
    if (!nb) break;
    const areaBefore = (box.x1 - box.x0) * (box.y1 - box.y0);
    const areaAfter = (nb.x1 - nb.x0) * (nb.y1 - nb.y0);
    const nextInside = countIn(nb);
    if (nextInside < inside * 0.95) break;       // 单轮丢点 >5% → 切到主体了，停
    if (nextInside < M * 0.7) break;             // 累计丢点 >30% → 收缩过头，停
    inside = nextInside;
    box = nb;
    if (areaAfter > areaBefore * 0.99) break;    // 不再显著缩小 → 已收敛到主体
  }

  // 密度窗口精修：聚类对「对角彩块」无能为力 —— 粗网格里它和主体连通、
  // 细网格时包围盒已同时包含两者，循环不再缩小。实测 LH-03：~6% 的点落在
  // 主体对角 1700 单位外，最终 viewBox 4515×2294 而主体只占其中一角。
  // 做法：X、Y 各自做 64 桶直方图，找累计 92% 点数的最小连续窗口；
  // 只在窗口显著小于当前 box（面积 ≤60%）时才应用 —— 均匀布图的图纸
  // 窗口≈全宽，不会误裁真实内容。
  for (let axis = 0; axis < 2; axis++) {
    const inBox = [];
    for (let i = 0; i < M; i++) {
      if (px[i] >= box.x0 && px[i] <= box.x1 && py[i] >= box.y0 && py[i] <= box.y1) inBox.push(i);
    }
    if (inBox.length < 64) break;
    const NB = 64;
    const lo = axis === 0 ? box.x0 : box.y0;
    const span = (axis === 0 ? box.x1 - box.x0 : box.y1 - box.y0) || 1;
    const hist = new Array(NB).fill(0);
    for (const i of inBox) {
      const v = axis === 0 ? px[i] : py[i];
      hist[Math.min(NB - 1, Math.max(0, Math.floor((v - lo) / span * NB)))]++;
    }
    const target = Math.ceil(inBox.length * 0.92);
    // 滑窗找「点数 ≥ target」的最窄窗口
    let bestL = 0, bestR = NB - 1, acc = 0;
    for (let l = 0, r = 0; r < NB; r++) {
      acc += hist[r];
      while (acc - hist[l] >= target) { acc -= hist[l]; l++; }
      if (acc >= target && r - l < bestR - bestL) { bestL = l; bestR = r; }
    }
    if (bestR - bestL >= NB - 1) break;            // 窗口≈全宽 → 不裁
    const pad = (bestR - bestL + 1) * span / NB * 0.03;
    const nlo = lo + bestL * span / NB - pad;
    const nhi = lo + (bestR + 1) * span / NB + pad;
    const before = axis === 0 ? (box.x1 - box.x0) : (box.y1 - box.y0);
    const after = nhi - nlo;
    if (!(after > 0) || after > before * 0.6) break;  // 窗口不够窄 → 不裁
    if (axis === 0) { box.x0 = nlo; box.x1 = nhi; }
    else { box.y0 = nlo; box.y1 = nhi; }
  }

  // 在最终 box 内取实际点的 min/max
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < M; i++) {
    if (px[i] >= box.x0 && px[i] <= box.x1 && py[i] >= box.y0 && py[i] <= box.y1) {
      if (px[i] < minX) minX = px[i];
      if (px[i] > maxX) maxX = px[i];
      if (py[i] < minY) minY = py[i];
      if (py[i] > maxY) maxY = py[i];
    }
  }
  const w = maxX - minX, h = maxY - minY;
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return fb;
  // 视口外扩 3%，贴边的线不至于顶死边框
  const mx = w * 0.03, my = h * 0.03;
  return { minX: minX - mx, minY: minY - my, maxX: maxX + mx, maxY: maxY + my };
}

// SVG 的内在像素尺寸封顶：viewBox 才决定坐标，width/height 只影响 Chromium
// 栅格化 —— 500 万像素高的 SVG 会直接画不出来（空白）。
const MAX_SIDE = 4096;

// 单个多段线 → polyline points 字符串（Float32Array）
function ptsAttr(arr) {
  const n = Math.floor(arr.length / 2) * 2;
  const out = new Array(n / 2);
  for (let i = 0; i < n; i += 2) out[i / 2] = f2(arr[i]) + ',' + f2(arr[i + 1]);
  return out.join(' ');
}

function buildSVG(conv, dark) {
  const b = robustBounds(conv);
  const w = Math.max(1, b.maxX - b.minX);
  const h = Math.max(1, b.maxY - b.minY);
  const span = Math.max(w, h);
  const sw = Math.max(span / 1400, span / 1400);   // 线宽 ≈ 千分之一跨度
  const ptR = span / 400;
  // 内在尺寸封顶，保持纵横比
  const scale = Math.min(1, MAX_SIDE / Math.max(w, h));
  const outW = Math.max(1, Math.round(w * scale));
  const outH = Math.max(1, Math.round(h * scale));
  const parts = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${outW}" height="${outH}" ` +
    `viewBox="${f2(b.minX)} ${f2(-b.maxY)} ${f2(w)} ${f2(h)}">`
  );

  // 注：CAD 的 Y 轴向上，SVG 的 Y 轴向下 → 用 transform 翻转一次，
  // 桶内坐标保持数学坐标，文字翻转后通过逆变换摆正。透明底，颜色随主题。
  parts.push('<g transform="scale(1,-1)">');

  for (const B of conv.buckets) {
    const color = fixColor(B.color, dark);
    const g = [`<g stroke="${color}" fill="none" stroke-width="${f2(sw)}" stroke-linecap="round" stroke-linejoin="round">`];
    // 直线段
    const segs = B.segs;
    for (let i = 0; i + 3 < segs.length; i += 4) {
      g.push(`<line x1="${f2(segs[i])}" y1="${f2(segs[i + 1])}" x2="${f2(segs[i + 2])}" y2="${f2(segs[i + 3])}"/>`);
    }
    // 圆
    const cs = B.circles;
    for (let i = 0; i + 2 < cs.length; i += 3) {
      g.push(`<circle cx="${f2(cs[i])}" cy="${f2(cs[i + 1])}" r="${f2(cs[i + 2])}"/>`);
    }
    // 弧
    const as = B.arcs;
    for (let i = 0; i + 4 < as.length; i += 5) {
      g.push(`<path d="${arcPath(as[i], as[i + 1], as[i + 2], as[i + 3], as[i + 4])}"/>`);
    }
    // 多段线
    for (let i = 0; i < B.polys.length; i++) {
      g.push(`<polyline points="${ptsAttr(B.polys[i])}"/>`);
    }
    // 点（填充小圆，不随 stroke）
    const ps = B.points;
    if (ps.length) {
      const pg = [`<g fill="${color}" stroke="none">`];
      for (let i = 0; i + 1 < ps.length; i += 2) {
        pg.push(`<circle cx="${f2(ps[i])}" cy="${f2(ps[i + 1])}" r="${f2(ptR)}"/>`);
      }
      pg.push('</g>');
      g.push(pg.join(''));
    }
    // 文字：翻转坐标里再翻回来，保证不镜像
    if (B.texts.length) {
      const tg = [`<g fill="${color}" stroke="none" font-family="sans-serif" transform="scale(1,-1)">`];
      for (const t of B.texts) {
        const fs = Math.max(t.h, span / 500);
        const deg = -(t.rot || 0) * 180 / Math.PI;
        const tf = deg ? ` transform="rotate(${deg.toFixed(1)} ${f2(t.x)} ${f2(-t.y)})"` : '';
        tg.push(`<text x="${f2(t.x)}" y="${f2(-t.y)}" font-size="${f2(fs)}"${tf} xml:space="preserve">${escapeXML(t.s)}</text>`);
      }
      tg.push('</g>');
      g.push(tg.join(''));
    }
    g.push('</g>');
    parts.push(g.join(''));
  }

  parts.push('</g></svg>');
  // ⚠️ width/height 必须是 SVG 的内在像素尺寸(outW/outH)，不能是 CAD 单位——
  // 渲染层 fit() 用它算缩放，和 <img> 的固有尺寸脱钩会把图缩成亚像素(空白画布)。
  return { svg: parts.join(''), width: outW, height: outH, cadWidth: w, cadHeight: h };
}

function escapeXML(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/* ============================ 解析入口 ============================ */

function parseWithTimeout(abs, ext) {
  const job = (async () => {
    if (ext === '.dxf') {
      const buf = await fsp.readFile(abs);
      const text = decodeText(buf);
      return { ...parseDxf(text, path.basename(abs)), format: 'DXF' };
    }
    const buf = await fsp.readFile(abs);
    // WASM 直接吃 Buffer（拷进堆，避免外挂内存被提前回收）
    const copy = new Uint8Array(buf.byteLength);
    copy.set(buf);
    return { ...(await parser.parseDwg(copy, path.basename(abs))), format: 'DWG' };
  })();

  const timer = setTimeout(() => job.catch(() => {}), TIMEOUT_MS);
  // job 本身没有取消能力；超时靠 Promise.race 拒绝
  const timeout = new Promise((_, rej) =>
    setTimeout(() => rej(new Error(`DWG/DXF 解析超时（${TIMEOUT_MS / 1000}s）`)), TIMEOUT_MS));
  return Promise.race([job, timeout]).finally(() => clearTimeout(timer));
}

// DXF 文本编码识别（dxf-parser 内部也有，这里对 Buffer 先行处理）
function decodeText(buf) {
  let enc = 'utf8';
  try {
    const head = buf.slice(0, 8192).toString('latin1');
    const idx = head.indexOf('$DWGCODEPAGE');
    if (idx >= 0) {
      const seg = head.slice(idx, idx + 200).split(/\r?\n/).map(s => s.trim());
      const p = seg.indexOf('3');
      const cp = p >= 0 ? (seg[p + 1] || '').toUpperCase() : '';
      if (cp.indexOf('GB') >= 0 || cp.indexOf('936') >= 0) enc = 'gb18030';
      else if (cp.indexOf('BIG5') >= 0 || cp.indexOf('950') >= 0) enc = 'big5';
      else if (cp.indexOf('1252') >= 0 || cp === 'ANSI_1252') enc = 'latin1';
    }
  } catch { /* ignore */ }
  return buf.toString(enc);
}

/**
 * 把 DWG/DXF 转成 SVG。
 * @param {{dark?: boolean}} opts 主题（决定线条明暗，透明底）
 * @returns {Promise<{ok:true,svgPath:string,pages:number,width:number,height:number,entities:number,layers:number,format:string,cached:boolean}>}
 */
async function render(abs, opts) {
  const dark = !!(opts && opts.dark);
  if (!supported(abs)) throw new Error('不是 DWG/DXF 文件');
  if (!cfg.wasmDir && !cfg.cacheDir) throw new Error('dwg 模块未初始化');

  const hit = await peek(abs, dark);
  if (hit) return hit;

  const st = await fsp.stat(abs);
  if (st.size > MAX_INPUT_BYTES) throw new Error('文件过大，不适用矢量渲染');

  const key = abs.toLowerCase() + (dark ? ':d' : ':l');
  if (inflight.has(key)) return inflight.get(key);

  const job = (async () => {
    const ext = path.extname(abs).toLowerCase();
    const conv = await parseWithTimeout(abs, ext);
    if (!conv || !conv.ok) throw new Error('解析失败：文件损坏或版本不受支持');

    const { svg, width: rw, height: rh, cadWidth: cw, cadHeight: ch } = buildSVG(conv, dark);
    if (svg.length > MAX_SVG_BYTES) throw new Error('图纸过于复杂，SVG 体积超限');

    const { svg: svgPath, meta } = keys(abs, st, dark);
    await fsp.mkdir(cfg.cacheDir, { recursive: true });
    await fsp.writeFile(svgPath, svg, 'utf8');
    const metaOut = {
      ok: true,
      pages: 1,
      page: 0,
      width: rw,
      height: rh,
      cadWidth: cw,
      cadHeight: ch,
      entities: conv.stats ? conv.stats.entities : 0,
      layers: conv.layers ? conv.layers.length : 0,
      format: conv.format,
      renderedAt: Date.now(),
    };
    // 先写临时文件再改名，避免中断留下半截 meta（peek 会把坏 meta 当未命中）
    const metaTmp = meta + '.tmp';
    await fsp.writeFile(metaTmp, JSON.stringify(metaOut), 'utf8');
    await fsp.rename(metaTmp, meta);
    return { ...metaOut, svgPath, cached: false };
  })();

  inflight.set(key, job);
  try {
    return await job;
  } finally {
    inflight.delete(key);
  }
}

// 预热：后台解析，不抛错、不阻塞调用方
function warmup(abs, notify, opts) {
  render(abs, opts)
    .then((r) => { if (notify) notify(null, r); })
    .catch((err) => { if (notify) notify(err, null); });
}

module.exports = {
  VECTOR_EXT,
  init,
  supported,
  render,
  peek,
  warmup,
  toolConfigured: () => true,
};
