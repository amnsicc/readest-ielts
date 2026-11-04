param(
    [Parameter(Mandatory)]
    [ValidateSet('Backup', 'RestoreTest')]
    [string]$Mode,

    [Parameter(Mandatory)]
    [string]$BackupDirectory
)

$ErrorActionPreference = 'Stop'
$appId = 'local.ielts.readest.trial'
$restoreId = 'local.ielts.readest.trial.restore'
if (Get-Process -Name 'readest-ielts','readest-ielts-restore' -ErrorAction SilentlyContinue) {
    throw 'Close all IELTS trial windows and wait for both programs to exit before copying.'
}

$backup = [IO.Path]::GetFullPath($BackupDirectory)
$bases = [ordered]@{ Roaming=$env:APPDATA; Local=$env:LOCALAPPDATA }
foreach ($base in $bases.Values) {
    foreach ($id in @($appId, $restoreId)) {
        $appRoot = [IO.Path]::GetFullPath((Join-Path $base $id))
        if ($backup.Equals($appRoot, 'OrdinalIgnoreCase') -or
            $backup.StartsWith($appRoot + [IO.Path]::DirectorySeparatorChar, 'OrdinalIgnoreCase')) {
            throw 'The backup directory must be outside both app profiles.'
        }
    }
}

function Get-Inventory([string]$Directory) {
    $resolved = (Resolve-Path -LiteralPath $Directory).ProviderPath
    Get-ChildItem -LiteralPath $resolved -File -Recurse -Force |
        ForEach-Object {
            [pscustomobject]@{
                path=[IO.Path]::GetRelativePath($resolved, $_.FullName)
                bytes=$_.Length
                sha256=(Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash
            }
        } | Sort-Object path
}

function Assert-Inventory([string]$Directory, [object[]]$Expected) {
    $actual = @(Get-Inventory $Directory)
    if (($actual | ConvertTo-Json -Compress) -ne ($Expected | ConvertTo-Json -Compress)) {
        throw "File hash verification failed for $Directory"
    }
}

function Copy-ProfileContent([string]$Source, [string]$Destination) {
    $root = (Resolve-Path -LiteralPath $Source).ProviderPath
    [IO.Directory]::CreateDirectory($Destination) | Out-Null
    foreach ($entry in Get-ChildItem -LiteralPath $root -Recurse -Force) {
        $target = Join-Path $Destination ([IO.Path]::GetRelativePath($root, $entry.FullName))
        if ($entry.PSIsContainer) {
            [IO.Directory]::CreateDirectory($target) | Out-Null
            continue
        }
        $inputFile = [IO.File]::Open($entry.FullName, 'Open', 'Read', 'Read')
        try {
            $outputFile = [IO.File]::Open($target, 'CreateNew', 'Write', 'None')
            try {
                $inputFile.CopyTo($outputFile)
                $outputFile.Flush($true)
            } finally {
                $outputFile.Dispose()
            }
        } finally {
            $inputFile.Dispose()
        }
    }
}

if ($Mode -eq 'Backup') {
    if (Test-Path -LiteralPath $backup) { throw 'Choose a new directory for the backup.' }
    $source = Join-Path $bases.Roaming $appId
    if (-not (Test-Path -LiteralPath $source -PathType Container)) {
        throw "The app profile has not been created: $source"
    }
    New-Item -ItemType Directory -Path $backup | Out-Null
    $manifest = [ordered]@{}
    $statePath = Join-Path $backup 'backup-state.json'
    $state = [ordered]@{
        formatVersion=1
        status='incomplete'
        section=''
        startedAt=(Get-Date).ToString('o')
        completedAt=$null
        error=$null
        contentCopy='Source encryption attributes are retained; backup files contain readable content.'
    }
    try {
        $state | ConvertTo-Json | Set-Content -LiteralPath $statePath -Encoding utf8
        foreach ($entry in $bases.GetEnumerator()) {
            $state.section = $entry.Key
            $state | ConvertTo-Json | Set-Content -LiteralPath $statePath -Encoding utf8
            $source = Join-Path $entry.Value $appId
            $dest = Join-Path $backup $entry.Key
            $files = @(Get-Inventory $source)
            Copy-ProfileContent $source $dest
            Assert-Inventory $dest $files
            $manifest[$entry.Key] = $files
            "backup verified: $source => $dest ($($files.Count) files)"
        }
        foreach ($entry in $bases.GetEnumerator()) {
            Assert-Inventory (Join-Path $entry.Value $appId) $manifest[$entry.Key]
        }
        $manifest | ConvertTo-Json -Depth 6 |
            Set-Content -LiteralPath (Join-Path $backup 'SHA256.json') -Encoding utf8
        $state.status = 'complete'
        $state.completedAt = (Get-Date).ToString('o')
        $state | ConvertTo-Json | Set-Content -LiteralPath $statePath -Encoding utf8
    } catch {
        $state.status = 'failed'
        $state.error = $_.Exception.Message
        $state | ConvertTo-Json | Set-Content -LiteralPath $statePath -Encoding utf8
        throw
    }
    return
}

$state = Get-Content -LiteralPath (Join-Path $backup 'backup-state.json') -Raw | ConvertFrom-Json
if ($state.formatVersion -ne 1 -or $state.status -ne 'complete') {
    throw 'Backup is incomplete or failed. Its partial files have been retained; create a new backup.'
}
$manifest = Get-Content -LiteralPath (Join-Path $backup 'SHA256.json') -Raw | ConvertFrom-Json -AsHashtable
if (-not $manifest.Contains('Roaming') -or -not $manifest.Contains('Local')) {
    throw 'Backup must contain both Roaming and Local directories.'
}
foreach ($entry in $bases.GetEnumerator()) {
    $dest = Join-Path $entry.Value $restoreId
    if (Test-Path -LiteralPath $dest) { throw "Restore test destination already exists: $dest" }
    if ($manifest.Contains($entry.Key)) {
        Assert-Inventory (Join-Path $backup $entry.Key) $manifest[$entry.Key]
    }
}
foreach ($entry in $bases.GetEnumerator()) {
    if (-not $manifest.Contains($entry.Key)) { continue }
    $source = Join-Path $backup $entry.Key
    $dest = Join-Path $entry.Value $restoreId
    Copy-ProfileContent $source $dest
    Assert-Inventory $dest $manifest[$entry.Key]
    "isolated copy verified: $source => $dest ($($manifest[$entry.Key].Count) files)"
}
