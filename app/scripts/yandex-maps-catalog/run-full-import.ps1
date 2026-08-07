# Заливка полной базы Яндекс.Карт в каталог организаций.
#
# Идёт десятки часов, поэтому падение процесса не должно стоить всей работы:
# импортёр пишет контрольную точку по файлам, а этот скрипт перезапускает его
# с --resume, пока источник не будет пройден целиком.
#
# Строка подключения берётся из -DatabaseUrl или $env:YANDEX_MAPS_CATALOG_DATABASE_URL
# и НЕ пишется ни в файл, ни в лог.
param(
  [string]$Source = '',
  [string]$DatabaseUrl = '',
  [int]$BatchSize = 20000,
  # Фактическое число строк во всех файлах источника, замерено полным
  # прогоном 07.08.2026. Прежнее значение 20632021 было занижено и роняло
  # заливку сверкой на самом финише, хотя данные заливались полностью.
  [int64]$ExpectedRows = 21650464,
  [switch]$Resume,
  [int]$MaxAttempts = 40
)

$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath (Join-Path $PSScriptRoot '..\..')

if ([string]::IsNullOrWhiteSpace($Source)) {
  $sourceChars = (0x041F,0x043E,0x043B,0x043D,0x0430,0x044F,0x0020,0x0431,0x0430,0x0437,0x0430,0x0020,0x042F,0x043D,0x0434,0x0435,0x043A,0x0441,0x0020,0x043A,0x0430,0x0440,0x0442,0x0020,0x0434,0x043B,0x044F,0x0020,0x0441,0x0430,0x0439,0x0442,0x0430) | ForEach-Object { [char]$_ }
  $Source = 'G:\' + ($sourceChars -join '')
}

if (-not [string]::IsNullOrWhiteSpace($DatabaseUrl)) {
  $env:YANDEX_MAPS_CATALOG_DATABASE_URL = $DatabaseUrl
}
if ([string]::IsNullOrWhiteSpace($env:YANDEX_MAPS_CATALOG_DATABASE_URL)) {
  throw 'Нужен -DatabaseUrl или $env:YANDEX_MAPS_CATALOG_DATABASE_URL (иначе зальётся в базу из .env).'
}

$logDir = Join-Path (Get-Location) 'logs'
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir | Out-Null }
$log = Join-Path $logDir 'yandex-maps-catalog-import.log'

# Первый заход может быть как чистым, так и продолжением — дальше только --resume.
$resumeNext = $Resume.IsPresent
$attempt = 0

while ($attempt -lt $MaxAttempts) {
  $attempt++
  # Не $args — это автоматическая переменная PowerShell, присваивание её ломает скрипт.
  $nodeArgs = @(
    '--env-file=../.env',
    '--max-old-space-size=8192',
    'dist/scripts/import-yandex-maps-catalog.cjs',
    '--source', $Source,
    '--batch-size', $BatchSize,
    '--expected-source-rows', $ExpectedRows,
    '--force'
  )
  if ($resumeNext) { $nodeArgs += '--resume' }

  "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] попытка $attempt (resume=$resumeNext)" | Tee-Object -FilePath $log -Append

  & 'G:\NodeJs\node.exe' @nodeArgs 2>&1 | Tee-Object -FilePath $log -Append
  $code = $LASTEXITCODE

  if ($code -eq 0) {
    "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] заливка завершена успешно" | Tee-Object -FilePath $log -Append
    exit 0
  }

  "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] упало с кодом $code — перезапуск с контрольной точки через 30 с" | Tee-Object -FilePath $log -Append
  $resumeNext = $true
  Start-Sleep -Seconds 30
}

"[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] исчерпаны $MaxAttempts попыток" | Tee-Object -FilePath $log -Append
exit 1
