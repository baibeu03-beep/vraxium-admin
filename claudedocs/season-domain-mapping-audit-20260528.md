# Season Domain Technical Mapping 감사 보고서

**감사 일자**: 2026-05-28  
**감사 범위**: 성장 도메인 8개 개념 (a~h) × 10개 검증 항목  
**감사 원칙**: 읽기 전용, 수정 없음, migration 없음

---

## 대상 개념 정의 (원천: `cluster3GrowthTypes.ts:57-66`)

| 기호 | 한국어 명칭 | 정의 |
|------|------------|------|
| a | 성장 성공 주차 | `user_week_statuses.status = 'success'` 행 수 |
| b | 성장 실패 주차 | `user_week_statuses.status = 'fail'` 행 수 |
| c | 개인 휴식 주차 | `user_week_statuses.status = 'personal_rest'` 행 수 |
| d | 공식 휴식 주차 | `user_week_statuses.status = 'official_rest'` 행 수 |
| e | 성장 가능 주차 | a + b + c |
| h | 물리적(지나간) 주차 | a + b + c + d |
| f | 성장 휴식 시즌 | `user_season_statuses.status = 'rest'` 행 수 |
| g | 성장 성공 시즌 | `user_season_statuses` 중 rest가 아닌 행 수 |

---

## 1. 실제 계산 함수

### a. 성장 성공 주차

| 위치 | 파일:줄 | 계산 방식 | 변수명 |
|------|---------|----------|--------|
| Cluster3 | `cluster3GrowthData.ts:148` | `case "success": a++` | `a` |
| Cluster4 | `cluster4WeeklyGrowthData.ts:224-225` | `case "success": approvedWeeks++` | `approvedWeeks` |
| Cluster1 | `cluster1ResumeData.ts:94-95` | `case "success": approvedActiveWeeks++` | `approvedActiveWeeks` |
| SQL RPC | `get_week_status_counts()` | `COUNT(*) WHERE status='success'` | `success_count` |
| Stored | `user_growth_stats.approved_weeks` | migration 시 동기화 | — |

**평가**: 5곳에서 독립 계산. 로직 일치. 변수명 3종 (`a`, `approvedWeeks`, `approvedActiveWeeks`).

### b. 성장 실패 주차

| 위치 | 파일:줄 | 변수명 |
|------|---------|--------|
| Cluster3 | `cluster3GrowthData.ts:149` | `b` |
| Cluster4 | `cluster4WeeklyGrowthData.ts:227-228` | `failedWeeks` |
| Cluster1 | `cluster1ResumeData.ts:97-98` | `unapprovedActiveWeeks` |

**평가**: 로직 일치. Cluster1의 `unapprovedActiveWeeks`는 "미승인 활동 주차"로 의미론적 프레이밍이 다름.

### c. 개인 휴식 주차

| 위치 | 파일:줄 | 변수명 |
|------|---------|--------|
| Cluster3 | `cluster3GrowthData.ts:150` | `c` |
| Cluster4 | `cluster4WeeklyGrowthData.ts:230-231` | `restWeeks` |
| Cluster1 | `cluster1ResumeData.ts:100-101` | `preRestWeeks` |

**평가**: 로직 일치. Cluster4의 `restWeeks`는 personal_rest만 카운트하지만 이름이 모호 (official_rest 포함 착각 유발).

### d. 공식 휴식 주차

| 위치 | 파일:줄 | 변수명 | 비고 |
|------|---------|--------|------|
| Cluster3 | `cluster3GrowthData.ts:151` | `d` | 정상 카운트 |
| Cluster4 | `cluster4WeeklyGrowthData.ts:222-234` | **(없음)** | **switch에 case 없음 — 무시됨** |
| Cluster1 | `cluster1ResumeData.ts:103-104` | `officialRestWeeks` | 정상 카운트 |

> **FINDING-01 [HIGH]**: `computeGrowthSummary()`의 switch문(줄 222-234)에 `case "official_rest"` 가 없다. `d`에 해당하는 행이 조용히 무시되어 `GrowthSummary` DTO에 공식 휴식 주차 수가 전혀 반영되지 않는다. `availableWeeks`(=e)는 정확하나, 전체 주차 수(`weeks.length`)와 `availableWeeks`의 차이를 UI에서 설명할 수 없다.

