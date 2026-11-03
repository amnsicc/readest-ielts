param(
  [Parameter(Mandatory=$true)][string]$OutputDirectory,
  [switch]$FullSuite
)

$ErrorActionPreference = 'Stop'
$taskApp = Split-Path $PSScriptRoot -Parent
$taskOutput = [System.IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Path $taskOutput -Force | Out-Null
$taskOriginalPm = [Environment]::GetEnvironmentVariable('pnpm_config_pm_on_fail')
$env:pnpm_config_pm_on_fail = 'ignore'
$taskResults = [System.Collections.Generic.List[object]]::new()

function Invoke-LearningCheck {
  param([string]$Label, [string[]]$CommandArguments)
  $taskLog = Join-Path $taskOutput ($Label + '.txt')
  $taskStarted = [DateTimeOffset]::UtcNow.ToOffset([TimeSpan]::FromHours(8)).ToString('o')
  "Command: pnpm.cmd $($CommandArguments -join ' ')`nStarted: $taskStarted" | Set-Content -LiteralPath $taskLog -Encoding utf8
  & pnpm.cmd @CommandArguments *>> $taskLog
  $taskCode = $LASTEXITCODE
  "exit_code=$taskCode" | Add-Content -LiteralPath $taskLog -Encoding utf8
  $taskResults.Add([pscustomobject]@{check=$Label;startedAt=$taskStarted;command=@('pnpm.cmd')+$CommandArguments;exitCode=$taskCode;log=$taskLog})
  Write-Output "$Label exit_code=$taskCode"
  Get-Content -LiteralPath $taskLog -Tail 9
}

Push-Location -LiteralPath $taskApp
try {
  Invoke-LearningCheck -Label 'storage-public-api' -CommandArguments @('test','--run','--maxWorkers=2','src/__tests__/services/learning/')
  Invoke-LearningCheck -Label 'changed-files-format' -CommandArguments @('exec','biome','format','src/services/learning','src/__tests__/services/learning','src/services/database/migrations/index.ts')
  Invoke-LearningCheck -Label 'project-lint' -CommandArguments @('lint')
  if ($FullSuite) {
    Invoke-LearningCheck -Label 'full-unit-suite' -CommandArguments @('test','--run','--maxWorkers=2')
  }
  $taskResults | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $taskOutput 'checks.json') -Encoding utf8
} finally {
  Pop-Location
  if ($null -eq $taskOriginalPm) {
    Remove-Item -LiteralPath 'Env:\pnpm_config_pm_on_fail' -ErrorAction SilentlyContinue
  } else {
    $env:pnpm_config_pm_on_fail = $taskOriginalPm
  }
}
if (@($taskResults | Where-Object exitCode -NE 0).Count -gt 0) { exit 1 }
exit 0
