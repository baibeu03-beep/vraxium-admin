# Cluster4 라인 개설 구현 영향도 검증

> **작성일**: 2026-05-27
> **기준 문서**: `cluster4-line-final-architecture.md`
> **범위**: 코드 수정 없음. 조사 및 검증만 진행.

---

## 1. PUT /api/activity-details 분석

### 파일 위치

`Career-Resume/app/(host)/api/activity-details/route.ts`

### activity_type_id 생성 위치

```
요청 본문에서 직접 수신 (line 104-115):
  const { user_id, week_id, activity_type_id, sub_title, ... } = body

클라이언트(프론트)가 전송. 서버에서 생성하지 않음.
하드코딩 아님. URL 파라미터도 아님.
```

### 값 출처 (프론트 → 서버)

```
Cluster4CardContent.tsx에서 모달 저장 시:
  PUT /api/activity-details {
    user_id: 세션 사용자,
    week_id: 현재 주차 ID,
    activity_type_id: 해당 카드의 activityType (예: 'wisdom', 'comp-1')
  }

activity_type_id 값은:
  info 허브:   하드코딩 목록 ['wisdom', 'essay', ...] 에서 선택
  ability 허브: activity_types 테이블의 id (cluster_id='practical_competency')
  exp 허브:    activity_types 테이블의 id (cluster_id='practical_experience')
  career 허브: activity_types 테이블의 id 또는 'practical_project'
```

### weekly_activities 의존 여부

**의존함. 치명적 의존.**

```
Lines 235-240:
  supabaseAdmin
    .from('weekly_activities')
    .select('is_active, opened_at, deadline, team_id')
    .eq('week_id', week_id)
    .eq('activity_type_id', activity_type_id)

목적: 마감 시간(deadline) 및 개설 여부(is_active) 검증

weekly_activities 미존재 시:
  → 쿼리 결과 에러 또는 빈 배열
  → wa = null (line 259-261 fallback 로직)
  → isBeforeDeadline = false
  → 비어드민 + editWindow 미오픈 + grant 미존재 시 → 403 거부
```

**결론**: weekly_activities가 없으므로 현재 이 API는 **비어드민 사용자에게 항상 403을 반환**한다. 어드민만 bypass 가능.

### UPSERT 대상

```
user_activity_details 테이블에 UPSERT (line 304-310):
  onConflict: 'user_id, week_id, activity_type_id'

activity_type_id는 클라이언트가 보낸 값이 그대로 DB에 저장됨.
cluster4_lines와의 연결: activity_type_id 값이 동일하면 논리적으로 연결.
```

### 수정 방안

```
weekly_activities 대신 cluster4_lines + cluster4_line_targets 참조로 변경:

현재:
  .from('weekly_activities')
  .select('is_active, opened_at, deadline, team_id')
  .eq('week_id', week_id)
  .eq('activity_type_id', activity_type_id)

변경:
  cluster4_lines JOIN cluster4_line_targets
  WHERE targets.week_id = week_id
    AND lines.activity_type_id = activity_type_id
    AND lines.is_active = true
  → is_active = lines.is_active
  → deadline = lines.submission_closes_at
  → team_id = lines.team_id
```

---

## 2. cluster4_lines.activity_type_id 추가 시 연결 가능성

### 연결 경로

```
cluster4_lines.activity_type_id = 'wisdom'
                    ↕ (동일 text 값)
user_activity_details.activity_type_id = 'wisdom'
                    ↕ (동일 text 값)
프론트가 전송하는 activity_type_id = 'wisdom'
```

**text 값만 일치하면 연결된다.** FK 불필요, JOIN 불필요 (같은 필드명 + 같은 값).

### 프론트 최소 수정 범위

```
수정 불필요한 것:
  ✅ PUT /api/activity-details의 요청 본문 형태 (activity_type_id 전달 방식 동일)
  ✅ user_activity_details UPSERT 로직 (onConflict 키 동일)
  ✅ 프론트 모달의 저장 로직 (activity_type_id를 보내는 방식 동일)

수정 필요한 것:
  ❌ PUT /api/activity-details의 마감 검증 (weekly_activities → cluster4_lines)
  ❌ 프론트의 weekBundle 데이터 소스 (weekly_activities → cluster4_lines)
  ❌ getEnhancementStatus() (activity_records → cluster4_line_submissions)
  ❌ buildWeeklyCards() (weekly_activities + activity_records → cluster4_*)
  ❌ Profile API의 weekBundle 조립 (weekly_activities, activity_records 쿼리 제거/교체)
```

