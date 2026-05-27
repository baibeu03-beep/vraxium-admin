# 서비스 핵심 지표 — 일괄 데이터 흐름 감사 보고서

> 감사일: 2026-05-27
> 범위: 15개 핵심 지표
> 제한: 코드 수정 없음 / 읽기 전용 감사

---

## 1. 지표별 데이터 흐름 상세표

### M01 — 일정 신뢰도

| 항목 | 내용 |
|---|---|
| **ID** | M01 |
| **지표명** | 일정 신뢰도 (Schedule Reliability) |
| **한줄 설명** | 사용자가 활동 가능 주차 대비 얼마나 성실하게 참여했는지의 비율 |
| **도메인** | Cluster1 Resume / Cluster3 Growth |
| **생산자** | `computeScheduleReliability()` |
| **계산식** | `((d + b) / (a - e)) × 100` — d=인정주차, b=사전휴식, a=물리주차, e=공식휴식 |
| **원천 데이터** | `user_week_statuses.status` (4종 COUNT), `user_profiles.activity_started_at` (Date 차이 → a) |
| **저장 테이블** | 없음 |
| **저장 컬럼** | 없음 |
| **API** | `getCluster1Resume()` → Resume Card API |
| **사용 화면** | `ResumeCardEditor.tsx:789-852` |
| **상태** | 구현 완료 (on-the-fly) |
| **중복 의심** | `cluster3GrowthData.ts`의 변수 a/b/c/d가 **다른 의미**로 사용됨 (아래 비고 참조) |
| **비고** | `a` 산출 방식이 2곳에서 다름: (1) Resume: `Date.now() - activity_started_at` 시간차 (2) Cluster3: `user_week_statuses` row 합산 `h=a+b+c+d`. 동일 사용자에서 값 불일치 가능 |

---

### M02 — 활동 완료율

| 항목 | 내용 |
|---|---|
| **ID** | M02 |
| **지표명** | 활동 완료율 (Activity Completion Rate) |
| **한줄 설명** | 가용 활동 라인 대비 실제 이행한 활동의 비율 |
| **도메인** | Cluster1 Resume / Cluster4 Weekly |
| **생산자** | (Resume) `computeActivityCompletion()` / (Weekly) `computeWeeklyCards()` |
| **계산식** | Resume: `Math.round((completed / available) × 1000) / 10` (소수점 1자리) / Weekly: `ceilGrowthRate(completed, available)` (올림 정수) |
| **원천 데이터** | `user_activity_details` (completed COUNT), `user_week_statuses` (growable 주차 필터), `weeks.id` (주차 ID), `cluster4_lines` + `cluster4_line_targets` (정보 가용), `career_project_weeks` (경력 가용), 코드 상수 (역량=1, 경험=org별 2) |
| **저장 테이블** | 없음 |
| **저장 컬럼** | 없음 |
| **API** | Resume: `getCluster1Resume()` / Weekly: `/api/admin/crews/[id]/cluster4/weekly-growth`, `/api/cluster4/weekly-growth` |
| **사용 화면** | `ResumeCardEditor.tsx:855-` (Resume), `Cluster4Editor.tsx` (Weekly per-card) |
| **상태** | 구현 완료 (on-the-fly) |
| **중복 의심** | Resume 경로와 Cluster4 경로에서 **서로 다른 함수**가 같은 이름의 값을 계산. 반올림 방식도 다름 (round vs ceil) |
| **비고** | Resume 경로 `cluster1ResumeData.ts:141-194`는 누적 합산. Cluster4 경로 `cluster4WeeklyGrowthData.ts:586-596`은 주차별 개별 계산. 가용 라인은 `lineAvailability.ts` 공통 모듈에서 동적 산출 |

---

### M03 — 주차 성장률

