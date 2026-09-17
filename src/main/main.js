'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell, nativeTheme, protocol, net, nativeImage } = require('electron');
const path = require('node:path');
const fsp = require('node:fs/promises');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');

const scanner = require('./scanner');
const exifReader = require('./exif');
const previewer = require('./preview');
const cdr = require('./cdr');
const dwg = require('./dwg');
const { DiskCache } = require('./cache');
const assoc = require('./assoc');

const isSmoke = process.argv.includes('--smoke-test');
const IMG_CACHE = new Map();      // 内嵌预览的内存缓存（避免同一次会话重复挖）
const IMG_CACHE_MAX = 40;

let win = null;
let cache = null;
let pendingPath = null;
const allowed = new Set();        // 允许通过 ratfile:// 读出的绝对路径

// ---------------------------------------------------------------- 单实例
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

app.on('second-instance', (_e, argv) => {
  const p = pathFromArgv(argv);
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
    if (p) {
      pendingPath = p;
      win.webContents.send('app:openPath', p);
    }
  }
});

// --safe-mode：给显卡驱动异常的机器留的后路，纯软件渲染启动。
const isSafe = process.argv.includes('--safe-mode') || process.argv.includes('--no-gpu');

// 驱动有问题时 GPU 进程会反复起不来，Chromium 默认到达次数上限就「连坐」整个应用
// （实测退出码 0x80000003）。关掉这个上限，让它自己退化成软件渲染继续跑，
// 用户顶多觉得慢一点，不会「一打开就闪退」。
app.commandLine.appendSwitch('disable-gpu-process-crash-limit');

// 自动化探针同样属于「无人值守」场景：本机沙箱里 GPU 进程起不来会一路拖到超时，
// 所以探针模式一并走软件渲染，保证 CI/脚本里能稳定拿到结果。
const isHeadlessProbe = !!process.env.RAT_WINDOW_PROBE;

if (isSmoke || isSafe || isHeadlessProbe) {
  // 无头/受限环境里 GPU 进程往往起不来，会拖住 Electron 的退出流程。
  // 冒烟测试只验逻辑，不需要 GPU。
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('disable-gpu');
  app.commandLine.appendSwitch('disable-gpu-compositing');
  app.commandLine.appendSwitch('disable-gpu-sandbox');
  app.commandLine.appendSwitch('disable-software-rasterizer');
  app.commandLine.appendSwitch('in-process-gpu');
}

if (process.platform === 'win32') app.setAppUserModelId('com.rat.imageviewer');

// ---------------------------------------------------------------- 自定义协议
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'ratfile',
    privileges: { secure: true, supportFetchAPI: true, stream: true, bypassCSP: true },
  },
]);

// ---------------------------------------------------------------- 工具
function pathFromArgv(argv) {
  if (!argv) return null;
  for (const a of argv.slice(1)) {
    if (!a || a.startsWith('-')) continue;
    if (a === '.' || a === path.resolve('.')) continue;
    try {
      const abs = path.resolve(a);
      if (fs.existsSync(abs) && fs.statSync(abs).isFile()) return abs;
    } catch {}
  }
  return null;
}

function allow(p) {
  const abs = path.resolve(p);
  allowed.add(abs);
  return abs;
}

function settingsFile() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function readSettings() {
  try {
    return JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
  } catch {
    return {};
  }
}

function writeSettings(patch) {
  const next = { ...readSettings(), ...patch };
  try {
    fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
    fs.writeFileSync(settingsFile(), JSON.stringify(next, null, 2));
  } catch {}
  return next;
}

function themeBackground(theme) {
  return theme === 'dark' ? '#0e1116' : '#f4f5f7';
}

// 当前是否为深色外观（跟随用户的 light/dark/system 设置）。
// DWG/DXF 的 SVG 是透明底的，线条明暗必须按主题生成 —— 缓存键也因此带主题维度，
// 免得切主题后拿到另一套配色。nativeTheme 在 themeSource 变化后会同步更新。
function isDarkTheme() {
  return !!(nativeTheme && nativeTheme.shouldUseDarkColors);
}

// 取内嵌预览（带内存缓存）
async function getPreview(abs, thumbMode) {
  const hit = IMG_CACHE.get(abs);
  if (hit) return hit;
  const pv = await previewer.extractPreview(abs, {
    maxBytes: thumbMode ? previewer.THUMB_SCAN_BYTES : previewer.FULL_SCAN_BYTES,
  });
  if (!pv) return null;
  if (IMG_CACHE.size >= IMG_CACHE_MAX) {
    IMG_CACHE.delete(IMG_CACHE.keys().next().value);
  }
  IMG_CACHE.set(abs, pv);
  return pv;
}

