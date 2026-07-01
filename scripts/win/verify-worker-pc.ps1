# 재부팅 후 자동 실행 검증 (비관리자). 사용: powershell -ExecutionPolicy Bypass -File .\scripts\win\verify-worker-pc.ps1
$ErrorActionPreference="SilentlyContinue"
$repo=(Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$o=@("=== Vraxium worker PC verify @ "+(Get-Date -Format o)+" ===")
$svc=Get-Service Cloudflared
$o+="1) cloudflared service : Status="+$svc.Status+" StartType="+$svc.StartType
$o+="2) crawler :8787 listen: "+[bool](Get-NetTCPConnection -LocalPort 8787 -State Listen)
$o+="3) node processes      : "+((Get-Process node|Measure-Object).Count)
try{$r=Invoke-WebRequest "https://crawler.vraxium.store/health" -TimeoutSec 20 -UseBasicParsing;$o+="4) remote /health      : HTTP "+$r.StatusCode+" "+$r.Content}catch{$o+="4) remote /health      : ERR "+$_.Exception.Message}
$sec=(Select-String -Path (Join-Path $repo ".env.local") -Pattern "^CAFE_CRAWLER_SECRET=(.+)$").Matches.Groups[1].Value.Trim()
try{$d=Invoke-RestMethod "https://crawler.vraxium.store/health?deep=1" -Headers @{Authorization="Bearer $sec"} -TimeoutSec 90;$o+="5) remote deep session : "+$d.session}catch{$o+="5) remote deep session : ERR "+$_.Exception.Message}
$wl="C:\ProgramData\vraxium\logs\worker.log"
if(Test-Path $wl){$o+="6) worker.log last 3   :";$o+= (Get-Content $wl -Tail 3 | ForEach-Object {"     "+$_})}else{$o+="6) worker.log          : (none yet)"}
$base=(Select-String -Path (Join-Path $repo ".env.local") -Pattern "^WORKER_BASE_URL=(.+)$").Matches.Groups[1].Value.Trim()
$o+="7) WORKER_BASE_URL      : "+$base
$o | Tee-Object -FilePath "C:\ProgramData\vraxium\logs\verify.log"