| 항목 | 내용 |
|---|---|
| **ID** | M03 |
| **지표명** | 주차 성장률 (Weekly Growth Rate) |
| **한줄 설명** | 특정 주차에서 가용 활동 라인 대비 완료한 비율 |
| **도메인** | Cluster4 Weekly |
| **생산자** | `computeWeeklyCards()` 내부 |
| **계산식** | `ceilGrowthRate(completedLines, availableLines)` = `ceil((completed / available) × 100)` |
| **원천 데이터** | `user_activity_details` (completed per week), `activity_types.cluster_id` (카테고리 분류), `cluster4_lines` + `cluster4_line_targets` (정보 가용), `career_project_weeks` (경력 가용), 코드 상수 (역량/경험) |
| **저장 테이블** | 없음 |
| **저장 컬럼** | 없음 |
| **API** | `/api/admin/crews/[id]/cluster4/weekly-growth`, `/api/cluster4/weekly-growth` |
| **사용 화면** | `Cluster4Editor.tsx` (주차 카드 내 rate 표시) |
| **상태** | 구현 완료 (on-the-fly) |
| **중복 의심** | 없음 — 단일 계산 경로 |
| **비고** | `lineAvailability.ts:100-101`의 `ceilGrowthRate()` 공통 함수 사용. `WeeklyCardDto.weeklyGrowth.rate`로 반환 |

---

### M04 — 시즌 성공률

| 항목 | 내용 |
|---|---|
| **ID** | M04 |
| **지표명** | 시즌 성공률 (Season Growth Rate) |
| **한줄 설명** | 시즌 전체 기간 동안의 활동 완료 비율 (주차별 합산 기반) |
| **도메인** | Cluster4 Weekly / Cluster3 Growth (시즌 카운트) |
| **생산자** | (비율) `computeSeasonGrowthRates()` / (카운트) `buildIndicators()` |
| **계산식** | 비율: `ceilGrowthRate(시즌내 totalCompleted, 시즌내 totalAvailable)` / 카운트: `f`=rest시즌수, `g`=성공시즌수 |
| **원천 데이터** | (비율) `WeeklyCardDto[]` 집계 / (카운트) `user_season_statuses.status` ('success'\|'rest') |
| **저장 테이블** | `user_season_statuses` (시즌별 성공/휴식 상태만 저장) |
| **저장 컬럼** | `user_season_statuses.status` |
| **API** | 비율: `/api/.../cluster4/weekly-growth` (seasonGrowthRates 배열) / 카운트: `/api/.../cluster3/growth` (period.f, period.g) |
| **사용 화면** | `Cluster4Editor.tsx` (시즌별 성장률), `Cluster3Editor.tsx` (성장 시즌/휴식 시즌 카운트) |
| **상태** | 구현 완료 (hybrid) |
| **중복 의심** | 시즌 "성공률"의 의미가 2곳에서 다름: Cluster4는 활동 라인 비율, Cluster3는 시즌 상태 카운트 |
| **비고** | Cluster1 Resume에서도 `computeSeasonRecords()` (`cluster1ResumeData.ts:215-`)로 시즌별 승인 주차 수/총 주차 수를 별도 집계 — 3번째 경로 |

---

### M05 — 단감 포인트

| 항목 | 내용 |
|---|---|
| **ID** | M05 |
| **지표명** | 단감 포인트 (Stars / Points) |
| **한줄 설명** | 사용자의 누적 성장 포인트 (조직별 라벨: 단감/별/투구) |
| **도메인** | Cluster3 Growth |
| **생산자** | `buildIndicators()` — 읽기만 수행 |
| **계산식** | `j = pts?.total_stars ?? 0` (저장값 직접 사용) |
| **원천 데이터** | `user_cumulative_points.total_stars` |
| **저장 테이블** | `user_cumulative_points` (누적), `user_weekly_points` (주차별) |
| **저장 컬럼** | `total_stars` (누적), `points` (주차별) |
| **API** | `/api/admin/crews/[id]/cluster3/growth` (point.points) |
| **사용 화면** | `Cluster3Editor.tsx` (포인트 카드) |
| **상태** | 구현 완료 (stored) |
| **중복 의심** | `total_stars` = SUM(`user_weekly_points.points`)이어야 하나, 동기화 로직이 migration 시점 1회만 확인됨 |
| **비고** | 라벨은 `pointLabels.ts`에서 조직별 매핑: oranke→"단감", encre→"별", phalanx→"투구" |

---

### M06 — 인절미 포인트

