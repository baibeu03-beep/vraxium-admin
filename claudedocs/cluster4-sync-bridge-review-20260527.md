# Cluster4 Sync-Bridge 설계 Architecture Review

> **작성일**: 2026-05-27
> **대상**: `claudedocs/cluster4-sync-bridge-design-20260527.md`
> **범위**: 설계 리뷰만 진행. SQL 작성 없음.

---

## 총평

설계안의 방향(cluster4_lines를 SoT로, 레거시에 프로젝션 동기화)은 적절하다.
그러나 **양방향 쓰기 충돌**이라는 치명적 결함 1건과, 구조 단순화 여지 1건이 있다.
나머지 4개 검토 항목은 경미한 조정으로 해결 가능하다.

**심각도 분류**:
- CRITICAL: 이대로 구현하면 데이터 불일치 발생
- MAJOR: 구조적 단순화가 필요
- MINOR: 조정 권장

---

## CRITICAL — 양방향 쓰기 충돌 (설계서 미언급)

### 문제

설계서는 **신규 → 레거시** 단방향 동기화만 다룬다.
그러나 기존 프론트는 `PUT /api/activity-details`로 `user_activity_details`에 **직접 쓴다**.

```
현재 프론트 쓰기 경로 (Career-Resume):
  사용자 모달 저장 버튼
    → PUT /api/activity-details
      → UPSERT user_activity_details (sub_title, growth_point, output_links, image_urls, ...)

설계안 쓰기 경로 (신규):
  사용자 submission
    → POST /cluster4/lines/:targetId/submission
      → INSERT cluster4_line_submissions
      → syncSubmissionToLegacy()
        → UPSERT user_activity_details (sub_title, growth_point, output_links, image_urls, ...)
```

**두 경로가 동일 행 `(user_id, week_id, activity_type_id)`에 쓴다.**

시나리오:
1. 사용자가 신규 API로 submission 제출 → user_activity_details 동기화됨
2. 사용자가 기존 프론트 모달에서 growth_point 수정 → user_activity_details 직접 갱신
3. cluster4_line_submissions에는 #2 변경이 반영되지 않음
4. 이후 submission PATCH 시 → user_activity_details를 #1 시점 데이터로 **덮어쓴다**

결과: 사용자의 #2 수정이 소실된다.

### 원인

설계서 원칙 2가 "레거시 테이블은 읽기 전용 프로젝션"이라고 선언하지만,
**기존 프론트의 PUT /api/activity-details가 여전히 레거시에 직접 쓰기 때문에** 실제로 읽기 전용이 아니다.

### 권장 해결

**user_activity_details를 동기화 대상에서 제외한다.**

```
변경 전 (설계안):
  cluster4_line_submissions → sync → activity_records + user_activity_details

변경 후 (권장):
  cluster4_line_submissions → sync → activity_records만
  user_activity_details     → 기존 PUT /api/activity-details 경로 유지 (변경 없음)
```

이유:
- `activity_records.is_completed`만 강화 판정에 영향 → 이것만 동기화하면 핵심 기능 작동
- `user_activity_details`는 기존 프론트가 직접 관리 → 동기화 불필요하고 위험
- `cluster4_line_submissions`의 역할은 "제출 사실 기록"으로 한정

이 변경은 **Migration 2를 불필요하게 만든다** (아래 MAJOR 항목 참조).

---

## MAJOR — Migration 2 제거 권장 (스키마 중복)

### 문제

Migration 2는 `cluster4_line_submissions`에 `growth_point`, `image_urls`, `image_captions`, `rating`을 추가한다.
이 컬럼들은 `user_activity_details`에 이미 존재하고, 기존 프론트가 직접 관리한다.

```
cluster4_line_submissions.growth_point  ← 중복 → user_activity_details.growth_point
cluster4_line_submissions.image_urls    ← 중복 → user_activity_details.image_urls
cluster4_line_submissions.image_captions← 중복 → user_activity_details.image_captions
cluster4_line_submissions.rating        ← 중복 → user_activity_details.rating
```

위 CRITICAL 항목에서 user_activity_details를 동기화 대상에서 제외하면,
이 컬럼들은 쓰는 곳도 읽는 곳도 없는 dead column이 된다.

### 권장

**Migration 2를 삭제한다.**

`cluster4_line_submissions`의 역할을 재정의:

```
현재 설계 (과도):
  cluster4_line_submissions = "사용자 2차 정보 전체 저장소"
  → user_activity_details의 복제본

권장 (축소):
  cluster4_line_submissions = "제출 사실 + 제출 시점 기록"
  → subtitle, output_link_2~5는 유지 (기존 스키마)
  → growth_point, image_urls, image_captions, rating 추가하지 않음
  → 사용자 2차 정보 전체는 user_activity_details가 계속 담당
```

이 접근의 장점:
- 신규 시스템 스키마가 깔끔하게 유지됨
- 양방향 쓰기 충돌 원천 차단
- 기존 프론트 `/api/activity-details` PUT 경로 변경 불필요
- `syncSubmissionToLegacy()` 함수가 `activity_records` 1개 테이블만 다루므로 단순

단, `cluster4_line_submissions.subtitle`과 `user_activity_details.sub_title`은 여전히 중복이다.
이 1개 필드의 SoT를 명확히 정해야 한다:

```
옵션 A: submission.subtitle이 SoT → sync → user_activity_details.sub_title (단방향)
         기존 프론트 모달은 sub_title을 submission API로 저장하도록 변경 필요
옵션 B: user_activity_details.sub_title이 SoT → submission.subtitle은 참고용 스냅샷
         기존 프론트 변경 불필요
옵션 C: subtitle을 cluster4_line_submissions에서도 제거
         submission은 순수 "제출 확인" 레코드로만 사용
```

**옵션 B 권장** — 프론트 변경 최소화 원칙과 일관.

---

## 검토 1: activity_type_id 브릿지 방식의 적절성

### 판정: 실용적으로 적절, 단 제약조건 필요

activity_type_id를 cluster4_lines에 추가하는 것은 레거시 호환을 위한 유일한 현실적 방법이다.
대안(매핑 테이블, part_type에서 자동 유도)은 모두 더 복잡하다.

**단, 설계서에 누락된 제약조건이 있다:**

```
문제: 동일 (week_id, activity_type_id)에 여러 cluster4_lines가 존재할 수 있다.
      이 경우 syncLineToWeeklyActivity()에서 어느 line의 데이터를 쓸지 모호해진다.

예시:
  line A: activity_type_id='wisdom', main_title='A제목'
  line B: activity_type_id='wisdom', main_title='B제목'
  target A → week 9
  target B → week 9
  → weekly_activities (week_id=9, activity_type_id='wisdom') 에 어느 title을 쓸 것인가?
```

**권장**: `cluster4_lines`에 `UNIQUE (activity_type_id)` 부분 인덱스 추가.
또는 동기화 함수에서 "동일 activity_type_id + 같은 week → 에러" 검증.

**추가 우려**: activity_type_id를 admin이 직접 입력하는 것은 오류 가능성이 높다.
어드민 UI에서 activity_types 테이블을 드롭다운으로 제공하는 것이 필수적이다.
설계서 미결 사항 #3에 언급되어 있으나, "미결"이 아니라 **필수 요건**으로 격상해야 한다.

---

## 검토 2: cluster4_lines를 SoT로 사용하는 구조의 적절성

### 판정: 방향은 맞지만, SoT 범위를 축소 정의해야 함

설계서 원칙 1이 "cluster4_lines 시스템이 유일한 SoT"라고 선언하지만,
실제로는 **라인 개설(1차 정보)**에 대한 SoT일 뿐이다.

```
실제 SoT 분포:

  라인 개설 정보 (1차):
    SoT = cluster4_lines + cluster4_line_targets
    → weekly_activities는 프로젝션

  사용자 2차 정보:
    SoT = user_activity_details  ← 기존 프론트가 직접 관리
    → cluster4_line_submissions.subtitle은 스냅샷 또는 참고값

  강화 판정:
    SoT = activity_records.is_completed  ← cluster4_line_submissions 존재 여부로 동기화
    → cluster4_line_submissions 존재 = is_completed true

  경력 프로젝트 메타:
    SoT = career_projects  ← 별도 관리 도메인
    → cluster4_lines(career)는 "개설" 관리만
```

**권장**: 원칙 1을 아래와 같이 수정.

```
수정 전: "cluster4_lines 시스템이 유일한 Source of Truth"
수정 후: "라인 개설(1차 정보)의 Source of Truth는 cluster4_lines이다.
          사용자 2차 정보의 Source of Truth는 user_activity_details이다.
          강화 판정은 cluster4_line_submissions 존재 여부에서 activity_records로 동기화한다."
```

### 전환기 공존 문제

설계서가 다루지 않는 시나리오:

```
기존 운영자가 weekly_activities에 직접 라인을 개설하는 경로가 있는가?
  → Career-Resume 어드민 UI 또는 Supabase Dashboard에서 직접 INSERT
  → 이 경우 cluster4_lines에는 대응 행이 없음
  → "SoT = cluster4_lines"라는 전제가 깨짐
```

**권장**: 전환기 동안의 운영 정책을 명시해야 한다.
- 언제부터 weekly_activities 직접 쓰기를 금지하는가?
- 기존 weekly_activities 데이터를 cluster4_lines로 역마이그레이션하는가?
- 역마이그레이션 전까지는 "이중 SoT" 상태를 인정하는가?

---

## 검토 3: weekly_activities / activity_records 유지 전략

### 판정: 유지 전략 자체는 적절, 동기화 범위만 조정

weekly_activities와 activity_records를 폐기하지 않고 프로젝션으로 유지하는 것은 올바르다.
프론트 전면 개편 없이 점진적 전환이 가능하기 때문이다.

**조정 권장 사항**:

```
설계서:
  syncLineToWeeklyActivity()      → weekly_activities 동기화     ✅ 유지
  syncSubmissionToLegacy()        → activity_records 동기화      ✅ 유지
  syncSubmissionToLegacy()        → user_activity_details 동기화 ❌ 제거

이유: CRITICAL 항목 참조 — 양방향 쓰기 충돌 방지
```

**weekly_activities 동기화 시 fan-out 문제**:

```
admin이 cluster4_lines.main_title을 수정하면,
이 line에 연결된 모든 target의 week_id에 대해 weekly_activities를 갱신해야 한다.

line 1개에 target 50개 (50주차분) → weekly_activities 50행 UPDATE

대응: updateCluster4Line()에서 title/is_active 변경 시
      연관 target을 먼저 조회 → 변경된 필드만 선택적 동기화
      또는 batch UPDATE로 처리 (단일 SQL)
```

---

## 검토 4: Career 파트 이중 구조 리스크

### 판정: 가장 위험한 부분. 구조 분리를 유지하되 경계를 명확히 해야 함

### 문제 1: 도메인 불일치

```
career_projects = "프로젝트 메타데이터" (회사, 감독자, 설명, 로고 등 15+ 필드)
cluster4_lines  = "라인 개설 관리" (제목, 링크, 제출 기간, 활성 여부 등 6 필드)

이 둘은 본질적으로 다른 도메인이다.
career_project_id FK로 연결한다고 해서 하나가 다른 하나의 SoT가 되는 것이 아니다.
```

### 문제 2: career_records 동기화 시 grade/grade_points 충돌

설계서의 syncCareerLineToLegacy():
```
UPSERT career_records SET enhancement_status = 'pending'
  → grade, grade_points는 별도 관리 (어드민 입력)
```

그러나 UPSERT ON CONFLICT DO UPDATE는 기존 행의 **모든 SET 컬럼을 덮어쓴다**.
기존 career_records 행에 이미 grade='A', grade_points=85가 있다면,
enhancement_status만 바꾸려 해도 다른 컬럼이 NULL로 리셋될 위험이 있다.

**권장**:

```
career에 대해서는 cluster4_lines를 SoT로 삼지 않는 것을 검토한다.

이유:
1. career_projects 자체가 이미 잘 구조화된 마스터 테이블
2. career_project_weeks가 이미 주차별 개설 관리를 담당
3. career_records가 이미 사용자별 상태 + 등급 관리를 담당
4. 이 위에 cluster4_lines를 얹으면 이중 관리 비용만 증가

대안: career 파트는 cluster4_lines 시스템에서 제외하고,
      기존 career_projects + career_project_weeks + career_records 체계를 유지한다.
      cluster4_lines.part_type은 info/experience/competency 3개만 지원.
```

career를 제외하면:
- `career_project_id` 컬럼 불필요 (Migration 1 축소)
- `syncCareerLineToLegacy()` 함수 불필요
- career_records의 grade/grade_points 충돌 원천 제거
- 어드민 career 관리 UI는 기존 경로 그대로 유지

---

## 검토 5: Rule Target 지원 방안

### 판정: 설계서의 "향후" 처리는 부적절. 최소한의 설계 방향이 필요

### 핵심 문제

rule target은 특정 user_id가 없으므로, 레거시 테이블 동기화가 구조적으로 불가능하다:

