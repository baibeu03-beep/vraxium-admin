# Cluster4-card 최종 데이터 모델 설계서
_Date: 2026-05-21_
_상태: 설계 확정(안). Migration / Supabase 변경 없음. 코드 수정 없음._

---

## 0. Executive Summary

| 섹션 | Front 사용 중 | DB 상태 | 다음 단계 |
|---|---|---|---|
| reputation | ✅ active | `weekly_reputations` — 적용 가능성 높음 (Cluster4-1과 같은 step2 migration). 사용자 SQL 재확인 권장 | Admin 조회 UI |
| colleague | ✅ active | `weekly_colleagues` — **미존재 확인** | 신규 migration 필요 (다음 단계) |
| weekly review | ✅ active | `weekly_reviews` — **미존재 확인** (schema 파일 FK 오류로 적용 실패 추정) | 신규 migration 필요 (다음 단계) |
| workinfo | ✅ active | `user_activity_details` — 사용 중 추정 (재확인 권장) | Admin 조회/수정 UI |
| workability | ✅ active | `user_activity_details` 공유 | Admin 조회/수정 UI |
| workexp | ✅ active | `user_activity_details` 공유 + grade UI 일부 미연동 | Phase 후반 |
| workcar | ✅ active | `career_projects` + `career_records` + `career_project_weeks` — 사용 중 추정 | Admin Project/Record 분리 UI |

**핵심 결론**: Cluster4-card의 7개 섹션은 모두 **실제 운영 기능**이며 mock/legacy 없음. DB 측의 schema drift 2건(`weekly_reviews`, `weekly_colleagues` 미존재)이 silent fail로 가려져 있던 상태이며, 이 두 테이블이 본 Phase의 최우선 차단 요소입니다.

---

## 1. 5개 핵심 질문 직답

### A. reputation section은 Season Reputation과 별개인가, 같은 데이터를 재사용하는가?

**완전 별개의 데이터.** 같은 peer-review 패턴을 따르지만 테이블/주기/제약이 다릅니다.

| 항목 | `/cluster-4-card` reputation (주차) | `/cluster-4-1` Season Reputation (시즌) |
|---|---|---|
| 테이블 | `weekly_reputations` | `season_reputations` |
| 스코프 키 | `(reviewer_id, target_user_id, **week_card_id**)` | `(reviewer_id, target_user_id, **season_history_id**)` |
| rating 범위 | 0~10, 0.5 step (**0 허용**) | 1~10, 0.5 step (**0 금지**) |
| content 길이 | 1~100자 | 1~300자 |
| 키워드 컬럼 | `keyword` (1개, free text) | `keyword_1`, `keyword_2`, `keyword_3` (3개 distinct) |
| Rate limit (앱 레이어) | reviewer 7 sent / target 4 received per week | reviewer 10 sent / target 7 received per season |
| Front API | `/api/weekly-reputations` | `/api/season-reputations` |

근거: `vraxium-admin/db/migrations/2026-05-21_peer_review_pivot_step2_create_peer_review.sql:47-130`. 두 테이블 모두 같은 step2 migration에 정의되어 있어 같이 적용됐을 가능성이 높음 — Cluster4-1 Season Reputation이 정상 작동하므로 `weekly_reputations`도 사실상 적용된 상태로 추정. 단 SQL 재확인 권장.

### B. weekly review는 weekly_reviews 테이블을 새로 사용하는 기능인가, 기존 user_season_histories와 관계가 있는가?

**완전 별개.** `weekly_reviews`는 **주차별 본인 회고**를, `user_season_histories.review`는 **시즌별 본인 회고**를 저장합니다.

| 항목 | Weekly Review (`weekly_reviews`) | Season Review (`user_season_histories.review`) |
|---|---|---|
| 스코프 | `(user_id, week_card_id)` UNIQUE | `user_season_histories` 행당 1개 (시즌 자체에 1:1) |
| rating 범위 | 1~10 정수 | 1~10 정수 (numeric으로 추정) |
| content/review 길이 | 1~200자 | 별도 제약 (시즌 review는 더 긴 텍스트 허용 추정) |
| Front API | `/api/weekly-reviews` (GET/POST) + `/api/weekly-reviews/[id]` (PUT/DELETE) | `/api/season-review` (GET/PUT) |
| UI 위치 | `/cluster-4-card` Weekly Review 박스 (좌하단 unfurl 카드) | `/cluster-4-1` Section 3 area-5 |
| 자기 작성 | 본인 1건 | 본인 시즌별 1건 |
| Admin override | 라우트에 있음 (`isAdminEmail` bypass) | **현재 없음** (`/api/season-review` PUT은 엄격 ownership only) |

