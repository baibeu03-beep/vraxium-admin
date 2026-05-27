# Cluster4 라인 개설 최종 아키텍처

> **작성일**: 2026-05-27
> **상태**: 확정 — Migration SQL 작성의 기준 문서
> **이전 문서**: Sync Bridge 설계 전체 **폐기** (weekly_activities / activity_records 미존재 확인)

---

## 1. 전제 변경

### 운영 DB 확인 결과

| 테이블 | 존재 | 비고 |
|---|---|---|
| `weekly_activities` | **미존재** | 코드에서 참조하나 실제 DB에 없음 |
| `activity_records` | **미존재** | 동일 |
| `cluster4_lines` | **존재** | 라인 개설 마스터 |
| `cluster4_line_targets` | **존재** | 주차 × 대상 매핑 |
| `cluster4_line_submissions` | **존재** | 사용자 제출 |
| `user_activity_details` | **존재** | 사용자 2차 정보 (migration 확인) |
| `career_projects` | **존재** | 경력 프로젝트 마스터 |
| `career_project_weeks` | **존재** | 경력 주차 junction |
| `career_records` | **존재** | 경력 사용자 기록 |
| `activity_types` | **존재** | 활동 분류 마스터 |
| `weeks` | **존재** | 주차 정의 |

### 결론

```
Sync Bridge 불필요 — 동기화 대상 테이블이 존재하지 않음.
cluster4_lines 시스템이 유일한 라인 개설 시스템.
프론트는 cluster4_* 테이블을 직접 읽도록 구성해야 함.
```

---

## 2. 현재 스키마 재확인

### cluster4_lines (현재)

```
id                    uuid         PK
part_type             text         NOT NULL   CHECK: info/experience/competency/career
main_title            text         NOT NULL
output_link_1         text         NULL
submission_opens_at   timestamptz  NOT NULL
submission_closes_at  timestamptz  NOT NULL
is_active             boolean      NOT NULL   DEFAULT true
created_by            uuid         NULL       FK → admin_users
updated_by            uuid         NULL       FK → admin_users
created_at            timestamptz  NOT NULL
updated_at            timestamptz  NOT NULL
```

### cluster4_line_targets (현재)

```
id                    uuid         PK
line_id               uuid         NOT NULL   FK → cluster4_lines CASCADE
week_id               uuid         NOT NULL   FK → weeks CASCADE
target_mode           text         NOT NULL   CHECK: user/rule
target_user_id        uuid         NULL       FK → user_profiles CASCADE
target_rule           jsonb        NOT NULL   DEFAULT '{}'
created_by            uuid         NULL
updated_by            uuid         NULL
created_at            timestamptz  NOT NULL
updated_at            timestamptz  NOT NULL
```

### cluster4_line_submissions (현재)

```
id                    uuid         PK
line_target_id        uuid         NOT NULL   FK → cluster4_line_targets CASCADE
user_id               uuid         NOT NULL   FK → user_profiles CASCADE
subtitle              text         NULL
output_link_2         text         NULL
output_link_3         text         NULL
output_link_4         text         NULL
output_link_5         text         NULL
submitted_at          timestamptz  NOT NULL   DEFAULT now()
created_at            timestamptz  NOT NULL
updated_at            timestamptz  NOT NULL
```

### user_activity_details (현재)

```
id                    uuid         PK
user_id               uuid         NOT NULL   FK → user_profiles CASCADE
week_id               uuid         NOT NULL   FK → weeks RESTRICT
activity_type_id      text         NOT NULL
sub_title             text         NULL
output_links          jsonb        NOT NULL   DEFAULT '[]'
growth_point          text         NULL
image_urls            text[]       NOT NULL   DEFAULT '{}'
image_captions        text[]       NOT NULL   DEFAULT '{}'
growth_image_url      text         NULL
growth_image_caption  text         NULL
rating                smallint     NULL       CHECK: 0~10
created_at            timestamptz  NOT NULL
updated_at            timestamptz  NOT NULL

UNIQUE (user_id, week_id, activity_type_id)
```

---

## 3. 4개 허브 표현 가능성 분석