---

## 3. 프론트 데이터 구조 전제 분석

### 3-1. Cluster4CardContent.tsx가 전제하는 데이터

**weeklyActivities 상태 (line 1255)**:
```typescript
WeeklyActivity[] = [
  {
    id: string,
    activity_type_id: string,    // 'wisdom', 'comp-1' 등
    title: string | null,        // Main Title
    is_active: boolean,
    opened_at: string | null,
    output_links: {desc, url}[] | null,
    output_images?: {url, caption}[] | null,   // 코드에서 참조하나 API select에 없음
    team_id?: string | null,                    // activity-details에서만 사용
  }
]
```

**weekActivityRecords 상태 (line 1276)**:
```typescript
ActivityRecord[] = [
  {
    week_id: string,
    activity_type_id: string,
    is_completed: boolean,
    is_empty?: boolean,          // 더미 데이터 sentinel
  }
]
```

**weekActivityDetails 상태**:
```typescript
ActivityDetail[] = [
  {
    week_id: string,
    activity_type_id: string,
    sub_title: string | null,
    output_links: {desc, url}[] | null,
    growth_point: string | null,
    image_urls: (string|null)[] | null,
    image_captions: string[] | null,
    rating: number | null,
  }
]
```

### 3-2. getEnhancementStatus() 전제 (line 4939-4992)

```
입력: activityType (string, 예: 'wisdom')

참조하는 상태:
  weeklyActivities → activity = find(a => a.activity_type_id === activityType)
  weekActivityRecords → record = find(r => r.activity_type_id === activityType)

판정 흐름:
  1. onboarding/rest → "not_applicable"
  2. 역할 불일치 + record 없음 → "not_applicable"
  3. experience 적격 범위 밖 + record 없음 → "not_applicable"
  4. activity?.is_active === false → "not_applicable"
  5. !record || !record.is_completed → "failed"
  6. record.is_completed && !resultsDecided → "waiting"
  7. record.is_completed && resultsDecided → "success"
```

**cluster4_* 전환 시 필요한 매핑**:

| 현재 데이터 | cluster4_* 대체 | 매핑 방법 |
|---|---|---|
| `activity.is_active` | `cluster4_lines.is_active` | activity_type_id 매칭 |
| `record.is_completed` | `cluster4_line_submissions 존재 여부` | target 기반 lookup |
| `activity.activity_type_id` | `cluster4_lines.activity_type_id` | 동일 필드 |
| `activity.title` | `cluster4_lines.main_title` | 필드명 변경 |
| `activity.output_links` | `[{url: cluster4_lines.output_link_1}]` | 변환 필요 |

### 3-3. buildWeeklyCards() 전제 (cluster4-weekly-cards.ts)

```
쿼리 대상:
  weekly_activities: week_id, activity_type_id, is_active (line 129)
  activity_records: week_id, activity_type_id, is_completed (line 113)
  activity_types: id, cluster_id (line 114)

강화 판정 함수 (line 285-290):
  function isEnhanced(weekId, startDate, typeId):
    if (now < resultDecidedMs(startDate)) return false
    const records = actMap.get(`${weekId}|${typeId}`)
    return !!records?.some(r => r.is_completed)

info 강화율 (line 293-300):
  infoCount = infoTypeIds 중 isEnhanced가 true인 수
  infoTotal = 해당 주차 활성 info activity 수
```

**cluster4_* 전환 시**: weekly_activities와 activity_records 쿼리를 cluster4_lines + cluster4_line_targets + cluster4_line_submissions JOIN으로 교체해야 한다.

---

## 4. 수정 필요 파일 목록

### 4-1. 백엔드 (Career-Resume)

