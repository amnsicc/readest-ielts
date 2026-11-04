param(
    [Parameter(Mandatory)][string]$RestoreExecutable,
    [Parameter(Mandatory)][string]$DataDirectory,
    [Parameter(Mandatory)][string]$OutputDirectory
)
$ErrorActionPreference = 'Stop'
$output = [IO.Path]::GetFullPath($OutputDirectory)
$data = [IO.Path]::GetFullPath($DataDirectory)
if (Test-Path -LiteralPath $output) { throw 'Use a new evidence directory.' }
if (-not (Test-Path -LiteralPath $RestoreExecutable -PathType Leaf)) { throw 'Missing recovery executable.' }
if (Get-Process -Name 'readest-ielts','readest-ielts-restore' -ErrorAction SilentlyContinue) {
    throw 'An IELTS trial is already running.'
}
$roots = [ordered]@{Roaming=$env:APPDATA; Local=$env:LOCALAPPDATA}
$id = 'local.ielts.readest.trial.restore.w01'
foreach ($entry in $roots.GetEnumerator()) {
    $link = Get-Item -LiteralPath (Join-Path $entry.Value $id) -Force
    $target = [IO.Path]::GetFullPath((Join-Path $data $entry.Key))
    if ($link.LinkType -ne 'Junction' -or [IO.Path]::GetFullPath($link.Target) -ne $target) {
        throw 'The recovery identity must map exclusively to the supplied D-drive data root.'
    }
}
New-Item -ItemType Directory -Path $output | Out-Null
function Inventory([string]$Path) {
    @(Get-ChildItem -LiteralPath $Path -File -Recurse -Force | ForEach-Object {
        [pscustomobject]@{
            path=[IO.Path]::GetRelativePath($Path, $_.FullName)
            bytes=$_.Length
            sha256=(Get-FileHash -LiteralPath $_.FullName).Hash
            attributes=[string]$_.Attributes
        }
    } | Sort-Object path)
}
$protected = foreach ($root in $roots.Values) {
    $path = Join-Path $root 'local.ielts.readest.trial'
    [pscustomobject]@{path=$path;files=@(Inventory $path)}
}
$protected | ConvertTo-Json -Depth 7 | Set-Content -LiteralPath (Join-Path $output 'protected-before.json')
$runner = Join-Path $PSScriptRoot 'verify-ielts-windows.mjs'
$copy = Join-Path $PSScriptRoot 'copy-ielts-windows-data.ps1'
$oldIdentity = $env:IELTS_VERIFY_RECOVERY_IDENTITY
$env:IELTS_VERIFY_RECOVERY_IDENTITY = '1'
function Run-Native([string]$Mode, [string]$Name) {
    $caseOutput = Join-Path $output $Name
    & node $runner $RestoreExecutable $caseOutput $Mode *>&1 | Tee-Object -LiteralPath "$caseOutput.log"
    $code = $LASTEXITCODE
    "exit_code=$code" | Add-Content -LiteralPath "$caseOutput.log"
    if ($code -ne 0) { throw "Native case failed: $Name (exit $code)" }
}
try {
    if (@(Get-ChildItem -LiteralPath $data -Recurse -File -Force).Count) {
        throw 'The isolated data root must start empty. Preserve prior evidence before retrying.'
    }
    Run-Native 'exercise' '01-full-study'
    Run-Native 'reopen' '02-cold-reopen'
    Run-Native 'alt-dirty' '03-alt-dirty'
    Run-Native 'alt-saving' '04-alt-saving'
    Run-Native 'alt-clean' '05-alt-clean'
    Run-Native 'multi-reader-first' '06-reader-first'
    Run-Native 'multi-main-first' '07-main-first'
    Run-Native 'multi-main-dirty' '08-other-draft'
    Run-Native 'multi-main-saving' '08b-other-saving'
    Run-Native 'mark-off' '09-cancel-mark'
    Run-Native 'mark-off-reopen' '10-cancel-mark-reopen'
    $backup = Join-Path $output 'complete-backup'
    & pwsh -NoProfile -File $copy -Mode Backup -ApplicationId $id -BackupDirectory $backup
    if ($LASTEXITCODE -ne 0) { throw 'Complete study profile backup failed.' }
    $parent = Split-Path -Parent $data
    $saved = "$data.before-restore-" + [guid]::NewGuid().ToString('N')
    if (-not $data.StartsWith('D:\codex_project\雅思备考\', 'OrdinalIgnoreCase') -or
        [IO.Path]::GetDirectoryName($saved) -ne $parent) {
        throw 'Isolated data move is outside the verified workspace.'
    }
    Move-Item -LiteralPath $data -Destination $saved
    foreach ($name in $roots.Keys) {
        New-Item -ItemType Directory -Path (Join-Path $data $name) -Force | Out-Null
    }
    "Original isolated data retained at $saved" |
        Set-Content -LiteralPath (Join-Path $output 'source-isolation.log')
    & pwsh -NoProfile -File $copy -Mode RestoreTest -BackupDirectory $backup
    if ($LASTEXITCODE -ne 0) { throw 'Isolated restore failed.' }
    Run-Native 'restore' '11-restored-full-study'
    $before = Get-Content -LiteralPath (Join-Path $output '02-cold-reopen\checks.json') -Raw | ConvertFrom-Json
    $after = Get-Content -LiteralPath (Join-Path $output '11-restored-full-study\checks.json') -Raw | ConvertFrom-Json
    $original = $before | Where-Object name -eq 'native listening saved value and frozen first check'
    $restored = $after | Where-Object name -eq 'native listening saved value and frozen first check'
    if ($original.checkedAtDisplay -ne $restored.checkedAtDisplay) {
        throw 'The restored first-check time or frozen result differs from the original.'
    }
    Run-Native 'restore-write' '12-restored-save'
    Run-Native 'restore-write-reopen' '13-restored-cold-reopen'
} finally {
    $env:IELTS_VERIFY_RECOVERY_IDENTITY = $oldIdentity
    foreach ($record in $protected) {
        $after = @(Inventory $record.path)
        if (($after | ConvertTo-Json -Compress) -ne ($record.files | ConvertTo-Json -Compress)) {
            throw "Protected original profile changed: $($record.path)"
        }
        "Original profile verified: $($record.path) ($($after.Count) files)"
    }
    'Original profiles retained in place and verified.' |
        Set-Content -LiteralPath (Join-Path $output 'protected-after.log')
}