### 3-1. 실무 정보 (info) — 최대 9개 카드

| 프론트 필요 데이터 | 현재 출처 | cluster4_lines | 부족 여부 |
|---|---|---|---|
| activity_type_id (wisdom/essay 등) | 하드코딩 | **없음** | **부족** |
| Main Title | weekly_activities.title | main_title ✅ | |
| is_active | weekly_activities.is_active | is_active ✅ | |
| 개설일 | weekly_activities.opened_at | submission_opens_at ✅ | |
| 마감일 | weekly_activities.deadline | submission_closes_at ✅ | |
| Output Link (운영자) | weekly_activities.output_links | output_link_1 (단일) | **부분** |
| Output Image (운영자) | weekly_activities.output_images | **없음** | **부족** |
| team_id | weekly_activities.team_id | **없음** | (info에선 미사용) |
| 강화 상태 | activity_records.is_completed | submission 존재 여부로 대체 ✅ | |
| Sub Title (사용자) | user_activity_details.sub_title | — | user_activity_details ✅ |
| Growth Point (사용자) | user_activity_details.growth_point | — | user_activity_details ✅ |
| Image (사용자) | user_activity_details.image_urls | — | user_activity_details ✅ |
| Rating | user_activity_details.rating | — | user_activity_details ✅ |

### 3-2. 실무 역량 (competency) — 단일 카드

| 프론트 필요 데이터 | cluster4_lines | 부족 여부 |
|---|---|---|
| activity_type_id (comp-1 등) | **없음** | **부족** |
| Main Title | main_title ✅ | |
| Line Code | activity_types.line_code (JOIN 필요) | **activity_type_id 필요** |
| 나머지 | info와 동일 | |

### 3-3. 실무 경험 (experience) — 최대 5개 카드

| 프론트 필요 데이터 | cluster4_lines | 부족 여부 |
|---|---|---|
| activity_type_id (exp-1 등) | **없음** | **부족** |
| team_id | **없음** | **부족** |
| Rating (별점) | user_activity_details.rating ✅ | |
| 나머지 | info와 동일 | |

### 3-4. 실무 경력 (career) — 카드 수 = career_records 수

| 프론트 필요 데이터 | 현재 출처 | cluster4_lines | 부족 여부 |
|---|---|---|---|
| 회사명/로고/감독자 등 15+ 필드 | career_projects | 표현 불가 | **별도 관리** |
| 등급 / 점수 | career_records.grade | 표현 불가 | **별도 관리** |
| enhancement_status | career_records | 표현 불가 | **별도 관리** |
| 제출 기간 | (기존에 없음) | submission_opens/closes_at ✅ | |
| 기본 개설 관리 | career_project_weeks | cluster4_lines 병용 가능 | |

### 분석 결론

```
info / competency / experience:
  cluster4_lines에 activity_type_id, output_images, team_id 추가 시 완전 표현 가능.
  강화 판정은 cluster4_line_submissions 존재 여부로 대체.

career:
  cluster4_lines로 표현 불가 (15+ 필드의 career_projects 도메인).
  기존 career_projects + career_records 체계 유지.
  cluster4_lines(part_type='career')는 제출 기간 관리 용도로만 사용.
```

---

## 4. 최종 아키텍처

### 4-1. SoT 정의

```
┌────────────────────────────┬─────────────────────────────────┐
│ 도메인                      │ Source of Truth                 │
├────────────────────────────┼─────────────────────────────────┤
│ 라인 개설 (1차 정보)        │ cluster4_lines                  │
│ 주차 배정 + 대상 지정       │ cluster4_line_targets           │
│ 제출 확인 (강화 판정 근거)  │ cluster4_line_submissions       │
│ 사용자 2차 정보             │ user_activity_details           │
│ 경력 프로젝트 메타          │ career_projects + career_records│
└────────────────────────────┴─────────────────────────────────┘
```

### 4-2. 역할 분담: cluster4_line_submissions vs user_activity_details