| # | 파일 경로 | 수정 이유 | 난이도 |
|---|---|---|---|
| 1 | `app/(host)/api/profile/route.ts` | weekBundle 조립 시 weekly_activities (line 518) → cluster4_lines+targets JOIN으로 교체. activity_records (line 555) → cluster4_line_submissions 존재 확인으로 교체. | **상** |
| 2 | `app/(host)/api/activity-details/route.ts` | 마감 검증 (line 235-240) weekly_activities → cluster4_lines+targets 참조로 교체. team_id 조회도 동일 변경. | **중** |
| 3 | `app/(host)/api/cluster-4-ranking/route.ts` | weekly_activities (line 255) → cluster4_lines+targets. activity_records (line 263) → cluster4_line_submissions. infoTypeIds 하드코딩 (line 9) → activity_types 쿼리. | **상** |
| 4 | `lib/cluster4-weekly-cards.ts` | weekly_activities (line 129) → cluster4_lines+targets. activity_records (line 113) → cluster4_line_submissions. isEnhanced() 함수 로직 변경. | **상** |
| 5 | `components/home-career/Sidebar.tsx` | weekly_activities (line 1694) → cluster4_lines+targets. activity_records (line 1710) → cluster4_line_submissions. | **중** |

### 4-2. 프론트 (Career-Resume)

| # | 파일 경로 | 수정 이유 | 난이도 |
|---|---|---|---|
| 6 | `components/cluster-4-card/Cluster4CardContent.tsx` | (A) weeklyActivities 상태의 데이터 소스 전환 (line 1252-1260). (B) weekActivityRecords 상태를 submissions 기반으로 전환 (line 1275-1276). (C) getEnhancementStatus() 로직 변경 (line 4939-4992). (D) workInfoActivityTypes 하드코딩 제거 → activity_types 쿼리 (line 4855). (E) workInfoCards 빌더의 activity/record 매칭 변경 (line 5370-5416). | **상** |
| 7 | `components/cluster-4-card/DetailLogModal.tsx` | weeklyActivities 참조가 있다면 동일 변경 | **하** |

### 4-3. 백엔드 (vraxium-admin)

| # | 파일 경로 | 수정 이유 | 난이도 |
|---|---|---|---|
| 8 | `lib/adminCluster4LinesTypes.ts` | Cluster4LineUpsertInput, Cluster4LineDto에 activityTypeId, outputImages, teamId, careerProjectId 추가. 파서 함수 수정. | **중** |
| 9 | `lib/adminCluster4LinesData.ts` | createCluster4Line(), updateCluster4Line()에서 신규 컬럼 읽기/쓰기 추가. listCluster4Lines()에서 activity_type_id 필터 지원. | **중** |
| 10 | `lib/cluster4LinesTypes.ts` | Cluster4VisibleLineDto에 activityTypeId 추가. | **하** |
| 11 | `lib/cluster4LinesData.ts` | 쿼리에서 activity_type_id 컬럼 select 추가. | **하** |
| 12 | `db/migrations/` (신규) | Migration 1: cluster4_lines 컬럼 추가. Migration 2: activity_types CHECK+seed. | **하** |

### 4-4. 수정 불필요 파일

| 파일 | 이유 |
|---|---|
| `lib/userActivityDetailsTypes.ts` | 스키마 변경 없음 |
| `lib/userActivityDetailsData.ts` | 스키마 변경 없음 |
| `lib/careerRecordsTypes.ts` | career_records 스키마 변경 없음 |
| `lib/careerRecordsData.ts` | 동일 |
| `cluster4_line_submissions` 관련 파일 | 스키마 변경 없음 |

---

## 5. 구현 순서 검증

### 아키텍처 문서의 Phase 순서

```
Phase 1: Migration 적용 (cluster4_lines 컬럼 + activity_types seed)
Phase 2: Admin API 보강 (드롭다운, 신규 컬럼 입력)
Phase 3: 사용자 API 수정 (week-bundle, activity-details)
Phase 4: 프론트 연동 (데이터 소스 전환)
Phase 5: 검증
```

### 검증 결과: 순서 조정 필요

**문제 1: Phase 3과 Phase 4의 의존 관계**

