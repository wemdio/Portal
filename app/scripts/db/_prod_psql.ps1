param(
  [Parameter(ValueFromPipeline=$true)][string]$Sql = '',
  [string]$File = '',
  [string]$DbUser = 'supabase_admin',
  [string]$DbName = 'postgres',
  [string]$Container = 'main-postgres',
  [string]$Host_ = '144.31.54.166',
  [string]$SshUser = 'root',
  [int]$TimeoutSec = 600
)
$ErrorActionPreference = 'Stop'

if (-not $env:PROD_PASS) {
  throw 'PROD_PASS env var not set'
}
$plink = 'C:\Program Files\PuTTY\plink.exe'
$hostKey = 'SHA256:D/3dKJA1Z6pLEph27Od9y2j2iVoCy7W5Ksky/jn4j/c'

# psql command on remote — reads SQL from stdin. -v ON_ERROR_STOP=1 makes it bail on error.
$remote = "docker exec -i -e PGPASSWORD=II4HByZJGNzDA5xq6vBtDvrvuqNDipha $Container /usr/bin/psql -U $DbUser -d $DbName -v ON_ERROR_STOP=1 -X"

# Make sure we read SQL as UTF-8 (default PS pipe re-encodes via OEM, killing Cyrillic).
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)

if ($File) {
  if (-not (Test-Path $File)) { throw "File not found: $File" }
  $bytes = [System.IO.File]::ReadAllBytes((Resolve-Path $File).Path)
} elseif ($Sql) {
  $bytes = $utf8NoBom.GetBytes($Sql)
} else {
  $stdin = [Console]::In.ReadToEnd()
  $bytes = $utf8NoBom.GetBytes($stdin)
}

# Write SQL to a temp .sql file (UTF-8, no BOM), SCP it, then run psql -f.
# This avoids ALL pipe-encoding pitfalls (PS → plink → bash → docker exec stdin).
$tmpLocal = [System.IO.Path]::GetTempFileName()
[System.IO.File]::WriteAllBytes($tmpLocal, $bytes)
$remoteTmp = "/tmp/_okved_$([System.IO.Path]::GetFileNameWithoutExtension($tmpLocal)).sql"

try {
  $pscp = 'C:\Program Files\PuTTY\pscp.exe'
  & $pscp -batch -pw $env:PROD_PASS -hostkey $hostKey -q $tmpLocal "$SshUser@${Host_}:$remoteTmp" 2>&1 | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "pscp failed with code $LASTEXITCODE" }

  $cmd = "docker cp $remoteTmp ${Container}:$remoteTmp && docker exec -e PGPASSWORD=II4HByZJGNzDA5xq6vBtDvrvuqNDipha $Container /usr/bin/psql -U $DbUser -d $DbName -v ON_ERROR_STOP=1 -X -f $remoteTmp; rc=`$?; rm -f $remoteTmp; docker exec $Container rm -f $remoteTmp 2>/dev/null; exit `$rc"
  & $plink -batch -ssh -pw $env:PROD_PASS -hostkey $hostKey "$SshUser@$Host_" $cmd 2>&1
}
finally {
  Remove-Item -Force -ErrorAction SilentlyContinue $tmpLocal
}
