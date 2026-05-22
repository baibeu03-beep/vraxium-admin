# Cluster4-card Phase 1 — DDL Review 보고서
_Date: 2026-05-21_
_Scope: weekly_reviews + weekly_colleagues canonical 테이블 도입_

---

## 0. Deliverables Summary

| # | 산출물 | 경로 |
|---|---|---|
| 1 | weekly_reviews migration | `vraxium-admin/db/migrations/2026-05-21_cluster4_card_blocker_step1_create_weekly_reviews.sql` |
| 2 | weekly_colleagues migration | `vraxium-admin/db/migrations/2026-05-21_cluster4_card_blocker_step2_create_weekly_colleagues.sql` |
| 3 | DDL 리뷰 보고서 | 본 문서 |
| 4 | 검증 SQL | 본 문서 §5 |
| 5 | Front↔Backend↔Supabase 검증 계획 | 본 문서 §6 |

코드 수정: **없음** (기존 API/Front 그대로 사용)
README.md 변경: **없음** (기존 selective tracking 패턴을 유지)

---

## 1. 결정 사항과 근거

### 1.1 FK 참조 컬럼: `user_profiles(user_id)`

- `lib/get-user-profile.ts:8-9` 가 "user_profiles 의 canonical PK 는 user_id" 임을 명시
- 기존 admin migration set (`2026-05-21_peer_review_pivot_step2`, `2026-05-13_user_edit_windows`, `2026-05-13_user_review_links` 등) 모두 `user_profiles(user_id)` 참조
- Career-Resume 의 기존 `backend/database/schema/weekly_reviews.sql:9` 가 `user_profiles(id)` 로 잘못 표기되어 있었음. 이번 migration 으로 정정

### 1.2 ON DELETE 정책

| FK | 동작 | 근거 |
|---|---|---|
| `user_id → user_profiles(user_id)` | CASCADE | 사용자 삭제 시 본인 회고/동료 리스트는 같이 정리 |
| `colleague_id → user_profiles(user_id)` | CASCADE | 동료가 탈퇴하면 그 row 도 사라져야 함 |
| `week_card_id → weeks(id)` | RESTRICT | 주차를 함부로 삭제하면 회고/동료 row 가 orphan. 명시적 정리 강제 |

### 1.3 rating 타입: `smallint`

- 기존 schema 파일은 `integer` 였으나, 1..10 범위에 `smallint`(2 byte) 가 더 적합
- 디스크/메모리 절약 + CHECK 와 무관한 데이터 무결성 — 음수 표현 가능하지만 CHECK 로 1..10 강제
- 다른 활성 테이블의 rating 컬럼이 `numeric(3,1)` (weekly_reputations, season_reputations) 인 것과 다른 이유: weekly_reviews 는 0.5 step 이 없는 **정수 1..10** (Front `app/api/weekly-reviews/route.ts:120-128` 검증과 일치)

### 1.4 message 컬럼: nullable + length CHECK ≤200

- 설계 문서 v1 §4.2 의 "nullable, 0~200" 정의를 그대로 반영
- 실제 Front 코드 (`weekly-colleagues/route.ts:203`) 는 `c.message || ''` 로 NULL 대신 빈 문자열을 저장하므로 NULL 케이스는 현재 발생하지 않음. 그러나 향후 admin/스크립트 경로가 NULL 을 쓸 가능성을 위해 nullable 유지
- CHECK 는 `message IS NULL OR char_length(message) <= 200` — NULL 도 허용

### 1.5 UNIQUE 키

| 테이블 | UNIQUE | 근거 |
|---|---|---|
| `weekly_reviews` | (user_id, week_card_id) | 본인 1 주차 1 행 강제. POST 에서 `existing.id` 발견 시 409 응답 (route.ts:166-180) 이 이 제약과 짝 |
| `weekly_colleagues` | (user_id, week_card_id, colleague_id) | 같은 주차에 같은 동료 중복 등록 금지. UI 3 슬롯이라 row 수는 ≤3 |

### 1.6 자기 자신 등록 금지 (`weekly_colleagues`)

- CHECK `user_id <> colleague_id` 추가
- weekly_reputations 의 `reviewer_id <> target_user_id` 와 같은 패턴
- Front 의 crew search modal 에서 본인을 제외해서 보여주지만 (`?excludeUserId=` 쿼리), DB-level 방어

### 1.7 RLS 정책: 미부여 (기존 컨벤션 준수)

