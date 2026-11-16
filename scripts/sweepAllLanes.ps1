# Full sweep, one scenario per template, in parallel lanes (each lane = its own resumable bulk run).
# Usage: sweepAllLanes.ps1 -Tag all-1114 -Lanes 3 [-Scenarios 2]   (scenarios per template; default 1)   (lists: results\smartComm\bulk\<tag>-lane<N>-list.json)
param([Parameter(Mandatory)][string]$Tag, [int]$Lanes = 3, [int]$Scenarios = 1)
Remove-Item Env:\ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
$d = Split-Path -Parent $PSScriptRoot
$out = Join-Path $d 'results\smartComm\bulk'
$env:CC_ENV = 'cloud'; $env:CC_TIER = 'test'
$env:SMARTCOMM_DATA_DIR = 'V:\Amit Int\SmartComm\data'; $env:SMARTCOMM_INTERACTIVE = '1'; if ($Scenarios -gt 1) { $env:SMARTCOMM_SINGLE_SCENARIO = '0'; $env:SMARTCOMM_MAX_SCENARIOS = "$Scenarios" } else { $env:SMARTCOMM_SINGLE_SCENARIO = '1' }
$env:SMARTCOMM_OKTA_SESSION_FILE = 'V:\Amit Int\SmartComm\smartcomm-okta-session.json'; $env:SMARTCOMM_OKTA_SESSION_READONLY = '1'
Set-Location $d
$procs = 0..($Lanes - 1) | ForEach-Object {
  Start-Process node -ArgumentList 'scripts/bulkValidateSmartComm.js', "results/smartComm/bulk/$Tag-lane$_-list.json", "results/smartComm/bulk/$Tag-lane$_.json" -RedirectStandardOutput (Join-Path $out "$Tag-lane$_.log") -RedirectStandardError (Join-Path $out "$Tag-lane$_.err.log") -PassThru
}
$procs | Wait-Process
