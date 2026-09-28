param(
    [switch]$SkipBuild
)

$ErrorActionPreference = 'Stop'
$appRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$package = Get-Content -LiteralPath (Join-Path $appRoot 'package.json') -Raw | ConvertFrom-Json
$tauri = Get-Content -LiteralPath (Join-Path $appRoot 'src-tauri\tauri.conf.json') -Raw | ConvertFrom-Json
$version = [string]$package.version
if ($version -notmatch '^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$' -or $version -ne [string]$tauri.version) {
    throw 'package.json and tauri.conf.json must contain the same SemVer version.'
}
$signingKey = Join-Path $env:USERPROFILE '.tauri\invoice-company-app.key'
if (-not (Test-Path -LiteralPath $signingKey -PathType Leaf)) {
    throw "Updater signing key is missing: $signingKey"
}

Push-Location -LiteralPath $appRoot
try {
    & npm run check
    if ($LASTEXITCODE -ne 0) { throw 'App checks failed.' }
    if (-not $SkipBuild) {
        & (Join-Path $PSScriptRoot 'build-windows.cmd')
        if ($LASTEXITCODE -ne 0) { throw 'Windows package build failed.' }
    }
    $bundleDir = Join-Path $appRoot 'src-tauri\target\release\bundle\nsis'
    $installer = Join-Path $bundleDir "Soumissions et factures_${version}_x64-setup.exe"
    $signature = "$installer.sig"
    if (-not (Test-Path -LiteralPath $installer -PathType Leaf) -or -not (Test-Path -LiteralPath $signature -PathType Leaf)) {
        throw 'The signed installer or its .sig file is missing.'
    }
    $releaseDir = Join-Path $appRoot "release-output\v$version"
    if (Test-Path -LiteralPath $releaseDir) { throw "Release folder already exists: $releaseDir" }
    New-Item -ItemType Directory -Path $releaseDir | Out-Null
    $releaseInstaller = Join-Path $releaseDir "Soumissions-et-factures_${version}_x64-setup.exe"
    $releaseSignature = "$releaseInstaller.sig"
    Copy-Item -LiteralPath $installer -Destination $releaseInstaller
    Copy-Item -LiteralPath $signature -Destination $releaseSignature
    $manifest = Join-Path $releaseDir 'latest.json'
    & node (Join-Path $PSScriptRoot 'create-update-manifest.mjs') $version 'foodcel/invoice-company-app' $releaseInstaller $releaseSignature $manifest
    if ($LASTEXITCODE -ne 0) { throw 'Update manifest creation failed.' }
    Write-Host "Release files ready: $releaseDir"
} finally {
    Pop-Location
}
