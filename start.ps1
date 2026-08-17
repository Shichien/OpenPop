param(
    [int]$Port = 8011,
    [string]$HostAddress = '127.0.0.1'
)

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path -LiteralPath $PSScriptRoot).Path
Push-Location -LiteralPath $root
try {
    if (-not (Test-Path -LiteralPath '.next\BUILD_ID')) {
        & npm.cmd run build
        if ($LASTEXITCODE -ne 0) { throw "Next.js 构建失败，退出码：$LASTEXITCODE" }
    }

    $nativeArgs = @(
        'run'
        'start'
        '--'
        '--hostname'
        $HostAddress
        '--port'
        [string]$Port
    )
    & npm.cmd @nativeArgs
    if ($LASTEXITCODE -ne 0) { throw "Next.js 服务退出，退出码：$LASTEXITCODE" }
} finally {
    Pop-Location
}
