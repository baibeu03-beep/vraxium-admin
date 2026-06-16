# 네이버 세션 시드 (Windows 운영자용)
#   창이 열리면 사람이 직접 로그인(캡차/기기확인/2단계 인증 통과) → .naver-profile\ 에 세션 저장.
#   ⚠ 계정 정보는 어떤 로그에도 출력되지 않는다.
#   ⚠ 시드 중에는 크롤러 /crawl 이 돌지 않도록(프로필 충돌 방지) 크롤러를 idle/중지 권장.
#   사용:  .\crawler\seed-naver-session-windows.ps1

. "$PSScriptRoot\_common-windows.ps1"
$repo = Get-RepoRoot

Write-Host "[seed] 네이버 세션 시드를 시작합니다. 열리는 창에서 직접 로그인하세요."
Write-Host "[seed] (NAVER_ID/NAVER_PASSWORD 가 .env.local 에 있으면 자동 입력만 보조 — 캡차/2FA는 사람이 통과)"

Push-Location $repo
try {
  npm run crawler:seed
  $code = $LASTEXITCODE
}
finally { Pop-Location }

if ($code -eq 0) {
  Write-Host "[seed] 세션 저장 완료. 이제 세션 유효성을 확인하세요:"
  Write-Host "        .\crawler\check-health-windows.ps1   ->  deep: session = valid 여야 합니다."
} else {
  Write-Warning "[seed] 로그인이 확인되지 않았습니다(exit $code). 다시 실행해 주세요."
  exit 1
}