### e. 성장 가능 주차

| 위치 | 파일:줄 | 수식 | 변수명 |
|------|---------|------|--------|
| Cluster3 | `cluster3GrowthData.ts:183` | `a + b + c` | `e` |
| Cluster4 | `cluster4WeeklyGrowthData.ts:236` | `approvedWeeks + failedWeeks + restWeeks` | `availableWeeks` |
| Cluster1 | `cluster1ResumeData.ts:109` | `physicalWeeks - officialRestWeeks` | (분모로 사용) |

> **FINDING-02 [MED]**: Cluster1은 `e`를 `h - d`로 간접 계산하는데, Cluster3/4는 `a + b + c`로 직접 계산한다. 수학적으로 `a+b+c = (a+b+c+d) - d = h - d`이므로 **원천이 같다면** 동치. 그러나 Cluster1의 `h`(=`physicalWeeks`)는 날짜 산술 기반이고, Cluster3/4의 `h`는 행 카운트 기반이다. 따라서 **동일 사용자에게 e 값이 다를 수 있다** (7항 참조).

### f. 성장 휴식 시즌

| 위치 | 파일:줄 | 수식 |
|------|---------|------|
| Cluster3 | `cluster3GrowthData.ts:161` | `user_season_statuses` → `status === "rest"` → `f++` |
| Cluster4 | `cluster4WeeklyGrowthData.ts:199-201` | `user_season_statuses` → `.eq("status", "rest")` → `.length` |

**평가**: 로직 일치. 동일 원천 테이블, 동일 필터.

### g. 성장 성공 시즌

| 위치 | 파일:줄 | 수식 |
|------|---------|------|
| Cluster3 | `cluster3GrowthData.ts:162-163` | `else g++` (rest 아닌 시즌 카운트) |
| Cluster4 | — | **계산하지 않음** |
| Cluster1 | — | **계산하지 않음** |

> **FINDING-03 [LOW]**: `g`(성장 성공 시즌)는 Cluster3 `buildIndicators()`에서만 계산된다. GrowthPeriod DTO에 포함되어 API로 노출되지만, Cluster4의 `GrowthSummary`에는 대응 필드가 없다.

### h. 지나간 주차 (물리적 주차)

| 위치 | 파일:줄 | 계산 방식 | 변수명 |
|------|---------|----------|--------|
| Cluster3 | `cluster3GrowthData.ts:155` | `a + b + c + d` (행 합산) | `h` |
| Cluster4 | — | 명시적 계산 없음 (`weeks.length` 사용 가능) | — |
| Cluster1 | `cluster1ResumeData.ts:81-84` | `Math.floor((now - startDate) / msPerWeek)` (날짜 산술) | `physicalWeeks` |

> **FINDING-04 [HIGH]**: Cluster1의 `physicalWeeks`와 Cluster3의 `h`는 **다른 계산 방식**을 사용한다.
> - Cluster3: `user_week_statuses` 테이블 행 수 = 실제 기록된 주차
> - Cluster1: `(현재일 - 활동시작일) / 7일` = 경과 달력 주차
>
> 불일치 시나리오:
> - 시즌 휴식 신청 후 주차 행이 생성되지 않은 기간 → Cluster1 > Cluster3
> - 주차 행이 소급 생성된 경우 → 값이 같을 수도 다를 수도 있음
> - 현재 주차(running)가 아직 user_week_statuses에 없는 경우 → Cluster1 > Cluster3

---

## 2. 실제 원천 테이블

| 개념 | 원천 테이블 | 원천 컬럼 | 보조 테이블 |
|------|-----------|----------|-----------|
| a | `user_week_statuses` | `status = 'success'` | `user_growth_stats.approved_weeks` (사본) |
| b | `user_week_statuses` | `status = 'fail'` | — |
| c | `user_week_statuses` | `status = 'personal_rest'` | — |
| d | `user_week_statuses` | `status = 'official_rest'` | `official_rest_weeks` (정의), `weeks.is_official_rest` (플래그) |
| e | (계산) | a + b + c | — |
| h | (계산 또는 행 수) | a + b + c + d | `user_growth_stats.cumulative_weeks` (사본) |
| f | `user_season_statuses` | `status = 'rest'` | — |
| g | `user_season_statuses` | `status != 'rest'` | — |

