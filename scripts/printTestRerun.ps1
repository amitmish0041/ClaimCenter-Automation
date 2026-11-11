# Reruns some templates of a live print test with that run's own plan (same recipients / mail options per template).
# Usage: printTestRerun.ps1 -Stamp 20261110-1800 -Digs DIG30,DIG55   -> V:\Amit Int\SmartComm\print-test\PrintTest-<stamp>-rerun-<HHmm>.xlsx
param([Parameter(Mandatory)][string]$Stamp, [Parameter(Mandatory)][string]$Digs)
Remove-Item Env:\ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
$d = Split-Path -Parent $PSScriptRoot
$share = 'V:\Amit Int\SmartComm\print-test'
$out = Join-Path $d 'results\smartComm\print'
$tag = "live-$Stamp-rerun-$(Get-Date -Format 'HHmm')"
$env:CC_ENV = 'cloud'; $env:CC_TIER = 'test'
$env:SMARTCOMM_DATA_DIR = 'V:\Amit Int\SmartComm\data'; $env:SMARTCOMM_INTERACTIVE = '1'
$env:SMARTCOMM_OKTA_SESSION_FILE = 'V:\Amit Int\SmartComm\smartcomm-okta-session.json'; $env:SMARTCOMM_OKTA_SESSION_READONLY = '1'
$plan = Join-Path $out "live-$Stamp-plan.json"
$env:SMARTCOMM_PRINT_PLAN = $plan
Set-Location $d
$res = Join-Path $out "$tag.json"
node scripts/bulkValidateSmartComm.js $Digs $res *> (Join-Path $out "$tag.log")
node scripts/printTestReport.js $res (Join-Path $share ("PrintTest-$Stamp-rerun-" + $tag.Substring($tag.Length - 4) + ".xlsx")) $plan *>> (Join-Path $out "$tag.log")
