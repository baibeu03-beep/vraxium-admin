# Cluster4-card 빈 화면 — Seed 이전에 해결해야 할 백엔드 미스매치
_Date: 2026-05-21_
_상태: Critical pre-flight finding. seed SQL 작성을 잠시 보류함._

---

## TL;DR

> **"테스트 데이터가 부족해 화면이 안 뜬다"가 진단이지만, 실제 원인은 다른 곳에 있습니다.**

`Cluster4CardContent.tsx:1092-1093` 가 `profileResult.weekBundle.currentWeek` 를 기대하는데, 현재 운영 중인 `/api/profile` 라우트 (`app/(host)/api/profile/route.ts` 의 `context=card` 분기) 는 **`weekBundle` 키를 응답에 한 번도 넣지 않습니다**. 컴포넌트의 try/catch 가 throw 를 삼키고 `setIsLoadingWeek(false)` 로 떨어지면서 페이지는 그려지지만 **모든 섹션이 빈 상태** — 사용자가 보고 있는 증상의 정체입니다.

**seed SQL 을 아무리 정확하게 작성해도 이 미스매치는 해결되지 않습니다.** 페이지가 weekBundle 을 못 받으면 그 안에 들어 있어야 할 `activity_types / currentWeek / weekly_activities / user_weekly_growth / allWeeks / allPoints / successWeeks` 가 전부 빈 상태로 남고, weekly_reviews / weekly_colleagues / weekly_reputations / career-records 도 보조 API 로는 따로 받지만 페이지 골격이 못 그려져 뒤따라오는 렌더가 의미를 잃습니다.

선후관계: **(1) backend 패치 → (2) 실 페이지 진입해서 어떤 데이터가 비어 보이는지 사용자 확인 → (3) 부족한 user-specific row 만 seed**. (3) 의 seed scope 는 (2) 를 보고 결정해야 정확해집니다.

---

## 1. 증상의 정확한 메커니즘

### 1.1 Frontend 의 기대값

`components/cluster-4-card/Cluster4CardContent.tsx:1067-1095`:

```tsx
const [profileResponse, earlyApiResults] = await Promise.all([fetch(profileUrl), earlyApiPromise]);
// ...
const profileResult = await profileResponse.json();
// ...
// ========== weekBundle에서 주차 관련 데이터 추출 (서버 사이드 번들) ==========
const wb = profileResult.weekBundle;
if (!wb || !wb.currentWeek) throw new Error("Week not found");

const activityTypesData = wb.activityTypes;
const currentWeek = wb.currentWeek;
// ...
const weeklyGrowthData = wb.weeklyGrowth;
const allPointsData = wb.allPoints || [];
const successWeeksData = wb.successWeeks || [];
const allUserWeeksData = wb.allWeeks || [];
```

### 1.2 Backend 의 실제 응답

`app/(host)/api/profile/route.ts:393-443` (context=card 분기) — 응답 키 전체:

```
{ success, data, onboardingWeekId, growthInfo, activityWeekIds, restWeekIds,
  approvedActivities, activityRecords, activityDetails, activityPoints,
  userRoleHistory, userTeamParts, teams, parts, resumeCardSettings }
```

`weekBundle` 키가 **없음**. `grep "weekBundle" app/(host)/api/profile/route.ts` 결과 0건.

### 1.3 실패 흐름

```
fetch /api/profile?context=card&weekId=…
  → 200 응답 { success:true, ..., weekBundle: undefined }
  → const wb = profileResult.weekBundle      // undefined
  → if (!wb || !wb.currentWeek) throw new Error("Week not found")
  → throw 가 outer try (line 1042) 의 catch (line 1550) 에 잡힘
  → console.error("주차 데이터 로드 오류:", Error("Week not found"))
  → finally: setIsLoadingWeek(false)
  → 컴포넌트가 isLoadingWeek=false 로 정상 렌더되지만
    weekData / activityTypesMap / careerRecords / weekActivityDetails ... 모두 빈 상태
  → 사용자 눈에는 "데이터 없음" 카드들만 보임
```

`isLoadingWeek` 자체는 5840 줄에서 단일 placeholder div 만 그리는 짧은 분기라, fetch 가 실패해도 페이지 자체는 살아 보임. 단 콘솔에 `주차 데이터 로드 오류: Error: Week not found` 가 떨어집니다 — 사용자 측 브라우저 DevTools Console 을 확인하면 이 메시지가 정확히 보일 것입니다.

---

## 2. 원인 — 머지 누락된 commit 의 부분 적용

### 2.1 Git history

```
$ git log --all -S "weekBundle"
1de7040 클러스터 4 커밋
def0554 cluster-4-card: admin 승인 체크 bypass + weekBundle 활용 리팩터
001777e perf: cluster-4-card 데이터 로딩 속도 개선 — 하드코딩 더미 제거 + 서버 번들 쿼리
```

