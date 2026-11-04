param([Parameter(Mandatory)][string]$OutputDirectory)
$ErrorActionPreference = 'Stop'
$output = [IO.Path]::GetFullPath($OutputDirectory)
if (Test-Path -LiteralPath $output) { throw 'Use a new test output directory.' }
$roaming = Join-Path $output 'profiles\Roaming'
$local = Join-Path $output 'profiles\Local'
foreach ($root in @($roaming, $local)) {
    New-Item -ItemType Directory -Path (Join-Path $root 'local.ielts.readest.trial') -Force | Out-Null
    [IO.File]::WriteAllText((Join-Path $root 'local.ielts.readest.trial\saved.txt'), 'saved source')
}
$oldRoaming = $env:APPDATA
$oldLocal = $env:LOCALAPPDATA
$env:APPDATA = $roaming
$env:LOCALAPPDATA = $local
$locked = Join-Path $local 'local.ielts.readest.trial\saved.txt'
$lock = [IO.File]::Open($locked, 'Open', 'ReadWrite', 'None')
$script = Join-Path $PSScriptRoot 'copy-ielts-windows-data.ps1'
$backup = Join-Path $output 'interrupted'
try {
    & pwsh -NoProfile -File $script -Mode Backup -BackupDirectory $backup
    if ($LASTEXITCODE -eq 0) { throw 'The inaccessible source must fail backup.' }
    $state = Get-Content -LiteralPath (Join-Path $backup 'backup-state.json') -Raw | ConvertFrom-Json
    if ($state.status -ne 'failed' -or $state.section -ne 'Local') {
        throw 'The partial backup must report failed and identify the Local section.'
    }
    if (Test-Path -LiteralPath (Join-Path $backup 'SHA256.json')) { throw 'Partial backup published a completed manifest.' }
    if ([IO.File]::ReadAllText((Join-Path $backup 'Roaming\saved.txt')) -ne 'saved source') {
        throw 'The already copied section was not retained.'
    }
    & pwsh -NoProfile -File $script -Mode RestoreTest -BackupDirectory $backup
    if ($LASTEXITCODE -eq 0) { throw 'Restore accepted an incomplete backup.' }
    foreach ($root in @($roaming, $local)) {
        if (Test-Path -LiteralPath (Join-Path $root 'local.ielts.readest.trial.restore')) {
            throw 'An incomplete backup wrote a restore profile.'
        }
    }
    'PASS: partial state is explicit; restore rejected it before writing a destination.'
    $lock.Dispose()
    $fresh = Join-Path $output 'retry-complete'
    & pwsh -NoProfile -File $script -Mode Backup -BackupDirectory $fresh
    if ($LASTEXITCODE -ne 0) { throw 'Retry into a new directory failed.' }
    & pwsh -NoProfile -File $script -Mode RestoreTest -BackupDirectory $fresh
    if ($LASTEXITCODE -ne 0) { throw 'Complete backup restore failed.' }
    foreach ($root in @($roaming, $local)) {
        $restored = Join-Path $root 'local.ielts.readest.trial.restore.w01\saved.txt'
        if ([IO.File]::ReadAllText($restored) -ne 'saved source') { throw 'Restored content differs.' }
        $original = Join-Path $root 'local.ielts.readest.trial\saved.txt'
        if ([IO.File]::ReadAllText($original) -ne 'saved source') { throw 'Source content changed.' }
    }
    'PASS: retry completed and both independent directories restored with exact content.'
} finally {
    $lock.Dispose()
    $env:APPDATA = $oldRoaming
    $env:LOCALAPPDATA = $oldLocal
}
