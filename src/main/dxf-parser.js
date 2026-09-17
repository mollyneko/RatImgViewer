'use strict';

/**
 * 高性能 DXF 解析器
 * - 纯 JS、零依赖
 * - 单次线性扫描，分组码直读，无正则
 * - 输出几何体为类型化数组（Float32Array），可零拷贝转移给渲染进程
 * - 支持：LINE / CIRCLE / ARC / LWPOLYLINE / POLYLINE+VERTEX / ELLIPSE / POINT / TEXT / MTEXT / INSERT(块展开)
 */

/* ============================ 颜色（AutoCAD ACI） ============================ */

function hsv2rgb(h, s, v) {
  h = ((h % 360) + 360) % 360;
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  let r = 0, g = 0, b = 0;
  if (h < 60) { r = c; g = x; }
  else if (h < 120) { r = x; g = c; }
  else if (h < 180) { g = c; b = x; }
  else if (h < 240) { g = x; b = c; }
  else if (h < 300) { r = x; b = c; }
  else { r = c; b = x; }
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

const ACI_TABLE = (function () {
  const t = new Uint8Array(256 * 3);
  const set = (i, r, g, b) => { t[i * 3] = r; t[i * 3 + 1] = g; t[i * 3 + 2] = b; };
  const base = [
    [0, 0, 0],       // 0  BYBLOCK
    [255, 0, 0],     // 1
    [255, 255, 0],   // 2
    [0, 255, 0],     // 3
    [0, 255, 255],   // 4
    [0, 0, 255],     // 5
    [255, 0, 255],   // 6
    [255, 255, 255], // 7
    [128, 128, 128], // 8
    [192, 192, 192]  // 9
  ];
  for (let i = 0; i < base.length; i++) set(i, base[i][0], base[i][1], base[i][2]);
  // 10..249：按 6 个色相带 × 40 生成，每带 10 组明度/饱和度变化
  for (let i = 10; i <= 249; i++) {
    const n = i - 10;
    const band = Math.floor(n / 40);
    const sub = Math.floor((n % 40) / 4);
    const hue = band * 60 + (sub % 5) * 6;
    let s = 1, v = 1;
    switch (sub) {
      case 1: s = 0.6; v = 1.0; break;
      case 2: s = 1.0; v = 0.78; break;
      case 3: s = 1.0; v = 0.55; break;
      case 4: s = 0.45; v = 0.85; break;
      case 5: s = 1.0; v = 1.0; break;
      case 6: s = 0.75; v = 0.95; break;
      case 7: s = 1.0; v = 0.88; break;
      case 8: s = 1.0; v = 0.66; break;
      case 9: s = 0.5; v = 0.62; break;
      default: s = 1.0; v = 1.0;
    }
    const c = hsv2rgb(hue, s, v);
    set(i, c[0], c[1], c[2]);
  }
  // 250..255：灰阶
  const grays = [51, 85, 125, 170, 212, 255];
  for (let i = 0; i < grays.length; i++) set(250 + i, grays[i], grays[i], grays[i]);
  return t;
})();

function aciRgb(idx) {
  if (!Number.isFinite(idx) || idx < 0 || idx > 255) idx = 7;
  return [ACI_TABLE[idx * 3], ACI_TABLE[idx * 3 + 1], ACI_TABLE[idx * 3 + 2]];
}

function aciHex(idx) {
  const c = aciRgb(idx);
  return '#' + ((1 << 24) + (c[0] << 16) + (c[1] << 8) + c[2]).toString(16).slice(1);
}

/* ============================ 编码识别 ============================ */

function decodeBuffer(buf) {
  let enc = 'utf-8';
  try {
    const head = buf.slice(0, 8192).toString('latin1');
    const idx = head.indexOf('$DWGCODEPAGE');
    if (idx >= 0) {
      const seg = head.slice(idx, idx + 200).split(/\r?\n/).map(s => s.trim());
      const p = seg.indexOf('3');
      const cp = p >= 0 ? (seg[p + 1] || '').toUpperCase() : '';
      if (cp.indexOf('GB') >= 0 || cp.indexOf('936') >= 0) enc = 'gb18030';
      else if (cp.indexOf('BIG5') >= 0 || cp.indexOf('950') >= 0) enc = 'big5';
      else if (cp.indexOf('1252') >= 0 || cp === 'ANSI_1252') enc = 'windows-1252';
      else if (cp.indexOf('1251') >= 0) enc = 'windows-1251';
      else if (cp.indexOf('932') >= 0) enc = 'shift_jis';
      else if (cp.indexOf('949') >= 0) enc = 'euc-kr';
    }
    // UTF-8 BOM
    if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) enc = 'utf-8';
    return new TextDecoder(enc, { fatal: false }).decode(buf);
  } catch (e) {
    return buf.toString('utf8');
  }
}

