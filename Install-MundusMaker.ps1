# Installs MundusMaker for the current user: copies the app to a stable
# location, creates Start Menu and Desktop shortcuts with the app icon, and
# writes an uninstaller. No admin rights needed. Your data is never deleted;
# an existing data folder in this app folder is carried along (the original
# stays behind as a backup copy).
#
#   Install-MundusMaker.bat            - double-click friendly wrapper
#   -InstallDir <path>                 - install somewhere else
#   -NoDesktopShortcut                 - skip the desktop shortcut

param(
  [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'Programs\MundusMaker'),
  [switch]$NoDesktopShortcut
)

$ErrorActionPreference = 'Stop'
$src = $PSScriptRoot

if (-not (Test-Path (Join-Path $src 'server.js'))) {
  Write-Host 'Run this from the MundusMaker folder (next to server.js).'
  exit 1
}

# Normalize for a same-folder check; installing onto itself just refreshes shortcuts.
$srcFull = [IO.Path]::GetFullPath($src).TrimEnd('\')
$dstFull = [IO.Path]::GetFullPath($InstallDir).TrimEnd('\')
$samePlace = $srcFull -ieq $dstFull

if (-not $samePlace) {
  Write-Host "Installing MundusMaker to $InstallDir ..."
  New-Item -ItemType Directory -Force $InstallDir | Out-Null
  # dev-only folders stay behind; data/ is handled separately below
  $skip = @('.git', 'node_modules', 'dist', '.agents', '.claude', 'data')
  Get-ChildItem $src -Force | Where-Object { $skip -notcontains $_.Name } | ForEach-Object {
    if ($_.PSIsContainer) {
      Copy-Item $_.FullName -Destination (Join-Path $InstallDir $_.Name) -Recurse -Force
    } else {
      Copy-Item $_.FullName -Destination $InstallDir -Force
    }
  }
  $srcData = Join-Path $src 'data'
  $dstData = Join-Path $InstallDir 'data'
  if ((Test-Path $srcData) -and -not (Test-Path $dstData)) {
    Write-Host 'Carrying your existing worlds along (the copy here stays as a backup)...'
    Copy-Item $srcData -Destination $dstData -Recurse -Force
  }
}

# ---------- shortcuts ----------
$shell = New-Object -ComObject WScript.Shell
$ico = (Join-Path $InstallDir 'public\favicon.ico') + ',0'

function New-AppShortcut {
  param($LnkPath)
  $lnk = $shell.CreateShortcut($LnkPath)
  $lnk.TargetPath = Join-Path $InstallDir 'Start-MundusMaker.bat'
  $lnk.WorkingDirectory = $InstallDir
  $lnk.IconLocation = $ico
  $lnk.Description = 'MundusMaker - local worldbuilding wiki for game masters'
  $lnk.Save()
}

$startMenuLnk = Join-Path ([Environment]::GetFolderPath('Programs')) 'MundusMaker.lnk'
New-AppShortcut $startMenuLnk
Write-Host "Start Menu shortcut: $startMenuLnk"

if (-not $NoDesktopShortcut) {
  $desktopLnk = Join-Path ([Environment]::GetFolderPath('Desktop')) 'MundusMaker.lnk'
  New-AppShortcut $desktopLnk
  Write-Host "Desktop shortcut:    $desktopLnk"
}

# ---------- uninstaller ----------
# Lives inside the install dir, so at run time its $PSScriptRoot IS the
# install dir - no paths need to be baked in. Data and config always survive.
$uninstall = @'
# Removes MundusMaker (app files and shortcuts). Your data folder and
# mundusmaker.config.json are kept - delete them yourself if you want them gone.
$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
foreach ($name in @('MundusMaker.lnk')) {
  foreach ($dir in @([Environment]::GetFolderPath('Programs'), [Environment]::GetFolderPath('Desktop'))) {
    $lnk = Join-Path $dir $name
    if (Test-Path $lnk) { Remove-Item $lnk -Force }
  }
}
Get-ChildItem $here -Force |
  Where-Object { $_.Name -ne 'data' -and $_.Name -notlike '*.config.json' -and $_.Name -ne 'Uninstall-MundusMaker.ps1' } |
  Remove-Item -Recurse -Force
if (Test-Path (Join-Path $here 'data')) {
  Write-Host "MundusMaker is removed. Your worlds are still in $(Join-Path $here 'data')."
} else {
  try {
    Remove-Item (Join-Path $here 'Uninstall-MundusMaker.ps1') -Force
    Set-Location (Split-Path $here)
    Remove-Item $here -Force
  } catch { }
  Write-Host 'MundusMaker is removed.'
}
'@
Set-Content -Path (Join-Path $InstallDir 'Uninstall-MundusMaker.ps1') -Value $uninstall -Encoding Ascii

Write-Host ''
Write-Host 'Done. Launch MundusMaker from the Start Menu.'
Write-Host 'Tip: for a tray icon instead of a console window, run MundusMaker-Tray.ps1.'
Write-Host "To remove it later: powershell -ExecutionPolicy Bypass -File `"$InstallDir\Uninstall-MundusMaker.ps1`""
