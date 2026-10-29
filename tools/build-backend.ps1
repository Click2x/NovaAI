# Build the bundled backend: backend\dist\novaai-server\novaai-server.exe (shipped by electron-builder as resources\backend\novaai-server).
# Uses a throwaway venv in backend\.build-venv so the build does not depend on what is installed globally.
$ErrorActionPreference = 'Stop'
$backend = Join-Path $PSScriptRoot '..\backend' | Resolve-Path
Push-Location $backend
try {
    if (-not (Test-Path .build-venv)) { python -m venv .build-venv }
    $py = Join-Path $backend '.build-venv\Scripts\python.exe'
    & $py -m pip install --quiet --upgrade pip
    & $py -m pip install --quiet -r requirements.txt pyinstaller
    & $py -m PyInstaller --noconfirm --clean --distpath dist --workpath build novaai-server.spec
    if ($LASTEXITCODE -ne 0) { throw "PyInstaller failed ($LASTEXITCODE)" }
    $exe = Join-Path $backend 'dist\novaai-server\novaai-server.exe'
    if (-not (Test-Path $exe)) { throw "missing $exe" }
    Write-Host "built $exe"
} finally { Pop-Location }
