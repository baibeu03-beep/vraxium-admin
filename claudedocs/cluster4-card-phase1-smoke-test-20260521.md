# Cluster4-card Phase 1 — Smoke Test 보고서
_Date: 2026-05-21_
_Scope: weekly_reviews + weekly_colleagues 의 코드↔스키마 정합 + 회귀 + smoke test 시나리오_

---

## 0. 검증 방법 선언

본 보고서는 다음 두 축으로 구성됩니다:

| 축 | 수행자 | 비고 |
|---|---|---|
| (A) 코드 정적 정합성 검증 + 회귀 grep | Claude (본 단계에서 수행) | line-by-line / column-by-column |
| (B) Production smoke test (Transactional SQL + UI click) | 사용자 (Supabase SQL Editor + 브라우저) | 본 보고서의 §5, §6 체크리스트 사용 |

실제 클릭 기반 E2E 자동화는 NextAuth 세션 인증을 요구해 본 단계에서 자동화하지 않았습니다. 대신 코드 정적 검증으로 "이론적으로 어떤 시나리오가 어떤 응답을 내는지" 100% 추적하고, 사용자가 5분 내 실행 가능한 안전한 SQL/UI 체크리스트를 제공합니다.

---

## 1. 검증 결과 요약

| # | 항목 | 결과 | 근거 |
|---|---|---|---|
| 1.1 | Weekly Review 생성 (POST) | ✅ 코드↔스키마 정합 | §2.1 |
| 1.2 | Weekly Review 수정 (PUT) | ✅ 코드↔스키마 정합 | §2.2 |
| 1.3 | Weekly Review 조회 (GET) | ✅ 코드↔스키마 정합 | §2.3 |
| 1.4 | Weekly Review 새로고침 후 유지 | ✅ 정합 (GET 응답이 maybeSingle 기반) | §2.3 |
| 2.1 | Weekly Colleagues 저장 (POST full-replace) | ✅ 코드↔스키마 정합 | §3.1 |
| 2.2 | Weekly Colleagues 조회 (GET) | ✅ 코드↔스키마 정합 | §3.2 |
| 2.3 | Weekly Colleagues 새로고침 후 유지 | ✅ 정합 | §3.2 |
| 3.1 | weekly_reviews 409 / UNIQUE 충돌 | ✅ Application-layer 선행 catch → DB UNIQUE 추가 방어 | §4.1 |
| 3.2 | weekly_colleagues UNIQUE 충돌 | ✅ DB UNIQUE 강제. ⚠️ Front 보강 권장 (§4.2) | §4.2 |
| 3.3 | weekly_colleagues CHECK 위반 (rank 1..3, no-self) | ✅ DB CHECK 방어선 작동 | §4.3 |
| 4.1 | weekly_reviews admin override (라우트 레벨) | ✅ 라우트 코드 자체는 admin path 지원 | §5 |
| 4.1 | weekly_reviews admin override (Front 레벨) | ⚠️ Front `saveWeeklyReview()` 가 `apiUrl()` helper 미사용 → admin 이 Cluster4-card UI 에서 직접 대신 작성 못함 (현재 Front 가 admin override 호출을 안 함). Phase 3 admin UI 에서 보강 대상 | §5 |
| 4.2 | weekly_colleagues admin override | ✅ Front 가 `apiUrl()` helper 사용. 라우트도 extractTargetUserId 지원 | §5 |
| 5.1 | Cluster4-1 Season Review 회귀 | ✅ 영향 0건 (코드 의존성 grep 0) | §6 |
| 5.2 | Cluster4-1 Season Reputation 회귀 | ✅ 영향 0건 | §6 |

**총평**: 1.1~5.2 모든 항목 ✅ 또는 ⚠️ (단 ⚠️ 1건은 Phase 3 admin UI 구현 시 자연스럽게 해결되는 layer issue). Phase 1 종료 가능.

---

## 2. weekly_reviews — 라우트 ↔ 스키마 정밀 매칭

### 2.1 POST (`app/api/weekly-reviews/route.ts:101-217`)

