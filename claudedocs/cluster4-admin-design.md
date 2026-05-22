# Cluster4 Admin 운영화 — 설계/진단 보고

> **작성일**: 2026-05-20
> **작성 컨텍스트**: vraxium-admin repo / Claude Code 진단
> **상태**: 설계 단계 (코드 변경 전, 검토용)

---

> **⚠️ 사전 명시 (중요)**
> 본 보고서는 `vraxium-admin` (admin-only) repo 안에서 작성되었습니다.
> 사용자가 언급한 `/api/weekly-*`, `/api/season-*`, `/api/activity-details`, `/api/career-records` 라우트들은 **이 repo 안에 존재하지 않습니다** (grep 0건). 즉 Front 앱(별도 repo)에 위치한다고 판단합니다.
> 따라서 아래 1·2·3번 항목 중 "Front 앱 라우트 현황" 부분은 코드 직접 확인 없이 일반적 패턴 및 사용자 질문 문맥을 토대로 **가설(추정)** 로 정리하며, **실제 결론 확정 전 Front repo 에서 검증 필요** 입니다. 검증 가능하면 그 repo path 또는 routes 코드를 공유해 주시면 즉시 보강합니다.

---

## 1. 현재 Cluster4 canonical source 요약

User 가 명시한 "Cluster4 는 이미 Supabase canonical source 가 존재"한다는 전제를 다음 테이블 그룹으로 해석합니다 (전제 그대로 사용, 신규 테이블 생성 없음).

| 분류 | 테이블 | 성격 | Admin 직접 편집 |
|---|---|---|---|
| 마스터 / 시간 축 | `weeks`, `seasons` | 시스템 기준값 | ❌ 절대 편집 안함 |
| 마스터 / 활동 정의 | `weekly_activities`, `activity_types`, `points` | 시스템 정의값 | ❌ 절대 편집 안함 |
| derived / 계산값 | `user_weekly_growth`, `activity_records`, `career_projects` | 트리거/배치 산출물 | ❌ 직접 편집 안함 (원본 수정 후 재계산) |
| **user-level (1차 admin 편집 대상)** | `weekly_reviews` | 사용자가 쓴 회고 | ✅ |
| | `weekly_reputations` | 주간 평판 키워드 + 점수 | ✅ |
| | `weekly_colleagues` | 주간 함께한 동료 (delete+insert 패턴) | ✅ |
| | `season_reputations` | 시즌 평판 | ✅ |
| | `user_season_histories.rating / review` | 시즌 종합 평점·총평 | ✅ |
| | `user_activity_details` | 활동 상세 메모 | ✅ |
| Cluster4 권한 게이트 (가설) | `secondary_info_grants` | 사용자에게 부여된 2차 정보 입력 권한 | 🟡 admin 부여/회수 |

(주: `user_edit_windows` 는 이미 cluster2/3 에서 사용 중인 generic edit-window 테이블이며, `resource_key` 만 늘리면 cluster4 에도 그대로 재사용 가능합니다 — `lib/adminEditWindowsTypes.ts:18` 의 `EDITABLE_RESOURCES`.)

이 repo 에서 확인한 admin 패턴은 **route param = `user_profiles.user_id` (UUID)** 이며, `legacy_user_id` 라는 변수명을 쓰지만 실제 값은 UUID 입니다 (`lib/adminCluster3Data.ts:118`). Cluster4 도 동일 컨벤션 권장.

---

## 2. API 별 read / write 권한 현황

### 2-A. Read (GET) — Front 앱 라우트, 가설

사용자가 질문 문맥에서 "targetUserId 만 있으면 read 가능한지 확인" 이라고 표현한 것은 **현재 그렇게 동작할 가능성이 높음**을 시사합니다. 일반적 Front Cluster4 라우트의 추정 상태:

