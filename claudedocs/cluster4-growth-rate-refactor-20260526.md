# Cluster4 주차 성장률 계산 기준 정리 + 불일치 개선 보고서

> 작성일: 2026-05-26

---

## 1. 삭제/수정 파일 목록

| 파일 | 작업 | 내용 |
|------|------|------|
| `lib/cluster4WeeklyDummyData.ts` | **삭제** | dead code (import 0건), 442줄 제거 |
| `lib/lineAvailability.ts` | **신규** | 공통 계산 모듈 (config + batch query + rate helper) |
| `lib/cluster4WeeklyGrowthTypes.ts` | 수정 | `SeasonGrowthRate` 타입 추가, `WeeklyGrowthDto`에 `seasonGrowthRates` 필드 추가 |
| `lib/cluster4WeeklyGrowthData.ts` | 수정 | `STANDARD_LINE_AVAILABLE` 제거, 동적 가용 라인 조회, 시즌 성장률 계산 추가 |
| `lib/cluster1ResumeData.ts` | 수정 | `LINES_PER_WEEK` 제거, `lineAvailability` 모듈 사용으로 전환 |
| `scripts/verify-resume-card.ts` | 수정 | `LINES_PER_WEEK` → `LINES_PER_WEEK_APPROX` (근사치 명시) |
| `components/admin/ResumeCardEditor.tsx` | 수정 | "Cluster4 연동 전 더미" → "Cluster4 실데이터 연동" (2곳) |

---

## 2. STANDARD_LINE_AVAILABLE 사용 위치 (제거 전)

| 파일 | 위치 | 용도 | 조치 |
|------|------|------|------|
| `lib/cluster4WeeklyGrowthData.ts:313-318` | 상수 정의 | info:7, ability:1, exp:2, career:2 | **제거** → `lineAvailability` 동적 조회 |
| `lib/cluster4WeeklyGrowthData.ts:348` | `classifyActivityType()` 반환 타입 | `keyof typeof STANDARD_LINE_AVAILABLE` | **변경** → `LineCategory` |
| `lib/cluster4WeeklyGrowthData.ts:577-591` | lineBreakdown 조립 | `.available = STANDARD_LINE_AVAILABLE.xxx` (4곳) | **변경** → `buildWeekAvailability()` |
| `lib/cluster1ResumeData.ts:134` | `LINES_PER_WEEK = 12` | 활동 완료율 분모 | **제거** → 주차별 동적 합산 |
| `scripts/verify-resume-card.ts:12` | `LINES_PER_WEEK = 12` | 검증 스크립트 | **변경** → 근사치 명시 |

---

## 3. 새 계산 기준

### 주차 성장률 k

```
k = ceil( (a' + b' + c' + d') / (a + b + c + d) × 100 )
```

| 변수 | 의미 | Source of Truth |
|------|------|----------------|
| a | 실무 정보 가능 라인 수 | `cluster4_lines` (part_type='info', is_active=true) → `cluster4_line_targets` (target_mode='user', target_user_id=userId, week_id) |
| a' | 실무 정보 이행 라인 수 | `user_activity_details` (activity_types.cluster_id 분류 → info) |
| b | 실무 역량 가능 라인 수 | 고정값 **1** (`lineAvailability.ABILITY_AVAILABLE`) |
| b' | 실무 역량 이행 라인 수 | `user_activity_details` (분류 → ability) |
| c | 실무 경험 가능 라인 수 | 조직별 설정값 (`lineAvailability.getExperienceAvailable()`) — EC 기본 **2** |
| c' | 실무 경험 이행 라인 수 | `user_activity_details` (분류 → experience) |
| d | 실무 경력 가능 라인 수 | `min(5, career_project_weeks.count(week_id, is_active=true))` |
| d' | 실무 경력 이행 라인 수 | `user_activity_details` (분류 → career) |

- 소수점은 항상 **올림** (`Math.ceil`)
- 휴식 주차 (personal_rest, official_rest): a=b=c=d=0, a'=b'=c'=d'=0

### 시즌 성장률

```
시즌 성장률 = ceil( Σ(시즌 내 모든 주차 이행 라인) / Σ(시즌 내 모든 주차 가용 라인) × 100 )
```

주차별 성장률의 평균이 **아닌**, 시즌 전체 합산 기반.

### 파트별 표시 기준

카드에는 파트별 백분율을 표시하지 않음. 갯수만 표시:

```
실무 정보   a'/a  (예: 1/7)
실무 역량   b'/b  (예: 1/1)
실무 경험   c'/c  (예: 1/2)
실무 경력   d'/d  (예: 1/5)
```

카드 메인 백분율은 k만 표시.

---

## 4. Source of Truth 테이블 정리

