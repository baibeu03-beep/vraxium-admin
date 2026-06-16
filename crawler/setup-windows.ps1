# 카페 크롤러 최초 셋업 (Windows 운영자용)
#   npm ci → Playwright Chromium 설치 → .env.local / CAFE_CRAWLER_SECRET 확인
#   사용:  .\crawler\setup-windows.ps1            (전체)
#          .\crawler\setup-windows.ps1 -SkipInstall   (설치 건너뛰고 환경만 점검/복구)
param([switch]$SkipInstall)

. "$PSScriptRoot\_common-windows.ps1"
$repo = Get-RepoRoot
Write-Host "[setup] repo: $repo"

if (-not $SkipInstall) {
  Push-Location $repo
  try {
    Write-Host "[setup] npm ci ..."
    npm ci
    if ($LASTEXITCODE -ne 0) { throw "npm ci 실패 (exit $LASTEXITCODE)" }

    Write-Host "[setup] Playwright Chromium 설치 ..."
    npx playwright-core install chromium
    if ($LASTEXITCODE -ne 0) { throw "Chromium 설치 실패 (exit $LASTEXITCODE)" }
  }
  finally { Pop-Location }
} else {
  Write-Host "[setup] -SkipInstall : npm ci / chromium 설치 건너뜀"
}

# .env.local 점검 (값은 출력하지 않는다)
$envPath = Join-Path $repo ".env.local"
$ready = $true
if (-not (Test-Path $envPath)) {
  Write-Warning ".env.local 이 없습니다. crawler\.env.example 을 참고해 만들어 주세요."
  $ready = $false
} else {
  $secret = Get-EnvValue "CAFE_CRAWLER_SECRET"
  if ([string]::IsNullOrWhiteSpace($secret)) {
    Write-Warning "CAFE_CRAWLER_SECRET 가 비어 있습니다. .env.local 에 길고 무작위한 값으로 설정하세요."
    $ready = $false
  } else {
    Write-Host "[setup] CAFE_CRAWLER_SECRET 확인됨 (길이 $($secret.Length)자, 값 미표시)"
  }
  Write-Host "[setup] CAFE_CRAWLER_PORT = $(Get-CrawlerPort)"
}

if ($ready) {
  Write-Host "[setup] 완료. 다음 단계:"
  Write-Host "        1) .\crawler\seed-naver-session-windows.ps1   (네이버 세션 1회 시드)"
  Write-Host "        2) .\crawler\start-windows.ps1                 (크롤러 실행)"
  Write-Host "        3) .\crawler\check-health-windows.ps1          (세션 valid 확인)"
} else {
  Write-Warning "[setup] .env.local 설정을 마친 뒤 다시 실행하세요."
  exit 1
}
