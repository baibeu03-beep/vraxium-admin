# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

@AGENTS.md

## 언어 및 커뮤니케이션 규칙

- **기본 응답 언어**: 한국어
- **코드 주석**: 한국어로 작성 (기존 코드의 SoT 주석 스타일을 따른다)
- **커밋 메시지**: 한국어로 작성
- **문서화**: 한국어로 작성 (`docs/`, `db/migrations/README.md` 등)
- **변수명/함수명/타입명**: 영어 (코드 표준 준수)
- 사용자 노출 문구(토스트·오류 메시지·라벨)는 한국어. 서버 4xx 오류 문구도 한국어 업무 문장으로 쓴다 (`docs/error-handling.md` 참조).

## 명령어

```bash
npm run dev            # 개발 서버 :3000
npm run build          # 프로덕션 빌드
npm run lint           # eslint (flat config)
npx tsc --noEmit       # 타입 체크 — 커밋 전 필수 (scripts/ 는 tsconfig exclude)
```

### 검증 스크립트 (테스트 러너 없음)

이 저장소에는 jest/vitest가 없다. 검증은 `scripts/` 의 1,600여 개 일회성/회귀 스크립트로 한다. 세 유형이 있다:

```bash
# 1) 순수 단위 검증 (DB 불필요)
npx tsx scripts/verify-scope-helper-usage.ts

# 2) DB 직결 검증 — --env-file=.env.local 필수
npx tsx --env-file=.env.local scripts/verify-operated-part-sot-unification.ts

# 3) 브라우저 렌더 검증 — dev 서버(:3000)가 떠 있어야 하고 소유자 세션으로 로그인한다
node scripts/browser-verify-crew-week-results-render.mjs
```

자주 쓰는 것은 `package.json` scripts 에 별칭이 있다 (`npm run verify:scope`, `npm run verify:point-award-source-allowlists` 등). **단일 검증 실행 = 해당 스크립트 하나를 직접 호출**하는 것이다.

`browser-verify-*.mjs` 일부는 형제 저장소 `../vraxium`(크루 앱)의 playwright 를 `createRequire` 로 빌려 쓴다. 그 저장소가 없으면 로컬 `playwright-core` 를 쓰도록 고쳐야 한다.

### 크롤러 (별도 프로세스)

```bash
npm run crawler        # crawler/server.ts — 네이버 카페 댓글 수집 HTTP 서비스
npm run crawler:seed   # 네이버 세션 시드(브라우저 로그인 1회)
```

가정용 IP의 상시 가동 PC에서 돌린다. 자세한 운영 절차는 `crawler/README.md`.

### DB 마이그레이션

**자동 실행 도구를 두지 않는다.** `db/migrations/*.sql` 을 Supabase SQL Editor 에 **파일명 알파벳 순서대로 수동 적용**한다. 모든 파일은 멱등이어야 한다. 새 마이그레이션을 추가하면 `db/migrations/README.md` 표에 목적·의존·멱등성을 함께 기록한다.

## 아키텍처

### 스택과 배치

Next.js 16 App Router (React 19) + Supabase(Postgres/Auth) + Tailwind v4 + shadcn/base-ui. Vercel `icn1` 리전 배포. 경로 별칭은 `@/*` = 저장소 루트(`src/` 없음).

**두 저장소 구조** — 이 저장소는 어드민이고, 크루(고객) 앱은 형제 저장소 `../vraxium` 다. 두 앱은 같은 Supabase 를 보며, 크루 앱은 이 저장소의 `/api/cluster*` 15개 라우트를 소비한다.

### 디렉터리

