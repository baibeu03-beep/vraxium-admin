# Source of Truth 확정 및 영향도 감사 보고서

**작성일**: 2026-05-28
**범위**: 55 테이블, 2 뷰, 62 FK, 47 코드 참조 테이블
**목적**: 기준 확정 / legacy fallback 정리 / cluster4 흐름 표준화 / 동기화 안정화

---

## 1단계. Source of Truth 최종 확정

---

### 1-1. 주간 상태 (Week Status)

**Current Source of Truth**: `user_week_statuses` 테이블
- PK: `(user_id, year, week_number)`
- status: `'success'|'fail'|'personal_rest'|'official_rest'`

**Fallback Sources**: 없음 (단일 소스)

**Read Locations**:
| 위치 | 파일:라인 | 용도 |
|------|----------|------|
| Growth Summary 계산 | `lib/cluster4WeeklyGrowthData.ts:187-191` | 전체 주차 상태 조회 → approved/fail/rest COUNT |
| Growth Summary 계산 | `lib/cluster3GrowthData.ts:185-191` | 동일 로직 (중복 존재) |
| Season Rest 검증 | `lib/seasonRestValidation.ts:70-77` | 시즌 1주차 상태 조회 |
| Club Rank 계산 | `lib/cluster3ClubRankData.ts:87-99` | 주차 상태 기반 등급 |
| Resume 계산 | `lib/cluster1ResumeData.ts:161` | official_rest 필터링 |
| Cluster4 Weekly Cards | `lib/cluster4WeeklyGrowthData.ts:392-404` | 주차별 카드 구성 |

**Write Locations**:
| 위치 | 파일:라인 | 동작 |
|------|----------|------|
| 시즌 휴식 전환 | `lib/seasonRestValidation.ts:80-86` | 1주차 → personal_rest |
| 남은 주차 전환 | `lib/seasonRestValidation.ts:125-131` | 미래 주차 → personal_rest |
| 마이그레이션 시드 | `2026-05-25_cluster3_growth_indicators.sql:157-221` | 초기 데이터 생성 |

**Sync Method**: **없음** — `user_growth_stats.approved_weeks`와의 자동 동기화 없음
- `seasonRestValidation.ts:94-100`에서만 수동 재집계
- 마이그레이션 SQL에서만 배치 재집계

**Risk Level**: **HIGH**
- `user_week_statuses` 직접 수정 시 `user_growth_stats`와 불일치 발생
- 관리 UI에서 주차 상태 변경 → `approved_weeks` 자동 갱신 안 됨

**Recommended Final Structure**:
- `user_week_statuses` = 유일한 source of truth (현재 상태 유지)
- `user_growth_stats.approved_weeks` = 트리거 기반 자동 동기화 추가 필요
- `user_weekly_points` 패턴과 동일한 AFTER INSERT/UPDATE/DELETE 트리거 적용

---

### 1-2. 주간 포인트 (Weekly Points)

**Current Source of Truth**: `user_weekly_points` 테이블

**Fallback Sources**: 없음 (단일 소스)

**Read Locations**:
| 위치 | 파일:라인 | 용도 |
|------|----------|------|
| Weekly Cards 포인트 | `lib/cluster4WeeklyGrowthData.ts:407-416` | 주차별 points/advantages/penalty |
| Cumulative 검증 | `scripts/verify-cumulative-sync.ts:21-48` | SUM 비교 |

**Write Locations**:
| 위치 | 파일:라인 | 동작 |
|------|----------|------|
| 마이그레이션 시드 | `scripts/apply-weeks-backfill.ts` | 초기 데이터 |
| (운영 코드에서 직접 INSERT 없음) | — | cluster4 제출 → 포인트 흐름 미구현 |

**Sync Method**: **DB 트리거 (자동)**
- `sync_cumulative_on_weekly_change` 트리거 (`2026-05-28_cumulative_points_auto_sync.sql:157-160`)
- AFTER INSERT/UPDATE/DELETE on `user_weekly_points`
- → `sync_cumulative_points_for_user()` 호출
- → `user_cumulative_points` 자동 UPSERT

**Risk Level**: **LOW** (트리거로 해결됨)

**Recommended Final Structure**: 현재 구조 유지 — 안정적 패턴

---

### 1-3. 공식 휴식주 (Official Rest)

**Current Source of Truth**: **3중 소스 (충돌 위험)**

| 소스 | 역할 | 테이블 |
|------|------|--------|
| 정의 | 공휴일(설/추석) 정의 | `official_rest_weeks` |
| 캐시 | 글로벌 캘린더 플래그 | `weeks.is_official_rest` + `weeks.holiday_name` |
| 예외 | 개인별 오버라이드 | `user_week_statuses.is_official_rest_override` |

**Fallback Sources**:
- `weeks.is_official_rest`는 두 가지 소스에서 채워짐:
  1. 캘린더 규칙: 봄/가을 시즌 6~8주, 14~16주 (`2026-05-25_cluster4_weeks_schema_alignment.sql:169-179`)
  2. 공휴일 매핑: `official_rest_weeks` → `weeks` ISO year/week 매칭 (`sql:182-194`)