| 항목 | 내용 |
|---|---|
| **ID** | M06 |
| **지표명** | 인절미 포인트 (Advantages / Shields) |
| **한줄 설명** | 누적 이점 포인트에서 벌점을 차감한 순 이점 (조직별 라벨: 인절미/방패) |
| **도메인** | Cluster3 Growth |
| **생산자** | `buildIndicators()` |
| **계산식** | `k = k0 - l` (k0=total_raw_advantages, l=abs(total_lightnings)) |
| **원천 데이터** | `user_cumulative_points.total_raw_advantages`, `user_cumulative_points.total_lightnings` |
| **저장 테이블** | `user_cumulative_points` (누적), `user_weekly_points` (주차별) |
| **저장 컬럼** | `total_raw_advantages` (k0), `total_shields` (k legacy), `total_lightnings` (l) / 주차별: `advantages`, `penalty` |
| **API** | `/api/admin/crews/[id]/cluster3/growth` (point.netAdvantages) |
| **사용 화면** | `Cluster3Editor.tsx` (이점 카드) |
| **상태** | 구현 완료 (hybrid — 저장 + 계산 검증) |
| **중복 의심** | `total_shields` (legacy 저장값) vs 계산된 `k=k0-l` — 정합성 검증이 `_debug.integrityOk`로만 확인 |
| **비고** | 라벨: oranke→"인절미", encre/phalanx→"방패". migration에서 `total_raw_advantages = total_shields + abs(total_lightnings)` 역산 backfill |

---

### M07 — 어흥 포인트

| 항목 | 내용 |
|---|---|
| **ID** | M07 |
| **지표명** | 어흥 포인트 (Lightnings / Penalty) |
| **한줄 설명** | 사용자의 누적 벌점 포인트 (조직별 라벨: 어흥/번개) |
| **도메인** | Cluster3 Growth |
| **생산자** | `buildIndicators()` — 읽기만 수행 |
| **계산식** | `l = Math.abs(pts?.total_lightnings ?? 0)` (절대값 변환만) |
| **원천 데이터** | `user_cumulative_points.total_lightnings` |
| **저장 테이블** | `user_cumulative_points` (누적), `user_weekly_points` (주차별) |
| **저장 컬럼** | `total_lightnings` (누적), `penalty` (주차별) |
| **API** | `/api/admin/crews/[id]/cluster3/growth` (point.penalty) |
| **사용 화면** | `Cluster3Editor.tsx` (벌점 카드) |
| **상태** | 구현 완료 (stored) |
| **중복 의심** | `total_lightnings` = SUM(`user_weekly_points.penalty`)이어야 하나, 동기화 확인 필요 |
| **비고** | 라벨: oranke→"어흥", encre/phalanx→"번개". Cluster4에서 FM 점수 산출 시 `penalty × 5` 가중치 적용 |

---

### M08 — 누적 포인트

| 항목 | 내용 |
|---|---|
| **ID** | M08 |
| **지표명** | 누적 포인트 (Cumulative Points) |
| **한줄 설명** | 단감 + 인절미 - 어흥을 종합한 사용자의 전체 포인트 현황 |
| **도메인** | Cluster3 Growth |
| **생산자** | `buildIndicators()` |
| **계산식** | 개별 항목만 노출 (j, k0, k, l). 합산 공식은 FM score에서만 사용: `points + advantages×3 - penalty×5` |
| **원천 데이터** | `user_cumulative_points` 전체 컬럼 |
| **저장 테이블** | `user_cumulative_points` |
| **저장 컬럼** | `total_stars`, `total_raw_advantages`, `total_shields`, `total_lightnings` |
| **API** | `/api/admin/crews/[id]/cluster3/growth` (point 객체 전체) |
| **사용 화면** | `Cluster3Editor.tsx` |
| **상태** | 구현 완료 (stored + on-the-fly 검증) |
| **중복 의심** | `total_shields` 컬럼이 legacy이면서 `k=k0-l` 계산으로도 도출 가능 |
| **비고** | 주차별 breakdown은 `user_weekly_points` (points, advantages, penalty 컬럼). FM score 가중치 공식은 `cluster4WeeklyGrowthData.ts:516`에서만 사용 |

---

### M09 — 승인 주차 수