// ---------------------------------------------------------------- 协议处理
function handleProtocol() {
  protocol.handle('ratfile', async (request) => {
    let u;
    try {
      u = new URL(request.url);
    } catch {
      return new Response('bad url', { status: 400 });
    }
    const host = u.host;
    const p = decodeURIComponent(u.searchParams.get('p') || '');
    const w = parseInt(u.searchParams.get('w') || '0', 10);
    if (!p) return new Response('missing path', { status: 400 });

    const abs = path.resolve(p);
    if (!allowed.has(abs)) return new Response('forbidden', { status: 403 });

    let st;
    try {
      st = await fsp.stat(abs);
    } catch {
      return new Response('not found', { status: 404 });
    }

    const ext = path.extname(abs).toLowerCase();
    const isNative = scanner.NATIVE.has(ext);
    const isPreview = scanner.PREVIEW.has(ext);

    // ---- 矢量（CDR=libcdr 转 SVG / DWG=LibreDWG 转 SVG，缓存命中才有）----
    if (host === 'svg') {
      const hit = (await cdr.peek(abs, 0)) || (await dwg.peek(abs, isDarkTheme()));
      if (!hit) return new Response('no vector', { status: 404 });
      const data = await fsp.readFile(hit.svgPath);
      return new Response(data, {
        headers: { 'content-type': 'image/svg+xml', 'x-rat-vector': '1' },
      });
    }

    // ---- 缩略图 ----
    if (host === 'thumb') {
      // 矢量缩略图的缓存键必须带「算法版本 + 主题」：SVG 是透明底且线条颜色
      // 随主题变，键不变的话切主题或改算法后还会命中旧的（白底/暗线）缩略图。
      const vecTag = scanner.CAD.has(ext)
        ? `|dwg8|${isDarkTheme() ? 'd' : 'l'}`
        : '';
      const key = cache.key(abs, st.mtimeMs, st.size, 'thumb:' + w + vecTag);
      const cached = await cache.get(key);
      if (cached) return new Response(cached.data, { headers: { 'content-type': cached.meta.mime } });

      let out = null;

      // PNG / JPEG 用 nativeImage 缩到目标宽度，体积最小
      if (/\.(png|jpe?g|jfif)$/i.test(abs)) {
        try {
          const img = nativeImage.createFromPath(abs);
          if (!img.isEmpty()) {
            const sz = img.getSize();
            const r = sz.width >= sz.height
              ? { width: Math.max(16, Math.min(w, sz.width)) }
              : { height: Math.max(16, Math.min(w, sz.height)) };
            out = { data: img.resize(r, 'good').toJPEG(80), mime: 'image/jpeg' };
          }
        } catch {}
      }

      // 其余格式：挖内嵌预览
      if (!out && isPreview) {
        const pv = await getPreview(abs, true);
        if (pv) {
          if (pv.mime === 'image/jpeg') {
            try {
              const img = nativeImage.createFromBuffer(pv.buffer);
              if (!img.isEmpty()) {
                const sz = img.getSize();
                const r = sz.width >= sz.height
                  ? { width: Math.max(16, Math.min(w, sz.width)) }
                  : { height: Math.max(16, Math.min(w, sz.height)) };
                out = { data: img.resize(r, 'good').toJPEG(80), mime: 'image/jpeg' };
              }
            } catch {}
          }
          if (!out) out = { data: pv.buffer, mime: pv.mime };
        }
      }

      // CAD 矢量：已生成 SVG 时直接当缩略图（Chromium 可渲染 SVG）。
      // 注意：已经挖到内嵌预览的 CDR/CMX 优先用预览 —— 打开时也是预览，
      // 两者保持一致（libcdr 转出的 SVG 与 CorelDRAW 官方预览长相不同）。
      if (!out && scanner.CAD.has(ext)) {
        const hit = (await cdr.peek(abs, 0)) || (await dwg.peek(abs, isDarkTheme()));
        if (!hit) {
          // 还没转过 → 顺手起一个后台转换，渲染层稍后重试就能拿到（灰块才有救）
          if (cdr.supported(ext) && cdr.toolConfigured()) cdr.warmup(abs, () => {});
          else if (dwg.supported(ext)) dwg.warmup(abs, () => {}, { dark: isDarkTheme() });
          return new Response('no vector', { status: 404 });
        }
        let data = await fsp.readFile(hit.svgPath, 'utf8');
        if (ext === '.dwg' || ext === '.dxf') {
          // DWG 线宽按「内在尺寸/缩略图宽」放大,否则缩到 200px 时细线不可见
          try {
            const vbw = parseFloat((data.match(/viewBox="[-\d.]+ [-\d.]+ ([\d.]+) /) || [])[1] || '0');
            if (vbw > 0 && w > 0) {
              const sw = (1.3 * vbw / w).toFixed(2);
              data = data.replace(/stroke-width="[^"]+"/g, `stroke-width="${sw}"`);
            }
          } catch { /* 线宽调整失败就按原样给 */ }
        }
        return new Response(data, { headers: { 'content-type': 'image/svg+xml' } });
      }

      // 兜底：原图交给 Chromium 自己缩（GIF/WebP/BMP/AVIF/SVG）
      if (!out) {
        try {
          out = { data: await fsp.readFile(abs), mime: scanner.mimeOf(abs) };
        } catch {
          return new Response('', { status: 404 });
        }
      }

      if (out.data.length < 4 * 1024 * 1024) await cache.set(key, out.data, { mime: out.mime });
      return new Response(out.data, { headers: { 'content-type': out.mime } });
    }

    // ---- 全尺寸 ----
    if (isNative) {
      return net.fetch(pathToFileURL(abs).toString());
    }
    if (scanner.CAD.has(ext)) {
      // CAD 矢量：全尺寸同样给 SVG（对比屏 / 放大镜走这里）。
      // 有内嵌预览的 CDR/CMX 保持用预览，与看图屏显示的内容一致。
      if (isPreview) {
        const pv = await getPreview(abs, false).catch(() => null);
        if (pv) {
          return new Response(pv.buffer, {
            headers: { 'content-type': pv.mime, 'x-rat-preview': '1' },
          });
        }
      }
      const hit = (await cdr.peek(abs, 0)) || (await dwg.peek(abs, isDarkTheme()));
      if (!hit) return new Response('no vector', { status: 404 });
      const data = await fsp.readFile(hit.svgPath);
      return new Response(data, { headers: { 'content-type': 'image/svg+xml' } });
    }
    if (isPreview) {
      const pv = await getPreview(abs, false);
      if (!pv) return new Response('no embedded preview', { status: 415 });
      return new Response(pv.buffer, {
        headers: { 'content-type': pv.mime, 'x-rat-preview': '1' },
      });
    }
    return new Response('unsupported', { status: 415 });
  });
}

// ---------------------------------------------------------------- 窗口
function logDiag(tag, msg) {
  try {
    const dir = path.join(app.getPath('userData'), 'logs');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(
      path.join(dir, 'rat.log'),
      new Date().toISOString() + ' [' + tag + '] ' + String(msg).slice(0, 900) + '\n'
    );
  } catch {}
}

// RAT_WINDOW_PROBE=<路径>：启动后等一小会儿，把「窗口真的出来了吗 / 渲染进程
// 真的画出东西了吗」写成 JSON 再退出。用于打包后的端到端验证。
async function windowProbe() {
  const outPath = process.env.RAT_WINDOW_PROBE;
  const out = { ok: true };
  const step = (name, val) => {
    out[name] = val;
    if (val && val.ok === false) out.ok = false;
  };
  try {
    await new Promise((r) => setTimeout(r, 1800));
    step('window', {
      ok: win.isVisible(),
      visible: win.isVisible(),
      bounds: win.getBounds(),
      title: win.getTitle(),
    });
    const evalDom = () => win.webContents.executeJavaScript(`(() => {
      const q = (s) => document.querySelector(s);
      const screens = [...document.querySelectorAll('.screen')];
      const visible = screens.filter((s) => getComputedStyle(s).display !== 'none');
      const app = q('#app');
      const img = q('#stage');
      const src = img ? img.getAttribute('src') : null;
      return {
        bridge: typeof window.rat === 'object' && !!window.rat,
        screenCount: screens.length,
        visibleScreens: visible.map((s) => s.id),
        activeScreen: app ? app.getAttribute('data-screen') : null,
        theme: document.documentElement.getAttribute('data-theme'),
        bodyText: (document.body.innerText || '').replace(/\\s+/g, ' ').trim().length,
        toolbarBtns: document.querySelectorAll('.toolbar button').length,
        tabs: document.querySelectorAll('.tab').length,
        thumbs: document.querySelectorAll('.grid-item, .thumb, .strip-item').length,
        iconUses: document.querySelectorAll('svg use').length,
        stage: img ? {
          scheme: src ? src.split(':')[0] : null,
          vector: !!src && src.includes('svg'),
          loaded: !!img.complete && img.naturalWidth > 0,
          w: img.naturalWidth,
          h: img.naturalHeight,
          transform: getComputedStyle(img).transform,
        } : null,
        titleText: (q('#tbTitle') || q('.tb-title') || {}).textContent || null,
        emptyText: (q('#emptyHint') || {}).textContent || null,
        perfPill: (q('#perfPill') || {}).textContent || null,
        previewPill: (q('#previewPill') || {}).textContent || null,
        appVersion: (window.rat && window.rat.appVersion) || null,
        aboutText: (q('#aboutInfo') || {}).textContent || null,
        errors: (window.__ratErrors || []).length,
        errorList: (window.__ratErrors || []).slice(0, 5),
      };
    })()`);

    let dom = await evalDom();
    // 打开大文件/矢量文件时渲染链路要跑一会儿（扫描目录 → 内嵌预览 → 矢量转换），
    // 所以没加载完就继续轮询，最多再等 10 秒。
    for (let i = 0; i < 14 && !(dom.stage && dom.stage.loaded); i++) {
      await new Promise((r) => setTimeout(r, 700));
      dom = await evalDom();
    }
    step('dom', dom);
    step('version', {
      ok: dom.appVersion === app.getVersion(),
      bridge: dom.appVersion,
      expect: app.getVersion(),
      display: 'V' + (dom.appVersion || '?'),
    });
    step('probe-text', {
      ok: dom.bodyText > 200,
      chars: dom.bodyText,
    });
    step('only-one-screen-visible', {
      ok: dom.visibleScreens.length <= 1,
      visible: dom.visibleScreens,
    });
    // 深挖用：直接从渲染层调一次 image:open，看 IPC 到底返回什么/耗多久
    if (process.env.RAT_PROBE_FILE) {
      try {
        const t0 = Date.now();
        const r = await win.webContents.executeJavaScript(
          `window.rat.openImage(${JSON.stringify(process.env.RAT_PROBE_FILE)})`);
        out.ipcOpen = { ms: Date.now() - t0, r };
      } catch (e) {
        out.ipcOpen = { error: String(e).slice(0, 300) };
      }
      // 真实画布验证：走渲染层正常流程（app:openPath → select → renderMeta → requestVector → #stage）
      try {
        // 渲染层 console 抓进来（requestVector 的报错只有 console 能看到）
        const logs = [];
        win.webContents.on('console-message', (_e, level, message) => {
          logs.push({ level, message: String(message).slice(0, 300) });
        });
        win.webContents.send('app:openPath', process.env.RAT_PROBE_FILE);
        const stageWait = parseInt(process.env.RAT_PROBE_STAGE_WAIT || '3000', 10);
        const readStage = () => win.webContents.executeJavaScript(`(() => {
          const img = document.querySelector('#stage');
          const hint = document.querySelector('#emptyHint');
          return {
            src: (img.getAttribute('src') || '').slice(0, 40),
            complete: img.complete,
            nw: img.naturalWidth,
            nh: img.naturalHeight,
            hintShown: hint.style.display !== 'none',
            hintText: (hint.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 60),
            perf: (document.querySelector('#perfPill') || {}).innerText || '',
            zoom: (document.querySelector('#zoomVal') || {}).textContent || '',
            layoutW: img.clientWidth,
            layoutH: img.clientHeight,
            rect: (() => { const r = img.getBoundingClientRect(); return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)]; })(),
            style: (() => { const s = getComputedStyle(img); return { opacity: s.opacity, visibility: s.visibility, display: s.display, zIndex: s.zIndex, filter: s.filter.slice(0, 60) }; })(),
            topAtCenter: (() => {
              const vp = document.querySelector('#viewport');
              const r = (vp || img).getBoundingClientRect();
              const el = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
              return el ? (el.id || el.tagName) + '<' + (el.parentElement && (el.parentElement.id || el.parentElement.tagName)) + '>' : 'null';
            })(),
            vpRect: (() => { const vp = document.querySelector('#viewport'); if (!vp) return null; const r = vp.getBoundingClientRect(); return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)]; })(),
          };
        })()`);
        await new Promise((r) => setTimeout(r, Math.min(3000, stageWait)));
        const st3 = await readStage();
        if (stageWait > 3000) {
          await new Promise((r) => setTimeout(r, stageWait - 3000));
        }
        const st = stageWait > 3000 ? await readStage() : st3;
        out.stage = { ...st, at3s: st3, logs: logs.slice(0, 20) };
        if (!st.complete || !st.nw) out.ok = false;
      } catch (e) {
        out.stage = { error: String(e).slice(0, 300) };
        out.ok = false;
      }
      // 矢量链路端到端：cdrRender → ratfile://svg 真的能加载成 <img> 吗？
      // （复现「一直停在矢量渲染中」：img.onerror 渲染层没挂，协议层失败会静默）
      if (/\.(cdr|cmx|dwg|dxf)$/i.test(process.env.RAT_PROBE_FILE)) {
        try {
          const vr = await win.webContents.executeJavaScript(`(async () => {
            const r = await window.rat.cdrRender(${JSON.stringify(process.env.RAT_PROBE_FILE)});
            if (!r || !r.ok) return { render: r || null };
            return await new Promise((res) => {
              const img = new Image();
              const t0 = Date.now();
              img.onload = () => {
                const base = { load: 'ok', ms: Date.now() - t0, w: img.naturalWidth, h: img.naturalHeight, url: r.url.slice(0, 80) };
                try {
                  const cv = document.createElement('canvas');
                  cv.width = Math.min(800, img.naturalWidth);
                  cv.height = Math.max(1, Math.round(cv.width * img.naturalHeight / img.naturalWidth));
                  const ctx = cv.getContext('2d');
                  ctx.drawImage(img, 0, 0, cv.width, cv.height);
                  const d = ctx.getImageData(0, 0, cv.width, cv.height).data;
                  let ink = 0;
                  for (let i = 3; i < d.length; i += 4) if (d[i] > 8) ink++;
                  base.inkRatio = +(ink / (d.length / 4)).toFixed(5);
                  base.canvas = cv.width + 'x' + cv.height;
                } catch (e) { base.inkErr = String(e).slice(0, 120); }
                res(base);
              };
              img.onerror = () => res({ load: 'error', ms: Date.now() - t0, url: r.url.slice(0, 80) });
              setTimeout(() => res({ load: 'timeout', ms: Date.now() - t0, url: r.url.slice(0, 80) }), 15000);
              img.src = r.url;
            });
          })()`);
          out.vector = vr;
          if (vr && vr.load !== 'ok') out.ok = false;
        } catch (e) {
          out.vector = { error: String(e).slice(0, 300) };
          out.ok = false;
        }
      }
      // RAT_PROBE_SCREEN=<screen>:切到指定屏再截图(对比缩略图 vs 打开后的画面)
      if (process.env.RAT_PROBE_SCREEN) {
        const ok = await win.webContents.executeJavaScript(
          `(() => { const b = document.querySelector('.rail-btn[data-go="${process.env.RAT_PROBE_SCREEN}"]'); if (b) { b.click(); return true; } return false; })()`
        ).catch(() => false);
        out.screenSwitch = ok;
        await new Promise((r) => setTimeout(r, parseInt(process.env.RAT_PROBE_SCREEN_WAIT || '7000', 10)));
      }
      // RAT_PROBE_SHOT=<png 路径>:把真实画布截下来(人眼看不到就靠它排障)
      if (process.env.RAT_PROBE_SHOT) {
        try {
          await new Promise((r) => setTimeout(r, 1200));   // 等缩放/贴合动画落定
          const img = await win.webContents.capturePage();
          await fsp.writeFile(process.env.RAT_PROBE_SHOT, img.toPNG());
          out.shot = { ok: true, path: process.env.RAT_PROBE_SHOT };
        } catch (e) {
          out.shot = { error: String(e).slice(0, 200) };
        }
      }
    }
  } catch (e) {
    out.ok = false;
    out.error = String((e && e.stack) || e);
  }
  try {
    await fsp.writeFile(outPath, JSON.stringify(out, null, 2));
  } catch (e) {
    out.writeError = String(e);
  }
  console.log('WINDOW_PROBE_JSON=' + JSON.stringify(out));
  process.reallyExit(out.ok ? 0 : 1);
}

function createWindow() {
  const theme = nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
  win = new BrowserWindow({
    width: 1200,
    height: 780,
    minWidth: 940,
    minHeight: 620,
    show: false,
    frame: false,
    backgroundColor: themeBackground(theme),
    title: 'Rat看图王',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      // 把程序版本号（不带头缀 V）同步注入渲染层，避免前端写死版本
      additionalArguments: ['--rat-app-version=' + app.getVersion()],
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
      backgroundThrottling: false,
    },
  });

  win.setMenuBarVisibility(false);
  win.once('ready-to-show', () => win.show());

  const pushWinState = () => {
    if (win && !win.isDestroyed()) {
      win.webContents.send('win:state', { maximized: win.isMaximized() });
    }
  };
  win.on('maximize', pushWinState);
  win.on('unmaximize', pushWinState);

  // 渲染进程出错时留痕，方便交付后远程排障（GUI 子系统看不到控制台输出）
  win.webContents.on('did-fail-load', (_e, code, desc, url) =>
    logDiag('did-fail-load', code + ' ' + desc + ' ' + url)
  );
  win.webContents.on('render-process-gone', (_e, d) =>
    logDiag('render-gone', JSON.stringify(d))
  );
  win.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    if (level >= 2) logDiag('console', message + ' @' + sourceId + ':' + line);
  });

  win.webContents.on('did-finish-load', () => {
    pushWinState();
    if (pendingPath) {
      win.webContents.send('app:openPath', pendingPath);
      pendingPath = null;
    }
    if (process.env.RAT_WINDOW_PROBE) windowProbe();
  });

  // 拦截外链与意外导航
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  return win;
}