| GET 라우트 | 현재 인증(추정) | owner/admin 검증 | userId query 로 타인 데이터 조회 | 보강 필요 |
|---|---|---|---|---|
| `/api/weekly-reputations?userId=` | 세션만 있음 | ❌ | ⚠️ 가능 | 🔴 owner OR admin check 추가 |
| `/api/weekly-colleagues?userId=` | 세션만 있음 | ❌ | ⚠️ 가능 | 🔴 owner OR admin check 추가 |
| `/api/weekly-reviews?userId=` | 세션만 있음 | ❌ | ⚠️ 가능 | 🔴 owner OR admin check 추가 |
| `/api/activity-details?userId=` | 세션만 있음 | ❌ | ⚠️ 가능 | 🔴 owner OR admin check 추가 |
| `/api/career-records?userId=` | 세션만 있음 | ❌ | ⚠️ 가능 | 🔴 owner OR admin check 추가 |
| `/api/season-reputations?userId=` | 세션만 있음 | ❌ | ⚠️ 가능 | 🔴 owner OR admin check 추가 |

**확정 전 검증 필요**: Front repo 의 위 6개 route handler 에서 `targetUserId !== session.user.id` 일 때 어떻게 처리되는지 grep 결과 첨부 부탁드립니다.

### 2-B. Write — Front 앱 라우트, 가설

| Write 라우트 | owner 가드 | deadline gate | admin override | 비고 |
|---|---|---|---|---|
| `PUT /api/weekly-reviews` | (추정) self only | (추정) 있음 | ❓ | review-link 같이 `evaluateEditWindowPermission({isAdmin})` 패턴이면 deadline OK 회피 |
| `PUT /api/weekly-reputations` | self | 있음? | ❓ | 동상 |
| `PUT /api/weekly-colleagues` | self | 있음? | ❓ | **delete+insert non-atomic risk** ↓ (§6) |
| `PUT /api/season-reputations` | self | 있음? | ❓ | |
| `PUT /api/season-review` | self | (있음) | **❌ 없을 가능성 높음** ← 사용자 지적 | 1순위 보강 |
| `POST /api/activity-details` | self | **있음, admin 도 막힐 가능성** ← 사용자 지적 | ❌ | deadline override 필요 |

### 2-C. 이 admin repo 에서 확인된 사실
- `lib/adminAuth.ts:43` `requireAdmin()` 로 보호된 admin route 들은 **edit window 와 무관하게 write** 합니다 (`lib/adminCluster3Data.ts` 주석 참조).
- 사용자-facing 라우트 `/api/review-link` 에서는 `evaluateEditWindowPermission({ isAdmin })` 로 deadline override 가 이미 구현되어 있습니다 (`app/api/review-link/route.ts:179-186`). 단 **현재 user 가 admin 일 때 본인 데이터만** 편집할 수 있고, 타 user 의 데이터를 admin 으로 편집하려면 별도 admin-only route 가 필요합니다.

---

## 3. 보강 필요한 backend route

세 가지 갈래로 정리:

### (a) Front 앱 — Read 보강 (별 repo)
GET 6개에 동일 가드:
```
if (targetUserId && targetUserId !== session.user.id) {
  if (!isAdmin(session.user.id)) return 403
}
```
- 패턴 출처: `app/api/edit-windows/permission/route.ts:43-50` 의 `admin_users` 조회.

### (b) Front 앱 — Write 보강 (별 repo)
- `/api/season-review` PUT: admin override 추가 (이 admin repo 의 `evaluateEditWindowPermission({isAdmin})` 패턴 차용).
- `/api/activity-details` POST: deadline gate 통과 시 admin 은 bypass.
- `/api/weekly-colleagues` PUT: delete+insert 를 한 트랜잭션(RPC)으로 합치거나 `upsert + delete-by-diff` 로 idempotent 화.

### (c) 이 admin repo — 신규 admin-only route (1차 구현 대상)
Cluster2/3 패턴과 동일하게:

```
/api/admin/crews/[legacy_user_id]/cluster4   (GET + PATCH)
```

