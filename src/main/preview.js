'use strict';

// 内嵌预览提取：Chromium 不能渲染 CDR / PSD / RAW / HEIC，
// 但这些格式的文件里几乎都内嵌了一张预览图（JPEG 或 BMP）。
// 本模块把它们挖出来直接显示 —— 这就是设计文档里写的那条降级链路。
//
// 这是「能看图」而不是「能编辑」：拿到的是作者保存文件时写进去的预览，
// 与最终稿可能有差异，UI 上必须如实标注。

const fsp = require('node:fs/promises');

const FULL_SCAN_BYTES = 96 * 1024 * 1024;
const THUMB_SCAN_BYTES = 16 * 1024 * 1024;

// ---------- JPEG ----------

function inspectJpeg(buf, start) {
  let off = start + 2;
  let width = 0;
  let height = 0;
  while (off + 4 <= buf.length) {
    if (buf[off] !== 0xff) {
      off++;
      continue;
    }
    const marker = buf[off + 1];
    if (marker === 0xff) {
      off++;
      continue;
    }
    if (marker === 0xd9) return { end: off + 2, width, height };
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      off += 2;
      continue;
    }
    const len = buf.readUInt16BE(off + 2);
    if (len < 2) return null;

    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (!width && off + 9 <= buf.length) {
        height = buf.readUInt16BE(off + 5);
        width = buf.readUInt16BE(off + 7);
      }
    }

    if (marker === 0xda) {
      // 进入熵编码数据，只按字节找 EOI（处理 FF00 填充）
      let p = off + 2 + len;
      while (p + 1 < buf.length) {
        if (buf[p] !== 0xff) {
          p++;
          continue;
        }
        const b = buf[p + 1];
        if (b === 0xd9) return { end: p + 2, width, height };
        if (b === 0x00 || (b >= 0xd0 && b <= 0xd7)) {
          p += 2;
          continue;
        }
        p += 2;
      }
      return null;
    }
    off += 2 + len;
  }
  return null;
}

// ---------- BMP ----------

function inspectBmp(buf, start) {
  if (start + 54 > buf.length) return null;
  const fileSize = buf.readUInt32LE(start + 2);
  const dataOff = buf.readUInt32LE(start + 10);
  const headerSize = buf.readUInt32LE(start + 14);
  const width = buf.readInt32LE(start + 18);
  const rawHeight = buf.readInt32LE(start + 22);
  const bpp = buf.readUInt16LE(start + 28);
  const height = Math.abs(rawHeight);

  if (headerSize !== 40 && headerSize !== 108 && headerSize !== 124) return null;
  if (width < 32 || width > 30000 || height < 32 || height > 30000) return null;
  if (![1, 4, 8, 16, 24, 32].includes(bpp)) return null;
  if (dataOff < 14 + headerSize || dataOff > start + fileSize) return null;

  const need = 14 + headerSize + Math.ceil((width * bpp) / 8) * height;
  if (need > buf.length - start) return null;
  const end = dataOff + Math.ceil((width * bpp) / 8) * height;
  if (end > buf.length) return null;
  return { end, width, height };
}

// ---------- PSD 缩略图资源（8BIM 1036 / 1033） ----------

function psdThumbnail(buf) {
  try {
    if (buf.toString('latin1', 0, 4) !== '8BPS') return null;
    const colorModeLen = buf.readUInt32BE(26);
    let p = 30 + colorModeLen;
    if (p + 4 > buf.length) return null;
    const resLen = buf.readUInt32BE(p);
    p += 4;
    const resEnd = Math.min(p + resLen, buf.length);

    while (p + 12 <= resEnd) {
      if (buf.toString('latin1', p, p + 4) !== '8BIM') break;
      const id = buf.readUInt16BE(p + 4);
      let q = p + 6;
      const nameLen = buf[q];
      q += 1 + nameLen;
      if ((1 + nameLen) % 2 !== 0) q += 1;
      const size = buf.readUInt32BE(q);
      q += 4;
      const dataStart = q;

      if ((id === 1036 || id === 1033) && dataStart + 28 <= buf.length) {
        const fmt = buf.readUInt32BE(dataStart);
        const w = buf.readUInt32BE(dataStart + 4);
        const h = buf.readUInt32BE(dataStart + 8);
        const payload = dataStart + 28;
        const payloadLen = size - 28;
        if (fmt === 1) {
          const jpeg = inspectJpeg(buf, payload);
          if (jpeg) {
            return { buffer: buf.subarray(payload, jpeg.end), mime: 'image/jpeg', width: w, height: h, source: 'PSD 缩略图资源' };
          }
        } else if (fmt === 0 && payloadLen > 0) {
          // 未压缩 RGB：包一层 BMP 头方便 Chromium 直接显示
          const bmp = rawRgbToBmp(buf.subarray(payload, payload + payloadLen), w, h);
          if (bmp) return { buffer: bmp, mime: 'image/bmp', width: w, height: h, source: 'PSD 缩略图资源' };
        }
      }

      p = dataStart + size;
      if (size % 2 !== 0) p += 1;
    }
  } catch {
    // 结构异常就当没有缩略图
  }
  return null;
}