// ---------------------------------------------------------------- IPC
function registerIpc() {
  // 窗口控制
  ipcMain.handle('win:minimize', () => win?.minimize());
  ipcMain.handle('win:toggleMax', () => {
    if (!win) return;
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
  });
  ipcMain.handle('win:close', () => win?.close());

  // 文件对话框
  ipcMain.handle('dialog:openFiles', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: '打开图片',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: '图片', extensions: [...scanner.ALL].map((e) => e.slice(1)) },
        { name: '所有文件', extensions: ['*'] },
      ],
    });
    if (r.canceled) return [];
    const list = r.filePaths.filter((p) => scanner.isSupported(p) || true);
    return list.map(allow);
  });

  ipcMain.handle('dialog:openFolder', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: '打开文件夹',
      properties: ['openDirectory'],
    });
    if (r.canceled) return null;
    return r.filePaths[0];
  });

  ipcMain.handle('dialog:saveAs', async (_e, suggested, filters) => {
    const r = await dialog.showSaveDialog(win, {
      title: '另存为',
      defaultPath: suggested || 'output.jpg',
      filters: filters || [
        { name: 'JPEG', extensions: ['jpg', 'jpeg'] },
        { name: 'PNG', extensions: ['png'] },
        { name: 'WebP', extensions: ['webp'] },
      ],
    });
    if (r.canceled || !r.filePath) return null;
    return r.filePath;
  });

  // 目录扫描
  ipcMain.handle('fs:scanFolder', async (_e, dir) => {
    if (!dir) return { dir: null, files: [] };
    try {
      const files = await scanner.scanFolder(dir);
      files.forEach((f) => allow(f.path));
      return { dir, files };
    } catch (e) {
      return { dir, files: [], error: String(e.message || e) };
    }
  });

  // 打开一张图：返回元信息 + 该用哪种方式显示
  ipcMain.handle('image:open', async (_e, p) => {
    if (!p) return { ok: false, reason: 'no-path' };
    const abs = allow(p);
    let st;
    try {
      st = await fsp.stat(abs);
    } catch {
      return { ok: false, reason: 'not-found' };
    }
    const ext = path.extname(abs).toLowerCase();
    const name = path.basename(abs);
    const base = {
      path: abs,
      name,
      ext,
      dir: path.dirname(abs),
      size: st.size,
      mtime: st.mtimeMs,
      format: ext.replace('.', '').toUpperCase(),
      width: 0,
      height: 0,
    };

    if (scanner.NATIVE.has(ext)) {
      const head = await exifReader.readExif(abs);
      return {
        ok: true,
        kind: 'native',
        ...base,
        width: head?.width || 0,
        height: head?.height || 0,
      };
    }

    const isCad = scanner.CAD.has(ext);
    if (scanner.PREVIEW.has(ext) || isCad) {
      const isCdr = cdr.supported(ext) && cdr.toolConfigured();
      const isDwg = isCad && dwg.supported(ext);
      // 共用的矢量预热（CDR=外部进程 / DWG=进程内 WASM），完成后推给渲染层热替换
      const vectorNotify = (tag) => (err, r) => {
        if (err) {
          logDiag(tag, `矢量渲染失败 ${abs}: ${err.message || err}`);
          return;
        }
        if (r && win && !win.isDestroyed()) {
          win.webContents.send('cdr:vector', {
            path: abs,
            url: 'ratfile://svg?p=' + encodeURIComponent(abs) + '&t=' + Date.now(),
            pages: r.pages || 1,
            width: r.width,
            height: r.height,
          });
        }
      };
      if (isCdr) cdr.warmup(abs, vectorNotify('cdr'));
      if (isDwg) dwg.warmup(abs, vectorNotify('dwg'), { dark: isDarkTheme() });

      if (isCad) {
        // DWG/DXF 没有位图预览可挖 —— 直接等矢量 SVG（解析毫秒级）
        return { ok: true, kind: 'vector', ...base, width: 0, height: 0 };
      }

      const pv = await getPreview(abs, false).catch(() => null);
      if (!pv) {
        if (isCdr) {
          // 没有内嵌预览也没关系 —— 矢量通道就是为这种文件准备的
          return { ok: true, kind: 'vector', ...base, width: 0, height: 0 };
        }
        return {
          ok: false,
          reason: 'needs-plugin',
          ...base,
          message: '该格式需要解码插件（本版未内置），且文件里没有可用的内嵌预览。',
        };
      }
      return {
        ok: true,
        kind: 'preview',
        previewSource: pv.source,
        ...base,
        width: pv.width,
        height: pv.height,
        size: pv.buffer.length,
        originalSize: st.size,
      };
    }

    return {
      ok: false,
      reason: 'unsupported',
      ...base,
      message: '本版暂不支持该格式。',
    };
  });

  // CDR/CMX/DWG/DXF 矢量渲染：返回缓存或等待转换完成（渲染层切回页签时主动拉取）
  ipcMain.handle('cdr:render', async (_e, p) => {
    if (!p) return { ok: false, reason: 'no-path' };
    const abs = allow(p);
    if (!cdr.supported(abs) && !dwg.supported(abs)) return { ok: false, reason: 'unsupported' };
    try {
      if (dwg.supported(abs)) {
        const r = await dwg.render(abs, { dark: isDarkTheme() });
        return {
          ok: true,
          pages: 1,
          width: r.width,
          height: r.height,
          cached: r.cached,
          format: r.format,
          url: 'ratfile://svg?p=' + encodeURIComponent(abs) + '&t=' + Date.now(),
        };
      }
      if (!cdr.toolConfigured()) return { ok: false, reason: 'no-tool' };
      const r = await cdr.render(abs, 0);
      return {
        ok: true,
        pages: r.pages,
        width: r.width,
        height: r.height,
        cached: r.cached,
        url: 'ratfile://svg?p=' + encodeURIComponent(abs) + '&t=' + Date.now(),
      };
    } catch (err) {
      return { ok: false, reason: String((err && err.message) || err).slice(0, 160) };
    }
  });

  // EXIF
  ipcMain.handle('exif:read', async (_e, p) => {
    if (!p) return null;
    try {
      return await exifReader.readExif(allow(p));
    } catch {
      return null;
    }
  });

  // 取原始字节：渲染层做直方图 / 裁剪 / 批量转出要用 canvas，
  // 而自定义协议属于跨源，直接 <img src="ratfile://..."> 会让 canvas 被 taint，
  // 所以这里走 IPC 拿字节，渲染层再转成同源的 blob: URL。
  ipcMain.handle('image:bytes', async (_e, p) => {
    if (!p) return { ok: false, reason: 'no-path' };
    const abs = allow(p);
    const ext = path.extname(abs).toLowerCase();
    try {
      if (scanner.PREVIEW.has(ext)) {
        const pv = await getPreview(abs, false);
        if (!pv) return { ok: false, reason: 'needs-plugin' };
        return { ok: true, mime: pv.mime, data: new Uint8Array(pv.buffer).buffer };
      }
      if (scanner.CAD.has(ext)) {
        // CDR 的矢量缓存在 cdr-svg、DWG/DXF 的在 dwg-svg，两处都试
        const hit = (await cdr.peek(abs, 0)) || (await dwg.peek(abs, isDarkTheme()));
        if (!hit) return { ok: false, reason: 'vector-pending' };
        const buf = await fsp.readFile(hit.svgPath);
        return { ok: true, mime: 'image/svg+xml', data: new Uint8Array(buf).buffer };
      }
      const buf = await fsp.readFile(abs);
      return { ok: true, mime: scanner.mimeOf(abs), data: new Uint8Array(buf).buffer };
    } catch (e) {
      return { ok: false, reason: String(e.message || e) };
    }
  });

  // 写文件（裁剪 / 批量转出）
  ipcMain.handle('file:write', async (_e, target, data) => {
    try {
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
      await fsp.mkdir(path.dirname(target), { recursive: true });
      await fsp.writeFile(target, buf);
      allow(target);
      return { ok: true, bytes: buf.length };
    } catch (e) {
      return { ok: false, error: String(e.message || e) };
    }
  });

  // 删除走回收站（设计文档里的安全阀）
  ipcMain.handle('file:trash', async (_e, p) => {
    try {
      await shell.trashItem(allow(p));
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String(e.message || e) };
    }
  });

  ipcMain.handle('shell:reveal', (_e, p) => {
    if (p) shell.showItemInFolder(path.resolve(p));
    return { ok: true };
  });

  ipcMain.handle('shell:revealExe', () => {
    shell.showItemInFolder(process.execPath);
    return { ok: true };
  });

  ipcMain.handle('shell:openExternal', async (_e, url) => {
    if (!/^(https?:|ms-settings:)/.test(url)) return { ok: false };
    await shell.openExternal(url);
    return { ok: true };
  });

  // 主题
  ipcMain.handle('theme:set', (_e, mode) => {
    const m = ['light', 'dark', 'system'].includes(mode) ? mode : 'light';
    nativeTheme.themeSource = m;
    writeSettings({ theme: m });
    if (win && !win.isDestroyed()) {
      win.setBackgroundColor(themeBackground(nativeTheme.shouldUseDarkColors ? 'dark' : 'light'));
    }
    return { ok: true, theme: m, dark: nativeTheme.shouldUseDarkColors };
  });

  ipcMain.handle('theme:get', () => {
    const s = readSettings();
    return {
      mode: s.theme || 'light',
      dark: nativeTheme.shouldUseDarkColors,
    };
  });

  // 文件关联
  ipcMain.handle('assoc:register', async () => {
    try {
      return await assoc.register();
    } catch (e) {
      return { ok: false, error: String(e.message || e) };
    }
  });

  ipcMain.handle('assoc:unregister', async () => {
    try {
      return await assoc.unregister();
    } catch (e) {
      return { ok: false, error: String(e.message || e) };
    }
  });

  ipcMain.handle('assoc:status', async () => ({
    registered: await assoc.isRegistered(),
    exe: assoc.exePath(),
    exeName: path.basename(process.execPath),
    extensions: assoc.EXTENSIONS,
  }));

  // Windows 不允许静默改默认程序，只能把用户送到设置页
  ipcMain.handle('assoc:openSettings', async () => {
    const attempts = [
      'ms-settings:defaultapps?registeredAppUser=' + encodeURIComponent(assoc.KEY_NAME),
      'ms-settings:defaultapps',
    ];
    for (const url of attempts) {
      try {
        await shell.openExternal(url);
        return { ok: true, url };
      } catch {}
    }
    return { ok: false };
  });

  // 启动时带进来的文件路径
  ipcMain.handle('app:pendingPath', () => {
    const p = pendingPath;
    pendingPath = null;
    return p;
  });
}

