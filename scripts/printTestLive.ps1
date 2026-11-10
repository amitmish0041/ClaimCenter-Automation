# Live physical print test: fresh random plan, one scenario per template marked X, results sheet to V:\Amit Int\SmartComm\print-test.
# Run from a signed-in Windows session (visible browser). Scheduled task: "SmartCOMM Print Test".
Remove-Item Env:\ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
$d = Split-Path -Parent $PSScriptRoot
$share = 'V:\Amit Int\SmartComm\print-test'
$stamp = Get-Date -Format 'yyyyMMdd-HHmm'
$out = Join-Path $d 'results\smartComm\print'
New-Item -ItemType Directory -Force $out | Out-Null
$env:CC_ENV = 'cloud'; $env:CC_TIER = 'test'
$env:SMARTCOMM_DATA_DIR = 'V:\Amit Int\SmartComm\data'; $env:SMARTCOMM_INTERACTIVE = '1'
$env:SMARTCOMM_OKTA_SESSION_FILE = 'V:\Amit Int\SmartComm\smartcomm-okta-session.json'; $env:SMARTCOMM_OKTA_SESSION_READONLY = '1'
$plan = Join-Path $out "live-$stamp-plan.json"
Set-Location $d
node scripts/printTestPlan.js "$share\Templates_Approved_for_SMT_dev.xlsx" $plan | Out-File (Join-Path $out "live-$stamp.log")
$env:SMARTCOMM_PRINT_PLAN = $plan
$digs = ((Get-Content $plan -Raw | ConvertFrom-Json).templates.PSObject.Properties.Name) -join ','
$res = Join-Path $out "live-$stamp.json"
node scripts/bulkValidateSmartComm.js $digs $res *>> (Join-Path $out "live-$stamp.log")
node scripts/printTestReport.js $res (Join-Path $share "PrintTest-$stamp.xlsx") $plan *>> (Join-Path $out "live-$stamp.log")
Copy-Item $plan (Join-Path $share "PrintTest-$stamp-plan.json")
