# Cluster4 Sync-Bridge 최종 설계서

> **작성일**: 2026-05-27
> **상태**: 확정 — 이후 Migration SQL 작성의 기준 문서
> **입력 문서**:
>   - 원안: `cluster4-sync-bridge-design-20260527.md`
>   - 리뷰: `cluster4-sync-bridge-review-20260527.md`

---

## 1. 채택/기각 결정표

| # | 리뷰 항목 | 심각도 | 결정 | 근거 |
|---|---|---|---|---|
| 1 | user_activity_details 동기화 제거 | CRITICAL | **채택** | 기존 프론트가 `PUT /api/activity-details`로 직접 쓰는 경로가 존재. 동기화 시 양방향 쓰기 충돌로 데이터 소실 발생. `activity_records.is_completed`만 동기화하면 강화 판정이 정상 작동함. |
| 2 | Migration 2 삭제 | MAJOR | **채택** | #1 결정에 의해 `user_activity_details` 동기화가 없으므로, `cluster4_line_submissions`에 `growth_point`/`image_urls`/`image_captions`/`rating`을 추가할 이유 소멸. dead column 방지. |
| 3 | career 파트 cluster4_lines 제외 | MAJOR | **부분 채택** | `cluster4_lines.part_type='career'`는 스키마에 잔류(기존 CHECK 유지). 그러나 **career에 대한 레거시 동기화는 수행하지 않음**. career 라인 개설은 기존 `career_projects` + `career_project_weeks` + `career_records` 체계로 계속 관리. `career_project_id` 컬럼 추가하지 않음. `syncCareerLineToLegacy()` 함수 불필요. |
| 4 | activity_type_id 충돌 방지 제약조건 | MINOR | **채택** | 활성 라인 간 동일 `activity_type_id` 허용 시 sync 대상 행 모호. 부분 UNIQUE 인덱스로 방지. |
| 5 | SoT 범위 축소 정의 | MINOR | **채택** | "유일한 SoT" 선언은 과대. 도메인별 분리 정의 채택. |
| 6 | rule target 설계 방향 명시 | MINOR | **채택** | Phase 1은 user 모드 전용(rule=501). 동기화 함수가 rule 모드에도 대응 가능한 구조임을 확인. |
| 7 | Migration 순서 변경 (0→3→4→1) | MINOR | **채택** | 레거시 스키마 확인 없이 브릿지 컬럼 타입을 확정할 수 없음. Phase 0 절대 선행. |
| 8 | weekly_activities fan-out 대응 | MINOR | **채택** | `updateCluster4Line()` 시 연관 target 조회 → batch UPDATE. |
| 9 | 전환기 공존 정책 명시 | MINOR | **채택** | 운영 정책 섹션 추가. |
| 10 | activity_type_id 입력 방식 필수화 | MINOR | **채택** | 어드민 UI에서 `activity_types` 드롭다운 필수 제공. |

---

## 2. 최종 SoT 정의

```
┌────────────────────────────┬──────────────────────────────────┐
│        도메인              │  Source of Truth                  │
├────────────────────────────┼──────────────────────────────────┤
│ 라인 개설 (1차 정보)       │ cluster4_lines                   │
│   주차 배정 + 대상 지정    │ cluster4_line_targets            │
│                            │                                  │
│ 제출 사실 (강화 판정 근거) │ cluster4_line_submissions        │
│                            │                                  │
│ 사용자 2차 정보            │ user_activity_details            │
│   (sub_title, growth_point,│ ← 기존 PUT /api/activity-details │
│    images, rating)         │   경로 유지, 변경 없음           │
│                            │                                  │
│ 경력 프로젝트 메타         │ career_projects                  │
│   (회사, 감독자, 등급 등)  │ + career_project_weeks           │
│                            │ + career_records                 │
│                            │ ← 기존 어드민 경로 유지          │
└────────────────────────────┴──────────────────────────────────┘

레거시 프로젝션 (읽기 전용, 동기화로 채움):
  weekly_activities  ← syncLineToWeeklyActivity()
  activity_records   ← syncSubmissionToActivityRecord()
```

---

## 3. 최종 아키텍처

### 3-1. 동기화 대상

