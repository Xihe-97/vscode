@echo off
setlocal
cd /d "%~dp0"

set "REPO=%CD%"
set "PORTABLE_NODE=%REPO%\..\_tooling\node-v22.22.0-win-x64"
set "EXE=%REPO%\.build\electron\Code - OSS.exe"

if not exist "%PORTABLE_NODE%\node.exe" (
  echo [ERROR] Portable Node not found:
  echo   %PORTABLE_NODE%
  pause
  exit /b 1
)

if not exist "%EXE%" (
  echo [ERROR] Source Code - OSS executable not found:
  echo   %EXE%
  pause
  exit /b 1
)

for /f "tokens=1,* delims=:=" %%A in ('subst ^| findstr /B /I "V:\:"') do set "HAS_V=1"
if not defined HAS_V subst V: "%REPO%"

set "PATH=%PORTABLE_NODE%;%PORTABLE_NODE%\node_modules\npm\bin;%PATH%"
set "vs2022_install=D:\Microsoft Visual Studio\18\BuildTools"
set "VCINSTALLDIR=D:\Microsoft Visual Studio\18\BuildTools\VC\"
set "VSCMD_VER=17.14.0"
set "WindowsSDKVersion=10.0.26100.0\"
set "ELECTRON_RUN_AS_NODE="
set "VSCODE_SKIP_PRELAUNCH=1"

echo [VSCode Dev] Repairing NLS/build outputs first...
pushd V:\
"%PORTABLE_NODE%\node.exe" build\next\index.ts bundle --nls --out out
if errorlevel 1 (
  echo.
  echo [ERROR] Failed while repairing build outputs.
  popd
  pause
  exit /b 1
)

echo.
echo [VSCode Dev] Starting source Code - OSS...
start "" "%EXE%" .
popd
exit /b 0