| 지표 | 테이블 | 비고 |
|------|--------|------|
| a (정보 가용) | `cluster4_lines` + `cluster4_line_targets` | part_type='info', target_mode='user' |
| b (역량 가용) | 설정값 (코드 상수) | `ABILITY_AVAILABLE = 1` |
| c (경험 가용) | 설정값 (코드 상수) | `getExperienceAvailable(org)` — encre/oranke/phalanx 각 2 |
| d (경력 가용) | `career_project_weeks` | is_active=true, cap 5 |
| a'/b'/c'/d' (이행) | `user_activity_details` + `activity_types` | cluster_id 기반 분류 |
| 주차 성장률 k | 계산값 (백엔드) | `ceilGrowthRate(completed, available)` |
| 시즌 성장률 | 계산값 (백엔드) | `computeSeasonGrowthRates(weeklyCards)` |
| 라인 상태 | `cluster4_line_targets` + `cluster4_line_submissions` | void/pending/success/fail |
| 실무 경험 평점 | `user_activity_details.rating` | work_exp only, 0-10 |
| 실무 경력 평점 | `career_records.grade` | S/A/B/C/D |
| 평점 → 포인트 환산 | **미구현** | 기획 문서 `rating*3` vs 현 FM공식 `pts+adv*3-pen*5` 차이 미해결 |

---

## 5. 공통 계산 함수 위치

**`lib/lineAvailability.ts`** (신규 모듈)

| export | 용도 |
|--------|------|
| `ABILITY_AVAILABLE` | 역량 가용 상수 (1) |
| `CAREER_DISPLAY_CAP` | 경력 표시 상한 (5) |
| `getExperienceAvailable(org)` | 조직별 경험 가용 수 |
| `fetchInfoLineCountsByWeek(userId, weekIds)` | 주차별 정보 라인 개설 수 batch 조회 |
| `fetchCareerProjectCountsByWeek(weekIds)` | 주차별 활성 경력 프로젝트 수 batch 조회 |
| `buildWeekAvailability(weekId, infoMap, careerMap, org)` | 4파트 가용 라인 조립 |
| `totalAvailable(avail)` | 4파트 합산 |
| `ceilGrowthRate(completed, available)` | 올림 백분율 계산 |

**사용처:**
- `lib/cluster4WeeklyGrowthData.ts` — 주차 카드 + 시즌 성장률
- `lib/cluster1ResumeData.ts` — 활동 완료율

---

## 6. API/DTO 변경 사항

### WeeklyGrowthDto (변경)

```typescript
// BEFORE
type WeeklyGrowthDto = {
  currentWeekInfo: CurrentWeekInfo;
  growthSummary: GrowthSummary;
  weeklyCards: WeeklyCardDto[];
};

// AFTER
type WeeklyGrowthDto = {
  currentWeekInfo: CurrentWeekInfo;
  growthSummary: GrowthSummary;
  weeklyCards: WeeklyCardDto[];
  seasonGrowthRates: SeasonGrowthRate[];  // NEW
};
```

### SeasonGrowthRate (신규)

```typescript
type SeasonGrowthRate = {
  seasonKey: string;       // "2026-spring"
  seasonLabel: string;     // "2026년도 봄시즌"
  totalCompleted: number;  // 시즌 전체 이행 라인 합
  totalAvailable: number;  // 시즌 전체 가용 라인 합
  rate: number;            // ceil(completed/available * 100)
};
```

### WeeklyCardDto — 변경 없음

`weeklyGrowth.rate`, `lineBreakdown` 구조 동일. 값만 동적으로 변경.

---

## 7. Before/After 샘플

### 주차 카드 lineBreakdown (info 라인 7개 개설, 경력 프로젝트 3개 활성)

**BEFORE (하드코딩):**
```json
{
  "info": { "completed": 5, "available": 7 },
  "ability": { "completed": 1, "available": 1 },
  "experience": { "completed": 1, "available": 2 },
  "career": { "completed": 1, "available": 2 }
}
// rate = ceil(8/12 * 100) = 67%
```

**AFTER (동적):**
```json
{
  "info": { "completed": 5, "available": 7 },
  "ability": { "completed": 1, "available": 1 },
  "experience": { "completed": 1, "available": 2 },
  "career": { "completed": 1, "available": 3 }
}
// rate = ceil(8/13 * 100) = 62%
```

### 주차 카드 lineBreakdown (info 라인 0개 개설, 경력 프로젝트 0개)

**AFTER (동적, 라인 미개설):**
```json
{
  "info": { "completed": 0, "available": 0 },
  "ability": { "completed": 1, "available": 1 },
  "experience": { "completed": 1, "available": 2 },
  "career": { "completed": 0, "available": 0 }
}
// rate = ceil(2/3 * 100) = 67%
```

---

## 8. 어드민/사용자 앱 값 일치 검증

| 항목 | 검증 결과 |
|------|----------|
| 어드민 API `/api/admin/crews/[id]/cluster4/weekly-growth` | `getWeeklyGrowth()` 호출 → 동일 계산 경로 |
| 사용자 API `/api/cluster4/weekly-growth` | `getWeeklyGrowthByUserId()` → `getWeeklyGrowth()` 호출 → 동일 계산 경로 |
| 계산 함수 공유 | `computeWeeklyCards()`, `computeSeasonGrowthRates()` 동일 사용 |
| lineAvailability 모듈 | 어드민/사용자 API 모두 동일 모듈에서 가용 라인 수 조회 |
| 프론트 계산 없음 | `Cluster4Editor.tsx`는 DTO 값 표시만 수행, 자체 계산 없음 |

---

## 9. Build/Typecheck 결과

```
npx tsc --noEmit  → 0 errors
npx next build    → 0 errors, 0 warnings
```