| 레거시 테이블 | 동기화 여부 | 동기화 함수 | 방향 |
|---|---|---|---|
| `weekly_activities` | **O** | `syncLineToWeeklyActivity()` | cluster4_lines → weekly_activities |
| `activity_records` | **O** | `syncSubmissionToActivityRecord()` | cluster4_line_submissions → activity_records |
| `user_activity_details` | **X** | 없음 | 기존 프론트가 직접 관리 |
| `career_projects` | **X** | 없음 | 별도 도메인, 기존 체계 유지 |
| `career_project_weeks` | **X** | 없음 | 동일 |
| `career_records` | **X** | 없음 | 동일 |

### 3-2. 전체 데이터 흐름

```
┌─────────────────────────────────────────────────────────────────┐
│                         Admin Flow                               │
│                                                                  │
│  POST /admin/cluster4/lines                                      │
│    → INSERT cluster4_lines                                       │
│                                                                  │
│  POST /admin/cluster4/lines/:id/targets                          │
│    → INSERT cluster4_line_targets                                │
│    → syncLineToWeeklyActivity()                                  │
│        → UPSERT weekly_activities                                │
│          (title, is_active, output_links, output_images, ...)    │
│                                                                  │
│  PATCH /admin/cluster4/lines/:id                                 │
│    → UPDATE cluster4_lines                                       │
│    → 변경된 필드 있으면 연관 weekly_activities batch UPDATE       │
│                                                                  │
│  DELETE /admin/cluster4/targets/:targetId                        │
│    → DELETE cluster4_line_targets                                │
│    → 잔여 target 없으면 weekly_activities.is_active = false      │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│                         User Flow                                │
│                                                                  │
│  POST /cluster4/lines/:targetId/submission                       │
│    → INSERT cluster4_line_submissions                            │
│    → syncSubmissionToActivityRecord()                            │
│        → UPSERT activity_records SET is_completed = true         │
│                                                                  │
│  PUT /api/activity-details (기존 경로, 변경 없음)                │
│    → UPSERT user_activity_details                                │
│      (sub_title, growth_point, output_links, image_urls, ...)    │
│                                                                  │
│  ※ 두 경로는 서로 다른 테이블에 쓰므로 충돌 없음               │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│                    Frontend Read (변경 없음)                      │
│                                                                  │
│  GET /api/profile?context=card                                   │
│    → weekBundle.weeklyActivities[]  ← weekly_activities (동기화) │
│    → apiActivityRecords[]           ← activity_records  (동기화) │
│    → apiActivityDetails[]           ← user_activity_details      │
│                                        (기존 직접 관리)          │
│                                                                  │
│  getEnhancementStatus(activityType):                             │
│    activity_records.is_completed = true  → "waiting" / "success" │
│    activity_records.is_completed = false → "failed"              │
│    activity_records 행 없음             → "failed"              │
└─────────────────────────────────────────────────────────────────┘
```

### 3-3. 강화 상태 판정 흐름 (최종)

```
T0: 라인 개설
     admin: cluster4_lines + cluster4_line_targets
     sync:  weekly_activities.is_active = true
     front: 카드 표시됨. activity_records 없음 → "failed"

T1: 사용자 모달 열기 + 2차 정보 입력
     user:  PUT /api/activity-details → user_activity_details (sub_title, growth_point, ...)
     front: 모달에 2차 정보 표시됨. activity_records 여전히 없음 → "failed"

T2: 사용자 제출 (신규 API)
     user:  POST /cluster4/lines/:targetId/submission
     sync:  activity_records.is_completed = true
     front: getEnhancementStatus → "waiting"

T3: N+1 목 12:01 KST (결정 시점)
     변경 없음 (프론트 시간 계산으로 자동 전환)
     front: getEnhancementStatus → "success"

TX: 미제출 + 윈도우 마감
     activity_records 행 없음
     front: getEnhancementStatus → "failed"
```

---

## 4. 동기화 함수 최종 설계

### 4-1. syncLineToWeeklyActivity()

**호출 시점**:
- `createCluster4LineTarget()` 성공 후
- `updateCluster4Line()` 에서 title / is_active / output_link_1 / output_images / team_id 변경 시
- `deleteCluster4LineTarget()` 성공 후

**전제조건**:
- `line.activity_type_id IS NOT NULL` (NULL이면 skip — 레거시 매핑 없는 신규 전용 라인)
- `line.part_type != 'career'` (career는 동기화 대상 아님)

**동작**:

```
target 생성/수정 시:
  UPSERT weekly_activities
    ON CONFLICT (week_id, activity_type_id)
    SET:
      week_id           = target.week_id
      activity_type_id  = line.activity_type_id
      title             = line.main_title
      is_active         = line.is_active
      opened_at         = line.submission_opens_at
      deadline          = line.submission_closes_at
      output_links      = [{url: line.output_link_1}]  (NULL 제외, 빈 배열이면 '[]')
      output_images     = line.output_images
      team_id           = line.team_id

target 삭제 시:
  해당 (week_id, activity_type_id) 조합에 다른 활성 target이 있는지 확인
  → 있으면: 유지 (다른 target의 line 정보로 갱신)
  → 없으면: weekly_activities.is_active = false

line 수정 시 (fan-out):
  해당 line에 연결된 모든 target의 week_id 목록 조회
  → 변경된 필드만 weekly_activities에 batch UPDATE
```

### 4-2. syncSubmissionToActivityRecord()

**호출 시점**:
- `createCluster4LineSubmissionForAuthUser()` 성공 후
- `updateCluster4LineSubmissionForAuthUser()` 성공 후

**전제조건**:
- `line.activity_type_id IS NOT NULL`
- `line.part_type != 'career'`

**동작**:

```
UPSERT activity_records
  ON CONFLICT (user_id, week_id, activity_type_id)
  SET:
    user_id           = submission.user_id
    week_id           = target.week_id
    activity_type_id  = line.activity_type_id
    is_completed      = true
```

단일 테이블, 단일 행 UPSERT. 가장 단순한 형태.

### 4-3. 동기화하지 않는 것 (명시적 제외)

| 대상 | 제외 이유 |
|---|---|
| `user_activity_details` | 기존 프론트가 `PUT /api/activity-details`로 직접 관리. 양방향 쓰기 충돌 방지. |
| `career_project_weeks` | career 파트는 기존 체계 유지. 동기화 복잡도 + grade/grade_points 충돌 위험. |
| `career_records` | 동일. |

---

## 5. activity_type_id 브릿지 정책 (최종)

### 컬럼 정의

```
cluster4_lines.activity_type_id   text   NULL
```

- FK 미부여 (기존 `user_activity_details.activity_type_id` 관례와 동일)
- NULL = 레거시 매핑 없는 신규 전용 라인 → 동기화 skip

### 충돌 방지: 부분 UNIQUE 인덱스

```
UNIQUE (activity_type_id)
  WHERE activity_type_id IS NOT NULL
    AND is_active = true
```

효과:
- 활성 라인 간 동일 `activity_type_id` 금지 → sync 대상 행 모호성 제거
- 비활성(is_active=false) 라인은 중복 허용 (히스토리 보존)
- NULL은 UNIQUE에서 제외 (PostgreSQL 기본 동작)

### 입력 방식

**필수 요건**: 어드민 UI에서 `activity_types` 테이블을 드롭다운으로 제공.

```
어드민 라인 생성 UI:
  part_type 선택 (info / experience / competency)
    ↓
  해당 part_type에 속하는 activity_types 목록 필터
    (info: cluster_id 기반이 아닌 개별 ID 목록)
    (competency: cluster_id = 'practical_competency')
    (experience: cluster_id = 'practical_experience')
    ↓
  드롭다운에서 선택 → activity_type_id 자동 입력
```

자유 텍스트 입력 금지. 오타/오매핑 방지.

### part_type → activity_types 필터 규칙

| part_type | activity_types 필터 조건 | 비고 |
|---|---|---|
| `info` | 별도 매핑 테이블 또는 하드코딩 목록 | activity_types에 info 전용 cluster_id 없음 |
| `competency` | `cluster_id = 'practical_competency'` | |
| `experience` | `cluster_id = 'practical_experience'` | |
| `career` | 동기화 대상 아님 | activity_type_id 입력 불필요 |

**info 파트 특수 사항**: `activity_types` 테이블에 `practical_info` cluster_id가 없다.
info 활동 타입('wisdom', 'essay', 'forum', 'infodesk', 'calendar', 'session', 'etc_a')은
별도 목록으로 관리하거나, `activity_types`에 `practical_info` cluster_id를 추가하는 migration이 필요하다.

```
미결 → Phase 0에서 운영 DB의 activity_types 실데이터 확인 후 결정:
  옵션 A: activity_types에 practical_info cluster_id 추가 (migration 필요)
  옵션 B: 어드민 코드에 info 타입 하드코딩 목록 유지
```

---

## 6. Career 파트 처리 (최종)

### 결정: 부분 채택 — 스키마 잔류, 동기화 제외