> **FINDING-05 [MED]**: `d`(공식 휴식 주차)의 정의가 3중 원천을 갖는다:
> 1. `official_rest_weeks` — 명절(설/추석) 등 시스템 차원 정의
> 2. `weeks.is_official_rest` — 달력 규칙(봄/가을 6~8, 14~16주) + 명절 합산
> 3. `user_week_statuses.status = 'official_rest'` — 사용자 개인 기록
>
> `weeks.is_official_rest`는 시험기간(`exam_period`) 사유를 포함하고, `official_rest_weeks`는 명절만 정의한다. 달력 규칙 기반 공식 휴식(봄/가을 중간 휴식)은 `official_rest_weeks`에 없고 `weeks` 테이블에만 플래그가 있다. 사용자가 공식 휴식 주차에 활동하면 status가 'success'로 바뀌어 원천 간 불일치가 발생한다(`is_official_rest_override`로 추적).

---

## 3. 저장 여부

| 개념 | 저장 | 계산(on-the-fly) | 동기화 보장 |
|------|------|-----------------|-----------|
| a | `user_growth_stats.approved_weeks` | Cluster3, Cluster4, Cluster1, RPC | **없음** |
| b | — | Cluster3, Cluster4, Cluster1 | N/A |
| c | — | Cluster3, Cluster4, Cluster1 | N/A |
| d | — | Cluster3, Cluster1 | N/A |
| e | — | Cluster3, Cluster4 | N/A |
| h | `user_growth_stats.cumulative_weeks` | Cluster3, Cluster1 | **없음** |
| f | — | Cluster3, Cluster4 | N/A |
| g | — | Cluster3 | N/A |

> **FINDING-06 [HIGH]**: `a`(approved_weeks)와 `h`(cumulative_weeks)는 `user_growth_stats`에 저장되면서 동시에 최소 3곳에서 독립적으로 on-the-fly 계산된다. 동기화 트리거가 없다.
>
> 저장값 갱신은 오직 2곳에서만 발생:
> 1. `seasonRestValidation.ts:97-100` — 시즌 휴식 신청 시
> 2. `seasonRestValidation.ts:139-145` — 남은 주차 일괄 전환 시
>
> **일반적인 주차 상태 변경(예: fail→success)에는 user_growth_stats가 갱신되지 않는다.** 저장값과 계산값이 시간이 지나면 반드시 괴리된다.

---

## 4. 시즌 전환 주차 처리

### 캘린더 규칙 (`seasonCalendar.ts:49-61`)

```
시즌 끝 = 시작 + (seasonWeeks + 1주 전환) × 7일 - 1일
전환 주차 = weekNumber > seasonWeeks → CalendarWeekStatus = "transition"
```

전환 주차는 **직전 시즌에 귀속**된다 (endDate에 포함).

### 런타임 처리 (`cluster4WeeklyGrowthData.ts:140-144`)

```typescript
if (calendarStatus === "transition") {
  status = "transition";        // WeeklyGrowthStatus 전용값
  restReason = "transition";
}
```

### DB 처리

- `official_rest_weeks` 시드에 transition 사유 포함 가능 (`reason = 'transition'`)
- `user_week_statuses`에는 transition 상태 없음 (CHECK: success/fail/personal_rest/official_rest)
- `weeks.is_official_rest`에서 transition 주차는 **false** (migration backfill 시 제외)

> **FINDING-07 [MED]**: 전환 주차의 상태 처리 경로가 불투명하다.
> - `computeCurrentWeekInfo()`는 전환 주차를 `status: "transition"`으로 반환 (런타임 전용)
> - `user_week_statuses`에는 transition 상태가 CHECK 제약으로 존재할 수 없음
> - 전환 주차가 실제 사용자에게 어떤 status로 기록되는지 명시적 정책이 없다
> - 가능성: (1) official_rest로 기록, (2) 아예 행을 생성하지 않음, (3) personal_rest로 기록
> - 어느 경우든 `h` 카운트에 영향을 준다

---

## 5. 시즌 휴식 처리

### 시즌 전체 휴식 신청 (`seasonRestValidation.ts:14-103`)

