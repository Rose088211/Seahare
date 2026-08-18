$ErrorActionPreference = "Stop"
$ProjectRoot = $PSScriptRoot

Push-Location $ProjectRoot
try {
    python -m PyInstaller --version *> $null
    if ($LASTEXITCODE -ne 0) {
        if (Get-Command uv -ErrorAction SilentlyContinue) {
            uv pip install --python python -r backend/requirements-build.txt
        } else {
            python -m ensurepip --upgrade
            python -m pip install -r backend/requirements-build.txt
        }
    }

    powershell -ExecutionPolicy Bypass -File backend/build.ps1
    Push-Location frontend
    try {
        npm ci
        npm run package:dir:fallback
    } finally {
        Pop-Location
    }
} finally {
    Pop-Location
}