```
cluster4_lines.part_type CHECK:
  ('info', 'experience', 'competency', 'career')  ← 기존 CHECK 유지, 변경 없음

동기화 대상:
  info        → weekly_activities + activity_records 동기화   ✅
  experience  → weekly_activities + activity_records 동기화   ✅
  competency  → weekly_activities + activity_records 동기화   ✅
  career      → 동기화 없음                                  ❌
```

### 근거

1. `career_projects`는 15+ 필드의 풍부한 마스터 (회사/감독자/프로젝트 메타)
2. `career_project_weeks`가 이미 주차별 개설 관리 담당
3. `career_records.grade / grade_points`는 어드민이 별도 관리 — sync UPSERT 시 덮어쓰기 위험
4. `cluster4_lines`의 6필드로는 career 도메인을 표현할 수 없음
5. `career_project_id` FK를 추가해도 이중 관리 비용만 증가

### career 라인의 향후 방향

career 파트에 대해 `cluster4_lines` row를 생성하는 것 자체는 허용한다.
그러나 이 row는 **admin 관리 UI 내부에서의 메타데이터로만 사용**하며,
레거시 테이블 동기화는 수행하지 않는다.

career 라인 개설 운영 흐름:
```
기존 (유지):
  어드민 → career_projects 생성 → career_project_weeks에 주차 배정

신규 (선택적):
  어드민 → cluster4_lines(part_type='career') 생성 가능
  → 그러나 weekly_activities / activity_records에 동기화되지 않음
  → admin 내부 관리 목적으로만 사용 (제출 기간 추적 등)
```

---

## 7. Rule Target 지원 전략 (최종)

### Phase 1 결정: user 모드 전용. rule 모드는 501 유지.

```
Phase 1 (현재):
  cluster4_line_targets.target_mode = 'user'  → 지원
  cluster4_line_targets.target_mode = 'rule'  → 501 Not Implemented 응답
```

### rule 모드가 동기화에 미치는 영향 (Phase 2 대비)

rule 모드 지원 시에도 동기화 함수 변경이 불필요한 이유:

```
syncLineToWeeklyActivity():
  weekly_activities는 (week_id, activity_type_id) PK — user_id 무관
  → rule target이든 user target이든 동일하게 동기화 가능
  → 변경 없음

syncSubmissionToActivityRecord():
  activity_records는 (user_id, week_id, activity_type_id) PK — user_id 필수
  → submission에는 항상 user_id가 있음 (제출자)
  → target이 rule 모드여도 submission 시점에 user_id 확정
  → 변경 없음
```

### Phase 2 추가 작업 (참고, 이번 설계 범위 밖)

```
1. rule evaluator 함수: target_rule JSON → 매칭 사용자 목록 계산
2. 사용자 라인 조회 시 rule 매칭 평가 로직
3. rule target 생성 시 weekly_activities 동기화 (user target과 동일 경로)
4. 동기화 함수 자체는 변경 불필요
```

---

## 8. 전환기 공존 정책

### 문제

기존 운영에서 `weekly_activities`에 직접 INSERT/UPDATE하는 경로가 있을 수 있다.
이 경우 cluster4_lines에 대응 행이 없어 SoT 전제가 깨진다.

### 정책

```
Phase 1~3 (동기화 구현 완료 전):
  → 기존 weekly_activities 직접 쓰기 경로 허용
  → cluster4_lines 동기화도 병행
  → 이중 SoT 상태를 인정

Phase 4 (검증 완료 후):
  → 기존 weekly_activities 직접 쓰기 경로 비활성화
    (Career-Resume 어드민에서 weekly_activities INSERT 차단)
  → 모든 라인 개설은 cluster4_lines 경유로 전환
  → weekly_activities는 동기화 프로젝션으로만 존재

역마이그레이션:
  → 기존 weekly_activities 데이터 중 cluster4_lines에 없는 행은
    역방향 import 스크립트로 cluster4_lines에 생성
  → Phase 4 전환 시 1회성 실행
  → 스크립트 설계는 이번 문서 범위 밖
```

---

## 9. cluster4_line_submissions.subtitle 처리

### 결정: 잔류. SoT는 user_activity_details.sub_title.

```
cluster4_line_submissions.subtitle:
  → 제출 시점의 스냅샷으로 유지
  → 어드민이 "사용자가 뭘 제출했는지" 확인하는 용도
  → user_activity_details.sub_title과 동기화하지 않음
  → 사용자가 이후 모달에서 sub_title을 수정해도 submissions.subtitle은 갱신되지 않음

user_activity_details.sub_title:
  → SoT. 기존 PUT /api/activity-details 경로로 관리
  → 프론트가 카드에 표시하는 값
```