**절차**:
1. `season_definitions`에서 시즌 존재 확인
2. 데드라인 검증: 시즌 시작일 + 7일 이내
3. `user_season_statuses` upsert → `status = 'rest'` (f 증가)
4. 해당 시즌 첫 주차 → `personal_rest` 전환 (a→c 또는 유지)
5. `user_growth_stats` 재집계

**영향 분석**:

| 변수 | 변동 | 비고 |
|------|------|------|
| a | 감소 가능 | 첫 주차가 success였으면 -1 |
| b | 변동 없음 | |
| c | 증가 가능 | 첫 주차 → personal_rest (+1) |
| d | 변동 없음 | |
| e | 변동 없음 | a↓ + c↑ 상쇄 |
| h | 변동 없음 | 총 행 수 불변 |
| f | +1 | 새 rest 시즌 |
| g | -1 | success 시즌 감소 |

### 남은 주차 일괄 전환 (`seasonRestValidation.ts:107-148`)

- 미래 주차 중 success/fail → personal_rest 일괄 전환
- a/b 감소, c 증가, e/h 불변

> **FINDING-08 [LOW]**: `convertRemainingToPersonalRest()`는 `user_season_statuses`를 갱신하지 않는다. 시즌 휴식 상태가 'rest'로 바뀌지 않으므로, f/g 카운트에 영향이 없다. 이것이 의도된 동작인지 불명확 — 2주차 이후 대안 경로이므로 시즌 자체를 '휴식'으로 분류하지 않는 정책일 수 있다.

---

## 6. Override 처리

### 스키마 (`2026-05-25_official_rest_weeks_and_override.sql:64-68`)

```sql
ALTER TABLE user_week_statuses
  ADD COLUMN is_official_rest_override boolean NOT NULL DEFAULT false;
-- '공식 휴식 주차이지만 활동이 인정되어 status=success로 기록된 경우 true. d가 아닌 a에 집계됨.'
```

### 계산 영향

| 변수 | Override 영향 |
|------|-------------|
| a | +1 (status='success'이므로 a에 포함) |
| d | -1 (status가 official_rest가 아니므로 d에서 제외) |
| e | +1 (a 증가) |
| h | 변동 없음 (총 행 수 불변) |

### 코드 반영 현황

| 위치 | Override 인식 | 처리 |
|------|-------------|------|
| Cluster3 `buildIndicators` | `is_official_rest_override` 조회 (줄 287) | 카운트만 추적 (`_debug.officialRestOverrideCount`), 분류에는 영향 없음 (이미 status='success') |
| Cluster4 `computeGrowthSummary` | 조회하지 않음 | status만으로 분류 — 정상 동작 (status='success') |
| Cluster4 `computeWeeklyCards` | 줄 559 | `status="official_rest" && is_official_rest=false` → fail로 재분류 (override와 무관한 별도 로직) |
| Cluster1 `computeScheduleReliability` | 조회하지 않음 | status만으로 분류 — 정상 동작 |

> **FINDING-09 [LOW]**: Override 처리 자체는 정상 동작한다 (DB에서 이미 status='success'로 변경되어 있으므로). 단, `_debug.officialRestOverrideCount`는 Cluster3에서만 추적되고, Cluster4/Cluster1에서는 override 존재 자체를 알 수 없다. 감사/디버깅 목적의 추적에 사각지대가 있다.

---

## 7. a+b+c+d=h 실제 보장 여부

### Cluster3 (`cluster3GrowthData.ts:145-155`)

```typescript
let a = 0, b = 0, c = 0, d = 0;
for (const row of weekRows) {
  switch (row.status) {
    case "success": a++; break;
    case "fail": b++; break;
    case "personal_rest": c++; break;
    case "official_rest": d++; break;
  }
}
const h = a + b + c + d;
```

**보장됨**: `h`가 `a+b+c+d`로 직접 계산됨. DB CHECK 제약에 의해 status는 4종 중 하나이므로 `h === weekRows.length`.

### Cluster4 (`cluster4WeeklyGrowthData.ts:218-236`)

```typescript
let approvedWeeks = 0, failedWeeks = 0, restWeeks = 0;
for (const w of weeks) {
  switch (w.status) {
    case "success": approvedWeeks++; break;
    case "fail": failedWeeks++; break;
    case "personal_rest": restWeeks++; break;
    // ← case "official_rest" 없음!
  }
}
const availableWeeks = approvedWeeks + failedWeeks + restWeeks;
```