**Read Locations**:
| 위치 | 파일:라인 | 어떤 소스 사용 |
|------|----------|---------------|
| 현재 주 상태 판별 | `lib/cluster4WeeklyGrowthData.ts:150-155` | `official_rest_weeks` 직접 조회 |
| Weekly Cards 생성 | `lib/cluster4WeeklyGrowthData.ts:396` | `weeks.is_official_rest` |
| 상태 무결성 검증 | `lib/cluster4WeeklyGrowthData.ts:559` | `weeks.is_official_rest` vs `uws.status` 교차 검증 |
| Override 카운팅 | `lib/cluster3GrowthData.ts:153` | `user_week_statuses.is_official_rest_override` |
| Resume 필터링 | `lib/cluster1ResumeData.ts:161` | `user_week_statuses.status == 'official_rest'` |

**Write Locations**:
| 위치 | 동작 |
|------|------|
| `2026-05-25_official_rest_weeks_and_override.sql:53-57` | 초기 시드 (설/추석 3건) |
| `scripts/apply-weeks-backfill.ts:200-220` | 스크립트에서 weeks 테이블 갱신 |
| `2026-05-25_cluster4_weeks_schema_alignment.sql:169-194` | 마이그레이션에서 캘린더 규칙 + 공휴일 매핑 |

**Sync Method**: **단방향, 비자동**
- `official_rest_weeks` → `weeks.is_official_rest` (마이그레이션/스크립트에서만)
- `official_rest_weeks` → `user_week_statuses.status='official_rest'` (시드에서만)
- 런타임 자동 동기화 없음

**Risk Level**: **MEDIUM**
- `official_rest_weeks`에 새 공휴일 추가 시 → `weeks` 자동 갱신 안 됨
- `user_week_statuses`에 이미 생성된 행의 status는 변경 안 됨

**Recommended Final Structure**:
```
official_rest_weeks (공휴일 정의 원본) → 삭제하고 weeks.is_official_rest에 통합
weeks.is_official_rest (글로벌 single source) → 캘린더 규칙 + 공휴일 모두 여기서 관리
user_week_statuses.is_official_rest_override → 유지 (개인 예외 플래그)
user_week_statuses.status = 'official_rest' → weeks.is_official_rest에서 파생
```

---

### 1-4. 학교명 (School Name)

**Current Source of Truth**: `user_educations.school_name` (1순위)

**Fallback Sources**:
1. `user_profiles.school_name` (2순위, 레거시)
2. `legacy_crew_import.school_name` (3순위)

**Read Locations**:
| 위치 | 파일:라인 | 패턴 |
|------|----------|------|
| Crew DTO 빌드 | `lib/adminCrewData.ts:334-338` | `preferString(education, profile, legacy)` |
| Resume Card | `lib/adminResumeCardData.ts:158-159` | `user_educations` 직접 |

**Write Locations**:
| 위치 | 동작 |
|------|------|
| Cluster2 학력 편집 | `lib/adminCluster2Data.ts` | `user_educations` INSERT/DELETE |
| 크루 관리 API | `app/api/admin/crews/[legacy_user_id]/route.ts` | `legacy_crew_import` PATCH |

**Sync Method**: 없음 — `user_educations` 변경 시 `user_profiles.school_name` 갱신 안 됨

**Risk Level**: **MEDIUM** — `user_profiles.school_name`이 stale 가능

**Recommended Final Structure**:
- `user_educations` = 유일한 source (현재 구조 유지)
- `user_profiles.school_name` → 레거시 컬럼, deprecate 후 제거 대상
- `legacy_crew_import.school_name` → 이관 완료 후 fallback 제거

---

### 1-5. 누적 주차 수 (Cumulative Weeks)

**Current Source of Truth**: `user_growth_stats.cumulative_weeks`

**Fallback Sources**: `legacy_crew_import.cumulative_weeks` (2순위)

**Read Locations**:
| 위치 | 파일:라인 | 패턴 |
|------|----------|------|
| Crew DTO | `lib/adminCrewData.ts:354-357` | `preferNumber(growth, legacy)` |
| Resume Card | `lib/adminResumeCardData.ts:285-286` | `growth ?? crew.cumulativeWeeks` |
| Growth Summary | `lib/cluster4WeeklyGrowthData.ts:218-236` | **직접 COUNT** (`user_week_statuses`에서 실시간 계산) |

**Write Locations**:
| 위치 | 파일:라인 | 동작 |
|------|----------|------|
| 시즌 휴식 후 재집계 | `lib/seasonRestValidation.ts:95-100` | COUNT → UPDATE |
| 남은 주차 전환 후 | `lib/seasonRestValidation.ts:139-145` | COUNT → UPDATE |
| 마이그레이션 배치 | `2026-05-25_cluster3_growth_indicators.sql:230-242` | 배치 재집계 |
| 시드 데이터 | `2026-05-25_cluster3_growth_seed_diversify.sql:289-293` | UPSERT |

**Sync Method**: **이벤트 기반 수동** — `seasonRestValidation` 호출 시만 갱신

**Risk Level**: **HIGH**
- `user_week_statuses` 직접 변경 시 `user_growth_stats.cumulative_weeks` 불일치
- `legacy_crew_import.cumulative_weeks`와 `user_growth_stats.cumulative_weeks` 값이 다를 수 있음

**Recommended Final Structure**:
- `user_week_statuses` COUNT = 유일한 계산 기준
- `user_growth_stats` = 캐시 (트리거 자동 동기화 필요)
- `legacy_crew_import.cumulative_weeks` → 이관 완료 후 fallback 제거

---

### 1-6. 시즌 정의 (Season Definition)

**Current Source of Truth**: `season_definitions` 테이블

**Fallback Sources**: 없음

