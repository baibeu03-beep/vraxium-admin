# Cluster4-card — weekBundle 응답 복원 패치
_Date: 2026-05-21_
_Scope: Career-Resume `app/(host)/api/profile/route.ts` context=card 분기에 weekBundle 응답 복원_

---

## 0. Deliverables Summary

| # | 산출물 | 위치 |
|---|---|---|
| 1 | 패치 적용 코드 | `Career-Resume/app/(host)/api/profile/route.ts` (context=card 분기) |
| 2 | Diff 보고서 + Front shape 매칭 | 본 문서 |
| 3 | 검증 단계 (사용자 실행) | §5 |

코드 수정: **1 파일** (profile 라우트). Migration / Supabase 변경 / Front 변경: **0**.

---

## 1. 변경 위치

**파일**: `Career-Resume/app/(host)/api/profile/route.ts`

**분기**: `if (context === 'card') { ... }` (적용 전 393~443 줄 → 적용 후 약 393~501 줄, +58 줄)

**미영향 분기**: 같은 라우트 안 line 444 이후의 main 응답 분기 — 손대지 않았습니다. cluster-4 / cluster-4-1 / Sidebar / Cluster1 등 다른 호출자는 영향 없음.

---

## 2. Diff 요약

### 2.1 추가된 코드 블록 — 3개

**(A) weekQueries 배열** (`if (context === 'card') {` 직후):
- weekId 가 있을 때만 7개 SELECT 쿼리를 준비.
- weekId 없으면 빈 배열 → 기존 sidebar 등 호출 행동에 변화 없음.
- `as const` 로 readonly tuple — `Promise.all` 결과 타입 추론 보존.

**(B) destructure 확장** (`Promise.all` 결과 받는 부분):
- 기존 10개 변수 + `...weekResults` rest 패턴 추가.
- `Promise.all` 배열 끝에 `...weekQueries` spread.

**(C) weekBundle 객체 생성** (`completedActivities` 다음, `return` 직전):
- `weekResults.length === 7` 가드 — `weekQueries` 가 비어 있을 때 `null` 반환.
- 응답에 `weekBundle` 키 추가.

### 2.2 추가된 SELECT 7개 (Supabase 쿼리)

| # | 테이블 | 컬럼 | 필터 |
|---|---|---|---|
| 0 | `activity_types` | `id, name, line_code, cluster_id, description, eligible_min_approved_weeks, eligible_max_approved_weeks, count_once_in_total` | `is_active = true` |
| 1 | `weeks` | `id, week_number, start_date, end_date, is_club_break, holiday_name, seasons (id, year, name)` | `id = weekId` + `single()` |
| 2 | `weeks` | `id, start_date, end_date, season_id, seasons(name)` | `ORDER start_date DESC` |
| 3 | `weekly_activities` | `id, activity_type_id, title, is_active, opened_at, output_links` | `week_id = weekId` |
| 4 | `user_weekly_growth` | `is_success, is_resting, is_club_break, failure_reason` | `user_id, week_id = weekId` + `maybeSingle()` |
| 5 | `points` | `week_id, point_type, points` | `user_id` |
| 6 | `user_weekly_growth` | `week_id, weeks!inner(end_date)` | `user_id, is_success = true` |

모두 read-only SELECT. write 0건. RLS 영향 없음 (service_role).

### 2.3 응답 shape 변경

기존 응답 키 모두 유지. **`weekBundle` 키 1개만 추가**.

```jsonc
{
  "success": true,
  "data": { /* user_profiles 행 */ },
  "onboardingWeekId": "...",
  "growthInfo": { "startDate": "YYYY-MM-DD" | null },
  "activityWeekIds": [...],
  "restWeekIds": [...],
  "approvedActivities": [...],
  "activityRecords": [...],
  "activityDetails": [...],
  "activityPoints": [...],
  "userRoleHistory": [...],
  "userTeamParts": [...],
  "teams": [...],
  "parts": [...],
  "resumeCardSettings": { ... },

  // ★ 추가
  "weekBundle": {
    "activityTypes": [...],   // 7번째 [0]
    "currentWeek": {...} | null, // [1]
    "allWeeks": [...],        // [2]
    "weeklyActivities": [...],// [3]
    "weeklyGrowth": {...} | null, // [4]
    "allPoints": [...],       // [5]
    "successWeeks": [...]     // [6]
  } | null
}
```