/* ============================ 矩阵工具 ============================ */

// [a,b,c,d,e,f]: x' = a*x + c*y + e ; y' = b*x + d*y + f
const IDENTITY = [1, 0, 0, 1, 0, 0];

function mul(A, B) {
  return [
    A[0] * B[0] + A[2] * B[1],
    A[1] * B[0] + A[3] * B[1],
    A[0] * B[2] + A[2] * B[3],
    A[1] * B[2] + A[3] * B[3],
    A[0] * B[4] + A[2] * B[5] + A[4],
    A[1] * B[4] + A[3] * B[5] + A[5]
  ];
}

/* ============================ 主解析 ============================ */

function parseDxf(text, fileName) {
  const t0 = Date.now();

  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const lines = text.split(/\r\n|\r|\n/);
  const n = lines.length;

  let i = 0;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

  const upd = (x, y) => {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  };

  /* ---- 图层 ---- */
  const layerList = [];
  const layerMap = new Map();
  function getLayer(name) {
    let L = layerMap.get(name);
    if (!L) {
      L = { name, colorIndex: 7, visible: true, count: 0, index: layerList.length };
      layerMap.set(name, L);
      layerList.push(L);
    }
    return L;
  }
  getLayer('0');

  /* ---- 绘制桶（按 图层+颜色 分组，渲染时可整桶批量描边） ---- */
  const bucketList = [];
  const bucketMap = new Map();
  function getBucket(layerIdx, colorIdx) {
    const key = layerIdx + '|' + colorIdx;
    let B = bucketMap.get(key);
    if (!B) {
      B = {
        layer: layerIdx,
        color: aciHex(colorIdx),
        segs: [],      // Float32 对：[x1,y1,x2,y2,...]  （LINE）
        circles: [],   // [cx,cy,r]
        arcs: [],      // [cx,cy,r,a0,a1]
        polys: [],     // [Float32Array(x,y,...)]  连续折线/曲线
        polyClosed: [],// Uint8 配对
        points: [],    // [x,y]
        texts: [],     // {x,y,h,rot,s}
        count: 0
      };
      bucketMap.set(key, B);
      bucketList.push(B);
    }
    return B;
  }

  /* ---- 读取一组属性，直到下一个组码 0 ---- */
  const REPEAT = { '10': 1, '20': 1, '30': 1, '11': 1, '21': 1, '31': 1, '42': 1 };
  function readGroups() {
    const g = Object.create(null);
    while (i + 1 < n) {
      const c = lines[i];
      if (c === '0') break;
      const v = lines[i + 1];
      i += 2;
      if (REPEAT[c]) {
        const f = parseFloat(v);
        if (g[c]) g[c].push(f); else g[c] = [f];
      } else {
        g[c] = v;
      }
    }
    return g;
  }

  /* ----  bulge 弧段 tessellation ---- */
  function pushBulge(pts, x1, y1, x2, y2, bulge) {
    if (!Number.isFinite(bulge) || Math.abs(bulge) < 1e-9) return;
    const dx = x2 - x1, dy = y2 - y1;
    const c = Math.hypot(dx, dy);
    if (c < 1e-12) return;
    const theta = 4 * Math.atan(bulge);
    const s = Math.sin(theta / 2);
    if (Math.abs(s) < 1e-12) return;
    const r = c / (2 * s);
    const h = r * Math.cos(theta / 2);
    const ux = dx / c, uy = dy / c;
    // 垂直方向（+90°）
    const cx = (x1 + x2) / 2 + (-uy) * h;
    const cy = (y1 + y2) / 2 + (ux) * h;
    const a0 = Math.atan2(y1 - cy, x1 - cx);
    const steps = Math.min(96, Math.max(3, Math.ceil(Math.abs(theta) / 0.30)));
    const rr = Math.abs(r);
    for (let s2 = 1; s2 < steps; s2++) {
      const a = a0 + theta * (s2 / steps);
      pts.push(cx + rr * Math.cos(a), cy + rr * Math.sin(a));
    }
  }

  /* ---- 变换点 ---- */
  function tx(m, x, y) { return m[0] * x + m[2] * y + m[4]; }
  function ty(m, x, y) { return m[1] * x + m[3] * y + m[5]; }
  function scaleOf(m) {
    const det = Math.abs(m[0] * m[3] - m[1] * m[2]);
    return det > 1e-12 ? Math.sqrt(det) : 1;
  }
  function rotOf(m) { return Math.atan2(m[1], m[0]); }

  /* ---- 实体处理 ---- */
  const blocks = new Map();
  let totalEntities = 0;

  function handleEntity(type, g, ctx) {
    if (!g) return;
    const m = ctx.m;
    const layerName = ((g['8'] || '0').trim()) || '0';
    const layer = getLayer(layerName);

    let ci = parseInt(g['62'], 10);
    if (!Number.isFinite(ci) || ci === 256 || ci === 0) ci = layer.colorIndex;
    if (ci < 0) ci = 0;
    if (ci > 255) ci = 255;

    const B = getBucket(layer.index, ci);
    const sc = scaleOf(m);
    const ro = rotOf(m);

    switch (type) {
      case 'LINE': {
        const x1 = g['10'] ? g['10'][0] : 0;
        const y1 = g['20'] ? g['20'][0] : 0;
        const x2 = g['11'] ? g['11'][0] : 0;
        const y2 = g['21'] ? g['21'][0] : 0;
        const X1 = tx(m, x1, y1), Y1 = ty(m, x1, y1);
        const X2 = tx(m, x2, y2), Y2 = ty(m, x2, y2);
        B.segs.push(X1, Y1, X2, Y2);
        upd(X1, Y1); upd(X2, Y2);
        B.count++; totalEntities++; layer.count++;
        break;
      }
      case 'CIRCLE': {
        const cx = g['10'] ? g['10'][0] : 0;
        const cy = g['20'] ? g['20'][0] : 0;
        const r = (parseFloat(g['40']) || 0) * sc;
        const X = tx(m, cx, cy), Y = ty(m, cx, cy);
        B.circles.push(X, Y, r);
        upd(X - r, Y - r); upd(X + r, Y + r);
        B.count++; totalEntities++; layer.count++;
        break;
      }
      case 'ARC': {
        const cx = g['10'] ? g['10'][0] : 0;
        const cy = g['20'] ? g['20'][0] : 0;
        const r = (parseFloat(g['40']) || 0) * sc;
        const a0 = (parseFloat(g['50']) || 0) * Math.PI / 180 + ro;
        const a1 = (parseFloat(g['51']) || 0) * Math.PI / 180 + ro;
        const X = tx(m, cx, cy), Y = ty(m, cx, cy);
        B.arcs.push(X, Y, r, a0, a1);
        upd(X - r, Y - r); upd(X + r, Y + r);
        B.count++; totalEntities++; layer.count++;
        break;
      }
      case 'LWPOLYLINE': {
        const xs = g['10'], ys = g['20'];
        if (!xs || !ys) break;
        const cnt = Math.min(xs.length, ys.length);
        if (cnt < 2) break;
        const flag = parseInt(g['70'], 10) || 0;
        const closed = (flag & 1) !== 0;
        const bulges = g['42'] || null;
        const pts = [];
        for (let k = 0; k < cnt; k++) {
          const X = tx(m, xs[k], ys[k]), Y = ty(m, xs[k], ys[k]);
          if (k > 0 && bulges) pushBulge(pts, pts[pts.length - 2], pts[pts.length - 1], X, Y, bulges[k - 1]);
          pts.push(X, Y);
          upd(X, Y);
        }
        if (closed && cnt > 2) {
          const X = pts[0], Y = pts[1];
          if (bulges) pushBulge(pts, pts[pts.length - 2], pts[pts.length - 1], X, Y, bulges[cnt - 1]);
          pts.push(X, Y);
        }
        B.polys.push(new Float32Array(pts));
        B.polyClosed.push(closed ? 1 : 0);
        B.count++; totalEntities++; layer.count++;
        break;
      }
      case 'ELLIPSE': {
        const cx = g['10'] ? g['10'][0] : 0;
        const cy = g['20'] ? g['20'][0] : 0;
        const mx = g['11'] ? g['11'][0] : 1;
        const my = g['21'] ? g['21'][0] : 0;
        const ratio = parseFloat(g['40']) || 1;
        const CX = tx(m, cx, cy), CY = ty(m, cx, cy);
        // 主轴向量参与变换（近似：按整体缩放）
        const a = Math.hypot(mx, my) * sc;
        const b = a * ratio;
        const ang = Math.atan2(my, mx) + ro;
        let p0 = parseFloat(g['41']), p1 = parseFloat(g['42']);
        if (!Number.isFinite(p0) || !Number.isFinite(p1)) { p0 = 0; p1 = Math.PI * 2; }
        let sweep = p1 - p0;
        while (sweep <= 0) sweep += Math.PI * 2;
        const steps = Math.min(256, Math.max(12, Math.ceil(sweep / 0.12)));
        const pts = [];
        const ca = Math.cos(ang), sa = Math.sin(ang);
        for (let k = 0; k <= steps; k++) {
          const t = p0 + sweep * (k / steps);
          const lx = a * Math.cos(t), ly = b * Math.sin(t);
          const X = CX + lx * ca - ly * sa;
          const Y = CY + lx * sa + ly * ca;
          pts.push(X, Y); upd(X, Y);
        }
        B.polys.push(new Float32Array(pts));
        B.polyClosed.push(Math.abs(sweep - Math.PI * 2) < 1e-6 ? 1 : 0);
        B.count++; totalEntities++; layer.count++;
        break;
      }
      case 'POINT': {
        const x = g['10'] ? g['10'][0] : 0;
        const y = g['20'] ? g['20'][0] : 0;
        const X = tx(m, x, y), Y = ty(m, x, y);
        B.points.push(X, Y); upd(X, Y);
        B.count++; totalEntities++; layer.count++;
        break;
      }
      case 'TEXT':
      case 'MTEXT': {
        const x = g['10'] ? g['10'][0] : 0;
        const y = g['20'] ? g['20'][0] : 0;
        const X = tx(m, x, y), Y = ty(m, x, y);
        let s = g['1'] || g['3'] || '';
        if (Array.isArray(s)) s = s.join('');
        s = String(s).replace(/\\[A-Za-z0-9.|]+;?/g, '').replace(/[{}]/g, '').trim();
        s = s.replace(/%%[cC]/g, 'Ø').replace(/%%[dD]/g, '°').replace(/%%[pP]/g, '±').replace(/%%%/g, '%');
        if (s) {
          const h = (parseFloat(g['40']) || 2.5) * sc;
          const rot = (parseFloat(g['50']) || 0) * Math.PI / 180 + ro;
          B.texts.push({ x: X, y: Y, h, rot, s });
          upd(X, Y);
        }
        B.count++; totalEntities++; layer.count++;
        break;
      }
      case 'INSERT': {
        const name = (g['2'] || '').trim();
        const blk = blocks.get(name);
        if (!blk) break;
        const ix = g['10'] ? g['10'][0] : 0;
        const iy = g['20'] ? g['20'][0] : 0;
        let sx = parseFloat(g['41']); if (!Number.isFinite(sx) || sx === 0) sx = 1;
        let sy = parseFloat(g['42']); if (!Number.isFinite(sy) || sy === 0) sy = sx;
        const rot = (parseFloat(g['50']) || 0) * Math.PI / 180;
        const cs = Math.cos(rot), sn = Math.sin(rot);

        let M = [1, 0, 0, 1, ix, iy];                 // T(ins)
        M = mul(M, [cs, sn, -sn, cs, 0, 0]);          // R
        M = mul(M, [sx, 0, 0, sy, 0, 0]);             // S
        M = mul(M, [1, 0, 0, 1, -blk.base[0], -blk.base[1]]); // T(-base)
        const child = { m: mul(m, M), depth: (ctx.depth || 0) + 1 };
        if (child.depth > 8) break;
        for (let k = 0; k < blk.ents.length; k++) {
          const e = blk.ents[k];
          handleEntity(e.type, e.g === undefined ? null : e.g, child);
        }
        break;
      }
      default:
        break;
    }
  }

  /* ---- POLYLINE 状态机 ---- */
  let poly = null;
  function flushPoly() {
    if (!poly) return;
    const pts = poly.pts;
    if (pts.length >= 4) {
      const B = poly.bucket;
      B.polys.push(new Float32Array(pts));
      B.polyClosed.push(poly.closed ? 1 : 0);
      B.count++; totalEntities++; poly.layer.count++;
    }
    poly = null;
  }

  /* ---- 读取一个实体 ---- */
  function readEntity() {
    while (i + 1 < n) {
      const c = lines[i];
      if (c !== '0') { i += 2; continue; }
      const type = lines[i + 1].trim();
      i += 2;
      if (type === 'ENDSEC' || type === 'ENDBLK' || type === 'SEQEND' || type === 'EOF') {
        return { type, g: null };
      }
      const g = readGroups();
      return { type, g };
    }
    return null;
  }

  /* ---- 段扫描 ---- */
  function parseTables() {
    while (true) {
      const e = readEntity();
      if (!e || e.type === 'ENDSEC' || e.type === 'EOF') return;
      if (e.type === 'LAYER' && e.g) {
        const name = (e.g['2'] || '').trim();
        if (name) {
          const L = getLayer(name);
          const c66 = parseInt(e.g['62'], 10);
          if (Number.isFinite(c66)) {
            if (c66 < 0) { L.visible = false; L.colorIndex = Math.min(255, -c66); }
            else { L.colorIndex = Math.min(255, c66); L.visible = true; }
          }
        }
      }
    }
  }

  function parseBlocks() {
    while (true) {
      const e = readEntity();
      if (!e || e.type === 'ENDSEC' || e.type === 'EOF') return;
      if (e.type === 'BLOCK' && e.g) {
        const name = (e.g['2'] || '').trim();
        const bx = e.g['10'] ? e.g['10'][0] : 0;
        const by = e.g['20'] ? e.g['20'][0] : 0;
        const ents = [];
        while (true) {
          const ce = readEntity();
          if (!ce) break;
          if (ce.type === 'ENDBLK' || ce.type === 'ENDSEC' || ce.type === 'EOF') break;
          if (ce.g) ents.push(ce);
        }
        if (name) blocks.set(name, { base: [bx, by], ents });
      }
    }
  }

  function parseEntities() {
    const root = { m: IDENTITY, depth: 0 };
    while (true) {
      const e = readEntity();
      if (!e || e.type === 'ENDSEC' || e.type === 'EOF') break;

      if (e.type === 'POLYLINE') {
        flushPoly();
        if (e.g) {
          const ln = ((e.g['8'] || '0').trim()) || '0';
          const layer = getLayer(ln);
          let ci = parseInt(e.g['62'], 10);
          if (!Number.isFinite(ci) || ci === 256 || ci === 0) ci = layer.colorIndex;
          if (ci < 0) ci = 0; if (ci > 255) ci = 255;
          const flag = parseInt(e.g['70'], 10) || 0;
          poly = { bucket: getBucket(layer.index, ci), layer, pts: [], closed: (flag & 1) !== 0, last: null, prevBulge: 0 };
        }
        continue;
      }
      if (e.type === 'VERTEX') {
        if (poly && e.g && e.g['10'] && e.g['20']) {
          const X = e.g['10'][0], Y = e.g['20'][0];
          const bg = e.g['42'] ? e.g['42'][0] : 0;
          if (poly.last) pushBulge(poly.pts, poly.last[0], poly.last[1], X, Y, poly.prevBulge);
          poly.pts.push(X, Y); upd(X, Y);
          poly.last = [X, Y];
          poly.prevBulge = bg;
        }
        continue;
      }
      if (e.type === 'SEQEND') { flushPoly(); continue; }

      handleEntity(e.type, e.g, root);
    }
    flushPoly();
  }

  /* ---- 主循环 ---- */
  while (i + 1 < n) {
    if (lines[i] !== '0') { i += 2; continue; }
    const name = lines[i + 1].trim();
    if (name === 'SECTION') {
      i += 2;
      let secName = '';
      if (i + 1 < n && lines[i].trim() === '2') { secName = lines[i + 1].trim(); i += 2; }
      if (secName === 'ENTITIES') parseEntities();
      else if (secName === 'BLOCKS') parseBlocks();
      else if (secName === 'TABLES') parseTables();
      else {
        // 跳过未知段（含 HEADER）
        while (i + 1 < n) {
          if (lines[i] === '0' && lines[i + 1].trim() === 'ENDSEC') { i += 2; break; }
          i += 2;
        }
      }
      continue;
    }
    if (name === 'EOF') break;
    i += 2;
  }

  /* ---- 整理输出：数组 → 类型化数组 ---- */
  const buckets = [];
  for (let k = 0; k < bucketList.length; k++) {
    const B = bucketList[k];
    if (B.count === 0) continue;
    buckets.push({
      layer: B.layer,
      color: B.color,
      count: B.count,
      segs: new Float32Array(B.segs),
      circles: new Float32Array(B.circles),
      arcs: new Float32Array(B.arcs),
      polys: B.polys,
      polyClosed: new Uint8Array(B.polyClosed),
      points: new Float32Array(B.points),
      texts: B.texts
    });
  }

  const layers = layerList.map(L => ({
    name: L.name,
    color: aciHex(L.colorIndex),
    visible: L.visible,
    count: L.count
  }));

  if (!Number.isFinite(minX) || !Number.isFinite(minY)) { minX = minY = 0; maxX = maxY = 100; }

  return {
    ok: true,
    fileName: fileName || '',
    bounds: { minX, minY, maxX, maxY },
    layers,
    buckets,
    stats: {
      entities: totalEntities,
      layers: layers.length,
      buckets: buckets.length,
      ms: Date.now() - t0,
      chars: text.length
    }
  };
}

module.exports = { parseDxf, decodeBuffer, aciHex, aciRgb };