// ---------------------------------------------------------------- 冒烟自检
async function smokeTest() {
  const os = require('node:os');
  const zlib = require('node:zlib');
  const out = { steps: [], ok: true };
  const step = (name, val) => {
    out.steps.push({ name, ...val });
    if (val && val.ok === false) out.ok = false;
  };

  // 1) 模块加载
  step('modules', {
    ok: typeof scanner.scanFolder === 'function' && typeof exifReader.readExif === 'function' &&
        typeof previewer.extractPreview === 'function' && typeof assoc.register === 'function',
  });

  const tmp = path.join(os.tmpdir(), 'rat-smoke-' + Date.now());
  await fsp.mkdir(tmp, { recursive: true });

  // 2) 手搓一张真 PNG（4x4 RGBA）
  const W = 4;
  const H = 4;
  const raw = Buffer.alloc(H * (1 + W * 4));
  for (let y = 0; y < H; y++) {
    const row = y * (1 + W * 4);
    raw[row] = 0;
    for (let x = 0; x < W; x++) {
      const o = row + 1 + x * 4;
      raw[o] = (x * 60) & 255;
      raw[o + 1] = (y * 60) & 255;
      raw[o + 2] = 200;
      raw[o + 3] = 255;
    }
  }
  const crc = (buf, seed) => {
    if (typeof zlib.crc32 === 'function') return zlib.crc32(buf, seed);
    let c = seed === undefined ? 0xffffffff : seed;
    for (const b of buf) {
      c ^= b;
      for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, crcBuf]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  const pngPath = path.join(tmp, 'sample.png');
  await fsp.writeFile(pngPath, png);
  step('make-png', { ok: png.length > 60, bytes: png.length });

  // 3) PNG 头部解析
  const dim = exifReader.readDimensions(png);
  step('read-dimensions', { ok: dim.width === W && dim.height === H, ...dim });

  // 4) 造一个「假 CDR」：前面塞垃圾，中间塞真 JPEG，后面再塞垃圾
  const pngImg = nativeImage.createFromBuffer(png);
  const jpeg = pngImg.isEmpty() ? null : pngImg.resize({ width: 320 }).toJPEG(85);
  step('make-jpeg', { ok: !!jpeg && jpeg.length > 200, bytes: jpeg ? jpeg.length : 0 });

  let cdrPath = null;
  if (jpeg) {
    const junk1 = Buffer.alloc(4096, 0x11);
    const junk2 = Buffer.alloc(2048, 0x22);
    const fake = Buffer.concat([Buffer.from('RIFF'), junk1, jpeg, junk2]);
    cdrPath = path.join(tmp, 'fake.cdr');
    await fsp.writeFile(cdrPath, fake);

    const pv = await previewer.extractPreview(cdrPath, { maxBytes: 8 * 1024 * 1024 });
    step('extract-embedded-preview', {
      ok: !!pv && pv.mime === 'image/jpeg' && pv.buffer.equals(jpeg),
      found: !!pv,
      mime: pv?.mime || null,
      source: pv?.source || null,
      width: pv?.width || 0,
      height: pv?.height || 0,
    });
  }

  // 5) 目录扫描（txt 应被忽略）
  await fsp.writeFile(path.join(tmp, 'notes.txt'), 'ignore me');
  const files = await scanner.scanFolder(tmp);
  step('scan-folder', {
    ok: files.length === 2 && files.every((f) => f.name !== 'notes.txt'),
    count: files.length,
    names: files.map((f) => f.name),
    kinds: files.map((f) => f.kind),
  });

  // 6) EXIF 空值容错
  const ex = await exifReader.readExif(pngPath);
  step('read-exif', { ok: !!ex && ex.width === W, width: ex?.width || 0, format: ex?.format || null });

  // 7) 文件关联状态（只读查询，不写注册表）
  const registered = await assoc.isRegistered();
  step('assoc-status', { ok: true, registered, exe: path.basename(process.execPath) });

  // 8) 协议处理器注册
  handleProtocol();
  step('protocol-handler', { ok: true });

  await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});

  // Electron 在 Windows 属 GUI 子系统，console.log 不会回到父控制台，
  // 所以结果必须落盘，由外部脚本读取。
  const outPath = process.env.RAT_SMOKE_OUT
    || path.join(os.tmpdir(), 'rat-smoke-result.json');
  try {
    await fsp.writeFile(outPath, JSON.stringify(out, null, 2));
  } catch {}

  console.log('SMOKE_RESULT_JSON=' + JSON.stringify(out));
  return out;
}

