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
robocopy "$sRoot\HPExstream Document Mapping\ClaimCenter" "$vData\Templates\ClaimCenter" /E /XF '~$*' /R:2 /W:5 /NP /NJH /NJS | Out-Null
$docs = $LASTEXITCODE

# robocopy: 0-7 = success (1 = files copied), 8+ = failure
Log ("dictionary exit {0}, mapping docs exit {1}" -f $dict, $docs)
if ($dict -ge 8 -or $docs -ge 8) { exit 1 }
exit 0
