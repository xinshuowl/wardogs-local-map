param([int]$Port = 4173)
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$serverReferences = @{}
if ($PSVersionTable.PSVersion.Major -lt 6) { $serverReferences.ReferencedAssemblies = @('System.dll', 'System.Core.dll', 'System.Net.Http.dll') }
Add-Type -Path (Join-Path $PSScriptRoot 'LocalMapServer.cs') @serverReferences
[LocalMapServer]::Run($root, $Port, $false)