- `vraxium-admin/db/migrations/README.md:28` 의 명시적 컨벤션: "신규 테이블은 모두 `anon`/`authenticated` SELECT만, write 는 `service_role` 경유 admin API 에서만. 별도 RLS 정책은 두지 않는다"
- 같은 PR 시즌에 추가된 `2026-05-21_peer_review_pivot_step2_create_peer_review.sql` 도 RLS 미부여
- 운영상 영향 없음: Front 의 모든 weekly_reviews / weekly_colleagues 라우트가 `createAdminClient` (service_role) 사용
- ⚠️ Defense-in-depth 관점에서 우려가 있으나, 본 migration 그룹의 컨벤션을 따르고 별도 PR 에서 일괄 검토 권장 — §3.3 참조

### 1.8 idempotency

- `CREATE TABLE IF NOT EXISTS`
- `CREATE INDEX IF NOT EXISTS`
- `CREATE OR REPLACE FUNCTION`
- `DROP TRIGGER IF EXISTS ... CREATE TRIGGER ...`
- 모든 statement 가 재실행 안전 — README §"신규 마이그레이션 추가 시" 의 규칙과 일치

---

## 2. 설계 문서 v1 ↔ 구현 diff

본 단계는 v1 design doc 의 §4.2 / §4.3 을 그대로 반영. 무시할 수 없는 차이 없음.

| 항목 | 설계 doc | migration | 차이 사유 |
|---|---|---|---|
| weekly_reviews.rating 타입 | "smallint" (§4.3) | smallint | — |
| weekly_colleagues.message NOT NULL | "nullable" (§4.2) | nullable (NULL 허용) | — |
| weekly_colleagues UNIQUE | (user_id, week_card_id, colleague_id) | 동상 | — |
| weekly_colleagues.rank CHECK | 1..3 | 1..3 | — |
| 트리거 함수 / 트리거 네이밍 | 명시 없음 | `touch_<table>_updated_at()` / `<table>_set_updated_at` | 동일 migration 그룹의 weekly_reputations 트리거 네이밍과 일치 |

---

## 3. Risk 분석

### 3.1 적용 안전성

| 항목 | 위험도 | 평가 |
|---|---|---|
| Schema 충돌 (테이블 이미 존재) | 🟢 낮음 | 사용자 SQL 검증으로 미존재 확인. `IF NOT EXISTS` 로 추가 안전망 |
| FK 적용 실패 | 🟢 낮음 | `user_profiles.user_id`, `weeks.id` 모두 운영 DB 에 존재 (Cluster4-1 정상 동작이 증거) |
| 다른 migration 의존 | 🟢 낮음 | 의존 테이블 (user_profiles, weeks) 이 모두 선행 적용 상태 |
| 데이터 손실 | 🟢 없음 | CREATE only. 기존 데이터 변경/삭제 없음 |

### 3.2 적용 후 잔존 위험

| # | 위험 | 영향 | 완화 |
|---|---|---|---|
| R1 | `Career-Resume/backend/database/schema/weekly_reviews.sql` 의 broken FK 파일이 그대로 남음 | 다른 개발자가 신규 환경 부트스트랩 시 그 파일 실행 → FK 오류로 무시되지만 헷갈림 | §7.1 — 후속 PR 또는 schema 파일 정정 권장 |
| R2 | `weekly_colleagues` POST 가 delete + insert 비원자적 동작 | 네트워크 끊김 시 동료 리스트 손실 | Phase 후반 RPC/트랜잭션 보강 (별도 PR) |
| R3 | RLS 미부여 — anon key + REST 직접 접근 시 read/write 가능성 | 운영 DB 의 PostgREST exposure 설정에 의존 | §3.3 separate review |
| R4 | weekly_reviews 의 POST 가 `extractTargetUserId` 헤더로 admin 대필 가능하나, weekly_colleagues 의 POST 도 마찬가지 — 그러나 본 migration 은 둘 다 동일 권한 모델 가정 | 의도된 동작 | — |

### 3.3 RLS 도입 가능성 (별도 PR 권장)

설계 문서 v1 §5.1 의 권한 정책 매트릭스를 DB 레벨로 강제하려면:

