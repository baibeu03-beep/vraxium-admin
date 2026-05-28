# Growth Domain Technical Mapping Audit

**날짜**: 2026-05-28  
**대상**: 일정 신뢰도, 활동 완료율, 주차 성장률(k), 시즌 성공률(n)  
**범위**: 계산 함수, Rulebook 일치 여부, 원천 테이블, 저장 여부, API, UI, 중복/불일치

---

## 1. 일정 신뢰도

### Rulebook 공식
`(d + b) / (a - e) × 100`

| 변수 | 의미 | DB 컬럼 |
|------|------|---------|
| a | 물리 주차 | 날짜 산술 `(now - activity_started_at) / 7일` |
| b | 사전 휴식 | `user_week_statuses.status = 'personal_rest'` 행 수 |
| c | 미인정 활동 | `user_week_statuses.status = 'fail'` 행 수 |
| d | 인정 활동 | `user_week_statuses.status = 'success'` 행 수 |
| e | 공식 휴식 | `user_week_statuses.status = 'official_rest'` 행 수 |

### 계산 함수
`lib/cluster1ResumeData.ts:54-123` — `computeScheduleReliability(userId)`

```typescript
// line 109-112
const denominator = physicalWeeks - officialRestWeeks;  // a - e
const rate = Math.round(((approvedActiveWeeks + preRestWeeks) / denominator) * 100);  // (d+b)/(a-e)×100
```

### Rulebook 일치 여부
**일치** — `(approvedActiveWeeks + preRestWeeks) / (physicalWeeks - officialRestWeeks) × 100`

### 원천 테이블
| 테이블 | 용도 |
|--------|------|
| `user_week_statuses` | b, c, d, e 카운트 |
| `user_profiles.activity_started_at` | a 계산 기준 |

### 저장 여부
**비저장** — 매 요청 시 on-the-fly 계산

### API
| 메서드 | 경로 |
|--------|------|
| GET | `/api/admin/crews/[legacy_user_id]/resume-card/resume` |

### UI
`components/admin/ResumeCardEditor.tsx:789-852` — 일정 신뢰도 섹션

### 위험 사항

| 위험도 | 항목 | 설명 |
|--------|------|------|
| **HIGH** | 변수명 충돌 (Cluster3 vs Cluster1) | `cluster3GrowthData.ts:145`에서 a=success, b=fail, c=personal_rest, d=official_rest. Rulebook에서는 a=물리주차, d=인정활동. **동일 문자가 완전히 다른 의미**. |
| **MED** | physicalWeeks(a) 산출 불일치 | 본 함수는 **날짜 산술** (`Math.floor((now-start)/7일)`), 검증 스크립트 `simulate-resume-dto.ts:25`와 `verify-resume-card.ts:63`은 **행 수** (`rows.length`). 동일 사용자에 대해 값이 다를 수 있음. |
| **LOW** | `is_official_rest_override` 미반영 | 해당 플래그가 true인 행은 `status='success'`이지만 실제로는 공식 휴식. `computeScheduleReliability`는 status만 보므로 d에 가산(e 미가산). 미미한 수치 왜곡 가능. |

---

## 2. 활동 완료율

### Rulebook 공식
`전체 기간 동안 이행한 라인 수 / 전체 기간 동안 개설된 라인 수 × 100`

> **지표 단위 정리**: 활동 완료율은 **전체 기간 누적** 지표이다. 주차 성장률(k)은 주차 단위, 시즌 성공률(n)은 시즌 단위.

### 계산 경로 — 2개 존재

#### 경로 A: Resume (누적 — Rulebook 정의와 일치)
`lib/cluster1ResumeData.ts:141-193` — `computeActivityCompletion(userId, organization)`

```typescript
// line 190
Math.round((completedActivities / availableActivities) * 1000) / 10
```

