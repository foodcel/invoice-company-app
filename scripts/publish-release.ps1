param([string]$Repository = 'foodcel/invoice-company-app')

$ErrorActionPreference = 'Stop'
if ($PSVersionTable.PSVersion.Major -lt 7) {
    $releaseModernShell = Get-Command pwsh -ErrorAction SilentlyContinue
    if (-not $releaseModernShell) { throw 'Release publishing requires PowerShell 7 (pwsh). Run this script there.' }
    & $releaseModernShell.Source -NoProfile -ExecutionPolicy Bypass -File $PSCommandPath -Repository $Repository
    exit $LASTEXITCODE
}
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
$releasePreviousEncoding = $OutputEncoding
try {
    $OutputEncoding = [System.Text.UTF8Encoding]::new($false)
    $credential = @('protocol=https', 'host=github.com', '') | git credential fill 2>$null
} finally {
    $OutputEncoding = $releasePreviousEncoding
}
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

$notes = if ($version -eq '0.1.0') {
    'First Windows release. French quotations and invoices with local drafts, Letter PDFs, printing, and signed update support.'
} elseif ($version -eq '0.1.5') {
    'English customer copies with review and separate PDFs; OpenAI or Z.ai settings; work-line dictation and AI wording proposals; document dictation that fills fields during recording. A general API key, internet connection, and microphone permission are required for AI features. Please review AI-filled text and numbers before sending documents.'
} elseif ($version -eq '0.1.6') {
    'Nemotron 3.5 French-capable speech recognition now runs locally in the Windows app. Dictation shows words while speaking and sends completed utterances to the selected OpenAI or Z.ai text service for field filling and description proposals. The installer bundles the CPU speech model and runtime; no separate setup is needed. A general API key and internet connection are still required for AI field filling, rewriting, and English translation. Review all AI-filled fields before creating a customer PDF.'
} elseif ($version -eq '0.1.8') {
    'Invoice numbers can now be deliberately reused after a warning. Existing invoices and PDFs stay intact, and the automatic sequence continues forward. The editor has a compact save-status icon, matched work-line controls and read-only amount box, cleaner invoice preview, side-by-side number and translation controls, and inner focus highlights. Local Nemotron dictation and OpenAI or Z.ai AI features remain available.'
} elseif ($version -eq '0.1.9') {
    'Draft save status is now shown inside the Save Draft button: a pending dot, a small spinner while saving, a check after confirmation, or an error mark. Hover to see that drafts save automatically on this PC and the time of the last confirmed save. The existing invoice number and English-copy panels are unchanged while compact design options are reviewed.'
} elseif ($version -eq '0.1.10') {
    'The approved compact number and language panels now sit side by side in one row. Invoice number editing stays inside its card; reused numbers still require confirmation. The full-card Francais/English switch translates on selection and shows the English customer preview. Creating or printing the English PDF confirms that copy, and later French text changes require a refreshed translation. Manual French documents remain available without AI.'
} elseif ($version -eq '0.1.11') {
    'Add multiple deposits or received payments with an amount and optional date on each row. The approved compact date chooser uses larger text, and Add a payment stays below the rows. French and English customer PDFs list every payment and date, the combined amount, and the remaining balance. Existing single deposits are preserved as undated rows, including earlier drafts and recoverable versions. Invoice numbering and the selected PDF folder are unchanged.'
} elseif ($version -eq '0.1.14') {
    'Subscription-only AI: sign in with your personal ChatGPT plan for description rewriting, English customer copies and voice-text field extraction. Corrects the subscription HTTP 400 request and streaming response handling; all three text workflows were tested with a personal Pro subscription. No metered API key or billing fallback. Business workspace-token connection remains separate and has not been verified live. Local Nemotron speech recognition stays bundled; existing drafts, payments, invoice numbering and save folder are preserved. Review AI results before sending customer PDFs.'
} elseif ($version -eq '0.1.17') {
    'Outlook email composer: connect a personal Outlook/MSN account, review multiple recipients and CC, attach an automatically archived PDF, and send from the app. Accountant CC defaults on for invoices and off for quotations; all recipients remain editable. Company signature is prefilled. PDF, Print and Send share one row with icons. Deposits and payments now sit in a matching contained card, and invoice number / French-English controls are compact at 44px. Existing drafts and PDF workflows are preserved. Microsoft registration is included; each PC signs in separately. Automated frontend and backend checks passed; live Outlook sign-in and delivery still need user verification. No test email was sent during release checks.'
} else { "Windows release $tag. Signed update package for existing installations." }
$body = @{ tag_name = $tag; target_commitish = 'main'; name = "Soumissions et factures $tag"; body = $notes; draft = $true; prerelease = $false } | ConvertTo-Json -Compress
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