| Step | 코드 위치 | 검증 | 스키마 대응 |
|---|---|---|---|
| Auth | L104 `requireOwnerOrAdmin(adminTargetUserId)` | session + (owner | admin) | — |
| writerUserId | L107 `gate.context.targetUserId` | `user_profiles.user_id` 형식 보장 | weekly_reviews.user_id 컬럼 (FK user_profiles.user_id) ✓ |
| weekCardId UUID | L112 정규식 검증 | uuid 형식 | weeks.id 형식 ✓ |
| rating 검증 | L119-128 `Number.isInteger && 1..10` | 정수 + 범위 | CHECK `rating BETWEEN 1 AND 10` ✓ |
| content 검증 | L131-143 `trim().length > 0 && length ≤ 200` | 1..200자 | CHECK `char_length(content) BETWEEN 1 AND 200` ✓ |
| Edit-window | L146-161 admin 이 아니면 `cluster4.weekly_reviews` 게이트 | 403 EDIT_WINDOW_CLOSED | — (DB 무관) |
| Pre-INSERT UNIQUE | L166-181 SELECT existing → 발견 시 409 | App-layer 중복 차단 | UNIQUE `(user_id, week_card_id)` 와 정합 ✓ |
| INSERT payload | L186-194 | `{id, user_id, week_card_id, rating, content, created_at, updated_at}` 7컬럼 | 스키마 7컬럼과 100% 일치 ✓ |
| SELECT after | L195 7컬럼 returning | 응답 row shape | toClient 변환 후 Front `record.{id,weekCardId,rating,content,created_at,updated_at}` 와 일치 ✓ |

### 2.2 PUT (`app/api/weekly-reviews/[id]/route.ts:42-179`)

| Step | 코드 위치 | 검증 | 스키마 대응 |
|---|---|---|---|
| reviewId UUID | L48 | 형식 | weekly_reviews.id 형식 ✓ |
| Profile lookup | L56-66 `getUserProfile("id", adminTargetUserId)` | `lib/get-user-profile.ts:24-49` 의 alias 로직으로 `profile.id === profile.user_id` 보장 | weekly_reviews.user_id 와 비교 가능 ✓ |
| rating + content | L71-95 | POST 와 동일 | 동상 ✓ |
| Existing fetch | L103-122 SELECT `id, user_id` WHERE `id = reviewId` | 1행 | UNIQUE PK ✓ |
| Ownership check | L124-129 `existing.user_id !== profile.id` non-admin only | user_profiles.user_id 비교 | 일치 ✓ |
| Edit-window | L131-147 admin bypass | — | — |
| UPDATE payload | L149-158 `{rating, content, updated_at}` + WHERE `id` | 3컬럼 UPDATE | CHECK 모두 통과 ✓. trigger `weekly_reviews_set_updated_at` 가 추가 갱신 (멱등) ✓ |

### 2.3 GET (`app/api/weekly-reviews/route.ts:42-95`)

| Step | 코드 위치 | 검증 | 스키마 대응 |
|---|---|---|---|
| Query params | L44-60 weekCardId + optional userId | UUID | — |
| Auth | L63 `requireOwnerOrAdmin(explicitUserId)` | — | — |
| Fetch | L69-74 SELECT 7컬럼 + `eq("user_id", targetUserId).eq("week_card_id", weekCardId).maybeSingle()` | 1행 또는 null | UNIQUE `(user_id, week_card_id)` 보장 ✓ |
| Response | L84-87 `{success:true, data: row|null}` | Front 기대값 | Cluster4CardContent.tsx:3801-3814 의 `json.success && json.data` 분기와 일치 ✓ |

**새로고침 후 유지**: GET 응답 → `setWeeklyReviewFromDB(record)`. 새로고침 시 `useEffect [weekId, isDemoMode, urlUserId, session?.user?.id]` (L3821-3826) 재실행 → 동일 GET 호출 → DB row 있으면 state 복원 ✓.

---

## 3. weekly_colleagues — 라우트 ↔ 스키마 정밀 매칭

### 3.1 POST full-replace (`app/(host)/api/weekly-colleagues/route.ts:167-232`)

