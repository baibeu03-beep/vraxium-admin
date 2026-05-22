# Cluster4-card Step 1 Status Report
_Date: 2026-05-21_
_Scope: weekly_reviews API + 테이블 존재 확인 + v1 결정 문서화_

## TL;DR

이번 단계에서 **새로 작성한 코드는 없습니다**. 사용자가 요청한 4개 작업은 다음과 같이 정리됩니다:

| 항목 | 결과 |
|---|---|
| 1. weekly_reviews API 라우트 | **이미 구현되어 있음** (commit `0e0d81c`). 추가 작성 불필요. 단, 스키마 파일 FK 오류로 인한 production 적용 여부 검증 필요 |
| 2. weekly_colleagues 테이블 | API는 사용 중이지만 **schema 파일이 버전관리에 없음**. Production에는 존재 추정 — 사용자 검증 필요 |
| 3. user_activity_details 테이블 | Schema 파일 존재 + ALTER migration 존재 + activity-details API가 production에서 사용 중 → **존재 확실** |
| 4. workexp.rating / workcar supervisor v1 결정 | 본 문서에 방향만 기록. 구현/migration 없음 |

---

## 1. weekly_reviews API 라우트

### 1.1 현황

| 경로 | 메서드 | 상태 |
|---|---|---|
| `Career-Resume/app/api/weekly-reviews/route.ts` | GET, POST | ✅ 존재 |
| `Career-Resume/app/api/weekly-reviews/[id]/route.ts` | PUT, DELETE | ✅ 존재 |

이전 조사 보고서는 `app/(host)/api/weekly-reviews/` 경로만 찾아 "라우트 없음"이라고 잘못 결론지었습니다. 실제 라우트는 `app/api/weekly-reviews/`에 있으며 `0e0d81c feat: 주차 리뷰(weekly_reviews) 실데이터 연동 + 본인 페이지 한정 수정 가드` 커밋으로 추가되어 있습니다.

> **Note**: Career-Resume에는 `app/(host)/api/...`와 `app/api/...` 두 그룹의 라우트가 공존합니다. weekly-reviews는 후자 그룹입니다. Cluster4CardContent.tsx가 호출하는 `/api/weekly-reviews` URL은 Next.js의 route groups 규칙상 양쪽 모두에서 매칭 가능합니다.

### 1.2 라우트 감사 결과

| 항목 | 평가 | 근거 |
|---|---|---|
| 인증 게이트 | ✅ 정합 | GET/POST: `requireOwnerOrAdmin(userId)` / PUT/DELETE: 별도 `getUserProfile + isAdminEmail` |
| 작성 기간 게이트 | ✅ 정합 | `CLUSTER4_EDIT_RESOURCE_KEYS.weeklyReviews = "cluster4.weekly_reviews"` 사용. admin 우회 처리 명확 |
| 403 응답 코드 | ✅ Front 기대값과 일치 | `{ error: "EDIT_WINDOW_CLOSED", message: EDIT_WINDOW_LOCKED_MESSAGE }` — Cluster4CardContent.tsx:3869 분기와 매칭 |
| 응답 shape | ✅ Front 기대값과 일치 | `{ success: true, data: { id, weekCardId, rating, content, created_at, updated_at } }` — Cluster4CardContent.tsx:3879-3881과 매칭 |
| 입력 검증 | ✅ 스키마 제약과 일치 | rating: 1~10 integer / content: 1~200자 — `weekly_reviews.sql`의 CHECK 제약과 동일 |
| 중복 방지 | ✅ 명확 | POST에서 `(user_id, week_card_id)` 기존 row 발견 시 409 + `existingId` 반환 |
| 에러 로그 | ✅ silent fail 없음 | 모든 실패 경로에 `console.error` 기록. Front도 `[weekly-review] API 응답 오류:` 로그 출력 |
| ID 컨벤션 | ⚠️ 일관됨 (혼란스럽지만) | PUT/DELETE가 `profile.id`를 비교하지만 `get-user-profile.ts`의 alias 로직으로 사실상 `user_id` 값. 버그 아님 |

### 1.3 잠재 리스크: 스키마 FK 불일치