| 항목 | 구현 |
|------|------|
| 분자 (이행 라인) | `user_activity_details` 전체 행 수 (모든 주차 합산) |
| 분모 (가용 라인) | 비휴식 주차 × `buildWeekAvailability()` 합산 |
| 반올림 | `Math.round(x*1000)/10` → 소수 1자리 |
| 범위 | **전체 기간 누적** (Rulebook 정의와 일치) |

#### 경로 B: Weekly Growth (주차별 — 실질적으로 주차 성장률 k와 동일)
`lib/cluster4WeeklyGrowthData.ts:586-596` — `computeWeeklyCards()` 내부

```typescript
// line 596
const rate = ceilGrowthRate(completedLines, availableLines);
// ceilGrowthRate: Math.ceil((completed / available) * 100)
```

| 항목 | 구현 |
|------|------|
| 분자 (이행 라인) | 해당 주차 `user_activity_details` 행을 info/ability/experience/career로 분류 후 합산 |
| 분모 (가용 라인) | 해당 주차 `buildWeekAvailability()` |
| 반올림 | `Math.ceil` → 올림 정수 |
| 범위 | **주차 단위** (활동 완료율이 아니라 주차 성장률 k에 해당) |

### 가용 라인 산출 (공통 모듈)
`lib/lineAvailability.ts:80-94` — `buildWeekAvailability()`

| 카테고리 | 가용 라인 수 | 원천 |
|----------|-------------|------|
| a (실무 정보) | **동적** | `cluster4_lines(part_type='info', is_active=true)` + `cluster4_line_targets(target_mode='user', target_user_id)` |
| b (실무 역량) | **고정 1** | `ABILITY_AVAILABLE = 1` |
| c (실무 경험) | **고정 2** | `getExperienceAvailable(org)` — 모든 조직 2 |
| d (실무 경력) | **동적, 최대 5** | `career_project_weeks(is_active=true)`, `Math.min(5, count)` |

### Rulebook 일치 여부

| 경로 | 일치 여부 | 상세 |
|------|-----------|------|
| 경로 A (Resume) | **일치** | Rulebook은 "전체 기간 누적"을 명시하며, 경로 A는 전 주차 누적 합산으로 정의에 부합. 반올림만 소수 1자리(Rulebook은 정수 기대)로 미세 차이. |
| 경로 B (Weekly) | **별개 지표** | 주차 단위 계산이므로 활동 완료율이 아니라 주차 성장률(k)과 동일한 지표. |

### 원천 테이블
| 테이블 | 용도 |
|--------|------|
| `user_activity_details` | 이행 라인 수 (분자) |
| `user_week_statuses` | 휴식 주차 필터링 |
| `weeks` | 주차 ID 해석 |
| `cluster4_lines` + `cluster4_line_targets` | 실무 정보 가용 라인 |
| `career_project_weeks` | 실무 경력 가용 라인 |

### 저장 여부
**비저장** — 양쪽 경로 모두 on-the-fly 계산

### API
| 경로 | 메서드 | API |
|------|--------|-----|
| Resume (A) | GET | `/api/admin/crews/[legacy_user_id]/resume-card/resume` |
| Weekly (B) admin | GET | `/api/admin/crews/[legacy_user_id]/cluster4/weekly-growth` |
| Weekly (B) user | GET | `/api/cluster4/weekly-growth` |

### UI
| 경로 | 컴포넌트 | 위치 |
|------|----------|------|
| Resume | `ResumeCardEditor.tsx:855-902` | 활동 완료율 섹션 |
| Weekly | `Cluster4Editor.tsx:769-781` | 주차별 카드 성장률 |

### 위험 사항

| 위험도 | 항목 | 설명 |
|--------|------|------|
| **MED** | 경로 B가 "활동 완료율"로 라벨링됨 | 경로 B(주차별)는 실질적으로 주차 성장률(k)과 동일한 지표이나, UI/코드에서 "활동 완료율"로 표시될 수 있음. 활동 완료율은 전체 기간 누적 지표이므로 라벨 혼선 주의. |
| **LOW** | 반올림 차이 | 경로 A는 `Math.round` 소수1자리, Rulebook은 정수를 기대. 미세 차이. |
| **LOW** | 검증 스크립트 `verify-cluster4-full.ts:272`가 `successWeeks/growableWeeks`로 계산 | 주차 성공률이지 라인 완료율이 아님. 레이블은 "활동 완료율"이나 실제는 다른 지표. |