```sql
-- weekly_reviews (사적 데이터)
ALTER TABLE public.weekly_reviews ENABLE ROW LEVEL SECURITY;
CREATE POLICY weekly_reviews_owner_select ON public.weekly_reviews
  FOR SELECT TO authenticated USING (user_id = auth.uid());
CREATE POLICY weekly_reviews_owner_modify ON public.weekly_reviews
  FOR ALL TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

-- weekly_colleagues (사적 데이터)
ALTER TABLE public.weekly_colleagues ENABLE ROW LEVEL SECURITY;
CREATE POLICY weekly_colleagues_owner_select ON public.weekly_colleagues
  FOR SELECT TO authenticated USING (user_id = auth.uid());
CREATE POLICY weekly_colleagues_owner_modify ON public.weekly_colleagues
  FOR ALL TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
```

- 적용 시 영향: service_role 은 RLS bypass 이므로 Front API 동작에 변화 없음
- weekly_reputations / season_reputations 에도 같은 검토가 필요 (별도 통합 PR 권장)
- 본 PR 에서는 컨벤션 준수가 우선이라 미포함

---

## 4. Rollback 절차

migration 적용 후 문제가 발견되면 다음 SQL 로 rollback. 단, **이미 row 가 들어가 있으면 row 도 사라지므로 신중**.

```sql
BEGIN;

-- Step 2 rollback
DROP TRIGGER IF EXISTS weekly_colleagues_set_updated_at ON public.weekly_colleagues;
DROP FUNCTION IF EXISTS public.touch_weekly_colleagues_updated_at();
DROP TABLE IF EXISTS public.weekly_colleagues;

-- Step 1 rollback
DROP TRIGGER IF EXISTS weekly_reviews_set_updated_at ON public.weekly_reviews;
DROP FUNCTION IF EXISTS public.touch_weekly_reviews_updated_at();
DROP TABLE IF EXISTS public.weekly_reviews;

COMMIT;
```

> Cluster4-1 정상 동작에는 영향 없음 (이 두 테이블에 의존하는 기능은 cluster-4-card 의 Weekly Review 박스와 연계 동료 섹션뿐).

---

## 5. 적용 후 검증 SQL (Supabase SQL Editor)

### 5.1 테이블 / 컬럼 / 제약 검증

```sql
-- (1) 테이블 존재 확인
SELECT
  to_regclass('public.weekly_reviews')    AS weekly_reviews,
  to_regclass('public.weekly_colleagues') AS weekly_colleagues;

-- (2) 컬럼 검증
SELECT table_name, column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name IN ('weekly_reviews','weekly_colleagues')
ORDER BY table_name, ordinal_position;

-- (3) FK 검증 — 모두 user_profiles(user_id) 또는 weeks(id) 참조여야 함
SELECT
  tc.table_name,
  tc.constraint_name,
  kcu.column_name        AS local_col,
  ccu.table_name         AS foreign_table,
  ccu.column_name        AS foreign_col,
  rc.update_rule,
  rc.delete_rule
FROM information_schema.table_constraints tc
JOIN information_schema.key_column_usage kcu
  ON tc.constraint_name = kcu.constraint_name
 AND tc.table_schema    = kcu.table_schema
JOIN information_schema.constraint_column_usage ccu
  ON ccu.constraint_name = tc.constraint_name
JOIN information_schema.referential_constraints rc
  ON rc.constraint_name = tc.constraint_name
WHERE tc.table_schema    = 'public'
  AND tc.constraint_type = 'FOREIGN KEY'
  AND tc.table_name IN ('weekly_reviews','weekly_colleagues')
ORDER BY tc.table_name, tc.constraint_name;

-- (4) CHECK / UNIQUE 제약 검증
SELECT c.relname AS table_name, con.conname, pg_get_constraintdef(con.oid) AS definition
FROM pg_constraint con
JOIN pg_class      c   ON c.oid = con.conrelid
JOIN pg_namespace  n   ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN ('weekly_reviews','weekly_colleagues')
  AND con.contype IN ('c','u')
ORDER BY c.relname, con.conname;

-- (5) INDEX 검증
SELECT tablename, indexname, indexdef
FROM pg_indexes
WHERE schemaname = 'public'
  AND tablename IN ('weekly_reviews','weekly_colleagues')
ORDER BY tablename, indexname;

-- (6) Trigger 검증
SELECT event_object_table AS table_name, trigger_name, event_manipulation, action_timing
FROM information_schema.triggers
WHERE event_object_schema = 'public'
  AND event_object_table IN ('weekly_reviews','weekly_colleagues')
ORDER BY event_object_table, trigger_name;
```

### 5.2 기대 결과

