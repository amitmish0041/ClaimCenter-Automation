# scripts/oneIncStockTopUp.ps1 — nightly OneInc test-data stock top-up (user direction 2026-11-03: always create the
# claims in advance; a test run takes them from the shared pool instead of filing fresh claims while the team waits).
#
# Runs `runOneInc.js --data-only` over every automated scenario: per claim type it creates what one full run needs minus
# the Unused claims already in stock (helpers/oneInc/testClaims.js plan — shared claims for negatives / simple positives,
# 3 parallel builders). Claims land in V:\Amit Int\OneInc\AutomationResults\TestData\claim-pool-test.json as "Unused";
# runs (this machine or the team's Runners) take those first and only file new claims when the stock is short.
# Scheduled task "OneInc Test-Data Stock" (Mon-Fri 01:00, interactive — the builders use a visible browser).
$ErrorActionPreference = 'Continue'
$repo = Split-Path -Parent $PSScriptRoot
$logDir = 'V:\Amit Int\OneInc\AutomationResults\Logs'
if (-not (Test-Path $logDir)) { $logDir = Join-Path $repo 'results\oneInc' }
New-Item -ItemType Directory -Force $logDir | Out-Null
$log = Join-Path $logDir ("StockTopUp_{0}.log" -f (Get-Date -Format 'yyyyMMdd_HHmm'))

# One top-up at a time.
$running = Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*runOneInc.js*--data-only*' }
if ($running) { "$(Get-Date -Format s) another stock top-up is already running (pid $($running.ProcessId)) — skipped" | Out-File -Append -Encoding utf8 $log; exit 0 }

Remove-Item Env:\ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
$env:CC_ENV = 'cloud'
Set-Location $repo
"$(Get-Date -Format s) stock top-up started" | Out-File -Append -Encoding utf8 $log
& node scripts/runOneInc.js --data-only *>&1 | ForEach-Object { "$(Get-Date -Format s) $_" } | Out-File -Append -Encoding utf8 $log
"$(Get-Date -Format s) stock top-up finished (exit $LASTEXITCODE)" | Out-File -Append -Encoding utf8 $log
exit $LASTEXITCODE