**Read Locations**:
| 위치 | 파일:라인 | 용도 |
|------|----------|------|
| Weekly Growth | `lib/cluster4WeeklyGrowthData.ts:381-389` | season_label 조회 |
| Cluster4 Admin | `lib/adminCluster4Data.ts:317` | 시즌 목록 |
| Resume | `lib/cluster1ResumeData.ts:114-157` | 시즌 기간 참조 |
| Scripts | `scripts/apply-weeks-backfill.ts:114-157` | 주차 생성 기준 |

**Write Locations**: 마이그레이션에서만 INSERT (런타임 쓰기 없음)

**Sync Method**: 해당 없음 (단일 소스)

**Risk Level**: **NONE**

**Recommended Final Structure**: 현재 구조 유지. `seasons` (old table, 1행) 삭제 가능.

---

### 1-7. 크루 데이터 (Crew Data)

**Current Source of Truth**: 분산 — 6개 테이블에서 `preferString/preferNumber`로 병합

| 필드 | 1순위 | 2순위 | 3순위 |
|------|-------|-------|-------|
| displayName | `user_profiles` | `legacy_crew_import` | contact_email, user_id |
| birthDate | `user_profiles` | `legacy_crew_import` | — |
| gender | `user_profiles` | `legacy_crew_import` | — |
| contactPhone | `user_profiles` | `legacy_crew_import` | — |
| contactEmail | `user_profiles` | `legacy_crew_import` | — |
| schoolName | `user_educations` | `user_profiles` | `legacy_crew_import` |
| departmentName | `user_educations` | `user_profiles` | `legacy_crew_import` |
| teamName | `user_memberships` | `legacy_crew_import` | — |
| partName | `user_memberships` | `legacy_crew_import` | — |
| membershipLevel | `user_memberships` | `legacy_crew_import` | — |
| membershipState | `user_memberships` | `legacy_crew_import` | — |
| cumulativeWeeks | `user_growth_stats` | `legacy_crew_import` | — |
| approvedWeeks | `user_growth_stats` | — (단일 소스) | — |
| isVisible | `legacy_crew_import` (단독) | — | — |
| adminNote | `legacy_crew_import` (단독) | — | — |
| organizationSlug | `user_profiles` (단독) | — | — |

**Read Locations**: `lib/adminCrewData.ts:222-397` (`fetchCrewSourceRows` → `buildAdminCrewDtos`)

**Write Locations**:
- `app/api/admin/crews/route.ts` (POST: `legacy_crew_import` INSERT + `user_profiles` UPDATE)
- `app/api/admin/crews/[legacy_user_id]/route.ts` (PATCH: `legacy_crew_import` UPSERT + `user_profiles` UPDATE)

**Risk Level**: **MEDIUM** — fallback 체인이 복잡하지만 우선순위는 명확

**Recommended Final Structure**:
- 정규 테이블(`user_profiles`, `user_memberships`, `user_educations`, `user_growth_stats`) = canonical
- `legacy_crew_import` = staging/이관 소스 (이관 완료까지 유지)
- `isVisible`, `adminNote` → 이관 시 `user_profiles`에 컬럼 추가 필요
- `crew_list_view`, `admin_crew_list_view` → 코드에서 미사용, 삭제 가능

---

## 2단계. approved_weeks 구조 감사

---

### 현재 구조

```
user_week_statuses (rows per user per week)
  status: 'success' | 'fail' | 'personal_rest' | 'official_rest'
        ↓ (수동 COUNT)
user_growth_stats.approved_weeks = COUNT(status='success')
user_growth_stats.cumulative_weeks = COUNT(*)
```

### 2-1. 어디서 계산되는가

| 위치 | 방식 | 파일:라인 |
|------|------|----------|
| 마이그레이션 | SQL COUNT(*) FILTER | `2026-05-25_cluster3_growth_indicators.sql:230-242` |
| 마이그레이션 | SQL COUNT(*) FILTER | `2026-05-25_season_rest_request_policy.sql:119-132` |
| 마이그레이션 | SQL COUNT(*) FILTER | `2026-05-25_official_rest_weeks_and_override.sql:130-140` |
| 시드 | PL/pgSQL 루프 | `2026-05-25_cluster3_growth_seed_diversify.sql:289-293` |
| 런타임 (TS) | Array.filter().length | `lib/seasonRestValidation.ts:94,139` |
| 런타임 (TS, 읽기 전용) | for-loop COUNT | `lib/cluster4WeeklyGrowthData.ts:218-234` |
| 런타임 (TS, 읽기 전용) | for-loop COUNT | `lib/cluster3GrowthData.ts:218-234` |

### 2-2. 어디서 UPDATE되는가

| 위치 | 트리거? | 파일:라인 |
|------|--------|----------|
| `seasonRestValidation.requestSeasonRest()` | 아니오, 명시적 호출 | `lib/seasonRestValidation.ts:97-100` |
| `seasonRestValidation.convertRemainingToPersonalRest()` | 아니오, 명시적 호출 | `lib/seasonRestValidation.ts:142-145` |
| 마이그레이션 배치 (3곳) | 아니오, 일회성 SQL | 위 마이그레이션 파일들 |

### 2-3. 실제 sync 여부

**자동 동기화: 없음**
- DB 트리거: **없음**
- RPC: `get_week_status_counts(uuid)` 존재하지만 **읽기 전용** (쓰기 안 함)
- Cron: **없음**
- `user_week_statuses` 변경 → `user_growth_stats` 자동 갱신 **안 됨**

### 2-4. 값 불일치 가능성