| 항목 | 내용 |
|---|---|
| **ID** | M09 |
| **지표명** | 승인 주차 수 (Approved Weeks) |
| **한줄 설명** | status='success'인 주차의 누적 수 |
| **도메인** | Cluster3 Growth / Cluster4 Weekly |
| **생산자** | (Cluster3) `buildIndicators()` → `a` / (Cluster4) `computeGrowthSummary()` |
| **계산식** | `COUNT(*) WHERE status = 'success'` |
| **원천 데이터** | `user_week_statuses.status` |
| **저장 테이블** | `user_growth_stats` (denormalized cache) |
| **저장 컬럼** | `user_growth_stats.approved_weeks` |
| **API** | Cluster3: `/api/.../cluster3/growth` (period.a) / Cluster4: `/api/.../cluster4/weekly-growth` (growthSummary.approvedWeeks) |
| **사용 화면** | `Cluster3Editor.tsx`, `Cluster4Editor.tsx` |
| **상태** | 구현 완료 (dual: stored + on-the-fly) |
| **중복 의심** | **있음** — `user_growth_stats.approved_weeks` (저장) vs `user_week_statuses` COUNT (계산) vs `cluster3GrowthData.ts`의 변수 `a` (loop 집계). 3곳에서 같은 값을 독립적으로 산출. 동기화 보장 없음 |
| **비고** | `is_official_rest_override=true`인 행은 status='success'이므로 승인 주차에 포함됨. 이 미묘한 차이가 schedule reliability 공식의 `e` 값과 불일치를 만들 수 있음 |

---

### M10 — 누적 주차 수

| 항목 | 내용 |
|---|---|
| **ID** | M10 |
| **지표명** | 누적 주차 수 (Cumulative Weeks) |
| **한줄 설명** | 사용자가 가입 이후 경험한 전체 주차 수 |
| **도메인** | Cluster3 Growth / Cluster1 Resume |
| **생산자** | (Cluster3) `buildIndicators()` → `h=a+b+c+d` / (Resume) `computeScheduleReliability()` → `physicalWeeks` |
| **계산식** | Cluster3: `COUNT(*) FROM user_week_statuses` / Resume: `floor((Date.now() - activity_started_at) / msPerWeek)` |
| **원천 데이터** | `user_week_statuses` (row count) 또는 `user_profiles.activity_started_at` (Date 차이) |
| **저장 테이블** | `user_growth_stats` (denormalized cache) |
| **저장 컬럼** | `user_growth_stats.cumulative_weeks` |
| **API** | Cluster3: period.h / Resume: scheduleReliability.physicalWeeks |
| **사용 화면** | `Cluster3Editor.tsx`, `ResumeCardEditor.tsx` |
| **상태** | 구현 완료 (dual: stored + on-the-fly) |
| **중복 의심** | **높음** — (1) `user_growth_stats.cumulative_weeks` (2) `h = a+b+c+d` (row count) (3) `physicalWeeks` (시간차). 3가지 산출 경로, 결과가 다를 수 있음 |
| **비고** | row count 방식은 seed되지 않은 주차를 누락하고, 시간차 방식은 미래 주차를 포함할 수 있음. `availableWeeks`(Cluster4: `a+b+c`, official_rest 제외)는 또 다른 변형 |

---

### M11 — 사용자 상태

| 항목 | 내용 |
|---|---|
| **ID** | M11 |
| **지표명** | 사용자 상태 (Growth Status) |
| **한줄 설명** | 사용자의 현재 성장 과정 상태 (10종 표시 라벨) |
| **도메인** | Cluster3 Growth / Members |
| **생산자** | `resolveDisplayKey()` (DB값 + 계산 상태 조합) |
| **계산식** | DB `growth_status` 7종 + 계산 도출 3종 (official_rest/onboarding/extra_growth) |
| **원천 데이터** | `user_profiles.growth_status`, `user_week_statuses.status` (현재 주차), `period.a`, `period.h`, `graduationThreshold` |
| **저장 테이블** | `user_profiles` |
| **저장 컬럼** | `user_profiles.growth_status` (DB 7종: active/graduated/suspended/paused/graduating/seasonal_rest/weekly_rest) |
| **API** | `/api/.../cluster3/growth` (process.growthStatus, process.growthDisplayKey) / `/api/admin/members` (growthStatus) |
| **사용 화면** | `Cluster3Editor.tsx`, `MembersList.tsx`, `MemberEditDrawer.tsx`, `CrewManager.tsx` |
| **상태** | 구현 완료 (stored + derived display) |
| **중복 의심** | `user_profiles.growth_status` vs `user_profiles.status` (별도 도메인이지만 혼동 가능) |
| **비고** | 표시 라벨 10종은 `cluster3GrowthTypes.ts:30-41` GROWTH_DISPLAY_LABELS 상수. CHECK 제약은 DB에 없고 앱 레벨 계약 |

---

### M12 — 현재 시즌

