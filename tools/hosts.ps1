# hosts.ps1 — переключение api.rf4game.ru между локальным и официальным сервером
#
# Использование:
#   .\tools\hosts.ps1 local      # направить на 127.0.0.1 (наш шлюз)
#   .\tools\hosts.ps1 official   # закомментировать строки проекта, вернуть официальные адреса
#   .\tools\hosts.ps1 status     # показать текущее состояние
#
# Перед каждым изменением создаётся копия hosts.rf4s-backup-<время>; восстановить: -Restore <файл>.
param(
    [Parameter(Position = 0)][ValidateSet('local', 'official', 'status')][string]$Mode = 'status',
    [string]$Restore = ''
)

$ErrorActionPreference = 'Stop'
$hosts = Join-Path $env:SystemRoot 'System32\drivers\etc\hosts'
$marker = '# rf4s-local'
$lines = @(
    '127.0.0.1 api.rf4game.ru',
    '127.0.0.1 api.rf4game.com'
)

if ($Restore) {
    Copy-Item $Restore $hosts -Force
    Write-Host ('restored from ' + $Restore) -ForegroundColor Green
    return
}

$text = Get-Content $hosts -Raw -Encoding UTF8
if ($null -eq $text) { $text = '' }
$current = @($text -split "`r?`n")

function Show-Status {
    $active = @($current | Where-Object { $_ -match '^\s*127\.0\.0\.1\s+api\.rf4game\.' })
    $disabled = @($current | Where-Object { $_ -match ('^\s*' + [regex]::Escape($marker)) })
    if ($active.Count -gt 0) {
        Write-Host 'Сейчас: локальный сервер (api.rf4game.ru -> 127.0.0.1)' -ForegroundColor Yellow
        $active | ForEach-Object { Write-Host ('  ' + $_) }
    } else {
        Write-Host 'Сейчас: официальный сервер (строки этого проекта в hosts закомментированы или отсутствуют)' -ForegroundColor Green
    }
    if ($disabled.Count -gt 0) { Write-Host ('Закомментировано строк: ' + $disabled.Count) -ForegroundColor DarkGray }
}

if ($Mode -eq 'status') { Show-Status; return }

$backup = Join-Path (Split-Path $hosts) ('hosts.rf4s-backup-' + (Get-Date -Format 'yyyyMMddHHmmss'))
Copy-Item $hosts $backup -Force
Write-Host ('backup -> ' + $backup) -ForegroundColor DarkGray

if ($Mode -eq 'local') {
    $out = @()
    foreach ($ln in $current) {
        $t = $ln.Trim()
        if ($t -match ('^' + [regex]::Escape($marker))) { $out += ($t -replace ('^' + [regex]::Escape($marker) + '\s*'), '') }
        else { $out += $ln }
    }
    $has = @($out | Where-Object { $_ -match '^\s*127\.0\.0\.1\s+api\.rf4game\.ru' }).Count
    if ($has -eq 0) { $out += $lines }
    else {
        $out = @($out | Where-Object { $_ -notmatch '^\s*127\.0\.0\.1\s+api\.rf4game\.(ru|com)' })
        $out += $lines
    }
    [IO.File]::WriteAllText($hosts, (($out -join "`r`n") + "`r`n"), (New-Object Text.UTF8Encoding($false)))
    Write-Host 'Переключено: локальный сервер' -ForegroundColor Yellow
} else {
    $out = @()
    foreach ($ln in $current) {
        if ($ln -match '^\s*127\.0\.0\.1\s+api\.rf4game\.(ru|com)') { $out += ($marker + ' ' + $ln.Trim()) }
        else { $out += $ln }
    }
    [IO.File]::WriteAllText($hosts, (($out -join "`r`n") + "`r`n"), (New-Object Text.UTF8Encoding($false)))
    Write-Host 'Переключено: официальный сервер (входите своим аккаунтом как обычно)' -ForegroundColor Green
}
Write-Host ''
Show-Status
