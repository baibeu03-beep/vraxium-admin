# Cluster4 신규 → 레거시 동기화 설계안

> **작성일**: 2026-05-27
> **목적**: cluster4_lines(SoT) → weekly_activities / activity_records / user_activity_details 동기화 설계
> **수정 사항 없음** — 설계안 및 migration 후보 목록만 기재

---

## 0. 현황 요약

### 신규 시스템 (Source of Truth)

```
cluster4_lines                    운영자가 라인 생성
  └── cluster4_line_targets       주차 × 대상(user/rule) 매핑
        └── cluster4_line_submissions   사용자 2차 정보 제출
```

- 상태(void/pending/success/fail)는 저장하지 않고 **조회 시 계산**
- 제출 기간(`submission_opens_at ~ closes_at`) 기반 시간 윈도우 관리

### 레거시 시스템 (프론트 소비)

```
weekly_activities                 주차별 활동 개설 (activity_type_id 단위)
  └── activity_records            사용자별 이행 기록 (is_completed → 강화 판정)
  └── user_activity_details       사용자 2차 정보 (sub_title, growth_point, images, rating)
```

- `activity_records.is_completed` = **유일한** 강화 성공/실패 판정 기준
- `weekly_activities.title / output_links / output_images` = 카드 표면 1차 정보
- `user_activity_details.*` = 모달 내 사용자 2차 정보

### 프론트 소비 경로 (변경 불가 — 단기)

```
/api/profile?context=card
  → weekBundle.weeklyActivities[].title, is_active, output_links
  → apiActivityRecords[].is_completed
  → apiActivityDetails[].sub_title, growth_point, output_links, image_urls, image_captions, rating

Cluster4CardContent.tsx
  → getEnhancementStatus(activityType)
       if (!record || !record.is_completed) → "failed"
       if (record.is_completed && !resultsDecided) → "waiting"
       if (record.is_completed && resultsDecided) → "success"
```

---

## 1. 핵심 구조 불일치 3가지

### 불일치 A: 식별자 체계

| 구분 | 레거시 | 신규 |
|---|---|---|
| 활동 식별 | `activity_type_id` (text: 'wisdom', 'comp-1', 'exp-2') | `cluster4_lines.id` (uuid) |
| 분류 체계 | `activity_types.cluster_id` ('practical_competency' 등) | `cluster4_lines.part_type` ('info' 등) |
| 주차 연결 | `weekly_activities.week_id` | `cluster4_line_targets.week_id` |

**문제**: 신규 시스템에 `activity_type_id`가 없어서 레거시 테이블에 어떤 행을 동기화해야 할지 매핑 불가.

### 불일치 B: 대상 범위

| 구분 | 레거시 | 신규 |
|---|---|---|
| 개설 단위 | 주차 × activity_type (전체 사용자 대상) | 주차 × line × 사용자(또는 규칙) |
| 사용자 필터 | 없음 (코드에서 역할 기반 필터) | `cluster4_line_targets.target_user_id` |

**문제**: 레거시 `weekly_activities`는 사용자 구분 없이 1행이고, 신규는 사용자별 target이 있음.

### 불일치 C: 스키마 필드 격차

**cluster4_lines에 없는 필드 (레거시 weekly_activities 기준)**:

| 레거시 필드 | 용도 | 신규 대응 |
|---|---|---|
| `activity_type_id` | 활동 타입 식별 | **없음** |
| `output_links` (jsonb array) | 운영자 링크 복수 | `output_link_1` (단일 text) |
| `output_images` (jsonb array) | 운영자 이미지 복수 | **없음** |
| `team_id` | 실무 경험 팀 지정 | **없음** |
| `opened_at` | 개설 시점 | `submission_opens_at` (유사) |
| `deadline` | 마감 시점 | `submission_closes_at` (유사) |

**cluster4_line_submissions에 없는 필드 (레거시 user_activity_details 기준)**:

| 레거시 필드 | 용도 | 신규 대응 |
|---|---|---|
| `growth_point` | 성장 포인트 텍스트 | **없음** |
| `image_urls` (text[]) | 사용자 이미지 복수 | **없음** |
| `image_captions` (text[]) | 이미지 캡션 복수 | **없음** |
| `rating` (0~10) | 라인 평점 | **없음** |
| `growth_image_url` | 성장 이미지 | **없음** |
| `growth_image_caption` | 성장 이미지 캡션 | **없음** |
| `output_links` (jsonb array) | 사용자 링크 복수 | `output_link_2~5` (개별 text) |