- **001777e (Thu Mar 19 2026, Jiwoo)**: weekBundle 응답을 `app/api/profile/route.ts` (host 그룹 **밖**) 에 추가한 commit. 컴포넌트 측 weekBundle 의존성도 같은 PR 에서 도입.
- 그 이후 어떤 PR 에서 profile 라우트가 `app/api/profile/route.ts` → `app/(host)/api/profile/route.ts` 로 이동된 것으로 보임. 그 이동 과정에서 **weekBundle 응답 코드 52줄이 옮겨지지 못함**.

현재 파일시스템:
```
app/(host)/api/profile/route.ts  ← 운영 중. weekBundle 미존재
app/api/profile/route.ts          ← 파일 없음
```

따라서 컴포넌트 (weekBundle 의존성 유지) 와 라우트 (weekBundle 응답 제거됨) 가 **머지 시점에 분리되어 좌초된 상태** 입니다.

### 2.2 누락된 52줄 (commit 001777e diff)

`app/(host)/api/profile/route.ts` 의 `context === 'card'` 분기 시작 (현 라인 393) 바로 안쪽에 다음을 그대로 옮기면 패치 완료:

```ts
const weekId = searchParams.get('weekId');

// weekId가 있으면 주차 관련 데이터도 함께 번들 (클라이언트 Supabase 직접 쿼리 제거)
const weekQueries = weekId ? [
  // [10] activity_types (full columns for card page)
  supabaseAdmin.from("activity_types")
    .select("id, name, line_code, cluster_id, description, eligible_min_approved_weeks, eligible_max_approved_weeks, count_once_in_total")
    .eq("is_active", true),
  // [11] current week
  supabaseAdmin.from("weeks")
    .select("id, week_number, start_date, end_date, is_club_break, holiday_name, seasons (id, year, name)")
    .eq("id", weekId)
    .single(),
  // [12] all weeks (for prev/next navigation)
  supabaseAdmin.from("weeks")
    .select("id, start_date, end_date, season_id, seasons(name)")
    .order("start_date", { ascending: false }),
  // [13] weekly_activities for this week
  supabaseAdmin.from("weekly_activities")
    .select("id, activity_type_id, title, is_active, opened_at, output_links")
    .eq("week_id", weekId),
  // [14] user_weekly_growth for this week
  supabaseAdmin.from("user_weekly_growth")
    .select("is_success, is_resting, is_club_break, failure_reason")
    .eq("user_id", profile.id)
    .eq("week_id", weekId)
    .maybeSingle(),
  // [15] all points for user (all types)
  supabaseAdmin.from("points")
    .select("week_id, point_type, points")
    .eq("user_id", profile.id),
  // [16] success weeks for cumulative count
  supabaseAdmin.from("user_weekly_growth")
    .select("week_id, weeks!inner(end_date)")
    .eq("user_id", profile.id)
    .eq("is_success", true),
] as const : [];
```

그리고 기존 `Promise.all([...])` 배열 끝에 `...weekQueries` 를 spread 한 뒤, 반환 객체에 `weekBundle` 키를 추가:

```ts
const weekBundle = weekId && weekResults.length === 7 ? {
  activityTypes: weekResults[0]?.data || [],
  currentWeek: weekResults[1]?.data || null,
  allWeeks: weekResults[2]?.data || [],
  weeklyActivities: weekResults[3]?.data || [],
  weeklyGrowth: weekResults[4]?.data || null,
  allPoints: weekResults[5]?.data || [],
  successWeeks: weekResults[6]?.data || [],
} : null;

return NextResponse.json({
  // ... 기존 키들 그대로
  weekBundle,
});
```

이 변경은 **`context === 'card'` 분기에만 영향**하며, 기존 `context=card` 응답 키들은 그대로 유지됩니다. 즉 cluster-4-1 / cluster-4 / 다른 페이지의 profile 호출에는 영향 없음.

---

## 3. 회귀 영향 평가

| 영역 | 영향 |
|---|---|
| `/cluster-4` (Cluster41Content) | ❌ 없음 — `context=card` 분기를 안 씀 |
| `/cluster-4-1` (Cluster4Content) | ❌ 없음 — `context=card` 분기를 안 씀 |
| `/cluster-4-card/[weekId]` (Cluster4CardContent) | ✅ 정상화 — weekBundle 받아서 페이지가 데이터 흐름대로 렌더 |
| Sidebar / Resume card / 기타 profile 호출 | ❌ 없음 — `context` 미지정 또는 다른 값 |
| 데이터 정합성 | ❌ 위험 없음 — 모두 read-only SELECT, write 0 건 |

