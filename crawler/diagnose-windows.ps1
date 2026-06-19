# 카페 크롤러 박스 자동실행 구조 진단 (Windows 운영자용)
#   PC만 켜두면 자동으로 살아나는 구조인지 점검한다. 한 항목이 실패해도 끝까지 진행.
#   ⚠ 시크릿(CAFE_CRAWLER_SECRET)은 어떤 경우에도 출력하지 않는다(존재/길이만).
#   결과는 콘솔 + crawler\diagnose-report-<시각>.txt 로 저장(시크릿 미포함 — 그대로 공유 가능).
#
#   사용:  crawler\diagnose-windows.bat 더블클릭
#          .\crawler\diagnose-windows.ps1 [-Port 8787] [-PublicUrl https://crawler.vraxium.store]
param([int]$Port = 0, [string]$Secret = "", [string]$PublicUrl = "https://crawler.vraxium.store")

. "$PSScriptRoot\_common-windows.ps1"
$ErrorActionPreference = "Continue" # 진단은 멈추지 않고 모든 항목 수집

$port = Get-CrawlerPort -Port $Port
$base = "http://localhost:$port"
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$report = Join-Path $PSScriptRoot "diagnose-report-$stamp.txt"
$lines = New-Object System.Collections.Generic.List[string]
function Log($m) { Write-Host $m; $script:lines.Add([string]$m) }

Log "================ 카페 크롤러 박스 진단 ($stamp) ================"
Log "repo=$(Get-RepoRoot)  port=$port  public=$PublicUrl"

# 도구/환경 존재 (값 비출력)
$pm2  = Get-Command pm2 -ErrorAction SilentlyContinue
$cfd  = Get-Command cloudflared -ErrorAction SilentlyContinue
$nssm = Get-Command nssm -ErrorAction SilentlyContinue
$secretVal = Resolve-CrawlerSecret -Secret $Secret
$hasSecret = -not [string]::IsNullOrWhiteSpace($secretVal)
$urlVal = Get-EnvValue "CAFE_CRAWLER_URL"
Log "[도구] pm2=$([bool]$pm2)  cloudflared=$([bool]$cfd)  nssm=$([bool]$nssm)"
Log "[env]  CAFE_CRAWLER_SECRET 설정=$hasSecret(len=$(if($hasSecret){$secretVal.Length}else{0}))  CAFE_CRAWLER_PORT=$port  CAFE_CRAWLER_URL설정=$(-not [string]::IsNullOrWhiteSpace($urlVal))"
Log ""

# 1) pm2 list (※ pm2 describe/env 는 환경변수 노출 위험 → 사용 안 함)
Log "[1] pm2 list ---------------------------------------------------"
if ($pm2) { try { ((pm2 list 2>&1) | Out-String).TrimEnd() -split "`r?`n" | ForEach-Object { Log "  $_" } } catch { Log "  pm2 list 실패: $($_.Exception.Message)" } }
else { Log "  pm2 미설치" }
Log ""

# 2) PM2 부팅 자동 등록 여부 (Windows: pm2-windows-startup + dump.pm2)
Log "[2] PM2 부팅 자동 등록 ------------------------------------------"
$dump = Join-Path $env:USERPROFILE ".pm2\dump.pm2"
$pm2Startup = Get-Command pm2-startup -ErrorAction SilentlyContinue
Log "  pm2 save 덤프(dump.pm2) 존재: $(Test-Path $dump)"
Log "  pm2-windows-startup(pm2-startup 명령) 설치: $([bool]$pm2Startup)"
$runHits = @()
foreach ($p in @("HKCU:\Software\Microsoft\Windows\CurrentVersion\Run","HKLM:\Software\Microsoft\Windows\CurrentVersion\Run")) {
  try { (Get-ItemProperty -Path $p -ErrorAction Stop).PSObject.Properties | Where-Object { $_.Name -match 'pm2' } | ForEach-Object { $runHits += "$p::$($_.Name)" } } catch {}
}
Log "  레지스트리 Run 의 pm2 항목: $(if($runHits.Count){$runHits -join ', '}else{'없음'})"
Log ""

# 3) Windows 작업 스케줄러
Log "[3] Windows 작업 스케줄러 ---------------------------------------"
try {
  $tasks = Get-ScheduledTask -ErrorAction Stop | Where-Object { $_.TaskName -match 'craw|cafe|pm2|naver' }
  if ($tasks) { $tasks | ForEach-Object { Log "  - $($_.TaskName)  state=$($_.State)" } } else { Log "  관련 작업 없음" }
} catch { Log "  조회 실패(모듈/권한): $($_.Exception.Message)" }
Log ""