**HIGH** — 다음 시나리오에서 발생:
1. 관리자가 DB에서 직접 `user_week_statuses.status` 변경
2. 새 주차 행 추가 시 `user_growth_stats` 미갱신
3. `seasonRestValidation` 외의 경로로 status 변경
4. 마이그레이션 이후 새 사용자 추가 시 `user_growth_stats` 행 누락 가능

### 2-5. 어떤 API/UI가 approved_weeks를 신뢰하는가

| 소비자 | 파일:라인 | 어떤 값 사용 |
|--------|----------|-------------|
| 크루 관리 목록 | `lib/adminCrewData.ts:358` | `user_growth_stats.approved_weeks` (저장값) |
| 리즈메 카드 | `lib/adminResumeCardData.ts:285` | `user_growth_stats.approved_weeks` (저장값) |
| Growth Summary API | `lib/cluster4WeeklyGrowthData.ts:218-234` | **실시간 COUNT** (user_week_statuses) |
| Growth Summary API | `lib/cluster3GrowthData.ts:218-234` | **실시간 COUNT** (user_week_statuses) |
| CrewManager UI | `components/admin/CrewManager.tsx` | DTO의 approvedWeeks (저장값) |

**핵심 발견**: Growth Summary는 실시간 COUNT, Crew/Resume는 저장값 — **동일 데이터의 이중 경로**

### 2-6. A안 vs B안 비교

#### A안: user_week_statuses 기반 실시간 COUNT

```
장점:
- 항상 정확 (single source of truth)
- 동기화 문제 원천 차단
- user_growth_stats 테이블 불필요

단점:
- 매 조회마다 COUNT 쿼리 필요
- 크루 목록 조회 시 N+1 문제 (157명 × 1 COUNT 쿼리)
- user_growth_stats를 참조하는 모든 코드 수정 필요
- Resume Card 등 다수 API 변경 필요
```

#### B안: user_growth_stats.approved_weeks 유지 + 트리거 자동 동기화

```
장점:
- 기존 읽기 코드 변경 최소화
- user_cumulative_points 패턴과 동일 (검증된 패턴)
- 리스트 조회 시 성능 우수 (pre-computed)
- approved_weeks/cumulative_weeks 한번에 동기화

단점:
- 트리거 추가 필요 (1회성 작업)
- 캐시 정합성 모니터링 필요

구현 패턴 (user_cumulative_points와 동일):
  CREATE OR REPLACE FUNCTION sync_growth_stats_for_user(p_user_id uuid)
  → COUNT(*) FILTER (WHERE status='success') → approved_weeks
  → COUNT(*) → cumulative_weeks
  
  CREATE TRIGGER sync_growth_on_week_change
  AFTER INSERT OR UPDATE OR DELETE ON user_week_statuses
  FOR EACH ROW EXECUTE FUNCTION sync_growth_stats_for_user()
```

#### 권장: **B안**
- 이미 `user_weekly_points → user_cumulative_points` 트리거가 검증됨
- 동일 패턴 적용으로 일관성 확보
- 기존 코드 변경 최소화

---

## 3단계. 공식 휴식주 구조 단일화 감사

---

### 현재 3중 소스 구조

```
SOURCE 1: official_rest_weeks (설/추석 공휴일 정의)
  ↓ (마이그레이션/스크립트에서 복사)
SOURCE 2: weeks.is_official_rest (캘린더 규칙 + 공휴일 = 통합 플래그)
  ↓ (시드에서 참조)
  user_week_statuses.status = 'official_rest'
  
SOURCE 3: user_week_statuses.is_official_rest_override (예외 플래그)
  = "공식 휴식주이지만 활동 인정된 경우"
```

### 3-1. 각 소스의 실제 역할

#### `official_rest_weeks` (3행)
- **역할**: 공휴일(설/추석) 원본 정의
- **데이터**: 2025-W5(설), 2025-W41(추석), 2026-W5(설)
- **런타임 사용**: `cluster4WeeklyGrowthData.ts:150-155` — 현재 주가 공휴일인지 직접 조회
- **문제**: `weeks.is_official_rest`에 이미 복사된 데이터를 런타임에 원본에서 다시 조회

#### `weeks.is_official_rest` + `weeks.holiday_name`
- **역할**: 글로벌 캘린더 플래그 (denormalized cache)
- **채워지는 방식**:
  1. 캘린더 규칙: 봄/가을 시즌 6~8주, 14~16주 자동 true
  2. 공휴일: `official_rest_weeks` → ISO year/week 매칭 시 true + holiday_name
- **런타임 사용**: `cluster4WeeklyGrowthData.ts:396,559` — Weekly Cards 생성 및 무결성 검증

#### `user_week_statuses.is_official_rest_override`
- **역할**: 메타데이터 플래그 (계산에 영향 없음)
- **의미**: "이 주차는 공식 휴식이지만 status='success'로 활동이 인정됨"
- **쓰기**: 마이그레이션에서만 (`override.sql:78-84`)
- **읽기**: `cluster3GrowthData.ts:153` (디버그 카운트용)
- **계산 영향**: 없음 — status='success'이므로 이미 approved_weeks에 포함

### 3-2. 우선순위 분석

**현재 상태 판별 시** (`cluster4WeeklyGrowthData.ts:559-567`):
```typescript
if (uws.status === "official_rest" && weeksRow?.is_official_rest === false) {
  // 불일치 → fail 또는 running으로 처리
  resultStatus = isCurrentWeek ? "running" : "fail";
}
```
→ `weeks.is_official_rest`가 최종 기준, `user_week_statuses.status`는 보조