| 경로 | 역할 |
| --- | --- |
| `app/(portal)/admin/**` | 어드민 화면. `app/(portal)/layout.tsx` 가 `requireAdminPage()` 로 전체를 게이트하고 전역 Provider(세션·조직권한·토스트·확인·툴팁·로딩배너)를 마운트 |
| `app/api/admin/**` | 어드민 전용 API(약 188개). 전부 `requireAdmin()` 통과 필요 |
| `app/api/cluster1\|3\|4/**`, `/api/members`, `/api/review-link` 등 | **크루 앱이 소비하는 외부 계약**. `x-internal-api-key` 서버-서버 또는 Supabase 세션 인증. 변경 시 반대편 저장소 파손 주의 |
| `lib/**` | 데이터 레이어 + 도메인 정책. 화면당 `admin*Data.ts`/`admin*Types.ts` 쌍이 관례 |
| `shared/**` | 브라우저 안전 계약(서버 전용 import 금지) |
| `components/admin/**` | 화면 컴포넌트(139개) · `components/ui/**` 공용 프리미티브 |
| `scripts/**` | 검증·백필·감사·마이그레이션 실행 스크립트 |
| `docs/data-flow/` | **데이터 흐름 전수 인덱스** — 페이지↔API↔테이블 계보. 새 작업 전 먼저 읽을 것 |

### 인증·세션

`middleware.ts` 가 모든 요청에서 Supabase 쿠키를 갱신하고 **서버측 유휴 타임아웃**을 강제한다(`admin_last_active` 슬라이딩 쿠키). 만료 시 페이지는 `/login?reason=idle`, API 는 401. `createServerClient` 와 `getUser()` 사이에 로직을 넣지 말 것(공식 패턴).

권한은 `lib/adminAuth.ts` 의 `requireAdmin(ADMIN_READ_ROLES | ADMIN_WRITE_ROLES)` 한 곳. 라우트는 `toAdminErrorResponse(error)` 로 401/403 을 변환한다.

### 두 개의 직교하는 스코프 축

거의 모든 화면·API 가 이 두 축을 함께 받는다. **화면마다 재구현하지 말고 반드시 아래 SoT 를 거친다.**

1. **조직(org)** — `lib/organizations.ts` 의 `encre`/`oranke`/`phalanx`. URL 은 `?org={slug}`(크루 목록만 path `/admin/crews/{org}`), API 내부 규약은 `?organization=`. `org=null` = 통합 모드. 판정은 `lib/adminOrgContext.ts` 의 `resolveAdminOrgFocus()`, 링크 부착은 `orgHref()`. 관리자별 허용 조직은 `lib/adminOrgAccess.ts`.
   - 조직 **표시명**은 반드시 `organizationLabelKo()` — slug 비교/권한/쿼리에 표시 상수를 쓰지 않는다.
2. **모집단 모드(mode)** — `lib/userScope.ts` 의 `resolveUserScope(mode, org)`. `operating`(실사용자만) / `test`(`test_user_markers` 만). 46개 라우트가 이 축을 탄다. 라우트에서는 `lib/requestScope.ts` 의 `resolveRequestScope(request)` 로 org·mode·demoUserId·targetUserId 를 한 번에 해소한다.

부가 스위치: `actAsTestUserId`(로그 actor·개설 게이트), `demoUserId`(데모 DTO 분기), `QA_HIDE_REAL_USERS`(QA 오버레이). **모드별로 문구·DTO 를 분기하지 않는다** — 대상 선택만 바뀌고 이후 판정은 동일해야 한다.

### 도메인 어휘

- **cluster1** 이력서 · **cluster2** 클럽 리뷰/슬로건 · **cluster3** 성장·품계 · **cluster4** 주차 카드·라인(핵심).
- **허브** = 실무 정보 / 실무 경험 / 실무 역량 / 실무 경력 4종. 대부분의 기능이 허브별로 갈라진다.
- **주차(week) / 시즌(season)** 이 시간 축. 경계는 KST 00:01. 전환 주차는 다음 시즌 W0 에 귀속.
- **라인(line)** = 크루가 주차마다 수행하는 활동 단위. 개설 → 검수 → 완료 워크플로.

