# -*- coding: utf-8 -*-
"""把 Rat看图王 推到 GitHub 并发版（幂等可重跑）。

做三件事：
  1. 确保本地是 git 仓库、工作区已提交、origin 指向目标仓库，然后推送 main
  2. 确保 <tag> 对应的 Release 存在（没有就建）
  3. 把 dist/ 下的 exe 与 SHA256SUMS.txt 作为 Release assets 上传

凭据只从环境变量或 --token 读取，不写进任何配置文件，也不落盘。

用法：
    set GH_TOKEN=ghp_xxx
    python tools/publish-github.py                 # 推送 + 建 Release + 传 assets
    python tools/publish-github.py --skip-push     # 只发 Release
    python tools/publish-github.py --dry-run       # 只打印将要做什么
"""
import argparse
import hashlib
import json
import os
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_REPO = 'mollyneko/RatImgViewer'
API = 'https://api.github.com'
UPLOADS = 'https://uploads.github.com'


# ------------------------------------------------------------------ 基础工具
def log(msg):
    print(msg, flush=True)


def run_git(args, env=None):
    r = subprocess.run(['git'] + args, cwd=ROOT, capture_output=True, text=True, env=env)
    return r.returncode, (r.stdout or ''), (r.stderr or '')


def api(method, url, token, data=None, content_type='application/json', raw=False):
    headers = {
        'Authorization': 'Bearer ' + token,
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'RatImgViewer-publish',
    }
    body = None
    if data is not None:
        headers['Content-Type'] = content_type
        body = data if isinstance(data, (bytes, bytearray)) else json.dumps(data).encode('utf-8')
        headers['Content-Length'] = str(len(body))
    req = urllib.request.Request(url, data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=300) as resp:
            payload = resp.read()
            return resp.status, (payload if raw else json.loads(payload.decode('utf-8') or 'null'))
    except urllib.error.HTTPError as e:
        detail = e.read().decode('utf-8', 'replace')
        return e.code, {'error': detail}
    except Exception as e:                                    # 网络异常
        return 0, {'error': str(e)}


def sha256_of(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b''):
            h.update(chunk)
    return h.hexdigest()


# ------------------------------------------------------------------ 1. 推送
def ensure_repo():
    if os.path.isdir(os.path.join(ROOT, '.git')):
        return True
    rc, _, err = run_git(['init', '-b', 'main'])
    log('  git init -b main -> rc=%d %s' % (rc, err.strip()[:120]))
    return rc == 0


def has_identity():
    rc, out, _ = run_git(['config', 'user.email'])
    return rc == 0 and out.strip() != ''


def commit_all(message):
    run_git(['add', '-A'])
    rc, out, _ = run_git(['status', '--porcelain'])
    if rc != 0:
        return False, 'git status 失败'
    if not out.strip():
        log('  工作区干净，无需提交')
        return False, None
    rc, out, err = run_git(['commit', '-m', message])
    if rc != 0:
        return False, err.strip()[:400]
    log('  已提交：%s' % message)
    return True, None


def set_origin(repo):
    url = 'https://github.com/%s.git' % repo
    rc, out, _ = run_git(['remote', 'get-url', 'origin'])
    if rc == 0:
        if out.strip() != url:
            run_git(['remote', 'set-url', 'origin', url])
            log('  origin 已更新为 %s' % url)
        else:
            log('  origin 已是 %s' % url)
    else:
        run_git(['remote', 'add', 'origin', url])
        log('  已添加 origin -> %s' % url)


def push_main(token):
    """用一次性 credential helper 推送，token 不进 argv、不写进 .git/config。"""
    env = dict(os.environ)
    env['GH_TOKEN'] = token
    env['GIT_TERMINAL_PROMPT'] = '0'
    helper = '!f() { echo username=x-access-token; echo password=$GH_TOKEN; }; f'
    arg = '-c' if os.name == 'nt' else '-c'
    rc, out, err = run_git(
        [arg, 'credential.helper=', arg, 'credential.helper=' + helper,
         'push', '-u', 'origin', 'main'],
        env=env,
    )
    # 失败时退化到 URL 带 token 的方式（有些环境 sh 不可用）
    if rc != 0:
        log('  credential helper 方式失败，改用 URL 直推…')
        rc2, out2, err2 = run_git(
            ['push', '-u', 'https://x-access-token:%s@github.com/%s.git' % (token, repo_slug), 'main'],
            env=env,
        )
        out, err, rc = out2, err2, rc2
    return rc, (out + err).strip()