function rawRgbToBmp(rgb, w, h) {
  const rowBytes = w * 3;
  const pad = (4 - (rowBytes % 4)) % 4;
  const stride = rowBytes + pad;
  const pixelBytes = stride * h;
  if (rgb.length < w * h * 3) return null;
  const out = Buffer.alloc(54 + pixelBytes);
  out.write('BM', 0, 'latin1');
  out.writeUInt32LE(out.length, 2);
  out.writeUInt32LE(54, 10);
  out.writeUInt32LE(40, 14);
  out.writeInt32LE(w, 18);
  out.writeInt32LE(h, 22);
  out.writeUInt16LE(1, 26);
  out.writeUInt16LE(24, 28);
  out.writeUInt32LE(pixelBytes, 34);
  // PSD 缩略图是 RGB 顺序、从上到下；BMP 是 BGR、从下到上
  for (let y = 0; y < h; y++) {
    const srcRow = y * w * 3;
    const dstRow = 54 + (h - 1 - y) * stride;
    for (let x = 0; x < w; x++) {
      out[dstRow + x * 3] = rgb[srcRow + x * 3 + 2];
      out[dstRow + x * 3 + 1] = rgb[srcRow + x * 3 + 1];
      out[dstRow + x * 3 + 2] = rgb[srcRow + x * 3];
    }
  }
  return out;
}

// ---------- 主流程 ----------

/**
 * 从任意二进制里挖出最大的内嵌图片（JPEG / BMP）。
 * 选“最大”是为了跳过 EXIF 里那种 160x120 的小缩略图。
 */
function scanEmbedded(buf, offset = 0) {
  let best = null;
  const consider = (cand) => {
    if (!cand) return;
    if (cand.width < 64 || cand.height < 64) return;
    const area = cand.width * cand.height;
    if (!best || area > best.area) best = { ...cand, area };
  };

  const SOI = Buffer.from([0xff, 0xd8, 0xff]);
  let idx = buf.indexOf(SOI, offset);
  let guard = 0;
  while (idx !== -1 && guard++ < 400) {
    const jpeg = inspectJpeg(buf, idx);
    if (jpeg) {
      consider({ start: idx, end: jpeg.end, width: jpeg.width, height: jpeg.height, mime: 'image/jpeg', source: '内嵌 JPEG 预览' });
      idx = buf.indexOf(SOI, idx + 3);
    } else {
      idx = buf.indexOf(SOI, idx + 3);
    }
  }

  let b = buf.indexOf('BM', Math.max(0, offset - 2) + 2);
  let bguard = 0;
  while (b !== -1 && bguard++ < 200) {
    const bmp = inspectBmp(buf, b);
    if (bmp) consider({ start: b, end: bmp.end, width: bmp.width, height: bmp.height, mime: 'image/bmp', source: '内嵌 BMP 预览' });
    b = buf.indexOf('BM', b + 2);
  }

  if (!best) return null;
  return {
    buffer: buf.subarray(best.start, best.end),
    mime: best.mime,
    width: best.width,
    height: best.height,
    source: best.source,
  };
}

async function extractPreview(file, opts = {}) {
  const maxBytes = opts.maxBytes || FULL_SCAN_BYTES;
  let fh;
  try {
    fh = await fsp.open(file, 'r');
    const size = (await fh.stat()).size;
    const want = Math.min(size, maxBytes);
    if (want < 64) return null;
    const buf = Buffer.alloc(want);
    await fh.read(buf, 0, want, 0);

    // PSD 先走正规的缩略图资源解析，拿到的更干净
    const psd = psdThumbnail(buf);
    if (psd) return psd;

    return scanEmbedded(buf);
  } catch {
    return null;
  } finally {
    if (fh) await fh.close().catch(() => {});
  }
}

module.exports = { extractPreview, scanEmbedded, FULL_SCAN_BYTES, THUMB_SCAN_BYTES };
