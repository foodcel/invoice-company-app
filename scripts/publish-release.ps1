param([string]$Repository = 'foodcel/invoice-company-app')

$ErrorActionPreference = 'Stop'
$appRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$package = Get-Content -LiteralPath (Join-Path $appRoot 'package.json') -Raw | ConvertFrom-Json
$version = [string]$package.version
$tag = "v$version"
$releaseDir = Join-Path $appRoot "release-output\$tag"
$installerName = "Soumissions-et-factures_${version}_x64-setup.exe"
$files = @($installerName, "$installerName.sig", 'latest.json')
foreach ($name in $files) {
    if (-not (Test-Path -LiteralPath (Join-Path $releaseDir $name) -PathType Leaf)) {
        throw "Missing release file: $name"
    }
}

$env:GCM_INTERACTIVE = 'never'
$credential = @('protocol=https', 'host=github.com', '') | git credential fill 2>$null
$token = ($credential | Where-Object { $_ -match '^password=' } | Select-Object -First 1) -replace '^password=', ''
if (-not $token) { throw 'Sign in to GitHub with Git Credential Manager before publishing.' }
$headers = @{ Authorization = "Bearer $token"; Accept = 'application/vnd.github+json'; 'X-GitHub-Api-Version' = '2022-11-28' }
$api = "https://api.github.com/repos/$Repository"
try {
    $existing = Invoke-RestMethod -Uri "$api/releases/tags/$tag" -Headers $headers
    if ($existing) { throw "Release $tag already exists. No files were replaced." }
} catch {
    if ($_.Exception.Response.StatusCode.value__ -ne 404) { throw }
}

$body = @{ tag_name = $tag; target_commitish = 'main'; name = "Soumissions et factures $tag"; body = 'First Windows release. French quotations and invoices with local drafts, Letter PDFs, printing, and signed update support.'; draft = $true; prerelease = $false } | ConvertTo-Json -Compress
$release = Invoke-RestMethod -Method Post -Uri "$api/releases" -Headers $headers -ContentType 'application/json' -Body $body
$uploadBase = ($release.upload_url -replace '\{.*$', '')
foreach ($name in $files) {
    $path = Join-Path $releaseDir $name
    $encoded = [System.Uri]::EscapeDataString($name)
    $asset = Invoke-RestMethod -Method Post -Uri "${uploadBase}?name=$encoded" -Headers $headers -ContentType 'application/octet-stream' -InFile $path
    if ($asset.name -cne $name) { throw "GitHub changed the uploaded filename: $name -> $($asset.name)" }
    if ([int64]$asset.size -ne (Get-Item -LiteralPath $path).Length) { throw "Uploaded file size mismatch: $name" }
    Write-Host "Uploaded $name"
}
$published = Invoke-RestMethod -Method Patch -Uri "$api/releases/$($release.id)" -Headers $headers -ContentType 'application/json' -Body '{"draft":false}'
Write-Host "Published $($published.html_url)"
Remove-Variable token,credential -ErrorAction SilentlyContinue