PATCH body 는 섹션 단위 partial update:
```
{
  weeklyReviews?:      { weekId, content }[]
  weeklyReputations?:  { weekId, keywordKey, score }[]
  weeklyColleagues?:   { weekId, colleagueUserId }[]
  seasonReputations?:  { seasonId, keywordKey, score }[]
  seasonReview?:       { seasonId, rating, review }
  activityDetails?:    { activityId, weekId, detail }[]
}
```
- `legacy_user_id` 라우트 파라미터는 실제로는 `user_profiles.user_id` (UUID) — Cluster3 와 동일 규약.
- `requireAdmin(ADMIN_WRITE_ROLES)` 보호.
- 모든 write 는 server-side sanitize + slot stamp.

### (d) 이 admin repo — `EDITABLE_RESOURCES` 추가
`lib/adminEditWindowsTypes.ts:18` 에 cluster4 키 후보:
- `cluster4.weekly_reviews`
- `cluster4.weekly_reputations`
- `cluster4.weekly_colleagues`
- `cluster4.season_review`
- `cluster4.activity_details`
- (`cluster4.season_reputations` 도 별도 필요할지 검토)

> 단, "1차 부여하지 않고 admin route 만으로 수정" 도 가능하므로, **edit-window 자체가 1차에 꼭 필요한 건 아닙니다** (Cluster3 도 처음에는 admin route 만 쓰고, edit-window 는 후속에 추가됨).

---

## 4. Admin UI 방식 추천

### Option A: 별도 Admin 페이지 — `/admin/crews/[organization]/[user_id]/cluster4` ✅ **추천**

| 항목 | 평가 |
|---|---|
| 구현 난이도 | 🟢 Cluster2/3 패턴 그대로 미러 → 가장 빠름 |
| 유지보수성 | 🟢 admin/user UI 가 분리되어 의도/책임이 명확 |
| 기존 self-edit 재사용성 | 🟡 form 컴포넌트는 분리 신규 작성, 단 `lib/adminCluster*Data.ts` 패턴 재사용 |
| 보안 위험 | 🟢 admin-only route 만 사용 → user-facing route 손볼 필요 적음 |
| 코드 위치 | `app/(portal)/admin/crews/[organization]/[legacy_user_id]/cluster4/page.tsx` + `components/admin/Cluster4Editor.tsx` |

### Option B: Front Cluster4 페이지 admin mode 진입 — `/cluster-4-card/[weekId]?userId=<targetUserId>&admin=true`

| 항목 | 평가 |
|---|---|
| 구현 난이도 | 🟡 Front 앱의 모든 form/save handler 가 admin mode 를 분기 처리해야 함 |
| 유지보수성 | 🔴 admin 로직이 user-facing 코드 곳곳에 흩어짐 — 회귀 비용 큼 |
| 기존 self-edit 재사용성 | 🟢 같은 화면 그대로 |
| 보안 위험 | 🔴 query param `admin=true` 는 client trust 위험. 서버 측 `userId` 받는 모든 mutation 에 admin re-check 필요. **public read 노출 위험**도 동일하게 커짐 |
| Front repo 침습 | 🔴 admin 변경이 Front 배포 사이클에 묶임 |

### 권고
- **1차: Option A** — Cluster2/3 와 일관, 보안 표면 최소, 빠른 출시.
- **2차 (optional)**: Option B 의 일부만 채택 — Front 의 Cluster4 read-view 에 `?userId=` admin 미리보기 (수정은 안 됨) 를 추가하여, admin 이 사용자 화면과 동일한 시각으로 확인할 수 있도록.
- 편집 흐름은 무조건 admin-only route 통해서만 수행 (Option A).

---

## 5. 1차 Admin 편집 범위

**포함 (user-level only):**

| 테이블 | 1차 편집 | 비고 |
|---|---|---|
| `weekly_reviews` | ✅ | content text |
| `weekly_reputations` | ✅ | (week_id, keyword_id, score) 단위; synthetic keyword id 위험 ↓ §6 |
| `weekly_colleagues` | ✅ | (week_id, colleague_user_id) 다대다; **atomic replace 필수** ↓ §6 |
| `season_reputations` | ✅ | (season_id, keyword_id, score) |
| `user_season_histories.rating, review` | ✅ | 해당 두 컬럼만 PATCH |
| `user_activity_details` | ✅ | activity_id 별 detail text |

