param(
    [ValidateSet('qwen', 'base', 'cosyvoice')]
    [string]$Engine = 'qwen',
    [string]$EnvName = 'novel-voice',
    [string]$Runner = '',
    [string]$ModelDir = '',
    [switch]$SkipModelDownload
)

$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$WorkerRoot = Join-Path $ProjectRoot 'worker'

function Resolve-EnvironmentRunner {
    param([string]$Explicit)
    if ($Explicit) {
        $resolved = (Resolve-Path -LiteralPath $Explicit -ErrorAction Stop).Path
        return @{ Command = $resolved; Kind = if ((Split-Path -Leaf $resolved) -like 'micromamba*') { 'micromamba' } else { 'conda' } }
    }
    if ($env:MAMBA_EXE -and (Test-Path -LiteralPath $env:MAMBA_EXE)) {
        return @{ Command = $env:MAMBA_EXE; Kind = 'micromamba' }
    }
    $known = @(
        $(if ($env:MAMBA_ROOT_PREFIX) { Join-Path $env:MAMBA_ROOT_PREFIX 'condabin\micromamba.bat' }),
        "$env:USERPROFILE\micromamba-root\condabin\micromamba.bat",
        "$env:USERPROFILE\micromamba\micromamba.exe",
        "$env:USERPROFILE\.local\bin\micromamba.exe",
        "$env:USERPROFILE\bin\micromamba.exe",
        "$env:LOCALAPPDATA\micromamba\micromamba.exe",
        "$env:USERPROFILE\scoop\shims\micromamba.exe"
    )
    foreach ($candidate in $known) {
        if (Test-Path -LiteralPath $candidate) { return @{ Command = $candidate; Kind = 'micromamba' } }
    }
    $mamba = Get-Command micromamba -ErrorAction SilentlyContinue
    if ($mamba) { return @{ Command = $mamba.Source; Kind = 'micromamba' } }
    $conda = Get-Command conda -ErrorAction SilentlyContinue
    if ($conda) { return @{ Command = $conda.Source; Kind = 'conda' } }
    throw "micromamba/conda was not found in PowerShell PATH. If conda is a shell alias, pass the real micromamba.exe path with -Runner."
}

function Invoke-Env {
    param([hashtable]$Resolved, [string[]]$Arguments)
    & $Resolved.Command @Arguments
    if ($LASTEXITCODE -ne 0) { throw "Environment command failed: $($Arguments -join ' ')" }
}

$ResolvedRunner = Resolve-EnvironmentRunner -Explicit $Runner
if (-not $env:MAMBA_ROOT_PREFIX -and (Test-Path -LiteralPath "$env:USERPROFILE\micromamba-root")) {
    $env:MAMBA_ROOT_PREFIX = "$env:USERPROFILE\micromamba-root"
}
& $ResolvedRunner.Command --version *> $null
if ($LASTEXITCODE -ne 0) { throw "The environment runner could not execute: $($ResolvedRunner.Command)" }
Write-Host "Using $($ResolvedRunner.Kind): $($ResolvedRunner.Command)" -ForegroundColor Cyan
Write-Host "Creating isolated environment $EnvName (the existing torch environment is untouched)" -ForegroundColor Cyan

if ($ResolvedRunner.Kind -eq 'micromamba') {
    Invoke-Env $ResolvedRunner @('create', '-y', '-n', $EnvName, '-c', 'conda-forge', 'python=3.11', 'ffmpeg', 'sox', 'libsndfile')
} else {
    Invoke-Env $ResolvedRunner @('create', '-y', '-n', $EnvName, '-c', 'conda-forge', 'python=3.11', 'ffmpeg', 'sox', 'libsndfile')
}

$RunPrefix = @('run', '-n', $EnvName)
Invoke-Env $ResolvedRunner ($RunPrefix + @('python', '-m', 'pip', 'install', '--upgrade', 'pip', 'wheel', 'setuptools'))
Invoke-Env $ResolvedRunner ($RunPrefix + @('python', '-m', 'pip', 'install', '-r', (Join-Path $WorkerRoot 'requirements.txt')))