근거: `Career-Resume/app/api/weekly-reviews/{route.ts, [id]/route.ts}`, `Career-Resume/app/(host)/api/season-review/route.ts`, `Career-Resume/backend/database/schema/weekly_reviews.sql`.

### C. colleague section은 weekly_colleagues 테이블이 canonical인가?

**Front/API 코드 기준으로는 canonical.** 그러나 SQL 검증으로 **production에 미존재 확인**.

- Front: `Cluster4CardContent.tsx`가 `/api/weekly-colleagues` 호출
- API: `Career-Resume/app/(host)/api/weekly-colleagues/route.ts`가 `weekly_colleagues` 테이블 read/write
- Schema 파일: **두 repo 어디에도 없음** (`Career-Resume/backend/database/schema/`, `Career-Resume/db/migrations/`, `vraxium-admin/db/migrations/` 모두 검색 0건)
- production 상태: 사용자 SQL 검증으로 미존재

**결론**: `weekly_colleagues`가 canonical로 설계되었으나 **schema 적용이 빠진 상태**. 다음 Phase에서 새 migration 작성 필요.

### D. workinfo / workability / workexp가 user_activity_details 공유 모델인가?

**예. 동일 테이블, `activity_type_id` 컬럼으로 구분되는 공유 모델.**

| 섹션 | `activity_type_id` 값 (Front 코드 기준) | 사용 컬럼 |
|---|---|---|
| workinfo | `wisdom`, `essay`, `forum`, `infodesk`, `calendar`, `session`, `practical_lecture`, `community`, `etc_a` 등 | sub_title, output_links, image_urls, image_captions, growth_point |
| workability | `comp-1`, `comp-2`, ... (competency 코드) | 동일 + 태그/뱃지 표현은 클라이언트 매핑 |
| workexp | `exp-1`, `exp-2`, ... (experience 코드) | 동일 + **rating** (현재 저장 경로 불명, §6.E 참조) |

근거: `Career-Resume/app/(host)/api/activity-details/route.ts` (단일 라우트로 3섹션 모두 처리), `backend/database/schema/user-activity-details-schema.sql`. UNIQUE 제약은 `(user_id, week_id, activity_type_id)` 1행.

`workexp.rating`만 예외 — Front state에 `workExpRating`가 있으나 현 코드의 `POST /api/activity-details` payload에는 rating 필드가 없음. **현재 rating 저장 경로는 존재하지 않음** (next Phase에서 결정 필요).

### E. workcar의 supervisor 정보는 실제로 저장되는 데이터인가, 현재 표시용 mock인가?

**실데이터.** 두 테이블에 칼럼이 있고 API가 둘 다 select 후 우선순위로 머지합니다.

- 1순위: `career_projects.{supervisor_name, supervisor_position, supervisor_department, supervisor_company, supervisor_profile_img}` — admin이 프로젝트 마스터 단위로 지정
- 2순위 (legacy fallback): `career_records.{supervisor_name, ...}` — 구 데이터 호환

근거: `Career-Resume/app/(host)/api/career-records/route.ts:115-121`:
```
supervisor_name: project.supervisor_name || userRecord?.supervisor_name || null,
...
```

Front (Cluster4CardContent.tsx:5723-5727)는 API 응답의 `record.supervisor_*`를 우선 사용하며 default 이미지로 fallback. **데모 모드일 때만** state 초기값(line 699-755)의 hardcoded 5건 (김민지/박서연/조워싱턴 등)이 표시됨. non-demo에서는 API 응답이 즉시 덮어쓰므로 표시 mock이 아니라 **DB 저장 대상의 실데이터**.