**`Career-Resume/backend/database/schema/weekly_reviews.sql:9`**:
```sql
user_id       uuid NOT NULL REFERENCES public.user_profiles (id) ON DELETE CASCADE,
```

그러나 `Career-Resume/lib/get-user-profile.ts:8-9`에 명시:
> `user_profiles 테이블은 user_id 컬럼을 canonical PK로 사용합니다. (별도 id 컬럼이 존재하지 않음)`

즉 `user_profiles.id` 컬럼은 존재하지 않으므로 위 FK는 **DDL 적용 시 ERROR로 실패합니다**. 가능한 시나리오:

1. **(가능성 높음)** Schema 파일이 production에 적용되지 않아 `weekly_reviews` 테이블이 존재하지 않는 상태 → 라우트 호출 시 Supabase가 `relation "weekly_reviews" does not exist` 500 반환 → Front는 `setWeeklyReviewFromDB(null)`로 무음 처리
2. 수동으로 FK 없이(혹은 `user_profiles(user_id)`로 수정해서) 생성됨 → 동작은 정상
3. `user_profiles`에 실제로 `id` 컬럼이 있는데 `get-user-profile.ts`의 코멘트가 오래된 것 (가능성 낮음 — 같은 파일에서 `id`/`user_id` alias 처리를 명시적으로 함)

**확인 SQL** (Supabase SQL Editor에서 실행):
```sql
-- (1) weekly_reviews 테이블 존재 여부
SELECT to_regclass('public.weekly_reviews') AS exists_check;

-- (2) 존재한다면 컬럼/제약 확인
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'weekly_reviews'
ORDER BY ordinal_position;

-- (3) FK 실제 참조 컬럼 확인
SELECT
  tc.constraint_name,
  kcu.column_name AS local_col,
  ccu.table_name  AS foreign_table,
  ccu.column_name AS foreign_col
FROM information_schema.table_constraints tc
JOIN information_schema.key_column_usage kcu
  ON tc.constraint_name = kcu.constraint_name
JOIN information_schema.constraint_column_usage ccu
  ON ccu.constraint_name = tc.constraint_name
WHERE tc.table_name = 'weekly_reviews'
  AND tc.constraint_type = 'FOREIGN KEY';

-- (4) user_profiles 의 ID 관련 컬럼이 무엇인지
SELECT column_name FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'user_profiles'
  AND column_name IN ('id', 'user_id');
```

**다음 단계 결정 트리** (사용자 검증 후):
- (1)의 결과가 `null` → 테이블 미존재 → `weekly_reviews.sql`의 FK를 `user_profiles(user_id)`로 수정한 후 적용 필요 (별도 단계에서 migration 작성)
- (1)이 존재 + (3)이 `user_profiles(user_id)` 참조 → 정상. 스키마 파일만 코드와 일치하도록 수정 필요 (DDL 변경 없음)
- (1)이 존재 + (3)이 `user_profiles(id)` 참조 → `user_profiles.id` 컬럼이 실제로 존재한다는 의미. `get-user-profile.ts` 주석 정정 필요

---

## 2. weekly_colleagues 테이블

### 2.1 현황

- **Route**: `Career-Resume/app/(host)/api/weekly-colleagues/route.ts` (GET, POST 존재). 일관되게 `weekly_colleagues` 테이블을 `user_profiles.user_id`와 매칭해서 사용.
- **Schema migration / DDL 파일**: 두 repo 어디에도 **없음**. 검색 결과 0건:
  - `Career-Resume/backend/database/schema/` ❌
  - `Career-Resume/db/migrations/` ❌
  - `vraxium-admin/db/migrations/` ❌

### 2.2 추정 컬럼 (route.ts:33~45, 197~203 기준)

```
id            uuid PRIMARY KEY
user_id       uuid NOT NULL  -- 추정 FK: user_profiles(user_id)
week_card_id  uuid NOT NULL  -- 추정 FK: weeks(id)
colleague_id  uuid NOT NULL  -- 추정 FK: user_profiles(user_id)
rank          integer NOT NULL
message       text
created_at    timestamptz DEFAULT now()
```

