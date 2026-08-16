param(
    [Parameter(Mandatory = $true)]
    [string]$AccountId,

    [Parameter(Mandatory = $true)]
    [string]$Bucket,

    [Parameter(Mandatory = $true)]
    [string]$PublicUrl
)

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$buildRoot = (Resolve-Path -LiteralPath (Join-Path $root 'runtime\unity-webgl')).Path
$endpoint = "https://$AccountId.r2.cloudflarestorage.com"
$publicRoot = $PublicUrl.TrimEnd('/')
$immutableCache = 'public, max-age=31536000, immutable'

if (-not (Get-Command aws -ErrorAction SilentlyContinue)) {
    throw '需要先安装并配置 AWS CLI，R2 访问密钥使用 AWS_ACCESS_KEY_ID 和 AWS_SECRET_ACCESS_KEY。'
}

$files = Get-ChildItem -LiteralPath $buildRoot -Recurse -File | Where-Object {
    $_.Directory.Name -eq 'Build' -and
    $_.Name -match '\.(data|wasm|framework\.js)(\.br)?$'
}
if ($files.Count -eq 0) {
    throw "没有找到需要上传的 Unity 大型文件：$buildRoot"
}

foreach ($file in $files) {
    $relative = [IO.Path]::GetRelativePath($buildRoot, $file.FullName).Replace('\', '/')
    $key = "unity-practice-builds/$relative"
    $sourceName = if ($file.Name.EndsWith('.br')) { $file.Name.Substring(0, $file.Name.Length - 3) } else { $file.Name }
    $contentType = if ($sourceName.EndsWith('.wasm')) {
        'application/wasm'
    } elseif ($sourceName.EndsWith('.js')) {
        'application/javascript'
    } else {
        'application/octet-stream'
    }

    $arguments = @(
        's3api', 'put-object',
        '--endpoint-url', $endpoint,
        '--bucket', $Bucket,
        '--key', $key,
        '--body', $file.FullName,
        '--content-type', $contentType,
        '--cache-control', $immutableCache
    )
    if ($file.Name.EndsWith('.br')) {
        $arguments += @('--content-encoding', 'br')
    }

    & aws @arguments | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw "R2 上传失败：$($file.FullName)"
    }

    $assetUrl = "$publicRoot/$key"
    $headers = Invoke-WebRequest -UseBasicParsing -Method Head -Uri $assetUrl
    if ($headers.StatusCode -ne 200 -or $headers.Headers['Cache-Control'] -notmatch 'max-age=31536000') {
        throw "R2 上传后的缓存头核验失败：$assetUrl"
    }
    if ($file.Name.EndsWith('.br') -and $headers.Headers['Content-Encoding'] -ne 'br') {
        throw "R2 上传后的 Brotli 响应头核验失败：$assetUrl"
    }
    Write-Output "R2_OK=$assetUrl"
}

Write-Output "POP_R2_PUBLIC_URL=$publicRoot"
