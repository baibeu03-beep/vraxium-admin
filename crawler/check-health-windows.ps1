# 카페 크롤러 헬스 점검 (Windows 운영자용)
#   /health (shallow) + /health?deep=1 (세션 유효성) 결과를 보기 쉽게 출력.
#   ⚠ 시크릿은 헤더로만 전달하고 화면/로그에 출력하지 않는다.
#   사용:  .\crawler\check-health-windows.ps1
#          .\crawler\check-health-windows.ps1 -Port 8787 -Secret <시크릿>   (오버라이드)
param([int]$Port = 0, [string]$Secret = "")

. "$PSScriptRoot\_common-windows.ps1"
$base = Get-CrawlerBase -Port $Port

Write-Host "== 크롤러 헬스 점검 ($base) =="

# 1) shallow
try {
  $h = Invoke-RestMethod -Uri "$base/health" -Method Get -TimeoutSec 10
  Write-Host ("  [shallow] up={0}  lastCrawlAt={1}  lastError={2}" -f $h.up, $h.lastCrawlAt, $h.lastError)
} catch {
  Write-Warning "  [shallow] 응답 없음 — 크롤러가 꺼져 있거나 포트가 다릅니다. ($($_.Exception.Message))"
  exit 1
}

# 2) deep (세션 유효성)
$secret = Resolve-CrawlerSecret -Secret $Secret
if ([string]::IsNullOrWhiteSpace($secret)) {
  Write-Warning "  [deep] CAFE_CRAWLER_SECRET 가 없어 세션 점검을 건너뜁니다(.env.local 확인)."
  exit 1
}

try {
  $d = Invoke-RestMethod -Uri "$base/health?deep=1" -Method Get -TimeoutSec 90 `
        -Headers @{ Authorization = "Bearer $secret" }
  if ($d.session -eq "valid") {
    Write-Host "  [deep] session = valid  ✓  (검수 가능)"
  } else {
    Write-Warning "  [deep] session = $($d.session)  → 세션 만료. 재시드 필요: .\crawler\seed-naver-session-windows.ps1"
    exit 2
  }
} catch {
  Write-Warning "  [deep] 점검 실패 — 시크릿 불일치 또는 서버 오류. ($($_.Exception.Message))"
  exit 1
}