**제외 (master / derived):**

| 테이블 | 사유 |
|---|---|
| `weeks`, `seasons` | 시간 마스터 — 수정 시 전 시스템 영향 |
| `weekly_activities`, `activity_types` | 활동 정의 — 운영팀 별도 관리 |
| `points` | 점수 정의 — 코드/룰 변경과 동기 필요 |
| `user_weekly_growth` | derived — 원본(reviews/reputations) 수정 후 trigger/배치로 재계산 |
| `activity_records` | derived (활동 참여 기록) — 원천이 다른 경로 |
| `career_projects` | derived (project 집계) — 원천 카드/콜라보 정보 수정 후 재집계 |

설계 원칙: **마스터/derived 는 admin UI 에 절대 노출하지 않음** → 운영 실수로 계산값이 mutate 되어 불일치가 누적되는 사고를 차단.

---

## 6. 제외할 derived / master 데이터

위 §5 참조. 한 줄 요약:
- **Master**: weeks, seasons, weekly_activities, activity_types, points → read-only.
- **Derived**: user_weekly_growth, activity_records, career_projects → admin 이 절대 직접 mutate 하지 않음. 필요 시 "재계산 트리거" 별도 운영 도구로.

---

## 7. 권한 매트릭스

> 역할: `owner`, `admin`, `viewer` (현재 시스템: `lib/adminAuthRoles.ts:5`).
> 향후 `operator`/`manager` 도 같은 매트릭스의 새 열로 확장 가능.

### 7-A. 이 admin repo — `/api/admin/crews/:user_id/cluster4`
| 작업 | owner | admin | viewer |
|---|---|---|---|
| GET (read 임의 사용자) | ✅ | ✅ | ✅ |
| PATCH weekly_reviews | ✅ | ✅ | ❌ |
| PATCH weekly_reputations | ✅ | ✅ | ❌ |
| PATCH weekly_colleagues | ✅ | ✅ | ❌ |
| PATCH season_reputations | ✅ | ✅ | ❌ |
| PATCH user_season_histories | ✅ | ✅ | ❌ |
| PATCH user_activity_details | ✅ | ✅ | ❌ |
| DELETE (slot 비우기 = empty-row delete) | ✅ | ✅ | ❌ |
| deadline override (admin route 자체가 window 무관) | 항상 | 항상 | n/a |

### 7-B. Front 앱 — `/api/weekly-*`, `/api/season-*`, …
| 작업 | self user | admin (cross-user) |
|---|---|---|
| GET own data | ✅ (세션) | ✅ |
| GET other user (`?userId=`) | ❌ 403 | ✅ (`isAdmin` 체크) |
| PUT own data, window open | ✅ | ✅ |
| PUT own data, window closed | ❌ 403 | ✅ (override) |
| PUT other user | ❌ 403 | ✅ (admin-only route 권장) |
| activity-details deadline 지난 후 | ❌ 403 | ✅ (override) |

### 7-C. Edit-window grant
| 작업 | owner | admin | viewer |
|---|---|---|---|
| user_edit_windows PATCH (upsert/close) | ✅ | ✅ | ❌ |
| bulk grant | ✅ | ✅ | ❌ |

---

## 8. 구현 우선순위

