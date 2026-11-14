# @file LatticeDX — Open Digital Enterprise Platform
# @author CTU-OpenPaw
# @license Apache-2.0
# @see https://github.com/CTU-OpenPaw/lattice-dx
# SPDX-License-Identifier: Apache-2.0
[CmdletBinding()]
param([ValidateSet('Start','Stop','Restart')][string]$Mode='Start')
$ErrorActionPreference='Stop'
$desktopExe=Join-Path $env:ProgramFiles 'Docker/Docker/Docker Desktop.exe'
$dockerInstall=[IO.Path]::GetFullPath((Split-Path $desktopExe -Parent))+[IO.Path]::DirectorySeparatorChar
$localRoot=[IO.Path]::GetFullPath($env:LOCALAPPDATA)
$logFile=Join-Path $localRoot 'Docker/log/host/com.docker.backend.exe.log'
function Invoke-Docker([string]$arguments,[int]$timeout=8) {
  $info=New-Object Diagnostics.ProcessStartInfo
  $info.FileName=(Get-Command docker.exe).Source; $info.Arguments=$arguments
  $info.UseShellExecute=$false; $info.CreateNoWindow=$true
  $info.RedirectStandardOutput=$true; $info.RedirectStandardError=$true
  $proc=[Diagnostics.Process]::Start($info)
  $stdout=$proc.StandardOutput.ReadToEndAsync(); $stderr=$proc.StandardError.ReadToEndAsync()
  if(!$proc.WaitForExit($timeout*1000)){$proc.Kill();$proc.WaitForExit();$proc.Dispose();return @{Code=124;Text='Docker CLI timed out'}}
  $result=@{Code=$proc.ExitCode;Text=($stdout.Result+$stderr.Result).Trim()};$proc.Dispose();return $result
}
function Get-DesktopProcesses {
  @(Get-Process -Name 'Docker Desktop','com.docker.backend','docker-ai' -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path.StartsWith($dockerInstall,[StringComparison]::OrdinalIgnoreCase) })
}
function Stop-Desktop {
  if(!(Get-DesktopProcesses).Count){return}
  $result=Invoke-Docker 'desktop stop --timeout 55' 60
  if($result.Code -ne 0){throw "Orderly Docker stop failed: $($result.Text). No running engine was force-stopped."}
  for($i=0;$i -lt 10 -and (Get-DesktopProcesses).Count;$i++){Start-Sleep -Seconds 1}
  if((Get-DesktopProcesses).Count){throw 'Docker processes remain after orderly stop.'}
}
function Repair-KnownSocketFailure {
  # Only exact runtime directories, only after the recognized socket crash, never data disks/volumes.
  $tail=if(Test-Path -LiteralPath $logFile){(Get-Content -LiteralPath $logFile -Tail 120) -join "`n"}else{''}
  if($tail -notmatch '(dockerInference|engine\.sock|sailor-ingest\.sock).*(The file cannot be accessed by the system|filename, directory name, or volume label syntax)'){return $false}
  $health=Invoke-Docker '--context desktop-linux info --format {{.ServerVersion}}' 5
  if($health.Code -eq 0){throw 'Refusing socket repair while Docker engine is available.'}
  # Startup has crashed: stop only verified Docker installation processes, not WSL or other apps.
  Get-DesktopProcesses | Stop-Process -Force
  for($i=0;$i -lt 10 -and (Get-DesktopProcesses).Count;$i++){Start-Sleep -Milliseconds 300}
  if((Get-DesktopProcesses).Count){throw 'Docker processes did not exit; runtime was not moved.'}
  $stamp=Get-Date -Format 'yyyyMMdd-HHmmss-fff'
  $targets=@()
  foreach($relative in @('Docker/run','docker-secrets-engine')){
    $target=[IO.Path]::GetFullPath((Join-Path $localRoot $relative))
    if(!$target.StartsWith($localRoot+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)){throw 'Runtime target outside LOCALAPPDATA'}
    if(Test-Path -LiteralPath $target){
      $item=Get-Item -LiteralPath $target -Force
      if(!$item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)){throw "Unexpected runtime directory: $target"}
      if($relative -eq 'docker-secrets-engine'){
        $unknown=@(Get-ChildItem -LiteralPath $target -Force | Where-Object {$_.Name -ne 'engine.sock' -or $_.PSIsContainer})
        if($unknown.Count){throw 'Secrets runtime contains unknown content; no directories were moved.'}
      }
    }
    $targets+=$target
  }
  foreach($target in $targets){
    if(Test-Path -LiteralPath $target){Rename-Item -LiteralPath $target -NewName ((Split-Path $target -Leaf)+'-stale-'+$stamp)}
    New-Item -ItemType Directory -Path $target | Out-Null
  }
  Write-Host 'Archived stale Docker runtime sockets; persistent Docker data was not changed.'
  return $true
}
if($Mode -in @('Stop','Restart')){Stop-Desktop;if($Mode -eq 'Stop'){Write-Host 'Docker Desktop stopped cleanly.';exit 0}}
$health=Invoke-Docker '--context desktop-linux info --format {{.ServerVersion}}' 5
if($health.Code -eq 0){Write-Host "Docker ready: $($health.Text)";exit 0}
if(!(Test-Path -LiteralPath $desktopExe)){throw 'Docker Desktop installation not found.'}
for($attempt=0;$attempt -lt 2;$attempt++){
  if($attempt -eq 0 -and !(Get-DesktopProcesses).Count){[void](Repair-KnownSocketFailure)}
  $startedAt=[DateTimeOffset]::UtcNow
  $socketCrash=$false
  Start-Process -FilePath $desktopExe -WindowStyle Hidden
  $deadline=(Get-Date).AddSeconds(100)
  do {
    $health=Invoke-Docker '--context desktop-linux info --format {{.ServerVersion}}' 5
    if($health.Code -eq 0){Write-Host "Docker ready: $($health.Text)";exit 0}
    Start-Sleep -Seconds 2
    $tail=if(Test-Path -LiteralPath $logFile){(Get-Content -LiteralPath $logFile -Tail 20) -join "`n"}else{''}
    $crashLines=$tail -split "`n" | Where-Object {$_ -match 'backend (crashed|cancelling with error).*(dockerInference|engine\.sock|sailor-ingest\.sock)'}
    foreach($line in $crashLines){
      if($line -match '^\[([^\]]+)\]'){
        $crashAt=[DateTimeOffset]::MinValue
        if([DateTimeOffset]::TryParse($Matches[1],[ref]$crashAt) -and $crashAt -ge $startedAt){$socketCrash=$true}
      }
    }
    if($socketCrash){break}
  }while((Get-Date) -lt $deadline)
  if($attempt -eq 0 -and $socketCrash -and (Repair-KnownSocketFailure)){continue}
  throw 'Docker did not start. No further repair attempted; inspect Docker host logs.'
}