---

## 2. 설계 원칙

```
1. cluster4_lines 시스템이 유일한 Source of Truth
2. 레거시 테이블은 "읽기 전용 프로젝션" — 신규 시스템에서 동기화로 채움
3. 프론트 코드 변경 최소화 — 레거시 테이블 shape 유지
4. 동기화는 API 레이어의 명시적 함수 — DB trigger 아님 (디버깅 용이)
5. 향후 프론트 마이그레이션 완료 시 동기화 함수만 제거
```

---

## 3. 설계안: Sync-Bridge 패턴

### 3-1. 아키텍처 개요

```
┌──────────────────────────────────────────────────────────────┐
│                    Admin API Layer                            │
│                                                              │
│  POST /admin/cluster4/lines         ──┐                      │
│  POST /admin/cluster4/lines/:id/targets ──┤ Sync-Bridge     │
│                                          │ Functions         │
│  ┌─────────────────────┐  ┌─────────────▼─────────────┐     │
│  │  cluster4_lines     │  │  syncLineToWeeklyActivity()│     │
│  │  cluster4_line_     │  │  → weekly_activities       │     │
│  │    targets          │  └───────────────────────────┘     │
│  └─────────────────────┘                                     │
└──────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────┐
│                    User API Layer                             │
│                                                              │
│  POST /cluster4/lines/:id/submission ──┐                     │
│  PATCH /cluster4/lines/:id/submission ──┤ Sync-Bridge       │
│                                         │ Functions          │
│  ┌──────────────────────────┐  ┌───────▼──────────────────┐ │
│  │  cluster4_line_          │  │ syncSubmissionToLegacy()  │ │
│  │    submissions           │  │ → activity_records       │ │
│  │                          │  │ → user_activity_details  │ │
│  └──────────────────────────┘  └──────────────────────────┘ │
└──────────────────────────────────────────────────────────────┘
```

### 3-2. 식별자 브릿지: `activity_type_id` 컬럼 추가

`cluster4_lines`에 `activity_type_id` 컬럼을 추가하여 레거시 식별자와 연결한다.

```
cluster4_lines
  + activity_type_id   text   NULL
                       ↓
                  activity_types.id (논리 매핑, FK 미부여)
```

**설계 근거**:
- `activity_types.id`에 FK를 부여하지 않는 이유: 기존 `user_activity_details`도 동일 이유로 FK 미부여 (activity_types row 완비 보장 없음)
- NULL 허용: 신규 라인이 레거시 activity_type에 매핑되지 않을 수 있음
- `activity_type_id`가 NULL인 라인은 동기화 대상에서 제외

**part_type → cluster_id 매핑 규칙**:

| cluster4_lines.part_type | activity_types.cluster_id | activity_type_id 예시 |
|---|---|---|
| `info` | *(없음 — info는 개별 ID)* | `wisdom`, `essay`, `forum`, `infodesk` 등 |
| `competency` | `practical_competency` | `comp-1`, `comp-2`, `comp-3`, `comp-4` |
| `experience` | `practical_experience` | `exp-1`, `exp-2`, `exp-3`, `exp-4`, `exp-5` |
| `career` | `practical_career` | `car-1` 등 (또는 career_projects.id 기반) |

### 3-3. 스키마 보강: 레거시 호환 컬럼 추가

#### cluster4_lines 추가 컬럼

| 컬럼명 | 타입 | 용도 | 레거시 대응 |
|---|---|---|---|
| `activity_type_id` | text NULL | 레거시 식별자 브릿지 | `weekly_activities.activity_type_id` |
| `output_images` | jsonb DEFAULT '[]' | 운영자 이미지 복수 | `weekly_activities.output_images` |
| `team_id` | uuid NULL | 실무 경험 팀 지정 | `weekly_activities.team_id` |

`output_link_1`은 이미 존재. 레거시 `output_links`(jsonb array)로 변환 시 `[{url: output_link_1}]` 형태로 매핑.

#### cluster4_line_submissions 추가 컬럼

