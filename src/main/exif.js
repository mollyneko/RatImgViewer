'use strict';

// 轻量 EXIF / 图片头解析：只读文件前 512 KB，不依赖任何第三方库。
const fsp = require('node:fs/promises');

const HEAD_BYTES = 512 * 1024;

const TAG_MAP = {
  0x010f: 'make',
  0x0110: 'model',
  0x0131: 'software',
  0x0112: 'orientation',
  0x0132: 'dateTime',
  0x9003: 'dateTimeOriginal',
  0x829a: 'exposureTime',
  0x829d: 'fNumber',
  0x8827: 'iso',
  0x920a: 'focalLength',
  0xa002: 'pixelWidth',
  0xa003: 'pixelHeight',
  0xa433: 'lensMake',
  0xa434: 'lensModel',
};

const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8 };

function detectFormat(buf) {
  if (buf.length < 12) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
  if (buf.toString('latin1', 0, 4) === 'GIF8') return 'gif';
  if (buf[0] === 0x42 && buf[1] === 0x4d) return 'bmp';
  if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'CDR6') return 'cdr';
  if (buf.toString('latin1', 0, 4) === '8BPS') return 'psd';
  if (buf.toString('latin1', 0, 2) === 'II' || buf.toString('latin1', 0, 2) === 'MM') return 'tiff';
  if (buf.length > 12 && buf.toString('latin1', 4, 8) === 'ftyp') {
    const brand = buf.toString('latin1', 8, 12);
    if (/^(heic|heix|hevc|hevx|mif1|msf1)$/.test(brand)) return 'heic';
    if (/^(avif|avis)$/.test(brand)) return 'avif';
  }
  return null;
}

// 无 EXIF 时也能拿到尺寸，让网格能立刻显示宽高
function readDimensions(buf) {
  const fmt = detectFormat(buf);
  try {
    if (fmt === 'png') {
      return { format: 'PNG', width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    }
    if (fmt === 'gif') {
      return { format: 'GIF', width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
    }
    if (fmt === 'bmp') {
      return {
        format: 'BMP',
        width: Math.abs(buf.readInt32LE(18)),
        height: Math.abs(buf.readInt32LE(22)),
      };
    }
    if (fmt === 'webp') {
      const chunk = buf.toString('latin1', 12, 16);
      if (chunk === 'VP8 ') {
        return {
          format: 'WebP',
          width: buf.readUInt16LE(26) & 0x3fff,
          height: buf.readUInt16LE(28) & 0x3fff,
        };
      }
      if (chunk === 'VP8L') {
        const b = buf;
        return {
          format: 'WebP',
          width: 1 + (((b[22] & 0x3f) << 8) | b[21]),
          height: 1 + (((b[24] & 0x0f) << 10) | (b[23] << 2) | ((b[22] & 0xc0) >> 6)),
        };
      }
      if (chunk === 'VP8X') {
        const w = 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16));
        const h = 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16));
        return { format: 'WebP', width: w, height: h };
      }
    }
    if (fmt === 'jpeg' || fmt === 'tiff') {
      // JPEG 走 SOF 段；TIFF 交给 EXIF IFD
      const sof = findJpegSOF(buf);
      if (sof) return { format: 'JPEG', width: sof.width, height: sof.height };
    }
  } catch {
    // 头部异常就放弃，交给调用方兜底
  }
  return { format: fmt ? fmt.toUpperCase() : null, width: 0, height: 0 };
}

function findJpegSOF(buf) {
  let off = 2;
  while (off + 4 <= buf.length) {
    if (buf[off] !== 0xff) {
      off++;
      continue;
    }
    const marker = buf[off + 1];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      off += 2;
      continue;
    }
    if (marker === 0xda || marker === 0xd9) return null;
    const len = buf.readUInt16BE(off + 2);
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: buf.readUInt16BE(off + 5), width: buf.readUInt16BE(off + 7) };
    }
    off += 2 + len;
  }
  return null;
}

function exifOffset(buf) {
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let off = 2;
    while (off + 4 <= buf.length) {
      if (buf[off] !== 0xff) {
        off++;
        continue;
      }
      const marker = buf[off + 1];
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        off += 2;
        continue;
      }
      if (marker === 0xda || marker === 0xd9) return -1;
      const len = buf.readUInt16BE(off + 2);
      if (marker === 0xe1 && buf.toString('latin1', off + 4, off + 10) === 'Exif\0\0') {
        return off + 10;
      }
      off += 2 + len;
    }
    return -1;
  }
  const two = buf.toString('latin1', 0, 2);
  if (two === 'II' || two === 'MM') return 0;
  return -1;
}