// ---------------------------------------------------------------- 启动
const TRACE_FILE = (process.env.RAT_SMOKE_OUT || 'rat-smoke.json') + '.trace';
function trace(m) {
  if (!isSmoke) return;
  try {
    fs.appendFileSync(TRACE_FILE, Date.now() + ' ' + m + '\n');
  } catch {}
}

async function main() {
  trace('A 进入 main');
  await app.whenReady();
  trace('B whenReady 已解析, isSmoke=' + isSmoke);

  if (isSmoke) {
    let code = 1;
    try {
      const r = await smokeTest();
      code = r.ok ? 0 : 1;
      trace('C smokeTest 返回 code=' + code);
    } catch (e) {
      trace('C smokeTest 抛错 ' + String(e.message || e));
      const payload = { ok: false, error: String(e.stack || e) };
      try {
        await fsp.writeFile(
          process.env.RAT_SMOKE_OUT || path.join(require('node:os').tmpdir(), 'rat-smoke-result.json'),
          JSON.stringify(payload, null, 2)
        );
      } catch {}
      console.log('SMOKE_RESULT_JSON=' + JSON.stringify(payload));
    }
    // 说明：Electron 主进程里 process.exit() 会被接管（只收尾、不终止），
    // app.exit(code) 能退出但要等 Chromium 回收（实测 ~4 秒），
    // process.reallyExit(code) 是 Node 的原生出口：立即终止且保留退出码。
    // 再挂一个定时强杀兜底，免得在异常环境里卡住不退。
    trace('D 退出 code=' + code);
    setTimeout(() => {
      trace('E 定时兜底强杀');
      try {
        process.kill(process.pid, 'SIGKILL');
      } catch {}
    }, 1500);
    process.reallyExit(code);

    trace('F reallyExit 未生效，立即强杀');
    try {
      process.kill(process.pid, 'SIGKILL');
    } catch {
      try {
        process.abort();
      } catch {}
    }
    return;
  }

  cache = new DiskCache(path.join(app.getPath('userData'), 'thumb-cache'));
  await cache.init();

  // CDR 矢量渲染工具：打包后放 resources/bin，开发态放项目 vendor/cdr2svg
  const cdrExe = app.isPackaged
    ? path.join(process.resourcesPath, 'bin', 'cdr2svg.exe')
    : path.join(app.getAppPath(), 'vendor', 'cdr2svg', 'cdr2svg.exe');
  cdr.init({
    exe: cdrExe,
    cacheDir: path.join(app.getPath('userData'), 'cdr-svg'),
  });
  logDiag('cdr', `tool=${cdrExe} exists=${fs.existsSync(cdrExe)} appPath=${app.getAppPath()}`);

  // DWG/DXF 矢量渲染（LibreDWG WASM）：打包后放 resources/libredwg，开发态放 vendor/
  const dwgWasm = app.isPackaged
    ? path.join(process.resourcesPath, 'libredwg', 'wasm')
    : path.join(app.getAppPath(), 'vendor', 'libredwg-web', 'wasm');
  dwg.init({
    wasmDir: dwgWasm,
    cacheDir: path.join(app.getPath('userData'), 'dwg-svg'),
  });
  logDiag('dwg', `wasm=${dwgWasm} exists=${fs.existsSync(path.join(dwgWasm, 'libredwg-web.wasm'))}`);

  // 启动时把用户偏好主题恢复上（默认白天）
  const s = readSettings();
  nativeTheme.themeSource = s.theme === 'dark' ? 'dark' : s.theme === 'system' ? 'system' : 'light';

  pendingPath = pathFromArgv(process.argv);
  if (pendingPath) allow(pendingPath);

  handleProtocol();
  registerIpc();
  createWindow();

  nativeTheme.on('updated', () => {
    if (win && !win.isDestroyed()) {
      win.webContents.send('system:theme', { dark: nativeTheme.shouldUseDarkColors });
    }
  });

  // 自动注册成候选看图程序（幂等，只写 HKCU）。
  // 触发条件：首次运行 / exe 位置变了（升级、换目录）/ 关联清单版本升级
  // （新增扩展名时让老用户自动补上）。
  if (!s.assocRegistered || s.assocExe !== assoc.exePath() || s.assocExtVer !== assoc.EXT_VER) {
    try {
      await assoc.register();
      writeSettings({ assocRegistered: true, assocExe: assoc.exePath(), assocExtVer: assoc.EXT_VER });
    } catch {}
  }

  // 关掉所有窗口就退出。加一个看门狗：app.quit() 在个别环境下会卡住
  // （实测无窗口时 app.quit() 甚至永不返回；有窗口时 process.reallyExit 也可能阻塞），
  // 所以先走优雅退出，宽限期一到就用 TerminateProcess 强杀 —— 这个路径实测必定生效。
  // 「点了关闭却留个进程在后台」是很糟糕的体验。
  app.on('window-all-closed', () => {
    app.quit();
    setTimeout(() => {
      try {
        cache?.flush?.();
      } catch {}
      try {
        process.kill(process.pid, 'SIGKILL');
      } catch {
        try {
          process.reallyExit(0);
        } catch {}
      }
    }, 1200);
  });
}

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

main().catch((e) => {
  console.error('FATAL', e);
  app.exit(1);
});
