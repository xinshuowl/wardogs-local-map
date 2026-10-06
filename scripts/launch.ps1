$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$url = 'http://127.0.0.1:4173'
try {
    $response = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 2
    if ($response.Content -match 'WARDOGS' -and $response.Content -match 'map-viewport') { Start-Process $url; exit 0 }
} catch { }
Write-Host 'WARDOGS local map. Keep this window open; press Ctrl+C to stop.'
$node = Get-Command node -ErrorAction SilentlyContinue
$nodePath = if ($node) { $node.Source } else { Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' }
if (Test-Path -LiteralPath $nodePath) {
    $process = Start-Process -FilePath $nodePath -ArgumentList @(('"' + (Join-Path $root 'server.mjs') + '"'), '--open') -WorkingDirectory $root -NoNewWindow -PassThru
    @{ pid = $process.Id; backend = 'node'; root = $root } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $root '.local-server.json') -Encoding UTF8
    $process.WaitForExit()
} else {
    @{ pid = $PID; backend = 'windows'; root = $root } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $root '.local-server.json') -Encoding UTF8
    $serverReferences = @{}
    if ($PSVersionTable.PSVersion.Major -lt 6) { $serverReferences.ReferencedAssemblies = @('System.dll', 'System.Core.dll', 'System.Net.Http.dll') }
    Add-Type -Path (Join-Path $PSScriptRoot 'LocalMapServer.cs') @serverReferences
    [LocalMapServer]::Run($root, 4173, $true)
}