| 컬럼명 | 타입 | 용도 | 레거시 대응 |
|---|---|---|---|
| `growth_point` | text NULL | 성장 포인트 | `user_activity_details.growth_point` |
| `image_urls` | text[] DEFAULT '{}' | 사용자 이미지 | `user_activity_details.image_urls` |
| `image_captions` | text[] DEFAULT '{}' | 이미지 캡션 | `user_activity_details.image_captions` |
| `rating` | smallint NULL | 라인 평점 (0~10) | `user_activity_details.rating` |

**`output_links` 매핑**:
- 신규: `output_link_2`, `output_link_3`, `output_link_4`, `output_link_5` (개별 text)
- 레거시: `output_links` (jsonb array: `[{url: "..."}, ...]`)
- 동기화 시 `[{url: link2}, {url: link3}, ...]` 으로 변환

---

## 4. 동기화 함수 설계

### 4-1. syncLineToWeeklyActivity()

**트리거 시점**: admin이 `cluster4_line_targets` 생성/수정/삭제 시

**입력**:
```
line: cluster4_lines row
target: cluster4_line_targets row
```

**동작**:
```
IF line.activity_type_id IS NULL THEN
  SKIP (레거시 매핑 없는 신규 전용 라인)

UPSERT weekly_activities
  ON CONFLICT (week_id, activity_type_id)
  SET:
    week_id           = target.week_id
    activity_type_id  = line.activity_type_id
    title             = line.main_title
    is_active         = line.is_active
    opened_at         = line.submission_opens_at
    deadline          = line.submission_closes_at
    output_links      = [{url: line.output_link_1}]  (NULL 제외)
    output_images     = line.output_images
    team_id           = line.team_id
```

**삭제 동기화**: target 삭제 시 해당 (week_id, activity_type_id) 조합에 다른 활성 target이 없으면 `weekly_activities.is_active = false` 설정.

**주의사항**:
- 동일 (week_id, activity_type_id)에 여러 target이 있을 수 있음 (사용자별)
- `weekly_activities`는 사용자 구분 없는 1행 → **하나라도 활성 target이 있으면 is_active = true**
- line.main_title 변경 시에도 weekly_activities.title 동기화

### 4-2. syncSubmissionToLegacy()

**트리거 시점**: 사용자가 `cluster4_line_submissions` 생성/수정 시

**입력**:
```
submission: cluster4_line_submissions row
target: cluster4_line_targets row (JOIN)
line: cluster4_lines row (JOIN)
```

**동작**:
```
IF line.activity_type_id IS NULL THEN
  SKIP

-- Step 1: activity_records 동기화
UPSERT activity_records
  ON CONFLICT (user_id, week_id, activity_type_id)
  SET:
    user_id           = submission.user_id
    week_id           = target.week_id
    activity_type_id  = line.activity_type_id
    is_completed      = true

-- Step 2: user_activity_details 동기화
UPSERT user_activity_details
  ON CONFLICT (user_id, week_id, activity_type_id)
  SET:
    user_id           = submission.user_id
    week_id           = target.week_id
    activity_type_id  = line.activity_type_id
    sub_title         = submission.subtitle
    growth_point      = submission.growth_point
    output_links      = 변환([link2, link3, link4, link5])
    image_urls        = submission.image_urls
    image_captions    = submission.image_captions
    rating            = submission.rating
```

### 4-3. syncSubmissionDelete()

**트리거 시점**: submission 삭제 시 (미구현이지만 향후 대비)

**동작**:
```
UPDATE activity_records
  SET is_completed = false
  WHERE (user_id, week_id, activity_type_id) = 해당 매핑

-- user_activity_details는 삭제하지 않음 (사용자 입력 보존)
```

### 4-4. output_links 변환 규칙

```
신규 → 레거시:
  output_link_1              → weekly_activities.output_links = [{"url": link1}]
  output_link_2~5 (non-null) → user_activity_details.output_links = [{"url": link2}, {"url": link3}, ...]

레거시 → 신규 (역방향 읽기, 참고용):
  weekly_activities.output_links[0].url → output_link_1
  user_activity_details.output_links[0..3].url → output_link_2~5
```

---

## 5. 경력(Career) 파트 특수 처리

실무 경력은 `career_projects` + `career_records`라는 별도 레거시 구조가 있다.

### 현재 구조

