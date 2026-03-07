@echo off
setlocal
cd /d "%~dp0"

set "TARGET1=%CD%\.build\electron\Code - OSS.exe"
set "TARGET2=V:\.build\electron\Code - OSS.exe"

echo [VSCode Dev] Stopping source Code - OSS processes...
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$targets = @('%TARGET1%', '%TARGET2%'); $processes = Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and ($targets -contains $_.ExecutablePath) }; if (-not $processes) { Write-Host '[VSCode Dev] No source Code - OSS processes found.'; exit 0 }; foreach ($proc in $processes) { try { Stop-Process -Id $proc.ProcessId -Force -ErrorAction Stop; Write-Host ('[VSCode Dev] Stopped PID ' + $proc.ProcessId) } catch { Write-Host ('[VSCode Dev] Failed to stop PID ' + $proc.ProcessId + ': ' + $_.Exception.Message) } }"

exit /b 0