⚠️ Schema 파일은 두 repo 모두 미발견 — 컬럼 존재가 코드 기반 추정. production 검증 SQL 권장 (§7 Appendix).

---

## 2. 섹션별 Front 데이터 흐름 (재조사)

### 2.1 reputation section (weekly)

| 항목 | 값 |
|---|---|
| State | `weeklyReputations` (Cluster4CardContent.tsx:1964) |
| Type | API 응답에 따른 inline (id, reviewer_id, target_user_id, week_card_id, rating, content, keyword, created_at, reviewer object) |
| GET | `/api/weekly-reputations?targetUserId=&weekCardId=` |
| POST | `/api/weekly-reputations` body `{ targetUserId, weekCardId, rating, content, keyword }` |
| PUT | `/api/weekly-reputations` body `{ id, rating, content, keyword }` |
| DELETE | `/api/weekly-reputations?id=` |
| Edit UI | `reputation-view-modal` 안의 reputation-form (rating dropdown + content textarea + keyword dropdown) |
| 권한 | 자기 자신에게 작성 금지. reviewer만 본인 작성분 수정/삭제. admin override 있음. |
| 분류 | **운영 중인 기능** |

### 2.2 colleague section

| 항목 | 값 |
|---|---|
| State | `selectedColleagues` (Cluster4CardContent.tsx:1975) |
| GET | `/api/weekly-colleagues?userId=&weekCardId=` |
| POST | `/api/weekly-colleagues` body `{ weekCardId, colleagues: [{colleagueId, rank, message}] }` (full replace) |
| Edit UI | crew search modal + section-modal-colleague-edit |
| 권한 | self만 (또는 admin extractTargetUserId override) |
| 분류 | **운영 중인 기능 (DB 미적용 상태로 silent fail)** |

### 2.3 weekly review

| 항목 | 값 |
|---|---|
| State | `weeklyReviewFromDB` + `weeklyReviewData` (1783, 1784) |
| GET | `/api/weekly-reviews?userId=&weekCardId=` |
| POST | `/api/weekly-reviews` body `{ weekCardId, rating, content }` |
| PUT | `/api/weekly-reviews/:id` body `{ weekCardId, rating, content }` |
| Edit UI | `weekly-review-form` modal |
| 권한 | self만 (admin override 있음). `cluster4.weekly_reviews` edit-window 게이트 |
| 분류 | **운영 중인 기능 (DB 미적용 상태로 silent fail)** |

### 2.4 workinfo

| 항목 | 값 |
|---|---|
| State | `weekActivityDetails` (ActivityDetail[]). 활성 activity_type만 필터. View state `selectedWorkInfoCard` |
| Type | `ActivityDetail` interface — id, user_id, week_id, activity_type_id, sub_title, output_links, image_urls, image_captions, growth_point |
| GET | `/api/activity-details?user_id=&week_id=&activity_type_id=` |
| POST | `/api/activity-details` (upsert) body 위 필드 전체 |
| Image upload | `POST /api/activity-details/upload-image` (multipart) |
| Edit UI | `workinfo-view-modal` |
| 권한 | self(or admin) + `cluster4.activity_details` edit-window |
| 분류 | **운영 중인 기능** |

### 2.5 workability

| 항목 | 값 |
|---|---|
| State / API | workinfo와 동일 — `user_activity_details` 공유 |
| 구분자 | activity_type_id가 competency 코드(`comp-1`..) |
| 차이점 | rating 슬라이더 없음. 배지/태그 표현은 클라이언트 매핑 |
| Edit UI | `workability-view-modal` |
| 분류 | **운영 중인 기능** |

### 2.6 workexp

| 항목 | 값 |
|---|---|
| State / API | workinfo와 동일 + `workExpRating` 슬라이더 state (line 2121) |
| 구분자 | activity_type_id가 experience 코드(`exp-1`..) |
| **Rating 저장 경로** | **현재 코드에 없음**. `POST /api/activity-details` payload에 rating 필드 미포함 → UI 슬라이더는 표시되지만 영구 저장 안 됨 |
| Edit UI | `workexp-view-modal` |
| 분류 | **부분 구현 (Image/Sub-title은 저장됨, rating은 silent drop)** |