---

## 10. 최종 Migration 목록

### Migration A: 레거시 canonical DDL (2개)

**선행 조건**: Phase 0 운영 DB 스키마 덤프 완료 후 확정.

```
Migration A-1: weekly_activities canonical DDL
  → 운영 DB \d+ 결과 기반으로 CREATE TABLE IF NOT EXISTS 작성
  → 필수 컬럼: id, week_id, activity_type_id, title, is_active,
    opened_at, deadline, team_id, output_links, output_images
  → UNIQUE (week_id, activity_type_id)

Migration A-2: activity_records canonical DDL
  → 운영 DB \d+ 결과 기반으로 CREATE TABLE IF NOT EXISTS 작성
  → 필수 컬럼: id, user_id, week_id, activity_type_id, is_completed
  → UNIQUE (user_id, week_id, activity_type_id)
```

### Migration B: cluster4_lines 브릿지 컬럼 (1개)

**선행 조건**: Migration A 확정 후 (activity_type_id 실제 타입 확인).

```
Migration B-1: cluster4_lines 레거시 브릿지 컬럼

  ALTER TABLE cluster4_lines ADD COLUMN IF NOT EXISTS:
    activity_type_id    text         NULL
    output_images       jsonb        NOT NULL DEFAULT '[]'::jsonb
    team_id             uuid         NULL

  부분 UNIQUE 인덱스:
    UNIQUE (activity_type_id)
      WHERE activity_type_id IS NOT NULL AND is_active = true
```

| 컬럼 | 타입 | 용도 | FK |
|---|---|---|---|
| `activity_type_id` | text NULL | 레거시 식별자 브릿지 | 없음 |
| `output_images` | jsonb DEFAULT '[]' | 운영자 이미지 복수 | 없음 |
| `team_id` | uuid NULL | 실무 경험 팀 지정 | 없음 (teams DDL 미확정) |

### 삭제된 Migration

| 원안 | 상태 | 사유 |
|---|---|---|
| Migration 2 (submissions 4컬럼) | **삭제** | user_activity_details 동기화 제거에 따라 불필요 |
| Migration 5 (동기화 인덱스) | **삭제** | UNIQUE 제약조건이 이미 인덱스 역할 |
| career_project_id 컬럼 | **삭제** | career 동기화 제외에 따라 불필요 |

### 최종 Migration 수: 3개

```
Migration A-1: weekly_activities canonical DDL
Migration A-2: activity_records canonical DDL
Migration B-1: cluster4_lines 브릿지 컬럼 + 부분 UNIQUE 인덱스
```

---

## 11. 최종 구현 순서

```
Phase 0: 운영 DB 스키마 덤프                          ← 절대 선행
  ├── \d+ weekly_activities
  ├── \d+ activity_records
  ├── \d+ teams, parts, user_team_parts, user_role_history
  ├── SELECT * FROM activity_types (info 타입 ID 목록 확인)
  └── canonical DDL 초안 작성

Phase 1: Migration 작성 + 적용
  ├── Migration A-1: weekly_activities canonical DDL
  ├── Migration A-2: activity_records canonical DDL
  ├── Migration B-1: cluster4_lines 브릿지 컬럼
  └── 타입/DTO/파서 업데이트
       ├── Cluster4LineUpsertInput에 activityTypeId 추가
       ├── Cluster4LinePatchInput에 activityTypeId 추가
       ├── parseCluster4LineCreateBody에 activity_type_id 파싱 추가
       └── Cluster4LineDto에 activityTypeId, outputImages, teamId 추가

Phase 2: 동기화 함수 구현
  ├── lib/cluster4SyncBridge.ts 신규 파일
  │    ├── syncLineToWeeklyActivity(line, target)
  │    └── syncSubmissionToActivityRecord(submission, target, line)
  └── 단위 테스트 (동기화 함수 로직 검증)

Phase 3: API 레이어 통합
  ├── lib/adminCluster4LinesData.ts
  │    ├── createCluster4LineTarget() 후 sync 호출
  │    ├── updateCluster4Line() 후 변경 필드 있으면 batch sync
  │    ├── deleteCluster4Line() 후 weekly_activities.is_active = false
  │    └── deleteCluster4LineTarget() 후 잔여 target 재평가 + sync
  │
  └── lib/cluster4LinesData.ts
       ├── createCluster4LineSubmissionForAuthUser() 후 sync 호출
       └── updateCluster4LineSubmissionForAuthUser() 후 sync 호출

Phase 4: 검증
  ├── 동기화 정합성 검증 쿼리
  │    ├── cluster4_lines ↔ weekly_activities 매칭 확인
  │    └── cluster4_line_submissions ↔ activity_records 매칭 확인
  ├── smoke test: 라인 개설 → 프론트 카드 표시 확인
  ├── smoke test: 사용자 제출 → 강화 상태 전환 확인 (failed → waiting → success)
  └── smoke test: 기존 PUT /api/activity-details → user_activity_details 정상 작동 확인

Phase 5 (향후): 전환 완료
  ├── 기존 weekly_activities 직접 쓰기 경로 비활성화
  ├── 기존 데이터 역마이그레이션 스크립트 실행
  ├── 프론트가 cluster4_lines 직접 읽기로 전환 (장기)
  └── 동기화 함수 제거 (장기)
```