| 항목 | 기대값 |
|---|---|
| (1) 테이블 | 두 테이블 모두 `public.weekly_reviews` / `public.weekly_colleagues` 로 표시 (NULL 아님) |
| (2) 컬럼 | weekly_reviews 7 컬럼, weekly_colleagues 8 컬럼. NOT NULL / 타입 일치 |
| (3) FK | weekly_reviews.user_id → user_profiles.user_id (CASCADE), weekly_reviews.week_card_id → weeks.id (RESTRICT). weekly_colleagues.user_id / colleague_id → user_profiles.user_id (CASCADE), week_card_id → weeks.id (RESTRICT) |
| (4) CHECK / UNIQUE | 위 §1.5, §1.6 의 제약 모두 표시 |
| (5) INDEX | weekly_reviews 2 개 + PK, weekly_colleagues 2 개 + PK |
| (6) Trigger | 각 테이블에 BEFORE UPDATE 트리거 1 개 |

### 5.3 CHECK 동작 smoke test (선택)

```sql
-- 본인=동료 등록 시도 → 22023 (check_violation) 기대
BEGIN;
INSERT INTO public.weekly_colleagues (user_id, week_card_id, colleague_id, rank)
SELECT user_id, (SELECT id FROM public.weeks LIMIT 1), user_id, 1
FROM public.user_profiles LIMIT 1;
ROLLBACK;

-- rank=4 시도 → check_violation 기대
BEGIN;
INSERT INTO public.weekly_colleagues (user_id, week_card_id, colleague_id, rank)
SELECT
  (SELECT user_id FROM public.user_profiles LIMIT 1),
  (SELECT id FROM public.weeks LIMIT 1),
  (SELECT user_id FROM public.user_profiles OFFSET 1 LIMIT 1),
  4;
ROLLBACK;

-- rating=11 시도 → check_violation 기대
BEGIN;
INSERT INTO public.weekly_reviews (user_id, week_card_id, rating, content)
SELECT
  (SELECT user_id FROM public.user_profiles LIMIT 1),
  (SELECT id FROM public.weeks LIMIT 1),
  11,
  'test';
ROLLBACK;
```

위 3 개 INSERT 가 모두 `ERROR: ... violates check constraint ...` 로 거부되면 CHECK 정상.

---

## 6. Front ↔ Backend ↔ Supabase 검증 계획

> 본 단계에서는 사용자가 운영 DB 에 migration 을 적용한 직후 수동 점검을 위해 시나리오를 명시합니다. 실제 테스트 실행은 사용자 측.

### 6.1 Weekly Review smoke test

| # | 행동 | 기대 결과 | 검증 위치 |
|---|---|---|---|
| 1 | 본인 계정으로 `/cluster-4-card/{weekId}` 접속 | weekly-review 박스가 "아직 작성된 리뷰가 없습니다 …" 로 표시 (DB 비어 있음) | Front UI |
| 2 | 네트워크 탭에서 `GET /api/weekly-reviews?weekCardId=...&userId=...` 응답 | `200 { success: true, data: null }` | DevTools Network |
| 3 | weekly-review modal 열고 rating + content 입력 후 저장 | `POST /api/weekly-reviews` body `{ weekCardId, rating, content }` → `200 { success:true, data:{ id, userId, weekCardId, rating, content, ...} }` | Network |
| 4 | DB 확인 | `SELECT * FROM public.weekly_reviews WHERE user_id = '<myUserId>' AND week_card_id = '<weekId>'` → 1 행, rating/content 일치 | Supabase SQL |
| 5 | 같은 modal 다시 열고 rating 변경 후 저장 | `PUT /api/weekly-reviews/<id>` → `200 { success:true, data:{...} }` | Network |
| 6 | DB 확인 | rating 갱신, `updated_at` 이 더 최신 | Supabase SQL |
| 7 | 다른 주차에서 동일 시도 | 같은 user 라도 다른 week_card_id 면 별 행 생성 OK | DB |
| 8 | 같은 주차에서 POST 재호출 (id 모름 가정) | `409 { error: '이미 해당 주차 리뷰가 존재합니다. 수정 API를 사용해주세요.', existingId }` (route.ts:173-181) | Network |
| 9 | 작성 기간 닫혀 있을 때 저장 시도 | `403 { error: 'EDIT_WINDOW_CLOSED', message: ... }` + Front 가 통일 안내 표시 | Network + UI |

### 6.2 Weekly Colleagues smoke test