### 2.7 workcar

| 항목 | 값 |
|---|---|
| State | `careerRecords` (line 542) — `CareerRecord[]` |
| Type | CareerRecord (project + user record 머지된 view): id, project_id, week_id, company_name, company_logo_url, job_position, project_name, project_description, line_code, line_name, output_links, supervisor_* 5개, enhancement_status, grade, grade_points, career_code, record_id, user_id |
| GET | `/api/career-records?week_id=&user_id=` — `career_projects` + `career_records` + `career_project_weeks` 머지 |
| POST/PUT | **현재 라우트에 write 메서드 없음** (GET만) — grade 슬라이더 UI는 있지만 영구 저장 안 됨 |
| Image 저장 | 이미지/캡션은 `user_activity_details`에 동일 line_code의 activity_type_id로 저장 |
| Edit UI | `workcareer-view-modal` (grade dropdown, image upload, supervisor display read-only) |
| 분류 | **부분 구현 (마스터 read + 이미지 저장은 됨, grade/enhancement_status 저장 경로 없음)** |

---

## 3. 섹션별 실사용 판정

| 섹션 | 현재 운영 | 미구현 | Mock 데이터 | Legacy/Dead 코드 | 비고 |
|---|---|---|---|---|---|
| reputation | ✅ | — | demo 모드에서만 hardcoded | 없음 | DB OK 추정 |
| colleague | ✅ (UX는) | — | demo seed only | 없음 | **DB 미존재로 실제 저장 실패** |
| weekly review | ✅ (UX는) | — | demo seed only | 없음 | **DB 미존재로 실제 저장 실패** |
| workinfo | ✅ | — | demo seed only | 없음 | DB 존재 확률 매우 높음 |
| workability | ✅ | — | demo seed only | 없음 | 동상 |
| workexp | ✅ (text/image) | rating 저장 | demo seed only | 없음 | rating 저장 경로 신설 필요 |
| workcar | ✅ (read) | grade write / record upsert | careerRecords state 초기값 3장 | 없음 | write API 없음 |

> 참고: `Cluster4CardContent.tsx:675-755`의 careerRecords state 초기값 데모 3장은 non-demo에서도 마운트 직후 잠깐 표시되다 API 응답이 덮어씀. UX flicker만 존재, DB write 위험 없음.

---

## 4. Canonical Schema 제안

### 4.1 weekly_reputations (기존 — 정정 가능성 검증만)

| 컬럼 | 타입 | 제약 |
|---|---|---|
| id | uuid PK | DEFAULT gen_random_uuid() |
| reviewer_id | uuid NOT NULL | FK user_profiles(user_id) ON DELETE CASCADE |
| target_user_id | uuid NOT NULL | FK user_profiles(user_id) ON DELETE CASCADE |
| week_card_id | uuid NOT NULL | FK weeks(id) ON DELETE RESTRICT |
| rating | numeric(3,1) NOT NULL | CHECK 0~10, 0.5 step |
| content | text NOT NULL | CHECK 1~100 chars |
| keyword | text NOT NULL | CHECK len ≥ 1, no FK (free taxonomy) |
| created_at | timestamptz NOT NULL DEFAULT now() | |
| updated_at | timestamptz NOT NULL DEFAULT now() | trigger 자동 갱신 |

추가 제약: UNIQUE(reviewer_id, target_user_id, week_card_id), CHECK reviewer ≠ target. 인덱스: (target_user_id, week_card_id), (reviewer_id, week_card_id).

기준 키: **week** (season은 weeks→seasons로 join하면 됨, season_id 직접 보유 X)

### 4.2 weekly_colleagues (신규 제안)

| 컬럼 | 타입 | 제약 |
|---|---|---|
| id | uuid PK | DEFAULT gen_random_uuid() |
| user_id | uuid NOT NULL | FK user_profiles(user_id) ON DELETE CASCADE |
| week_card_id | uuid NOT NULL | FK weeks(id) ON DELETE RESTRICT |
| colleague_id | uuid NOT NULL | FK user_profiles(user_id) ON DELETE CASCADE |
| rank | smallint NOT NULL | CHECK BETWEEN 1 AND 3 (UI가 3슬롯) |
| message | text | CHECK len 0~200 (nullable) |
| created_at | timestamptz NOT NULL DEFAULT now() | |
| updated_at | timestamptz NOT NULL DEFAULT now() | trigger |