```
career_projects (마스터)
  └── career_project_weeks (주차 junction: is_active)
  └── career_records (사용자별: grade, enhancement_status)
```

### 동기화 방안

| 신규 | 레거시 대응 | 동기화 방향 |
|---|---|---|
| `cluster4_lines` (part_type='career') | `career_projects` + `career_project_weeks` | 이중 관리 유지 |
| `cluster4_line_targets` (career) | `career_project_weeks.is_active` | **동기화 대상** |
| `cluster4_line_submissions` (career) | `career_records` + `user_activity_details` | **동기화 대상** |

**career_projects는 건드리지 않는다.** career_projects는 회사/감독자/프로젝트 메타 마스터로, 라인 개설 시스템과 1:1 매핑이 아닌 별도 관리 대상이다.

**브릿지 방안**: `cluster4_lines`에 `career_project_id` (uuid NULL) 컬럼 추가.

```
cluster4_lines (part_type='career')
  + career_project_id   uuid NULL   FK → career_projects.id
```

**동기화 함수**: `syncCareerLineToLegacy()`

```
-- target 생성 시
UPSERT career_project_weeks
  ON CONFLICT (project_id, week_id)
  SET:
    project_id = line.career_project_id
    week_id    = target.week_id
    is_active  = line.is_active

-- submission 생성 시
UPSERT career_records
  ON CONFLICT (user_id, week_id, project_id)
  SET:
    user_id             = submission.user_id
    week_id             = target.week_id
    project_id          = line.career_project_id
    enhancement_status  = 'pending'   ← 제출 완료 = pending
    -- grade, grade_points는 별도 관리 (어드민 입력)
```

---

## 6. 동기화 구현 위치 비교

| 방식 | 장점 | 단점 | 권장 |
|---|---|---|---|
| **A. API 레이어 함수** | 명시적, 디버깅 용이, 트랜잭션 제어 가능 | 코드 중복, API 경로 누락 위험 | **권장** |
| B. DB Trigger | 자동, 경로 누락 불가 | 암묵적, 디버깅 어려움, Supabase RLS 간섭 | 차선 |
| C. DB View | SoT 단일, 읽기 자동 | INSERT/UPDATE 불가, Supabase 호환 불확실 | 부적합 |
| D. 배치 Job | 대량 처리 가능 | 실시간성 부족, 지연 발생 | 보조 용도 |

**권장: A (API 레이어 함수) + D (배치 보조)**

```
주요 흐름: API 레이어에서 동기화 함수 호출 (트랜잭션 내)
보조 흐름: 일 1회 배치로 정합성 검증 (desync 감지 및 보정)
```

### API 레이어 적용 위치

```
lib/adminCluster4LinesData.ts
  createCluster4Line()       → 라인 생성 후 (동기화 불필요 — target 없으면 weekly_activities 불필요)
  updateCluster4Line()       → title/is_active 변경 시 → syncLineToWeeklyActivity()
  deleteCluster4Line()       → 삭제 시 → weekly_activities.is_active = false
  createCluster4LineTarget() → target 생성 시 → syncLineToWeeklyActivity()
  deleteCluster4LineTarget() → target 삭제 시 → syncLineToWeeklyActivity() (재평가)

lib/cluster4LinesData.ts
  createCluster4LineSubmissionForAuthUser() → submission 생성 시 → syncSubmissionToLegacy()
  updateCluster4LineSubmissionForAuthUser() → submission 수정 시 → syncSubmissionToLegacy()
```

---

## 7. 전체 데이터 흐름 (동기화 후)

### 운영자 라인 개설

```
Admin UI
  │
  ▼
POST /admin/cluster4/lines
  → INSERT cluster4_lines (activity_type_id, main_title, output_link_1, output_images, team_id)
  │
  ▼
POST /admin/cluster4/lines/:id/targets
  → INSERT cluster4_line_targets (line_id, week_id, target_user_id)
  → syncLineToWeeklyActivity()
      → UPSERT weekly_activities (week_id, activity_type_id, title, is_active, ...)
  │
  ▼
프론트 (변경 없음)
  /api/profile?context=card
    → weekBundle.weeklyActivities[].title ← 동기화된 값
    → weekBundle.weeklyActivities[].is_active ← 동기화된 값
```

### 사용자 2차 정보 제출

