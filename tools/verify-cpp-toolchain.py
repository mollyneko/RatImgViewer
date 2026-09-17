#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""MSVC / CMake / node-gyp 工具链四层验收（Windows）。

层的含义（逐层加严，前一层过了不代表后一层能过）：
  1. 文件层      —— cl.exe / vcvars64.bat / Windows SDK 在不在
  2. 编译器层    —— 真的编译 + 运行一个 C++17 程序
  3. 构建系统层  —— CMake 配置 + 构建「静态库 + 可执行文件」并运行
  4. Node 层     —— node-gyp 编一个 N-API 模块，require 进来调用

用法：
    python verify_cpp_toolchain.py
    python verify_cpp_toolchain.py --vs-path "D:\\Microsoft Visual Studio\\2022\\BuildTools"
    python verify_cpp_toolchain.py --node "C:\\path\\to\\node.exe" --gyp "C:\\proj\\node_modules\\node-gyp\\bin\\node-gyp.js"
    python verify_cpp_toolchain.py --gyp-python "C:\\venv\\Scripts\\python.exe"

若某层失败，脚本会把失败原因和对应修法提示一起打出来。
"""
import argparse
import glob
import os
import subprocess
import sys
import tempfile

SDK_ROOT = r'C:\Program Files (x86)\Windows Kits\10'
SKIP_DIRS = {'arm64', 'x86'}   # SDK bin 下只要 x64


# ----------------------------------------------------------------- 环境探测
def find_vs(explicit=None):
    if explicit and os.path.exists(explicit):
        return explicit
    pats = [
        r'C:\Program Files\Microsoft Visual Studio\2022\*\VC\Auxiliary\Build\vcvars64.bat',
        r'D:\Microsoft Visual Studio\2022\*\VC\Auxiliary\Build\vcvars64.bat',
        r'C:\Program Files (x86)\Microsoft Visual Studio\2022\*\VC\Auxiliary\Build\vcvars64.bat',
    ]
    for p in pats:
        hits = glob.glob(p)
        if hits:
            # <vs>\VC\Auxiliary\Build\vcvars64.bat  →  上退 4 层才回到 <vs>
            return os.path.dirname(os.path.dirname(os.path.dirname(
                os.path.dirname(hits[0]))))
    return None


def sdk_versions():
    """返回真正装了内容的 SDK 版本（历史残留会给空目录，必须过滤）。"""
    out = {}
    for kind in ('Include', 'Lib', 'bin'):
        base = os.path.join(SDK_ROOT, kind)
        vers = []
        if os.path.isdir(base):
            for v in sorted(os.listdir(base)):
                p = os.path.join(base, v)
                if os.path.isdir(p) and os.listdir(p):
                    # bin 下再确认有 x64 且非空
                    if kind == 'bin' and not os.path.isdir(os.path.join(p, 'x64')):
                        continue
                    vers.append(v)
        out[kind] = vers[-1] if vers else None
    return out


def sdk_env(ver):
    if not ver:
        return None
    inc = [os.path.join(SDK_ROOT, 'Include', ver, s) for s in ('ucrt', 'shared', 'um', 'winrt')]
    lib = [os.path.join(SDK_ROOT, 'Lib', ver, s, 'x64') for s in ('ucrt', 'um')]
    bins = [os.path.join(SDK_ROOT, 'bin', ver, 'x64')]
    return ([p for p in inc if os.path.isdir(p)],
            [p for p in lib if os.path.isdir(p)],
            [p for p in bins if os.path.isdir(p)])


def cmake_dirs(vs_path):
    cands = [os.path.join(vs_path, r'Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin'),
             os.path.join(vs_path, r'Common7\IDE\CommonExtensions\Microsoft\CMake\Ninja')]
    return [d for d in cands if os.path.isdir(d)]


def find_node(explicit=None):
    if explicit:
        return explicit
    cands = [os.environ.get('NODE_EXE'),
             r'C:\Users\93171\.workbuddy\binaries\node\versions\22.22.2-3\node.exe',
             r'C:\Program Files\nodejs\node.exe']
    for c in cands:
        if c and os.path.exists(c):
            return c
    return None


# ----------------------------------------------------------------- 执行
def say(*a):
    print(*a, flush=True)


def run_bat(body, workdir, vcvars, cmake_dirs_, sdk_env_, timeout=600):
    """把 body 写成 .bat 执行。

    ⚠️ 必须走 .bat，不要用 subprocess 列表形式调 cmd /c ——
    Python 的 list2cmdline 会把内部引号转义成 \\"，cmd.exe 不认，
    结果是退出码 1 且捕获不到任何输出。
    """
    bat = os.path.join(workdir, '_step.bat')
    lines = ['@echo off', 'chcp 65001 >nul']
    for d in cmake_dirs_:
        lines.append('set "PATH=%s;%%PATH%%"' % d)
    lines.append('call "%s"' % vcvars)
    if sdk_env_:
        inc, lib, bins = sdk_env_
        if inc:
            lines.append('set "INCLUDE=%s;%%INCLUDE%%"' % ';'.join(inc))
        if lib:
            lines.append('set "LIB=%s;%%LIB%%"' % ';'.join(lib))
        if bins:
            lines.append('set "PATH=%s;%%PATH%%"' % ';'.join(bins))
    lines.append(body)
    with open(bat, 'w', encoding='utf-8', newline='\r\n') as f:
        f.write('\n'.join(lines) + '\n')
    r = subprocess.run(['cmd', '/c', bat], cwd=workdir, capture_output=True,
                       text=True, encoding='utf-8', errors='replace', timeout=timeout)
    return r.returncode, ((r.stdout or '') + (r.stderr or ''))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--vs-path', default=None)
    ap.add_argument('--node', default=None)
    ap.add_argument('--gyp', default=None)
    ap.add_argument('--gyp-python', default=None,
                    help='带 setuptools 的 python（Python 3.12+ 需要它提供 distutils）')
    a = ap.parse_args()

    say('=' * 70)
    say('0) 探测')
    vs = find_vs(a.vs_path)
    say('   VS 实例    : %s' % (vs or '✗ 找不到（先用 install_vs_buildtools.py 安装）'))
    if not vs:
        return 2
    vcvars = os.path.join(vs, r'VC\Auxiliary\Build\vcvars64.bat')
    if not os.path.exists(vcvars):
        say('   ✗ 缺 vcvars64.bat')
        return 2

    sv = sdk_versions()
    say('   SDK Include: %s' % sv['Include'])
    say('   SDK Lib    : %s' % sv['Lib'])
    say('   SDK bin    : %s' % sv['bin'])
    sdkenv = sdk_env(sv['Include'])

    node = find_node(a.node)
    say('   node       : %s' % (node or '✗ 未找到（第 4 层会跳过）'))

    tmp = tempfile.mkdtemp(prefix='toolchain-verify-')
    say('   临时目录   : %s' % tmp)

    # ---------------- 1) 文件层 ----------------
    say('\n' + '=' * 70)
    say('1) 文件层')
    cl = glob.glob(os.path.join(vs, 'VC', 'Tools', 'MSVC', '*', 'bin', 'Hostx64', 'x64', 'cl.exe'))
    say('   cl.exe        : %s' % (cl[0] if cl else '✗'))
    say('   rc.exe        : %s' % (
        os.path.exists(os.path.join(SDK_ROOT, 'bin', sv['bin'] or '', 'x64', 'rc.exe'))))
    say('   CMake         : %s' % (os.path.exists(
        os.path.join(cmake_dirs(vs)[0], 'cmake.exe')) if cmake_dirs(vs) else '✗'))

    # ---------------- 2) 编译器层 ----------------
    say('\n' + '=' * 70)
    say('2) 编译器层 —— 真编一个 C++17 程序并运行')
    with open(os.path.join(tmp, 'hello.cpp'), 'w', encoding='utf-8') as f:
        f.write('#include <cstdio>\n#include <vector>\n#include <string>\n'
                'int main(){ std::vector<std::string> v{"MSVC","works"};\n'
                '  std::printf("%s %s | _MSC_VER=%d | C++%ld\\n",\n'
                '    v[0].c_str(), v[1].c_str(), _MSC_VER, _MSVC_LANG/100);\n'
                '  return 0; }\n')
    rc, out = run_bat('cl /nologo /std:c++17 /EHsc hello.cpp /Fe:hello.exe\n'
                      'echo CL_EXIT=%ERRORLEVEL%\n'
                      'hello.exe\necho RUN_EXIT=%ERRORLEVEL%\n',
                      tmp, vcvars, cmake_dirs(vs), sdkenv)
    for ln in out.strip().splitlines():
        s = ln.strip()
        if s and not s.startswith('*') and 'Developer Command Prompt' not in s \
                and 'Copyright' not in s and 'vcvarsall' not in s:
            say('   | ' + s[:170])
    ok2 = 'CL_EXIT=0' in out and 'RUN_EXIT=0' in out
    say('   %s 编译器层' % ('✓' if ok2 else '✗'))
    if not ok2:
        if 'stdio.h' in out or 'C1083' in out:
            say('   → 提示：这是「MSVC 有了但 Windows SDK 没接上」。')
            say('     多半是 vcvars 靠 reg.exe 查 SDK 却查不到（被安全策略拦截 / SDK 没装）。')
        if 'rc.exe' in out or 'RC Pass' in out:
            say('   → 提示：缺 rc.exe，把 SDK 的 bin\\<ver>\\x64 加进 PATH。')
        return 1

    # ---------------- 3) 构建系统层 ----------------
    say('\n' + '=' * 70)
    say('3) 构建系统层 —— CMake 静态库 + 可执行文件')
    proj = os.path.join(tmp, 'cmproj')
    os.makedirs(proj, exist_ok=True)
    with open(os.path.join(proj, 'CMakeLists.txt'), 'w', encoding='utf-8') as f:
        f.write('cmake_minimum_required(VERSION 3.20)\nproject(ratcheck CXX)\n'
                'set(CMAKE_CXX_STANDARD 17)\n'
                'add_library(ratcheck STATIC src.cpp)\n'
                'add_executable(ratrun main.cpp)\n'
                'target_link_libraries(ratrun PRIVATE ratcheck)\n')
    with open(os.path.join(proj, 'src.cpp'), 'w', encoding='utf-8') as f:
        f.write('int rat_add(int a, int b){ return a + b; }\n')
    with open(os.path.join(proj, 'main.cpp'), 'w', encoding='utf-8') as f:
        f.write('#include <cstdio>\nint rat_add(int,int);\n'
                'int main(){ std::printf("cmake+msvc = %d\\n", rat_add(20,22)); return 0; }\n')
    # 优先 Ninja：避开 VS 生成器的注册表查询
    gen = '-G Ninja' if glob.glob(os.path.join(vs, r'Common7\IDE\CommonExtensions\Microsoft\CMake\Ninja\ninja.exe')) else \
          '-G "Visual Studio 17 2022" -A x64'
    build_cmd = 'cmake --build cmproj\\build' if 'Ninja' in gen else 'cmake --build cmproj\\build --config Release'
    exe_path = 'cmproj\\build\\ratrun.exe' if 'Ninja' in gen else 'cmproj\\build\\Release\\ratrun.exe'
    rc, out = run_bat('cmake --version\n'
                      'cmake -S cmproj -B cmproj\\build %s -DCMAKE_BUILD_TYPE=Release\n'
                      'echo CONF_EXIT=%%ERRORLEVEL%%\n%s\necho BUILD_EXIT=%%ERRORLEVEL%%\n'
                      '%s\necho RUN_EXIT=%%ERRORLEVEL%%\n'
                      % (gen, build_cmd, exe_path),
                      tmp, vcvars, cmake_dirs(vs), sdkenv)
    for ln in out.strip().splitlines():
        s = ln.strip()
        if s and 'Developer Command Prompt' not in s and 'Copyright' not in s \
                and 'vcvarsall' not in s and not s.startswith('*'):
            say('   | ' + s[:170])
    ok3 = 'BUILD_EXIT=0' in out and 'cmake+msvc = 42' in out
    say('   %s CMake 全链路' % ('✓' if ok3 else '✗'))

    # ---------------- 4) Node 层 ----------------
    say('\n' + '=' * 70)
    say('4) Node 层 —— N-API 原生模块')
    ok4 = False
    gyp = a.gyp
    if not gyp:
        for c in glob.glob(os.path.join(os.getcwd(), 'node_modules', 'node-gyp', 'bin', 'node-gyp.js')):
            gyp = c
            break
    if not node or not gyp or not os.path.exists(gyp):
        say('   ⊘ 跳过（没找到 node 或 node-gyp: node=%s gyp=%s）' % (node, gyp))
    else:
        addon = os.path.join(tmp, 'addon')
        os.makedirs(addon, exist_ok=True)
        with open(os.path.join(addon, 'binding.gyp'), 'w', encoding='utf-8') as f:
            f.write('{"targets":[{"target_name":"rataddon","sources":["addon.cc"]}]}\n')
        with open(os.path.join(addon, 'addon.cc'), 'w', encoding='utf-8') as f:
            f.write('#include <node_api.h>\n'
                    'static napi_value Add(napi_env e, napi_callback_info i){\n'
                    '  size_t n=2; napi_value a[2]; napi_get_cb_info(e,i,&n,a,nullptr,nullptr);\n'
                    '  int32_t x=0,y=0; napi_get_value_int32(e,a[0],&x); napi_get_value_int32(e,a[1],&y);\n'
                    '  napi_value o; napi_create_int32(e,x+y,&o); return o; }\n'
                    'static napi_value Init(napi_env e, napi_value x){\n'
                    '  napi_value f; napi_create_function(e,"add",NAPI_AUTO_LENGTH,Add,nullptr,&f);\n'
                    '  napi_set_named_property(e,x,"add",f); return x; }\n'
                    'NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)\n')
        env = dict(os.environ)
        env['npm_config_disturl'] = 'https://npmmirror.com/mirrors/node/'
        env['npm_config_msvs_version'] = '2022'
        env.pop('ELECTRON_RUN_AS_NODE', None)
        if a.gyp_python and os.path.exists(a.gyp_python):
            env['npm_config_python'] = a.gyp_python
            say('   npm_config_python = %s' % a.gyp_python)
        if sdkenv:
            inc, lib, bins = sdkenv
            if inc:
                env['INCLUDE'] = ';'.join(inc) + (';' + env['INCLUDE'] if env.get('INCLUDE') else '')
            if lib:
                env['LIB'] = ';'.join(lib) + (';' + env['LIB'] if env.get('LIB') else '')
            env['PATH'] = ';'.join(bins) + ';' + env.get('PATH', '')
            env['WindowsSdkDir'] = SDK_ROOT
            env['WindowsSDKVersion'] = sv['Include'] + '\\'
        say('   运行 node-gyp rebuild ...')
        try:
            r = subprocess.run([node, gyp, 'rebuild'], cwd=addon, env=env,
                               capture_output=True, text=True, encoding='utf-8',
                               errors='replace', timeout=900)
            lines = ((r.stdout or '') + (r.stderr or '')).strip().splitlines()
            for ln in lines[-12:]:
                say('     | ' + ln.strip()[:170])
            nf = os.path.join(addon, 'build', 'Release', 'rataddon.node')
            if os.path.exists(nf):
                say('   ✓ 产出 %s (%.0f KB)' % (nf, os.path.getsize(nf) / 1024))
                r2 = subprocess.run(
                    [node, '-e',
                     "const m=require('./build/Release/rataddon.node');"
                     "const v=m.add(20,22);console.log('add(20,22) =',v);"
                     "process.exit(v===42?0:1)"],
                    cwd=addon, capture_output=True, text=True, timeout=120, env=env)
                say('   ▶ %s' % ((r2.stdout or r2.stderr).strip() or '(无输出)'))
                ok4 = r2.returncode == 0
            else:
                say('   ✗ 没有产出 rataddon.node')
                if 'distutils' in '\n'.join(lines):
                    say('   → 提示：Python 3.12+ 移除了 distutils。装 setuptools 并用 '
                        '--gyp-python 指向该 venv 的 python。')
        except subprocess.TimeoutExpired:
            say('   ✗ node-gyp 超时')

    say('\n' + '=' * 70)
    say('汇总: 编译器 %s | CMake %s | N-API %s'
        % ('✓' if ok2 else '✗', '✓' if ok3 else '✗',
           '✓' if ok4 else ('⊘' if not (node and gyp) else '✗')))
    say('临时工程目录: %s' % tmp)
    return 0 if (ok2 and ok3) else 1


if __name__ == '__main__':
    sys.exit(main())
