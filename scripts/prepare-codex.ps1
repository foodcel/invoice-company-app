$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Utility') -ErrorAction Stop
Import-Module (Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Security') -ErrorAction Stop
$root = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\src-tauri\resources\codex'))
New-Item -ItemType Directory -Force -Path $root | Out-Null
$expected = 'E31B931087C22F0039C11476600D0933C3E661D8C2C03BACE4995A66D2994BC6'
$destination = Join-Path $root 'codex.exe'
if (-not (Test-Path -LiteralPath $destination) -or (Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash -ne $expected) {
    $link = Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Links\codex.exe'
    if (-not (Test-Path -LiteralPath $link)) { throw 'Install official Codex CLI 0.152.0 with WinGet before building this release.' }
    $source = (Get-Item -LiteralPath $link).Target
    if ((Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash -ne $expected) { throw 'Codex CLI hash does not match pinned 0.152.0.' }
    if ((Get-AuthenticodeSignature -LiteralPath $source).Status -ne 'Valid') { throw 'Codex signature is invalid.' }
    Copy-Item -LiteralPath $source -Destination $destination -Force
    foreach ($helper in @('codex-command-runner.exe', 'codex-windows-sandbox-setup.exe')) {
        $helperPath = Join-Path (Split-Path $source) $helper
        if ((Get-AuthenticodeSignature -LiteralPath $helperPath).Status -ne 'Valid') { throw "Codex helper signature is invalid: $helper" }
        Copy-Item -LiteralPath $helperPath -Destination (Join-Path $root $helper) -Force
    }
}
foreach ($notice in @('LICENSE', 'NOTICE')) {
    $noticePath = Join-Path $root "$notice.txt"
    if (-not (Test-Path -LiteralPath $noticePath)) {
        Invoke-WebRequest -Uri "https://raw.githubusercontent.com/openai/codex/rust-v0.152.0/$notice" -OutFile $noticePath
    }
}
$version = & $destination --version
if ($version -ne 'codex-cli 0.152.0') { throw 'Codex version mismatch.' }
foreach ($entry in @(
    @('codex.exe', $expected),
    @('codex-command-runner.exe', '40F6BEBDCB6B795E5763785B8801DC4F4704CE2BFA0B37E3D7D5723A1B35128C'),
    @('codex-windows-sandbox-setup.exe', 'C9E43DEE96700F3B0863C5CF1A9919D51B3A9ECBEEB10C9DBAD873AB683FE011')
)) {
    $binaryPath = Join-Path $root $entry[0]
    if (-not (Test-Path -LiteralPath $binaryPath) -or (Get-FileHash -LiteralPath $binaryPath -Algorithm SHA256).Hash -ne $entry[1]) { throw "Pinned Codex resource mismatch: $($entry[0])" }
}
Write-Host 'Official Codex 0.152.0 runtime verified.'