POST가 `delete + insert` 전체 교체 방식으로 동작하므로 `(user_id, week_card_id)` 범위에 row 그룹이 형성됨. UNIQUE 제약은 추정상 없거나 `(user_id, week_card_id, colleague_id)`로 잡혀 있을 가능성.

### 2.3 확인 SQL

```sql
SELECT to_regclass('public.weekly_colleagues') AS exists_check;

SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'weekly_colleagues'
ORDER BY ordinal_position;

-- 제약/인덱스 확인
SELECT conname, pg_get_constraintdef(c.oid)
FROM pg_constraint c
JOIN pg_class t ON c.conrelid = t.oid
WHERE t.relname = 'weekly_colleagues';
```

### 2.4 결론

API 코드가 production에서 정상 동작 중이라면 테이블은 분명히 존재합니다 (Supabase Studio에서 수동 생성됐을 가능성). 그러나 **버전관리 외에 존재하는 테이블은 유지보수 리스크**이므로, 다음 단계에서 production schema를 capture해서 schema 파일로 commit하는 것이 권장됩니다.

---

## 3. user_activity_details 테이블

### 3.1 현황

| 증거 | 결과 |
|---|---|
| Schema 파일 | ✅ `Career-Resume/backend/database/schema/user-activity-details-schema.sql` |
| ALTER migration | ✅ `Career-Resume/db/migrations/alter_user_activity_details_add_growth_image.sql` |
| API 사용 | ✅ `app/(host)/api/activity-details/route.ts` — 3곳에서 `from('user_activity_details')` 호출 |
| Front 의존도 | ✅ Cluster4CardContent.tsx의 workinfo/workability/workexp가 모두 이 테이블 사용 |

### 3.2 주의사항

스키마 파일의 FK가 **`users(id)`**를 참조 (line 10). 다른 테이블들(`user_profiles(user_id)`)과 다릅니다. 이는 Supabase `auth.users` 테이블을 가리키는 것으로 추정되며, `session.user.id` = `auth.users.id` = `user_profiles.user_id` 동치 관계가 유지되는 한 의미상 문제 없습니다.

### 3.3 결론

**존재 확실.** 추가 확인 불필요. 활동 데이터는 이미 production에서 작동 중입니다.

---

## 4. workexp.rating / workcar supervisor — v1 결정 (구현 없음)

이 결정은 **방향만 기록**합니다. 코드 변경, migration 생성은 다음 단계에서 별도로 진행합니다.

### 4.1 workexp.rating

**제안 v1 방향**: `user_activity_details` 테이블에 `rating` (smallint, nullable) 컬럼 추가.

**근거**:
- workexp 섹션은 이미 `user_activity_details`를 base 테이블로 사용 중 (`activity_type_id IN exp-1..exp-N`)
- 별도 `experience_ratings` 테이블을 만들면 join이 추가되고 RLS/edit-window 정책도 중복 관리 필요
- rating은 activity-detail per-row 1:1 관계이므로 정규화 가치가 낮음
- nullable로 두면 workinfo/workability 같은 다른 activity_type에서는 비워두면 됨

**대안 (선택지 B)**: 별도 `experience_ratings(user_id, week_id, activity_type_id, rating)` 테이블 + UNIQUE 제약.
- 장점: workexp 전용 정책 분리 가능, audit log 분리 용이
- 단점: 위 단점

**다음 단계로 미루는 이유**: 
- Front의 현재 rating 저장 경로가 코드상 명시되지 않음 (workExpRating state는 있는데 API 호출 시 payload에 포함되는지 불명) → 먼저 Front의 save 호출부에서 rating이 어디로 가는지 확인 필요
- 무지성 컬럼 추가 시 향후 변경 비용 증가

### 4.2 workcar supervisor

**제안 v1 방향**: `career_records` 테이블에 평면 텍스트 컬럼 5개 추가:
- `supervisor_name` (text, nullable)
- `supervisor_position` (text, nullable)
- `supervisor_department` (text, nullable)
- `supervisor_company` (text, nullable)
- `supervisor_profile_img_url` (text, nullable)

