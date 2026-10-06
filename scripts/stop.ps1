$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$record = Join-Path $root '.local-server.json'
if (-not (Test-Path -LiteralPath $record)) { Write-Host 'This server was not started by the launcher. Stop it with Ctrl+C in its original terminal.'; exit 1 }
$metadata = Get-Content -LiteralPath $record -Raw | ConvertFrom-Json
if ($metadata.root -ne $root) { throw 'Server record does not match this project.' }
$process = Get-CimInstance Win32_Process -Filter ('ProcessId=' + [int]$metadata.pid)
$server = $(if ($metadata.backend -eq 'node') { Join-Path $root 'server.mjs' } else { Join-Path $root 'scripts\launch.ps1' })
if ($process -and $process.CommandLine -and $process.CommandLine.IndexOf($server, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
    Stop-Process -Id ([int]$metadata.pid)
    Remove-Item -LiteralPath $record
    Write-Host 'Local map server stopped.'
} else { Write-Host 'The original map server is no longer running. No process was stopped.' }
