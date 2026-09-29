$ErrorActionPreference = 'Stop'
$root = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\src-tauri\resources\nemotron'))
New-Item -ItemType Directory -Force -Path $root | Out-Null

function Assert-Hash($path, $expected) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { return $false }
    $stream = [System.IO.File]::OpenRead($path)
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $actual = [System.BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-', '').ToLowerInvariant()
        return $actual -eq $expected
    } finally {
        $sha.Dispose()
        $stream.Dispose()
    }
}

function Download-Verified($url, $path, $expected) {
    if (Assert-Hash $path $expected) { return }
    $part = "$path.download"
    if (Test-Path -LiteralPath $part) { Remove-Item -LiteralPath $part -Force }
    & curl.exe --fail --location --retry 3 --output $part $url
    if ($LASTEXITCODE -ne 0) { throw "Download failed: $url" }
    if (-not (Assert-Hash $part $expected)) { throw "SHA-256 mismatch: $url" }
    Move-Item -LiteralPath $part -Destination $path -Force
}

$archive = Join-Path $root 'runtime.zip'
$runtimeHash = '5e4ea81046012edcd77fd8848de8eefb5a4ba38cc26f52eb544ab184695a75d6'
Download-Verified 'https://github.com/NVIDIA/NeMo-Speech.cpp/releases/download/v0.1.0/nemo-speech-0.1.0-windows-x86_64-cpu.zip' $archive $runtimeHash
$exe = Join-Path $root 'runtime\bin\nemo-speech.exe'
if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) {
    Expand-Archive -LiteralPath $archive -DestinationPath (Join-Path $root 'runtime') -Force
}
$model = Join-Path $root 'nemotron-3.5-asr-streaming-0.6b.q8_0.gguf'
$modelHash = '3fc991d3badad7277c11030a7519832cddaf2057aafed6d4b25147e953a070b1'
Download-Verified 'https://huggingface.co/nvidia/nemotron-3.5-asr-streaming-0.6b/resolve/ea30d66debe3740a08b573244286791d423d6b3e/nemotron-3.5-asr-streaming-0.6b.q8_0.gguf' $model $modelHash
if (-not (Test-Path -LiteralPath (Join-Path $root 'OpenMDW-1.1.html'))) {
    throw 'The OpenMDW-1.1 license copy is missing from the source tree.'
}
if (-not (Test-Path -LiteralPath (Join-Path $root 'MODEL_CARD.md'))) {
    throw 'The Nemotron model card and notices are missing from the source tree.'
}
Write-Host 'Nemotron 3.5 CPU runtime and model verified.'
