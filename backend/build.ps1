$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot

Push-Location $ProjectRoot
try {
    python -m PyInstaller --noconfirm --clean backend/seahare_backend.spec
    Write-Host "Backend executable: $ProjectRoot\dist\seahare-backend.exe"
} finally {
    Pop-Location
}
