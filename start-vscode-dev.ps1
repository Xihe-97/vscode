[CmdletBinding()]
param(
	[string]$DriveLetter = 'V',
	[switch]$NoSubst,
	[switch]$ForcePrelaunch,
	[switch]$UseCodeBat,
	[switch]$Wait,
	[switch]$Repair,
	[switch]$KeepExisting,
	[int]$StartupCheckSeconds = 6,
	[Parameter(ValueFromRemainingArguments = $true)]
	[string[]]$CodeArgs
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$workspaceRoot = Split-Path -Parent $repoRoot
$logDir = Join-Path $repoRoot '.codex-logs'
$null = New-Item -ItemType Directory -Force $logDir
$timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$logFile = Join-Path $logDir "start-vscode-dev-$timestamp.log"
$latestLogFile = Join-Path $logDir 'start-vscode-dev.latest.log'
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($logFile, '', $utf8NoBom)
[System.IO.File]::WriteAllText($latestLogFile, '', $utf8NoBom)

function Write-LogLine {
	param([string]$Message)

	$line = "[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message
	[System.IO.File]::AppendAllText($logFile, $line + [Environment]::NewLine, $utf8NoBom)
	[System.IO.File]::WriteAllText($latestLogFile, [System.IO.File]::ReadAllText($logFile), $utf8NoBom)
	Write-Host $Message
}

function Quote-Arg {
	param([string]$Value)

	if ($null -eq $Value -or $Value -eq '') {
		return '""'
	}

	if ($Value -notmatch '[\s"]') {
		return $Value
	}

	return '"' + ($Value -replace '"', '\"') + '"'
}

function Ensure-SubstDrive {
	param(
		[string]$Letter,
		[string]$TargetPath
	)

	$driveName = $Letter.TrimEnd(':').ToUpperInvariant()
	$targetResolved = (Resolve-Path $TargetPath).Path.TrimEnd('\')
	$substOutput = cmd /c subst
	$prefix = "${driveName}:\: => "
	$mapping = $substOutput | Where-Object { $_.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase) } | Select-Object -First 1

	if ($mapping) {
		$mappedPath = $mapping.Substring($prefix.Length).Trim().TrimEnd('\\')
		if ($mappedPath -ne $targetResolved) {
			throw "盘符 ${driveName}: 已映射到 $mappedPath，不是当前仓库。请改用其他盘符，或先执行 subst ${driveName}: /d。"
		}

		return "${driveName}:\\"
	}

	$existingDrive = Get-PSDrive -Name $driveName -ErrorAction SilentlyContinue
	if ($existingDrive) {
		throw "盘符 ${driveName}: 已被系统占用，且不是 subst 映射。请改用其他盘符。"
	}

	cmd /c "subst ${driveName}: `"$TargetPath`"" | Out-Null
	return "${driveName}:\\"
}

function Get-SourceOssProcesses {
	Get-CimInstance Win32_Process | Where-Object {
		$_.ExecutablePath -eq 'D:\Programming\vscode plus\vscode\.build\electron\Code - OSS.exe' -or
		$_.ExecutablePath -eq 'V:\.build\electron\Code - OSS.exe'
	}
}

function Stop-SourceOssProcesses {
	$targets = @(Get-SourceOssProcesses)
	if ($targets.Count -eq 0) {
		Write-LogLine 'Clean Start   : no existing source Code - OSS processes found'
		return
	}

	Write-LogLine "Clean Start   : stopping $($targets.Count) existing source Code - OSS process(es)"
	foreach ($proc in $targets) {
		try {
			Stop-Process -Id $proc.ProcessId -Force -ErrorAction Stop
		} catch {
			Write-LogLine "Clean Start   : failed to stop PID $($proc.ProcessId): $($_.Exception.Message)"
		}
	}
	Start-Sleep -Seconds 2
}

function Invoke-RepairBuild {
	param(
		[string]$PortableNode,
		[string]$LaunchRoot
	)

	Write-LogLine 'Repair        : running NLS bundle repair (`node build/next/index.ts bundle --nls --out out`)'
	Push-Location $LaunchRoot
	try {
		& "$PortableNode\node.exe" 'build\next\index.ts' 'bundle' '--nls' '--out' 'out'
	} finally {
		Pop-Location
	}
}

function Start-SourceCodeOss {
	param(
		[string]$ElectronExe,
		[string]$CodeBat,
		[string]$LaunchRoot,
		[bool]$WaitMode,
		[bool]$UseCodeBatMode,
		[string[]]$LaunchArgs
	)

	$safeArgs = @($LaunchArgs | Where-Object { $_ -ne $null -and $_ -ne '' })

	if ($UseCodeBatMode -or -not (Test-Path $ElectronExe)) {
		if (-not (Test-Path $CodeBat)) {
			throw "未找到启动脚本：$CodeBat"
		}

		$quotedArgs = ($safeArgs | ForEach-Object { Quote-Arg $_ }) -join ' '
		$commandLine = if ($quotedArgs) { "scripts\\code.bat $quotedArgs" } else { 'scripts\\code.bat' }
		Write-LogLine "Command       : cmd /c $commandLine"

		if ($WaitMode) {
			Push-Location $LaunchRoot
			try {
				cmd /c $commandLine
			} finally {
				Pop-Location
			}
			return $null
		}

		return Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', $commandLine -WorkingDirectory $LaunchRoot -PassThru
	}

	Write-LogLine "Command       : $ElectronExe $($safeArgs -join ' ')"

	if ($WaitMode) {
		Push-Location $LaunchRoot
		try {
			& $ElectronExe @safeArgs
		} finally {
			Pop-Location
		}
		return $null
	}

	return Start-Process -FilePath $ElectronExe -ArgumentList $safeArgs -WorkingDirectory $LaunchRoot -PassThru
}

function Main {
	$toolingRoot = Join-Path $workspaceRoot '_tooling'
	$portableNode = Join-Path $toolingRoot 'node-v22.22.0-win-x64'
	$electronExe = Join-Path $repoRoot '.build\\electron\\Code - OSS.exe'
	$codeBat = Join-Path $repoRoot 'scripts\\code.bat'
	$nlsFile = Join-Path $repoRoot 'out\\nls.messages.json'

	if (-not (Test-Path $portableNode)) {
		throw "未找到便携 Node：$portableNode"
	}

	if (-not $CodeArgs -or $CodeArgs.Count -eq 0) {
		$script:CodeArgs = @('.')
	}

	$launchRoot = if ($NoSubst) { $repoRoot } else { Ensure-SubstDrive -Letter $DriveLetter -TargetPath $repoRoot }

	$env:PATH = "$portableNode;$portableNode\\node_modules\\npm\\bin;$env:PATH"
	$env:vs2022_install = 'D:\Microsoft Visual Studio\18\BuildTools'
	$env:VCINSTALLDIR = 'D:\Microsoft Visual Studio\18\BuildTools\VC\\'
	$env:VSCMD_VER = '17.14.0'
	$env:WindowsSDKVersion = '10.0.26100.0\\'
	$env:npm_config_msvs_version = '2022'
	$env:NODE_ENV = 'development'
	$env:VSCODE_DEV = '1'
	$env:VSCODE_CLI = '1'
	$env:ELECTRON_ENABLE_LOGGING = '1'
	$env:ELECTRON_ENABLE_STACK_DUMPING = '1'

	Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue

	if (-not $ForcePrelaunch -and (Test-Path $electronExe) -and (Test-Path $nlsFile)) {
		$env:VSCODE_SKIP_PRELAUNCH = '1'
	} else {
		Remove-Item Env:VSCODE_SKIP_PRELAUNCH -ErrorAction SilentlyContinue
	}

	Write-LogLine "Repo Root     : $repoRoot"
	Write-LogLine "Launch Root   : $launchRoot"
	Write-LogLine "Portable Node : $portableNode"
	Write-LogLine "Use code.bat  : $UseCodeBat"
	Write-LogLine "Wait Mode     : $Wait"
	Write-LogLine "Repair Mode   : $Repair"
	Write-LogLine "Keep Existing : $KeepExisting"
	Write-LogLine "Args          : $($CodeArgs -join ' ')"
	Write-LogLine "Log File      : $logFile"

	if (-not $KeepExisting) {
		Stop-SourceOssProcesses
	}

	if ($Repair -or -not (Test-Path $nlsFile)) {
		Invoke-RepairBuild -PortableNode $portableNode -LaunchRoot $launchRoot
	}

	if ($Wait) {
		Start-SourceCodeOss -ElectronExe $electronExe -CodeBat $codeBat -LaunchRoot $launchRoot -WaitMode $true -UseCodeBatMode ([bool]$UseCodeBat) -LaunchArgs $CodeArgs | Out-Null
		return
	}

	$beforeCount = @(Get-SourceOssProcesses).Count
	$null = Start-SourceCodeOss -ElectronExe $electronExe -CodeBat $codeBat -LaunchRoot $launchRoot -WaitMode $false -UseCodeBatMode ([bool]$UseCodeBat) -LaunchArgs $CodeArgs
	Start-Sleep -Seconds $StartupCheckSeconds
	$afterCount = @(Get-SourceOssProcesses).Count
	Write-LogLine "Startup Check : before=$beforeCount after=$afterCount"

	if ($afterCount -le $beforeCount) {
		Write-LogLine 'Startup Check : process did not stay alive, attempting one automatic repair and retry'
		Invoke-RepairBuild -PortableNode $portableNode -LaunchRoot $launchRoot
		$null = Start-SourceCodeOss -ElectronExe $electronExe -CodeBat $codeBat -LaunchRoot $launchRoot -WaitMode $false -UseCodeBatMode ([bool]$UseCodeBat) -LaunchArgs $CodeArgs
		Start-Sleep -Seconds $StartupCheckSeconds
		$retryAfterCount = @(Get-SourceOssProcesses).Count
		Write-LogLine "Retry Check   : after=$retryAfterCount"
		if ($retryAfterCount -le $beforeCount) {
			throw "源码版 VS Code 启动后立即退出。已自动执行一次 NLS 修复但仍失败。请查看日志：$latestLogFile，或运行 start-vscode-dev.ps1 -Repair -Wait 查看即时输出。"
		}
	}
}

try {
	Main
} catch {
	$err = $_
	$details = @(
		'启动失败。',
		"Message      : $($err.Exception.Message)",
		"Log File     : $logFile",
		"Latest Log   : $latestLogFile",
		'----- StackTrace -----',
		$err.ScriptStackTrace,
		'----- Exception -----',
		($err | Out-String)
	) -join [Environment]::NewLine

	[System.IO.File]::AppendAllText($logFile, $details + [Environment]::NewLine, $utf8NoBom)
	[System.IO.File]::WriteAllText($latestLogFile, [System.IO.File]::ReadAllText($logFile), $utf8NoBom)
	Write-Host $details -ForegroundColor Red
	exit 1
}
