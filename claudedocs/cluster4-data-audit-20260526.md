# Cluster4 데이터/지표 현황 감사 보고서

> 작성일: 2026-05-26
> 범위: 더미 데이터, DB 테이블, API, 지표 계산, 프론트 표시값 전수 조사

---

## 1. 더미 데이터 범위

### 1-1. Seed SQL 파일 목록

| 파일 | 배치 ID | 사용자 수 | 상태 |
|------|---------|----------|------|
| `claudedocs/seed-v4_1-20260522.sql` | `2026-05-22_seed_30users_v1` | 30명 | **ACTIVE** |
| `claudedocs/seed-v4_2-profile-enrichment-20260522.sql` | (위 30명 보강) | 30명 | **ACTIVE** |
| `claudedocs/seed-90users-v2-20260526.sql` | `2026-05-26_seed_90users_v2` | 90명 | **ACTIVE** |
| `claudedocs/seed-v2-20260522.sql` | - | - | DEPRECATED |
| `claudedocs/seed-v3-20260522.sql` | - | - | DEPRECATED |
| `claudedocs/seed-v4-20260522.sql` | - | - | DEPRECATED |

### 1-2. 더미 사용자 분포

**배치 1 (30명)** — legacy_user_id 900001-900030
- 조직: oranke 20명, encre 10명, phalanx 0명
- 유형: newbie(1-6), normal(7-18), high_activity(19-26), admin(27-28), status_issue(29-30)
- 상태: active 28명, weekly_rest 1명(#29), graduated 1명(#30)

**배치 2 (90명)** — legacy_user_id 900031-900120
- 조직: encre 30명, oranke 30명, phalanx 30명
- 유형: 조직별 6카테고리 × 5명 (onboarding, excellent, average, rest, failure, near_graduation)
- **phalanx 더미 사용자가 처음 포함된 배치**

### 1-3. 시즌/주차 범위

| 출처 | 시즌 | 주차 범위 |
|------|------|----------|
| `DUMMY_WEEKLY_CARDS` (TS, 미사용) | 2026 봄 | 1~13주차 (3/2~5/31) |
| seed-90users-v2 (SQL) | CURRENT_DATE 동적 | onboarding ~4주, excellent ~18-22주, near_graduation ~25-35주 |
| cluster3_growth_seed_diversify (SQL) | CURRENT_DATE 동적 | Group A: 1주 ~ Group F: ~35주 |

### 1-4. 더미 vs 실제 데이터 구분 기준 (4중 식별)

| 기준 | 배치 1 | 배치 2 |
|------|--------|--------|
| `test_user_markers` 테이블 | seed_batch_id: `2026-05-22_seed_30users_v1` | seed_batch_id: `2026-05-26_seed_90users_v2` |
| 이메일 도메인 | `dummyNN@vraxium.test` | `testNNN@vraxium.test` |
| display_name 패턴 | `실명 [TEST]` (v4.2 이후) | `실명 [TEST]` |
| 전화번호 | `010-9900-NNNN` | `010-9901-NNNN` |
| legacy_user_id | 900001-900030 | 900031-900120 |

롤백 시 4조건 AND로 실데이터 보호.

### 1-5. Seed가 투입된 테이블 요약

| 테이블 | 배치1(30) | 배치2(90) | Growth Diversify | Fixture/Master |
|--------|:---------:|:---------:|:----------------:|:--------------:|
| `auth.users` | - | 90 | - | - |
| `public.users` | 30 | 90 | - | - |
| `user_profiles` | 30 | 90 | 수정 30 | - |
| `test_user_markers` | 30 | 90 | - | - |
| `user_memberships` | 30 | - | - | - |
| `user_cumulative_points` | 30 | 90 | 수정 30 | - |
| `user_growth_stats` | 30 | 90 | 수정 30 | - |
| `applicants` | 30 | - | - | - |
| `user_introductions` | 30 | - | - | - |
| `user_cluster2` | 30 | - | - | - |
| `user_week_statuses` | - | 수백 | 교체 30 | - |
| `user_weekly_points` | - | 수백 | - | - |
| `user_season_statuses` | - | 다수 | - | - |
| `user_club_rank_frozen` | - | ~6 | - | - |
| `user_grade_stats` | - | 다수 | - | - |
| `activity_types` | - | - | - | 3 (verify) |
| `reputation_keywords` | - | - | - | 100 |
| `permissions` | - | - | - | 13 |
| `weeks` | - | - | - | backfill |
| `season_definitions` | - | - | - | 36 (2021-2029) |

### 1-6. TypeScript 더미 데이터 파일

| 파일 | 내용 | 사용 여부 |
|------|------|----------|
| `lib/cluster4WeeklyDummyData.ts` | 13개 주차 카드, 2026 봄 시즌 | **미사용 (dead code)** — import 0건 |
| `lib/cluster1ResumeData.ts` | `dummyScheduleReliability()`, `dummySeasonRecords()` | **사용 중** — userId 없을 때 fallback |

---

## 2. 테이블별 데이터 현황

### 핵심 테이블 스키마

#### `user_profiles` (마스터)
- PK: `user_id` (uuid)
- 주요 컬럼: display_name, organization_slug, status, growth_status, role, activity_started_at, activity_ended_at
- role CHECK: crew/ambassador/agent/part_leader/team_leader/admin/super_admin

#### `user_week_statuses`
- PK: `id` (uuid), UNIQUE: `(user_id, year, week_number)`
- status CHECK: success/fail/personal_rest/official_rest
- 추가 컬럼: `is_official_rest_override`, `season_key` (FK → season_definitions)

#### `user_season_statuses`
- PK: `id` (uuid), UNIQUE: `(user_id, season_key)`
- status CHECK: success/rest
- 추가: `requested_at` (시즌 휴식 요청 시각)

#### `weeks`
- PK: `id` (uuid), UNIQUE: `(iso_year, iso_week)`
- 주요 컬럼: week_number (시즌 내), start_date, end_date, season_key, is_official_rest, holiday_name

#### `season_definitions`
- PK: `id` (smallserial), UNIQUE: `season_key`
- 형식: '2026-spring', season_type CHECK: spring/summer/autumn/winter
- 36개 행 (2021-2029)

#### `user_weekly_points`
- PK: `id` (uuid), UNIQUE: `(user_id, year, week_number)`
- points, advantages, penalty (각 integer, default 0)
- 파생 계산: `weekly_score = points*1 + advantages*3 - penalty*5`

#### `user_activity_details`
- PK: `id` (uuid), UNIQUE: `(user_id, week_id, activity_type_id)`
- activity_type_id: text (comp-N/exp-N/car-N 등, FK 없음)
- rating: 0~10 (work_exp만), output_links (jsonb), image_urls (text[])

#### `activity_types`
- PK: `id` (text, 'comp-1' 등)
- cluster_id CHECK: practical_competency/practical_experience/practical_career
- eligible_min/max_approved_weeks, count_once_in_total

#### `weekly_reputations`
- UNIQUE: `(reviewer_id, target_user_id, week_card_id)`
- rating: numeric(3,1), 0~10, 0.5 단위
- reviewer_id ≠ target_user_id

#### `weekly_colleagues`
- UNIQUE: `(user_id, week_card_id, colleague_id)`
- rank: 1~3, message: 최대 200자
- user_id ≠ colleague_id

#### `career_projects`
- PK: `id` (uuid)
- 회사/직위/프로젝트/라인코드/감독관 정보
- output_links, output_images, company_homepage_links (jsonb)

#### `career_project_weeks`
- PK: `(project_id, week_id)` — composite
- is_active: boolean

#### `career_records`
- UNIQUE: `(user_id, week_id, project_id)`
- enhancement_status: not_applicable/pending/enhanced/failed
- grade: S/A/B/C/D, grade_points: integer

### 신규 테이블 (cluster4_lines 계열)

#### `cluster4_lines`
- part_type CHECK: info/experience/competency/career
- main_title, output_link_1, submission_opens_at/closes_at
- created_by/updated_by → admin_users

#### `cluster4_line_targets`
- FK: line_id → cluster4_lines, week_id → weeks
- target_mode CHECK: user/rule
- user 모드: target_user_id 필수, target_rule = '{}'
- rule 모드: target_user_id NULL, target_rule는 jsonb object

#### `cluster4_line_submissions`
- FK: line_target_id → cluster4_line_targets
- UNIQUE: `(line_target_id, user_id)`
- subtitle, output_link_2~5
- 트리거: user 모드일 때 submission.user_id = target.target_user_id 검증

### FK 의존 관계도

```
season_definitions ← user_season_statuses.season_key
                   ← weeks.season_key
                   ← user_week_statuses.season_key

user_profiles      ← user_week_statuses / user_season_statuses / user_weekly_points
                   ← user_activity_details / career_records / weekly_reviews
                   ← weekly_colleagues (user + colleague) / weekly_reputations (reviewer + target)
                   ← cluster4_line_targets.target_user_id / cluster4_line_submissions.user_id

weeks              ← user_activity_details / career_records / career_project_weeks
                   ← weekly_reviews / weekly_colleagues / weekly_reputations
                   ← cluster4_line_targets.week_id

career_projects    ← career_project_weeks / career_records
cluster4_lines     ← cluster4_line_targets ← cluster4_line_submissions
```

---

## 3. API별 Source of Truth

### 사용자 API

| API | 메서드 | 읽는 테이블 | 주요 계산 |
|-----|--------|------------|----------|
| `/api/cluster4/weekly-growth` | GET | user_profiles, user_week_statuses, user_season_statuses, official_rest_weeks, season_definitions, weeks, user_weekly_points, weekly_reputations, weekly_colleagues, user_activity_details, activity_types | currentWeekInfo, growthSummary, weeklyCards (FM, 성장률, 라인분류) |
| `/api/cluster4/lines/detail` | GET | user_profiles, cluster4_line_targets + cluster4_lines, cluster4_line_submissions | 라인 상태 (void/pending/success/fail) |
| `/api/cluster4/lines/[id]/submission` | POST/PATCH | cluster4_line_targets + cluster4_lines, cluster4_line_submissions | 제출 윈도우 검증, 권한 확인 |
| `/api/edit-windows/permission` | GET | admin_users, user_profiles, user_edit_windows | canEdit 판정 (admin 항상 true, 일반 사용자는 윈도우 기간 내) |
| `/api/review-link` | GET/PUT | user_review_links, user_cluster2, admin_users, user_edit_windows | 10슬롯 리뷰링크, week_index=30 레거시 backfill |

### 어드민 API

| API | 메서드 | 읽는 테이블 | 주요 기능 |
|-----|--------|------------|----------|
| `/api/admin/crews/[id]/cluster4` | GET/PATCH/DELETE | user_profiles, season_definitions, weeks, user_season_histories, season_reputations, reputation_keywords, weekly_reputations, weekly_reviews, weekly_colleagues, user_activity_details, career_records, activity_types | Cluster4Bundle 전체 CRUD |
| `/api/admin/crews/[id]/cluster4/weekly-growth` | GET | (사용자 API와 동일 테이블) | legacy_user_id로 조회 |
| `/api/admin/career-projects` | GET/POST | career_projects, career_project_weeks | 프로젝트 목록/생성 |
| `/api/admin/career-projects/[id]` | GET/PATCH/DELETE | career_projects, career_project_weeks, career_records | 개별 프로젝트 CRUD (삭제 시 career_records 참조 확인) |
| `/api/admin/career-projects/[id]/weeks` | GET/PATCH | career_projects, career_project_weeks, weeks | 주차 attach/detach/set_active |
| `/api/admin/cluster4/lines` | GET/POST | cluster4_lines, cluster4_line_targets, cluster4_line_submissions | 라인 목록/생성 (POST는 owner만) |
| `/api/admin/cluster4/lines/[id]` | GET/PATCH/DELETE | cluster4_lines, cluster4_line_targets, cluster4_line_submissions | 개별 라인 CRUD |
| `/api/admin/cluster4/lines/[id]/targets` | GET/POST | cluster4_lines, cluster4_line_targets, cluster4_line_submissions, weeks, user_profiles | 타겟 목록/생성 |
| `/api/admin/cluster4/targets/[id]` | PATCH/DELETE | cluster4_line_targets, cluster4_line_submissions, weeks, user_profiles | 개별 타겟 수정/삭제 |

### 미존재 API

- `/api/profile` — **존재하지 않음**. 사용자 식별은 `lib/resolveProfileUserId.ts` 내부 헬퍼로 처리

---

## 4. 지표별 계산 위치

### 4-1. 주차 성장률 (= 주차 강화율, Weekly Growth Rate)

- **파일**: `lib/cluster4WeeklyGrowthData.ts`, `computeWeeklyCards()` 내부
- **수식**: `rate = Math.ceil((completedLines / availableLines) * 100)`
- **completedLines**: user_activity_details → activity_types.cluster_id 기준 분류 후 카운트
- **availableLines**: 하드코딩 상수 `STANDARD_LINE_AVAILABLE = { info:7, ability:1, experience:2, career:2 }` (총 12)
- 휴식 주차는 available = 0 → rate = 0

### 4-2. 라인 강화 상태 (Line Reinforcement Status)

- **파일**: `lib/cluster4WeeklyGrowthData.ts`, `computeWeeklyCards()`
- **분류 로직** (`classifyActivityType()` in `lib/userActivityDetailsTypes.ts`):
  - `practical_competency` / `comp-*` → ability
  - `practical_experience` / `exp-*` → experience
  - `practical_career` / `car-*` → career
  - 그 외 → info
- **per-week 결과**: `lineBreakdown = { info: {completed, available}, ability: {...}, experience: {...}, career: {...} }`
- **cluster4_lines 테이블의 라인 상태** (`lib/cluster4LinesData.ts`):
  - void: 타겟 없음
  - pending: 타겟 있으나 미제출 + 윈도우 오픈
  - success: 제출 완료
  - fail: 윈도우 종료 + 미제출

### 4-3. 평점 (Ratings)

| 종류 | 범위 | 단위 | 테이블 | 검증 함수 |
|------|------|------|--------|----------|
| 시즌 평판 | 1~10 | 0.5 | season_reputations | `normalizeSeasonReputationRating()` |
| 주간 평판 | 0~10 | 0.5 | weekly_reputations | `normalizeWeeklyReputationRating()` |
| 주간 리뷰 (자기) | 1~10 | 정수 | weekly_reviews | `normalizeWeeklyReviewRating()` |
| 시즌 리뷰 | 0~10 | 정수 | user_season_histories | `normalizeUserSeasonHistoryRating()` |
| 활동 평점 | 0~10 | 정수 | user_activity_details | DB CHECK, work_exp만 |

모든 검증 함수는 `lib/adminCluster4Data.ts`에 위치.

### 4-4. 평점 → 포인트 환산

**현재 코드베이스에 rating → points 직접 환산 로직 없음.**

`claudedocs/backend-quantitative-survey-20260521.md`에서 `seasonReputations.reduce(rating*3)`을 언급했으나, admin 코드에서 미구현. FM score는 별도의 points/advantages/penalty 기반 계산.

### 4-5. 별/단감/투구 등 포인트 (조직별 라벨)

- **라벨 정의**: `lib/pointLabels.ts`
  - encre: 별/방패/번개
  - oranke: 단감/인절미/어흥
  - phalanx: 투구/방패/화살
- **저장**: `user_weekly_points` (주간: points, advantages, penalty)
- **누적**: `user_cumulative_points` (total_stars, total_shields, total_lightnings, total_raw_advantages)
- **Seed 공식** (club_rank_weekly_points.sql):
  - success: points = 2+(rn%3), advantages = rn%3, penalty = 0
  - fail: points = rn%2, advantages = 0, penalty = 1+(rn%2)
  - rest: 모두 0

### 4-6. FM (명성도, Fame Score)

- **파일**: `lib/cluster4WeeklyGrowthData.ts`, `computeWeeklyCards()`
- **수식**: `cumulativePoints += points + (advantages * 3) - (penalty * 5)` (누적합)
- 동일 수식이 `lib/cluster3ClubRankData.ts`의 `computeWeeklyScore()`에서도 사용 (주간 단위, 비누적)
- 각 주차 카드의 `totalFmScore`는 해당 시점까지의 누적값

### 4-7. 성장 성공/실패

**주차 레벨:**
- DB: `user_week_statuses.status` = success/fail/personal_rest/official_rest
- 런타임 오버라이드: 현재 주차 → `running`, official_rest이면서 weeks.is_official_rest=false → `fail`

**프로세스 레벨** (`lib/cluster3GrowthData.ts`, `resolveDisplayKey()`):
1. graduated (성장 완료)
2. suspended (성장 중단)
3. paused (성장 유보)
4. graduating (졸업 절차 중)
5. seasonal_rest (시즌 휴식)
6. weekly_rest (주간 휴식)
7. official_rest (공식 휴식 주간)
8. onboarding (h≤1, active)
9. extra_growth (a≥졸업기준, active)
10. active (성장 중)

**졸업 기준** (`lib/pointLabels.ts`): encre/phalanx ≥30주, oranke ≥25주

### 4-8. 누적 주차 (Cumulative Weeks)

- **파일**: `lib/cluster4WeeklyGrowthData.ts`, `computeWeeklyCards()`
- **로직**: status==="success"인 주차만 카운트, 시간순 누적
- 각 카드의 `accumulatedApprovedWeeks`는 해당 시점까지의 누적값
- **growthSummary** 레벨: approvedWeeks, failedWeeks, restWeeks, availableWeeks = approved+failed+rest

### 4-9. 클럽 품계 (Club Rank)

- **파일**: `lib/cluster3ClubRankData.ts`, `getClubRank()`
- **계산**: 전체 사용자 주간점수 → 주간 순위 → 백분위 → 평균 백분위 → 10단계 등급
- 등급: 정승(1) ~ 정9품(10)
- 졸업/중단 사용자: `user_club_rank_frozen` 테이블에 고정

---

## 5. 어드민/사용자 앱 표시값 차이

### 어드민 표시값

| 컴포넌트 | 표시 내용 | 데이터 출처 | 더미 여부 |
|----------|----------|------------|----------|
| `Cluster4Editor.tsx` 주간 성장 탭 | currentWeekInfo, growthSummary | DB via API | 실데이터 |
| `Cluster4Editor.tsx` 주차 리스트 탭 | 13+ 필드 (FM, 성장률, 포인트 등) | DB via API | 실데이터 (상수 분모 제외) |
| `Cluster4Editor.tsx` 시즌/주간 평판/리뷰 탭 | rating, content, keyword | DB via API | 실데이터 |
| `ActivityTab.tsx` | 4개 활동 모달 데이터 | DB via Cluster4Bundle | 실데이터 |
| `ResumeCardEditor.tsx` 활동 완료율 | rate, completedActivities | DB via API | **실데이터이나 "더미" 라벨 잔존** |
| `ResumeCardEditor.tsx` 실무 성적 | infoCount, experienceCount 등 | DB via API | **실데이터이나 "더미" 라벨 잔존** |

### 사용자 앱 표시값

| API | 반환 데이터 | 데이터 출처 | 더미 여부 |
|-----|-----------|------------|----------|
| `/api/cluster4/weekly-growth` | WeeklyGrowthDto | DB 직접 쿼리 | 실데이터 |
| `/api/cluster4/lines/detail` | Cluster4LineDetailDto | DB 직접 쿼리 | 실데이터 |
| `/api/cluster4/lines/.../submission` | Cluster4LineSubmissionDto | DB 직접 쿼리 | 실데이터 |

### 하드코딩/상수값 목록

| 위치 | 내용 | 값 |
|------|------|---|
| `Cluster4Editor.tsx:731` | 주간 평판 최대 수 | `/ 4` 하드코딩 |
| `Cluster4Editor.tsx:752` | 연계 동료 최대 수 | `/ 3` 하드코딩 |
| `cluster4WeeklyGrowthData.ts:313-318` | 주차별 가용 라인 수 | info:7, ability:1, exp:2, career:2 하드코딩 |
| `cluster1ResumeData.ts:134` | 주차별 총 라인 수 | `LINES_PER_WEEK = 12` 하드코딩 |
| `cluster4WeeklyGrowthData.ts:508` | FM 계산 계수 | advantages×3, penalty×5 하드코딩 |
| `cluster4WeeklyGrowthData.ts:110` | 시즌 미매칭 fallback | "봄 시즌" 하드코딩 |
| `pointLabels.ts` | 조직별 라벨/졸업기준 | 하드코딩 (설정으로 간주 가능) |

---

## 6. 현재 가장 위험한 불일치 지점

### 위험도 HIGH

1. **`lib/cluster4WeeklyDummyData.ts` — Dead Code 잔존**
   - 13개 하드코딩 주차 카드, 가짜 팀/파트명("미디어"/"웹툰드라마") 포함
   - 현재 import 0건이지만, DTO 타입과 미세한 차이 존재 (dangamCount, injeolmiCount 등 실제 DTO에 없는 필드)
   - 향후 실수로 import할 경우 타입 불일치 발생 가능

2. **`ResumeCardEditor.tsx` — "Cluster4 연동 전 더미" 라벨 오류**
   - 활동 완료율/실무 성적 영역에 devMode 시 "Cluster4 연동 전 더미" 표시
   - **실제로는 DB 실데이터 연동 완료 상태** — 라벨만 업데이트 안 됨
   - 운영자가 보면 데이터를 신뢰하지 않을 수 있음

3. **`STANDARD_LINE_AVAILABLE` 하드코딩과 `cluster4_lines` 테이블 불일치**
   - 성장률 계산의 분모(info:7, ability:1, exp:2, career:2)는 상수
   - `cluster4_lines` + `cluster4_line_targets` 테이블은 동적으로 라인을 관리
   - 두 시스템 사이에 연결이 없음 — 어드민이 라인을 추가/제거해도 성장률 분모는 변하지 않음

### 위험도 MEDIUM

4. **평점 → FM 변환 공식 미구현**
   - 기획 문서에 `seasonReputations.reduce(rating*3)` 기록, 실제 코드에 없음
   - FM은 오직 points/advantages/penalty로만 계산
   - 기획 의도와 구현이 다를 수 있음

5. **주간 평판 최대 "/ 4", 연계 동료 최대 "/ 3" 하드코딩**
   - DB 스키마에서 이 제한은 weekly_colleagues.rank CHECK 1..3뿐
   - weekly_reputations에는 최대 수 제한 없음 (unique는 reviewer+target+week)
   - UI 분모와 실제 제약이 불일치할 가능성

6. **`cluster4_line_targets` rule 모드 미지원**
   - 스키마에 `target_mode = 'rule'` 정의되어 있으나
   - `lib/cluster4LinesData.ts`에서 rule 모드는 warning 로그만 남기고 void 반환
   - 어드민이 rule 모드 타겟을 생성하면 사용자 앱에서 무시됨

### 위험도 LOW

7. **시즌 미매칭 시 "봄 시즌" fallback** — season_definitions에 36개 행이 있어 실제 발생 가능성 낮음
8. **`dummyScheduleReliability()` / `dummySeasonRecords()`** — userId 없는 사용자에게만 적용, 정상 사용자 미영향
9. **`cluster4WeeklyDummyData.ts`의 `computeGrowthRate()`** — 미사용이나 실제 함수와 동일 로직

---

## 7. 다음 구현 우선순위 제안

### P0 (즉시 정리)
1. **`lib/cluster4WeeklyDummyData.ts` 삭제** — dead code, 혼란의 원인
2. **`ResumeCardEditor.tsx`의 "더미" devMode 라벨 수정** — "Cluster4 실데이터 연동" 등으로 변경

### P1 (구조적 개선)
3. **`STANDARD_LINE_AVAILABLE` 상수를 `cluster4_lines` 테이블 기반으로 동적화**
   - 또는 최소한 상수값이 의도된 것임을 문서화하고, `cluster4_lines`와의 관계를 명확히
4. **주간 평판 최대/연계 동료 최대를 설정값으로 추출**
   - 현재 하드코딩된 "4"와 "3"을 검증 가능한 상수로

### P2 (기능 보강)
5. **`cluster4_line_targets` rule 모드 구현 완료** — 스키마는 준비됐으나 사용자 앱 미지원
6. **FM 계산 공식 확정** — 기획 문서(rating×3)와 구현(points+advantages×3-penalty×5)의 차이를 기획팀과 확인
7. **rating → points 환산 로직 필요 여부 확정** — 두 시스템이 독립적인 것이 의도인지 확인

### P3 (추후)
8. **`cluster4_lines` 어드민 UI 컴포넌트** — API는 완성, 프론트엔드 미구현
9. **더미 데이터 정리 정책 수립** — 120명의 테스트 사용자를 프로덕션에서 분리할 계획 필요
10. **`user_grade_stats` 동기화 자동화** — 현재 migration SQL로만 갱신, 주기적 동기화 필요

---

## 부록: 파일 인덱스

### 핵심 계산 파일
| 파일 | 역할 |
|------|------|
| `lib/cluster4WeeklyGrowthData.ts` | 주차 카드 계산 엔진 (FM, 성장률, 누적주차, 라인분류) |
| `lib/cluster4WeeklyGrowthTypes.ts` | 주간 성장 DTO 타입 |
| `lib/adminCluster4Data.ts` | Cluster4 번들 CRUD (평점, 평판, 리뷰) |
| `lib/cluster3ClubRankData.ts` | 클럽 품계 계산 |
| `lib/cluster3GrowthData.ts` | 성장 지표 (프로세스/기간/포인트) |
| `lib/cluster1ResumeData.ts` | 이력서 카드 지표 (활동 완료율, 실무 성적) |
| `lib/pointLabels.ts` | 조직별 포인트 라벨, 졸업 기준 |
| `lib/userActivityDetailsTypes.ts` | 활동 타입 분류 (classifyActivityType) |
| `lib/cluster4LinesData.ts` | 라인 오프닝 상태 판정 |

### 어드민 UI 컴포넌트
| 파일 | 역할 |
|------|------|
| `components/admin/Cluster4Editor.tsx` | Cluster4 어드민 메인 (8탭) |
| `components/admin/cluster4/ActivityTab.tsx` | 활동 상세 (4모달) |
| `components/admin/ResumeCardEditor.tsx` | Cluster1 이력서 카드 (Cluster4 데이터 일부 표시) |