---

## 3. 주차 성장률(k)

### Rulebook 공식
`(a' + b' + c' + d') / (a + b + c + d) × 100`  
p, q, r, s는 k 계산에 직접 사용하지 않음.

### 변수 매핑

| Rulebook | 의미 | 코드 변수 |
|----------|------|-----------|
| a | 실무 정보 가용 | `lineBreakdown.info.available` |
| b | 실무 역량 가용 | `lineBreakdown.ability.available` |
| c | 실무 경험 가용 | `lineBreakdown.experience.available` |
| d | 실무 경력 가용 | `lineBreakdown.career.available` |
| a' | 실무 정보 이행 | `lineBreakdown.info.completed` |
| b' | 실무 역량 이행 | `lineBreakdown.ability.completed` |
| c' | 실무 경험 이행 | `lineBreakdown.experience.completed` |
| d' | 실무 경력 이행 | `lineBreakdown.career.completed` |

### 계산 함수
`lib/cluster4WeeklyGrowthData.ts:586-596`

```typescript
const completedLines = info.completed + ability.completed + experience.completed + career.completed;
const availableLines = info.available + ability.available + experience.available + career.available;
const rate = ceilGrowthRate(completedLines, availableLines);
```

`lib/lineAvailability.ts:100-101`

```typescript
export function ceilGrowthRate(completed: number, available: number): number {
  return available === 0 ? 0 : Math.ceil((completed / available) * 100);
}
```

### Rulebook 일치 여부
**일치** — `ceil((a'+b'+c'+d') / (a+b+c+d) × 100)`

### p, q, r, s 오염 여부
**오염 없음** — `user_weekly_points.points/advantages/penalty`는 `totalFmScore` 계산(line 516)에만 사용. `weeklyGrowth.rate`와 완전히 분리된 경로.

### 원천 테이블
| 테이블 | 용도 |
|--------|------|
| `user_activity_details` | 분자 (이행 라인 — week_id 기준 분류) |
| `cluster4_lines` | activity_type → part_type 매핑 |
| `cluster4_line_targets` | 실무 정보 가용 라인 (분모) |
| `career_project_weeks` | 실무 경력 가용 라인 (분모) |
| `user_week_statuses` | 휴식 주차 판별 (휴식 시 0/0) |

### 저장 여부
**비저장** — on-the-fly 계산

### API
| 메서드 | 경로 |
|--------|------|
| GET | `/api/admin/crews/[legacy_user_id]/cluster4/weekly-growth` |
| GET | `/api/cluster4/weekly-growth` |

### UI
`components/admin/Cluster4Editor.tsx:756-799`
- 주차 성장률: `{c.weeklyGrowth.rate}%`
- 카테고리별: `info/ability/experience/career` 각 `completed/available`

### 위험 사항

| 위험도 | 항목 | 설명 |
|--------|------|------|
| **NONE** | Rulebook 일치 | 공식, 변수, p/q/r/s 분리 모두 정확 |

---

## 4. 시즌 성공률(n)

### Rulebook 공식
`시즌 전체 이행 라인 수 / 시즌 전체 라인 수 × 100`  
주차 성장률(k)은 시즌 성공률(n)에 직접 반영하지 않음.

### 계산 함수
`lib/cluster4WeeklyGrowthData.ts:641-661` — `computeSeasonGrowthRates(cards)`

```typescript
// 시즌 성장률: 주차별 평균이 아니라 시즌 전체 합산 기반
for (const c of cards) {
  s.completed += c.weeklyGrowth.completedLines;   // 시즌 내 모든 주차 이행 라인 합산
  s.available += c.weeklyGrowth.availableLines;    // 시즌 내 모든 주차 가용 라인 합산
}
rate = ceilGrowthRate(v.completed, v.available);   // ceil(합산이행/합산가용 × 100)
```

