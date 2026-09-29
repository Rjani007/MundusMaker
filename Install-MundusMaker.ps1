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

# A running MundusMaker holds its files open. Ask the copy in a folder to quit
# (saves in progress finish first) and wait until its port is free.
function Stop-MundusMakerIn($dir) {
  $port = 4870
  foreach ($name in @('mundusmaker.config.json', 'tomeweaver.config.json', 'loreweave.config.json')) {
    $cfgPath = Join-Path $dir $name
    if (-not (Test-Path $cfgPath)) { continue }
    try { $cfg = Get-Content $cfgPath -Raw | ConvertFrom-Json; if ($cfg.port) { $port = [int]$cfg.port }; break } catch { }
  }
  try {
    $req = [System.Net.HttpWebRequest]::Create("http://localhost:$port/api/status")
    $req.Proxy = $null; $req.Timeout = 2000
    $res = $req.GetResponse()
    $status = (New-Object IO.StreamReader($res.GetResponseStream())).ReadToEnd() | ConvertFrom-Json
    $res.Close()
  } catch { return }
  # the server reports its config file, which lives in its app folder; older
  # versions are recognized by their data folder instead
  $appDir = [IO.Path]::GetFullPath($dir).TrimEnd('')
  $sameApp = ($status.configPath -and ([IO.Path]::GetFullPath((Split-Path $status.configPath)).TrimEnd('') -ieq $appDir)) -or
    ([IO.Path]::GetFullPath($status.dataDir).TrimEnd('') -ieq [IO.Path]::GetFullPath((Join-Path $dir 'data')).TrimEnd(''))
  if (-not $sameApp) { return }
  Write-Host 'Stopping the MundusMaker that is running from this folder...'
  try {
    $req = [System.Net.HttpWebRequest]::Create("http://localhost:$port/api/quit")
    $req.Method = 'POST'; $req.Proxy = $null; $req.Timeout = 3000; $req.ContentType = 'application/json'
    $bytes = [Text.Encoding]::ASCII.GetBytes('{}'); $req.ContentLength = $bytes.Length
    $stream = $req.GetRequestStream(); $stream.Write($bytes, 0, $bytes.Length); $stream.Close()
    $req.GetResponse().Close()
  } catch { Write-Host 'It did not answer; quit it from its tray icon, then run this again.'; exit 1 }
  for ($i = 0; $i -lt 40; $i++) {
    $c = New-Object Net.Sockets.TcpClient
    try { $c.Connect('127.0.0.1', $port); $c.Close(); Start-Sleep -Milliseconds 250 } catch { return }
  }
}

# Normalize for a same-folder check; installing onto itself just refreshes shortcuts.
$srcFull = [IO.Path]::GetFullPath($src).TrimEnd('\')
$dstFull = [IO.Path]::GetFullPath($InstallDir).TrimEnd('\')
$samePlace = $srcFull -ieq $dstFull

if (-not $samePlace) {
  if (Test-Path $InstallDir) { Stop-MundusMakerIn $InstallDir }
  Write-Host "Installing MundusMaker to $InstallDir ..."
  New-Item -ItemType Directory -Force $InstallDir | Out-Null
  # dev-only folders stay behind; data/ is handled separately below
  $skip = @('.git', 'node_modules', 'dist', '.agents', '.claude', 'data', 'logs', 'tmp')
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
  # the tray host runs hidden: no console window to close by mistake
  $lnk.TargetPath = Join-Path $env:SystemRoot 'System32WindowsPowerShell1.0powershell.exe'
  $lnk.Arguments = '-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + (Join-Path $InstallDir 'MundusMaker-Tray.ps1') + '"'
  $lnk.WindowStyle = 7
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
try {
  $req = [System.Net.HttpWebRequest]::Create('http://localhost:4870/api/status')
  $req.Proxy = $null; $req.Timeout = 2000
  $res = $req.GetResponse(); $status = (New-Object IO.StreamReader($res.GetResponseStream())).ReadToEnd() | ConvertFrom-Json; $res.Close()
  $appDir = [IO.Path]::GetFullPath($here).TrimEnd('')
  if (($status.configPath -and ([IO.Path]::GetFullPath((Split-Path $status.configPath)).TrimEnd('') -ieq $appDir)) -or
      ([IO.Path]::GetFullPath($status.dataDir).TrimEnd('') -ieq [IO.Path]::GetFullPath((Join-Path $here 'data')).TrimEnd(''))) {
    Write-Host 'Stopping MundusMaker first (saves in progress finish)...'
    $req = [System.Net.HttpWebRequest]::Create('http://localhost:4870/api/quit')
    $req.Method = 'POST'; $req.Proxy = $null; $req.Timeout = 3000; $req.ContentType = 'application/json'; $req.ContentLength = 2
    $stream = $req.GetRequestStream(); $stream.Write([byte[]](123, 125), 0, 2); $stream.Close(); $req.GetResponse().Close()
    Start-Sleep -Seconds 3
  }
} catch { }
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
Write-Host 'Done. Launch MundusMaker from the Start Menu. It runs in the background with an'
Write-Host 'icon in the Windows tray; quit it from that icon or from Settings in the app.'
Write-Host "To remove it later: powershell -ExecutionPolicy Bypass -File `"$InstallDir\Uninstall-MundusMaker.ps1`""