| 항목 | 내용 |
|---|---|
| **ID** | M12 |
| **지표명** | 현재 시즌 (Current Season) |
| **한줄 설명** | 오늘 날짜 기준으로 해당하는 시즌 식별자와 라벨 |
| **도메인** | 공통 (Cluster3/4) |
| **생산자** | `getSeasonForDate()` |
| **계산식** | 하드코딩 달력 규칙 기반 날짜 범위 매칭 (ANCHOR_MS + offset) |
| **원천 데이터** | `seasonCalendar.ts` 내부 상수 (browser-safe, DB 불필요) + `season_definitions` 테이블 (DB 조회용) |
| **저장 테이블** | `season_definitions` |
| **저장 컬럼** | `season_key`, `season_label`, `start_date`, `end_date`, `season_type` |
| **API** | `/api/admin/cluster4/current-week` (seasonKey 반환), `/api/.../cluster4/weekly-growth` |
| **사용 화면** | `Cluster4Editor.tsx` (시즌 라벨 표시) |
| **상태** | 구현 완료 (hybrid: 코드 상수 + DB) |
| **중복 의심** | `seasonCalendar.ts` 하드코딩 vs `season_definitions` DB 데이터 — 36개 시즌 데이터가 2곳에 존재 |
| **비고** | `weeks.season_key` FK로도 연결. `season_definitions`는 2021-2029 36시즌 사전 seed |

---

### M13 — 현재 주차

| 항목 | 내용 |
|---|---|
| **ID** | M13 |
| **지표명** | 현재 주차 (Current Week) |
| **한줄 설명** | 현재 시즌 내에서의 주차 번호 및 ISO 주차 정보 |
| **도메인** | 공통 (Cluster3/4) |
| **생산자** | `getWeekInSeason()` / `getISOWeekInfo()` |
| **계산식** | `weekNumber = floor((dateMs - seasonStartMs) / (7 × DAY_MS)) + 1` |
| **원천 데이터** | 현재 날짜 + `seasonCalendar.ts` 시즌 시작일 / `weeks` 테이블 (iso_year, iso_week) |
| **저장 테이블** | `weeks` |
| **저장 컬럼** | `week_number`, `start_date`, `end_date`, `iso_year`, `iso_week` |
| **API** | `/api/admin/cluster4/current-week` |
| **사용 화면** | `Cluster4Editor.tsx` |
| **상태** | 구현 완료 (hybrid: computed + stored) |
| **중복 의심** | **높음** — `weeks.week_number` vs `user_week_statuses.week_number` vs `user_week_statuses.year`+`week_number` 조합. `weeks.start_date` vs `user_week_statuses.week_start_date` |
| **비고** | `weeks` 테이블 backfill이 `user_week_statuses`에서 복사됨 (역방향 의존). 두 테이블 비동기 시 불일치 위험 |

---

### M14 — 개인 휴식 주차 수

| 항목 | 내용 |
|---|---|
| **ID** | M14 |
| **지표명** | 개인 휴식 주차 수 (Personal Rest Weeks Count) |
| **한줄 설명** | 사용자가 사전에 개인 휴식을 신청한 주차의 누적 수 |
| **도메인** | Cluster1 Resume / Cluster3 Growth |
| **생산자** | loop 집계 (3곳 독립 구현) |
| **계산식** | `COUNT(*) FROM user_week_statuses WHERE status = 'personal_rest'` |
| **원천 데이터** | `user_week_statuses.status` |
| **저장 테이블** | 없음 (개별 row만 존재) |
| **저장 컬럼** | 없음 (집계값 미저장) |
| **API** | Resume: scheduleReliability.preRestWeeks / Cluster3: period.c / RPC: `get_week_status_counts().personal_rest_count` |
| **사용 화면** | `ResumeCardEditor.tsx:823`, `Cluster3Editor.tsx` |
| **상태** | 구현 완료 (on-the-fly, 3곳 독립 계산) |
| **중복 의심** | **있음** — (1) `cluster1ResumeData.ts:100` (2) `cluster3GrowthData.ts:150` (3) `cluster4WeeklyGrowthData.ts:230` — 3곳에서 동일 로직 반복 |
| **비고** | `user_season_statuses.status='rest'`는 시즌 단위 휴식으로, 개인 주차 휴식과는 다른 개념이나 연관 있음 |

---

### M15 — 공식 휴식 주차 수