```
현재 상태:
  Profile API가 weekly_activities/activity_records를 쿼리 → 500 에러
  → 프론트가 데이터를 받지 못함

Phase 3 (API 수정) 완료 전에는 Phase 4 (프론트 연동) 착수 불가.
그런데 Phase 3 자체가 Phase 1 (Migration) 완료를 전제.
→ 순서는 맞지만, Phase 3을 세분화해야 한다.
```

**문제 2: 프론트 데이터 형태 변환 전략 부재**

```
현재 프론트가 기대하는 형태:
  weeklyActivities = [{activity_type_id, title, is_active, ...}]
  activityRecords = [{activity_type_id, is_completed}]

cluster4_* 테이블에서 이 형태를 만들려면:
  cluster4_lines + cluster4_line_targets JOIN으로 weeklyActivities 형태 조립
  cluster4_line_submissions 존재 여부로 activityRecords 형태 조립

이 변환은 API 레이어에서 하는 것이 적절 (프론트 변경 최소화).
```

**문제 3: Profile API가 현재 완전 차단 상태**

```
weekly_activities 미존재 → Profile API 500 에러 → 프론트 전체 차단
이 상태에서 Phase 1 (Migration)만 적용해도 Profile API는 여전히 500
→ Phase 3 (API 수정)이 완료될 때까지 프론트는 작동 불가
→ Phase 3을 가능한 빨리 완료하는 것이 운영 우선순위
```

### 수정된 구현 순서

```
Phase 1: Migration 적용
  1-a. cluster4_lines 컬럼 4개 추가 + 부분 UNIQUE
  1-b. activity_types CHECK 변경 + info 타입 9개 seed
  1-c. 어드민 타입/DTO/파서 업데이트 (vraxium-admin)
  → 이 시점에서 어드민은 activity_type_id 포함하여 라인 생성 가능

Phase 2: Profile API 긴급 수정 (운영 차단 해소)
  2-a. profile/route.ts의 weekly_activities 쿼리 교체
       → cluster4_lines + cluster4_line_targets JOIN
       → 기존 weeklyActivities 응답 형태와 동일한 DTO 반환
         (activity_type_id, title=main_title, is_active, output_links 변환)
  2-b. profile/route.ts의 activity_records 쿼리 교체
       → cluster4_line_submissions 존재 확인
       → 기존 activityRecords 응답 형태와 동일한 DTO 반환
         (activity_type_id, is_completed = submission 존재 여부)
  → 이 시점에서 프론트가 기존 형태의 데이터를 받기 시작

Phase 3: 보조 API 수정
  3-a. PUT /api/activity-details — 마감 검증 로직 교체
  3-b. cluster-4-ranking/route.ts — 데이터 소스 교체
  3-c. cluster4-weekly-cards.ts (buildWeeklyCards) — 데이터 소스 교체
  3-d. Sidebar.tsx — 데이터 소스 교체

Phase 4: Admin API 보강
  4-a. 어드민 라인 생성 시 activity_type_id 드롭다운
  4-b. output_images, team_id, career_project_id 입력 지원

Phase 5: 프론트 직접 전환 (선택적, 장기)
  5-a. 프론트가 cluster4_* DTO를 직접 소비하도록 전환
       (Phase 2의 호환 레이어 제거)
  5-b. getEnhancementStatus() 네이티브 전환
  5-c. workInfoActivityTypes 하드코딩 제거

Phase 6: 검증
  6-a. 라인 개설 → 카드 표시
  6-b. 사용자 2차 정보 입력
  6-c. 사용자 제출 → 강화 상태 전환
  6-d. career 라인 연동
```

### 순서 변경 근거

| 변경 | 이유 |
|---|---|
| Phase 2를 API 수정으로 앞당김 | Profile API 500 에러가 운영 차단 상태. 가장 시급. |
| Phase 2에서 호환 DTO 반환 | 프론트 변경 없이 기존 형태 데이터 수신 가능. 프론트 직접 전환은 Phase 5로 분리. |
| Phase 4 (Admin 보강)를 Phase 3 이후로 | 어드민 라인 생성은 현재도 가능 (기존 컬럼). 드롭다운 등 UI 보강은 운영 차단 해소 후 진행. |
| Phase 5 (프론트 직접 전환)를 선택적으로 | Phase 2의 호환 레이어가 동작하면 프론트는 수정 없이도 작동. 장기적으로 전환. |