추가 제약: UNIQUE(user_id, week_card_id, colleague_id), CHECK user_id ≠ colleague_id. 인덱스: (user_id, week_card_id), (colleague_id).

기준 키: **week**. user_id가 카드 소유자, colleague_id가 지정된 동료.

⚠️ Front POST가 "delete + insert" 전체 교체 패턴이라 atomicity 약함 — Phase 후반에 트랜잭션 또는 RPC 함수로 보강 권장 (canonical schema 자체는 변경 없음).

### 4.3 weekly_reviews (정정 필요)

| 컬럼 | 타입 | 제약 |
|---|---|---|
| id | uuid PK | DEFAULT gen_random_uuid() |
| user_id | uuid NOT NULL | FK **user_profiles(user_id)** ON DELETE CASCADE (기존 schema 파일의 `(id)`는 오류) |
| week_card_id | uuid NOT NULL | FK weeks(id) ON DELETE RESTRICT |
| rating | smallint NOT NULL | CHECK 1~10 |
| content | text NOT NULL | CHECK 1~200 chars |
| created_at | timestamptz NOT NULL DEFAULT now() | |
| updated_at | timestamptz NOT NULL DEFAULT now() | trigger |

추가 제약: UNIQUE(user_id, week_card_id). 인덱스: (user_id), (week_card_id).

기준 키: **week**. 본인 작성 only (1행/주차/유저).

### 4.4 user_activity_details (기존 — 적용 확인 필요)

| 컬럼 | 타입 | 제약 |
|---|---|---|
| id | uuid PK | DEFAULT gen_random_uuid() |
| user_id | uuid NOT NULL | FK users(id) — Supabase auth.users 가정 |
| week_id | uuid NOT NULL | FK weeks(id) ON DELETE CASCADE |
| activity_type_id | text NOT NULL | (no FK; free taxonomy) |
| sub_title | text | (nullable, ≤300) |
| output_links | jsonb | `[{desc, url}, ...]` ≤5 |
| growth_point | text | (nullable) |
| image_urls | text[] DEFAULT '{}' | ≤4 |
| image_captions | text[] DEFAULT '{}' | ≤4, image_urls와 인덱스 정렬 |
| growth_image_url | text | (ALTER migration에서 추가) |
| growth_image_caption | text | (ALTER migration에서 추가) |
| created_at | timestamptz DEFAULT now() | |
| updated_at | timestamptz DEFAULT now() | trigger |

추가 제약: UNIQUE(user_id, week_id, activity_type_id). RLS 정책 4개(SELECT/INSERT/UPDATE/DELETE) — 단 createAdminClient가 bypass하므로 운영상 영향 없음.

기준 키: **week**. workinfo/workability/workexp 모두 공유 (activity_type_id로 구분).

**제안 추가 컬럼 (workexp.rating 수용)**:
```
rating smallint NULL CHECK rating IS NULL OR (rating BETWEEN 0 AND 10)
```
- workinfo/workability에서는 NULL
- workexp에서만 0~10 사용
- Front API/payload 양쪽에 `rating` 키 추가 필요 (다음 Phase)

### 4.5 career_projects (마스터, admin write)

코드에서 select하는 컬럼들 (스키마 파일 미발견 — 검증 SQL 권장):

```
id uuid PK
company_name text
company_logo_url text
job_position text
project_name text
project_description text
line_code text
line_name text
output_links jsonb
output_images jsonb (admin-uploaded images)
company_homepage_links jsonb
secondary_info_deadline timestamptz
supervisor_name text
supervisor_position text
supervisor_department text
supervisor_company text
supervisor_profile_img text
created_at timestamptz DEFAULT now()
```

기준 키: 없음 (마스터). 주차와는 `career_project_weeks` 분리.

### 4.6 career_project_weeks (junction)

```
project_id uuid FK career_projects(id)
week_id uuid FK weeks(id)
is_active boolean DEFAULT true
PRIMARY KEY (project_id, week_id)
```