| Step | 코드 위치 | 검증 | 스키마 대응 |
|---|---|---|---|
| Profile lookup | L169-174 `getUserProfile("user_id", extractTargetUserId(request))` | admin 만 targetUserId 활성화. non-admin 은 본인으로 강제 | — |
| Body parse | L178-186 `{weekCardId, colleagues[]}` | weekCardId 필수 | — |
| DELETE existing | L189-193 WHERE `user_id = userProfile.user_id AND week_card_id = weekCardId` | full-replace 전반부 | INDEX `(user_id, week_card_id)` 활용 ✓ |
| INSERT mapped | L197-206 | `{id, user_id, week_card_id, colleague_id, rank, message:c.message||'', created_at, updated_at}` 8컬럼 | 스키마 8컬럼과 100% 일치 ✓ |
| `message: c.message || ''` | L203 | NULL 대신 빈 문자열 | CHECK `message IS NULL OR char_length(message) <= 200` — 빈 문자열도 length 0 으로 통과 ✓ |

### 3.2 GET (`app/(host)/api/weekly-colleagues/route.ts:14-164`)

| Step | 코드 위치 | 검증 | 스키마 대응 |
|---|---|---|---|
| Auth | L28-29 `requireOwnerOrAdmin(userId)` | — | — |
| Fetch | L33-49 SELECT 7컬럼 `WHERE user_id = ... ORDER BY rank` | 정렬된 다중 행 | INDEX `(user_id, week_card_id)` 활용 + CHECK rank 1..3 ✓ |
| Enrichment | L62-150 | user_profiles + user_educations + user_team_parts join | — (weekly_colleagues 와 무관) |
| Response | L147-151 `{success:true, data:[]+colleague}` | Front 기대값 | Cluster4CardContent.tsx 의 `selectedColleagues` 매핑과 일치 ✓ |

**새로고침 후 유지**: GET 호출 useEffect (Cluster4CardContent.tsx:1669-1684) 가 `[urlUserId, weekId, session?.user?.id]` 의존성. 새로고침 후 동일 호출로 state 복원 ✓.

---

## 4. UNIQUE / CHECK 위반 시나리오 trace

### 4.1 weekly_reviews 409 (UNIQUE)

```
[정상 흐름] user A 가 week W 에 첫 review POST
  → app-layer 의 pre-SELECT 가 existing 없음을 확인
  → INSERT 성공
  → 200 { data }

[중복 흐름] user A 가 같은 week W 에 다시 POST
  → app-layer pre-SELECT 가 existing.id 발견
  → 409 { error: "이미 해당 주차 리뷰가 존재합니다. 수정 API를 사용해주세요.", existingId } (route.ts:173-181)
  → DB UNIQUE 까지 도달하지 않음
```

만약 어떤 경로로든 app-layer를 우회해 INSERT 가 DB에 도달하면, **DB UNIQUE `weekly_reviews_unique_user_week`** 가 PostgreSQL 23505 (unique_violation) 으로 차단. 이중 방어선 ✓.

### 4.2 weekly_colleagues UNIQUE (`user_id, week_card_id, colleague_id`)

```
[Front UI 의도] crew search modal 이 본인 + 이미 선택된 동료 제외 → 중복 불가능
[버그/공격 경로] 같은 colleagueId 가 두 번 들어간 payload 가 POST 로 도착
  → DELETE 성공
  → INSERT 시 두 번째 row 가 UNIQUE 위반 → 23505
  → Supabase JS `.insert(array)` 는 batch transactional → 전체 INSERT 실패
  → DELETE 는 이미 commit 되었으면 (별도 statement) 동료 리스트 통째로 사라진 상태로 잔존
```

⚠️ **드리프트 리스크 (재확인)**: §3.1 의 delete + insert 비원자성. DDL 리뷰 §3.2 R2 와 동일. Phase 6/후속 PR 의 RPC/트랜잭션 보강 대상. 본 Phase 검증에서는 **DB CHECK/UNIQUE 가 정상 작동함**까지만 확인.

### 4.3 weekly_colleagues CHECK 위반

