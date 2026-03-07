@echo off
setlocal
cd /d "%~dp0"

set "REPO=%CD%"
set "PORTABLE_NODE=%REPO%\..\_tooling\node-v22.22.0-win-x64"

if not exist "%PORTABLE_NODE%\node.exe" (
  echo [ERROR] Portable Node not found:
  echo   %PORTABLE_NODE%
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

echo [VSCode Dev] Starting incremental watch...
echo [VSCode Dev] Keep this window open while editing source files.
echo [VSCode Dev] After changes compile, use "Developer: Reload Window" in the source Code - OSS window.
echo.

pushd V:\
"%PORTABLE_NODE%\node.exe" "%PORTABLE_NODE%\node_modules\npm\bin\npm-cli.js" run watch
popd
exit /b %ERRORLEVEL%
