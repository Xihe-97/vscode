@echo off
REM Build script for VS Code source with Nailed agent
REM Usage: build-vscode-dev.bat

setlocal

set TOOLING_ROOT=D:\Programming\vscode plus\_tooling
set PORTABLE_NODE=%TOOLING_ROOT%\node-v22.22.0-win-x64
set VSCODE_ROOT=V:\
set PATH=%PORTABLE_NODE%;%PORTABLE_NODE%\node_modules\npm\bin;%PATH%

echo Building VS Code with Nailed agent...
echo.

cd /d %VSCODE_ROOT%

echo [1/5] Running transpile-client...
call npm run transpile-client
if errorlevel 1 (
    echo ERROR: transpile-client failed!
    exit /b 1
)

echo.
echo [2/5] Running gulp compile...
call npm run gulp compile
if errorlevel 1 (
    echo ERROR: gulp compile failed!
    exit /b 1
)

echo.
echo [3/5] Generating NLS bundle...
call node build\next\index.ts bundle --nls --out out
if errorlevel 1 (
    echo ERROR: NLS bundle failed!
    exit /b 1
)

echo.
echo [4/5] Rebuilding native modules...
echo    - windows-foreground-love
cd node_modules\windows-foreground-love
call npx node-gyp rebuild
cd ..\..
if errorlevel 1 (
    echo WARNING: windows-foreground-love rebuild failed
)

echo.
echo [5/5] Launching VS Code...
start "" ".build\electron\Code - OSS.exe" .

echo.
echo Build and launch completed!
