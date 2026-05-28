# Cluster4 Growth Sync Bridge — Technical Design

> **작성일**: 2026-05-28
> **개정**: 2026-05-28 (rev.3 — 실무 경험 라인 전제 정정, skip 분기 폐기)
> **상태**: 설계 검토용 (구현 금지)
> **범위**: cluster4_line_submissions → user_week_statuses → user_weekly_points → user_growth_stats → user_cumulative_points
> **선행 문서**:
> - `cluster4-sync-bridge-final-design.md` (라인 → legacy 동기화)
> - `source-of-truth-audit-20260528.md` (SoT 감사)
> - `2026-05-27_cluster4_experience_phase1.sql` (`cluster4_experience_line_evaluations`, rating=points 정책)

## REV.3 정정 사항 요약 (누적)

본 개정은 다음 정책을 반영한다 (rev.1/rev.2 폐기 항목 명시):

**REV.3 (2026-05-28, 최신)**:
- **전제 정정**: 실무 경험 라인이 없는 주차는 존재하지 않음. 모든 주차에 사용자 1인당 최소 1개의 실무 경험 라인이 배정된다.
- **폐기**: U3 (skip) 분기, §4-4 "실무 경험 라인 미배정 주차 처리" 정책 분기 전체
- **단순화**: status 판정은 3단계 우선순위로 확정
  1. 공식 휴식 → `official_rest`
  2. 개인/시즌 휴식 → `personal_rest`
  3. 일반 주차 → 실무 경험 참여 여부로 `success` / `fail`

**REV.2 (유지)**:
- **폐기**: SUCCESS_THRESHOLD, P2 (Threshold) 판정, F4 (status + 라인 충족 보너스) 포인트 산출
- **변경**: 주차 성장률 k는 **단순 수행률 지표** (success/fail 결정에 사용하지 않음)
- **변경**: 포인트 산출 = **평가 점수 1:1 매핑**
  - 실무 경험: 관리자가 0~10점 부여 (`cluster4_experience_line_evaluations.rating`) → 그대로 포인트
  - 실무 경력: 10/8/6/4/2점 중 하나 (`career_records.grade_points`) → 그대로 포인트
  - 실무 정보 / 실무 역량: 포인트 부여 여부 미확정 (현재 0으로 처리)
- **변경**: career는 평가/포인트 대상에 **포함** (이전 "career 제외" 표현 수정)

---

## 0. 본 문서의 위치

기존 sync bridge 설계(`cluster4-sync-bridge-final-design.md`)는 **라인 개설 → legacy(weekly_activities, activity_records) 동기화**까지를 다루었다. 본 문서는 그 다음 단계인 **사용자 제출 → 성장 도메인(week_statuses, weekly_points, growth_stats, cumulative_points) 반영**을 설계한다.

**기존 설계가 다룬 흐름** (T0~T3, 강화 상태 판정):
```
admin: cluster4_lines + targets → sync → weekly_activities
user:  cluster4_line_submissions → sync → activity_records.is_completed
front: getEnhancementStatus(activity_records) → "waiting"/"success"/"failed"
```

**본 문서가 다룰 흐름** (T_end, 주차 결정 → 누적 반영):
```
주차 종료
  → user_week_statuses.status 결정
  → user_weekly_points (points/advantages/penalty) 산출
  → user_growth_stats (approved_weeks/cumulative_weeks) 동기화
  → user_cumulative_points (stars/shields/lightnings) 동기화 (기존 trigger)
  → season 성공률 / Resume Card 갱신
```

---

## 1. 현재 상태와 갭 분석

### 1-1. 구현 완료된 부분

| 단계 | 상태 | 근거 |
|------|------|------|
| 라인 개설 (cluster4_lines CRUD) | ✅ | `lib/adminCluster4LinesData.ts:363-450` |
| 대상 배정 (cluster4_line_targets CRUD) | ✅ | 동일 파일 :452-591 |
| 사용자 제출 (cluster4_line_submissions) | ✅ | `lib/cluster4LinesData.ts:252-322` |
| 제출 윈도우 검증 | ✅ | `isWithinSubmissionWindow()` :101-110 |
| 강화 상태 판정 (T2~T3) | ✅ | `getCluster4LineDetailForAuthUser()` :201-250 |
| weekly_points → cumulative_points 동기화 | ✅ | `sync_cumulative_on_weekly_change` 트리거 |

### 1-2. 미구현 부분 (본 설계 대상)

| 단계 | 상태 | 핵심 누락 |
|------|------|----------|
| 제출 → user_week_statuses 반영 | ❌ | 주차 종료 시 success/fail 결정 메커니즘 없음 |
| 제출 → user_weekly_points 산출 | ❌ | 포인트 산출 규칙 없음 |
| user_week_statuses → user_growth_stats 동기화 | ❌ | 트리거 없음 (수동 재집계만) |
| Resume Card 활동 완료율 ↔ cluster4 | ❌ | 현재 user_activity_details에만 의존 |

### 1-3. 데이터 흐름의 핵심 모순

현재 다음 두 경로가 **독립적으로 작동**한다:

```
경로 A (Cluster4 신규):
  cluster4_line_submissions  → 강화 상태 ("waiting"/"success"/"failed")
                              → 라인 단위 판정, 즉시 가시화

경로 B (Legacy 성장):
  user_week_statuses.status  → 주차 단위 판정 (success/fail/personal_rest/official_rest)
                              → user_weekly_points → user_growth_stats → 누적
```

**갭**: 경로 A의 결과가 경로 B로 자동 전파되지 않는다. 시드 데이터로만 경로 B가 채워져 있다.

---

## 2. 분석 1 — 제출 → user_week_statuses 반영 시점

### 2-1. 반영 시점 후보

| 옵션 | 시점 | 트리거 | 장점 | 단점 |
|------|------|--------|------|------|
| **R1: 실시간 즉시 반영** | 각 제출 INSERT 후 | DB Trigger / API call | 지연 없음, 강화 상태와 일관 | 주차 내 추가 라인 개설 시 재평가 필요, 중간 status 의미 불명확 |
| **R2: 주차 종료 직후** | `weeks.end_date + 1day` 자정 | Cron / Edge Function | 결정 시점 명확, 1회 평가로 충분 | 인프라(스케줄러) 필요, 지연 발생 |
| **R3: 마지막 라인 마감 시점** | MAX(`submission_closes_at`) 도래 시 | Cron / Polling | 라인별 마감 차이 반영 | 라인이 매번 다른 마감을 가질 때 복잡 |
| **R4: 다음 주차 첫 조회 시 lazy 평가** | 사용자가 다음 주를 처음 열 때 | API on read | 인프라 불필요 | 평가 시점이 사용자 행동에 의존, 비관리자에게 평가 지연 |
| **R5: 수동 admin 일괄 처리** | 관리자 버튼 클릭 | API | 단순, 통제 가능 | 잊으면 영원히 미반영, 운영 부담 |

### 2-2. 기존 시스템과의 정합성

**기존 강화 상태 판정 시점** (`cluster4LinesData.ts:243`):
```typescript
const status = isSubmissionClosed(line.submissionClosesAt) ? "fail" : "pending";
```
→ 라인 단위, **조회 시점 lazy 평가** (저장하지 않음)

**기존 주차 status 시드 로직** (`2026-05-25_cluster3_growth_indicators.sql:214-218`):
```sql
CASE
  WHEN c.is_official_rest THEN 'official_rest'
  WHEN c.active_seq <= c.target_success THEN 'success'
  WHEN c.active_seq = c.total_active - 1 AND c.total_active > 3 THEN 'personal_rest'
  ELSE 'fail'
END
```
→ 마이그레이션 시점 1회, **저장 기반**

**Weekly Card 현재 status 표시** (`cluster4WeeklyGrowthData.ts:559-567`):
```typescript
if (uws.status === "official_rest" && weeksRow?.is_official_rest === false) {
  resultStatus = isCurrentWeek ? "running" : "fail";
} else if (isCurrentWeek && uws.status === "success") {
  resultStatus = "running";
}
```
→ 현재 주차는 무조건 "running"으로 표시 (저장된 status 무시)