function parseTiff(buf, base) {
  const little = buf.toString('latin1', base, base + 2) === 'II';
  const u16 = (o) => (little ? buf.readUInt16LE(o) : buf.readUInt16BE(o));
  const u32 = (o) => (little ? buf.readUInt32LE(o) : buf.readUInt32BE(o));
  const i32 = (o) => (little ? buf.readInt32LE(o) : buf.readInt32BE(o));

  if (u16(base + 2) !== 42) return null;

  const result = {};

  function readEntryValue(entry) {
    const type = u16(entry + 2);
    const count = u32(entry + 4);
    const size = TYPE_SIZE[type] || 1;
    const total = size * count;
    const vOff = total > 4 ? base + u32(entry + 8) : entry + 8;
    if (vOff + total > buf.length) return null;

    const out = [];
    for (let i = 0; i < count; i++) {
      const o = vOff + i * size;
      switch (type) {
        case 1: case 7: out.push(buf[o]); break;
        case 2: out.push(buf.toString('latin1', o, o + size)); break;
        case 3: out.push(u16(o)); break;
        case 4: out.push(u32(o)); break;
        case 5: out.push(u32(o) / (u32(o + 4) || 1)); break;
        case 9: out.push(i32(o)); break;
        case 10: out.push(i32(o) / (i32(o + 4) || 1)); break;
        default: out.push(null);
      }
    }
    return out;
  }

  function walk(ifdOffset) {
    if (ifdOffset <= 0 || ifdOffset + 2 > buf.length) return;
    const count = u16(ifdOffset);
    if (count > 512) return;
    for (let i = 0; i < count; i++) {
      const entry = ifdOffset + 2 + i * 12;
      if (entry + 12 > buf.length) return;
      const tag = u16(entry);
      if (tag === 0x8769) {
        const sub = readEntryValue(entry);
        if (sub && sub[0]) walk(base + sub[0]);
        continue;
      }
      const key = TAG_MAP[tag];
      if (!key || result[key] !== undefined) continue;
      const vals = readEntryValue(entry);
      if (!vals || vals.length === 0) continue;
      let v = vals[0];
      if (typeof v === 'string') v = v.replace(/\0.*$/, '').trim();
      if (v !== '' && v !== null && v !== undefined) result[key] = v;
    }
  }

  walk(base + u32(base + 4));
  return result;
}

function prettifyOrientation(n) {
  return {
    1: '正常', 2: '水平镜像', 3: '旋转 180°', 4: '垂直镜像',
    5: '镜像后转 90°', 6: '顺时针 90°', 7: '镜像后转 270°', 8: '逆时针 90°',
  }[n] || '';
}

function prettyExposure(v) {
  if (!v || typeof v !== 'number') return '';
  if (v >= 1) return v.toFixed(1).replace(/\.0$/, '') + ' s';
  return '1/' + Math.round(1 / v) + ' s';
}

async function readExif(file) {
  let fh;
  try {
    fh = await fsp.open(file, 'r');
    const size = (await fh.stat()).size;
    const want = Math.min(size, HEAD_BYTES);
    const buf = Buffer.alloc(want);
    await fh.read(buf, 0, want, 0);

    const dim = readDimensions(buf);
    const off = exifOffset(buf);
    const raw = off >= 0 ? parseTiff(buf, off) : null;

    const exif = {
      format: dim.format,
      width: raw?.pixelWidth || dim.width || 0,
      height: raw?.pixelHeight || dim.height || 0,
      make: raw?.make || '',
      model: raw?.model || '',
      lens: raw?.lensModel || '',
      software: raw?.software || '',
      dateTime: raw?.dateTimeOriginal || raw?.dateTime || '',
      orientation: raw?.orientation || 1,
      orientationText: prettifyOrientation(raw?.orientation || 1),
      exposure: prettyExposure(raw?.exposureTime),
      aperture: typeof raw?.fNumber === 'number' ? 'f/' + raw.fNumber.toFixed(1).replace(/\.0$/, '') : '',
      iso: raw?.iso || '',
      focal: typeof raw?.focalLength === 'number' ? Math.round(raw.focalLength) + ' mm' : '',
    };
    if (exif.width && exif.height) return exif;
    return exif;
  } catch {
    return null;
  } finally {
    if (fh) await fh.close().catch(() => {});
  }
}

module.exports = { readExif, readDimensions, detectFormat, HEAD_BYTES };