---

## 12. 원안 대비 최종안 비교

| 항목 | 원안 | 최종안 | 변경 사유 |
|---|---|---|---|
| 동기화 대상 | 3개 테이블 | **2개** | user_activity_details 양방향 충돌 |
| 동기화 함수 | 3개 | **2개** | career sync 제거, user_activity_details sync 제거 |
| Migration 수 | 5개 | **3개** | Migration 2 삭제, Migration 5 삭제 |
| cluster4_lines 추가 컬럼 | 4개 | **3개** | career_project_id 삭제 |
| cluster4_line_submissions 추가 컬럼 | 4개 | **0개** | Migration 2 전체 삭제 |
| career 동기화 | O | **X** | 이중 구조 리스크, grade/grade_points 충돌 |
| SoT 선언 | "유일한 SoT" | **도메인별 분리** | 과대 선언 수정 |
| activity_type_id 충돌 방지 | 없음 | **부분 UNIQUE** | 동기화 대상 행 모호성 제거 |
| rule target | "향후" | **Phase 1 = 501, 동기화는 rule-ready** | 방향 명시 |
| Migration 순서 | 1→2→3→4 | **A-1→A-2→B-1** | Phase 0 선행 |
| 전환기 정책 | 미정의 | **이중 SoT 인정 → Phase 4에서 전환** | 공존 기간 명시 |
| subtitle 처리 | SoT 미정의 | **스냅샷 (SoT = user_activity_details)** | 양방향 충돌 방지 |

---

## 13. 리스크 및 미결 사항 (최종)

### 잔존 리스크

| # | 리스크 | 영향 | 완화 |
|---|---|---|---|
| R1 | weekly_activities 실제 스키마가 추론과 다름 | Migration A-1 수정 필요 | Phase 0에서 확인 |
| R2 | activity_records 실제 스키마가 추론과 다름 | Migration A-2 수정 필요 | Phase 0에서 확인 |
| R3 | info 파트의 activity_type_id 목록 관리 | 어드민 드롭다운 구성 필요 | Phase 0에서 실데이터 확인 |
| R4 | 기존 weekly_activities 데이터와 UPSERT 충돌 | 기존 행 덮어쓰기 | 전환기 정책으로 관리 |
| R5 | fan-out UPDATE 성능 (line 1개 → target N개) | 대량 UPDATE | batch SQL로 처리 |

### 미결 사항

```
1. Phase 0 미실행: weekly_activities, activity_records 실제 스키마 미확인
   → 이 설계서의 Migration A-1, A-2는 "추론 기반 초안"
   → Phase 0 완료 후 확정

2. info 파트 activity_type_id 관리 방식
   → activity_types에 'practical_info' cluster_id 추가? vs 하드코딩?
   → Phase 0에서 activity_types 실데이터 확인 후 결정

3. 기존 weekly_activities 역마이그레이션 범위
   → 기존 행 중 cluster4_lines에 없는 것을 역방향 import할 범위
   → Phase 5에서 결정

4. teams 테이블 DDL 미확정
   → cluster4_lines.team_id FK 부여 여부는 teams canonical DDL 확정 후 결정
```

---

## 부록: 이 설계서 이후 다음 단계

```
즉시: Phase 0 실행
  → Supabase Dashboard 또는 psql로 레거시 테이블 스키마 덤프
  → 결과를 이 설계서에 반영하여 Migration A-1, A-2 확정
  → activity_types 실데이터 확인 (info 타입 목록)

그 다음: Phase 1 Migration SQL 작성
  → 이 설계서의 §10을 기준으로 작성
```