### Rulebook 일치 여부
**일치** — SUM(주차별 이행 라인) / SUM(주차별 가용 라인) × 100. k 평균이 아닌 원시 라인 합산.

### k 평균 오용 여부
**오용 없음** — 코드 주석에도 명시: `"주차별 평균이 아니라 시즌 전체 합산 기반"`. 주차별 `.rate` 값을 평균하는 코드는 존재하지 않음.

### 원천 테이블
주차 성장률(k)과 동일한 테이블 사용. 시즌 단위로 집계.

### 저장 여부
**비저장** — on-the-fly 계산. `user_season_statuses`에는 `status('success'/'rest')` 플래그만 저장.

### API
주차 성장률과 동일 API에서 `seasonGrowthRates[]`로 반환.

### UI
**미렌더링** — API 응답에 포함되지만 현재 UI에 표시하는 컴포넌트 없음.

### 위험 사항

| 위험도 | 항목 | 설명 |
|--------|------|------|
| **HIGH** | "시즌 성공률" 3중 의미 혼선 | 동일 용어가 코드베이스 내 **3가지 다른 의미**로 사용됨 (아래 상세) |
| **MED** | UI 미렌더링 | `seasonGrowthRates`가 계산·반환되지만 어떤 컴포넌트에도 표시되지 않음 |

---

## 5. 활동 완료율 vs 주차 성장률 — 같은 값인가?

### 결론: **서로 다른 단위의 지표이며, 경로 B는 주차 성장률(k)과 동일**

| 비교 항목 | 활동 완료율 — Resume 경로 (A) | 주차 성장률 (k) | Weekly 경로 (B) |
|-----------|------------------------------|----------------|------------------------------|
| 공식 | `round(completed/available × 1000)/10` | `ceil(completed/available × 100)` | `ceil(completed/available × 100)` |
| 범위 | **전체 기간 누적** | 주차 단위 | 주차 단위 |
| 분자 | 전 주차 이행 라인 합 | 해당 주차 이행 라인 | 해당 주차 이행 라인 |
| 분모 | 전 주차 가용 라인 합 | 해당 주차 가용 라인 | 해당 주차 가용 라인 |
| 반올림 | round (반올림, 소수1자리) | ceil (올림) | ceil (올림) |
| Rulebook 지표 | **활동 완료율** | **주차 성장률(k)** | 주차 성장률(k)과 동일 |

**활동 완료율(경로 A)은 전체 기간 누적 지표이고, 주차 성장률(k)은 주차 단위 지표이므로 본질적으로 다른 지표이다.** Weekly 경로(B)는 주차 성장률(k)과 같은 함수 `ceilGrowthRate()`를 호출하여 동일한 값을 산출하며, "활동 완료율"이 아니라 "주차 성장률"로 분류하는 것이 정확하다.

---

## 6. 시즌 성공률 용어 혼선 상세

| 위치 | 함수 | 계산 내용 | 실제 의미 |
|------|------|-----------|-----------|
| Cluster4 `computeSeasonGrowthRates` | `ceil(SUM(이행라인) / SUM(가용라인) × 100)` | **라인 기반 시즌 성공률** | Rulebook의 n |
| Cluster3 `buildIndicators` | `COUNT(user_season_statuses WHERE status='rest')` → f, 나머지 → g | **시즌 수 카운트** | f/g 지표 (성공률이 아님) |
| Cluster1 `computeSeasonRecords` | `approvedWeeks / totalWeeks` per season | **주차 기반 시즌 기록** | 시즌별 인정 주차 비율 |

**"시즌 성공률"이라는 동일 용어가 3곳에서 서로 다른 계산을 수행한다.** Cluster4만이 Rulebook 공식과 일치한다.

---

## 7. 동일 의미를 다른 이름으로 계산하는 경로