**현재 주 판별 시** (`cluster4WeeklyGrowthData.ts:150-155`):
```typescript
// official_rest_weeks 테이블 직접 조회 (weeks.is_official_rest 미사용)
const holidayRes = await supabaseAdmin
  .from("official_rest_weeks")
  .select("reason")
  .eq("year", isoYear).eq("week_number", isoWeek)
  .maybeSingle();
```
→ `official_rest_weeks`가 기준 (weeks 미사용 — **불일치 위험**)

### 3-3. 충돌 가능성

| 시나리오 | 위험 | 현재 처리 |
|---------|------|----------|
| `official_rest_weeks`에 신규 추가, `weeks` 미갱신 | `getWeeklyGrowthDto`는 정확, Weekly Cards는 미반영 | 미처리 |
| 캘린더 규칙 변경 (봄/가을 6~8주 외) | `weeks` 마이그레이션 재실행 필요 | 미처리 |
| `user_week_statuses.status='official_rest'` but `weeks.is_official_rest=false` | fail로 강등 (line 559-560) | 처리됨 |
| `is_official_rest_override=true` but `status='success'` | 정상 동작 (이미 success) | 처리됨 |

### 3-4. 권장 최종 구조

```
[글로벌 공식 휴식]
weeks.is_official_rest = SINGLE SOURCE
weeks.holiday_name = 사유 저장
→ 캘린더 규칙 + 공휴일 모두 이 컬럼으로 관리
→ official_rest_weeks 테이블은 seed 용도로만 유지하되,
   런타임 조회는 weeks 테이블만 사용하도록 통일

[개인별 예외]
user_week_statuses.is_official_rest_override = 유지
→ 의미: "공식 휴식주에 활동이 인정된 예외"
→ 계산에는 영향 없음 (metadata)

[변경 사항]
1. cluster4WeeklyGrowthData.ts:150-155 → weeks.is_official_rest 조회로 변경
2. official_rest_weeks → 신규 공휴일 추가 시 weeks 자동 갱신 트리거 추가
   또는 official_rest_weeks 제거하고 weeks에 직접 관리
```

---

## 4단계. legacy_crew_import 감사

---

### 4-1. 실제 역할

`legacy_crew_import`는 **staging table** + **운영 fallback** 이중 역할:
1. **기존 사용자 데이터 이관 소스** (34행, bigint legacy_user_id)
2. **현재도 운영 fallback으로 사용** (`preferString/preferNumber` 체인)
3. **is_visible/admin_note 유일한 저장소** (다른 테이블에 해당 컬럼 없음)
4. **크루 신규 등록 시 staging 테이블** (POST `/api/admin/crews`)

### 4-2. 현재 운영 fallback 참조

| API Route | 용도 | 파일 |
|-----------|------|------|
| `GET /api/admin/crews` | 크루 목록 조회 시 fallback 병합 | `lib/adminCrewData.ts:222-397` |
| `GET /api/admin/crews/[id]` | 개별 크루 조회 시 fallback | 동일 |
| `POST /api/admin/crews` | 신규 크루 등록 (legacy 직접 INSERT) | `app/api/admin/crews/route.ts:122-126` |
| `PATCH /api/admin/crews/[id]` | 크루 정보 수정 (legacy UPSERT) | `app/api/admin/crews/[legacy_user_id]/route.ts:164-210` |
| `DELETE /api/admin/crews/[id]` | 크루 숨기기 (is_visible=false) | `route.ts:258-289` |

### 4-3. preferString/preferNumber 전체 목록

**정의**: `lib/adminCrewData.ts:167-179`

**사용 위치** (`lib/adminCrewData.ts:327-394`):
```
preferString(profile.display_name, legacy.display_name, ...)        → displayName
preferString(profile.birth_date, legacy.birth_date)                  → birthDate
preferString(profile.gender, legacy.gender)                          → gender
preferString(profile.contact_phone, legacy.contact_phone)            → contactPhone
preferString(profile.contact_email, legacy.contact_email)            → contactEmail
preferString(education.school_name, profile.school_name, legacy.school_name)  → schoolName
preferString(education.major_name_1, profile.department_name, legacy.major_name) → departmentName
preferString(membership.team_name, legacy.team_name)                 → teamName
preferString(membership.part_name, legacy.part_name)                 → partName
preferString(membership.membership_level, legacy.membership_level)   → membershipLevel
preferString(membership.membership_state, legacy.membership_state)   → membershipState
preferString(profile.updated_at, legacy.updated_at)                  → updatedAt
preferNumber(growth.cumulative_weeks, legacy.cumulative_weeks)       → cumulativeWeeks
preferNumber(growth.approved_weeks)                                   → approvedWeeks (단일)
```

### 4-4. 컬럼별 이관 현황