```
activity_records = (user_id, week_id, activity_type_id) PK
  → user_id 필수. rule target은 user_id가 없음 → 쓸 수 없음

weekly_activities = (week_id, activity_type_id) PK
  → user_id 무관. rule target은 쓸 수 있음 → 동기화 가능
```

따라서:
- `weekly_activities` 동기화: rule target으로도 가능 (사용자 무관)
- `activity_records` 동기화: rule target으로는 **불가능** — 매칭된 사용자 목록이 필요

### 권장 설계 방향

```
Phase 1 (현재): user 모드만 지원. rule 모드는 501 유지.

Phase 2 (향후): rule evaluator 도입
  1. rule target 생성 시 → weekly_activities 동기화는 가능 (user 무관)
  2. 사용자가 자기 라인 조회 시 → rule 매칭 평가 → 적격 여부 판단
  3. 사용자가 submission 제출 시:
     → cluster4_line_submissions INSERT (이건 user_id 있음)
     → activity_records 동기화 가능 (이 시점에서 user_id 확정)
  4. 즉, rule target의 activity_records 동기화는
     "target 생성 시"가 아니라 "submission 생성 시"에 발생

이 방향이면 기존 동기화 함수에 특별한 분기가 필요 없다:
  syncSubmissionToLegacy()는 submission에서 user_id를 읽으므로
  target이 user 모드든 rule 모드든 동일하게 동작한다.
```

설계서에 이 방향을 명시해두면, rule 지원 추가 시 동기화 함수 변경이 불필요하다는 점을 확인할 수 있다.

---

## 검토 6: Migration 1~2 우선 적용 적절성

### 판정: 순서가 잘못되었다. Phase 0이 진정한 선행 조건.

### 현재 설계서 순서

```
Phase 0: 운영 DB 스키마 덤프 (weekly_activities, activity_records)
Phase 1: Migration 1 (cluster4_lines 브릿지) + Migration 2 (submissions 2차 정보)
Phase 2: 동기화 함수 구현
Phase 3: API 레이어 통합
```

### 문제

Migration 1의 컬럼 정의(`activity_type_id` 등)가 레거시 스키마에 의존하는데,
Phase 0(레거시 스키마 확인)이 완료되기 전에 Migration 1을 작성하면 가정 기반 설계가 된다.

예시:
- `weekly_activities.activity_type_id`가 실제로는 `uuid` 타입이면?
  → cluster4_lines.activity_type_id를 text로 정의한 Migration 1이 무효
- `activity_records`에 추가 컬럼(예: `completed_at`)이 있으면?
  → syncSubmissionToLegacy()가 이 컬럼을 채워야 할 수 있음

### 권장 순서

```
Phase 0: 운영 DB 스키마 덤프               ← 절대 선행
  → \d+ weekly_activities
  → \d+ activity_records
  → \d+ teams, parts, user_team_parts, user_role_history
  → canonical DDL 확정 (Migration 3, 4)

Phase 1a: Migration 3, 4 작성 (canonical DDL)  ← Phase 0 결과로 확정
Phase 1b: Migration 1 작성 (브릿지 컬럼)        ← Phase 1a 확정된 스키마 기준
Phase 1c: Migration 2                          ← 리뷰 결과 삭제 권장

Phase 2: 동기화 함수 구현
Phase 3: API 통합
```

또한 Migration 2는 위 MAJOR 항목에서 삭제를 권장했으므로,
**실제 필요한 migration은 Migration 1(축소판) + Migration 3 + Migration 4** 3개이다.

---

## 단순화 제안 종합

위 리뷰 항목을 종합하면, 설계안을 아래와 같이 단순화할 수 있다.

### 변경 전 (원안)

```
동기화 대상: weekly_activities + activity_records + user_activity_details (3개)
동기화 함수: syncLineToWeeklyActivity + syncSubmissionToLegacy + syncCareerLineToLegacy (3개)
Migration:   1 (lines 4컬럼) + 2 (submissions 4컬럼) + 3 + 4 + 5 (5개)
career 처리: cluster4_lines에 career_project_id 추가, 이중 동기화
SoT 선언:    "cluster4_lines = 유일한 SoT"
```

### 변경 후 (권장)

```
동기화 대상: weekly_activities + activity_records (2개)
동기화 함수: syncLineToWeeklyActivity + syncSubmissionToActivityRecord (2개)
Migration:   1-축소 (lines 3컬럼) + 3 + 4 (3개)
career 처리: cluster4_lines에서 제외, 기존 체계 유지
SoT 선언:    "라인 개설 SoT = cluster4_lines, 사용자 2차 정보 SoT = user_activity_details"
```