# ------------------------------------------------------------------ 2. Release
def release_body(version):
    base = 'https://github.com/%s/releases/latest/download' % repo_slug
    return (
        '## Rat 看图王 V{v}\n\n'
        'Windows 10 / 11 x64　·　单文件下载，无需安装运行库\n\n'
        '| 文件 | 说明 |\n|---|---|\n'
        '| `RatImageViewer-Setup-V{v}.exe` | 安装版：可选安装目录、创建快捷方式、可注册文件关联 |\n'
        '| `RatImageViewer-Portable-V{v}.exe` | 免安装版：单文件，双击即用，不写注册表 |\n'
        '| `SHA256SUMS.txt` | 校验和，核对方式见下方 |\n\n'
        '### 直链\n\n'
        '- 安装版：{base}/RatImageViewer-Setup-V{v}.exe\n'
        '- 免安装版：{base}/RatImageViewer-Portable-V{v}.exe\n\n'
        '### 本版内容\n\n'
        '- 图片浏览：滚轮缩放 / 适应窗口 / 1:1，多标签，幻灯片，放大镜\n'
        '- 格式：JPG · PNG · WebP · GIF · BMP · ICO · SVG · AVIF · TIFF · PSD/PSB · HEIC · 相机 RAW\n'
        '- **CDR / CMX 矢量渲染**（内置 libcdr，不装 CorelDRAW 也能看）\n'
        '- **DWG / DXF 图纸查看**（内置 LibreDWG，支持图层与文字；DXF 支持 gb18030 / Big5）\n'
        '- 管理（缩略图网格）· 对比（分割线找差异）· 批量转换（JPEG/PNG/WebP）\n'
        '- 非破坏性旋转 / 翻转 / 裁剪，亮度·对比度·饱和度·一键美化\n'
        '- EXIF 信息与 RGB 直方图，删除走系统回收站\n'
        '- 完全离线运行，不发任何网络请求\n\n'
        '### 安装说明\n\n'
        '安装包未做代码签名，首次运行 Windows SmartScreen 会提示「已保护你的电脑」，'
        '点「更多信息」→「仍要运行」即可。\n\n'
        '### 校验下载完整性\n\n'
        '```\n'
        'certutil -hashfile RatImageViewer-Setup-V{v}.exe SHA256\n'
        '```\n'
        '把输出和 `SHA256SUMS.txt` 里对应行对比即可。\n\n'
        '完整说明见 [README](https://github.com/{repo}#readme)。\n'
    ).format(v=version, base=base, repo=repo_slug)


def get_or_create_release(repo, tag, version, token, dry):
    if not token:
        log('  [dry-run] 无凭据，不带 token 查询失败，按「需要新建」处理')
        return None
    status, data = api('GET', '%s/repos/%s/releases/tags/%s' % (API, repo, tag), token)
    if status == 200:
        log('  Release %s 已存在（id=%s）' % (tag, data.get('id')))
        return data
    if status != 404:
        log('  查询 Release 失败：%s %s' % (status, str(data)[:300]))
        return None
    if dry:
        log('  [dry-run] 将创建 Release %s' % tag)
        return None
    payload = {
        'tag_name': tag,
        'target_commitish': 'main',
        'name': 'Rat 看图王 V%s' % version,
        'body': release_body(version),
        'draft': False,
        'prerelease': False,
    }
    status, data = api('POST', '%s/repos/%s/releases' % (API, repo), token, payload)
    if status not in (200, 201):
        log('  创建 Release 失败：%s %s' % (status, str(data)[:400]))
        return None
    log('  已创建 Release %s（id=%s）' % (tag, data.get('id')))
    return data


def upload_assets(repo, release, files, token, dry):
    existing = {a['name']: a for a in (release.get('assets') or [])}
    ok = True
    for path in files:
        name = os.path.basename(path)
        size = os.path.getsize(path)
        if name in existing:
            if existing[name].get('size') == size:
                log('  跳过 %s（已存在且大小一致）' % name)
                continue
            if dry:
                log('  [dry-run] 将替换 %s' % name)
                continue
            api('DELETE', '%s/repos/%s/releases/assets/%s' % (API, repo, existing[name]['id']), token)
            log('  已删除旧 asset %s' % name)
        if dry:
            log('  [dry-run] 将上传 %s（%.1f MB）' % (name, size / 1048576))
            continue
        log('  上传 %s（%.1f MB）…' % (name, size / 1048576))
        with open(path, 'rb') as f:
            blob = f.read()
        url = '%s/repos/%s/releases/%s/assets?name=%s' % (
            UPLOADS, repo, release['id'], urllib.parse.quote(name))
        status, data = api('POST', url, token, blob, 'application/octet-stream')
        if status in (200, 201):
            log('    ✓ %s' % name)
        else:
            ok = False
            log('    ✗ %s -> %s %s' % (name, status, str(data)[:300]))
    return ok


