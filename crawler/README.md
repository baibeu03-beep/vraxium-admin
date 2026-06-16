# 카페 댓글 크롤러 서비스 (C안)

Vercel admin 의 카페 댓글 검수가 **운영 환경에서도** 동작하도록, 네이버 로그인 세션을 가진
전용 환경에서 댓글 닉네임만 수집해 HTTP 로 돌려주는 작은 서비스다.

- **이 서비스는 크루 DB·org·mode·user 에 접근하지 않는다.** 응답은 공개 닉네임 목록뿐.
- 매칭/스코프(org·mode·동명이인·test/operating)는 전적으로 Vercel admin 이 수행한다.
- 구현 본체는 `lib/naverCafeComments.ts`(로컬 크롤링과 동일 코드)를 HTTP 로 노출한 `crawler/server.ts`.

## 어디서 구동하나

**가정용/사무실 IP 의 상시 가동 PC/미니PC 1대.**
⚠ VPS/클라우드(데이터센터 IP)에 두면 네이버가 캡차/기기인증/계정잠금을 유발해 깨진다 — 반드시 가정용 IP.

---

## 초보 운영자 — `.bat` 더블클릭 (가장 쉬움)

PowerShell 명령을 직접 입력할 필요 없이, `crawler` 폴더에서 아래 파일을 **순서대로 더블클릭**하면 된다.
(각 런처는 자동으로 `-ExecutionPolicy Bypass` 로 실행하고, 끝나면 창이 닫히지 않도록 멈춘다. 시크릿은 출력되지 않는다.)

| 순서 | 더블클릭할 파일 | 하는 일 |
|---|---|---|
| 0 | (메모장으로) `.env.local` 에 `CAFE_CRAWLER_SECRET`·`CAFE_CRAWLER_PORT` 입력 | `crawler\.env.example` 참고 |
| 1 | **`setup-windows.bat`** | 설치 + 환경 점검 |
| 2 | **`seed-naver-session-windows.bat`** | 창에서 네이버 로그인 1회 |
| 3 | **`start-windows.bat`** | 크롤러 실행 |
| 4 | **`check-health-windows.bat`** | `deep: session = valid` 면 검수 준비 완료 |

- 세션이 만료되면(`check-health` 가 `expired`) → **`seed-naver-session-windows.bat`** 을 다시 더블클릭.
- 더 세밀한 제어(포트/시크릿 오버라이드 등)가 필요하면 아래 PowerShell 직접 실행을 사용한다.

---

## Windows 운영자 실행 순서 (요약, PowerShell 직접)

```powershell
# 0) 최초 1회: .env.local 에 시크릿 설정 (crawler\.env.example 참고)
#      CAFE_CRAWLER_SECRET=<길고 무작위>   CAFE_CRAWLER_PORT=8787

# 1) 설치 (npm ci + Chromium + 환경 점검)
.\crawler\setup-windows.ps1

# 2) 네이버 세션 1회 시드 (창에서 사람이 로그인)
.\crawler\seed-naver-session-windows.ps1

# 3) 크롤러 실행
.\crawler\start-windows.ps1

# 4) 세션/헬스 확인 (deep = valid 여야 검수 가능)
.\crawler\check-health-windows.ps1
```

> PowerShell 실행정책으로 막히면(최초 1회):
> `Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned`
> 또는 개별 실행: `powershell -ExecutionPolicy Bypass -File .\crawler\setup-windows.ps1`

### 스크립트 설명
| 스크립트 | 하는 일 |
|---|---|
| `setup-windows.ps1` | `npm ci` → Playwright Chromium 설치 → `.env.local`/`CAFE_CRAWLER_SECRET` 확인. `-SkipInstall` 로 환경 점검만. |
| `seed-naver-session-windows.ps1` | `naver-session-seed` 실행(헤드풀 로그인) → 끝나면 헬스 확인 안내. |
| `start-windows.ps1` | 포트 점검 → (미가동 시) 새 창에서 `npm run crawler` → `/health` 대기/확인. `-Port` 오버라이드. |
| `check-health-windows.ps1` | `/health` + `/health?deep=1` 결과 출력. `-Port`/`-Secret` 오버라이드. 시크릿은 미표시. |

상시 운영(부팅 자동·크래시 재시작)은 pm2 권장:
```powershell
pm2 start crawler\ecosystem.config.cjs ; pm2 save ; pm2 startup
```

---

## 최초 설치 (상세)

```powershell
# repo 클론 후
.\crawler\setup-windows.ps1
```
내부적으로: `npm ci` → `npx playwright-core install chromium` → `.env.local` 와 `CAFE_CRAWLER_SECRET` 존재 확인.
설치 없이 환경만 다시 점검/복구하려면: `.\crawler\setup-windows.ps1 -SkipInstall`

## 네이버 세션 시드