### 변경 상세

| 항목 | 원안 | 권장 | 이유 |
|---|---|---|---|
| user_activity_details 동기화 | O | **X** | 양방향 쓰기 충돌 방지 (CRITICAL) |
| Migration 2 | O | **삭제** | 스키마 중복 제거 (MAJOR) |
| career 파트 | cluster4_lines 포함 | **제외** | 이중 구조 리스크 제거 |
| career_project_id 컬럼 | O | **삭제** | career 제외에 따라 불필요 |
| cluster4_lines.part_type | 4종 (info/exp/comp/career) | **3종** (info/exp/comp) | career 제외 |
| syncCareerLineToLegacy() | O | **삭제** | career 제외에 따라 불필요 |
| 동기화 함수 복잡도 | 3 JOIN + 2 테이블 쓰기 | 3 JOIN + 1 테이블 쓰기 | syncSubmission 단순화 |

### Migration 1 축소판

```
ALTER TABLE cluster4_lines ADD COLUMN IF NOT EXISTS:
  activity_type_id    text         NULL
  output_images       jsonb        NOT NULL DEFAULT '[]'::jsonb
  team_id             uuid         NULL

(career_project_id 삭제)
```

### 동기화 함수 축소판

```
syncLineToWeeklyActivity(line, target):
  → UPSERT weekly_activities (title, is_active, output_links, output_images, team_id, ...)
  (원안과 동일)

syncSubmissionToActivityRecord(submission, target, line):
  → UPSERT activity_records SET is_completed = true
  (user_activity_details 동기화 삭제)
```

---

## 대안 검토: 왜 다른 접근은 부적절한가

### 대안 A: 프론트를 cluster4_lines에서 직접 읽도록 전면 개편

```
장점: 동기화 자체가 불필요, 깔끔한 아키텍처
단점: Cluster4CardContent.tsx (6000+ 줄) 전면 개편 필요
      /api/profile, /api/cluster-4-ranking 등 다수 API도 변경
      buildWeeklyCards() 전면 재작성
판정: 비용 대비 효과 부적절. 장기 목표로는 적합하나 단기 전략 아님.
```

### 대안 B: DB View로 weekly_activities를 cluster4_lines에서 유도

```
장점: SoT 단일, 읽기 시 자동 반영
단점: Supabase PostgREST가 view를 테이블처럼 쿼리 가능하나,
      기존 코드가 .from("weekly_activities")로 호출하고 있어
      view 이름을 "weekly_activities"로 만들면 기존 테이블과 충돌
      → DROP TABLE + CREATE VIEW는 기존 데이터 소실
판정: 전환 리스크가 너무 높음. 부적절.
```

### 대안 C: DB Trigger로 자동 동기화

```
장점: API 경로 누락 위험 없음
단점: Supabase에서 trigger가 service_role 권한으로 실행되므로
      RLS 정책과 간섭 가능. 디버깅 어려움. 
      trigger 내 다른 테이블 쓰기는 복잡도 증가.
판정: 차선. API 레이어 함수(설계안 A)가 더 적절.
```

---

## 최종 체크리스트

| # | 항목 | 원안 상태 | 권장 조치 | 심각도 |
|---|---|---|---|---|
| 1 | user_activity_details 양방향 쓰기 | 미식별 | 동기화 대상에서 제외 | CRITICAL |
| 2 | Migration 2 스키마 중복 | 포함 | 삭제 | MAJOR |
| 3 | activity_type_id 중복 제약조건 | 미정의 | UNIQUE partial index 또는 sync 시 검증 | MINOR |
| 4 | SoT 범위 과대 선언 | "유일한 SoT" | 도메인별 SoT 분리 정의 | MINOR |
| 5 | career 이중 구조 | 포함 | cluster4_lines에서 career 제외 | MINOR~MAJOR |
| 6 | rule target 동기화 방향 | "향후" | 최소 설계 방향 명시 | MINOR |
| 7 | Migration 순서 | 1→2→3→4 | 0→3→4→1 | MINOR |
| 8 | weekly_activities fan-out | 미언급 | batch UPDATE 또는 선택적 동기화 | MINOR |
| 9 | 전환기 공존 정책 | 미정의 | 운영 정책 문서화 | MINOR |
| 10 | activity_type_id 입력 방식 | 미결 | 필수 요건으로 격상 (드롭다운) | MINOR |