def update_repo_info(repo, token, dry):
    """补上仓库简介与话题标签。已有的简介/话题不覆盖，只做「填空」和并集。"""
    topics = ['image-viewer', 'windows', 'electron', 'cdr', 'coreldraw', 'dwg', 'dxf',
              'cad', 'psd', 'raw', 'viewer', 'photo-viewer']
    payload = {
        'description': '轻量快速的 Windows 看图工具，原生支持 CDR/CMX 矢量与 DWG/DXF 图纸查看',
        'homepage': 'https://github.com/%s/releases/latest' % repo,
        'has_issues': True,
        'has_wiki': False,
    }
    status, cur = api('GET', '%s/repos/%s' % (API, repo), token)
    if status == 200:
        if (cur.get('description') or '').strip():
            log('  仓库已有简介，保留原样：%s' % cur['description'])
            payload.pop('description', None)
        topics = sorted(set(cur.get('topics') or []) | set(topics))
    if dry:
        log('  [dry-run] 将更新：' + '，'.join(list(payload.keys()) + ['topics']))
        return True
    status, data = api('PATCH', '%s/repos/%s' % (API, repo), token, payload)
    if status == 200:
        log('  仓库信息已更新')
    else:
        log('  更新仓库信息失败：%s %s' % (status, str(data)[:300]))
    # topics 必须走专用接口：PATCH /repos 里带 topics 会被静默忽略（返回 200 但不生效）
    status, data = api('PUT', '%s/repos/%s/topics' % (API, repo), token, {'names': topics})
    if status == 200:
        log('  话题标签已更新（%d 个）' % len(topics))
        return True
    log('  更新话题标签失败：%s %s' % (status, str(data)[:300]))
    return False


# ------------------------------------------------------------------ main
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--repo', default=DEFAULT_REPO)
    ap.add_argument('--tag', default='v1.0.0')
    ap.add_argument('--version', default='1.0.0')
    ap.add_argument('--token', default=os.environ.get('GH_TOKEN') or os.environ.get('GITHUB_TOKEN'))
    ap.add_argument('--message', default='chore: 首次提交 V1.0.0')
    ap.add_argument('--skip-push', action='store_true')
    ap.add_argument('--skip-release', action='store_true')
    ap.add_argument('--dry-run', action='store_true')
    args = ap.parse_args()

    global repo_slug
    repo_slug = args.repo

    if not args.token and not args.dry_run:
        log('缺少凭据：请设置环境变量 GH_TOKEN，或传 --token')
        return 2

    if not has_identity() and not args.dry_run:
        log('git 未配置 user.name / user.email，请先执行：')
        log('  git config --global user.name "你的名字"')
        log('  git config --global user.email "你的邮箱"')
        return 2

    # --- 1. 推送
    if not args.skip_push:
        log('[1/3] 提交并推送 main')
        if not ensure_repo():
            return 1
        commit_all(args.message)
        set_origin(args.repo)
        if args.dry_run:
            log('  [dry-run] 将推送 main -> origin')
        else:
            rc, out = push_main(args.token)
            log('  push rc=%d' % rc)
            if out:
                log('  ' + out[:800])
            if rc != 0:
                log('推送失败。常见原因：仓库有远端提交需要先 pull，或 token 缺少 Contents 写权限。')
                return 1
    else:
        log('[1/3] 跳过推送')

    # --- 2 & 3. Release + assets
    dist = os.path.join(ROOT, 'dist')
    want = [
        os.path.join(dist, 'RatImageViewer-Setup-V%s.exe' % args.version),
        os.path.join(dist, 'RatImageViewer-Portable-V%s.exe' % args.version),
    ]
    sums = os.path.join(dist, 'SHA256SUMS.txt')
    files = [p for p in want if os.path.isfile(p)]
    missing = [p for p in want if not os.path.isfile(p)]
    if missing:
        log('缺少产物（会跳过）：' + '，'.join(os.path.basename(p) for p in missing))
    if not files:
        log('dist/ 下没有可上传的 exe，先跑 npm run dist。')
        return 1

    if not args.dry_run:
        lines = ['%s  %s' % (sha256_of(p), os.path.basename(p)) for p in files]
        with open(sums, 'w', encoding='utf-8', newline='\n') as f:
            f.write('\n'.join(lines) + '\n')
        log('已写入 %s' % sums)
    files_all = files + ([sums] if os.path.isfile(sums) else [])

    if args.skip_release:
        log('[2/3] [3/3] 跳过 Release')
        return 0
    log('[2/3] 更新仓库简介与话题标签' if args.token else '[2/3] 无凭据，跳过仓库信息更新')
    if args.token:
        update_repo_info(args.repo, args.token, args.dry_run)

    log('[3/3] 创建/复用 Release %s' % args.tag)
    release = get_or_create_release(args.repo, args.tag, args.version, args.token, args.dry_run)
    if not release:
        if args.dry_run:
            log('[3/3] [dry-run] 将上传：' + '，'.join(os.path.basename(p) for p in files_all))
            return 0
        return 1

    log('[3/3] 上传 assets')
    ok = upload_assets(args.repo, release, files_all, args.token, args.dry_run)

    log('')
    log('完成 → https://github.com/%s/releases/tag/%s' % (args.repo, args.tag))
    log('页面       → https://github.com/%s' % args.repo)
    return 0 if ok else 1


if __name__ == '__main__':
    sys.exit(main())
