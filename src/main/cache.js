'use strict';

// 缩略图磁盘缓存。对应设计文档里的「磁盘缩略图库」，
// 但本版用「文件 + 元数据」而不是 SQLite —— 少一个原生依赖，符合轻量定位。

const path = require('node:path');
const fsp = require('node:fs/promises');
const crypto = require('node:crypto');

const MAX_ENTRIES_SOFT = 4000;

class DiskCache {
  constructor(dir) {
    this.dir = dir;
    this.enabled = true;
  }

  async init() {
    try {
      await fsp.mkdir(this.dir, { recursive: true });
      const names = await fsp.readdir(this.dir);
      // 目录里条目过多时清理最旧的一半，避免无限增长
      if (names.length > MAX_ENTRIES_SOFT) {
        const files = [];
        for (const n of names) {
          if (n.endsWith('.json')) continue;
          try {
            const st = await fsp.stat(path.join(this.dir, n));
            files.push({ n, t: st.atimeMs });
          } catch {}
        }
        files.sort((a, b) => a.t - b.t);
        for (const f of files.slice(0, Math.floor(files.length / 2))) {
          await fsp.rm(path.join(this.dir, f.n), { force: true }).catch(() => {});
          await fsp.rm(path.join(this.dir, f.n + '.json'), { force: true }).catch(() => {});
        }
      }
    } catch {
      this.enabled = false;
    }
  }

  key(file, mtimeMs, size, tag) {
    return crypto.createHash('sha1')
      .update(`${file}|${Math.round(mtimeMs)}|${size}|${tag}`)
      .digest('hex');
  }

  async get(key) {
    if (!this.enabled) return null;
    try {
      const data = await fsp.readFile(path.join(this.dir, key));
      const meta = JSON.parse(await fsp.readFile(path.join(this.dir, key + '.json'), 'utf8'));
      return { data, meta };
    } catch {
      return null;
    }
  }

  async set(key, data, meta, ttlDays = 60) {
    if (!this.enabled) return;
    if (data.length > 4 * 1024 * 1024) return; // 过大的不缓存
    try {
      await fsp.writeFile(path.join(this.dir, key), data);
      await fsp.writeFile(
        path.join(this.dir, key + '.json'),
        JSON.stringify({ ...meta, t: Date.now(), ttl: ttlDays * 86400000 })
      );
    } catch {
      // 缓存失败不影响功能
    }
  }

  async clear() {
    try {
      await fsp.rm(this.dir, { recursive: true, force: true });
      await fsp.mkdir(this.dir, { recursive: true });
    } catch {}
  }
}

module.exports = { DiskCache };