### 2-3. 권장: 하이브리드 (R2 + R4)

```
주차 종료 시점 (weeks.end_date 다음날 00:00 KST):
  → 일괄 평가 함수 실행 (cron 또는 edge function)
  → 해당 주차의 모든 대상 사용자에 대해 user_week_statuses upsert
  
보정 경로 (R4 lazy):
  → 조회 시점 user_week_statuses 행이 없는 과거 주차 발견 시
  → 동일 평가 함수 inline 호출 → upsert → 반환
  → cron 실패/지연에 대한 자가 치유
```

**근거**:
- 주차 종료 = 명확한 결정 시점 (라인별 마감과 무관하게 단일 기준)
- 현재 주차는 어차피 Weekly Card에서 "running"으로 표시되므로 **확정 시점이 주차 종료 이후로 미뤄져도 UI에 영향 없음**
- Cron 실패 시 lazy 보정으로 데이터 누락 방지
- Realtime trigger(R1) 대비 단순함 — 한 주차에 라인 N개가 있을 때 N번 재평가하지 않음

---

## 3. 분석 2 — 주차 종료 시점 기준

### 3-1. 후보 기준

| 후보 | 데이터 소스 | 특성 |
|------|-------------|------|
| **B1: weeks.end_date** | `weeks` 테이블 | 글로벌 캘린더, 모든 사용자 동일 |
| **B2: MAX(submission_closes_at)** | `cluster4_lines` | 라인별 다름, 주차마다 다름 |
| **B3: weeks.end_date + grace period** | `weeks` + offset | 늦은 제출 허용 가능 |
| **B4: ISO 주 일요일 24:00** | 계산 | DB 무관, 시간대 명확 |

### 3-2. 권장: B1 (`weeks.end_date`) + 24시간 grace

```
평가 시점 = weeks.end_date + INTERVAL '1 day' (KST 00:00)
판정 시점 = 동일

이유:
1. weeks.end_date는 이미 글로벌 single source (season_definitions에서 파생)
2. 모든 사용자, 모든 라인이 동일 시점에 평가됨 → 단순
3. 라인별 submission_closes_at은 마감 시점 검증용이지, 주차 결정용이 아님
4. 24시간 grace는 자정 직전 제출의 시계 동기 오차 흡수
```

**제약**: 라인의 `submission_closes_at`이 `weeks.end_date + 1day`보다 늦으면 평가 시점에 미제출 상태가 됨. 따라서:
- **운영 정책**: 모든 cluster4_lines는 `submission_closes_at <= week.end_date + 1day` 강제 (validation 또는 admin UI에서 차단)

---

## 4. 분석 3 — success / fail / personal_rest / official_rest 판정 우선순위

### 4-1. 현재 4가지 status의 의미

| Status | 의미 | 현재 결정 주체 |
|--------|------|---------------|
| `official_rest` | 공식 휴식주 (설/추석/캘린더 규칙) | `weeks.is_official_rest` 또는 시드 |
| `personal_rest` | 시즌 휴식 신청 / 남은 주차 일괄 전환 | `seasonRestValidation.ts` |
| `success` | 활동 인정 | 시드 또는 (cluster4 통합 시 결정 필요) |
| `fail` | 활동 미인정 | 시드 또는 (동일) |

### 4-2. 판정 우선순위 (rev.3 정정 — 3단계로 단순화)

**전제 (rev.3)**: 모든 주차에는 사용자 1인당 최소 1개의 실무 경험 라인이 배정된다. 미배정 주차는 존재하지 않는다.

```
1순위: official_rest
  조건: weeks.is_official_rest = true
        AND user_week_statuses.is_official_rest_override = false
  → 활동 평가 무관, 무조건 official_rest
  → 단, override=true면 다음 순위로 진행 (활동 인정 가능)

2순위: personal_rest
  조건: user_season_statuses.status='rest' (해당 시즌)
        OR user_week_statuses.status가 이미 'personal_rest'로 수동 설정됨
  → 활동 평가 무관

3순위: 실무 경험 참여 기반 success / fail
  조건: 위 두 조건 미해당
  → 실무 경험 라인 제출 >= 1개 → success
  → 실무 경험 라인 제출 == 0개 → fail
```

### 4-3. success vs fail 판정 규칙 (rev.3 정정 — 단순화)

**기본 원칙**: 주차 success/fail은 **실무 경험 허브 참여 여부**가 핵심이자 유일한 조건이다. 다른 허브(실무 정보 / 실무 역량 / 실무 경력)의 참여/미참여는 status 결정에 영향을 주지 않는다.

```
주차 평가 규칙:

STEP 1: 실무 경험 라인 제출 여부 확인 (전제: 라인은 반드시 배정됨)
  experienceSubmissions = SELECT count(*)
    FROM cluster4_line_submissions s
    JOIN cluster4_line_targets t ON t.id = s.line_target_id
    JOIN cluster4_lines l ON l.id = t.line_id
    WHERE s.user_id = :user_id
      AND t.week_id = :week_id
      AND t.target_mode = 'user'
      AND l.part_type = 'experience'
      AND l.is_active = true

STEP 2: status 결정
  IF experienceSubmissions >= 1:
    → status = 'success'
  ELSE:
    → status = 'fail'

명확화:
  - 다른 part_type (info / ability / career) 제출 여부는 status 결정에 영향 없음
  - 한 주차에 실무 경험 라인이 N개 배정되었을 때, "최소 1개 제출"이 success 기준인지
    "전부 제출" 기준인지는 운영 정책 결정 필요 (§15-2 미결 #1)
  - 본 설계는 최소 1개 기준을 기본값으로 상정하되, 정책으로 확장 가능한 구조 유지
```

### 4-4. (폐기됨) 실무 경험 라인 미배정 주차의 처리

**rev.3 정정**: 본 섹션은 폐기된다. 모든 주차에 실무 경험 라인이 반드시 배정된다는 전제로, U1~U5 정책 분기 자체가 불필요하다.

데이터 무결성 가드 (예외 발생 시 대응):
- 만약 운영 중 실무 경험 라인이 0개인 주차가 발견되면, 그것은 **운영 정책 위반(데이터 오류)**으로 간주한다.
- 평가 함수는 이 상황을 **에러로 처리**하고 로그를 남긴다. status를 임의로 결정하지 않는다.
- 관리자가 라인을 배정하면 lazy 보정으로 재평가된다.

### 4-5. 다른 허브의 역할

success/fail에 직접 영향 없는 허브들의 평가 시점 역할:

| 허브 | part_type | success/fail 영향 | 포인트 영향 | 카드 표시 |
|------|-----------|------------------|------------|----------|
| 실무 정보 | `info` | 없음 | 미확정 (§6) | k 지표에 반영 |
| 실무 역량 | `ability`(`competency`) | 없음 | 미확정 (§6) | k 지표에 반영 |
| 실무 경험 | `experience` | **핵심 조건** | 평가 점수 그대로 (§6) | k 지표에 반영 |
| 실무 경력 | `career` | 없음 | 평가 점수 그대로 (§6) | k 지표에 반영 |

### 4-6. 운영 정책 명시 필요 사항 (rev.3 정정)

본 설계는 기술 구조만 정의하며, 다음은 **별도 의사결정 필요** (§15-2 통합 관리):
1. 실무 경험 라인 다중 배정 시 "최소 1개 제출" vs "전부 제출" 기준
2. 실무 정보 / 실무 역량 허브의 포인트 부여 여부

(rev.3에서 폐기된 항목: 실무 경험 라인 미배정 주차의 처리, 대상자 플래그 추가)

---

## 5. 분석 4 — 여러 라인 존재 시 주차 status 결정 규칙

### 5-1. 현실의 데이터 구조

```
한 사용자의 한 주차에 가능한 라인 수 (현재 시스템):

  info:        N (admin이 배정한 만큼, fetchInfoLineCountsByWeek)
  ability:     1 (ABILITY_AVAILABLE 상수, lineAvailability.ts:13)
  experience:  2 (getExperienceAvailable, oranke/encre/phalanx 모두 2)
  career:      0~5 (career_project_weeks 기반, CAREER_DISPLAY_CAP=5)

  총 배정 라인 = N + 1 + 2 + career_count
```