기준 키: project × week (`is_active=true`만 노출).

### 4.7 career_records (per-user)

코드에서 select하는 컬럼들 (스키마 파일 미발견):

```
id uuid PK
user_id uuid FK user_profiles(user_id)
week_id uuid FK weeks(id)
project_id uuid FK career_projects(id)
enhancement_status text ('not_applicable' | 'pending' | 'enhanced' | 'failed')
grade text ('S' | 'A' | 'B' | 'C' | 'D' | null)
grade_points integer
career_code text
supervisor_name text (legacy fallback)
supervisor_position text
supervisor_department text
supervisor_company text
supervisor_profile_img text
created_at timestamptz DEFAULT now()
```

추가 제약 (권장): UNIQUE(user_id, week_id, project_id). 기준 키: **week × project**.

> **canonical 결정**: supervisor 정보는 **`career_projects` 위주로 단일화**하고, `career_records.supervisor_*`는 legacy 컬럼으로 신규 write 금지. 마이그레이션 시점에 모든 NULL row를 그대로 두고 read fallback만 유지.

---

## 5. Admin 연동 설계 (조회/수정/삭제 + Tab 구조)

### 5.1 권한 정책 요약

- **자기 작성형** (weekly_reviews, weekly_colleagues, user_activity_details): Admin은 edit-window 우회 가능
- **Peer-review형** (weekly_reputations, season_reputations): Admin도 reviewer_id를 본인으로 가짐. 대필 의미를 명확히 결정 필요
- **마스터형** (career_projects, career_project_weeks, reputation_keywords): Admin only write

### 5.2 섹션별 Admin 기능 매트릭스

| 섹션 | 조회 | 수정 | 삭제 | 대필 작성 | 비고 |
|---|---|---|---|---|---|
| reputation | ✅ | ✅ (PUT admin bypass 있음) | ✅ (DELETE admin bypass 있음) | ❌ (reviewer_id가 admin이 되어 의미 변질) | admin은 기존 row 정정만 |
| colleague | ✅ | ✅ (extractTargetUserId override) | ✅ (POST full-replace로 가능) | ✅ (extractTargetUserId) | |
| weekly review | ✅ | ✅ (admin bypass) | ✅ (admin bypass) | ✅ (extractTargetUserId) | |
| workinfo | ✅ | ⚠️ (deadline 게이트가 admin도 막음) | ✅ (DELETE 있음, 미사용) | ✅ (deadline 통과 시) | secondary_info_grants 부여 필요 |
| workability | ✅ | ⚠️ (동상) | ✅ | ✅ | 동상 |
| workexp | ✅ | ⚠️ + rating 저장 경로 부재 | ✅ | ✅ | rating 컬럼 추가 후 보강 |
| workcar | ✅ | ❌ (write API 자체 없음) | ❌ | ❌ | 신규 admin endpoint 필요 |

### 5.3 Admin Tab 구조 (Cluster4Editor.tsx 확장 안)

현재 tab(season_review / season_reputation / weekly_reputation / weeks / activities / debug)에 추가:

```
[기존]                             [추가]
season_review                      
season_reputation                  
weekly_reputation                  weekly_review        ← weekly_reviews
weeks                              weekly_colleagues    ← weekly_colleagues
activities (확장)                  
debug                              career               ← career_records + projects
```

**activities tab 내부 sub-tab 제안**:
```
activities
├── workinfo    (user_activity_details where activity_type_id IN info)
├── workability (where activity_type_id IN competency)
├── workexp     (where activity_type_id IN experience)  ← rating 컬럼 노출
```

이렇게 하면 Cluster4Editor의 단일 진입점이 user_activity_details 4 group을 모두 다룸.

### 5.4 Admin API 엔드포인트 매핑

`/api/admin/crews/[legacy_user_id]/cluster4/` 그룹 안에 다음 추가 (vraxium-admin):

