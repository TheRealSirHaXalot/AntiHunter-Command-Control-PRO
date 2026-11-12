#Requires -Version 5.1
[CmdletBinding()]
param(
    [string]$AdminEmail = 'admin@example.com',
    [string]$AdminPassword = '',
    [string]$SiteId = '',
    [string]$SiteName = '',
    [string]$SerialPort = '',
    [switch]$SkipBuildTools,
    [switch]$NonInteractive,
    [switch]$NoPause
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$env:NODE_OPTIONS = ('--no-deprecation ' + $env:NODE_OPTIONS).Trim()
try { Start-Transcript -Path (Join-Path $env:TEMP 'ahcc-setup.log') -Append | Out-Null } catch { Write-Host '(log unavailable)' -ForegroundColor DarkGray }

trap {
    Write-Host "`nUNEXPECTED ERROR: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host "at line $($_.InvocationInfo.ScriptLineNumber): $($_.InvocationInfo.Line.Trim())`n" -ForegroundColor DarkGray
    if (-not $NoPause) { Read-Host 'Press Enter to close' }
    exit 1
}

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).ProviderPath
$onNetwork = ($RepoRoot -like '\\*') -or ([Uri]$RepoRoot).IsUnc
if (-not $onNetwork) {
    $driveRoot = [IO.Path]::GetPathRoot($RepoRoot).TrimEnd('\')
    $drv = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='$driveRoot'" -ErrorAction SilentlyContinue
    if ($drv -and $drv.DriveType -eq 4) { $onNetwork = $true }
}
if ($onNetwork) {
    $localRoot = Join-Path $env:USERPROFILE 'AntiHunter'
    Write-Host "      Project is on a network share - Node cannot build or run from there." -ForegroundColor Yellow
    Write-Host "      Copying to $localRoot (local disk); Windows gets its own node_modules..." -ForegroundColor Gray
    New-Item -ItemType Directory -Force -Path $localRoot | Out-Null
    & robocopy $RepoRoot $localRoot /MIR /XD node_modules .git .pnpm-store dist build .turbo /XF *.log .env .pg-superuser /R:1 /W:1 /NFL /NDL /NJH /NJS /NP | Out-Null
    if ($LASTEXITCODE -ge 8) { throw "Could not copy the project to $localRoot (robocopy exit $LASTEXITCODE)." }
    $RepoRoot = $localRoot
    Write-Host "      Working from $localRoot" -ForegroundColor Gray
}
$DbName = 'command_center'; $DbUser = 'command_center'; $DbHost = 'localhost'; $DbPort = '5432'
$BackendPort = '3000'; $FrontendPort = '5173'
$envPath = Join-Path $RepoRoot 'apps\backend\.env'
$wantX64 = ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') -or ($env:PROCESSOR_ARCHITEW6432 -eq 'ARM64')
$ExtraPath = ''

function Step($n, $msg) { Write-Host ("`n[{0}/6] {1}" -f $n, $msg) -ForegroundColor Cyan }
function Info($msg) { Write-Host "      $msg" -ForegroundColor Gray }
function Ok($msg)   { Write-Host "      OK  $msg" -ForegroundColor Green }
function Warn($msg) { Write-Host "      !   $msg" -ForegroundColor Yellow }
function Die($msg)  { Write-Host "`nERROR: $msg`n" -ForegroundColor Red; if (-not $NoPause) { Read-Host 'Press Enter to close' }; exit 1 }

function Test-Admin {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole([Security.Principal.WindowsBuiltinRole]::Administrator)
}
function Update-SessionPath {
    $env:Path = (@([Environment]::GetEnvironmentVariable('Path', 'Machine'), [Environment]::GetEnvironmentVariable('Path', 'User'), $ExtraPath) | Where-Object { $_ }) -join ';'
}
function New-Password([int]$len = 20) {
    $c = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
    -join (1..$len | ForEach-Object { $c[(Get-Random -Maximum $c.Length)] })
}
function Find-Psql {
    $g = Get-Command psql.exe -ErrorAction SilentlyContinue
    if ($g) { return $g.Source }
    foreach ($b in @($env:ProgramFiles, ${env:ProgramFiles(x86)})) {
        if (-not $b) { continue }
        $h = Get-ChildItem (Join-Path $b 'PostgreSQL\*\bin\psql.exe') -ErrorAction SilentlyContinue | Sort-Object FullName -Descending | Select-Object -First 1
        if ($h) { return $h.FullName }
    }
    return $null
}
function Winget-Install($id, $override) {
    $base = @('install', '-e', '--id', $id, '--silent', '--accept-package-agreements', '--accept-source-agreements')
    if ($override) { $base += @('--override', $override) }
    if ($wantX64) {
        $a = $base + @('--architecture', 'x64')
        & winget @a
        if ($LASTEXITCODE -eq 0) { return }
        Warn "No x64-specific build for $id; installing the default architecture..."
    }
    & winget @base
}
function Invoke-Psql($psql, $pass, $db, $sql) {
    $env:PGPASSWORD = $pass
    try { return (& $psql -h $DbHost -p $DbPort -U 'postgres' -d $db -w -v ON_ERROR_STOP=1 -tAc $sql) }
    finally { Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue }
}
function Test-DbConnect($psql, $pass) {
    if (-not $psql -or -not $pass) { return $false }
    $env:PGPASSWORD = $pass
    try { & $psql -h $DbHost -p $DbPort -U $DbUser -d $DbName -w -tAc 'SELECT 1' *> $null; return ($LASTEXITCODE -eq 0) }
    finally { Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue }
}
function Test-NodeOk {
    if (-not (Get-Command node.exe -ErrorAction SilentlyContinue)) { return $false }
    if ([int]((& node --version) -replace 'v', '').Split('.')[0] -lt 22) { return $false }
    if ($wantX64 -and ((& node -p 'process.arch') -ne 'x64')) { return $false }
    return $true
}
function Start-App {
    Update-SessionPath
    Push-Location $RepoRoot
    Write-Host "`nStarting AntiHunter (close this window to stop)`n" -ForegroundColor Green
    & pnpm dev
    Pop-Location
}
function Show-StartInstructions {
    $launcher = Join-Path $RepoRoot 'Start-AntiHunter.cmd'
    Set-Content -Path $launcher -Value "@echo off`r`ntitle AntiHunter`r`ncd /d `"%~dp0`"`r`ncall pnpm AHCC`r`npause`r`n" -Encoding ascii
    Write-Host @"

============================================================
  AntiHunter is installed.  It is NOT running yet.

  TO START IT  (now and every time in future):
     Double-click:   $launcher
        - or -
     In PowerShell:  cd "$RepoRoot"
                     pnpm AHCC            (or  pnpm AHCC:silent  for less output)

  Then open your browser to:   http://localhost:$FrontendPort
============================================================

"@ -ForegroundColor Green
}

if (-not (Test-Path (Join-Path $RepoRoot 'package.json'))) {
    Die "Run this from inside the extracted project folder (no package.json at $RepoRoot)."
}

if ((Test-Path $envPath) -and (Test-Path (Join-Path $RepoRoot 'node_modules'))) {
    Update-SessionPath
    if (Get-Command pnpm -ErrorAction SilentlyContinue) { Show-StartInstructions; if (-not $NoPause) { Read-Host 'Press Enter to close' | Out-Null }; exit }
}

if (-not (Test-Admin)) {
    Die 'Run this in an Administrator PowerShell: search "PowerShell", right-click -> Run as administrator, then run this script again.'
}

Write-Host @'

    AntiHunter Command & Control Pro  -  Windows Setup

'@ -ForegroundColor Blue

if (-not (Get-Command winget.exe -ErrorAction SilentlyContinue)) {
    Die "winget (App Installer) is missing. Install 'App Installer' from the Microsoft Store, then re-run."
}

if (-not $NonInteractive) {
    Write-Host 'Press Enter to accept the [default]:' -ForegroundColor Cyan
    if (-not $PSBoundParameters.ContainsKey('AdminEmail')) {
        do { $r = Read-Host '  Admin email [admin@example.com]'; if (-not $r) { $r = 'admin@example.com' }; $ok = $r -match '^[^@\s]+@[^@\s]+\.[^@\s]+$'; if (-not $ok) { Warn 'Invalid email.' } } until ($ok)
        $AdminEmail = $r
    }
    if (-not $AdminPassword) { $g = New-Password 14; $r = Read-Host "  Admin password [$g]"; $AdminPassword = if ($r) { $r } else { $g } }
    if (-not $SiteId) { $r = Read-Host '  Site ID [default]'; $SiteId = if ($r) { $r } else { 'default' } }
    if (-not $SiteName) { $r = Read-Host "  Site name [$SiteId]"; $SiteName = if ($r) { $r } else { $SiteId } }
    if (-not $SerialPort) { $SerialPort = Read-Host '  Serial COM port, e.g. COM3 (blank = skip)' }
}
if (-not $SiteId) { $SiteId = 'default' }
if (-not $SiteName) { $SiteName = $SiteId }
if (-not $AdminPassword) { $AdminPassword = New-Password 14 }

Step 1 'Node.js 22+'
Update-SessionPath
if (-not (Test-NodeOk)) {
    if ($wantX64 -and (Get-Command node.exe -ErrorAction SilentlyContinue)) {
        Info 'Replacing ARM64 Node with the x64 build...'
        & winget uninstall -e --id OpenJS.NodeJS.LTS --silent 2>$null
        & winget uninstall -e --id OpenJS.NodeJS --silent 2>$null
        Update-SessionPath
    }
    Info 'Installing Node.js LTS...'
    Winget-Install 'OpenJS.NodeJS.LTS'
    Update-SessionPath
    if (-not (Get-Command node.exe -ErrorAction SilentlyContinue)) {
        $ne = Join-Path $env:ProgramFiles 'nodejs\node.exe'
        if (Test-Path $ne) { $ExtraPath = Split-Path $ne; Update-SessionPath }
    }
    if (-not (Test-NodeOk)) { Die 'Node.js (x64) did not install. Install the x64 build from https://nodejs.org and run again.' }
}
Ok "node $(& node --version) $(& node -p 'process.arch')"

Step 2 'pnpm'
$pm = 'pnpm@12.4.2'
try { $pj = Get-Content (Join-Path $RepoRoot 'package.json') -Raw | ConvertFrom-Json; if ($pj.packageManager) { $pm = $pj.packageManager } } catch { Warn "package.json unreadable; using $pm" }
if (Get-Command corepack -ErrorAction SilentlyContinue) {
    & corepack enable 2>$null
    & corepack prepare $pm --activate 2>$null
}
Update-SessionPath
if (-not (Get-Command pnpm -ErrorAction SilentlyContinue) -and -not (Get-Command pnpm.cmd -ErrorAction SilentlyContinue)) {
    & npm install -g $pm 2>$null; Update-SessionPath
}
if (-not (Get-Command pnpm -ErrorAction SilentlyContinue) -and -not (Get-Command pnpm.cmd -ErrorAction SilentlyContinue)) { Die 'pnpm not available; close this window and re-run.' }
Ok "pnpm $(& pnpm --version)"

Step 3 'Installing dependencies'
Push-Location $RepoRoot
& pnpm install
$ok = ($LASTEXITCODE -eq 0)
if (-not $ok) { Warn 'Retrying clean...'; Remove-Item (Join-Path $RepoRoot 'node_modules') -Recurse -Force -ErrorAction SilentlyContinue; & pnpm install; $ok = ($LASTEXITCODE -eq 0) }
if (-not $ok -and -not $SkipBuildTools) {
    Warn 'A native module needs a C++ compiler - installing build tools...'
    & winget install -e --id Microsoft.VisualStudio.2022.BuildTools --silent --accept-package-agreements --accept-source-agreements --override '--quiet --wait --norestart --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended'
    Update-SessionPath; Remove-Item (Join-Path $RepoRoot 'node_modules') -Recurse -Force -ErrorAction SilentlyContinue; & pnpm install; $ok = ($LASTEXITCODE -eq 0)
}
Pop-Location
if (-not $ok) { Die 'pnpm install failed. See the error above.' }
Ok 'Dependencies installed'

Step 4 'PostgreSQL'
$psql = Find-Psql
$superFile = Join-Path $RepoRoot 'apps\backend\.pg-superuser'
$DbPassword = $null; $reuse = $false
if ($psql -and (Test-Path $envPath)) {
    $ln = Select-String -Path $envPath -Pattern 'DATABASE_URL=postgresql://[^:]+:([^@]+)@' -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($ln) { $p = $ln.Matches[0].Groups[1].Value; if (Test-DbConnect $psql $p) { $DbPassword = $p; $reuse = $true; Ok 'Existing database reused' } }
}
if (-not $reuse) {
    $DbPassword = New-Password 20
    if (-not $psql) {
        $SuperPass = if (Test-Path $superFile) { (Get-Content $superFile -Raw).Trim() } else { New-Password 20 }
        $ov = "--mode unattended --unattendedmodeui minimal --superpassword $SuperPass --serverport $DbPort --disable-components pgAdmin,stackbuilder"
        $pgId = $null
        foreach ($v in 17, 16, 18, 15, 14) {
            winget show -e --id "PostgreSQL.PostgreSQL.$v" --source winget *> $null
            if ($LASTEXITCODE -eq 0) { $pgId = "PostgreSQL.PostgreSQL.$v"; break }
        }
        if (-not $pgId) { $pgId = 'PostgreSQL.PostgreSQL.16' }
        Info "Installing $pgId via winget (large download)..."
        Winget-Install $pgId $ov
        for ($i = 0; $i -lt 24 -and -not $psql; $i++) { Start-Sleep 3; Update-SessionPath; $psql = Find-Psql }
        if (-not $psql) { Die 'PostgreSQL did not install via winget. See the messages above.' }
    } elseif (Test-Path $superFile) { $SuperPass = (Get-Content $superFile -Raw).Trim() } else { $SuperPass = $null }

    Get-Service -Name 'postgresql*' -ErrorAction SilentlyContinue | ForEach-Object {
        Set-Service -Name $_.Name -StartupType Automatic -ErrorAction SilentlyContinue
        if ($_.Status -ne 'Running') { Start-Service -Name $_.Name -ErrorAction SilentlyContinue }
    }
    $isready = Join-Path (Split-Path $psql) 'pg_isready.exe'
    $pgUp = $false
    for ($i = 0; $i -lt 30; $i++) { & $isready -h $DbHost -p $DbPort -q 2>$null; if ($LASTEXITCODE -eq 0) { $pgUp = $true; break }; Start-Sleep 2 }
    if (-not $pgUp) { Die "PostgreSQL is installed but not accepting connections on ${DbHost}:${DbPort} (the service may have failed to start)." }

    $authed = $false
    for ($t = 0; $t -lt 3 -and -not $authed; $t++) {
        if (-not $SuperPass) { $sec = Read-Host "      PostgreSQL 'postgres' superuser password" -AsSecureString; $SuperPass = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)) }
        Invoke-Psql $psql $SuperPass 'postgres' 'SELECT 1' | Out-Null
        if ($LASTEXITCODE -eq 0) { $authed = $true } else { Warn 'Wrong password.'; $SuperPass = $null }
    }
    if (-not $authed) { Die "Could not authenticate to PostgreSQL as 'postgres'." }
    New-Item -ItemType Directory -Force -Path (Split-Path $superFile) | Out-Null
    Set-Content -Path $superFile -Value $SuperPass -Encoding ascii
    if ((Invoke-Psql $psql $SuperPass 'postgres' "SELECT 1 FROM pg_roles WHERE rolname='$DbUser'") -eq '1') {
        Invoke-Psql $psql $SuperPass 'postgres' "ALTER ROLE $DbUser WITH LOGIN PASSWORD '$DbPassword'" | Out-Null
    } else {
        Invoke-Psql $psql $SuperPass 'postgres' "CREATE ROLE $DbUser WITH LOGIN PASSWORD '$DbPassword' CREATEDB" | Out-Null
    }
    if ((Invoke-Psql $psql $SuperPass 'postgres' "SELECT 1 FROM pg_database WHERE datname='$DbName'") -ne '1') {
        Invoke-Psql $psql $SuperPass 'postgres' "CREATE DATABASE $DbName OWNER $DbUser" | Out-Null
    }
    if (-not (Test-DbConnect $psql $DbPassword)) { Die 'Created the database role but cannot connect with it.' }
}
Ok "Database ready at ${DbHost}:${DbPort}/${DbName}"

Step 5 'Backend .env'
$databaseUrl = "postgresql://${DbUser}:${DbPassword}@${DbHost}:${DbPort}/${DbName}"
$envText = @"
# AntiHunter Command Center - Backend Configuration

DATABASE_URL=$databaseUrl
PORT=$BackendPort
HTTPS_ENABLED=false
HTTP_PREFIX=api
LOG_LEVEL=info

SITE_ID=$SiteId
SITE_NAME=$SiteName

"@
if ($SerialPort) {
    $envText += @"
SERIAL_DEVICE=$SerialPort
SERIAL_BAUD=115200
SERIAL_DATA_BITS=8
SERIAL_PARITY=none
SERIAL_STOP_BITS=1
SERIAL_PROTOCOL=meshtastic-rewrite

"@
}
$envText += @"
ALLOW_FOREVER=true
ALLOW_ERASE_FORCE=false
FPV_DECODER_ENABLED=true
DRONES_RECORD_INVENTORY=true
CLUSTER_WORKERS=1
"@
New-Item -ItemType Directory -Force -Path (Split-Path $envPath) | Out-Null
Set-Content -Path $envPath -Value $envText -Encoding ascii
Ok "Wrote $envPath"

Step 6 'Database schema + seed'
Push-Location $RepoRoot
$env:DATABASE_URL = $databaseUrl
& pnpm -C apps/backend prisma:generate; if ($LASTEXITCODE -ne 0) { Pop-Location; Die 'prisma generate failed.' }
& pnpm -C apps/backend prisma:migrate; if ($LASTEXITCODE -ne 0) { Pop-Location; Die 'prisma migrate failed.' }
$env:ADMIN_EMAIL = $AdminEmail; $env:ADMIN_PASSWORD = $AdminPassword
& pnpm -C apps/backend prisma:seed; $seedOk = ($LASTEXITCODE -eq 0)
Pop-Location
if ($seedOk) { Ok 'Migrated and admin user seeded' } else { Warn 'Seed reported an issue (admin user may already exist).' }

Write-Host @"

============================================================
  Setup complete.  Log in with:
     Email:     $AdminEmail
     Password:  $AdminPassword
============================================================

"@ -ForegroundColor Green

Show-StartInstructions
if (-not $NoPause) { Read-Host 'Press Enter to close' | Out-Null }