if ($Engine -ne 'base') {
    Write-Host 'Installing CUDA 13.0 PyTorch with Blackwell sm_120 support...' -ForegroundColor Cyan
    Invoke-Env $ResolvedRunner ($RunPrefix + @('python', '-m', 'pip', 'install', '--upgrade', 'torch', 'torchaudio', '--index-url', 'https://download.pytorch.org/whl/cu130'))
    Invoke-Env $ResolvedRunner ($RunPrefix + @('python', '-m', 'pip', 'install', '--upgrade', 'torchcodec'))
}

if ($Engine -eq 'qwen') {
    Write-Host 'Installing the native-Windows Qwen3-TTS engine...' -ForegroundColor Cyan
    Invoke-Env $ResolvedRunner ($RunPrefix + @('python', '-m', 'pip', 'install', '--upgrade', 'qwen-tts', 'huggingface-hub'))
    if (-not $SkipModelDownload) {
        $TargetRoot = if ($ModelDir) { $ModelDir } else { Join-Path $WorkerRoot 'models' }
        New-Item -ItemType Directory -Force -Path $TargetRoot | Out-Null
        $Target = Join-Path $TargetRoot 'Qwen3-TTS-12Hz-0.6B-Base'
        Invoke-Env $ResolvedRunner ($RunPrefix + @('python', '-c', "import sys; from huggingface_hub import snapshot_download; snapshot_download('Qwen/Qwen3-TTS-12Hz-0.6B-Base', local_dir=sys.argv[1])", $Target))
    }
}

if ($Engine -eq 'cosyvoice') {
    Write-Warning 'CosyVoice officially targets Linux. Follow the README WSL2 path on Windows; native dependencies may fail.'
    $VendorRoot = Join-Path $WorkerRoot 'vendor'
    $Repo = Join-Path $VendorRoot 'CosyVoice'
    New-Item -ItemType Directory -Force -Path $VendorRoot | Out-Null
    if (-not (Test-Path -LiteralPath $Repo)) {
        & git clone --recursive https://github.com/FunAudioLLM/CosyVoice.git $Repo
        if ($LASTEXITCODE -ne 0) { throw 'Failed to clone the CosyVoice repository' }
    }
    $Filtered = Join-Path $ProjectRoot '.runtime\cosyvoice-requirements.txt'
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Filtered) | Out-Null
    Get-Content -LiteralPath (Join-Path $Repo 'requirements.txt') |
        Where-Object { $_ -notmatch '^\s*(torch|torchaudio|flash-attn|deepspeed|xformers)(?:\W|$)' } |
        Set-Content -LiteralPath $Filtered -Encoding UTF8
    Invoke-Env $ResolvedRunner ($RunPrefix + @('python', '-m', 'pip', 'install', '-r', $Filtered))
    if (-not $SkipModelDownload) {
        Invoke-Env $ResolvedRunner ($RunPrefix + @('python', '-m', 'pip', 'install', '--upgrade', 'modelscope'))
        $TargetRoot = if ($ModelDir) { $ModelDir } else { Join-Path $WorkerRoot 'models' }
        $Target = Join-Path $TargetRoot 'Fun-CosyVoice3-0.5B'
        Invoke-Env $ResolvedRunner ($RunPrefix + @('python', '-c', "import sys; from modelscope import snapshot_download; snapshot_download('FunAudioLLM/Fun-CosyVoice3-0.5B-2512', local_dir=sys.argv[1])", $Target))
    }
}

$RuntimeRoot = Join-Path $ProjectRoot '.runtime'
New-Item -ItemType Directory -Force -Path $RuntimeRoot | Out-Null
$EffectiveModelDir = if ($ModelDir) { [System.IO.Path]::GetFullPath($ModelDir) } else { Join-Path $WorkerRoot 'models' }
@{ envName = $EnvName; runner = $ResolvedRunner.Command; modelDir = $EffectiveModelDir } |
    ConvertTo-Json | Set-Content -LiteralPath (Join-Path $RuntimeRoot 'worker.env.json') -Encoding UTF8

Write-Host ''
Write-Host 'Environment is ready. Verification command:' -ForegroundColor Green
Write-Host "$($ResolvedRunner.Command) run -n $EnvName python `"$WorkerRoot\server.py`""
Write-Host 'Run npm start in another terminal, then open http://127.0.0.1:4317'