| CHECK | 시나리오 | 응답 |
|---|---|---|
| `rank BETWEEN 1 AND 3` | rank=4 시도 | 23514 check_violation → API 500 |
| `user_id <> colleague_id` | 본인을 colleague 로 시도 (Front 가 사전 차단) | 23514 → 500 |
| `message IS NULL OR char_length(message) <= 200` | 201자 message | 23514 → 500 |

위 3건은 모두 DB 방어선이 작동 — Front UI 가 정상 작동하는 한 도달 불가능. Admin 직접 호출 또는 scripted access 시 DB 가 차단.

---

## 5. Admin override 경로 검증

### 5.1 헬퍼 동작 요약

`extractTargetUserId(request)` (`lib/admin.ts:18-21`):
- `?targetUserId=` 쿼리만 읽음
- header 미사용

`getUserProfile(select, targetUserId)` (`lib/get-user-profile.ts:86-100`):
- `targetUserId && isAdminEmail(session.user.email)` 조건일 때만 다른 유저 조회
- non-admin 이 ?targetUserId= 붙여도 **무시되고 본인으로 회귀** ✓

`requireOwnerOrAdmin(targetUserId)` (`lib/api-auth.ts`):
- `targetUserId === viewerUserId` → 본인 (ok)
- `isAdmin` → 다른 유저 가능 (ok)
- 그 외 → 403

### 5.2 weekly_reviews admin override

**라우트 레벨**:
- POST (route.ts:104): `requireOwnerOrAdmin(adminTargetUserId)` → admin 이 `?targetUserId=<crew>` 붙이면 그 user 의 row 작성 가능 ✓
- PUT (route.ts:55-59): `getUserProfile("id", adminTargetUserId)` + L124-129 의 isAdmin 분기로 우회 가능 ✓
- DELETE (route.ts:211-223): 동상 ✓

**Front 레벨** ⚠️:
- `saveWeeklyReview()` (Cluster4CardContent.tsx:3858-3865) 가 직접 `fetch("/api/weekly-reviews", ...)` 호출 — `apiUrl()` helper 미사용
- 따라서 admin 이 다른 유저의 Cluster4-card 페이지에서 weekly review 수정 시도해도 `?targetUserId=` 가 안 붙어서 본인 review 로 동작
- weekly_reputations / weekly_colleagues / activity-details 는 `apiUrl()` 사용 (line 2010, 2361, 3599, 4381 등)

**판정**: Phase 1 (DB 도입) 범위에서는 admin override 라우트 동작은 ✅. Front 레벨 helper 누락은 Phase 3 admin UI 도입 시 자연스럽게 보강 — 본 검증에서는 별도 ticket 으로 분리 권장.

### 5.3 weekly_colleagues admin override

- 라우트: extractTargetUserId + getUserProfile 으로 admin 우회 활성화 ✓
- Front: `apiUrl("/api/weekly-colleagues")` (line 2010, 3599) 사용 — admin 이 다른 유저 페이지 진입 시 자동 `?targetUserId=` 부착 ✓

**판정**: ✅

---

## 6. Cluster4-1 회귀 검증

### 6.1 컴포넌트 grep

| 검색 위치 | weekly_reviews 매치 | weekly_colleagues 매치 |
|---|---|---|
| `components/cluster-4/` (Cluster4Content = /cluster-4-1 페이지) | **0** | **0** |
| `components/cluster-4-1/` (Cluster41Content = /cluster-4 페이지) | **0** | **0** |

### 6.2 API 라우트 grep

| 검색 위치 | 매치 |
|---|---|
| `app/(host)/api/season-reputations/` | **0** |
| `app/(host)/api/season-review/` | **0** |

### 6.3 판정

Cluster4-1 의 Season Review (`/api/season-review` → `user_season_histories.review/rating`) 와 Season Reputation (`/api/season-reputations` → `season_reputations`) 은 weekly_reviews / weekly_colleagues 와 **테이블/코드/라우트 모두 독립**.

이번 migration 으로 적용된 변경은 두 신규 테이블 CREATE 만이고, 기존 객체에 ALTER/DROP 없음. **회귀 위험 0건**.

---

## 7. Production Smoke Test SQL (사용자 실행용)