```
cluster4_line_submissions:
  역할 = "제출 확인" + "기본 텍스트"
  핵심 = 존재 여부가 강화 성공/실패 판정 기준
  저장 = subtitle, output_link_2~5 (현재 스키마 유지)
  키   = (line_target_id, user_id) UNIQUE

user_activity_details:
  역할 = "풍부한 2차 정보 저장소"
  핵심 = sub_title, growth_point, image_urls, image_captions, rating
  저장 = 모든 사용자 콘텐츠
  키   = (user_id, week_id, activity_type_id) UNIQUE
```

**분리 근거**:

1. **키 구조가 다르다**: submissions는 (line_target_id, user_id), user_activity_details는 (user_id, week_id, activity_type_id). 프론트는 (week_id, activity_type_id) 기반으로 데이터를 조회하므로 user_activity_details의 키 구조가 프론트 소비에 적합.

2. **책임 분리**: submissions는 "제출 여부" (boolean 성격), user_activity_details는 "콘텐츠" (텍스트/이미지 성격). 제출 확인은 라인 시스템의 관심사, 콘텐츠 관리는 사용자 프로필의 관심사.

3. **기존 user_activity_details 활용**: 이미 migration이 적용되어 존재. 컬럼 구조가 프론트 요구사항과 정확히 일치. 새로 만들 이유 없음.

4. **스키마 팽창 방지**: submissions에 growth_point, image_urls, image_captions, rating, growth_image_url, growth_image_caption을 추가하면 6개 컬럼 증가. user_activity_details에 이미 존재하므로 중복.

### 4-3. 연결 방법: cluster4_lines.activity_type_id

```
cluster4_lines                    user_activity_details
  activity_type_id (text) ─────→   activity_type_id (text)
                                    + user_id + week_id

cluster4_line_targets
  week_id ──────────────────────→  week_id

cluster4_line_submissions
  user_id ──────────────────────→  user_id
```

사용자가 모달에서 2차 정보를 저장하면:
- `cluster4_lines.activity_type_id` + `target.week_id` + `submission.user_id` 로
- `user_activity_details (user_id, week_id, activity_type_id)` 행을 UPSERT.

### 4-4. 전체 데이터 흐름

```
[Admin 라인 개설]

  POST /admin/cluster4/lines
    → cluster4_lines (main_title, activity_type_id, output_link_1, output_images, ...)

  POST /admin/cluster4/lines/:id/targets
    → cluster4_line_targets (line_id, week_id, target_user_id)


[프론트 읽기 — 신규 API 필요]

  GET /api/cluster4/week-bundle?weekId=&userId=
    → cluster4_lines + targets + submissions JOIN
    → 카드 데이터 조립 (title, is_active, 강화 상태)
    → user_activity_details (sub_title, growth_point, images, rating)
    → 기존 weekBundle 형태와 동일한 DTO로 반환


[사용자 2차 정보 편집]

  PUT /api/activity-details (기존 경로 수정)
    → 유효성 검증: cluster4_lines + targets에서 is_active, 제출 기간 확인
      (기존: weekly_activities 참조 → 변경: cluster4_lines 참조)
    → UPSERT user_activity_details (sub_title, growth_point, image_urls, ...)


[사용자 제출 확인]

  POST /cluster4/lines/:targetId/submission
    → INSERT cluster4_line_submissions
    → 이것이 강화 판정의 근거 (존재 = completed)


[강화 상태 판정 — 기존 프론트 로직 대응]

  submission 존재                     → "waiting" 또는 "success" (시간 기준)
  submission 미존재 + 기간 내          → "pending" (아직 제출 전)
  submission 미존재 + 기간 만료        → "failed"
  target 미존재                       → "not_applicable"
```

### 4-5. 강화 상태 매핑

기존 프론트 `getEnhancementStatus()`의 `activity_records.is_completed` 의존성을
`cluster4_line_submissions` 존재 여부로 대체:

| 기존 (activity_records) | 신규 (cluster4_line_submissions) | 강화 상태 |
|---|---|---|
| 행 없음 | target 없음 | `not_applicable` |
| 행 없음 | target 있음 + 기간 내 + submission 없음 | 프론트에서 `failed`로 표시되나 실제로는 미제출 상태 |
| 행 없음 | target 있음 + 기간 만료 + submission 없음 | `failed` |
| is_completed = true, 결정 전 | submission 존재 + 결정 전 | `waiting` |
| is_completed = true, 결정 후 | submission 존재 + 결정 후 | `success` |

---

## 5. 부족한 컬럼 및 위치

### 5-1. cluster4_lines 추가 컬럼

| 컬럼 | 타입 | NULL | DEFAULT | 용도 |
|---|---|---|---|---|
| `activity_type_id` | text | NULL | | 활동 분류 식별자. user_activity_details 연결 키. 어드민 드롭다운 선택. |
| `output_images` | jsonb | NOT NULL | `'[]'::jsonb` | 운영자 이미지 복수. 기존 output_link_1(단일)의 이미지 버전. |
| `team_id` | uuid | NULL | | 실무 경험 팀 지정. experience 파트 전용. |

**activity_type_id 충돌 방지**:
```
부분 UNIQUE 인덱스:
  UNIQUE (activity_type_id)
    WHERE activity_type_id IS NOT NULL AND is_active = true
```

**career 파트에서의 activity_type_id**:
- career는 activity_type_id 대신 career_project_id로 식별
- cluster4_lines(part_type='career')는 activity_type_id = NULL 허용
- 대신 아래 career_project_id 컬럼 사용

**career 연결 컬럼**:

| 컬럼 | 타입 | NULL | 용도 |
|---|---|---|---|
| `career_project_id` | uuid | NULL | career 파트 전용. FK → career_projects.id ON DELETE SET NULL |

career 파트 사용 시: activity_type_id = NULL, career_project_id = 값
비career 파트 사용 시: activity_type_id = 값, career_project_id = NULL

### 5-2. cluster4_line_submissions — 추가 컬럼 없음

submissions에 growth_point, image_urls 등을 추가하지 않는다.

```
이유:
1. user_activity_details에 이미 존재하고 프론트가 해당 테이블에서 직접 읽음
2. 두 테이블에 같은 데이터를 저장하면 불일치 위험
3. submissions의 역할은 "제출 확인" — 콘텐츠 저장소 아님
```

현재 스키마의 subtitle, output_link_2~5는 유지:
- subtitle: 제출 시점 스냅샷 (어드민 확인용)
- output_link_2~5: 제출물 링크 (submission 고유 데이터)

### 5-3. user_activity_details — 추가 컬럼 없음

현재 스키마가 프론트 요구사항을 완전히 충족:
```
sub_title        ✅
output_links     ✅ (jsonb array)
growth_point     ✅
image_urls       ✅ (text array)
image_captions   ✅ (text array)
rating           ✅ (0~10)
growth_image_url ✅
growth_image_caption ✅
```

### 5-4. activity_types — CHECK 제약조건 변경

info 타입을 DB 기반으로 관리하기 위해:

```
현재 CHECK:
  cluster_id IN ('practical_competency', 'practical_experience', 'practical_career')

변경 후:
  cluster_id IN ('practical_info', 'practical_competency', 'practical_experience', 'practical_career')
```

info 타입 9개 seed:
```
wisdom, essay, infodesk, calendar, forum, session, practical_lecture, community, etc_a
→ cluster_id = 'practical_info'
```

---

## 6. Career 파트 아키텍처

### 구조

```
cluster4_lines (part_type='career')
  │  career_project_id → career_projects.id
  │  submission_opens_at / closes_at (제출 기간)
  │  is_active
  │
  └── cluster4_line_targets (week_id, target_user_id)
        │
        └── cluster4_line_submissions (제출 확인)

career_projects (마스터 — 독립)
  │  company_name, supervisor_*, project_name 등 15+ 필드
  │
  ├── career_project_weeks (주차 junction)
  │
  └── career_records (사용자별 grade, enhancement_status)
```

### 역할 분담

