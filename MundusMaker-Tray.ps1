# Optional tray launcher: starts the local server hidden and puts a
# MundusMaker icon in the system tray with Open / Data folder / Exit.
# Start-MundusMaker.bat remains the plain, always-works way to launch.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File MundusMaker-Tray.ps1

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$root = $PSScriptRoot
$port = 4870
$cfgPath = Join-Path $root 'mundusmaker.config.json'
if (Test-Path $cfgPath) {
  try {
    $cfg = Get-Content $cfgPath -Raw | ConvertFrom-Json
    if ($cfg.port) { $port = [int]$cfg.port }
  } catch { }
}
$url = "http://localhost:$port"

function Test-PortOpen {
  param($p)
  $c = New-Object Net.Sockets.TcpClient
  try { $c.Connect('127.0.0.1', $p); return $true } catch { return $false } finally { $c.Close() }
}

# Reuse a server that is already running (same single-instance feel as the bat).
$script:child = $null
if (-not (Test-PortOpen $port)) {
  $node = @((Join-Path $root 'runtime\MundusMaker.exe'), (Join-Path $root 'runtime\node.exe')) |
    Where-Object { Test-Path $_ } | Select-Object -First 1
  if (-not $node) {
    $cmd = Get-Command node -ErrorAction SilentlyContinue
    if ($cmd) { $node = $cmd.Source }
  }
  if (-not $node) {
    [System.Windows.Forms.MessageBox]::Show('MundusMaker needs its bundled runtime or an installed Node.js. Run Start-MundusMaker.bat once for setup help.', 'MundusMaker') | Out-Null
    exit 1
  }
  $script:child = Start-Process -FilePath $node -ArgumentList 'server.js', '--no-open' -WorkingDirectory $root -WindowStyle Hidden -PassThru
  for ($i = 0; $i -lt 40; $i++) {
    if (Test-PortOpen $port) { break }
    Start-Sleep -Milliseconds 250
  }
}

$icon = New-Object System.Windows.Forms.NotifyIcon
$icoPath = Join-Path $root 'public\favicon.ico'
try { $icon.Icon = New-Object System.Drawing.Icon($icoPath) }
catch { $icon.Icon = [System.Drawing.SystemIcons]::Application }
$icon.Text = 'MundusMaker'

$menu = New-Object System.Windows.Forms.ContextMenuStrip
[void]$menu.Items.Add('Open MundusMaker', $null, { Start-Process $url })
[void]$menu.Items.Add('Open data folder', $null, {
  try {
    $s = Invoke-RestMethod "$url/api/status"
    Start-Process explorer.exe $s.dataDir
  } catch { Start-Process explorer.exe $root }
})
[void]$menu.Items.Add('-')
[void]$menu.Items.Add('Exit (stops the server)', $null, {
  $icon.Visible = $false
  if ($script:child -and -not $script:child.HasExited) { Stop-Process -Id $script:child.Id -Force }
  [System.Windows.Forms.Application]::Exit()
})
$icon.ContextMenuStrip = $menu
$icon.add_DoubleClick({ Start-Process $url })
$icon.Visible = $true

Start-Process $url
[System.Windows.Forms.Application]::Run()
$icon.Dispose()