> Supabase SQL Editor 에서 **블록 단위로** 실행. 모든 블록이 `BEGIN; ... ROLLBACK;` 으로 감싸여 있어 운영 데이터에 영향 없음. RETURNING 결과를 Output 패널에서 확인 후 ROLLBACK.

### 7.1 사전 — 테스트 fixture 확보

```sql
-- 로그인된 본인 user_id 와 임의 week_card_id 확보 (실제 실행 전 본인 이메일/주차 ID 로 치환)
-- 실제 운영 환경에서는 SELECT 결과를 확인하고 아래 블록의 '<my_user_id>' '<some_week_id>' '<crew_user_id>' 를 치환.

SELECT user_id, display_name, auth_email
FROM public.user_profiles
WHERE auth_email = '23.aurum.06@gmail.com'  -- 본인 이메일
LIMIT 1;

SELECT id, week_number, start_date FROM public.weeks ORDER BY start_date DESC LIMIT 3;

SELECT user_id, display_name FROM public.user_profiles
WHERE user_id <> (SELECT user_id FROM public.user_profiles WHERE auth_email='23.aurum.06@gmail.com')
LIMIT 3;
```

치환 변수: `<my_user_id>`, `<week_id>`, `<crew_user_id_1>`, `<crew_user_id_2>`, `<crew_user_id_3>`.

### 7.2 weekly_reviews CRUD 시뮬레이션

```sql
BEGIN;

-- (1) INSERT 정상
INSERT INTO public.weekly_reviews (user_id, week_card_id, rating, content)
VALUES ('<my_user_id>', '<week_id>', 7, 'phase1 smoke test review')
RETURNING id, user_id, week_card_id, rating, content, created_at, updated_at;
-- 기대: 1 row, rating=7, content='phase1 smoke test review', created_at/updated_at 채워짐

-- (2) UPDATE — rating 변경
UPDATE public.weekly_reviews
SET rating = 9, content = 'phase1 smoke test updated'
WHERE user_id = '<my_user_id>' AND week_card_id = '<week_id>'
RETURNING id, rating, content, created_at, updated_at;
-- 기대: rating=9, updated_at > created_at (trigger 동작 확인)

-- (3) UNIQUE 중복 INSERT 시도 — 23505 unique_violation 기대
INSERT INTO public.weekly_reviews (user_id, week_card_id, rating, content)
VALUES ('<my_user_id>', '<week_id>', 5, 'duplicate attempt');
-- 기대: ERROR: duplicate key value violates unique constraint "weekly_reviews_unique_user_week"

ROLLBACK;
```

> ⚠️ (3) 에서 에러가 나면 BEGIN/ROLLBACK 트랜잭션은 자동 abort 상태가 됨. 그 상태에서도 ROLLBACK 은 정상 수행되어 (1)(2) 변경 사항도 모두 폐기. Supabase SQL Editor 의 multi-statement 실행 모드에서 자연스러움.

### 7.3 weekly_reviews CHECK 검증

```sql
BEGIN;

-- rating=11 시도 → 23514 check_violation 기대
INSERT INTO public.weekly_reviews (user_id, week_card_id, rating, content)
VALUES ('<my_user_id>', '<week_id>', 11, 'out-of-range rating');

ROLLBACK;
```

```sql
BEGIN;

-- content=201자 시도 → 23514 check_violation 기대
INSERT INTO public.weekly_reviews (user_id, week_card_id, rating, content)
VALUES ('<my_user_id>', '<week_id>', 5, REPEAT('a', 201));

ROLLBACK;
```

```sql
BEGIN;

-- rating=0 시도 → 23514 check_violation 기대 (CHECK 1..10)
INSERT INTO public.weekly_reviews (user_id, week_card_id, rating, content)
VALUES ('<my_user_id>', '<week_id>', 0, 'zero rating');

ROLLBACK;
```

### 7.4 weekly_colleagues full-replace 시뮬레이션