| 순위 | 범위 | 이유 | 예상 침습 |
|---|---|---|---|
| **P0** | Front 앱: GET 6개에 owner/admin check 추가 | public read 위험 즉시 제거 | Front, 30~60 LOC |
| P0 | Front 앱: `/api/season-review` PUT 에 admin override 추가 | 사용자 명시한 1순위 누락 | Front, ~10 LOC |
| P0 | Front 앱: `/api/activity-details` POST 의 admin deadline-bypass | admin 마저 막히면 운영 불가 | Front, ~10 LOC |
| **P1** | Admin repo: `/api/admin/crews/[legacy_user_id]/cluster4` GET 추가 | Admin UI MVP 의 조회 기반 | Admin, ~150 LOC + lib |
| P1 | Admin repo: `Cluster4Editor` page + components | 편집 UI MVP | Admin, ~400 LOC |
| P1 | Admin repo: `/api/admin/crews/[legacy_user_id]/cluster4` PATCH (weekly_reviews + season_review 부터) | 가장 단순한 텍스트 두 항목 먼저 | Admin, ~120 LOC |
| **P2** | Front 앱: weekly_colleagues delete+insert → atomic RPC 또는 diff-upsert | 원자성 결함 보강 | Front + Supabase SQL function |
| P2 | Admin repo: PATCH 의 나머지 섹션 (reputations, colleagues, activity_details) | colleagues 안전화 후 추가 | Admin, ~250 LOC |
| **P3** | Admin repo: `EDITABLE_RESOURCES` 에 cluster4 키 추가 + edit-window 부여 UI | self-edit 창구 운영 (cluster2/3 와 동치) | Admin, ~30 LOC |
| P3 | Demo/default 데이터 제거 가드 | 운영 데이터 청결도 | Front + Admin |

---

## 9. SQL / migration 필요 여부

**결론: 1차에서는 신규 migration 불필요.**

- `user_edit_windows` 는 이미 generic table (resource_key 컬럼 기반) → DDL 없이 `resource_key='cluster4.*'` 만 추가하면 동작 (`db/migrations/2026-05-13_user_edit_windows.sql:1-24`).
- `weekly_*`, `season_*`, `activity_details`, `user_season_histories` 는 Front 가 이미 사용 중이라는 전제 → 컬럼/제약 변경 불필요.
- 단, **추후 P2 단계** 에서 `weekly_colleagues` atomic replace 를 SQL function 으로 만든다면 그때 1건 migration 추가:
  ```
  -- 가칭: 2026-05-21_replace_weekly_colleagues_fn.sql
  -- replace_weekly_colleagues(user_id, week_id, colleague_user_ids[]) RPC
  ```
- 그 외 신규 테이블 / 스키마 변경은 **명시적 필요 없음**.

---

## 10. 다음 구현 프롬프트 초안

> 본 보고 승인 후, 아래 프롬프트로 단계적으로 진행하면 안전합니다.

### Prompt #1 — Front read-side 보안 보강 (별 repo 작업)
```
Cluster4 Front 앱의 아래 6개 GET route 에 owner/admin 검증을 추가해주세요.

대상:
- /api/weekly-reputations
- /api/weekly-colleagues
- /api/weekly-reviews
- /api/activity-details
- /api/career-records
- /api/season-reputations

요구사항:
1. 세션에서 currentUserId 추출.
2. query.userId 가 없으면 currentUserId 로 fallback.
3. query.userId 가 currentUserId 와 다르면 admin_users.is_active=true 인지
   확인하여 false 면 403.
4. supabaseAdmin (service role) 으로 row 조회, RLS 우회 의도 명시.
5. snake_case 응답 유지 (기존 client 호환).
6. 변경 LOC 최소화. 기존 select 컬럼은 손대지 말 것.

테스트 시나리오:
- self 조회 → 200
- 타 user 조회 (비 admin) → 403
- 타 user 조회 (admin) → 200
- 미인증 → 401
```