### 5-2. 판정 시 고려 사항 (rev.3 정정)

| 사항 | 결정 |
|------|------|
| career 포함 여부 | **포함** (포인트 산출 대상). status 결정에는 직접 영향 없음 (§4-3) |
| status 결정의 핵심 입력 | **실무 경험(`experience`) 라인 제출 여부** (라인은 반드시 배정됨) |
| 비활성 라인 처리 | `is_active=false` 라인은 배정에서 제외 |
| 라인 마감이 주차 종료보다 늦은 경우 | 운영 정책으로 차단 (§3-2 참조) |
| target_mode='rule' 라인 | Phase 1 미지원 — 평가에서 제외 |
| 실무 경험 라인 0개 주차 | **발생 안 함 (운영 전제)**. 발생 시 데이터 오류로 처리 (§4-4) |

### 5-3. 권장 평가 함수 의사 시그니처 (rev.3 정정 — 단순화)

```
function evaluateWeekStatus(userId, weekId):
  // 우선순위 1: official_rest
  if isOfficialRest(weekId) and not hasOverride(userId, weekId):
    return { status: 'official_rest', points: 0, ... }
  
  // 우선순위 2: personal_rest
  if isPersonalRest(userId, weekId):
    return { status: 'personal_rest', points: 0, ... }
  
  // 우선순위 3: 실무 경험 참여 기반 판정
  experienceSubmissions = countExperienceSubmissions(userId, weekId)
  
  status = experienceSubmissions >= 1 ? 'success' : 'fail'
  
  // 포인트 산출은 §6 별도 함수로 위임 (status와 독립)
  points = computeWeeklyPoints(userId, weekId)
  
  return {
    status,
    points: points.points,
    advantages: points.advantages,
    penalty: points.penalty,
  }
```

**핵심**:
- status 결정과 포인트 산출은 **분리된 함수**다. status는 실무 경험 참여만 보고, 포인트는 모든 평가 점수의 합이다 (§6).
- skip 분기는 rev.3에서 폐기되었다. 모든 주차는 반드시 4개 status 중 하나로 결정된다.

---

## 6. 분석 5 — cluster4_line_submissions → user_weekly_points 포인트 산출 규칙 (정정)

### 6-1. 현재 포인트 체계

**weekly_points 구조** (`2026-05-25_club_rank_weekly_points.sql:16-71`):
- `points`: 별 (j) — 양수
- `advantages`: 원시 방패 (k0) — 양수
- `penalty`: 번개 (l) — 양수 저장, 사용 시 ABS()

**현재 시드 규칙** (`sql:108-134`): status 기반 의사난수 분배 (운영 정책 아님, 시연용)

**누적 변환** (`2026-05-28_cumulative_points_auto_sync.sql:89-101`):
- `total_stars = SUM(points)`
- `total_raw_advantages = SUM(advantages)`
- `total_lightnings = SUM(penalty)`
- `total_shields = total_raw_advantages - ABS(total_lightnings)`

### 6-2. 포인트 산출 원칙 (정정)

**핵심 원칙**: 포인트는 status 기반 보너스가 아니라 **관리자가 부여한 평가 점수의 1:1 합산**이다.

```
주차 포인트 = SUM(해당 주차의 모든 평가 점수)

평가 점수의 소스는 허브별로 분리:

  실무 경험 (experience)  → cluster4_experience_line_evaluations.rating  (0~10)
  실무 경력 (career)      → career_records.grade_points                 (2/4/6/8/10)
  실무 정보 (info)        → 평가 점수 컬럼 없음 (현재 0 처리, 향후 확정)
  실무 역량 (competency)  → 평가 점수 컬럼 없음 (현재 0 처리, 향후 확정)
```

**1:1 매핑 정책 근거**:
- `2026-05-27_cluster4_experience_phase1.sql:19-21`에 명시:
  > "points 컬럼 없음. points = rating (1:1 계산값)"
- `career_records.grade_points`도 동일 의미 (이미 정수 점수로 저장)

### 6-3. 평가 점수 저장 위치 매핑

| 허브 | part_type | 점수 컬럼 | 부여 주체 | 부여 시점 | 범위 |
|------|-----------|----------|----------|----------|------|
| 실무 경험 | `experience` | `cluster4_experience_line_evaluations.rating` | admin | 제출 후 평가 시점 | 0~10 (정수) |
| 실무 경력 | `career` | `career_records.grade_points` | admin | 제출 후 평가 시점 | 2/4/6/8/10 (등급 매핑) |
| 실무 정보 | `info` | 없음 | — | — | 0 (잠정) |
| 실무 역량 | `competency` | 없음 | — | — | 0 (잠정) |

**career 등급 ↔ grade_points 매핑** (`careerRecordsTypes.ts:59-67`):
- S → 10
- A → 8
- B → 6
- C → 4
- D → 2

(매핑 함수는 별도 정책 — admin UI가 grade를 선택하면 grade_points 자동 채움, 또는 admin이 grade_points 직접 입력. 본 설계는 컬럼만 사용.)

### 6-4. 포인트 산출 함수 의사 시그니처

```
function computeWeeklyPoints(userId, weekId):
  // 1. 실무 경험 평가 점수 합계
  experiencePoints = SELECT COALESCE(SUM(e.rating), 0)
    FROM cluster4_experience_line_evaluations e
    JOIN cluster4_line_targets t ON t.id = e.line_target_id
    WHERE e.user_id = :userId
      AND t.week_id = :weekId

  // 2. 실무 경력 평가 점수 합계
  careerPoints = SELECT COALESCE(SUM(grade_points), 0)
    FROM career_records
    WHERE user_id = :userId
      AND week_id = :weekId
      AND grade_points IS NOT NULL

  // 3. 실무 정보 / 실무 역량 — 현재 0
  infoPoints = 0      // §15-2 미결 #3
  abilityPoints = 0   // §15-2 미결 #3

  return {
    points: experiencePoints + careerPoints + infoPoints + abilityPoints,
    advantages: 0,  // 별도 정책 — 본 설계 범위 밖 (§6-6)
    penalty: 0,     // 별도 정책 — 본 설계 범위 밖 (§6-6)
  }
```

**핵심**:
- `user_weekly_points.points` ← 모든 허브 평가 점수의 단순 합
- `cluster4_line_submissions` 자체는 점수를 가지지 않음. 제출 사실은 평가의 전제일 뿐.
- 평가 미부여 (admin이 아직 채점 안 함) → 해당 라인 점수 = 0 (해당 row 미존재 또는 NULL)

### 6-5. status와 포인트의 관계

```
status = 'success' AND points = 0 인 경우:
  → 가능. 실무 경험 제출 완료 + admin이 0점 부여한 경우
  → 또는 실무 경험 제출 후 admin 미평가 (평가 대기) — points는 미평가 시 0

status = 'fail' AND points > 0 인 경우:
  → 가능. 실무 경험 미제출(=fail)이지만 실무 경력 등 다른 허브에서 평가 점수 받은 경우
  → 본 설계는 이를 허용 (status와 포인트는 독립)

status = 'personal_rest' OR 'official_rest':
  → 평가 점수 자체가 발생하지 않으므로 points = 0 (보장됨)
  → 단, 휴식 주차에 평가 row가 잘못 들어간 경우는 0으로 강제하는 가드 필요
```

### 6-6. advantages / penalty 처리 (본 설계 범위 외)

현재 시드에서 사용된 `advantages`(방패)와 `penalty`(번개)는 **본 설계에서 산출 규칙을 정의하지 않는다**. 이유:
- 사용자가 정정한 정책 범위가 `points`에 한정됨
- advantages/penalty는 누적 시 stars/shields/lightnings에 영향을 주는 별도 영역
- 평가 점수 기반 산출 정책이 아직 명시되지 않음

**잠정 처리**: 본 설계의 평가 함수는 `advantages = 0`, `penalty = 0`으로 채운다. 별도 정책 도입 전까지 시드 외 데이터는 advantages/penalty가 0이 됨.