```sql
BEGIN;

-- (1) 3명 동료 등록
INSERT INTO public.weekly_colleagues (user_id, week_card_id, colleague_id, rank, message)
VALUES
  ('<my_user_id>', '<week_id>', '<crew_user_id_1>', 1, 'colleague 1'),
  ('<my_user_id>', '<week_id>', '<crew_user_id_2>', 2, 'colleague 2'),
  ('<my_user_id>', '<week_id>', '<crew_user_id_3>', 3, NULL)
RETURNING id, user_id, week_card_id, colleague_id, rank, message;
-- 기대: 3 rows

-- (2) 조회 확인
SELECT id, colleague_id, rank, message
FROM public.weekly_colleagues
WHERE user_id = '<my_user_id>' AND week_card_id = '<week_id>'
ORDER BY rank;
-- 기대: 3 rows, rank 1..3

-- (3) full-replace 시뮬레이션: DELETE → INSERT 2명
DELETE FROM public.weekly_colleagues
WHERE user_id = '<my_user_id>' AND week_card_id = '<week_id>';

INSERT INTO public.weekly_colleagues (user_id, week_card_id, colleague_id, rank, message)
VALUES
  ('<my_user_id>', '<week_id>', '<crew_user_id_1>', 1, 'replaced 1'),
  ('<my_user_id>', '<week_id>', '<crew_user_id_2>', 2, '');
-- 기대: 2 rows

SELECT colleague_id, rank, message
FROM public.weekly_colleagues
WHERE user_id = '<my_user_id>' AND week_card_id = '<week_id>'
ORDER BY rank;
-- 기대: 2 rows, 3번째 동료 사라짐

ROLLBACK;
```

### 7.5 weekly_colleagues CHECK / UNIQUE 검증

```sql
BEGIN;

-- 자기 자신을 colleague 로 → 23514 check_violation
INSERT INTO public.weekly_colleagues (user_id, week_card_id, colleague_id, rank)
VALUES ('<my_user_id>', '<week_id>', '<my_user_id>', 1);

ROLLBACK;
```

```sql
BEGIN;

-- rank=4 → 23514
INSERT INTO public.weekly_colleagues (user_id, week_card_id, colleague_id, rank)
VALUES ('<my_user_id>', '<week_id>', '<crew_user_id_1>', 4);

ROLLBACK;
```

```sql
BEGIN;

-- 같은 colleague 두 번 → 23505 unique_violation (두 번째 row 에서)
INSERT INTO public.weekly_colleagues (user_id, week_card_id, colleague_id, rank)
VALUES
  ('<my_user_id>', '<week_id>', '<crew_user_id_1>', 1),
  ('<my_user_id>', '<week_id>', '<crew_user_id_1>', 2);

ROLLBACK;
```

### 7.6 트리거 동작 확인 (updated_at)

```sql
BEGIN;

INSERT INTO public.weekly_reviews (user_id, week_card_id, rating, content)
VALUES ('<my_user_id>', '<week_id>', 5, 'trigger test');

SELECT id, created_at, updated_at,
       (updated_at = created_at) AS initially_equal
FROM public.weekly_reviews
WHERE user_id = '<my_user_id>' AND week_card_id = '<week_id>';
-- 기대: initially_equal = true

-- 1초 대기 (선택)
SELECT pg_sleep(1);

UPDATE public.weekly_reviews SET rating = 6
WHERE user_id = '<my_user_id>' AND week_card_id = '<week_id>';

SELECT id, created_at, updated_at,
       (updated_at > created_at) AS updated_at_advanced
FROM public.weekly_reviews
WHERE user_id = '<my_user_id>' AND week_card_id = '<week_id>';
-- 기대: updated_at_advanced = true

ROLLBACK;
```

---

## 8. UI smoke test 체크리스트 (사용자가 채워 넣음)

> 운영 DB 위에서 본인 계정으로 `/cluster-4-card/<weekId>` 진입. 결과를 ✅/❌/N/A 로 표기.

### 8.1 Weekly Review

