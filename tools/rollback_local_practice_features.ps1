[CmdletBinding(SupportsShouldProcess = $true)]
param()

$ErrorActionPreference = 'Stop'
$repo = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$workspace = [System.IO.Path]::GetFullPath((Join-Path $repo '..'))
$expectedWorkspace = [System.IO.Path]::GetFullPath('F:\Project\hk-replay-map')
if ($workspace.TrimEnd('\') -ne $expectedWorkspace.TrimEnd('\')) {
    throw "拒绝回滚：当前工作区不是预期目录。实际=$workspace 预期=$expectedWorkspace"
}

$backup = Join-Path $repo 'output\local-fix-backup-20260919'
if (-not (Test-Path -LiteralPath $backup -PathType Container)) {
    throw "回滚备份不存在：$backup"
}

$restore = @(
    @{ Source = 'public_static_unity-practice-runner.js'; Target = 'pop\public\static\unity-practice-runner.js' },
    @{ Source = 'public_static_unity-practice.css'; Target = 'pop\public\static\unity-practice.css' },
    @{ Source = 'public_static_unity-practice.js'; Target = 'pop\public\static\unity-practice.js' },
    @{ Source = 'src_app_practice_page.tsx'; Target = 'pop\src\app\practice\page.tsx' },
    @{ Source = 'src_components_social-replay-panel.tsx'; Target = 'pop\src\components\social-replay-panel.tsx' },
    @{ Source = 'src_lib_constants.ts'; Target = 'pop\src\lib\constants.ts' },
    @{ Source = '.._official-unity-projects_1.5.78.11833_ExportedProject_Assets_OriginalPractice_OriginalPracticeDebugController.cs'; Target = 'official-unity-projects\1.5.78.11833\ExportedProject\Assets\OriginalPractice\OriginalPracticeDebugController.cs' },
    @{ Source = '.._official-unity-projects_1.5.12620_ExportedProject_Assets_OriginalPractice_OriginalPracticeDebugController.cs'; Target = 'official-unity-projects\1.5.12620\ExportedProject\Assets\OriginalPractice\OriginalPracticeDebugController.cs' }
)

foreach ($item in $restore) {
    $source = [System.IO.Path]::GetFullPath((Join-Path $backup $item.Source))
    $target = [System.IO.Path]::GetFullPath((Join-Path $workspace $item.Target))
    if (-not $source.StartsWith($backup, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "备份路径越界：$source"
    }
    if (-not $target.StartsWith($workspace, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "目标路径越界：$target"
    }
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
        throw "缺少备份文件：$source"
    }
    if ($PSCmdlet.ShouldProcess($target, "从 $source 恢复")) {
        Copy-Item -LiteralPath $source -Destination $target -Force
    }
}

$remove = @(
    'pop\public\unity-cache-sw.js',
    'pop\tools\verify_browser_cache.cjs',
    'pop\tools\verify_local_practice_features.cjs',
    'pop\tools\verify_original_escape_menu.cjs',
    'pop\tools\verify_runner_recovery.cjs',
    'pop\progress.md',
    'pop\tools\rollback_local_practice_features.ps1'
)

foreach ($relative in $remove) {
    $target = [System.IO.Path]::GetFullPath((Join-Path $workspace $relative))
    if (-not $target.StartsWith($workspace, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "删除路径越界：$target"
    }
    if (Test-Path -LiteralPath $target -PathType Leaf) {
        if ($PSCmdlet.ShouldProcess($target, '删除本轮新增文件')) {
            Remove-Item -LiteralPath $target -Force
        }
    }
}

Write-Host '本地练习功能改动已回滚。验证输出和截图保留在 output 目录。'