| 관심사 | 담당 테이블 |
|---|---|
| 프로젝트 메타데이터 (회사/감독자) | career_projects |
| 주차별 활성화 | career_project_weeks (기존) + cluster4_line_targets (신규 병행) |
| 등급 / 점수 | career_records.grade, grade_points |
| career 강화 상태 | career_records.enhancement_status (기존 4-state: not_applicable/pending/enhanced/failed) |
| 제출 기간 관리 | cluster4_lines.submission_opens/closes_at |
| 제출 확인 | cluster4_line_submissions |
| 사용자 2차 정보 | user_activity_details (activity_type_id = career_projects.line_code 등으로 매핑) |

### career 강화 판정 특수 사항

career의 강화 상태는 `career_records.enhancement_status`로 관리 (4-state).
다른 3개 허브는 `cluster4_line_submissions` 존재 여부 + 시간으로 계산 (computed).

이 차이를 유지한다. career의 enhancement_status는 어드민이 수동 관리하는 필드이므로
submissions 존재 여부로 자동 계산하는 구조와 맞지 않는다.

---

## 7. 프론트 API 변경 필요 사항

### 7-1. 신규 API: week-bundle 대체

기존 `/api/profile?context=card`의 weekBundle이 weekly_activities/activity_records를 참조하므로, cluster4_* 기반으로 대체 API가 필요하다.

```
GET /api/cluster4/week-bundle?weekId={uuid}&userId={uuid}

응답:
{
  lines: [
    {
      lineId, activityTypeId, partType, mainTitle,
      outputLink1, outputImages, teamId,
      isActive, submissionOpensAt, submissionClosesAt,
      targetId, targetMode,
      hasSubmission,    // cluster4_line_submissions 존재 여부
      submittedAt       // submission 시점 (강화 대기/성공 판정용)
    }
  ],
  activityDetails: [
    {
      activityTypeId, subTitle, growthPoint,
      outputLinks, imageUrls, imageCaptions, rating
    }
  ],
  careerRecords: [ ... ],   // 기존 career_records 데이터
  careerProjects: [ ... ]   // 기존 career_projects 데이터
}
```

이 API 하나로 프론트가 4개 허브에 필요한 데이터를 모두 받을 수 있다.

### 7-2. 기존 API 수정: activity-details

```
PUT /api/activity-details

변경 전:
  weekly_activities 테이블에서 is_active, deadline 검증 → 실패 (테이블 미존재)

변경 후:
  cluster4_lines + cluster4_line_targets에서 is_active, submission_closes_at 검증
  → activity_type_id로 line 매칭
  → target의 week_id, target_user_id로 접근 권한 확인
  → UPSERT user_activity_details
```

### 7-3. 프론트 컴포넌트 변경

```
Cluster4CardContent.tsx:

  현재: weekBundle.weeklyActivities 에서 title, is_active 읽기
  변경: week-bundle API 응답의 lines[] 에서 읽기

  현재: getEnhancementStatus() → activity_records.is_completed 확인
  변경: lines[].hasSubmission + submittedAt 으로 계산

  현재: workInfoActivityTypes = 하드코딩 9개
  변경: activity_types 테이블에서 cluster_id='practical_info' 조회
```

---

## 8. 최소 Migration 목록

### Migration 1: cluster4_lines 컬럼 추가

```
ALTER TABLE cluster4_lines:
  + activity_type_id    text         NULL
  + output_images       jsonb        NOT NULL DEFAULT '[]'::jsonb
  + team_id             uuid         NULL
  + career_project_id   uuid         NULL     FK → career_projects.id ON DELETE SET NULL

부분 UNIQUE 인덱스:
  UNIQUE (activity_type_id) WHERE activity_type_id IS NOT NULL AND is_active = true

인덱스:
  (activity_type_id) WHERE activity_type_id IS NOT NULL
  (career_project_id) WHERE career_project_id IS NOT NULL
```

### Migration 2: activity_types CHECK 변경 + info seed