```powershell
.\crawler\seed-naver-session-windows.ps1
```
열리는 창에서 직접 로그인(캡차/기기확인/2단계 인증 통과). 성공 시 `.naver-profile\` 에 세션 저장.
⚠ 시드 중에는 크롤러 `/crawl` 이 돌지 않도록(프로필 충돌 방지) idle/중지 권장. 계정 정보는 로그에 남지 않는다.

## 크롤러 실행

```powershell
.\crawler\start-windows.ps1          # 새 창에서 기동 + /health 확인
.\crawler\check-health-windows.ps1   # deep: session = valid 확인
```

## Cloudflare Tunnel 연결 (인바운드 포트 0)

```powershell
cloudflared tunnel login
cloudflared tunnel create cafe-crawler
cloudflared tunnel route dns cafe-crawler cafe-crawler.<도메인>
# %USERPROFILE%\.cloudflared\config.yml = crawler\cloudflared.example.yml 참고
#   ingress → service: http://localhost:8787
cloudflared service install          # 상시(부팅 자동)
```
확인: `Invoke-RestMethod https://cafe-crawler.<도메인>/health` → `up=true`.
(권장) Cloudflare Access 서비스 토큰으로 "Vercel 만 도달" 제한.

## Vercel env 입력 (Preview + Production)

```
CAFE_CRAWLER_URL    = https://cafe-crawler.<도메인>
CAFE_CRAWLER_SECRET = <박스의 .env.local 과 동일값>
(선택) CF_ACCESS_CLIENT_ID / CF_ACCESS_CLIENT_SECRET    # Cloudflare Access 사용 시
```
→ 배포 후 `/admin/line-opening/practical-info?org=oranke&tab=open&mode=test` 에서 카페 URL 검수.
(`CAFE_CRAWLER_URL` 미설정 = 로컬 Playwright 폴백 경로로 동작 — 개발용.)

## 세션 만료 시 재시드

`check-health` 의 deep 이 `expired` 이거나 검수 시 `login_required` 가 반복되면:
```powershell
.\crawler\seed-naver-session-windows.ps1   # 창에서 다시 1회 로그인
pm2 restart cafe-crawler                    # (pm2 사용 시) 새 세션 반영
.\crawler\check-health-windows.ps1          # deep = valid 확인
```
사전 예방: 외부 업타임 모니터가 `/health?deep=1` 를 주기 호출 → `expired`/`down` 시 알림 → 검수자 도달 전 복구.

---

## API

- `POST /crawl` `{ "url": "<카페 게시글 URL>" }` (헤더 `Authorization: Bearer <CAFE_CRAWLER_SECRET>`)
  → `{ ok:true, data:{ articleUrl, totalComments, uniqueNicknames, nicknames[], nicknameCounts[] } }`
- `GET /health` → `{ ok:true, up:true, lastCrawlAt, lastError }` (uptime 핑용, 인증 불요)
- `GET /health?deep=1` (인증) → `{ ok:true, session:"valid"|"expired" }`

## 장애 대응표

| 증상 | 원인 | 조치 |
|---|---|---|
| `setup` 가 "CAFE_CRAWLER_SECRET 비어있음" 경고 | `.env.local` 미설정 | `.env.local` 에 시크릿 설정 후 재실행 |
| `start` /health 응답 없음 | 크롤러 미기동 / 포트 불일치 | 기동 창 로그 확인, `.env.local` CAFE_CRAWLER_PORT 확인 |
| `check-health` deep = `expired` | 네이버 세션 만료/미시드 | `seed-naver-session-windows.ps1` 재시드 |
| 검수 시 `login_required` | 세션 만료 또는 멤버전용 게시판 권한 | 재시드 / 게시판 접근 권한 확인 |
| admin 검수 "연결 못함" | 박스·터널 다운 / Vercel `CAFE_CRAWLER_URL` 오설정 | 박스·cloudflared 상태·Vercel env 확인 |
| admin 검수 인증 실패 | 시크릿 불일치 | 박스 `.env.local` 과 Vercel `CAFE_CRAWLER_SECRET` 동일화 |
| 공개글인데 0건 | 카페 마크업/페이지네이션 변동 | 박스에서 `/crawl` 직접 호출로 재현·로그 확인 |
| PowerShell "실행할 수 없음" | 실행정책 제한 | `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` 또는 `-ExecutionPolicy Bypass` |

## 보안 주의

- 시크릿·네이버 비밀번호는 스크립트/로그에 출력하지 않는다(헤더 전달, 길이/존재만 표시).
- `.env.local`·`.naver-profile\` 는 커밋 금지(실제 값/세션 보관소). `crawler\.env.example` 만 커밋.
- 크롤러는 크루 DB·snapshot·user_weekly_points 에 접근하지 않는다(닉네임 read-only).