| 의미 | 경로 1 | 경로 2 | 차이 |
|------|--------|--------|------|
| 주차별 라인 완료율 | `cluster4WeeklyGrowthData.ts:596` — `weeklyGrowth.rate` (주차 성장률 k) | `cluster1ResumeData.ts:190` — `activityCompletion.rate` (누적 활동 완료율) | **다른 지표**: k는 주차 단위, 활동 완료율은 전체 기간 누적. 반올림도 `ceil` vs `round` |
| physicalWeeks (a) | `cluster1ResumeData.ts:81` — 날짜 산술 | `simulate-resume-dto.ts:25` — `rows.length` | 산출 방식 |
| 주차 상태 카운트 a/b/c/d | `cluster3GrowthData.ts:145` — a=success, b=fail, c=personal_rest, d=official_rest | `cluster1ResumeData.ts:92` — a=물리주차, b=personal_rest, c=fail, d=success | **변수명 완전 역전** |

---

## 8. 전체 위험도 요약

| # | 위험도 | 지표 | 항목 | 영향 |
|---|--------|------|------|------|
| 1 | **HIGH** | 일정 신뢰도 / 전체 | **변수명 a/b/c/d 충돌** | Cluster3(a=success)과 Cluster1/Rulebook(a=물리주차)에서 동일 문자가 반대 의미. 유지보수 시 혼동 유발. |
| 2 | **MED** | 활동 완료율 | **경로 B 라벨 혼선** | 경로 B(주차별)는 실질적으로 주차 성장률(k)이나 "활동 완료율"로 라벨링될 수 있음. 활동 완료율(경로 A)은 전체 기간 누적 지표로 Rulebook과 일치. |
| 3 | **HIGH** | 시즌 성공률 | **"시즌 성공률" 3중 의미** | Cluster4(라인 기반), Cluster3(시즌 수), Cluster1(주차 비율)이 같은 용어로 다른 것을 계산. |
| 4 | **MED** | 일정 신뢰도 | **physicalWeeks 산출 불일치** | 본 함수(날짜 산술) vs 스크립트(행 수). |
| 5 | **MED** | 시즌 성공률 | **UI 미렌더링** | `seasonGrowthRates` 계산됨/API 반환됨이나 화면 없음. |
| 6 | **LOW** | 일정 신뢰도 | **`is_official_rest_override` 미반영** | override 행이 e 대신 d로 가산. |
| 7 | **LOW** | 활동 완료율 | **검증 스크립트 레이블 오류** | `verify-cluster4-full.ts`가 주차 성공률을 "활동 완료율"로 라벨링. |

---

## 9. 지표별 요약 매트릭스

| 항목 | 일정 신뢰도 | 활동 완료율 | 주차 성장률(k) | 시즌 성공률(n) |
|------|-------------|-------------|----------------|----------------|
| Rulebook 일치 | **일치** | 경로A **일치** (누적) / 경로B는 별개 지표(=k) | **일치** | **일치** |
| 계산 함수 | `cluster1ResumeData.ts:54` | A:`cluster1ResumeData.ts:141` B:`cluster4WeeklyGrowthData.ts:586` | `cluster4WeeklyGrowthData.ts:586` + `lineAvailability.ts:100` | `cluster4WeeklyGrowthData.ts:641` |
| 원천 테이블 | `user_week_statuses`, `user_profiles` | `user_activity_details`, `cluster4_lines`, `cluster4_line_targets`, `career_project_weeks` | 좌동 | 좌동 (시즌 집계) |
| 저장 | 비저장 | 비저장 | 비저장 | 비저장 |
| API | resume-card/resume | resume(A), weekly-growth(B) | weekly-growth | weekly-growth |
| UI 표시 | ResumeCardEditor | ResumeCardEditor(A), Cluster4Editor(B) | Cluster4Editor | **없음** |
| 중복 경로 | 없음 | 경로A만 해당 (경로B는 k와 동일) | 없음 | 3곳 다른 의미 |
| p,q,r,s 분리 | N/A | N/A | **정확 분리** | N/A |
| k 평균 미사용 | N/A | N/A | N/A | **정확 (합산 기반)** |