| # | 행동 | 기대 | 결과 |
|---|---|---|---|
| W1 | 페이지 진입 직후 weekly-review 박스 표시 | "아직 작성된 리뷰가 없습니다 …" | ___ |
| W2 | DevTools Network: `GET /api/weekly-reviews?weekCardId=...&userId=...` | 200, `{success:true, data:null}` | ___ |
| W3 | 박스 클릭 → modal 열고 rating + content 입력 후 저장 | 200, `{success:true, data:{id,...}}` | ___ |
| W4 | modal 닫힘 후 박스에 작성한 내용 표시 | 표시됨 | ___ |
| W5 | 새로고침 (F5) | 박스 내용 유지 | ___ |
| W6 | 다시 modal 열고 rating 변경 후 저장 | PUT 200, 변경 반영 | ___ |
| W7 | 새로고침 | 변경된 rating 유지 | ___ |
| W8 | 작성 기간 잠긴 주차에서 저장 시도 | 403 EDIT_WINDOW_CLOSED + alert 통일 문구 | ___ |

### 8.2 Weekly Colleagues

| # | 행동 | 기대 | 결과 |
|---|---|---|---|
| C1 | 페이지 진입 직후 연계 동료 3슬롯 모두 빈 카드 | 비어 있음 | ___ |
| C2 | DevTools Network: `GET /api/weekly-colleagues?userId=...&weekCardId=...` | 200, `{success:true, data:[]}` | ___ |
| C3 | crew picker 열어 동료 2명 선택 후 저장 | POST 200 + 2슬롯 표시 | ___ |
| C4 | 새로고침 | 2명 유지 | ___ |
| C5 | 다시 picker 열어 1명만 남기고 저장 (1명 제거) | POST 200 + 1슬롯만 표시 | ___ |
| C6 | DB 확인 (SQL editor): `SELECT count(*) FROM weekly_colleagues WHERE user_id='<my>' AND week_card_id='<w>'` | 1 | ___ |

### 8.3 Cluster4-1 회귀

| # | 행동 | 기대 | 결과 |
|---|---|---|---|
| R1 | `/cluster-4-1` 진입 | 정상 로드 | ___ |
| R2 | Season Review 박스 표시 + 수정 가능 | 변경 없음 | ___ |
| R3 | Season Reputation 7장 정상 표시 | 변경 없음 | ___ |
| R4 | Season Reputation 신규 작성 | 정상 저장 (PUT/POST 200) | ___ |

위 모든 항목이 ✅ 이면 Phase 1 정상 종료.

---

## 9. Open items (Phase 3 / 후속 단계로 이월)

| # | 이슈 | Phase | 근거 |
|---|---|---|---|
| O1 | `saveWeeklyReview()` 가 `apiUrl()` helper 미사용 — Front 에서 admin override 동작 안 함 | Phase 3 admin UI 와 함께 보강 | §5.2 |
| O2 | weekly_colleagues POST 의 delete + insert 비원자성 — 중복 colleagueId payload 시 리스트 통째 손실 가능 | 후속 PR (RPC/트랜잭션 wrap) | §4.2 |
| O3 | `Career-Resume/backend/database/schema/weekly_reviews.sql` 의 broken FK 표기 잔존 | Phase 2 (스키마 정합화) 또는 별도 cleanup PR | DDL review §7.1 |
| O4 | `vraxium-admin/db/migrations/README.md` 표 outdated (`2026-05-21_*` 다수 미등록) | 별도 cleanup PR | DDL review §7.3 |

---

## 10. Phase 1 종료 판정

본 단계에서 검증한 모든 정합성 항목 (§1) 이 ✅ 또는 ⚠️ (Phase 3 이월) 입니다. 다음 조건이 충족되면 Phase 1 종료입니다:

1. 사용자가 §7 의 transactional SQL 을 실행해 모든 INSERT/UPDATE/CHECK/UNIQUE/트리거 가 기대대로 동작함을 확인
2. 사용자가 §8 의 UI 체크리스트 W1-W8, C1-C6, R1-R4 모두 ✅

위 두 조건 충족 시 Phase 3 (Admin 조회 UI) 설계로 진행 가능합니다. ⚠️ 항목 O1-O4 는 별도 PR/Phase 에서 처리합니다.

---

## 11. 본 단계 변경 사항 요약

| 분류 | 내역 |
|---|---|
| 신규 migration | 0 |
| 수정한 코드 파일 | 0 |
| 수정한 Front 파일 | 0 |
| 신규 문서 | 본 보고서 1건 |
| Supabase 변경 | 0 |