`weekBundle` 은 `weekId` 미지정 시 `null`.

---

## 3. Front 기대 shape vs 응답 shape 매칭

`Cluster4CardContent.tsx:1092-1152` 와 1:1 비교:

| Front 라인 | 기대 필드 | 응답 필드 | 일치 |
|---|---|---|---|
| L1092 | `profileResult.weekBundle` | `weekBundle` | ✅ |
| L1093 | `wb.currentWeek` | `weekBundle.currentWeek` (= `weekResults[1].data`) | ✅ |
| L1095 | `wb.activityTypes` | `weekBundle.activityTypes` (= `weekResults[0].data`) | ✅ |
| L1106 | `at.id, at.cluster_id, at.eligible_min_approved_weeks, at.eligible_max_approved_weeks, at.count_once_in_total` | activity_types SELECT 컬럼과 모두 일치 | ✅ |
| L1131 | `currentWeek.seasons` | weeks SELECT 의 `seasons (id, year, name)` join | ✅ |
| L1149 | `wb.weeklyGrowth` | `weekBundle.weeklyGrowth` (= `weekResults[4].data`) | ✅ |
| L1150 | `wb.allPoints` | `weekBundle.allPoints` (= `weekResults[5].data`) | ✅ |
| L1151 | `wb.successWeeks` | `weekBundle.successWeeks` (= `weekResults[6].data`) | ✅ |
| L1152 | `wb.allWeeks` | `weekBundle.allWeeks` (= `weekResults[2].data`) | ✅ |
| L1155 | `w.end_date` (allWeeks filter) | `weeks SELECT end_date` 포함 | ✅ |
| L1167 | `weeklyGrowth?.is_success`, `is_resting`, `is_club_break` | user_weekly_growth SELECT 컬럼과 일치 | ✅ |
| L1213 | `currentWeek.id, week_number, start_date, end_date, is_club_break, holiday_name` | weeks SELECT 컬럼과 일치 | ✅ |
| L1215 | `seasonData.year`, `seasonData.name` | `seasons (id, year, name)` join 결과 | ✅ |

**불일치 0건**. Front 가 weekBundle 에서 읽는 모든 필드가 응답에 존재합니다.

`weekly_activities` 와 `points` (allPoints) 의 사용은 컴포넌트 후반부 (라인 1400+ 부근) 의 통계 계산 (`infoStats / competencyStats / experienceStats`) 에서 활용. SELECT 한 컬럼이 그쪽 로직과도 일치 — `weekly_activities.{id, activity_type_id, title, is_active, opened_at, output_links}`, `points.{week_id, point_type, points}`.

---

## 4. 회귀 영향 평가

| 영역 | 변경 효과 |
|---|---|
| `/cluster-4-card/[weekId]` (Cluster4CardContent) | ✅ 정상화. weekBundle.currentWeek 가 채워져 throw 없이 데이터 흐름 진행 |
| `/cluster-4` (Cluster41Content) | ❌ 영향 없음. context=card 분기를 호출하지 않음 |
| `/cluster-4-1` (Cluster4Content) | ❌ 영향 없음. 동상 |
| Sidebar / Resume card | ⚠️ context=card 를 호출하지만 weekId 없음 → `weekQueries = []` → `weekBundle = null` → 기존 응답 키들 + weekBundle: null 만 추가. Sidebar 가 weekBundle 키를 안 읽으면 무영향 (현재 호출자 코드 그대로 동작) |
| Other profile API consumers | ❌ context=card 가 아니면 무영향 |
| 데이터베이스 | ❌ 변경 없음. read-only SELECT 만 |
| 성능 | weekId 지정 시 쿼리 7개 추가. 모두 인덱스 활용 (`weeks.id` PK, `user_weekly_growth(user_id, week_id)`, `points.user_id`). 운영 부하 무시 가능 |

---

## 5. 검증 단계 (사용자 실행)

### 5.1 dev 서버 빌드 / 타입 체크

