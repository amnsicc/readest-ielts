param(
    [Parameter(Mandatory)]
    [string]$OutputDirectory
)

$ErrorActionPreference = 'Stop'
$output = [IO.Path]::GetFullPath($OutputDirectory)
if (Test-Path -LiteralPath $output) { throw 'Use a new test output directory.' }
New-Item -ItemType Directory -Path $output | Out-Null
$bases = [ordered]@{Roaming=$env:APPDATA; Local=$env:LOCALAPPDATA}
$appId = 'local.ielts.readest.trial'
function Snapshot {
    foreach ($entry in $bases.GetEnumerator()) {
        $root = Join-Path $entry.Value $appId
        Get-ChildItem -LiteralPath $root -Recurse -File -Force | ForEach-Object {
            [pscustomobject]@{
                root=$entry.Key
                path=[IO.Path]::GetRelativePath($root, $_.FullName)
                hash=(Get-FileHash -LiteralPath $_.FullName).Hash
                attributes=[string]$_.Attributes
            }
        }
    }
}
$before = @(Snapshot | Sort-Object root,path)
$before | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $output 'source-before.json')
$backup = Join-Path $output 'backup'
try {
    & pwsh -NoLogo -NoProfile -File (Join-Path $PSScriptRoot 'copy-ielts-windows-data.ps1') -Mode Backup -BackupDirectory $backup
    if ($LASTEXITCODE -ne 0) { throw "Encrypted profile backup failed with exit $LASTEXITCODE" }
    foreach ($file in $before) {
        $target = Join-Path $backup "$($file.root)\$($file.path)"
        if ((Get-FileHash -LiteralPath $target).Hash -ne $file.hash) { throw "Content mismatch: $target" }
        if ((Get-Item -LiteralPath $target -Force).Attributes.HasFlag([IO.FileAttributes]::Encrypted)) {
            throw "The D-drive content backup unexpectedly retained EFS: $target"
        }
    }
    'PASS: complete encrypted AppData profiles backed up to D with exact file content.'
} finally {
    $after = @(Snapshot | Sort-Object root,path)
    $after | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $output 'source-after.json')
    if (($before | ConvertTo-Json -Compress) -ne ($after | ConvertTo-Json -Compress)) {
        throw 'Source content or encryption attributes changed.'
    }
    'Source content and encryption attributes retained.'
}