| legacy 컬럼 | destination 테이블 | 이관 상태 | fallback 필요 |
|-------------|-------------------|----------|--------------|
| `legacy_user_id` | `users.legacy_user_id` | **완료** (157행 대 34행) | 아니오 (bridge key) |
| `display_name` | `user_profiles.display_name` | **완료** (151행) | 예 (null 가능) |
| `birth_date` | `user_profiles.birth_date` | **부분** (일부 null) | 예 |
| `gender` | `user_profiles.gender` | **부분** | 예 |
| `contact_phone` | `user_profiles.contact_phone` | **부분** | 예 |
| `contact_email` | `user_profiles.contact_email` | **부분** | 예 |
| `school_name` | `user_educations.school_name` | **부분** (37행/151명) | 예 |
| `major_name` | `user_educations.major_name_1` | **부분** | 예 |
| `team_name` | `user_memberships.team_name` | **완료** (157행) | 예 (레거시 사용자) |
| `part_name` | `user_memberships.part_name` | **완료** | 예 |
| `membership_level` | `user_memberships.membership_level` | **완료** | 예 |
| `membership_state` | `user_memberships.membership_state` | **완료** | 예 |
| `cumulative_weeks` | `user_growth_stats.cumulative_weeks` | **완료** (157행) | 예 (값 불일치 가능) |
| `is_visible` | **(없음)** | **미이관** | **필수** (유일 소스) |
| `admin_note` | **(없음)** | **미이관** | **필수** (유일 소스) |
| `address` | `user_profiles.address` | **부분** | 예 |

### 4-5. crew_list_view / admin_crew_list_view 역할

| 뷰 | 소스 | 코드 사용 | 역할 |
|----|------|----------|------|
| `crew_list_view` | `legacy_crew_import LEFT JOIN user_profiles` | **미사용** | User App용 (anon/authenticated) |
| `admin_crew_list_view` | `legacy_crew_import LEFT JOIN user_profiles` | **미사용** | Admin용 (service_role) |

**핵심**: 두 뷰 모두 코드에서 참조되지 않음. `adminCrewData.ts`가 직접 6개 테이블을 조회하여 DTO를 빌드.

### 4-6. Legacy Migration Checklist

#### 이미 이관 완료
- [x] `legacy_user_id` → `users.legacy_user_id` (bridge key 역할)
- [x] `display_name` → `user_profiles.display_name` (대부분)
- [x] `team_name`, `part_name` → `user_memberships` (157행)
- [x] `membership_level`, `membership_state` → `user_memberships`
- [x] `cumulative_weeks` → `user_growth_stats.cumulative_weeks`

#### 아직 이관 필요
- [ ] `birth_date`, `gender`, `contact_phone`, `contact_email` → `user_profiles` (null인 행 이관)
- [ ] `school_name`, `major_name` → `user_educations` (37/151 = 24% 완료)
- [ ] `address` → `user_profiles.address` (부분)

#### fallback 유지 필요 (이관 완료까지)
- 모든 `preferString/preferNumber` 체인 유지
- 특히 `school_name` (user_educations 행이 없는 사용자 114명)

#### 제거 불가 — 별도 이관 필요
- [ ] `is_visible` → destination 없음 → `user_profiles`에 컬럼 추가 필요
- [ ] `admin_note` → destination 없음 → `user_profiles`에 컬럼 추가 필요

#### 완전 제거 조건
1. `user_profiles`에 `is_visible`, `admin_note` 컬럼 추가 및 데이터 이관
2. `user_educations`에 모든 사용자의 학력 데이터 이관 (or `user_profiles.school_name` 유지)
3. null인 프로필 필드 (`birth_date`, `gender` 등) 모두 정규 테이블에 채움
4. 크루 관리 API가 `legacy_crew_import` 대신 정규 테이블만 사용하도록 변경
5. `crew_list_view`, `admin_crew_list_view` 삭제 또는 정규 테이블 기반으로 재정의

---

## 5단계. Cluster4 데이터 흐름 감사

---

### 설계 파이프라인 vs 실제 구현

```
DESIGNED PIPELINE:
cluster4_lines → cluster4_line_targets → cluster4_line_submissions
  → user_week_statuses → user_weekly_points → user_growth_stats → user_cumulative_points

ACTUAL IMPLEMENTATION:
cluster4_lines ✅ → cluster4_line_targets ✅ → cluster4_line_submissions ✅
  ❌ (GAP) → user_week_statuses → user_weekly_points → user_growth_stats
                                        ↓ (trigger ✅)
                                  user_cumulative_points
```

### 단계별 상세

#### Step 1: cluster4_lines (라인 개설) — ✅ 완성

| 항목 | 상태 |
|------|------|
| FK 연결 | `career_project_id → career_projects(id)`, `created_by/updated_by → admin_users(id)` |
| API 연결 | CRUD 완비 (`lib/adminCluster4LinesData.ts:363-450`) |
| 프론트 연결 | `PracticalCareerManager.tsx`, `PracticalCompetencyManager.tsx` |
| 행 수 | 0 (아직 운영 라인 미개설) |
| Source of Truth | `cluster4_lines` 테이블 |

#### Step 2: cluster4_line_targets (대상자 배정) — ✅ 완성

| 항목 | 상태 |
|------|------|
| FK 연결 | `line_id → cluster4_lines(id) CASCADE`, `week_id → weeks(id) CASCADE`, `target_user_id → user_profiles(user_id) CASCADE` |
| API 연결 | CRUD 완비 (`lib/adminCluster4LinesData.ts:452-591`) |
| 프론트 연결 | Admin 라인 관리 UI |
| target_mode | `'user'` (개인 지정) / `'rule'` (규칙 기반 — 미구현) |
| 행 수 | 0 |

#### Step 3: cluster4_line_submissions (사용자 제출) — ✅ 완성

