// 纯 Node 冒烟：dwg.js 解析 DXF + DWG → SVG
'use strict';
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const dwg = require('./src/main/dwg.js');

(async () => {
  dwg.init({
    wasmDir: path.join(__dirname, 'vendor', 'libredwg-web', 'wasm'),
    cacheDir: path.join(os.tmpdir(), 'rat-dwg-test'),
  });

  const targets = [
    'D:\\WorkBuddy\\Rat看图王\\.workbuddy\\cadviewer-extract\\sample.dxf',
  ];

  // 找一个真实 dwg
  const dwgs = [
    'D:\\~jdy\\AutoCAD_2020.1.6_x64_Lite\\AutoCAD_2020.1.6_x64_Lite\\x64\\acad\\PF\\Root\\Support\\chroma.dwg',
    'D:\\~jdy\\AutoCAD_2020.1.6_x64_Lite\\AutoCAD_2020.1.6_x64_Lite\\x64\\acad\\PF\\Root\\Express\\brkline.dwg',
  ];
  for (const p of dwgs) if (fs.existsSync(p)) { targets.push(p); break; }

  for (const t of targets) {
    if (!fs.existsSync(t)) { console.log('MISS', t); continue; }
    const t0 = Date.now();
    try {
      const r = await dwg.render(t);
      const sz = fs.statSync(r.svgPath).size;
      console.log(`OK ${path.extname(t)} ${((Date.now() - t0) / 1000).toFixed(1)}s ` +
        `svg=${(sz / 1024).toFixed(0)}KB ${r.width.toFixed(0)}x${r.height.toFixed(0)} ` +
        `entities=${r.entities} layers=${r.layers} cached=${r.cached}`);
      // 二次跑验证缓存
      const r2 = await dwg.render(t);
      console.log('  cached hit:', r2.cached);
    } catch (e) {
      console.log('FAIL', path.basename(t), '->', e.message);
    }
  }
})();