```
activity_types CHECK 제약조건 변경:
  DROP CONSTRAINT activity_types_cluster_id_valid
  ADD CONSTRAINT activity_types_cluster_id_valid
    CHECK (cluster_id IN ('practical_info', 'practical_competency', 'practical_experience', 'practical_career'))

INSERT 9개 info 타입:
  id             | name           | line_code | cluster_id      | is_active
  wisdom         | 위즈덤         | wisdom    | practical_info  | true
  essay          | 에세이         | essay     | practical_info  | true
  infodesk       | 인포데스크     | infodesk  | practical_info  | true
  calendar       | 캘린더         | calendar  | practical_info  | true
  forum          | 포럼           | forum     | practical_info  | true
  session        | 세션           | session   | practical_info  | true
  practical_lecture | 프랙티컬 렉처 | practical_lecture | practical_info | true
  community      | 커뮤니티       | community | practical_info  | true
  etc_a          | 기타 A         | etc_a     | practical_info  | true

(name, description은 운영 정책에 따라 확정. 위는 초안.)
```

### Migration 3 (선택): career_project_weeks 정합성

cluster4_line_targets(career)와 career_project_weeks가 동일 도메인을 다루므로,
향후 통합 시 정리 migration 필요할 수 있음. 현 시점에서는 병존 허용.

### 최종 필수 Migration 수: 2개

```
Migration 1: cluster4_lines 컬럼 4개 + 부분 UNIQUE + 인덱스
Migration 2: activity_types CHECK 변경 + info 타입 9개 seed
```

cluster4_line_submissions, user_activity_details에는 변경 없음.

---

## 9. 구현 순서

```
Phase 1: Migration 적용
  ├── Migration 1: cluster4_lines 컬럼 추가
  ├── Migration 2: activity_types info seed
  └── 타입/DTO/파서 업데이트
       ├── Cluster4LineUpsertInput에 activityTypeId, outputImages, teamId, careerProjectId 추가
       ├── Cluster4LineDto에 동일 필드 추가
       └── parseCluster4LineCreateBody, parseCluster4LinePatchBody 수정

Phase 2: Admin API 보강
  ├── 어드민 라인 생성 시 activity_type_id 드롭다운 (activity_types 조회)
  ├── 어드민 라인 생성 시 output_images, team_id 입력 지원
  └── career 라인 생성 시 career_project_id 선택 지원

Phase 3: 사용자 API 수정
  ├── GET /api/cluster4/week-bundle 신규 (또는 기존 profile API 확장)
  ├── PUT /api/activity-details 수정 (cluster4_lines 기반 검증)
  └── POST/PATCH /cluster4/lines/:targetId/submission (현재 작동 — 유지)

Phase 4: 프론트 연동
  ├── Cluster4CardContent.tsx week-bundle 데이터 소스 전환
  ├── getEnhancementStatus() 로직 전환 (submissions 기반)
  ├── workInfoActivityTypes 하드코딩 제거 → activity_types 쿼리
  └── buildWeeklyCards() 데이터 소스 전환

Phase 5: 검증
  ├── 라인 개설 → 카드 표시
  ├── 사용자 2차 정보 입력 → 모달 표시
  ├── 사용자 제출 → 강화 상태 전환 (pending → waiting → success)
  └── career 라인 → career_projects 연동 확인
```

---

## 10. 요약: 이전 설계 대비 변경점

| 항목 | Sync Bridge 설계 (폐기) | 최종 아키텍처 |
|---|---|---|
| weekly_activities | 동기화 대상 | **미존재. 불필요.** |
| activity_records | 동기화 대상 | **미존재. 불필요.** |
| 동기화 함수 | 2개 (sync bridge) | **0개. 동기화 자체 불필요.** |
| 강화 판정 | activity_records.is_completed | **cluster4_line_submissions 존재 여부** |
| user_activity_details | 동기화 제외 (기존 경로) | **유지. 2차 정보 SoT.** activity-details API 검증 로직만 수정. |
| 프론트 변경 | 최소화 (레거시 유지) | **필수.** weekly_activities/activity_records 참조를 cluster4_* 으로 전환. |
| Migration 수 | 3개 | **2개** |
| career 처리 | 제외 | **cluster4_lines에서 제출 기간 관리. 메타/등급은 career_projects/career_records 유지.** |
| activity_types info | 미결 | **practical_info cluster_id 추가 + 9개 seed** |
