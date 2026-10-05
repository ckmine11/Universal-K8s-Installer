# KubeEZ Gateway Agent installer (Windows)
#
# Installs to %USERPROFILE%\.kubeez-agent, saves the connection settings there
# (config.json) and registers a Scheduled Task "KubeEZ Gateway Agent" that keeps
# the agent running - it comes back after reboots and crashes, no new token needed:
#   run as Administrator -> starts at boot (no login needed)
#   normal user          -> starts when you log in
# Safe to run again: it replaces the running agent - never two copies.
param (
    [Parameter(Mandatory = $true)][string]$Token,
    [Parameter(Mandatory = $true)][string]$AgentId,
    [Parameter(Mandatory = $true)][string]$ServerUrl
)
$ErrorActionPreference = 'Stop'
$TaskName = 'KubeEZ Gateway Agent'
function Say($m, $c = 'Cyan') { Write-Host "[KubeEZ Gateway] $m" -ForegroundColor $c }

$AgentDir = Join-Path $HOME '.kubeez-agent'
New-Item -ItemType Directory -Force -Path $AgentDir | Out-Null
Set-Location $AgentDir

# -- Node.js (system node >= 16, otherwise a portable copy) -------------------
$NodeBin = $null
$sys = Get-Command node -ErrorAction SilentlyContinue
if ($sys) {
    $major = [int]((& $sys.Source -p "process.versions.node.split('.')[0]") 2>$null)
    if ($major -ge 16) { $NodeBin = $sys.Source }
}
if (-not $NodeBin) {
    $NodeBin = Join-Path $AgentDir 'bin\node.exe'
    if (-not (Test-Path $NodeBin)) {
        Say 'Node.js not found - downloading a portable copy...' 'Gray'
        $NodeVer = 'v18.20.2'
        Invoke-WebRequest -Uri "https://nodejs.org/dist/$NodeVer/node-$NodeVer-win-x64.zip" -OutFile 'node.zip' -UseBasicParsing
        Expand-Archive -Path 'node.zip' -DestinationPath '.' -Force
        New-Item -ItemType Directory -Force -Path 'bin' | Out-Null
        Move-Item -Path "node-$NodeVer-win-x64\node.exe" -Destination 'bin\node.exe' -Force
        Remove-Item -Path "node-$NodeVer-win-x64", 'node.zip' -Recurse -Force
    }
}

# -- Stop any earlier copy (re-install / upgrade) -----------------------------
Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine -like '*.kubeez-agent*' -and $_.ProcessId -ne $PID } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 1

# -- Agent + settings ---------------------------------------------------------
$HttpUrl = $ServerUrl -replace '^ws', 'http'
Invoke-WebRequest -Uri "$HttpUrl/agent-bundle.js" -OutFile 'agent-bundle.js' -UseBasicParsing
# The bundle is CommonJS - pin it so a parent package.json cannot turn it into an ES module
Set-Content -Path (Join-Path $AgentDir 'package.json') -Value '{"type":"commonjs"}' -Encoding ascii
@{ token = $Token; agentId = $AgentId; server = $ServerUrl } | ConvertTo-Json -Compress |
    Set-Content -Path (Join-Path $AgentDir 'config.json') -Encoding ascii

# Keeps the agent running: restarts it whenever it exits (except 78 = removed in KubeEZ)
$Runner = @"
Set-Location '$AgentDir'
while (`$true) {
    & '$NodeBin' agent-bundle.js --config config.json *>> agent.log
    if (`$LASTEXITCODE -eq 78) { break }
    Start-Sleep -Seconds 5
}
"@
Set-Content -Path (Join-Path $AgentDir 'run-agent.ps1') -Value $Runner -Encoding ascii

# -- Scheduled Task -----------------------------------------------------------
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
$user = "$env:USERDOMAIN\$env:USERNAME"
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$AgentDir\run-agent.ps1`""
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
    -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew
if ($isAdmin) {
    $trigger = New-ScheduledTaskTrigger -AtStartup
    $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType S4U -RunLevel Limited
    $when = 'at boot (no login needed)'
} else {
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
    $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
    $when = 'when you log in (run as Administrator to start at boot)'
}
$mode = 'task'
try {
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
    Start-ScheduledTask -TaskName $TaskName
} catch {
    # No Task Scheduler access: start now and add a per-user Run key for logins
    Say "Could not create the Scheduled Task ($($_.Exception.Message)) - using a login entry instead." 'Yellow'
    $cmd = "powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$AgentDir\run-agent.ps1`""
    Set-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name 'KubeEZGatewayAgent' -Value $cmd
    Start-Process powershell.exe -WindowStyle Hidden -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$AgentDir\run-agent.ps1`""
    $mode = 'run-key'; $when = 'when you log in'
}

# -- Verify -------------------------------------------------------------------
$running = $false
for ($i = 0; $i -lt 15 -and -not $running; $i++) {
    Start-Sleep -Seconds 1
    $running = [bool](Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -like '*agent-bundle.js*' })
}
if (-not $running) {
    Say 'ERROR: the agent did not start. Last log lines:' 'Red'
    if (Test-Path (Join-Path $AgentDir 'agent.log')) { Get-Content (Join-Path $AgentDir 'agent.log') -Tail 15 }
    exit 1
}

Write-Host '==========================================================' -ForegroundColor Cyan
Write-Host " [SUCCESS] KubeEZ Gateway Agent is running ($mode)" -ForegroundColor Green
Write-Host " Starts $when and restarts by itself after a crash." -ForegroundColor White
Write-Host " Logs:    Get-Content `"$AgentDir\agent.log`" -Tail 50 -Wait" -ForegroundColor Gray
Write-Host " Running this command again is safe (it replaces the agent)." -ForegroundColor Gray
Write-Host '==========================================================' -ForegroundColor Cyan
