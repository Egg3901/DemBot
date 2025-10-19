# Register a Windows Scheduled Task to run DemBot boot script at user logon

param(
  [string]$TaskName = 'DemBotBoot',
  [string]$AppName = 'dembot'
)

$ErrorActionPreference = 'Stop'

$repo = Split-Path -Parent $PSScriptRoot
$boot = Join-Path $PSScriptRoot 'boot.ps1'

if (-not (Test-Path $boot)) { throw "boot.ps1 not found at $boot" }

$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$boot`" -AppName $AppName"
$trigger = New-ScheduledTaskTrigger -AtLogOn
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -MultipleInstances IgnoreNew

try {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue | Out-Null
} catch {}

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings | Out-Null
Write-Host "Registered scheduled task '$TaskName' to run $boot at logon."