| 항목 | 상태 |
|------|------|
| FK 연결 | `line_target_id → cluster4_line_targets(id) CASCADE`, `user_id → user_profiles(user_id) CASCADE` |
| API 연결 | User 제출 API (`lib/cluster4LinesData.ts`) |
| 검증 | DB 트리거 `validate_cluster4_line_submission()` — user_id 일치 검증 |
| 상태 판별 | 제출 존재 = `success`, 마감 후 미제출 = `fail`, 미마감 = `pending` |
| 행 수 | 0 |

#### Step 4: → user_week_statuses (주차 반영) — ❌ 미구현

| 항목 | 상태 |
|------|------|
| 연결 | **없음** — cluster4 제출 → user_week_statuses 자동 반영 코드 없음 |
| 설계 | sync-bridge-final-design.md에 계획됨 (Phase 1 deferred) |
| 현재 동작 | `user_week_statuses`는 마이그레이션 시드/seasonRest에서만 변경 |
| 미완성 이유 | "Phase 1은 user 모드 전용, activity_records까지만 동기화" (설계 문서) |

#### Step 5: → user_weekly_points (포인트 반영) — ❌ 미구현

| 항목 | 상태 |
|------|------|
| 연결 | **없음** — cluster4 제출 → 포인트 자동 계산 없음 |
| 현재 동작 | `user_weekly_points`는 시드/스크립트에서만 INSERT |
| 포인트 산출 규칙 | 미정의 (cluster4 제출물 → 포인트 매핑 로직 없음) |

#### Step 6: → user_growth_stats (성장 반영) — ❌ 미구현

| 항목 | 상태 |
|------|------|
| 연결 | Step 4 미구현이므로 자동으로 미연결 |
| 의존성 | Step 4 (week_statuses) → Step 6 (growth_stats) 트리거가 필요하지만 Step 4 자체가 없음 |

#### Step 7: → user_cumulative_points (누적 반영) — ✅ 트리거 존재 (조건부)

| 항목 | 상태 |
|------|------|
| 트리거 | `sync_cumulative_on_weekly_change` — `user_weekly_points` 변경 시 자동 동기화 |
| 전제 조건 | Step 5 (weekly_points)에 데이터가 들어와야 트리거 발동 |
| 현재 상태 | Step 5 미구현 → 트리거 미발동 |

### 보조 구조

#### activity_type_id 매핑
- `cluster4_lines.activity_type_id` (text, FK 없음)
- `cluster4WeeklyGrowthData.ts:474-478`에서 `classifyByPartType()` 함수로 분류:
  - `"competency*"` → ability
  - `"experience*"` → experience
  - `"career*"` → career
  - 나머지 → info

#### cluster4_experience_line_masters (6행)
- 경험 라인 템플릿 관리 (admin CRUD 완비)
- `cluster4_lines.experience_line_master_id` FK 연결
- 실제 라인 개설에는 아직 사용 안 됨 (cluster4_lines 0행)

#### cluster4_competency_line_masters (21행)
- 역량 라인 템플릿 관리 (admin CRUD 완비)
- `cluster4_lines.competency_line_master_id` FK 연결
- 실제 라인 개설에는 아직 사용 안 됨

#### cluster4_experience_line_evaluations (0행)
- **코드에서 완전 미참조** — 스키마만 존재
- 평가 기능 미구현

#### career_projects / career_records 관계
- `cluster4_lines.career_project_id → career_projects(id)` FK 존재
- 설계 문서: "career에 대한 레거시 동기화는 수행하지 않음"
- Career 라인은 기존 `career_projects` 시스템과 독립 운영 예정

### Weekly Cards에서의 Cluster4 데이터 소비

현재 Weekly Cards (`cluster4WeeklyGrowthData.ts:450-491`)는:
- `user_activity_details` 테이블에서 라인 완료 수 조회
- `cluster4_lines`에서 `activity_type_id → part_type` 매핑만 사용
- **`cluster4_line_submissions`는 참조하지 않음**
- 즉, Weekly Cards의 라인 카운트는 legacy `user_activity_details` 기반

---

## 6단계. 최종 정리 및 리팩토링 우선순위

---

### Stable Core Tables (안정적 운영 중)

| 테이블 | 역할 | 비고 |
|--------|------|------|
| `users` | 인증 루트 PK | |
| `user_profiles` | 핵심 프로필 | org, status, growth_status 포함 |
| `user_week_statuses` | 주간 상태 SoT | 1,940행, 핵심 계산 기준 |
| `user_weekly_points` | 주간 포인트 SoT | 1,971행, 트리거 자동 동기화 |
| `user_cumulative_points` | 누적 포인트 캐시 | 트리거로 안정적 동기화 |
| `user_memberships` | 팀/파트 소속 | 157행 |
| `user_educations` | 학력 정보 | 37행 (확대 필요) |
| `user_growth_stats` | 성장 통계 캐시 | **동기화 트리거 필요** |
| `user_edit_windows` | 편집 권한 윈도우 | |
| `user_grade_stats` | 등급/백분위 | |
| `user_season_statuses` | 시즌별 상태 | |
| `weeks` | 글로벌 주차 캘린더 | 36행 |
| `season_definitions` | 시즌 정의 | 35행 |
| `admin_users` | 관리자 계정 | |
| `permissions` / `role_permissions` | RBAC | |
| `organizations` | 조직 마스터 | |
| `activity_types` | 활동 유형 마스터 | |
| `schools` | 학교 검색 DB | 12,523행 |
| `reputation_keywords` | 평판 키워드 | |

### Legacy Tables (이관 완료 전까지 유지)