### 캐시·스냅샷 (가장 사고가 잦은 영역)

`cluster4_weekly_card_snapshots` 가 크루 앱 주차 카드의 **1차 읽기 원천**이다(`dto_version` 기반, hit/stale/miss/error 4분기). 그 외 `cluster4_roster_card_stats`, `user_growth_stats`, 프로세스 메모리 캐시가 있다.

**Vercel Hobby 라 `vercel.json` 에 cron 이 없다.** 재계산은 `POST /api/admin/cluster4/recompute-*`, lazy 재계산, 그리고 `.github/workflows/process-check-auto-review.yml`(10분 주기 GitHub Actions → `INTERNAL_API_KEY` 로 `run-due-checks`·`run-due-week-actions` 호출)에 의존한다. 트리거가 끊기면 옛 카드가 무기한 노출된다.

PostgREST 제약 때문에 대량 조회는 `lib/supabaseInChunk.ts` 로 청크(≈50)한다 — `.in()` URL 길이 절벽과 1000행 cap 이 실재한다.

### 오류 처리

`lib/apiError.ts` **한 곳**에서만 API 오류 → 사용자 문구를 결정한다. 새 helper 를 만들지 않는다.

- 서버: 4xx = 사용자가 고칠 수 있는 한국어 업무 문장, 5xx = 원문 금지(`publicErrorMessage(error, status, fallback)` — 계산한 status 를 반드시 넘길 것). 필드명은 `lib/apiFieldLabels.ts` 의 `fieldLabel()`/`withJosa()`.
- 클라이언트: `throw new ApiRequestError({status, payload})` / `await readApiError(res)` → `t.apiError(...)` 또는 `getApiErrorMessage(err, fallback)`.
- 응답 형태는 `{ success: boolean, data? , error?: string }` 가 사실상의 규약이다(853곳).

## 이 저장소에서 일하는 방식

### SoT 주석을 먼저 읽는다

`lib/` 파일 상단의 긴 한국어 블록 주석은 장식이 아니라 **정책 계약**이다. 정책·판정·표시 규칙은 대부분 "단일 SoT" 로 통합되어 있고, 같은 계산을 화면에서 다시 구현하면 조용히 갈라진다. 새 계산을 만들기 전에 `lib/` 에 이미 있는지 grep 한다(예: 직책/클래스=`positionResolver`, 운용 파트=`loadTeamWeekRostersBulk`, 라인 org=`lineScope`, 표 정렬=`adminTableSort`, z-index=`overlayLayer`).

### 중복 URL·별칭에 주의

같은 컴포넌트를 마운트하는 URL 쌍이 있다 — `/admin/lines/register` ≡ `/admin/lines/info`, `/admin/processes/register` ≡ `/admin/processes/info`, `/admin/club-progress/weekly` ≡ `/admin/team-parts/info/weeks`. `/admin/integrated/*` 8개는 re-export 별칭이다. 한쪽만 고치면 다른 URL 에 옛 동작이 남는다.

### 사이드바 메뉴

`lib/adminMenuTree.ts` 가 사이드바와 헤더 breadcrumb 의 공통 SoT. 대분류의 `href` 는 첫 자식에서 유도해야 한다(basePath 하드코딩 시 조용한 `_rsc` 404).

### 편집 도구 주의

한글 주석·문구가 많은 파일에 PowerShell `Get-Content`/`Set-Content` 치환을 쓰면 인코딩이 깨져 복구가 어렵다. **파일 수정은 Edit/Write 툴로만** 한다.

### 배포·비밀값

환경변수는 `.env.local`(Vercel `vercel env pull`). 주요 키: `NEXT_PUBLIC_SUPABASE_URL`/`ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `INTERNAL_API_KEY`, `CAFE_CRAWLER_URL`/`SECRET`, `APP_ENV`(QA 단일 스위치), `MYSQL_*`(PMS 레거시 이관용).
