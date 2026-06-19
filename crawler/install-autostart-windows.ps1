# 카페 크롤러 상시 자동 실행 셋업 (Windows) — "PC만 켜져 있으면 자동 부활".
#   · 크롤러 : PM2 로 상시 실행(크래시 자동재시작) + 부팅/로그온 자동(pm2-windows-startup).
#   · 터널   : cloudflared 를 Windows 서비스로 설치(부팅 자동·로그인 불요).
#   ⚠ 관리자 권한 필요. ⚠ 시크릿은 출력하지 않는다(존재만 확인).
#
#   사용:  crawler\install-autostart-windows.bat 우클릭 → "관리자 권한으로 실행"
#          .\crawler\install-autostart-windows.ps1 [-SkipCloudflared]
#
#   ※ pm2-windows-startup 은 "로그온 시" 복구(HKCU Run)다. 로그인 없이 켜지자마자 띄우려면
#     박스에 자동 로그온을 설정하거나, 크롤러도 NSSM 서비스로 등록한다(README 참고).
param([switch]$SkipCloudflared)

. "$PSScriptRoot\_common-windows.ps1"
$ErrorActionPreference = "Stop"
$repo = Get-RepoRoot

function Test-Admin {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  return ([Security.Principal.WindowsPrincipal]$id).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}
if (-not (Test-Admin)) {
  Write-Warning "관리자 권한이 아닙니다. 이 창을 닫고 .bat 을 '관리자 권한으로 실행' 하세요."
  exit 1
}

# 0) 전제 — 시크릿/포트 확인(값 비출력)
$secret = Resolve-CrawlerSecret
if ([string]::IsNullOrWhiteSpace($secret)) {
  Write-Warning "CAFE_CRAWLER_SECRET 미설정(.env.local). crawler\.env.example 참고해 먼저 설정하세요."
  exit 1
}
$port = Get-CrawlerPort
Write-Host "[setup] repo=$repo  port=$port  (CAFE_CRAWLER_SECRET 설정 확인됨)"

# 1) PM2 설치
if (-not (Get-Command pm2 -ErrorAction SilentlyContinue)) {
  Write-Host "[setup] pm2 전역 설치: npm i -g pm2"
  npm i -g pm2 | Out-Host
}

# 2) 크롤러 등록/기동 (ecosystem.config.cjs — 크래시 자동재시작 autorestart:true)
$eco = Join-Path $repo "crawler\ecosystem.config.cjs"
Write-Host "[setup] cafe-crawler 기동/갱신: pm2 startOrReload $eco"
try { pm2 startOrReload $eco | Out-Host } catch { pm2 start $eco | Out-Host }

# 3) 부팅/로그온 자동 — pm2-windows-startup (Windows 는 native `pm2 startup` 미지원)
if (-not (Get-Command pm2-startup -ErrorAction SilentlyContinue)) {
  Write-Host "[setup] pm2-windows-startup 전역 설치"
  npm i -g pm2-windows-startup | Out-Host
}
Write-Host "[setup] 부팅 자동 등록: pm2-startup install"
pm2-startup install | Out-Host
Write-Host "[setup] 현재 프로세스 스냅샷 저장: pm2 save"
pm2 save | Out-Host

# 4) cloudflared 를 Windows 서비스로 (부팅 자동·로그인 불요)
if ($SkipCloudflared) {
  Write-Host "[setup] -SkipCloudflared → 터널 단계 건너뜀."
} elseif (-not (Get-Command cloudflared -ErrorAction SilentlyContinue)) {
  Write-Warning "[setup] cloudflared 미설치 — 설치 후 다시 실행하거나, 이미 다른 PC가 터널이면 무시."
} else {
  $svc = Get-Service -Name "Cloudflared" -ErrorAction SilentlyContinue
  if ($svc) {
    Write-Host "[setup] Cloudflared 서비스 이미 설치됨(status=$($svc.Status)) — 시작 보장."
    if ($svc.Status -ne 'Running') { Start-Service Cloudflared }
  } else {
    $cfg = Join-Path $env:USERPROFILE ".cloudflared\config.yml"
    if (-not (Test-Path $cfg)) {
      Write-Warning "[setup] ~/.cloudflared/config.yml 없음 — 터널 먼저 구성(crawler\cloudflared.example.yml). 서비스 설치 건너뜀."
    } else {
      Write-Host "[setup] cloudflared service install (부팅 자동)"
      cloudflared service install | Out-Host
    }
  }
}

# 5) /health 대기 + 안내
Write-Host "[setup] /health 대기 ..."
$base = "http://localhost:$port"; $ok = $false
for ($i = 0; $i -lt 30; $i++) { try { if ((Invoke-RestMethod "$base/health" -TimeoutSec 5).up) { $ok = $true; break } } catch { Start-Sleep -Seconds 1 } }
Write-Host "[setup] /health up=$ok"
Write-Host ""
Write-Host "== 셋업 완료 =="
Write-Host "  · 즉시 점검 : crawler\diagnose-windows.bat 더블클릭 → 요약 '자동 실행 구조 (OK)' 확인"
Write-Host "  · 진짜 검증 : PC 재부팅 → 로그인 후 다시 diagnose 실행해 모두 살아있는지 확인"
Write-Host "  · 세션 만료 시 : crawler\seed-naver-session-windows.bat (사람 1회 로그인) → pm2 restart cafe-crawler"