**근거**:
- Front에서 5개 필드를 그대로 렌더링 중 (Cluster4CardContent.tsx의 CareerRecord 인터페이스)
- supervisor가 별도 인증/프로필을 가진 user_profile 엔티티가 아니라 외부 사람(현업 멘토)일 가능성이 높음 — FK로 정규화하면 supervisor 마스터 테이블이 또 필요해짐
- v1은 raw text로 두고, 향후 supervisor 마스터화가 필요하다면 v2에서 user_id로 마이그레이션 가능

**대안 (선택지 B)**: `career_supervisors(id, name, position, department, company, profile_img_url)` 마스터 테이블 + `career_records.supervisor_id` FK.
- 장점: 동일 supervisor 중복 입력 방지, 마스터 데이터 일관성
- 단점: 마스터 등록 UI/관리자 권한 추가 필요. v1 범위 초과.

**다음 단계로 미루는 이유**:
- 현재 Front 어디서도 supervisor 입력 UI가 안 보임 (read-only display만 존재) → supervisor 데이터가 어디서 들어오는지 확인 필요
- career_projects 테이블에 이미 supervisor 컬럼이 있는데 코드가 못 찾고 있을 가능성도 있음

---

## 5. 수정 파일 / 미수정 파일

### 수정한 파일: 없음

- weekly_reviews 라우트: 이미 정합하게 구현되어 있어 수정 없음
- weekly_colleagues / user_activity_details: 코드 변경 없음 (테이블 검증만 SQL로 사용자에게 요청)
- 스키마 파일: 수정 금지 지시에 따라 변경 없음

### 새로 만든 파일

- 본 문서 `claudedocs/cluster4-card-step1-status-20260521.md`

---

## 6. 다음 단계 권장

1. **사용자 액션**: 위 §1.3, §2.3의 확인 SQL을 Supabase Studio에서 실행해 결과 공유
2. 그 결과에 따라:
   - `weekly_reviews` 테이블 미존재 시 → FK 정정된 schema 파일 작성 + 적용 단계
   - `weekly_colleagues` 테이블 존재 + schema 없음 → production에서 schema dump → schema 파일로 commit
3. workexp Front 코드에서 rating 저장 경로 확인 (Cluster4CardContent.tsx 검색)
4. workcar Front에서 supervisor 입력 UI가 있는지, 아니면 read-only인지 확인 후 v1 컬럼 추가 단계 분리

---

## Appendix A: 검증된 정합성 매트릭스

| Front 호출 (Cluster4CardContent.tsx) | API endpoint | API 상태 | 응답 정합 |
|---|---|---|---|
| `GET /api/weekly-reviews?userId&weekCardId` | `app/api/weekly-reviews/route.ts:GET` | ✅ | ✅ `data: WeeklyReviewClient \| null` |
| `POST /api/weekly-reviews` body `{weekCardId, rating, content}` | `app/api/weekly-reviews/route.ts:POST` | ✅ | ✅ `data: WeeklyReviewClient` |
| `PUT /api/weekly-reviews/:id` body `{weekCardId, rating, content}` | `app/api/weekly-reviews/[id]/route.ts:PUT` | ✅ | ✅ `data: WeeklyReviewClient` |
| 403 `EDIT_WINDOW_CLOSED` | both routes | ✅ | ✅ Front 분기 매칭 |

## Appendix B: 핵심 헬퍼 동작

| 헬퍼 | 위치 | 핵심 동작 |
|---|---|---|
| `requireOwnerOrAdmin(targetUserId)` | `lib/api-auth.ts` | 세션 확인 → 본인 user_id 조회 → 본인/admin 권한 체크. `context.targetUserId`는 항상 `user_profiles.user_id` 형태의 uuid |
| `getUserProfile(select, targetUserId)` | `lib/get-user-profile.ts` | select에 `"id"` 와도 자동으로 `user_id` 정규화. 반환 객체에 `id` alias 채워 넣음 → `profile.id === profile.user_id` 보장 |
| `hasOpenEditWindow({userId, resourceKey})` | `lib/editWindow.ts` | `user_edit_windows` 테이블의 `(user_id, resource_key)` row가 `opened_at <= now < expires_at` 조건 만족 시 true |
| `CLUSTER4_EDIT_RESOURCE_KEYS.weeklyReviews` | `lib/cluster4EditWindow.ts` | `"cluster4.weekly_reviews"` 문자열 상수 |