| 항목 | 내용 |
|---|---|
| **ID** | M15 |
| **지표명** | 공식 휴식 주차 수 (Official Rest Weeks Count) |
| **한줄 설명** | 조직 차원에서 지정된 공식 휴식 주차의 누적 수 (사용자 기준 집계) |
| **도메인** | Cluster1 Resume / Cluster3 Growth |
| **생산자** | loop 집계 (3곳 독립 구현) |
| **계산식** | `COUNT(*) FROM user_week_statuses WHERE status = 'official_rest'` |
| **원천 데이터** | `user_week_statuses.status`, `official_rest_weeks` (정의 테이블), `weeks.is_official_rest` (플래그) |
| **저장 테이블** | `official_rest_weeks` (정의), `weeks` (플래그), `user_week_statuses` (사용자별 기록) |
| **저장 컬럼** | `official_rest_weeks.(year, week_number)`, `weeks.is_official_rest`, `user_week_statuses.status`, `user_week_statuses.is_official_rest_override` |
| **API** | Resume: scheduleReliability.officialRestWeeks / Cluster3: period.d / RPC: `get_week_status_counts().official_rest_count` |
| **사용 화면** | `ResumeCardEditor.tsx:847`, `Cluster3Editor.tsx`, `Cluster4Editor.tsx` |
| **상태** | 구현 완료 (hybrid: 정의 stored + 집계 on-the-fly) |
| **중복 의심** | **높음** — 3개 원천: (1) `official_rest_weeks` (명절 정의) (2) `weeks.is_official_rest` (주차 플래그, 달력 규칙 포함) (3) `user_week_statuses.status='official_rest'` (사용자별 기록). override 플래그가 복잡성 추가 |
| **비고** | `is_official_rest_override=true`면 status='success'이지만 실제로는 공식 휴식 주차. 이 경우 일정 신뢰도 분모(a-e)에서 제외되지 않아 공식이 미묘하게 유리해짐 |

---

## 2. 요약 매트릭스

| ID | 지표명 | 저장 | 산출 방식 | 중복 | SSOT |
|---|---|---|---|---|---|
| M01 | 일정 신뢰도 | 없음 | on-the-fly | 변수명 혼재 | 불명확 |
| M02 | 활동 완료율 | 없음 | on-the-fly | 2개 경로 | 불명확 |
| M03 | 주차 성장률 | 없음 | on-the-fly | 없음 | 명확 |
| M04 | 시즌 성공률 | 부분 | hybrid | 3개 의미 | 불명확 |
| M05 | 단감 포인트 | 있음 | stored | 누적↔주차 동기화 | 명확 |
| M06 | 인절미 포인트 | 있음 | hybrid | shields legacy | 불명확 |
| M07 | 어흥 포인트 | 있음 | stored | 누적↔주차 동기화 | 명확 |
| M08 | 누적 포인트 | 있음 | stored | shields 중복 | 부분 명확 |
| M09 | 승인 주차 수 | 있음 | dual | 3곳 독립 산출 | 불명확 |
| M10 | 누적 주차 수 | 있음 | dual | 3가지 산출 경로 | 불명확 |
| M11 | 사용자 상태 | 있음 | stored+derived | status 2컬럼 | 명확 |
| M12 | 현재 시즌 | 있음 | hybrid | 코드+DB 이중 | 부분 명확 |
| M13 | 현재 주차 | 있음 | hybrid | 2테이블 중복 | 불명확 |
| M14 | 개인 휴식 주차 수 | 없음 | on-the-fly | 3곳 독립 계산 | 명확 (원천) |
| M15 | 공식 휴식 주차 수 | 부분 | hybrid | 3원천 + override | 불명확 |

---

## 3. 분류별 정리

### 3-A. 중복 의심 지표 목록

| 순위 | 지표 | 중복 유형 | 위험도 |
|---|---|---|---|
| 1 | M15 공식 휴식 주차 수 | 3개 원천 테이블 + override 플래그 | **높음** |
| 2 | M10 누적 주차 수 | 3가지 산출 경로 (DB stored / row count / Date 차이) | **높음** |
| 3 | M09 승인 주차 수 | 3곳 독립 산출 (growth_stats / week_statuses COUNT / loop) | **높음** |
| 4 | M13 현재 주차 | weeks vs user_week_statuses 양쪽에 week_number/start_date | 중간 |
| 5 | M06 인절미 포인트 | total_shields (legacy) vs 계산값 k=k0-l | 중간 |
| 6 | M04 시즌 성공률 | 3가지 다른 의미의 "시즌 성공" (비율/카운트/기록) | 중간 |
| 7 | M02 활동 완료율 | Resume 경로 vs Cluster4 경로 (반올림 방식도 다름) | 중간 |
| 8 | M14 개인 휴식 주차 수 | 3곳 독립 loop 집계 (로직 동일, DRY 위반) | 낮음 |
| 9 | M08 누적 포인트 | shields 컬럼 legacy 잔존 | 낮음 |
| 10 | M01 일정 신뢰도 | 변수명 a/b/c/d가 Cluster3와 전혀 다른 의미 | 낮음 (혼동 위험) |

