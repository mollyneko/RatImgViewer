@echo off
chcp 65001 >nul
rem ===================================================================
rem  一键复查 C++ 工具链（MSVC / CMake / node-gyp）
rem  四层验收：文件 → 真编译 → CMake 全链路 → N-API 原生模块
rem ===================================================================
setlocal

set "ROOT=%~dp0.."
set "PYTHON=%USERPROFILE%\.workbuddy\binaries\python\versions\3.13.12\python.exe"
set "GYP=%ROOT%\node_modules\node-gyp\bin\node-gyp.js"
set "GYP_PY=%USERPROFILE%\.workbuddy\binaries\python\envs\default\Scripts\python.exe"

if not exist "%PYTHON%" (
  echo [!] 找不到内置 Python: %PYTHON%
  echo     改用系统 python。
  set "PYTHON=python"
)

echo 正在验收 C++ 工具链，大约需要 30 秒...
echo.
"%PYTHON%" "%~dp0verify-cpp-toolchain.py" --gyp "%GYP%" --gyp-python "%GYP_PY%"
set "RC=%ERRORLEVEL%"
echo.
if "%RC%"=="0" (
  echo [OK] 工具链可用。
) else (
  echo [FAIL] 有问题，看上面的提示。退出码 %RC%
)
pause
exit /b %RC%
