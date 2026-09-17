'use strict';

// 文件关联与「设为默认看图软件」。
//
// 重要：Windows 8 之后，系统**不允许**任何程序静默把自己设成默认打开方式
// （微软刻意封死了这条路径，防止软件互相抢关联）。
// 正确做法是：
//   1. 把本程序注册成候选（Capabilities + RegisteredApplications + OpenWithProgids）
//      —— 这样它才会出现在「打开方式」和「默认应用」列表里；
//   2. 用 ms-settings: 深链把用户送到系统设置页并选中本程序，由用户点一下确认。
// 下面两条路都实现，installer/UI 只需要调用。

const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const run = promisify(execFile);

const DISPLAY_NAME = 'Rat看图王';   // 只作为「值」出现，显示给人看
const KEY_NAME = 'RatImageViewer';  // 注册表键名一律用 ASCII，避开编码坑
const PROGID = 'RatImageViewer.Image';

// 某些受限环境（例如自动化沙箱）会拦截 reg.exe。设为 1 时本模块整体降级为
// 只报告状态、不碰注册表 —— 便于在沙箱内验证程序能否正常启动。
const REG_DISABLED = process.env.RAT_NO_REG === '1';

const EXTENSIONS = [
  '.jpg', '.jpeg', '.jfif', '.png', '.apng', '.webp', '.gif', '.bmp', '.ico', '.svg', '.avif',
  '.tif', '.tiff', '.cdr', '.cmx', '.psd', '.psb', '.heic', '.heif',
  '.dwg', '.dxf',
  '.cr2', '.cr3', '.crw', '.nef', '.nrw', '.arw', '.srf', '.sr2', '.dng',
  '.orf', '.rw2', '.raf', '.pef', '.srw', '.mrw', '.x3f',
];

// 关联清单版本：EXTENSIONS 变化时 +1，老用户升级后会自动重注册一次
const EXT_VER = 2;

function reg(args) {
  return run('reg.exe', args, { windowsHide: true }).catch((e) => {
    throw new Error('注册表写入失败: ' + (e.stderr || e.message));
  });
}

function exePath() {
  return process.execPath;
}

// 「打开方式」列表里显示的名字 = exe 文件名，所以这里必须和实际 exe 一致
function exeName() {
  return path.basename(process.execPath);
}

async function register() {
  const exe = exePath();
  const name = exeName();
  if (REG_DISABLED) {
    return { ok: false, disabled: true, exe, exeName: name, progId: PROGID, extensions: EXTENSIONS.length };
  }
  const appKey = `HKCU\\Software\\Classes\\Applications\\${name}`;

  // 1) ProgID
  await reg(['add', `HKCU\\Software\\Classes\\${PROGID}`, '/ve', '/t', 'REG_SZ', '/d', `${DISPLAY_NAME} 图片文件`, '/f']);
  await reg(['add', `HKCU\\Software\\Classes\\${PROGID}\\DefaultIcon`, '/ve', '/t', 'REG_SZ', '/d', `"${exe}",0`, '/f']);
  await reg(['add', `HKCU\\Software\\Classes\\${PROGID}\\shell\\open\\command`, '/ve', '/t', 'REG_SZ', '/d', `"${exe}" "%1"`, '/f']);

  // 2) Applications\<exe>：让它出现在「打开方式」菜单
  await reg(['add', appKey, '/ve', '/t', 'REG_SZ', '/d', DISPLAY_NAME, '/f']);
  await reg(['add', appKey, '/v', 'FriendlyAppName', '/t', 'REG_SZ', '/d', DISPLAY_NAME, '/f']);
  await reg(['add', `${appKey}\\DefaultIcon`, '/ve', '/t', 'REG_SZ', '/d', `"${exe}",0`, '/f']);
  await reg(['add', `${appKey}\\shell\\open\\command`, '/ve', '/t', 'REG_SZ', '/d', `"${exe}" "%1"`, '/f']);

  // 3) Capabilities：让它出现在 Win10/11 的「默认应用」页面
  const cap = `HKCU\\Software\\${KEY_NAME}\\Capabilities`;
  await reg(['add', cap, '/v', 'ApplicationName', '/t', 'REG_SZ', '/d', DISPLAY_NAME, '/f']);
  await reg(['add', cap, '/v', 'ApplicationDescription', '/t', 'REG_SZ', '/d', '轻量高性能看图软件，支持 CDR/PSD/RAW 内嵌预览', '/f']);
  await reg(['add', cap, '/v', 'ApplicationIcon', '/t', 'REG_SZ', '/d', `"${exe}",0`, '/f']);
  await reg(['add', `HKCU\\Software\\RegisteredApplications`, '/v', KEY_NAME, '/t', 'REG_SZ', '/d', `Software\\${KEY_NAME}\\Capabilities`, '/f']);

  for (const ext of EXTENSIONS) {
    await reg(['add', `${cap}\\FileAssociations`, '/v', ext, '/t', 'REG_SZ', '/d', PROGID, '/f']);
    await reg(['add', appKey + '\\SupportedTypes', '/v', ext, '/t', 'REG_SZ', '/d', '', '/f']);
    // 「打开方式 → 更多应用」里出现本程序；只写 OpenWithProgids 子键，不动 .jpg 的默认值
    await reg(['add', `HKCU\\Software\\Classes\\${ext}\\OpenWithProgids`, '/v', PROGID, '/t', 'REG_SZ', '/d', '', '/f']);
  }

  return { ok: true, exe, exeName: name, progId: PROGID, extensions: EXTENSIONS.length };
}

async function unregister() {
  if (REG_DISABLED) return { ok: false, disabled: true };
  const name = exeName();
  const del = (key) => reg(['delete', key, '/f']).catch(() => {});
  await del(`HKCU\\Software\\Classes\\Applications\\${name}`);
  await del(`HKCU\\Software\\Classes\\${PROGID}`);
  await del(`HKCU\\Software\\${KEY_NAME}`);
  // RegisteredApplications 下 KEY_NAME 是「值」不是「键」，只能按值删，绝不能整键删
  await run('reg.exe', ['delete', 'HKCU\\Software\\RegisteredApplications', '/v', KEY_NAME, '/f'], { windowsHide: true }).catch(() => {});
  for (const ext of EXTENSIONS) {
    await run('reg.exe', [
      'delete', `HKCU\\Software\\Classes\\${ext}\\OpenWithProgids`, '/v', PROGID, '/f',
    ], { windowsHide: true }).catch(() => {});
  }
  return { ok: true };
}

async function isRegistered() {
  if (REG_DISABLED) return false;
  try {
    const { stdout } = await run('reg.exe', ['query', `HKCU\\Software\\Classes\\${PROGID}`], { windowsHide: true });
    return stdout.includes(PROGID);
  } catch {
    return false;
  }
}

module.exports = {
  register, unregister, isRegistered, EXTENSIONS, PROGID,
  KEY_NAME, DISPLAY_NAME, exePath, EXT_VER,
  // 兼容旧名
  APP_KEY: KEY_NAME,
};