> **FINDING-10 [HIGH]**: `h` 개념 자체가 Cluster4 `GrowthSummary`에 존재하지 않는다. `availableWeeks`는 `e`(=a+b+c)이지 `h`(=a+b+c+d)가 아니다. `a+b+c+d=h`를 보장하는 코드가 이 경로에 없다. `official_rest` 행은 카운트에서 완전히 누락된다.

### Cluster1 (`cluster1ResumeData.ts:81-84, 92-107`)

```typescript
const physicalWeeks = Math.floor((now - startDate) / msPerWeek);  // 날짜 산술
// ... (행 카운트로 a,b,c,d 별도 계산)
```

> **FINDING-11 [HIGH]**: `physicalWeeks`(h 역할)는 날짜 산술이고, `a+b+c+d`는 행 카운트이다. 동치가 보장되지 않는다.
>
> 구체적 불일치 시나리오:
> 1. **행 누락**: user_week_statuses에 기록되지 않은 주차가 있으면 `physicalWeeks > a+b+c+d`
> 2. **현재 주차**: 진행 중 주차는 아직 행이 없을 수 있음 → `physicalWeeks > a+b+c+d`
> 3. **시즌 휴식**: 시즌 전체 휴식 시 2주차 이후 행이 생성되지 않을 수 있음

---

## 8. a+b+c=e 실제 보장 여부

### Cluster3

```typescript
// cluster3GrowthData.ts:183
const period: GrowthPeriod = { a, b, c, d, e: a + b + c, h, f, g };
```

**보장됨**: 리터럴 수식으로 직접 대입.

### Cluster4

```typescript
// cluster4WeeklyGrowthData.ts:236
const availableWeeks = approvedWeeks + failedWeeks + restWeeks;
```

**보장됨**: 리터럴 수식으로 직접 대입. (`availableWeeks` = e 역할)

### Cluster1

Cluster1에는 명시적 `e` 변수가 없다. 일정 신뢰도 분모로 `physicalWeeks - officialRestWeeks`를 사용하는데, 이는 개념적으로 `h - d = e`와 동치이나 7항의 불일치로 인해 Cluster3/4의 `e`와 다를 수 있다.

> **결론**: a+b+c=e는 Cluster3, Cluster4에서 **구조적으로 보장**된다. Cluster1은 **간접 계산으로 보장되지 않는다**.

---

## 9. 중복 저장 여부

### 중복 저장 매트릭스

| 데이터 | 저장 위치 | 계산 위치 | 동기화 |
|--------|----------|----------|--------|
| `a` (approved_weeks) | `user_growth_stats` | Cluster3, Cluster4, Cluster1, RPC | `seasonRestValidation.ts`에서만 재집계 |
| `h` (cumulative_weeks) | `user_growth_stats` | Cluster3, Cluster1 | `seasonRestValidation.ts`에서만 재집계 |
| 공식 휴식 정의 | `official_rest_weeks` | — | 시드 데이터, 수동 관리 |
| 공식 휴식 플래그 | `weeks.is_official_rest` | — | backfill migration, 수동 관리 |
| 사용자별 공식 휴식 | `user_week_statuses.status` | — | 시드 또는 런타임 기록 |

> **FINDING-12 [HIGH]**: `approved_weeks`가 5곳에서 독립 산출된다 (위 1-a 참조). 저장값(`user_growth_stats`)은 시즌 휴식 신청 외에는 갱신되지 않으므로, 주차 상태가 수정되면 즉시 불일치가 발생한다.
>
> **FINDING-13 [MED]**: 공식 휴식 정의가 3중 원천을 가진다:
> - `official_rest_weeks`: 명절만 정의 (설, 추석)
> - `weeks.is_official_rest`: 달력 규칙(봄/가을 중간 휴식) + 명절 합산
> - `user_week_statuses.status='official_rest'`: 사용자별 개인 기록
>
> 달력 규칙 기반 공식 휴식(6~8주, 14~16주)은 `official_rest_weeks`에 행이 없다. 따라서 `computeCurrentWeekInfo()`에서 달력 규칙으로 감지한 공식 휴식은 `official_rest_weeks` 조회와 경로가 다르다.

---

## 10. 용어 충돌 여부

### 변수명 충돌 매트릭스

