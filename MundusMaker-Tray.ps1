# MundusMaker tray launcher: starts the local server without a window and puts
# a MundusMaker icon in the Windows tray with Open, data folder, log and Quit.
# Start-MundusMaker.bat runs this; MundusMaker-Console.bat runs the server in a
# visible window instead. Keep this file ASCII-only: Windows PowerShell 5.1
# reads BOM-less UTF-8 as ANSI.
#
#   powershell -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File MundusMaker-Tray.ps1

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

$root = $PSScriptRoot
$logPath = Join-Path $root 'logs\mundusmaker.log'

# Same port precedence as the server: PORT, then the first readable config file.
$port = 4870
foreach ($name in @('mundusmaker.config.json', 'tomeweaver.config.json', 'loreweave.config.json')) {
  $cfgPath = Join-Path $root $name
  if (-not (Test-Path $cfgPath)) { continue }
  try {
    $cfg = Get-Content $cfgPath -Raw | ConvertFrom-Json
    if ($cfg.port) { $port = [int]$cfg.port }
    break
  } catch { }
}
if ($env:PORT) { $port = [int]$env:PORT }
$url = "http://localhost:$port"

function Show-Message($text, $kind) {
  [void][System.Windows.Forms.MessageBox]::Show($text, 'MundusMaker', 'OK', $kind)
}

# Talks to the local server directly, never through a proxy.
function Invoke-Local($method, $path) {
  $req = [System.Net.HttpWebRequest]::Create("$url$path")
  $req.Method = $method
  $req.Proxy = $null
  $req.Timeout = 3000
  if ($method -eq 'POST') {
    $bytes = [Text.Encoding]::ASCII.GetBytes('{}')
    $req.ContentType = 'application/json'
    $req.ContentLength = $bytes.Length
    $stream = $req.GetRequestStream()
    $stream.Write($bytes, 0, $bytes.Length)
    $stream.Close()
  }
  $res = $req.GetResponse()
  try { return (New-Object IO.StreamReader($res.GetResponseStream())).ReadToEnd() } finally { $res.Close() }
}

# When the server refuses to start, its last log lines say why.
function Get-LogReason {
  if (-not (Test-Path $logPath)) { return '' }
  $lines = Get-Content $logPath -Tail 12 | ForEach-Object { $_ -replace '^\S+\s+\[mundusmaker\]\s*', '' }
  return (($lines | Where-Object { $_ -match 'Port |did not start|Quit the other|Close that program' }) -join "`r`n")
}

$node = @((Join-Path $root 'runtime\MundusMaker.exe'), (Join-Path $root 'runtime\node.exe')) |
  Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $node) {
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($cmd) { $node = $cmd.Source }
}
if (-not $node) {
  Show-Message 'MundusMaker needs its bundled runtime or an installed Node.js. Double-click MundusMaker-Console.bat for setup help.' 'Warning'
  exit 1
}

# The server opens the browser itself once it is ready, or opens the copy that
# is already running and exits. Its messages go to logs\mundusmaker.log.
$script:child = Start-Process -FilePath $node -ArgumentList 'server.js', '--log' -WorkingDirectory $root -WindowStyle Hidden -PassThru
$null = $script:child.Handle # PowerShell 5.1 only reports ExitCode for a process whose handle was read
$script:quitting = $false

$icon = New-Object System.Windows.Forms.NotifyIcon
try { $icon.Icon = New-Object System.Drawing.Icon (Join-Path $root 'public\favicon.ico') }
catch { $icon.Icon = [System.Drawing.SystemIcons]::Application }
$icon.Text = 'MundusMaker'

$menu = New-Object System.Windows.Forms.ContextMenuStrip
[void]$menu.Items.Add('Open MundusMaker', $null, { Start-Process $url })
[void]$menu.Items.Add('Open data folder', $null, {
  try { $status = Invoke-Local 'GET' '/api/status' | ConvertFrom-Json; Start-Process explorer.exe $status.dataDir }
  catch { Start-Process explorer.exe $root }
})
[void]$menu.Items.Add('Open log', $null, {
  if (Test-Path $logPath) { Start-Process notepad.exe $logPath } else { Start-Process explorer.exe $root }
})
[void]$menu.Items.Add('-')
[void]$menu.Items.Add('Quit MundusMaker', $null, {
  $script:quitting = $true
  # Saves already in progress finish before the server stops.
  try { [void](Invoke-Local 'POST' '/api/quit') }
  catch { if (-not $script:child.HasExited) { Stop-Process -Id $script:child.Id -Force } }
})
$icon.ContextMenuStrip = $menu
$icon.add_DoubleClick({ Start-Process $url })
$icon.Visible = $true

# The server exits on Quit (from here or from the app), when a copy is already
# running (it opened that one), or when it cannot start.
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 500
$timer.add_Tick({
  if (-not $script:child.HasExited) { return }
  $timer.Stop()
  $icon.Visible = $false
  $code = $script:child.ExitCode
  if ($code -eq 3) {
    Show-Message ("Another MundusMaker is already using port $port, so this one did not start.`r`n`r`n" + (Get-LogReason)) 'Warning'
  } elseif ($code -eq 4) {
    Show-Message ("Another program is using port $port, so MundusMaker could not start.`r`n`r`n" + (Get-LogReason)) 'Warning'
  } elseif ($code -ne 0 -and -not $script:quitting) {
    $answer = [System.Windows.Forms.MessageBox]::Show("MundusMaker stopped unexpectedly. Your saved worlds are safe.`r`n`r`nOpen the log to see why?", 'MundusMaker', 'YesNo', 'Warning')
    if ($answer -eq 'Yes' -and (Test-Path $logPath)) { Start-Process notepad.exe $logPath }
  }
  [System.Windows.Forms.Application]::Exit()
})
$timer.Start()

[System.Windows.Forms.Application]::Run()
$icon.Dispose()
