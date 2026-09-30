$ErrorActionPreference = 'Stop'
$release = Invoke-RestMethod -Uri 'https://api.github.com/repos/foodcel/invoice-company-app/releases/tags/v0.1.19' -Headers @{Accept='application/vnd.github+json'}
if ($release.draft -or $release.prerelease -or $release.tag_name -ne 'v0.1.19') { throw 'Release not public/stable' }
$manifest = Invoke-RestMethod -Uri ('https://github.com/foodcel/invoice-company-app/releases/latest/download/latest.json?verify=' + [DateTimeOffset]::UtcNow.ToUnixTimeSeconds())
if ($manifest.version -ne '0.1.19') { throw 'Updater does not point at v0.1.19' }
$platform = $manifest.platforms.'windows-x86_64'
$local = Get-Content -LiteralPath 'release-output\v0.1.19\latest.json' -Raw | ConvertFrom-Json
if ($platform.url -ne $local.platforms.'windows-x86_64'.url -or $platform.signature -ne $local.platforms.'windows-x86_64'.signature) { throw 'Public manifest/signature differs from final local package' }
$asset = $release.assets | Where-Object name -eq 'Soumissions-et-factures_0.1.19_x64-setup.exe'
$installer = Get-Item -LiteralPath 'release-output\v0.1.19\Soumissions-et-factures_0.1.19_x64-setup.exe'
$sha = (Get-FileHash -LiteralPath $installer.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
if ($asset.size -ne $installer.Length -or $asset.digest -ne "sha256:$sha") { throw 'GitHub installer digest or size differs' }
if ($release.assets.Count -ne 3) { throw 'Expected installer, signature and updater manifest' }
$receipt = @{version=$manifest.version;releaseUrl=$release.html_url;publicStable=$true;latestManifestMatches=$true;signatureMatches=$true;installerDigestMatches=$true;installerSize=$installer.Length;installerSha256=$sha;verifiedAt=[DateTimeOffset]::UtcNow.ToString('o')}
$receipt | ConvertTo-Json | Set-Content -LiteralPath 'docs\pdf-timeline\published-receipt.json'
$receipt | ConvertTo-Json
