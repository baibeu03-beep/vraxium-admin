@echo off
REM ────────────────────────────────────────────────────────────────────────────
REM 프로세스 체크 자동 검수 worker — Windows 자동 시작용 배치.
REM
REM 사전 준비(새 PC 1회):
REM   1) npm install
REM   2) npx playwright-core install chromium
REM   3) .env.local 배치 (SUPABASE_* + NAVER_ID/NAVER_PASSWORD)
REM   4) node scripts\naver-session-seed.mjs   (창에서 캡차/기기확인 1회 완료 → .naver-profile 세션)
REM   5) admin 서버 실행 (예: npm run dev → http://localhost:3000)
REM
REM 자동 시작 등록(작업 스케줄러, 권장):
REM   - 트리거: "로그온할 때"
REM   - 동작: 프로그램 시작 → 이 .bat
REM   - "시작 위치(작업 디렉터리)"에 repo 루트 경로 지정
REM
REM 또는 시작프로그램: Win+R → shell:startup → 이 .bat 바로가기 배치.
REM ────────────────────────────────────────────────────────────────────────────

REM repo 루트로 이동 (이 스크립트는 <repo>\scripts\win\ 에 위치).
cd /d "%~dp0\..\.."

REM 선택: 처리 범위/주기 한정 (미설정 시 전체 org/mode, 60초 주기).
REM set WORKER_ORGS=oranke,encre,phalanx
REM set WORKER_MODES=operating
REM set POLL_INTERVAL_MS=60000
REM set WORKER_BASE_URL=http://localhost:3000

echo [%date% %time%] starting process-check-worker...
node scripts\process-check-worker.mjs

REM worker 가 비정상 종료하면 창을 닫지 않고 코드 확인용으로 대기.
echo.
echo [worker exited with code %errorlevel%]
pause