```
GET    cluster4/bundle?weekCardId=         → weeks + 7섹션 + edit-window 상태 통합
PATCH  cluster4/weekly-reputations/[id]    → reputation 수정 (admin)
DELETE cluster4/weekly-reputations/[id]    → reputation 삭제
PATCH  cluster4/weekly-colleagues          → full-replace per (user_id, week)
PATCH  cluster4/weekly-reviews             → upsert per (user_id, week)
DELETE cluster4/weekly-reviews/[id]        → 삭제
PATCH  cluster4/activity-details           → upsert per (user_id, week, activity_type_id)
DELETE cluster4/activity-details           → 비우기
PATCH  cluster4/career-records             → upsert per (user_id, week, project_id) [신규]
PATCH  cluster4/edit-windows               → 작성 기간 부여/회수
```

위 라우트들은 모두 `Career-Resume`의 기존 user-facing 라우트를 admin 게이트와 합쳐 wrapping. 신규 비즈니스 로직은 최소.

---

## 6. 최종 구현 순서 (Phase 제안)

### Phase 1 — DB blocker 해소 (silent fail 제거)

- **구현 대상**:
  - `weekly_reviews` migration 작성 (FK 정정 + UNIQUE + index)
  - `weekly_colleagues` migration 작성 (UNIQUE + CHECK + index)
  - production 적용 검증
- **필요 테이블**: 위 2개 신규
- **필요 API**: 없음 (이미 존재)
- **검증**: 기존 Front에서 weekly review 저장/조회, colleague 저장/조회 정상 작동 확인
- **Scope 제외**: workexp.rating, workcar write — 별 Phase

### Phase 2 — Schema 정합화 + 검증 SQL

- **구현 대상**:
  - `user_activity_details` 실제 production 컬럼 확인 (스키마 파일과 일치 여부)
  - `career_projects` / `career_records` 컬럼 확인 + 스키마 파일로 commit
  - `weekly_reputations` 적용 상태 확인
  - 스키마 파일 ↔ production drift 0건으로 확정
- **필요 테이블**: 변경 없음
- **필요 API**: 없음
- **산출물**: 7섹션 schema 파일이 production과 일치하는 단일 source of truth 폴더

### Phase 3 — Admin 조회 UI

- **구현 대상**: Cluster4Editor에 4개 tab 추가 (weekly_review, weekly_colleagues, career, activities expansion)
- **필요 테이블**: 변경 없음
- **필요 API**: 각 섹션 admin GET endpoint (위 §5.4의 GET들). 단, Career-Resume에 이미 user-facing GET이 있으므로 admin은 thin wrapper 또는 직접 호출
- **읽기 only**: 본 Phase에서는 수정 UI 미포함

### Phase 4 — Admin 수정/삭제 UI (수정 가능 항목만)

- **구현 대상**:
  - reputation 수정/삭제 (이미 admin bypass 있음)
  - colleague full-replace 편집
  - weekly review 수정 (admin bypass 있음)
  - activity-details (workinfo/workability) 수정 + edit-window 부여 흐름
- **필요 테이블**: 변경 없음
- **필요 API**: §5.4의 PATCH 4개 + edit-windows PATCH

### Phase 5 — workexp.rating 저장 경로 신설

- **구현 대상**:
  - `user_activity_details.rating` 컬럼 추가 (nullable, smallint 0~10)
  - Front `POST /api/activity-details` payload에 `rating` 키 추가
  - Cluster4CardContent의 workexp 저장 핸들러에서 rating 포함
  - Admin Cluster4Editor의 activities>workexp sub-tab에서 rating 노출/편집
- **필요 테이블**: user_activity_details ALTER
- **필요 API**: 기존 라우트에 rating 검증 추가
- **결정 사항 의존**: 사용자 확정 후 진행 (현재 §4.4에 v1 안 기록)

### Phase 6 — workcar write 경로 신설

- **구현 대상**:
  - `POST/PATCH /api/career-records` (user-facing) — user가 enhancement_status=pending으로 신청
  - `PATCH /api/admin/.../cluster4/career-records` — admin이 grade/enhancement_status 확정
  - `career_records` UNIQUE(user_id, week_id, project_id) 보강
  - Admin이 career_projects 마스터 자체를 만드는 UI는 별 PR
- **필요 테이블**: career_records 정합화
- **필요 API**: 위 2개