### Prompt #2 — Front write 보강 (별 repo)
```
Cluster4 Front 앱의 두 write route 에 admin override 를 추가해주세요.

A. PUT /api/season-review
   - 현재 owner-only 라면 admin 이 targetUserId 로 호출 시 통과.
   - deadline gate (현재 있다면) 도 admin 은 bypass.

B. POST /api/activity-details
   - deadline 통과 후에도 admin 이면 저장 허용.
   - bypass 시 response.meta.bypassedReason = 'admin' 명시.

C. PUT /api/weekly-colleagues
   - 현재 delete+insert non-atomic. 다음 둘 중 하나로 보강:
     (1) Supabase RPC `replace_weekly_colleagues(user_id, week_id, ids[])`
     (2) 또는 client tx 없이 idempotent diff (`upsert` + `delete-by-not-in`)
   - 둘 중 선택 후 PR 단위로 분리.

변경 시 응답 shape 는 유지하고, edit-window 평가는
이 admin repo 의 `evaluateEditWindowPermission({ isAdmin })` 동등한 함수를
재사용/이식.
```

### Prompt #3 — Admin repo: Cluster4 admin GET (현 repo 1차 작업)
```
이 admin repo 에 Cluster3 와 동일한 패턴으로 Cluster4 admin GET 을 추가하세요.

생성/수정 파일:
- app/api/admin/crews/[legacy_user_id]/cluster4/route.ts  (GET only)
- lib/adminCluster4Data.ts   (Cluster4Bundle, getCluster4ForCrew, Cluster4Error)
- lib/adminCluster4Types.ts  (DTO + 상수)

요구사항:
1. requireAdmin(ADMIN_READ_ROLES).
2. resolveUserId: legacy_user_id route param 을 user_profiles.user_id 로 매칭
   (lib/adminCluster3Data.ts:118 그대로 미러).
3. 한 번의 fetch 로 아래 묶음을 모두 반환:
   - user_profiles 1행 (식별 정보)
   - user_season_histories 전체 (rating, review 포함)
   - season_reputations 전체
   - weekly_reviews 전체
   - weekly_reputations 전체
   - weekly_colleagues 전체
   - user_activity_details 전체
4. 마스터/derived 테이블은 select 하지 않음 (UI 가 보이지 않게).
5. 응답: { success, data: Cluster4Bundle }.
6. 신규 테이블 만들지 말 것. migration 작성하지 말 것.
7. 컬럼 추정 금지 — 실제 schema 확인 후 select 컬럼 확정 (모르면 사용자에 질문).

테스트:
- 존재하는 user → 모든 섹션 데이터 반환
- 존재하지 않는 user → bundle.userId = null, 섹션 = []
- viewer 권한도 GET 200
- 비admin 401
```

### Prompt #4 — Admin Cluster4 PATCH (텍스트 두 섹션만 먼저)
```
이 admin repo 에 Cluster4 admin PATCH 를 추가하되, 1차로는 아래 두 섹션만:
- weeklyReviews: [{ weekId, content }]
- seasonReview:  { seasonId, rating, review }

요구사항:
1. requireAdmin(ADMIN_WRITE_ROLES).
2. body 각 필드는 optional, 하나 이상 있어야 함 (없으면 400).
3. weekId/seasonId 는 마스터 weeks/seasons 에 존재하는지 검증 후 진행.
4. weekly_reviews: (user_id, week_id) 기준 upsert; content 가 빈 문자열이면 delete.
5. user_season_histories: rating, review 컬럼만 update (다른 컬럼 절대 손대지 말 것).
6. server-side sanitize: trim, blob:/data:/file: 차단 (URL 아닌 텍스트는 적용 안함).
7. 신규 테이블 만들지 말 것. derived 테이블 select/update 금지.
8. 응답: { success, data: Cluster4Bundle (재조회), applied }.

P2 에서 weekly_reputations / season_reputations / weekly_colleagues / activity_details
가 추가될 예정이므로 patch 함수는 섹션별 helper 로 분할.
```

