# Seahare Terminal PowerShell Profile

function global:ls {
  param(
    [string]$Path,
    [switch]$Force,
    [switch]$Recurse
  )
  $params = @{}
  if ($Path) { $params['Path'] = $Path }
  if ($Force) { $params['Force'] = $true }
  if ($Recurse) { $params['Recurse'] = $true }
  Get-ChildItem @params | ForEach-Object {
    $n = $_.Name
    $esc = [char]27
    $color = ''
    if ($_.PSIsContainer) { $color = '94' }
    elseif ($n -match '\.(exe|bat|cmd|ps1|psm1|vbs|py|com|msi)') { $color = '92' }
    elseif ($n -match '\.(zip|rar|7z|tar|gz|bz2)') { $color = '91' }
    elseif ($n -match '\.(jpg|jpeg|png|gif|bmp|svg|ico|webp)') { $color = '95' }
    elseif ($n -match '\.(md|txt|log|ini|cfg|conf|json|xml|yaml|yml)') { $color = '93' }
    $result = $n
    if ($color) { $result = $esc + '[' + $color + 'm' + $n + $esc + '[0m' }
    $result
  }
}

try { Set-PSReadLineOption -Colors @{Command='Green';Parameter='White';Variable='Cyan';String='Yellow';Number='Magenta'} -ErrorAction SilentlyContinue } catch {}

Set-Alias -Name ll -Value Get-ChildItem -Scope Global -ErrorAction SilentlyContinue