```
User UI
  │
  ▼
POST /cluster4/lines/:targetId/submission
  → INSERT cluster4_line_submissions (subtitle, output_link_2~5, growth_point, image_urls, ...)
  → syncSubmissionToLegacy()
      → UPSERT activity_records (is_completed = true)
      → UPSERT user_activity_details (sub_title, output_links, growth_point, image_urls, ...)
  │
  ▼
프론트 (변경 없음)
  getEnhancementStatus()
    → activity_records.is_completed = true
    → "waiting" (결정 시점 전) 또는 "success" (결정 시점 후)
```

### 강화 상태 판정 흐름

```
시간 흐름:
  T0: 라인 개설 (cluster4_lines + targets)
       → weekly_activities.is_active = true (sync)
       → 카드 상태: activity 열림, 아직 제출 없음
       → 프론트: getEnhancementStatus → "failed" (record 없음)

  T1: 사용자 제출 (cluster4_line_submissions)
       → activity_records.is_completed = true (sync)
       → 프론트: getEnhancementStatus → "waiting"

  T2: N+1 목 12:01 KST (결정 시점)
       → 변경 없음 (프론트 시간 계산으로 자동 전환)
       → 프론트: getEnhancementStatus → "success"

  TX: 미제출 + 윈도우 마감
       → activity_records 행 없음 (또는 is_completed = false)
       → 프론트: getEnhancementStatus → "failed"
```

---

## 8. Migration 후보 목록

> SQL 작성 금지. 목록과 컬럼 정의만 기재.

### Migration 1: cluster4_lines 레거시 브릿지 컬럼

```
ALTER TABLE cluster4_lines ADD COLUMN IF NOT EXISTS:

  activity_type_id    text         NULL
  output_images       jsonb        NOT NULL DEFAULT '[]'::jsonb
  team_id             uuid         NULL
  career_project_id   uuid         NULL
```

| 컬럼 | 용도 | FK |
|---|---|---|
| `activity_type_id` | 레거시 activity_types.id 매핑 | 없음 (기존 관례) |
| `output_images` | 운영자 이미지 복수 | 없음 |
| `team_id` | 실무 경험 팀 지정 | `teams.id` (추정, DDL 부재로 FK 보류) |
| `career_project_id` | 경력 프로젝트 연결 | `career_projects.id ON DELETE SET NULL` |

### Migration 2: cluster4_line_submissions 2차 정보 컬럼

```
ALTER TABLE cluster4_line_submissions ADD COLUMN IF NOT EXISTS:

  growth_point        text         NULL
  image_urls          text[]       NOT NULL DEFAULT '{}'
  image_captions      text[]       NOT NULL DEFAULT '{}'
  rating              smallint     NULL

  CONSTRAINT cluster4_line_submissions_rating_range
    CHECK (rating IS NULL OR (rating >= 0 AND rating <= 10))
```

| 컬럼 | 용도 | 레거시 대응 |
|---|---|---|
| `growth_point` | 성장 포인트 텍스트 | `user_activity_details.growth_point` |
| `image_urls` | 사용자 이미지 URL 배열 | `user_activity_details.image_urls` |
| `image_captions` | 이미지 캡션 배열 | `user_activity_details.image_captions` |
| `rating` | 라인 평점 0~10 | `user_activity_details.rating` |

### Migration 3: weekly_activities canonical DDL

현재 DDL 미존재. 동기화 대상이므로 canonical DDL 확정 필수.

```
CREATE TABLE IF NOT EXISTS weekly_activities (
  id                uuid         PK DEFAULT gen_random_uuid()
  week_id           uuid         NOT NULL FK → weeks.id
  activity_type_id  text         NOT NULL
  title             text         NULL
  is_active         boolean      NOT NULL DEFAULT false
  opened_at         timestamptz  NULL
  deadline          timestamptz  NULL
  team_id           uuid         NULL
  output_links      jsonb        NOT NULL DEFAULT '[]'::jsonb
  output_images     jsonb        NOT NULL DEFAULT '[]'::jsonb

  UNIQUE (week_id, activity_type_id)
)
```

**선행 조건**: 운영 DB에서 `\d+ weekly_activities` 실행하여 실제 스키마 확인 후 확정.

### Migration 4: activity_records canonical DDL

현재 DDL 미존재. 동기화 대상이므로 canonical DDL 확정 필수.

