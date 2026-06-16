# 카페 크롤러 실행 (Windows 운영자용)
#   포트 점검 → (미가동 시) 새 창에서 `npm run crawler` 기동 → /health 대기/확인
#   사용:  .\crawler\start-windows.ps1
#          .\crawler\start-windows.ps1 -Port 8787   (헬스/포트 점검용 오버라이드)
#   ※ 상시 운영은 pm2 권장:  pm2 start crawler\ecosystem.config.cjs ; pm2 save ; pm2 startup
param([int]$Port = 0)

. "$PSScriptRoot\_common-windows.ps1"
$repo = Get-RepoRoot
$port = Get-CrawlerPort -Port $Port
$base = Get-CrawlerBase -Port $Port

$listening = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
if ($listening) {
  Write-Host "[start] 포트 $port 에 이미 크롤러가 떠 있습니다. 헬스만 확인합니다."
} else {
  Write-Host "[start] 새 창에서 크롤러 기동: npm run crawler (포트 $port)"
  Start-Process -FilePath "npm.cmd" -ArgumentList "run", "crawler" -WorkingDirectory $repo -WindowStyle Normal
}

Write-Host "[start] $base/health 대기 중 ..."
$ok = $false
for ($i = 0; $i -lt 30; $i++) {
  try {
    $h = Invoke-RestMethod -Uri "$base/health" -Method Get -TimeoutSec 5
    if ($h.up) { $ok = $true; break }
  } catch { Start-Sleep -Seconds 1 }
}

if ($ok) {
  Write-Host "[start] OK — /health up=true (포트 $port)"
  Write-Host "[start] 세션 확인:  .\crawler\check-health-windows.ps1   (deep=valid 여야 검수 가능)"
  exit 0
} else {
  Write-Warning "[start] /health 응답 없음. 기동 창의 로그와 .env.local(CAFE_CRAWLER_SECRET/PORT)을 확인하세요."
  exit 1
}