### Phase 7 — Drift 방지 + Read hardening

- **구현 대상** (cluster-4-investigation-report.md §11~12에서 도출):
  - 모든 read endpoint에 session + (owner | admin) 게이트 추가 (현재 user_id 쿼리만으로 누구나 read 가능)
  - 카멜/스네이크 변환을 zod schema + mapper로 집중
  - `/api/profile` context=card weekBundle 응답 shape를 TypeScript 타입으로 명시
- **필요 테이블**: 변경 없음

---

## 7. Appendix: production 검증 SQL (Phase 1 시작 전 권장)

```sql
-- (1) 핵심 테이블 존재 확인
SELECT
  to_regclass('public.weekly_reputations')       AS weekly_reputations,
  to_regclass('public.weekly_reviews')           AS weekly_reviews,
  to_regclass('public.weekly_colleagues')        AS weekly_colleagues,
  to_regclass('public.user_activity_details')    AS user_activity_details,
  to_regclass('public.career_projects')          AS career_projects,
  to_regclass('public.career_records')           AS career_records,
  to_regclass('public.career_project_weeks')     AS career_project_weeks,
  to_regclass('public.season_reputations')       AS season_reputations,
  to_regclass('public.user_season_histories')    AS user_season_histories,
  to_regclass('public.reputation_keywords')      AS reputation_keywords;

-- (2) supervisor 컬럼 존재 확인 (career_projects / career_records 양쪽)
SELECT table_name, column_name
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name IN ('career_projects','career_records')
  AND column_name LIKE 'supervisor_%'
ORDER BY table_name, column_name;

-- (3) user_activity_details 컬럼 (rating 컬럼 유무 + growth_image 등 ALTER 적용 여부)
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema='public' AND table_name='user_activity_details'
ORDER BY ordinal_position;

-- (4) weekly_reputations 실제 FK 참조 (canonical user_profiles(user_id)인지)
SELECT tc.constraint_name, kcu.column_name, ccu.table_name, ccu.column_name AS ref_col
FROM information_schema.table_constraints tc
JOIN information_schema.key_column_usage kcu       ON tc.constraint_name = kcu.constraint_name
JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name = tc.constraint_name
WHERE tc.table_name='weekly_reputations' AND tc.constraint_type='FOREIGN KEY';
```

이 4개 결과를 기준으로 Phase 1 migration 초안을 작성합니다.

---

## 8. 결정 보류 항목 (사용자 confirmation 필요)

| # | 안건 | 본 문서 기록한 v1 안 | 결정 권한 |
|---|---|---|---|
| D1 | weekly_colleagues UNIQUE 키 (`user_id, week, colleague_id` vs 추가 컬럼) | (user_id, week_card_id, colleague_id) | 사용자 |
| D2 | `weekly_colleagues.rank` CHECK 범위 | BETWEEN 1 AND 3 (UI 3슬롯) | 사용자 |
| D3 | `weekly_colleagues.message` 길이 제한 | 0~200자 | 사용자 |
| D4 | workexp.rating 저장 위치 | `user_activity_details.rating` 컬럼 추가 (vs 별도 테이블) | 사용자 |
| D5 | workcar grade 저장 흐름 | user 신청 → admin 확정 2단계 | 사용자 |
| D6 | supervisor 단일화 정책 | `career_projects` 우선, `career_records.supervisor_*`는 read-only legacy | 사용자 |
| D7 | reputation 대필 정책 | admin은 정정만, 신규 작성은 불가 | 사용자 |
| D8 | `/api/season-review` admin override 추가 여부 | 본 Cluster4-card 작업 외이지만 Phase 7에서 검토 | 사용자 |

---

## 9. 본 단계 변경 사항 요약

| 분류 | 내역 |
|---|---|
| 신규 파일 | 본 문서 1개 (`claudedocs/cluster4-card-final-data-model-design-20260521.md`) |
| 수정한 코드 파일 | **없음** |
| 신규 migration | **없음** (Phase 1에서 작성 예정) |
| Supabase 변경 | **없음** |
| 검증 SQL | §7에 4개 쿼리 — 사용자가 실행 후 결과 공유 시 Phase 1 시작 |
