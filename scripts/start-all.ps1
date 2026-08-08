param(
    [string]$EnvName = 'novel-voice',
    [string]$Runner = '',
    [string]$DataDir = '',
    [string]$ModelDir = ''
)

$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $PSScriptRoot

function Resolve-Runner {
    if ($Runner) { return (Resolve-Path -LiteralPath $Runner -ErrorAction Stop).Path }
    if ($env:MAMBA_EXE -and (Test-Path -LiteralPath $env:MAMBA_EXE)) { return $env:MAMBA_EXE }
    foreach ($candidate in @(
        $(if ($env:MAMBA_ROOT_PREFIX) { Join-Path $env:MAMBA_ROOT_PREFIX 'condabin\micromamba.bat' }),
        "$env:USERPROFILE\micromamba-root\condabin\micromamba.bat",
        "$env:USERPROFILE\micromamba\micromamba.exe",
        "$env:USERPROFILE\.local\bin\micromamba.exe",
        "$env:USERPROFILE\bin\micromamba.exe",
        "$env:LOCALAPPDATA\micromamba\micromamba.exe",
        "$env:USERPROFILE\scoop\shims\micromamba.exe"
    )) { if (Test-Path -LiteralPath $candidate) { return $candidate } }
    $command = Get-Command micromamba -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }
    $command = Get-Command conda -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }
    return $null
}

$RuntimeConfigPath = Join-Path $ProjectRoot '.runtime\worker.env.json'
if (Test-Path -LiteralPath $RuntimeConfigPath) {
    $RuntimeConfig = Get-Content -LiteralPath $RuntimeConfigPath -Raw | ConvertFrom-Json
    if (-not $Runner -and $RuntimeConfig.runner) { $Runner = $RuntimeConfig.runner }
    if (-not $ModelDir -and $RuntimeConfig.modelDir) { $ModelDir = $RuntimeConfig.modelDir }
    if ($EnvName -eq 'novel-voice' -and $RuntimeConfig.envName) { $EnvName = $RuntimeConfig.envName }
}
if (-not $env:MAMBA_ROOT_PREFIX -and (Test-Path -LiteralPath "$env:USERPROFILE\micromamba-root")) {
    $env:MAMBA_ROOT_PREFIX = "$env:USERPROFILE\micromamba-root"
}
$ResolvedRunner = Resolve-Runner
$workerJob = $null
if ($ResolvedRunner) {
    $workerScript = Join-Path $ProjectRoot 'worker\server.py'
    $workerJob = Start-Job -ScriptBlock {
        param($runnerPath, $environmentName, $scriptPath, $dataPath, $modelsPath)
        if ($dataPath) { $env:NVS_DATA_DIR = $dataPath }
        if ($modelsPath) { $env:NVS_MODEL_DIR = $modelsPath }
        & $runnerPath run -n $environmentName python $scriptPath
    } -ArgumentList $ResolvedRunner, $EnvName, $workerScript, $DataDir, $ModelDir
    $workerReady = $false
    for ($attempt = 0; $attempt -lt 30; $attempt += 1) {
        Start-Sleep -Milliseconds 700
        if ($workerJob.State -eq 'Failed' -or $workerJob.State -eq 'Completed') { break }
        try {
            $health = Invoke-RestMethod -Uri 'http://127.0.0.1:7861/health' -TimeoutSec 2
            if ($health.ok) { $workerReady = $true; break }
        } catch { }
    }
    if (-not $workerReady) {
        Receive-Job -Job $workerJob -ErrorAction SilentlyContinue
        Stop-Job -Job $workerJob -ErrorAction SilentlyContinue
        Remove-Job -Job $workerJob -Force -ErrorAction SilentlyContinue
        throw "Model worker failed to become healthy. Verify environment '$EnvName' and port 7861."
    }
    Write-Host "Model worker is healthy (environment: $EnvName)" -ForegroundColor Cyan
} else {
    Write-Warning 'micromamba/conda was not found. Starting the UI and Node service without real TTS.'
}

try {
    Push-Location $ProjectRoot
    if ($DataDir) { $env:NVS_DATA_DIR = $DataDir }
    & node 'src/server.js'
} finally {
    Pop-Location
    if ($workerJob) {
        Stop-Job -Job $workerJob -ErrorAction SilentlyContinue
        Receive-Job -Job $workerJob -ErrorAction SilentlyContinue
        Remove-Job -Job $workerJob -Force -ErrorAction SilentlyContinue
    }
}