# 4) NSSM/서비스
Log "[4] NSSM/서비스 등록 -------------------------------------------"
try {
  $svc = Get-Service -ErrorAction Stop | Where-Object { $_.Name -match 'craw|cafe|nssm|pm2' }
  if ($svc) { $svc | ForEach-Object { Log "  - $($_.Name)  status=$($_.Status)" } } else { Log "  관련 서비스 없음" }
} catch { Log "  조회 실패: $($_.Exception.Message)" }
Log ""

# 5) 포트 listen
Log "[5] 포트 $port listen 여부 -------------------------------------"
$listen = $null
try { $listen = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction Stop } catch {}
if ($listen) { $listen | ForEach-Object { Log "  listening  pid=$($_.OwningProcess)  addr=$($_.LocalAddress)" } } else { Log "  listen 없음 — 크롤러 프로세스가 떠 있지 않음" }
Log ""

# 6) Cloudflared 서비스
Log "[6] Cloudflared 서비스 -----------------------------------------"
$cfsvc = Get-Service -Name "Cloudflared" -ErrorAction SilentlyContinue
if ($cfsvc) { Log "  서비스 Cloudflared  status=$($cfsvc.Status)  startType=$($cfsvc.StartType)" } else { Log "  Cloudflared 서비스 미설치" }
$cfCfg = Join-Path $env:USERPROFILE ".cloudflared\config.yml"
Log "  ~/.cloudflared/config.yml 존재: $(Test-Path $cfCfg)"
Log ""

# 7) public /health
Log "[7] $PublicUrl/health ------------------------------------------"
try {
  $r = Invoke-WebRequest -Uri "$PublicUrl/health" -Method Get -TimeoutSec 20 -UseBasicParsing
  Log "  HTTP $($r.StatusCode)  body=$(([string]$r.Content).Trim())"
} catch {
  $code = $null; try { $code = $_.Exception.Response.StatusCode.value__ } catch {}
  Log "  실패: HTTP $code  $($_.Exception.Message)"
}
# 7b) local /health
Log "[7b] local $base/health ----------------------------------------"
try { $lh = Invoke-RestMethod -Uri "$base/health" -Method Get -TimeoutSec 10; Log "  up=$($lh.up)  lastCrawlAt=$($lh.lastCrawlAt)  lastError=$($lh.lastError)" }
catch { Log "  로컬 응답 없음 — 크롤러 미기동/포트 불일치" }
Log ""

# 8) deep health(로컬, 네이버 세션) — 시크릿은 헤더로만
Log "[8] deep health (네이버 세션 valid 여부) ------------------------"
if (-not $hasSecret) { Log "  CAFE_CRAWLER_SECRET 없음 → deep 건너뜀(.env.local 확인)" }
else {
  try {
    $d = Invoke-RestMethod -Uri "$base/health?deep=1" -Method Get -TimeoutSec 90 -Headers @{ Authorization = "Bearer $secretVal" }
    Log "  session = $($d.session)  $(if($d.session -eq 'valid'){'✓ 검수 가능'}else{'→ 재시드 필요(seed-naver-session-windows)'})"
  } catch { Log "  deep 실패 — 시크릿 불일치/서버오류/세션문제: $($_.Exception.Message)" }
}
Log ""

# ── 요약 판정 ──
$crawlerUp = [bool]$listen
$pm2Online = $false; if ($pm2) { try { $pm2Online = ((pm2 list 2>&1 | Out-String) -match 'cafe-crawler') } catch {} }
$cfRunning = ($cfsvc -and $cfsvc.Status -eq 'Running')
$bootAuto  = (Test-Path $dump) -and ([bool]$pm2Startup -or $runHits.Count -gt 0)
Log "================ 요약 ================"
Log "  크롤러 프로세스 떠 있음(listen)     : $crawlerUp"
Log "  pm2 에 cafe-crawler 등록            : $pm2Online"
Log "  cloudflared 서비스 Running          : $cfRunning"
Log "  PM2 부팅 자동(dump+startup) 추정    : $bootAuto"
if ($crawlerUp -and $pm2Online -and $cfRunning -and $bootAuto) {
  Log "  => 판정: 자동 실행 구조 (OK) — PC 재부팅 후 자동 부활 기대"
} else {
  Log "  => 판정: 미완성 — install-autostart-windows.bat(관리자) 실행 권장"
}

[IO.File]::WriteAllLines($report, $lines)
Write-Host ""
Write-Host "리포트 저장: $report"
Write-Host "(시크릿 미포함 — 이 파일을 그대로 공유하면 정확한 모드 판정이 가능합니다.)"