| # | 행동 | 기대 결과 |
|---|---|---|
| 1 | `GET /api/weekly-colleagues?userId=&weekCardId=` | `200 { success:true, data: [] }` |
| 2 | crew search modal 에서 동료 1-3 명 선택 후 저장 | `POST /api/weekly-colleagues` body `{ weekCardId, colleagues: [{colleagueId, rank, message}, ...] }` → `200 { success:true }` |
| 3 | DB | `SELECT * FROM public.weekly_colleagues WHERE user_id=... AND week_card_id=... ORDER BY rank` → 선택 수만큼 행, rank 1..N |
| 4 | 같은 주차 다시 저장 (동료 1 명 빼고 2 명만) | 기존 행 모두 delete 후 새로 2 행 insert |
| 5 | DB | 행 수 = 2, 빠진 동료의 row 없음 |
| 6 | 본인을 동료로 지정 시도 (Front 가 막지만 직접 API 호출) | DB CHECK `weekly_colleagues_no_self` 위반 → `500` (Supabase 에러) — Front 가 본인 제외하므로 실제 노출은 없음 |
| 7 | 같은 동료 2 번 등록 시도 (rank=1, rank=2 로 둘 다 colleagueId 동일) | UNIQUE `weekly_colleagues_unique_user_week_colleague` 위반 |
| 8 | rank=4 시도 | CHECK `weekly_colleagues_rank_range` 위반 |

### 6.3 회귀 가드 — Cluster4-1 / Season 기능

- `/cluster-4-1` Season Review (`user_season_histories.review`) — **변경 없음** 확인
- `/cluster-4-1` Season Reputation (`season_reputations`) — **변경 없음** 확인
- 본 migration 은 두 신규 테이블만 도입하므로 다른 기능 회귀 위험은 0.

---

## 7. 잔존 cleanup 권장 (본 PR scope 외)

### 7.1 Career-Resume 의 broken schema 파일

`Career-Resume/backend/database/schema/weekly_reviews.sql:9` 는 여전히 `REFERENCES public.user_profiles (id)` 로 표기. 실 production 은 이번 migration 으로 정정되지만, 그 파일이 그대로 남아 있어 신규 환경 부트스트랩 시 혼란 가능.

권장 액션 (별도 PR):
- (a) 이 파일을 본 migration 과 동일한 정의로 갱신
- 또는 (b) 파일 헤더에 "초기 schema 파일은 폐기. 운영 진실은 `vraxium-admin/db/migrations/2026-05-21_cluster4_card_blocker_step1_create_weekly_reviews.sql`" 명시 + DDL 비활성화
- 또는 (c) 파일을 deprecated 폴더로 이동

### 7.2 Career-Resume schema 폴더에 weekly_colleagues.sql 추가

기존 `backend/database/schema/` 디렉토리 컨벤션을 유지하려면 weekly_colleagues 도 미러 파일을 두는 것이 일관됨. 단, vraxium-admin migration 이 운영 진실인 한 필수 작업은 아님.

### 7.3 README.md 업데이트

`vraxium-admin/db/migrations/README.md` 의 표가 #10 (2026-05-13) 까지만 추적 중 — `2026-05-21_peer_review_pivot_*` 4 개와 이번 cluster4_card_blocker_step1/2 까지 등록되어 있지 않음. 별도 PR 에서 일괄 정리 권장.

---

## 8. 본 PR 변경 사항 요약

| 분류 | 내역 |
|---|---|
| 신규 migration | 2 개 (`2026-05-21_cluster4_card_blocker_step1_create_weekly_reviews.sql`, `2026-05-21_cluster4_card_blocker_step2_create_weekly_colleagues.sql`) |
| 신규 문서 | 1 개 (본 보고서) |
| 수정한 코드 파일 | 0 개 |
| 수정한 Front 파일 | 0 개 |
| 수정한 API 라우트 | 0 개 |
| README/schema 파일 변경 | 0 개 (cleanup 은 §7 에 위임) |

---

## 9. 다음 단계 사용자 액션

1. **migration 적용**: Supabase SQL Editor 에 step1 → step2 순서로 파일 내용 붙여넣기 실행
2. **검증 SQL §5 실행**: 6 개 query 결과를 §5.2 기대값과 비교
3. **smoke test §6 실행**: weekly review + weekly colleague 저장/조회 사이클 (네트워크 200 + DB row 1:1 확인)
4. **회귀 가드**: Cluster4-1 의 Season Review / Season Reputation 이 여전히 정상인지 sanity check
5. 위 4 단계가 모두 OK 이면 Phase 1 종료 → 이후 Phase 2 (Schema 정합화) 또는 Phase 3 (Admin 조회 UI) 단계로 진행 가능

문제 발생 시 §4 rollback SQL 즉시 사용 가능.