Career-Resume 디렉토리에서:
```
npm run build
# 또는
npx tsc --noEmit
```
기대: error 0건. weekResults 의 union type 이 `weekResults[i]?.data` 접근에 OK.

⚠️ 만약 TypeScript strict mode 에서 `weekResults[6]?.data` 가 type error 를 낸다면 한 줄씩 type assertion 추가하는 hotfix 가능 — 그러나 commit 001777e 의 원본도 같은 패턴을 썼고 통과했으므로 우려 낮음.

### 5.2 cluster-4-card 진입 후 콘솔 / 네트워크 검증

본인 계정으로 `/cluster-4-card/<weekId>` 접속.

| # | 확인 위치 | 기대 |
|---|---|---|
| V1 | 브라우저 DevTools Console | `주차 데이터 로드 오류: Error: Week not found` **사라짐** |
| V2 | DevTools Console | `[DEBUG] weekId: <weekId>` 메시지 정상 출력 (line 5872) |
| V3 | DevTools Network → `/api/profile?...&context=card&weekId=...` Response | `weekBundle` 키 존재 + `weekBundle.currentWeek.id` 가 URL 의 weekId 와 일치 |
| V4 | Network 응답 | `weekBundle.activityTypes` 길이 > 0 (production 의 activity_types is_active=true row 수) |
| V5 | 페이지 화면 | 상단 주차 정보 영역 (year/season/week_number/start_date~end_date) 가 표시됨 |
| V6 | 페이지 화면 | 4 grid (실무 정보/역량/경험/경력) 가 슬롯 자체는 그려짐 (내용물은 user-specific 데이터 여부에 따라 비어 있을 수 있음 — Step C 의 seed 결정 input) |

V3 ~ V5 가 모두 ✅ 이면 **weekBundle 미스매치 blocker 해소 확정**.

### 5.3 회귀 가드 — 다른 페이지

| # | 페이지 | 확인 |
|---|---|---|
| R1 | `/cluster-4-1` 진입 | Season Review / Reputation 정상 작동 (변경 0 — 그대로 작동해야 함) |
| R2 | `/cluster-4` 진입 | Weekly Cards 리스트 정상 표시 |
| R3 | 사이드바 (Cluster1 영역) | 정상 표시 |

위 3개 모두 ✅ 이면 회귀 영향 0 건 확인.

---

## 6. 다음 단계 — seed scope 결정 input

§5.2 V6 시점에 사용자가 다음을 관찰해주세요:

1. **상단 주차 카드** (`weekData`) 표시 정상? → master 데이터 (`weeks`, `seasons`) OK
2. **4 grid 슬롯 개수** (실무 정보/역량/경험/경력) → master 데이터 (`activity_types`, `weekly_activities`) 상태 확인
3. **실무 정보 카드의 내용물** (sub_title/output_links/images) → user-specific (`user_activity_details`) 상태 확인
4. **실무 경력 카드** (career line cards) → master (`career_projects` + `career_project_weeks(is_active=true)`) 상태 확인
5. **평판 카드 7장** → user-specific (`weekly_reputations` target=본인) 상태 확인. 비어 있는 게 정상 (smoke test 대상)
6. **연계 동료 3슬롯** → user-specific (`weekly_colleagues`) 상태 확인. 비어 있는 게 정상
7. **Weekly Review 박스** → user-specific (`weekly_reviews`) 상태 확인. 비어 있는 게 정상

위 7개 관찰 결과를 알려주시면 **정확히 어떤 row 만 seed 해야 하는지**가 결정됩니다. 모두 master+user 가 있다면 seed 0건으로 곧장 Phase 1 smoke test 진행. master 일부가 빠진 경우 그 부분만 seed.

---

## 7. 본 단계 변경 요약

| 분류 | 내역 |
|---|---|
| 수정한 파일 | 1 (`Career-Resume/app/(host)/api/profile/route.ts`) |
| 추가 줄 수 | 약 58 (weekQueries 정의 + weekResults destructure + weekBundle 생성 + 응답 키) |
| 제거 줄 수 | 0 |
| Migration | 0 |
| Supabase 변경 | 0 |
| Front 변경 | 0 |
| 신규 문서 | 본 보고서 1건 |
| Seed SQL 작성 | 계속 보류 (§6 의 사용자 확인 후 결정) |