쿼리 7개 추가로 인한 부하: weekId 지정 시에만. 모두 `eq` 또는 `single` 기반이라 인덱스 활용. 운영 부하 증가는 무시할 수준.

---

## 4. 권장 진행 순서

### Step A (선행 필수) — backend 패치 1건

`app/(host)/api/profile/route.ts` 의 `context === 'card'` 분기에 §2.2 의 코드 적용. **이 PR 만으로 페이지가 일단 데이터를 받기 시작**.

승인 받으면 제가 패치를 작성하겠습니다. 또는 사용자가 직접 적용해도 동일. 어느 쪽이든 변경은 한 파일 한 분기.

### Step B — 사용자 페이지 실제 진입 확인

패치 적용 후 본인 계정으로 `/cluster-4-card/<weekId>` 진입. 그 시점에 어떤 섹션이 빈 카드로 남는지 사용자가 직접 확인 (DevTools Console 로 `[DEBUG] weekId: ...` 메시지 확인 가능). 가능한 빈 카드 시나리오:

- 본인의 `user_weekly_growth` row 없음 → 성장 상태가 phase 기반으로만 결정 (정상 동작)
- 그 주차의 `weekly_activities` 없음 → 4 grid 카드가 슬롯 0개로 비어 보임
- 그 주차의 `career_projects` × `career_project_weeks(is_active=true)` 없음 → 실무 경력 카드가 emptyCareerCard fallback 1개로 표시 (line 5755)
- 본인 `user_activity_details` 없음 → workinfo/workability/workexp 각 카드의 sub_title/image 비어 있음
- 본인 `weekly_reputations` (target) 없음 → 평판 카드 7장 모두 비어 보임
- 본인 `weekly_colleagues` 없음 → 연계 동료 3 슬롯 모두 비어 보임
- 본인 `weekly_reviews` 없음 → "아직 작성된 리뷰가 없습니다…" 박스 (정상, 작성 가능)

마지막 3 가지는 **빈 상태가 정상** (Phase 1 smoke test 의 "신규 작성 → 저장 → 새로고침" 시나리오를 위해 비어 있어야 함). 앞 4 가지는 master 데이터가 빠진 경우라 seed 대상이 됩니다.

### Step C — 필요한 만큼만 seed

Step B 결과에 따라 seed 범위가 다음 둘 중 하나로 좁혀집니다:

- **(C-min)** master 도 다 있는 상태 (= weekly_activities/career_projects 가 그 주차에 정상 등록되어 있음) → seed 불필요. 곧장 Phase 1 smoke test 진행 가능
- **(C-master+user)** master 일부가 빠진 상태 → 빠진 master row + user-specific 시각화용 row 만 seed

Step B 없이 미리 seed 작성하면 over-engineering 위험. 정확한 scope 는 페이지 한 번 띄워보고 결정하는 게 훨씬 안전합니다.

---

## 5. 사용자 결정 요청

다음 두 가지 중 어느 쪽이든 알려주세요. 본 단계는 그 답을 받기 전까지 더 진행하지 않습니다.

| 옵션 | 내용 |
|---|---|
| **(1) backend 패치를 제가 작성** | `app/(host)/api/profile/route.ts` 의 `context === 'card'` 분기에 §2.2 의 52줄 패치를 PR 형식으로 작성. 변경 파일 1개. seed SQL 은 패치 적용 후 Step B 의 사용자 확인을 거쳐 별도 단계로 작성. |
| **(2) 사용자가 직접 패치** | §2.2 의 diff 를 그대로 사용. 적용 후 Step B 확인 결과를 알려주시면 그 시점에 seed scope 를 결정해 SQL 작성. |

부수적으로 확인해주실 정보 (선택):
- 본인 계정 `/cluster-4-card` 접근 시 브라우저 Console 에 `주차 데이터 로드 오류: Error: Week not found` 메시지가 떨어지는지 — 떨어진다면 §1.3 의 메커니즘 확정

---

## 6. 본 단계 산출물

| 분류 | 내역 |
|---|---|
| 코드 수정 | **0** |
| Migration | **0** |
| Supabase 변경 | **0** |
| 신규 문서 | 본 보고서 1건 (`claudedocs/cluster4-card-prerequisite-weekbundle-gap-20260521.md`) |
| Seed SQL | **작성 보류** — Step A 결정 후 Step C 에서 작성 |

사용자가 요청한 4 산출물 (최소 렌더링 조건, seed SQL, cleanup SQL, user/week 안내) 은 §4 의 Step C 시점에 완성합니다. Step A 가 선행되지 않으면 Step C 의 결과물이 production 에서 효력이 없기 때문입니다.
