# Copies the BA-maintained SmartCOMM sources from S: to the team's V: copy, so teammates without S: always read
# the latest. Runs daily from Task Scheduler ("SmartCOMM S to V sync") on the owner's PC; safe to run by hand.
# Only copies newer/changed files — never deletes anything on V:. Log: V:\Amit Int\SmartComm\data\sync-from-S.log
$ErrorActionPreference = 'Continue'
$sRoot = 'S:\Shared Folders\Policy Center Initiative\PolicyCenter\Integration\Future State - Donegal'
$vData = 'V:\Amit Int\SmartComm\data'
$log = Join-Path $vData 'sync-from-S.log'

function Log($msg) { Add-Content -Path $log -Value ("{0}  {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg) }

if (-not (Test-Path $sRoot)) { Log 'S: not reachable - skipped'; exit 1 }

# Data dictionary (skip Excel's ~$ lock file)
robocopy "$sRoot\Data Mapping" "$vData\Requirement" 'Claims_Attributes_Data_Dictionary*.xlsb' /XF '~$*' /R:2 /W:5 /NP /NJH /NJS | Out-Null
$dict = $LASTEXITCODE
# Mapping docs
# Logs the names of files it had to copy as NEW: mapping docs kept vanishing from V: after each sync (2026-11-27,
# ~60 docs incl. DIG14/16/105/143/150PA re-copied daily), so the log shows what went missing since the last run.
$out = robocopy "$sRoot\HPExstream Document Mapping\ClaimCenter" "$vData\Templates\ClaimCenter" /E /XF '~$*' /R:2 /W:5 /NP /NJH /NJS /NDL
$docs = $LASTEXITCODE
$new = @($out | Where-Object { $_ -match 'New File' } | ForEach-Object { ($_ -split "`t")[-1].Trim() })
if ($new.Count) { Log ("re-copied {0} mapping doc(s) missing on V: {1}" -f $new.Count, ($new -join '; ')) }

# robocopy: 0-7 = success (1 = files copied), 8+ = failure
Log ("dictionary exit {0}, mapping docs exit {1}" -f $dict, $docs)
if ($dict -ge 8 -or $docs -ge 8) { exit 1 }
exit 0
