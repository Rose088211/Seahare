param(
    [string]$OutputName = "..\release\Seahare"
)

$ErrorActionPreference = "Stop"

$FrontendRoot = Split-Path -Parent $PSScriptRoot
$ProjectRoot = Split-Path -Parent $FrontendRoot
$OutputDir = Join-Path $FrontendRoot $OutputName
$ElectronRuntime = Join-Path $FrontendRoot "node_modules\electron\dist"
$BackendExe = Join-Path $ProjectRoot "dist\seahare-backend.exe"

if (-not (Test-Path -LiteralPath $ElectronRuntime)) {
    $ElectronInstaller = Join-Path $FrontendRoot "node_modules\electron\install.js"
    if (-not (Test-Path -LiteralPath $ElectronInstaller)) {
        throw "Electron package not found. Run npm install in frontend first."
    }
    Push-Location $FrontendRoot
    try {
        node $ElectronInstaller
        if ($LASTEXITCODE -ne 0) { throw "Electron runtime installation failed." }
    } finally {
        Pop-Location
    }
}
if (-not (Test-Path -LiteralPath $ElectronRuntime)) {
    throw "Electron runtime is still missing after running its installer."
}
if (-not (Test-Path -LiteralPath $BackendExe)) {
    throw "Backend executable not found. Run backend/build.ps1 first."
}

if (Test-Path -LiteralPath $OutputDir) {
    $resolvedOutput = (Resolve-Path -LiteralPath $OutputDir).Path
    $resolvedProject = (Resolve-Path -LiteralPath $ProjectRoot).Path
    if (-not $resolvedOutput.StartsWith($resolvedProject + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to remove output outside project: $resolvedOutput"
    }
    try {
        Remove-Item -LiteralPath $resolvedOutput -Recurse -Force
    } catch {
        Write-Host "WARNING: Output directory is partially locked (some files may be in use). Proceeding with overwrite..."
    }
}

$AppDir = Join-Path $OutputDir "resources\app"
$BackendDir = Join-Path $OutputDir "resources\backend"
New-Item -ItemType Directory -Path $AppDir, $BackendDir -Force | Out-Null
try {
    Copy-Item -Path (Join-Path $ElectronRuntime "*") -Destination $OutputDir -Recurse -Force
} catch {
    Write-Host "WARNING: Some Electron runtime files are locked, copying individually..."
    Get-ChildItem -Path (Join-Path $ElectronRuntime "*") -Force | ForEach-Object {
        $target = Join-Path $OutputDir $_.Name
        try { Copy-Item -LiteralPath $_.FullName -Destination $target -Recurse -Force } catch {}
    }
}
Copy-Item -Path (Join-Path $FrontendRoot "dist") -Destination $AppDir -Recurse -Force
Copy-Item -Path (Join-Path $FrontendRoot "electron") -Destination $AppDir -Recurse -Force
Copy-Item -LiteralPath (Join-Path $FrontendRoot "package.json") -Destination $AppDir -Force
Copy-Item -LiteralPath $BackendExe -Destination (Join-Path $BackendDir "seahare-backend.exe") -Force

# Copy node-pty for PTY helper (required at runtime, not in node_modules in production)
$NodePtySrc = Join-Path $FrontendRoot "node_modules\node-pty"
$AppNodeModules = Join-Path $AppDir "node_modules"
$AppNodePty = Join-Path $AppNodeModules "node-pty"
if (Test-Path -LiteralPath $NodePtySrc) {
    New-Item -ItemType Directory -Path $AppNodeModules -Force | Out-Null
    Write-Host "Copying node-pty to $AppNodePty..."
    # Copy node-pty file by file to skip locked files from old build
    Get-ChildItem -Path $NodePtySrc -Recurse -Force | ForEach-Object {
        $relative = $_.FullName.Substring($NodePtySrc.Length).TrimStart([IO.Path]::DirectorySeparatorChar)
        $target = Join-Path $AppNodePty $relative
        if ($_.PSIsContainer) {
            New-Item -ItemType Directory -Path $target -Force | Out-Null
        } else {
            try { Copy-Item -LiteralPath $_.FullName -Destination $target -Force } catch {}
        }
    }
    Write-Host "node-pty copy complete"
} else {
    Write-Host "WARNING: node-pty not found at $NodePtySrc"
}

$ElectronExe = Join-Path $OutputDir "electron.exe"
$SeahareExe = Join-Path $OutputDir "Seahare.exe"
try {
    Copy-Item -LiteralPath $ElectronExe -Destination $SeahareExe -Force
    try { Remove-Item -LiteralPath $ElectronExe -Force } catch { Write-Host "WARNING: could not remove electron.exe" }
} catch {
    Write-Host "WARNING: Seahare.exe is locked, keeping electron.exe as fallback"
}

# Embed the Seahare brand icon into the exe.
$Rcedit = Join-Path $FrontendRoot "node_modules\electron-winstaller\vendor\rcedit.exe"
$Icon = Join-Path $FrontendRoot "build\icon.ico"
if ((Test-Path -LiteralPath $Rcedit) -and (Test-Path -LiteralPath $Icon)) {
    & $Rcedit $SeahareExe --set-icon $Icon | Out-Null
    if ($LASTEXITCODE -ne 0) { Write-Host "WARNING: failed to embed icon into Seahare.exe" }
} else {
    Write-Host "WARNING: rcedit or icon.ico missing, skipping icon embed"
}

Write-Host "Desktop directory package: $SeahareExe"