**향후 별도 설계 필요 항목** (§15-2 미결 #4):
- advantages 부여 정책 (성과 보너스? 멀티 허브 참여 보상?)
- penalty 부여 정책 (미참여 페널티? 마감 임박 제출?)
- 위 두 항목 도입 시 cluster4_experience_line_evaluations 등에 컬럼 추가 필요할 수 있음

### 6-7. 정합성 보장 필요 사항 (정정)

1. **`total_shields = total_raw_advantages - ABS(total_lightnings)` 음수 방지**
   - 본 설계 잠정 (advantages=0, penalty=0)에서는 자동 0 유지
   - 향후 advantages/penalty 정책 도입 시 floor 정책 재검토
2. **현재 시드 데이터(120행)와의 격차**
   - 시드는 의사난수 분배, 본 설계는 평가 점수 기반
   - 시드 사용자에 대한 backfill 정책 필요 (본 설계 범위 밖)
3. **포인트 산출 함수는 status 평가 함수와 분리**
   - status 결정 (실무 경험 참여만) → 포인트 산출 (전 허브 평가 점수 합)
   - 두 함수는 독립적으로 호출 가능, 결과를 동일 트랜잭션에서 UPSERT

### 6-8. 미결 사항 (의사결정 필요)

본 설계는 산출 구조만 제시하며, **실제 정책은 별도 결정** (§15-2 통합):
- 실무 정보 / 실무 역량 포인트 부여 여부 및 저장 컬럼
- advantages / penalty 산출 규칙 (또는 deprecate 결정)
- 평가 미부여(admin 미채점) 상태의 user_weekly_points 처리
  - 잠정: points=0으로 즉시 기록 → 평가 완료 시 update
  - 대안: 평가 완료 전까지 user_weekly_points 행 미생성
- 시드 데이터 마이그레이션 정책
- career 평가 grade↔grade_points 매핑 자동 강제 여부

---

## 7. 분석 6 — approved_weeks / cumulative_weeks 자동 sync 연동

### 7-1. 1차 감사 결론 재확인

`source-of-truth-audit-20260528.md` §2단계에서 다음 결론:
- **A안** (실시간 COUNT): 매 조회마다 쿼리, 성능 부담
- **B안** (저장값 + 트리거): user_cumulative_points 패턴 복제 → 권장

본 설계는 **B안** 채택을 전제로 진행한다.

### 7-2. 트리거 구조 (개념)

```
함수: sync_growth_stats_for_user(p_user_id uuid)
  RETURNS void
  
  내부 로직:
    SELECT
      COUNT(*) FILTER (WHERE status = 'success') AS approved,
      COUNT(*) AS cumulative
    INTO v_approved, v_cumulative
    FROM user_week_statuses
    WHERE user_id = p_user_id;
    
    INSERT INTO user_growth_stats (user_id, approved_weeks, cumulative_weeks)
    VALUES (p_user_id, v_approved, v_cumulative)
    ON CONFLICT (user_id) DO UPDATE
      SET approved_weeks = EXCLUDED.approved_weeks,
          cumulative_weeks = EXCLUDED.cumulative_weeks,
          updated_at = now();

트리거: sync_growth_on_week_status_change
  AFTER INSERT OR UPDATE OR DELETE ON user_week_statuses
  FOR EACH ROW
  EXECUTE FUNCTION trigger_sync_growth_stats()
  // trigger_sync_growth_stats가 NEW.user_id 또는 OLD.user_id로 sync_growth_stats_for_user 호출
```

### 7-3. 본 설계와의 연동

```
[평가 함수 실행 흐름]

evaluateWeekStatus(userId, weekId)
  → status 결정
  → UPSERT user_week_statuses (status, ...)
       ↓ (트리거 발동, 자동)
       sync_growth_stats_for_user(userId)
       → UPDATE user_growth_stats
  → 별도로 user_weekly_points UPSERT (status 기반 포인트)
       ↓ (기존 트리거 발동, 자동)
       sync_cumulative_points_for_user(userId)
       → UPDATE user_cumulative_points
```

**핵심**: 평가 함수는 user_week_statuses와 user_weekly_points 두 곳에만 쓰고, 나머지는 트리거가 처리.

### 7-4. 트리거 순서 보장

두 트리거(growth_stats, cumulative_points)는 **독립적**이며 순서 무관:
- user_week_statuses 변경 → growth_stats 트리거
- user_weekly_points 변경 → cumulative_points 트리거

평가 함수 내에서 두 INSERT/UPSERT의 순서는 무관하지만, **트랜잭션 1개 내**에서 실행되어야 한다 (둘 다 성공 or 둘 다 실패).

---

## 8. 분석 7 — 시즌 성공률 (n) 계산 반영 방식 (정정)

### 8-1. 현재 계산 방식

**Growth Summary** (`cluster4WeeklyGrowthData.ts:218-236`):
```typescript
let approvedWeeks = 0, failedWeeks = 0, restWeeks = 0;
for (const w of weeks) {
  switch (w.status) {
    case "success": approvedWeeks++; break;
    case "fail": failedWeeks++; break;
    case "personal_rest": restWeeks++; break;
  }
}
const availableWeeks = approvedWeeks + failedWeeks + restWeeks;
```

→ **실시간 COUNT**, 시즌 구분 없음, user_week_statuses에서 직접 집계

**Season Growth Rate** (`cluster4WeeklyGrowthData.ts:641-661`):
```typescript
s.completed += c.weeklyGrowth.completedLines;
s.available += c.weeklyGrowth.availableLines;
return { rate: ceilGrowthRate(v.completed, v.available) };
```

→ 라인 단위 완료/배정 비율 집계 (status 무관)

### 8-2. 두 지표의 분리 (정정)

**중요**: 본 정정에서 두 지표의 의미를 명확히 분리한다.

**주차 성장률 k (정정)**:
- 의미: 해당 주차의 **수행률 지표** (단순 비율)
- 공식: `k = ceil((완료 라인 수 / 배정 라인 수) × 100)`
- **success/fail 판정에 사용하지 않음** (rev.1의 P2/F4 폐기에 따라)
- 카드 표시용, 사용자 동기부여용 지표
- 함수: `ceilGrowthRate()` (`lib/lineAvailability.ts:100-102`) 그대로 활용

**시즌 성공률 n (정정)**:
- 의미: 시즌 내 성공 주차 비율
- 공식: `n = COUNT(status='success') / COUNT(status IN ('success','fail','personal_rest'))`
- status 기반 (k 무관)
- status 결정 규칙은 §4-3 (실무 경험 참여 여부)

**두 지표는 서로 다른 차원**:
- k는 "이번 주에 얼마나 했나" (활동 양)
- n은 "시즌 동안 성공한 주가 몇 주인가" (성공 빈도)
- k가 높아도 실무 경험 미참여면 status='fail' → n 감소
- k가 낮아도 실무 경험만 참여하면 status='success' → n 증가

### 8-3. 시즌 라인 충족율 (보조 지표)

기존 `computeSeasonGrowthRates()`는 시즌 내 모든 주차의 라인 충족율을 집계한 보조 지표다:
```
seasonGrowthRate = ceil(Σ(week.completedLines) / Σ(week.availableLines) × 100)
```

이는 시즌 성공률 n과는 **다른 지표**다:
- seasonGrowthRate: 시즌 전체 라인 단위 수행률
- seasonSuccessRate (n): 시즌 전체 주차 단위 성공률

**두 지표 모두 유지 권장**:
- 사용자 카드: 시즌별 k 평균 또는 seasonGrowthRate 표시
- Resume Card: n (시즌 성공률) 표시

### 8-4. 코드 변경 영향 (정정)

본 설계 채택 시:
- `cluster4WeeklyGrowthData.ts:218-236` — 그대로 유지 (실시간 status COUNT)
- `cluster4WeeklyGrowthData.ts:586-596` — 그대로 유지 (k 계산은 라인 충족율로 일관)
- `cluster4WeeklyGrowthData.ts:641-661` — 그대로 유지 (seasonGrowthRate)
- **추가 권장**: seasonSuccessRate (n) 필드를 GrowthSummary에 명시적으로 노출
- 라인 완료 카운트의 SoT 전환 (user_activity_details → cluster4_line_submissions)은 Phase B (§10-2)

평가 함수가 user_week_statuses를 정확히 갱신하면, 위 함수들은 별도 변경 없이 정합성 확보된다. k와 n이 의미상 분리되어 있으므로 한쪽이 다른 쪽을 결정하지 않는다.

---

## 9. 분석 8 — Resume Card 활동 완료율 반영 방식

### 9-1. 현재 Resume Card 구조

**핵심 필드** (`adminResumeCardData.ts:147-153`):
```typescript
computed: {
  approvedWeeks: growth?.approved_weeks ?? crew.approvedWeeks ?? null,
  cumulativeWeeks: growth?.cumulative_weeks ?? crew.cumulativeWeeks ?? null,
  totalStars: points?.total_stars ?? null,
  totalShields: points?.total_shields ?? null,
  totalLightnings: points?.total_lightnings ?? null,
}
```

→ 모두 **저장값 기반** (user_growth_stats, user_cumulative_points)

**활동 완료율** (`cluster1ResumeData.ts:161` 영역):
- `user_activity_details` 기반 (현재)
- 일부 official_rest 필터링

### 9-2. cluster4 통합 후 Resume Card 갱신 경로

```
평가 함수 실행
  → user_week_statuses UPSERT
       → 트리거: user_growth_stats 자동 갱신
            → Resume Card.computed.approvedWeeks 자동 반영 (다음 조회 시)
  → user_weekly_points UPSERT
       → 트리거: user_cumulative_points 자동 갱신
            → Resume Card.computed.totalStars/Shields/Lightnings 자동 반영
```

→ **Resume Card는 별도 변경 불필요**. 저장값을 읽는 구조이므로 트리거가 정합성 보장.

### 9-3. 활동 완료율 (별도 지표) 처리

`cluster1ResumeData.ts`의 활동 완료율은 현재 `user_activity_details` 기반이다. 본 설계는:
- **단기 (Phase 1)**: 기존 user_activity_details 경로 유지 (변경 없음)
- **장기 (Phase 3+)**: cluster4_line_submissions 기반 충족율로 대체 가능
- 단, **user_activity_details 제거는 불가** (9-4 참조)

---

## 10. 분석 9 — user_activity_details (legacy) 제거 가능 여부

### 10-1. 결론: **제거 불가**

근거:
1. **기존 PUT /api/activity-details 경로 운영 중**
   - 기존 sync bridge final design §3에 명시
   - 양방향 쓰기 충돌 방지를 위해 동기화 대상에서 제외됨
2. **2차 정보(sub_title, growth_point, images, rating)의 SoT**
   - cluster4_line_submissions는 1차 제출 정보만 보유 (subtitle, output_links)
   - growth_point, images, rating은 user_activity_details에만 존재
3. **Weekly Cards 라인 카운트의 현재 소스**
   - `cluster4WeeklyGrowthData.ts:457-491`에서 user_activity_details를 라인 분류 카운트로 사용
   - cluster4_line_submissions 기반으로 대체하려면 광범위한 코드 변경 필요

### 10-2. 단계적 마이그레이션 경로 (장기, 본 설계 밖)

```
Phase A (현재): user_activity_details = 2차 정보 + 카운트 SoT
Phase B (중기): cluster4_line_submissions = 제출 사실, user_activity_details = 2차 정보 (분리 명확화)
Phase C (장기): user_activity_details 2차 정보를 cluster4_line_submissions에 통합 → user_activity_details 제거
```

본 설계는 **Phase A→B 전환**에 집중하며, Phase C는 별도 설계 필요.

### 10-3. 본 설계의 user_activity_details 처리 방침

```
본 설계 평가 함수는 user_activity_details를 읽거나 쓰지 않는다.

평가 함수 입력: cluster4_line_targets, cluster4_line_submissions, weeks, user_week_statuses
평가 함수 출력: user_week_statuses, user_weekly_points

→ user_activity_details는 별도 경로로 계속 운영 (변경 없음)
→ Weekly Cards의 라인 카운트 표시는 user_activity_details 기반 (기존 동작 유지)
→ cluster4 도입 후에도 두 소스가 공존, 점진적으로 SoT를 cluster4로 이동
```

---

## 11. 분석 10 — Trigger / Cron / API 중 적절한 방식

### 11-1. 비교 매트릭스

| 방식 | 적용 범위 | 장점 | 단점 | 리스크 |
|------|----------|------|------|--------|
| **DB Trigger** | INSERT/UPDATE 즉시 | 누락 없음, 자동 | SQL 함수 복잡도, 디버깅 어려움 | 트랜잭션 비용, 순환 트리거 |
| **Cron (Scheduled)** | 정기 일괄 | 일관된 시점, 부하 분산 | 인프라(스케줄러) 필요, 지연 | 누락된 사용자 발생 가능 |
| **Edge Function** | 이벤트 + 스케줄 | 유연성, 디버깅 용이 | Supabase Edge 종속, cold start | 호출 누락 |
| **API Server Action** | 명시적 호출 | 단순, 통제 가능 | 호출 누락 위험 | 잊으면 영원히 미반영 |

### 11-2. 본 설계의 책임 분리

```
[책임 1] 주차 평가 (status 결정 + points 산출)
  → 권장: Cron (주차 종료 다음날 KST 00:00)
  + Lazy 보정 (API 조회 시점 결손 발견 → inline 실행)
  근거: 시간 의존 작업, 인프라가 적절

[책임 2] user_week_statuses → user_growth_stats 동기화
  → 권장: DB Trigger
  근거: user_weekly_points → user_cumulative_points 트리거와 일관, 검증된 패턴

[책임 3] user_weekly_points → user_cumulative_points 동기화
  → 기존 Trigger 유지 (sync_cumulative_on_weekly_change)

[책임 4] cluster4 라인 → weekly_activities 동기화
  → 기존 설계 (API call) 유지 (cluster4-sync-bridge-final-design.md §4)

[책임 5] cluster4 제출 → activity_records 동기화
  → 기존 설계 (API call) 유지
```

### 11-3. Cron + Lazy 보정 패턴 상세

```
주차 평가 cron 작업:
  실행 주기: 매일 KST 00:30
  대상: weeks.end_date == (today - 1day) 인 주차의 모든 활성 사용자
  
  의사 코드:
    for each week where end_date = yesterday:
      for each active user (user_profiles.growth_status='active'):
        if no user_week_statuses row exists for (user_id, year, week_number):
          evaluateAndPersistWeekStatus(user_id, week_id)
    
  멱등성: 이미 행이 존재하면 skip (덮어쓰지 않음)
  관리자 재평가: 별도 API "force re-evaluate" 제공

Lazy 보정 (Weekly Cards 조회 시):
  cluster4WeeklyGrowthData.ts에서 user_week_statuses 조회 결과 분석
  → 과거 주차인데 status가 비어있는 행 발견 시
  → evaluateAndPersistWeekStatus(user_id, week_id) 인라인 실행
  → 결과를 응답에 반영
  
  성능 보호: 한 응답당 최대 N개 보정 (예: 3개), 초과 시 경고 로그 + skip
```

### 11-4. Trigger 위치 정리

```
DB 레벨 (새로 추가):
  AFTER INSERT/UPDATE/DELETE ON user_week_statuses
    → sync_growth_stats_for_user(user_id)
    → UPDATE user_growth_stats

DB 레벨 (기존 유지):
  AFTER INSERT/UPDATE/DELETE ON user_weekly_points
    → sync_cumulative_points_for_user(user_id)
    → UPDATE user_cumulative_points

App 레벨 (cron + lazy):
  evaluateAndPersistWeekStatus(user_id, week_id)
    → 평가 → UPSERT user_week_statuses → UPSERT user_weekly_points
    → (두 UPSERT가 각자의 DB 트리거를 발동시킴)

App 레벨 (제출 시점):
  createCluster4LineSubmissionForAuthUser() 후
    → 기존: syncSubmissionToActivityRecord() (legacy)
    → 본 설계: user_week_statuses는 갱신 안 함 (주차 종료 시 평가)
    → 단, 강화 상태 즉시 반영은 activity_records 기반 (기존 경로)
```

---

## 12. 통합 흐름도

### 12-1. T0~T_end 전체 라이프사이클

```
T0: 라인 개설 (admin)
  cluster4_lines + cluster4_line_targets INSERT
  → 기존 sync: weekly_activities UPSERT
  → 본 설계: user_week_statuses 영향 없음

T1: 사용자 모달 열기 + 2차 정보 입력
  user_activity_details UPSERT (기존 경로)
  → 본 설계: 영향 없음

T2: 사용자 제출
  cluster4_line_submissions INSERT
  → 기존 sync: activity_records.is_completed = true
  → 본 설계: user_week_statuses 영향 없음 (아직)

T3: 강화 상태 (N+1 목 12:01)
  프론트 자동 전환 (시간 계산)
  → 본 설계: 영향 없음

T_eval: admin 평가 입력 (제출 후 임의 시점)
  실무 경험: cluster4_experience_line_evaluations INSERT/UPDATE (rating: 0~10)
  실무 경력: career_records.grade_points UPDATE (2/4/6/8/10)
  실무 정보/역량: 평가 컬럼 없음 (현재 0)
  → 본 설계: user_week_statuses 영향 없음 (T_end 평가 시 점수 합산)
  → 옵션: 실시간 user_weekly_points 갱신 트리거 (별도 결정)

T_end: 주차 종료 다음날 KST 00:30 ★ 본 설계 추가
  Cron 실행
    → evaluateWeekStatus(user, week)
         status = 실무 경험 참여 여부 (§4-3)
    → computeWeeklyPoints(user, week)
         points = SUM(experience.rating) + SUM(career.grade_points) + 0 + 0
    → UPSERT user_week_statuses (status='success'|'fail'|'personal_rest'|'official_rest')
         ↓ (트리거)
         user_growth_stats UPDATE (approved_weeks, cumulative_weeks)
    → UPSERT user_weekly_points (points, advantages=0, penalty=0)
         ↓ (트리거)
         user_cumulative_points UPDATE (stars, shields, lightnings)
  
T_view: 사용자/관리자 조회
  Weekly Cards: user_week_statuses 직접 조회 (이미 트리거로 정합)
  Growth Summary: user_week_statuses COUNT (실시간)
  Resume Card: user_growth_stats + user_cumulative_points (저장값)
  
  결손 발견 시: lazy 보정 (T_end 평가를 즉시 실행)
```

### 12-2. 데이터 흐름 다이어그램

```
┌────────────────────────────────────────────────────────────────┐
│ Admin & User Actions                                            │
├────────────────────────────────────────────────────────────────┤
│ admin: cluster4_lines + cluster4_line_targets                  │
│ user:  cluster4_line_submissions                               │
│ user:  user_activity_details (별도 경로, 영향 없음)            │
│ admin: cluster4_experience_line_evaluations (rating 0~10)      │
│ admin: career_records.grade_points (2/4/6/8/10)                │
└────────────────────────────────────────────────────────────────┘
                            │
                            │ (주차 종료 + 1day 00:30 KST)
                            ▼
┌────────────────────────────────────────────────────────────────┐
│ Cron: evaluateWeekStatus() + computeWeeklyPoints()              │
├────────────────────────────────────────────────────────────────┤
│ status 결정 inputs:                                              │
│   cluster4_line_targets (user 모드, part_type='experience')     │
│   cluster4_line_submissions (experience 라인 제출 여부)          │
│   weeks (is_official_rest)                                      │
│   user_season_statuses                                          │
│                                                                 │
│ points 산출 inputs:                                              │
│   cluster4_experience_line_evaluations.rating                   │
│   career_records.grade_points                                   │
│   (info / competency 평가 컬럼 — 현재 없음, 0 처리)             │
│                                                                 │
│ outputs:                                                        │
│   UPSERT user_week_statuses (status)                            │
│   UPSERT user_weekly_points (points = SUM(평가 점수),            │
│                              advantages=0, penalty=0)            │
└────────────────────────────────────────────────────────────────┘
                            │
                  ┌─────────┴──────────┐
                  ▼                    ▼
   ┌─────────────────────┐  ┌─────────────────────┐
   │ Trigger (신규)      │  │ Trigger (기존)      │
   │ sync_growth_stats   │  │ sync_cumulative_pts │
   ├─────────────────────┤  ├─────────────────────┤
   │ UPDATE              │  │ UPDATE              │
   │ user_growth_stats   │  │ user_cumulative_pts │
   │ (approved_weeks,    │  │ (total_stars,       │
   │  cumulative_weeks)  │  │  total_shields,     │
   │                     │  │  total_lightnings)  │
   └─────────────────────┘  └─────────────────────┘
                  │                    │
                  └─────────┬──────────┘
                            ▼
┌────────────────────────────────────────────────────────────────┐
│ Read Consumers (변경 없음)                                       │
├────────────────────────────────────────────────────────────────┤
│ Weekly Cards     ← user_week_statuses (실시간)                  │
│ Growth Summary   ← user_week_statuses (실시간 COUNT)            │
│ Season Rate      ← user_week_statuses (status별 집계)           │
│ Resume Card      ← user_growth_stats + user_cumulative_points   │
│ Club Rank        ← user_weekly_points (weekly_score 계산)       │
│ Crew DTO         ← user_growth_stats                            │
└────────────────────────────────────────────────────────────────┘
```

---

## 13. SoT 최종 매핑 (본 설계 적용 후 — 정정)

```
┌─────────────────────────────────┬──────────────────────────────────────┐
│ 도메인                          │ Source of Truth                       │
├─────────────────────────────────┼──────────────────────────────────────┤
│ 라인 개설 정보                  │ cluster4_lines                       │
│ 주차 배정/대상                  │ cluster4_line_targets                │
│ 제출 사실                       │ cluster4_line_submissions            │
│ 사용자 2차 정보                 │ user_activity_details (기존)         │
│ 경력 프로젝트 메타              │ career_projects + ...                │
│                                 │                                      │
│ ★ 실무 경험 평가 점수           │ cluster4_experience_line_evaluations │
│   (admin 부여, 0~10)            │   .rating                            │
│                                 │                                      │
│ ★ 실무 경력 평가 점수           │ career_records.grade_points          │
│   (admin 부여, 2/4/6/8/10)      │   (등급 표시: career_records.grade)  │
│                                 │                                      │
│ ★ 실무 정보 평가 점수           │ (현재 컬럼 없음, 0 처리)              │
│ ★ 실무 역량 평가 점수           │ (현재 컬럼 없음, 0 처리)              │
│                                 │                                      │
│ ★ 주차 status (success/fail)    │ user_week_statuses                   │
│   결정 기준                     │   ← 실무 경험 라인 참여 여부 (§4-3)   │
│                                 │     evaluateWeekStatus() 결과         │
│                                 │                                      │
│ ★ 주간 포인트 (points)          │ user_weekly_points                   │
│   산출 기준                     │   ← SUM(experience.rating) +         │
│                                 │     SUM(career.grade_points) +       │
│                                 │     0 (info) + 0 (competency)        │
│                                 │     computeWeeklyPoints() 결과        │
│                                 │                                      │
│ ★ approved/cumulative_weeks     │ user_growth_stats                    │
│                                 │   ← user_week_statuses 트리거         │
│                                 │                                      │
│ ★ 누적 포인트                   │ user_cumulative_points               │
│                                 │   ← user_weekly_points 트리거         │
│                                 │                                      │
│ 주차 성장률 k (수행률 지표)     │ 실시간 계산 (lib/lineAvailability)    │
│                                 │   = ceil(완료/배정 × 100)             │
│                                 │   ※ status 결정과 무관               │
│                                 │                                      │
│ 시즌 성공률 n                    │ user_week_statuses (status COUNT)    │
│                                 │   = COUNT(status='success') /        │
│                                 │     COUNT(status IN ('success',      │
│                                 │     'fail', 'personal_rest'))        │
│                                 │                                      │
│ 공식 휴식주 (글로벌)            │ weeks.is_official_rest               │
│ 공식 휴식 예외 (개인)           │ user_week_statuses                   │
│                                 │   .is_official_rest_override         │
│ 시즌 휴식                       │ user_season_statuses                 │
└─────────────────────────────────┴──────────────────────────────────────┘

레거시 프로젝션 (기존 sync bridge — 변경 없음):
  weekly_activities  ← syncLineToWeeklyActivity()
  activity_records   ← syncSubmissionToActivityRecord()
```

---

## 14. 책임 분리 명세 (정정)

| 컴포넌트 | 책임 | 비책임 |
|---------|------|--------|
| `evaluateWeekStatus()` 함수 | status 결정 (실무 경험 참여 여부) | 포인트 산출, 평가 점수 부여 |
| `computeWeeklyPoints()` 함수 | 평가 점수 SUM → points 산출 | status 결정, 평가 점수 부여 |
| `evaluateAndPersist...()` 래퍼 | 위 두 결과를 트랜잭션으로 UPSERT | growth_stats/cumulative_points 직접 갱신 |
| admin 평가 UI (별도) | rating/grade_points 부여 | status / points 계산 |
| `sync_growth_stats_*` 트리거 | user_week_statuses → user_growth_stats | status 결정 |
| `sync_cumulative_points_*` 트리거 | user_weekly_points → user_cumulative_points | points 산출 |
| Cron 작업 | 주차 종료 후 일괄 평가 실행 | 사용자 단위 호출 라우팅 |
| Lazy 보정 (API) | 조회 시 결손 발견 → 평가 인라인 실행 | 정기 일괄 처리 |
| Weekly Cards | user_week_statuses 표시 + k 계산 | status 계산 |
| Resume Card | user_growth_stats + user_cumulative_points 표시 | 집계 |
| 기존 sync bridge | 라인/제출 → legacy 동기화 | growth 도메인 |
| user_activity_details API | 2차 정보 관리 | 1차 제출 사실 |
| `cluster4_experience_line_evaluations` | 실무 경험 평가 점수 저장 (admin) | 자동 산출 |
| `career_records.grade_points` | 실무 경력 평가 점수 저장 (admin) | 자동 산출 |

---

## 15. 리스크 및 미결 사항 (정정)

### 15-1. 잔존 리스크 (rev.3 정정)

| # | 리스크 | 영향 | 완화 |
|---|--------|------|------|
| GR1 | Cron 누락 시 평가 지연 | approved_weeks stale | Lazy 보정 patch |
| GR2 | 실무 경험 라인 0개 주차 발생 (운영 전제 위반) | 평가 함수 에러 | 데이터 무결성 가드 + 알림 (§4-4) |
| GR3 | 실무 정보/역량 포인트 컬럼 부재 | 두 허브 평가 점수가 0으로 고정 | 운영 결정 시 컬럼 추가 (§15-2 #2) |
| GR4 | 1년 이상 과거 주차의 lazy 보정 비용 | 응답 지연 | per-request 보정 한도 |
| GR5 | 트리거 추가 시 INSERT 성능 영향 | 시드 작업 지연 | 시드 시 트리거 일시 비활성화 |
| GR6 | admin 미평가 상태의 user_weekly_points 처리 | 평가 전 points=0으로 노출 | T_eval 시점에 실시간 갱신 (별도 옵션) |
| GR7 | user_activity_details vs cluster4_line_submissions 카운트 불일치 | Weekly Cards 라인 카운트와 status 충돌 | Phase B 전환 명시 |
| GR8 | rule mode target Phase 1 미지원 | rule 배정 라인 평가 누락 | user mode만 평가 대상으로 명시 |
| GR9 | career grade ↔ grade_points 매핑 일관성 | grade=S인데 grade_points=4 등 데이터 오류 가능 | admin UI에서 자동 매핑 강제 권장 |
| GR10 | 실무 경험 라인 다중 배정 시 평가 기준 | 1개 평가만 받은 경우 status는 success인지 | §15-2 #1 결정 필요 |

### 15-2. 미결 사항 (의사결정 필요 — rev.3 정정)

```
[정책 결정 필요]
1. 실무 경험 라인 다중 배정 시 success 기준
   - "최소 1개 제출" vs "전부 제출" vs "임의 N개 이상"
   - 잠정: 최소 1개 제출
   
2. 실무 정보 / 실무 역량 포인트 부여 여부
   - 부여하지 않음 → 현재 구조 유지 (points=0)
   - 부여함 → cluster4_*_line_evaluations 유사 테이블 추가 필요
   
3. advantages / penalty 산출 규칙
   - 본 설계에서 0으로 잠정 처리
   - 향후 별도 정책 도입 시 평가 컬럼 추가 가능
   
4. admin 미평가 상태의 user_weekly_points 처리
   - 옵션 A: 평가 완료 전까지 user_weekly_points 행 미생성
   - 옵션 B: points=0으로 즉시 기록, 평가 후 update
   - 본 설계 잠정: 옵션 B (T_end 시점에 평가된 만큼만 합산)
   
5. 평가 점수가 T_end 이후 변경되는 경우 처리
   - 옵션 A: user_weekly_points 자동 재계산 트리거
   - 옵션 B: admin 재평가 시 별도 재계산 API 호출
   - 본 설계 잠정: 옵션 A 권장 (cluster4_experience_line_evaluations 변경 트리거)

[인프라 결정 필요]
6. Cron 실행 인프라 (Supabase Edge / GitHub Actions / 외부 스케줄러)
7. Lazy 보정의 per-request 한도 (3개? 5개?)
8. user_growth_stats 트리거의 기존 데이터 backfill 시점
9. Resume Card 활동 완료율의 cluster4_line_submissions 기반 전환 시점

[데이터 결정 필요]
10. 시드 데이터 마이그레이션 정책 (현재 의사난수 points → 평가 기반으로 어떻게 전환)
11. career grade ↔ grade_points 매핑 자동 강제 여부

(rev.3에서 폐기된 항목:
 - 실무 경험 라인 미배정 주차 처리 정책 — 미배정 주차 자체가 발생하지 않음
 - user_profiles 실무 경험 대상자 플래그 — 미배정 분기가 사라져 불필요)
```

### 15-3. 본 설계 범위 밖

- 실제 Migration SQL 작성
- 실제 함수 코드 작성
- 시드 데이터 backfill 스크립트
- Cron 인프라 설정
- E2E 테스트 시나리오

본 설계는 **구조와 책임 분리**까지만 정의하며, 실제 구현은 별도 단계에서 진행.

---

## 16. 권장 구현 순서 (참고용, 구현은 별도 단계)

```
Step 0: 의사결정 (운영팀)
  → §15-2 미결 사항 모두 결정

Step 1: 트리거 추가 (SQL)
  → sync_growth_stats_for_user 함수 + 트리거
  → 1차 감사 권장 사항 단독 적용 가능

Step 2: 평가 함수 설계 확정
  → evaluateWeekStatus() 시그니처
  → 포인트 산출 공식 확정

Step 3: 평가 함수 구현 (개별 사용자)
  → lib/cluster4WeekStatusEvaluator.ts (가칭)
  → 단위 테스트

Step 4: Lazy 보정 통합
  → cluster4WeeklyGrowthData.ts에 결손 감지 + 평가 호출

Step 5: 일괄 평가 함수 구현
  → 전체 사용자 × 주차 반복
  → 멱등성 보장

Step 6: Cron 인프라 연결
  → Supabase Edge Function 또는 외부 스케줄러
  → 매일 KST 00:30 실행

Step 7: 검증
  → 시드 데이터와 평가 결과 일치 확인
  → 기존 user_growth_stats 값과 비교
  → smoke test
```

---

## 17. 기존 설계와의 관계

```
cluster4-sync-bridge-final-design.md (2026-05-27)
  ├─ 다룬 영역: cluster4_lines/targets/submissions → weekly_activities + activity_records
  ├─ 트리거 시점: API 호출 동기 (즉시)
  └─ 목표: 강화 상태 즉시 가시화

cluster4-growth-sync-bridge-design-20260528.md (본 문서)
  ├─ 다룬 영역: cluster4_line_submissions → user_week_statuses → user_weekly_points → user_growth_stats → user_cumulative_points
  ├─ 트리거 시점: 주차 종료 후 Cron + Lazy 보정 + DB Trigger 조합
  └─ 목표: 성장 도메인(주차/포인트/누적) 자동 반영

source-of-truth-audit-20260528.md
  └─ 본 문서의 SoT 정의 근거
```

두 sync bridge 설계는 **상호 보완적**이며 충돌하지 않는다. 기존 설계는 라인/제출의 **즉시 가시화**(legacy 프로젝션), 본 설계는 **주차/성장 도메인 누적**을 담당한다.

---

## 부록 A — 평가 함수의 의사 시그니처 (정정)

```
// 본 설계의 핵심 함수 (구현 시 참조)

type WeekEvaluationInput = {
  userId: string;
  weekId: string;     // weeks.id
  year: number;       // weeks.iso_year or weeks.season_definitions.year
  weekNumber: number; // weeks.week_number
  seasonKey: string;  // weeks.season_key
};

// status 결정 결과 (rev.3 정정 — skip 제거, 4개 status로 확정)
type WeekStatusResult = {
  status: 'success' | 'fail' | 'personal_rest' | 'official_rest';
  reason:
    | 'official_rest'                  // §4-2 1순위
    | 'season_rest'                    // §4-2 2순위
    | 'experience_participated'        // 실무 경험 1개 이상 제출 → success
    | 'experience_not_participated';   // 실무 경험 제출 0 → fail
  experienceTargets: number;           // 배정된 실무 경험 라인 수 (>= 1 보장)
  experienceSubmissions: number;       // 제출된 실무 경험 라인 수
};

// 데이터 무결성 오류 (실무 경험 라인 0개 발견 시)
type WeekEvaluationError = {
  kind: 'no_experience_target';
  userId: string;
  weekId: string;
  message: string;
};

// 포인트 산출 결과 (평가 점수 SUM)
type WeeklyPointsResult = {
  points: number;        // SUM(rating) + SUM(grade_points) + 0 + 0
  advantages: number;    // 본 설계 잠정 0 (§6-6)
  penalty: number;       // 본 설계 잠정 0 (§6-6)
  breakdown: {
    experience: number;  // SUM(cluster4_experience_line_evaluations.rating)
    career: number;      // SUM(career_records.grade_points)
    info: number;        // 0 (현재 컬럼 없음)
    competency: number;  // 0 (현재 컬럼 없음)
  };
};

// 통합 결과
type WeekEvaluationResult = WeekStatusResult & {
  points: WeeklyPointsResult;
  // 표시용 (저장 안 함)
  kRate: number;  // §8-2 주차 성장률 = ceil(완료/배정 × 100), status 결정에는 무관
};

// status 결정만 (DB 쓰기 없음)
function evaluateWeekStatus(input: WeekEvaluationInput): Promise<WeekStatusResult>;

// 포인트 산출만 (DB 쓰기 없음)
function computeWeeklyPoints(input: WeekEvaluationInput): Promise<WeeklyPointsResult>;

// 두 함수 결합 (DB 쓰기 없음)
function evaluateWeek(input: WeekEvaluationInput): Promise<WeekEvaluationResult>;

// 평가 + 영구 저장 (UPSERT 2건, 트랜잭션)
function evaluateAndPersistWeek(input: WeekEvaluationInput): Promise<WeekEvaluationResult>;

// Cron 진입점 (rev.3 정정 — skipped 제거)
function batchEvaluateWeeksEndingOn(date: string): Promise<{
  evaluated: number;    // status 저장된 (user, week) 쌍 수
  errors: WeekEvaluationError[];  // 실무 경험 라인 0개 등 데이터 오류
}>;
```

### 부록 A-1. status 결정 의사 코드 (rev.3 정정)

```
evaluateWeekStatus(input):
  // 1순위: official_rest
  if isOfficialRest(weekId) and not hasOverride(userId, weekId):
    return { status: 'official_rest', reason: 'official_rest', ... }
  
  // 2순위: personal_rest
  if isSeasonRest(userId, seasonKey) or isManualPersonalRest(userId, weekId):
    return { status: 'personal_rest', reason: 'season_rest', ... }
  
  // 3순위: 실무 경험 참여 기반
  experienceTargets = SELECT count(*)
    FROM cluster4_line_targets t
    JOIN cluster4_lines l ON l.id = t.line_id
    WHERE t.target_user_id = userId
      AND t.week_id = weekId
      AND t.target_mode = 'user'
      AND l.part_type = 'experience'
      AND l.is_active = true
  
  // 데이터 무결성 가드 (rev.3): 운영 전제상 0개 발생 불가
  if experienceTargets == 0:
    throw new WeekEvaluationError({
      kind: 'no_experience_target',
      userId, weekId,
      message: 'Experience line target must be assigned for every user/week (operational invariant).',
    })
  
  experienceSubmissions = SELECT count(*)
    FROM cluster4_line_submissions s
    JOIN cluster4_line_targets t ON t.id = s.line_target_id
    JOIN cluster4_lines l ON l.id = t.line_id
    WHERE s.user_id = userId
      AND t.week_id = weekId
      AND l.part_type = 'experience'
  
  return {
    status: experienceSubmissions >= 1 ? 'success' : 'fail',
    reason: experienceSubmissions >= 1
      ? 'experience_participated'
      : 'experience_not_participated',
    experienceTargets,
    experienceSubmissions,
  }
```

### 부록 A-2. 포인트 산출 의사 코드 (정정)

```
computeWeeklyPoints(input):
  // 실무 경험: cluster4_experience_line_evaluations.rating 합산
  experiencePoints = SELECT COALESCE(SUM(e.rating), 0)
    FROM cluster4_experience_line_evaluations e
    JOIN cluster4_line_targets t ON t.id = e.line_target_id
    WHERE e.user_id = input.userId
      AND t.week_id = input.weekId
  
  // 실무 경력: career_records.grade_points 합산
  careerPoints = SELECT COALESCE(SUM(grade_points), 0)
    FROM career_records
    WHERE user_id = input.userId
      AND week_id = input.weekId
      AND grade_points IS NOT NULL
  
  // 실무 정보 / 실무 역량: 현재 컬럼 없음
  infoPoints = 0       // §15-2 #3
  competencyPoints = 0 // §15-2 #3
  
  return {
    points: experiencePoints + careerPoints + infoPoints + competencyPoints,
    advantages: 0,     // §6-6
    penalty: 0,        // §6-6
    breakdown: {
      experience: experiencePoints,
      career: careerPoints,
      info: infoPoints,
      competency: competencyPoints,
    },
  }
```

---

## 부록 B — 본 설계가 영향을 주지 않는 코드

다음은 본 설계 적용 시에도 **변경 없이** 동작한다:

| 파일 | 사유 |
|------|------|
| `lib/cluster4WeeklyGrowthData.ts` (대부분) | user_week_statuses 읽기만, 쓰기 없음 |
| `lib/cluster3GrowthData.ts` | 동일 |
| `lib/adminResumeCardData.ts` | user_growth_stats/cumulative_points 읽기만 |
| `lib/adminCrewData.ts` | user_growth_stats 읽기만 |
| `lib/cluster4LinesData.ts` (제출 API) | 기존 sync bridge 경로 유지 |
| `lib/cluster3ClubRankData.ts` | user_weekly_points 읽기만 |
| `app/api/activity-details/*` | user_activity_details 별도 경로 유지 |
| 모든 frontend 컴포넌트 | 응답 DTO 변경 없음 |

신규 추가만 발생:
- DB 트리거 1개 (user_week_statuses → user_growth_stats)
- DB 함수 1개 (sync_growth_stats_for_user)
- 평가 함수 모듈 (lib/cluster4WeekStatusEvaluator.ts, 가칭)
- Cron entry point
- Lazy 보정 patch (cluster4WeeklyGrowthData.ts 안)

---

**문서 끝.** 본 설계는 구현 전 검토 단계이며, §15-2 미결 사항이 결정되어야 다음 단계(Migration SQL 작성)로 진행 가능하다.