### 3-B. SSOT가 명확한 지표 목록

| 지표 | SSOT | 근거 |
|---|---|---|
| M03 주차 성장률 | `computeWeeklyCards()` → `ceilGrowthRate()` | 단일 계산 경로, 중복 없음 |
| M05 단감 포인트 | `user_cumulative_points.total_stars` | 단일 저장 + 단일 읽기 |
| M07 어흥 포인트 | `user_cumulative_points.total_lightnings` | 단일 저장 + 단일 읽기 |
| M11 사용자 상태 | `user_profiles.growth_status` + `resolveDisplayKey()` | DB 1곳 + 표시 로직 1곳 |
| M14 개인 휴식 주차 수 | `user_week_statuses WHERE status='personal_rest'` | 원천은 1곳 (집계만 3곳) |

### 3-C. SSOT가 불명확한 지표 목록

| 지표 | 문제 | 개선 방향 |
|---|---|---|
| M01 일정 신뢰도 | 물리 주차(a) 산출이 Date 차이 vs row count 혼재 | 물리 주차 산출 방식 통일 필요 |
| M02 활동 완료율 | Resume vs Cluster4에서 반올림 방식 다름 | 공통 계산 함수 통합 |
| M04 시즌 성공률 | "시즌 성공"의 의미가 도메인마다 다름 | 용어 정의 문서화 |
| M06 인절미 포인트 | legacy `total_shields` 컬럼 잔존 | shields 컬럼 제거 또는 k 계산과 동기화 보장 |
| M09 승인 주차 수 | `user_growth_stats.approved_weeks` vs COUNT vs loop | 원천 1곳으로 통일 |
| M10 누적 주차 수 | `cumulative_weeks` vs `h` vs `physicalWeeks` | 산출 방식 단일화 |
| M13 현재 주차 | weeks vs user_week_statuses 양쪽 저장 | weeks를 SSOT로 확정 |
| M15 공식 휴식 주차 수 | 3개 원천 + override 복잡도 | official_rest_weeks → weeks.is_official_rest → user_week_statuses 단방향 파이프라인 확정 |

### 3-D. 저장하지 않아도 되는 계산형 지표 목록

| 지표 | 근거 |
|---|---|
| M01 일정 신뢰도 | 원천 데이터(week statuses)에서 항상 정확히 재계산 가능 |
| M02 활동 완료율 | 원천 데이터(activity details + line availability)에서 재계산 가능 |
| M03 주차 성장률 | 동일 |
| M04 시즌 성공률(비율) | 주차 카드 집계에서 재계산 가능 |
| M14 개인 휴식 주차 수 | status 필터 COUNT로 즉시 산출 |

### 3-E. 저장 여부를 검토해야 하는 지표 목록

| 지표 | 현재 상태 | 검토 이유 |
|---|---|---|
| M09 승인 주차 수 | `user_growth_stats.approved_weeks`에 중복 저장 | 계산으로 대체 가능하나, 쿼리 빈도 높으면 캐시 유지 합리적. 동기화 보장 필요 |
| M10 누적 주차 수 | `user_growth_stats.cumulative_weeks`에 중복 저장 | 동일 |
| M06 인절미 포인트 | `total_shields` legacy 컬럼 잔존 | `total_raw_advantages - abs(total_lightnings)`로 항상 재계산 가능. legacy 제거 또는 동기 보장 검토 |
| M12 현재 시즌 | 코드 상수 + DB 이중 관리 | 하나로 통합 (DB 우선 or 코드 우선) 결정 필요 |
| M15 공식 휴식 주차 수 | 3곳 분산 | 파이프라인 방향 확정 후 불필요한 중복 제거 |

### 3-F. 개별 정밀 감사 우선순위 TOP 5