---

## 6. 핵심 리스크

### 리스크 1: Profile API 호환 DTO 정확성

```
Phase 2에서 cluster4_* 데이터를 기존 weeklyActivities/activityRecords 형태로
변환해야 한다. 필드 매핑이 정확하지 않으면 프론트가 오작동한다.

필수 매핑:
  cluster4_lines.main_title → weeklyActivities[].title
  cluster4_lines.is_active → weeklyActivities[].is_active
  cluster4_lines.activity_type_id → weeklyActivities[].activity_type_id
  cluster4_lines.submission_opens_at → weeklyActivities[].opened_at
  cluster4_lines.submission_closes_at → weeklyActivities[].deadline
  [{url: cluster4_lines.output_link_1}] → weeklyActivities[].output_links
  cluster4_lines.output_images → weeklyActivities[].output_images
  cluster4_lines.team_id → weeklyActivities[].team_id
  ※ cluster4_lines.id는 weeklyActivities[].id로 매핑 (uuid 호환)

  cluster4_line_submissions 존재 → activityRecords[].is_completed = true
  submissions 미존재 → activityRecords[] 에서 해당 activity_type_id 행 제외
    (행 없음 = getEnhancementStatus에서 "failed" 처리)
```

### 리스크 2: team_id 멀티 행 처리

```
기존 weekly_activities는 같은 (week_id, activity_type_id)에 team_id가 다른 여러 행이 있을 수 있었다.
cluster4_lines에서도 같은 activity_type_id + 다른 team_id로 여러 line이 있을 수 있다.

그러나 부분 UNIQUE 인덱스 (activity_type_id WHERE is_active=true)가
활성 라인 간 동일 activity_type_id를 금지하므로,
team_id별 멀티 행 패턴은 불가능해진다.

대안: 부분 UNIQUE를 (activity_type_id, team_id) WHERE is_active=true 로 변경하면
      team_id별 멀티 행 가능. 그러나 복잡도 증가.

권장: Phase 1에서는 단순 UNIQUE(activity_type_id) 유지.
      실무 경험(experience)의 팀별 분리가 필요해지면 UNIQUE 조정.
```

### 리스크 3: activity_type_id 값 불일치

```
cluster4_lines.activity_type_id에 어드민이 입력하는 값과
프론트가 PUT /api/activity-details로 보내는 값이 동일해야 한다.

현재 프론트가 보내는 값:
  info: 'wisdom', 'essay', 'infodesk', 'calendar', 'forum', 'session',
        'practical_lecture', 'community', 'etc_a'
  competency: activity_types.id 값 (예: 'comp-1')
  experience: activity_types.id 값 (예: 'exp-1')

Migration 2에서 activity_types에 info 타입을 seed하면,
어드민 드롭다운에서 동일한 id 값을 선택하게 되므로 일치 보장.
```

---

## 7. 요약

### 현재 운영 상태

```
weekly_activities 미존재 → Profile API 500 에러 → 프론트 전체 차단
activity_records 미존재 → 강화 판정 불가
PUT /api/activity-details → 비어드민 사용자 403 거부
```

### 최소 필수 작업 (운영 차단 해소)

```
1. Migration 1: cluster4_lines 컬럼 추가 (activity_type_id 등)
2. Migration 2: activity_types info seed
3. Profile API: weekly_activities 쿼리 → cluster4_lines 호환 DTO
4. Profile API: activity_records 쿼리 → cluster4_line_submissions 호환 DTO
5. PUT /api/activity-details: 마감 검증 → cluster4_lines 참조
```

이 5개 작업이 완료되면 프론트 코드 수정 없이 기본 동작이 복원된다.

### 수정 파일 수

```
필수 (운영 차단 해소): 5개 파일
  Migration 2개 + profile API + activity-details API + admin 타입/데이터

보조 (완전 연동): 4개 파일 추가
  ranking API + weekly-cards + Sidebar + admin API 보강

프론트 직접 전환 (선택적, 장기): 2개 파일
  Cluster4CardContent.tsx + DetailLogModal.tsx
```