| 개념 | Cluster3 변수 | Cluster4 변수 | Cluster1 변수 | 충돌 수준 |
|------|-------------|-------------|-------------|----------|
| a | `a` | `approvedWeeks` | `approvedActiveWeeks` | LOW — 이름만 다름 |
| b | `b` | `failedWeeks` | `unapprovedActiveWeeks` | LOW — 이름만 다름 |
| c | `c` | `restWeeks` | `preRestWeeks` | **MED** — `restWeeks`가 모호 |
| d | `d` | **(없음)** | `officialRestWeeks` | **HIGH** — Cluster4에 개념 누락 |
| e | `e` | `availableWeeks` | (간접: `physicalWeeks - officialRestWeeks`) | **MED** — "available"의 의미가 문맥마다 다름 |
| h | `h` | **(없음)** | `physicalWeeks` | **HIGH** — 계산 방식 완전히 다름 |
| f | `f` | `restSeasonCount` | (없음) | LOW |
| g | `g` | **(없음)** | (없음) | LOW — Cluster3 전용 |

### 용어 충돌 상세

> **FINDING-14 [HIGH]**: `restWeeks`(Cluster4)는 `personal_rest`만 카운트하지만, 이름만으로는 `official_rest`까지 포함하는 것으로 오해할 수 있다. 실제로 `GrowthSummary` DTO의 `restWeeks` 필드를 소비하는 프론트엔드에서 이를 "총 휴식 주차"로 표시하면 d가 누락된 수치가 된다.

> **FINDING-15 [HIGH]**: `physicalWeeks`(Cluster1)와 `h`(Cluster3)는 동일한 개념("지나간 주차")을 표현하지만 계산 방식이 근본적으로 다르다:
> - Cluster1: `Math.floor((현재 - 활동시작일) / 7일)` — 날짜 산술
> - Cluster3: `COUNT(*) FROM user_week_statuses` — 행 카운트
>
> **동일 사용자에게 다른 값이 반환될 수 있다.**

> **FINDING-16 [MED]**: `availableWeeks`가 문맥마다 다른 의미로 사용된다:
> - `GrowthSummary.availableWeeks` = e (a+b+c, 성장 가능 주차)
> - `WeeklyCardDto.weeklyGrowth.availableLines` = 해당 주차 가용 라인 수
> - `ActivityCompletion.availableActivities` = 총 가용 활동 수
>
> "available"이라는 단어가 3가지 다른 차원(주차/라인/활동)에서 사용되어 혼란 유발.

> **FINDING-17 [HIGH]**: Cluster3와 Cluster1 Rulebook 간 **변수 문자 완전 역전**:
> - Cluster3: `a`=success, `b`=fail, `c`=personal_rest, `d`=official_rest
> - Cluster1 Rulebook: `a`=물리주차, `b`=사전휴식, `c`=미인정활동, `d`=인정활동, `e`=공식휴식
>
> **동일 문자가 완전히 다른 의미를 가진다.** 이 프로젝트에서 'a'라고 하면 어느 정의인지 문맥 없이 판별 불가.

---

## 종합 발견사항 요약