```
CREATE TABLE IF NOT EXISTS activity_records (
  id                uuid         PK DEFAULT gen_random_uuid()
  user_id           uuid         NOT NULL FK → user_profiles.user_id
  week_id           uuid         NOT NULL FK → weeks.id
  activity_type_id  text         NOT NULL
  is_completed      boolean      NOT NULL DEFAULT false

  UNIQUE (user_id, week_id, activity_type_id)
)
```

**선행 조건**: 운영 DB에서 `\d+ activity_records` 실행하여 실제 스키마 확인 후 확정.

### Migration 5 (선택): 동기화 전용 인덱스

```
weekly_activities:
  CREATE INDEX IF NOT EXISTS weekly_activities_week_type_idx
    ON weekly_activities (week_id, activity_type_id)

activity_records:
  CREATE INDEX IF NOT EXISTS activity_records_user_week_type_idx
    ON activity_records (user_id, week_id, activity_type_id)
```

UNIQUE 제약조건이 이미 인덱스 역할을 하므로, 별도 인덱스가 필요한지 운영 DB 확인 후 결정.

---

## 9. 구현 순서 권장

```
Phase 0: 운영 DB 스키마 덤프
  → weekly_activities, activity_records 실제 스키마 확인
  → canonical DDL 확정 (Migration 3, 4)

Phase 1: 신규 테이블 스키마 보강
  → Migration 1 (cluster4_lines 브릿지 컬럼)
  → Migration 2 (cluster4_line_submissions 2차 정보 컬럼)
  → 타입/DTO/파서 업데이트

Phase 2: 동기화 함수 구현
  → lib/cluster4SyncBridge.ts 신규 파일
  → syncLineToWeeklyActivity()
  → syncSubmissionToLegacy()
  → syncCareerLineToLegacy()

Phase 3: API 레이어 통합
  → adminCluster4LinesData.ts 에서 sync 함수 호출
  → cluster4LinesData.ts 에서 sync 함수 호출
  → 트랜잭션 내 실행 보장

Phase 4: 검증
  → 동기화 정합성 검증 쿼리 작성
  → smoke test: 라인 개설 → 카드 표시 확인
  → smoke test: 사용자 제출 → 강화 상태 전환 확인

Phase 5 (향후): 프론트 마이그레이션
  → 프론트가 cluster4_lines 시스템을 직접 읽도록 전환
  → 동기화 함수 제거
  → 레거시 테이블 deprecated
```

---

## 10. 리스크 및 미결 사항

### 리스크

| # | 리스크 | 영향 | 완화 |
|---|---|---|---|
| R1 | weekly_activities 실제 스키마가 추론과 다를 수 있음 | Migration 3 실패 | Phase 0에서 운영 DB 확인 필수 |
| R2 | 동일 (week_id, activity_type_id)에 기존 데이터 존재 시 UPSERT 충돌 | 기존 데이터 덮어쓰기 | ON CONFLICT DO UPDATE 사용, 기존 row 보존 정책 확정 필요 |
| R3 | rule 모드 target은 동기화 매핑 불가 (사용자 미특정) | rule 대상 라인 미동기화 | Phase 1에서는 user 모드만 지원, rule은 향후 |
| R4 | 경력(career) 파트의 이중 마스터 (career_projects vs cluster4_lines) | 데이터 불일치 | career_project_id 연결로 SoT 명확화 |

### 미결 사항

```
1. weekly_activities의 실제 스키마 확인 (Phase 0 선행)
2. activity_records의 실제 스키마 확인 (Phase 0 선행)
3. cluster4_lines.activity_type_id 값 관리 정책
   → 어드민 UI에서 activity_types 드롭다운 제공? 또는 자동 매핑?
4. 기존 weekly_activities 데이터와의 공존 정책
   → 이미 존재하는 행은 동기화로 덮어쓸 것인가? 보존할 것인가?
5. career_records.grade / grade_points 관리 주체
   → 현재: 어드민 직접 입력
   → 향후: cluster4_lines 시스템에서 관리? 별도 유지?
6. output_link 개수 제한
   → 신규: 최대 5개 (link_1 ~ link_5)
   → 레거시: 무제한 (jsonb array)
   → 5개 초과 링크 레거시 데이터가 있다면 역방향 매핑 시 정보 손실
```