| 테이블 | 이유 | 제거 조건 |
|--------|------|----------|
| `legacy_crew_import` | `is_visible`, `admin_note` 유일 소스 + fallback | 4단계 체크리스트 완료 |
| `official_rest_weeks` | 공휴일 정의 원본 (3행) | `weeks` 통합 후 |
| `user_profiles.school_name` | `user_educations` 미이관 사용자 fallback | education 이관 완료 후 |

### Deprecated Structures (완전 제거 가능)

| 대상 | 유형 | 사유 |
|------|------|------|
| `_backup_cumulative_points_20260528` | 테이블 | 일회성 백업, 코드 참조 없음 |
| `seasons` (old) | 테이블 | `season_definitions`로 완전 대체, 1행 |
| `reputation_score_keys` | 테이블 | 코드 참조 전무, 6행 |
| `cluster4_experience_line_evaluations` | 테이블 | 미구현 기능, 코드 참조 없음, 0행 |
| `crew_list_view` | 뷰 | 코드에서 미사용 |
| `admin_crew_list_view` | 뷰 | 코드에서 미사용 |
| `test_user_markers` | 테이블 | scripts에서만 사용, 운영 불필요 |

### Dangerous Sync Risks (값 불일치 가능)

| 위험 | 심각도 | 현상 | 근본 원인 |
|------|--------|------|----------|
| `user_growth_stats.approved_weeks` 불일치 | **HIGH** | `user_week_statuses` 변경 시 미갱신 | 트리거/자동 동기화 없음 |
| `user_growth_stats.cumulative_weeks` 불일치 | **HIGH** | 동일 | 동일 |
| `legacy_crew_import.cumulative_weeks` vs `user_growth_stats` | **MEDIUM** | 두 값이 다를 수 있음 | 독립 관리, fallback 체인 |
| `user_profiles.school_name` stale | **LOW** | `user_educations` 변경 시 미갱신 | 동기화 없음 |
| `official_rest_weeks` 추가 → `weeks` 미반영 | **MEDIUM** | 런타임 조회 소스 불일치 | 자동 동기화 없음 |

### Source of Truth Conflicts (기준 충돌)

| 데이터 | 충돌 소스 | 해결 방안 |
|--------|----------|----------|
| approved_weeks | `user_week_statuses` COUNT vs `user_growth_stats` 저장값 | 트리거 추가 (B안) |
| 공식 휴식 판별 | `official_rest_weeks` vs `weeks.is_official_rest` | `weeks` 단일 소스로 통합 |
| cumulative_weeks | `user_growth_stats` vs `legacy_crew_import` | 이관 완료 후 fallback 제거 |
| school_name | `user_educations` vs `user_profiles` vs `legacy` | `user_educations` 단일 소스 |
| cluster4 성공 판정 | `cluster4_line_submissions` 존재 vs `user_week_statuses.status` | sync bridge 구현 필요 |

### Immediate Refactor Targets (최우선 정리)

| 순위 | 대상 | 작업 | 영향 범위 |
|------|------|------|----------|
| **1** | `user_growth_stats` 트리거 | `user_week_statuses` AFTER INSERT/UPDATE/DELETE → approved_weeks/cumulative_weeks 자동 재집계 | DB 트리거 1개, 함수 1개 |
| **2** | `official_rest_weeks` → `weeks` 조회 통합 | `cluster4WeeklyGrowthData.ts:150-155`에서 `weeks` 테이블 조회로 변경 | 코드 1곳 |
| **3** | deprecated 테이블 삭제 | `_backup_*`, `seasons`, `reputation_score_keys`, `cluster4_experience_line_evaluations` | DB만, 코드 변경 없음 |
| **4** | 미사용 뷰 삭제 | `crew_list_view`, `admin_crew_list_view` | DB만, 코드 변경 없음 |

### Safe Refactor Order (권장 실행 순서)

```
Phase 1: 동기화 안정화 (코드 변경 없음, DB만)
  1.1  user_growth_stats 트리거 추가
       → user_weekly_points 트리거 패턴 복제
       → approved_weeks = COUNT(status='success')
       → cumulative_weeks = COUNT(*)
  1.2  트리거 검증 스크립트 작성 (verify-growth-sync.ts)

Phase 2: 불필요 구조 제거 (코드 변경 없음, DB만)
  2.1  _backup_cumulative_points_20260528 DROP
  2.2  seasons (old) DROP
  2.3  reputation_score_keys DROP
  2.4  cluster4_experience_line_evaluations DROP
  2.5  crew_list_view DROP
  2.6  admin_crew_list_view DROP

Phase 3: 공식 휴식 단일화 (코드 1곳 + DB)
  3.1  cluster4WeeklyGrowthData.ts:150-155 → weeks 조회로 변경
  3.2  (선택) official_rest_weeks 변경 시 weeks 자동 갱신 트리거

Phase 4: Cluster4 sync bridge (설계 단계)
  4.1  cluster4_line_submissions → user_activity_details 동기화 설계
  4.2  cluster4_line_submissions → user_week_statuses 반영 규칙 정의
  4.3  user_week_statuses → user_weekly_points 포인트 산출 규칙 정의
  4.4  구현 및 테스트

Phase 5: Legacy 이관 완료 (장기)
  5.1  user_profiles에 is_visible, admin_note 컬럼 추가
  5.2  legacy_crew_import 데이터 → 정규 테이블 이관
  5.3  preferString/preferNumber fallback 제거
  5.4  크루 관리 API 정규 테이블 전용으로 변경
  5.5  legacy_crew_import DROP
```
