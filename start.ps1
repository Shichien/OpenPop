param(
    [int]$Port = 8010,
    [string]$HostAddress = '127.0.0.1'
)

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path -LiteralPath $PSScriptRoot).Path
python -m uvicorn server:app --host $HostAddress --port $Port --app-dir $root