| # | 심각도 | 항목 | 내용 | 영향받는 파일 |
|---|--------|------|------|-------------|
| 01 | **HIGH** | d 누락 | `computeGrowthSummary` switch에 `official_rest` case 없음 | `cluster4WeeklyGrowthData.ts:222-234` |
| 04 | **HIGH** | h 불일치 | Cluster1 `physicalWeeks`(날짜산술) != Cluster3 `h`(행카운트) | `cluster1ResumeData.ts:81` vs `cluster3GrowthData.ts:155` |
| 06 | **HIGH** | 동기화 없음 | `user_growth_stats` 저장값과 on-the-fly 계산값 동기화 트리거 부재 | `seasonRestValidation.ts`, `cluster3GrowthData.ts` |
| 10 | **HIGH** | h 부재 | Cluster4 `GrowthSummary`에 h(물리적 주차) 개념 자체가 없음 | `cluster4WeeklyGrowthTypes.ts:117-126` |
| 11 | **HIGH** | h=a+b+c+d 미보장 | Cluster1에서 h와 a+b+c+d가 다른 산출 경로 | `cluster1ResumeData.ts:81-107` |
| 12 | **HIGH** | 5중 계산 | `approved_weeks`(a)가 5곳에서 독립 산출 | 다수 |
| 14 | **HIGH** | restWeeks 모호 | personal_rest만 카운트하나 이름이 전체 휴식 암시 | `cluster4WeeklyGrowthData.ts:220` |
| 15 | **HIGH** | physicalWeeks 충돌 | 동일 개념, 다른 계산법 | `cluster1ResumeData.ts` vs `cluster3GrowthData.ts` |
| 17 | **HIGH** | 변수 문자 역전 | Cluster3의 a/b/c/d와 Cluster1 Rulebook의 a/b/c/d가 완전히 다른 의미 | `cluster3GrowthTypes.ts` vs `cluster1ResumeTypes.ts` |
| 02 | **MED** | e 산출 경로 | Cluster1의 e는 h-d 간접계산, h 자체가 불일치 가능 | `cluster1ResumeData.ts:109` |
| 05 | **MED** | d 3중 원천 | 공식 휴식 정의가 3개 테이블에 분산 | `official_rest_weeks`, `weeks`, `user_week_statuses` |
| 07 | **MED** | 전환 주차 정책 | 전환 주차의 DB status 기록 정책 불명확 | `seasonCalendar.ts`, `cluster4WeeklyGrowthData.ts` |
| 13 | **MED** | 달력 vs DB 휴식 | 달력 규칙 공식 휴식은 official_rest_weeks에 없음 | `seasonCalendar.ts:119-122` |
| 16 | **MED** | available 다의어 | "available"이 주차/라인/활동 3차원에서 사용 | 다수 |
| 03 | **LOW** | g 편재 | 성장 성공 시즌(g)이 Cluster3에만 존재 | `cluster3GrowthData.ts:162` |
| 08 | **LOW** | 부분 휴식 상태 | `convertRemainingToPersonalRest`가 시즌 상태 미갱신 | `seasonRestValidation.ts:107` |
| 09 | **LOW** | override 추적 사각 | Override 카운트가 Cluster3 debug에서만 추적 | `cluster3GrowthData.ts:153` |

---

## 핵심 구조 다이어그램

```
user_week_statuses (원천)
  |- status CHECK: success | fail | personal_rest | official_rest
  |- is_official_rest_override: boolean
  '- season_key FK -> season_definitions

    +-------------------------------------------------------------+
    |                    소비자별 계산 경로                         |
    |                                                             |
    |  Cluster3 (buildIndicators)                                 |
    |    a = SUM(success)                                         |
    |    b = SUM(fail)                                            |
    |    c = SUM(personal_rest)                                   |
    |    d = SUM(official_rest)     <- 정상                       |
    |    e = a+b+c                 <- 보장                        |
    |    h = a+b+c+d               <- 보장                        |
    |                                                             |
    |  Cluster4 (computeGrowthSummary)                            |
    |    approvedWeeks = SUM(success)                              |
    |    failedWeeks   = SUM(fail)                                |
    |    restWeeks     = SUM(personal_rest)                       |
    |    (official_rest = 무시됨) <- !! FINDING-01                |
    |    availableWeeks = a+b+c  <- e만 계산, h 없음              |
    |                                                             |
    |  Cluster1 (computeScheduleReliability)                      |
    |    physicalWeeks = (now - startDate) / 7  <- 날짜 산술!     |
    |    approvedActiveWeeks  = SUM(success)                      |
    |    unapprovedActiveWeeks = SUM(fail)                        |
    |    preRestWeeks         = SUM(personal_rest)                |
    |    officialRestWeeks    = SUM(official_rest)                 |
    |    denominator = physicalWeeks - officialRestWeeks <- e!=a+b+c|
    |                                                             |
    |  user_growth_stats (저장)                                   |
    |    approved_weeks  <- 시즌휴식 시에만 동기화 !! FINDING-06  |
    |    cumulative_weeks <- 시즌휴식 시에만 동기화               |
    +-------------------------------------------------------------+

user_season_statuses (원천)
  |- status CHECK: success | rest
  |
  |  Cluster3: f = SUM(rest), g = SUM(non-rest)
  |  Cluster4: restSeasonCount = SUM(rest), g 없음
  '  Cluster1: 사용하지 않음
```

---

*본 보고서는 읽기 전용 감사이며, 코드 수정 및 migration을 포함하지 않습니다.*