| 순위 | 지표 | 긴급도 | 이유 |
|---|---|---|---|
| **1** | M15 공식 휴식 주차 수 | 높음 | 3개 원천 + override 플래그가 일정 신뢰도(M01) 분모에 직접 영향. 정합성 파괴 시 전체 지표 신뢰도 하락 |
| **2** | M10 누적 주차 수 | 높음 | 3가지 산출 경로가 서로 다른 결과를 낼 수 있고, 졸업 판정(`a >= threshold`)의 분모로 사용. 잘못되면 졸업 오판 |
| **3** | M09 승인 주차 수 | 높음 | `user_growth_stats.approved_weeks`와 실시간 COUNT 불일치 가능. 졸업 판정의 분자로 사용 |
| **4** | M02 활동 완료율 | 중간 | Resume vs Cluster4 두 경로의 계산 방식 차이 (round vs ceil)가 사용자 대면 지표에서 혼란 유발 가능 |
| **5** | M06 인절미 포인트 | 중간 | legacy `total_shields` 컬럼과 계산값 `k=k0-l`의 정합성이 `_debug.integrityOk`로만 검증. 실패 시 silent data corruption |

---

## 4. 핵심 파일 인덱스

| 파일 | 역할 | 관련 지표 |
|---|---|---|
| `lib/cluster1ResumeData.ts` | Resume DTO 빌더 (일정 신뢰도, 활동 완료율, 시즌 기록) | M01, M02, M04, M14, M15 |
| `lib/cluster1ResumeTypes.ts` | Resume DTO 타입 정의 | M01, M02 |
| `lib/cluster3GrowthData.ts` | Cluster3 성장 지표 빌더 (Process/Period/Point) | M05-M11, M14, M15 |
| `lib/cluster3GrowthTypes.ts` | Cluster3 타입 정의 + 표시 라벨 | M05-M11 |
| `lib/cluster4WeeklyGrowthData.ts` | Cluster4 주차별 성장 카드 빌더 | M02-M04, M09, M10, M12, M13 |
| `lib/cluster4WeeklyGrowthTypes.ts` | Cluster4 타입 정의 | M02-M04, M12, M13 |
| `lib/lineAvailability.ts` | 가용 라인 계산 공통 모듈 | M02, M03 |
| `lib/seasonCalendar.ts` | 시즌 달력 로직 (browser-safe) | M12 |
| `lib/pointLabels.ts` | 조직별 포인트 라벨 매핑 | M05, M06, M07 |
| `components/admin/ResumeCardEditor.tsx` | Resume Card UI | M01, M02, M14, M15 |
| `components/admin/Cluster3Editor.tsx` | Cluster3 UI | M05-M11 |
| `components/admin/Cluster4Editor.tsx` | Cluster4 UI | M02-M04, M09, M10, M12, M13 |
| `db/migrations/2026-05-25_cluster3_growth_indicators.sql` | user_week_statuses, user_cumulative_points, get_week_status_counts RPC | M01, M05-M10, M14, M15 |
| `db/migrations/2026-05-25_official_rest_weeks_and_override.sql` | official_rest_weeks, is_official_rest_override | M15 |
| `db/migrations/2026-05-25_season_definitions_and_user_seasons.sql` | season_definitions, user_season_statuses | M04, M12 |
| `db/migrations/2026-05-25_cluster4_weeks_schema_alignment.sql` | weeks 테이블 스키마 | M12, M13, M15 |
| `db/migrations/2026-05-25_club_rank_weekly_points.sql` | user_weekly_points | M05, M06, M07, M08 |

---

## 5. 변수명 혼재 경고

아래는 **같은 변수명이 다른 의미로 사용되는** 위험 구간입니다.

| 변수 | cluster3GrowthData.ts 의미 | cluster1ResumeData.ts 의미 |
|---|---|---|
| `a` | success 주차 수 (= 일정 신뢰도의 d) | 물리 주차 수 (= 일정 신뢰도의 a) |
| `b` | fail 주차 수 (= 일정 신뢰도의 c) | 사전 휴식 주차 수 (= 일정 신뢰도의 b) |
| `c` | personal_rest 주차 수 (= 일정 신뢰도의 b) | 미인정 주차 수 (= 일정 신뢰도의 c) |
| `d` | official_rest 주차 수 (= 일정 신뢰도의 e) | 인정 주차 수 (= 일정 신뢰도의 d) |
| `e` | growable 주차 (a+b+c) | 공식 휴식 주차 수 (= cluster3의 d) |
| `h` | 물리 주차 (a+b+c+d) | — (사용 안 함) |

이 혼재는 향후 유지보수에서 심각한 버그를 유발할 수 있습니다.