### Prompt #5 — Admin Cluster4 UI 스캐폴드
```
이 admin repo 에 Cluster3 와 동일 스타일의 Cluster4 admin UI 를 추가:
- app/(portal)/admin/crews/[organization]/[legacy_user_id]/cluster4/page.tsx
- components/admin/Cluster4Editor.tsx (1차: weekly_reviews 그리드 + season_review)

요구사항:
1. 상단 tab nav 에 "Cluster 4" 추가 (Cluster3 page 와 같은 위치).
2. weekly_reviews 는 week_index 1~N 슬롯 그리드, content textarea + Save 버튼.
3. season_review 는 season 별 카드, rating (number 1~5) + review textarea.
4. Save All 시 PATCH /api/admin/crews/:id/cluster4 호출, response 의 bundle 로
   form 재 hydrate.
5. 마스터/derived 데이터는 UI 에 보이지 않음. weeks/seasons 명칭은
   bundle 내 user_season_histories.season_label (또는 동등 join 결과)으로
   표시 — 별도 master fetch 추가하지 말 것.
6. demo/default placeholder 데이터 표시 금지 — 모든 값은 서버 응답 기반.
```

---

## 부록: 위험 지점 정리 (사용자 §6 응답)

| 위험 | 발생 위치 | 1차 대응 |
|---|---|---|
| **public read** | Front GET 6개에 owner check 없음 | Prompt #1 (P0) — admin 외 cross-user read 차단 |
| **deadline 이후 admin 수정 불가** | activity-details POST, season-review PUT | Prompt #2 (P0) — `evaluateEditWindowPermission({isAdmin})` 또는 동등 분기 추가. 본 admin route 자체는 window 무관 (lib/adminCluster3Data.ts 주석 참조) |
| **weekly_colleagues delete+insert non-atomic** | Front PUT | Prompt #2-C — RPC 또는 diff-upsert. Admin 측에서는 PATCH 시 같은 RPC 호출 |
| **synthetic reputation keyword id** | weekly_reputations, season_reputations | Admin PATCH 진입 시 keyword_id 가 마스터 표에 존재하는지 사전 검증 (`.in("id", ids)` 검증 후 missing 은 422). 클라이언트 생성 ID 신뢰 금지 |
| **snake_case / camelCase mismatch** | Front 응답 vs Admin Editor 입력 | Admin Editor 는 일관되게 camelCase form state, server 는 snake_case row. 변환 함수는 `lib/adminCluster4Data.ts` 한 곳에서만 (Cluster3 패턴 유지) |
| **demo/default 데이터 prod 노출** | Front fallback 분기 | Admin GET 에서는 절대 fallback 안 함 (`bundle.userId == null` 이면 빈 섹션 반환). Front 는 별도 PR 로 `if (env==='production') no-demo` 가드 |

---

## 다음 단계 (확인 필요)

1. **Front repo 위치** — 가능하면 위 6개 GET route 의 코드를 한 번에 공유 → §2-A/2-B 가설을 사실로 확정·수정.
2. `secondary_info_grants` 의 정확한 용도(어떤 화면을 열어주는 권한인지) — 1차 범위에 포함시킬지 결정 필요.
3. Cluster4 admin 의 첫 release 는 **Prompt #3 (read-only GET) 까지만** 만들고 한 번 사용자 시연 → OK 면 PATCH 진행, 권장 사항.

---

## 참고 코드 경로 (vraxium-admin repo, 패턴 출처)

| 목적 | 파일 |
|---|---|
| Admin 인증/역할 | `lib/adminAuth.ts`, `lib/adminAuthRoles.ts` |
| Cluster3 admin GET/PATCH (미러 대상) | `app/api/admin/crews/[legacy_user_id]/cluster3/route.ts` |
| Cluster3 admin 데이터 레이어 | `lib/adminCluster3Data.ts` (특히 `resolveUserId`, sanitize, applyTopCardsSection) |
| Cluster3 admin UI | `app/(portal)/admin/crews/[organization]/[legacy_user_id]/cluster3/page.tsx`, `components/admin/Cluster3Editor.tsx` |
| Edit-window generic 시스템 | `lib/adminEditWindowsTypes.ts`, `lib/adminEditWindowsData.ts`, `db/migrations/2026-05-13_user_edit_windows.sql` |
| 사용자-facing route 의 admin override 예시 | `app/api/review-link/route.ts` |
| Edit-window permission API | `app/api/edit-windows/permission/route.ts` |
