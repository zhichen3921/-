param(
  [Parameter(Mandatory = $true)]
  [string]$ProjectRoot
)

$ErrorActionPreference = 'Stop'
$deskProject = [System.IO.Path]::GetFullPath($ProjectRoot).TrimEnd(
  [System.IO.Path]::DirectorySeparatorChar,
  [System.IO.Path]::AltDirectorySeparatorChar
)
$deskBaseUrl = 'http://127.0.0.1:43127'
$deskHealthUrl = "$deskBaseUrl/api/health"
$deskServerEntry = [System.IO.Path]::GetFullPath(
  (Join-Path $deskProject 'server\server.mjs')
)

function Test-ApplicationDeskHealth {
  try {
    $deskHealth = Invoke-RestMethod -Uri $deskHealthUrl -Method Get -TimeoutSec 2
    return ($deskHealth.ok -eq $true -and $deskHealth.host -eq '127.0.0.1')
  } catch {
    return $false
  }
}

if (-not (Test-ApplicationDeskHealth)) {
  $deskNode = (Get-Command node.exe -ErrorAction Stop).Source
  $deskLogDirectory = Join-Path $deskProject 'logs'
  New-Item -ItemType Directory -Path $deskLogDirectory -Force | Out-Null
  $deskOutputLog = Join-Path $deskLogDirectory 'server.stdout.log'
  $deskErrorLog = Join-Path $deskLogDirectory 'server.stderr.log'

  Start-Process `
    -FilePath $deskNode `
    -ArgumentList @("`"$deskServerEntry`"") `
    -WorkingDirectory $deskProject `
    -WindowStyle Hidden `
    -RedirectStandardOutput $deskOutputLog `
    -RedirectStandardError $deskErrorLog

  $deskReady = $false
  for ($deskAttempt = 0; $deskAttempt -lt 40; $deskAttempt += 1) {
    if (Test-ApplicationDeskHealth) {
      $deskReady = $true
      break
    }
    Start-Sleep -Milliseconds 250
  }

  if (-not $deskReady) {
    throw 'The local application desk service did not start within 10 seconds. Check logs/server.stderr.log.'
  }
}

$deskBootstrap = Invoke-RestMethod -Uri "$deskBaseUrl/api/bootstrap" -Method Get -TimeoutSec 3
if ([string]::IsNullOrWhiteSpace([string]$deskBootstrap.token)) {
  throw 'The local service did not return a migration token.'
}

$deskReturnUrl = "$deskBaseUrl/"
$deskState = Invoke-RestMethod -Uri "$deskBaseUrl/api/state" -Method Get -TimeoutSec 3
$deskMigrationSources = @($deskState.state.updates.legacyMigrationSources)

if ($deskMigrationSources -contains 'applicationDesk.v2') {
  $deskLaunchUrl = $deskReturnUrl
} else {
  $deskIndexPath = [System.IO.Path]::GetFullPath((Join-Path $deskProject 'index.html'))
  $deskFileUrl = ([System.Uri]::new($deskIndexPath)).AbsoluteUri
  $deskFragment = @(
    'migrationBridge=1'
    'token=' + [System.Uri]::EscapeDataString([string]$deskBootstrap.token)
    'baseUrl=' + [System.Uri]::EscapeDataString($deskBaseUrl)
    'returnUrl=' + [System.Uri]::EscapeDataString($deskReturnUrl)
  ) -join '&'
  $deskLaunchUrl = "$deskFileUrl?legacyBridge=1&migration-bridge=1#$deskFragment"
}

$deskEdgeCandidates = @()
if (${env:ProgramFiles(x86)}) {
  $deskEdgeCandidates += Join-Path ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application\msedge.exe'
}
if ($env:ProgramFiles) {
  $deskEdgeCandidates += Join-Path $env:ProgramFiles 'Microsoft\Edge\Application\msedge.exe'
}
if ($env:LOCALAPPDATA) {
  $deskEdgeCandidates += Join-Path $env:LOCALAPPDATA 'Microsoft\Edge\Application\msedge.exe'
}

$deskEdge = $deskEdgeCandidates |
  Where-Object { $_ -and (Test-Path -LiteralPath $_ -PathType Leaf) } |
  Select-Object -First 1
if (-not $deskEdge) {
  throw 'Microsoft Edge was not found.'
}

$deskProfile = [System.IO.Path]::GetFullPath((Join-Path $deskProject '.boss-edge-profile'))
$deskEdgeArguments = @(
  ('--user-data-dir="{0}"' -f $deskProfile),
  '--no-first-run',
  '--new-window',
  $deskLaunchUrl
)
Start-Process -FilePath $deskEdge -ArgumentList $deskEdgeArguments
