# 설계: 2026-summer 이후 운영 주차 `user_week_statuses` 생성/갱신 구조

작성일: 2026-07-08
상태: **설계(미구현)** — resolver-only 패치는 보류. 본 문서 승인 후 구현.

관련 코드:
- 진입점: `app/api/admin/team-parts/info/weeks/[weekId]/review/route.ts` → `lib/adminTeamPartsInfoWeekDetailData.ts::markTeamPartsWeekReviewed`
- 공표/재계산: `lib/adminWeekRecognitionsData.ts` (`publishWeekResult`, `markWeekResultPublished`, `recomputeCohortSnapshots`)
- verdict 엔진(재사용): `lib/cluster4WeeklyGrowthData.ts` (`fetchExperienceRequiredSlotStatusByWeek`), `lib/growthCore.ts` (`resolveWeekResultStatus`)
- 카드 판정: `lib/growthResolve.ts::buildResolvedWeeks`
- 성장 캐시: `lib/userGrowthStatsData.ts::recalcUserGrowthStats`
- 스냅샷: `lib/cluster4WeeklyCardsSnapshot.ts::recomputeWeeklyCardsSnapshotsForUsers`

---

## 0. 배경 — 왜 이 설계가 필요한가

전수 조사 결과, **런타임(admin·front)에서 `user_week_statuses`(이하 uws)를 생성하는 코드는 0건**이다. uws는 오직 일회성 이관/백필 스크립트로만 INSERT되어 왔다. 그러나:

- **누적/졸업 판정**(`user_growth_stats.approved_weeks = recalcUserGrowthStats(uws success 합산)`),
- **주간 랭킹**(`weekly-league.ts`가 uws.status를 SoT 스냅샷으로 read),
- **카드 확정 표시**(`resolveWeekResultStatus`가 uws.status를 base 로 success/fail 판정),
- **finalization 코호트**(`recomputeCohortSnapshots`가 uws 보유자를 코호트로 사용)

이 모두 **persisted uws에 의존**한다. 2025 시즌까지는 PMS 이관으로 uws가 채워졌으나, **2026-summer는 이관 대상이 아닌 첫 순수 운영 시즌**이라 uws가 없다. 그 결과:

1. 참여자(`user_season_statuses`)만 있고 uws 없는 회원은 skeleton 카드(`tallying`)로만 노출됨.
2. **검수 완료 → `weeks.result_published_at` 세팅 → resolver 가 "공표됨 + uws 없음"을 `no_data`로 드롭 → 카드 소멸**(`growthCore.ts:130`).

즉 근본 결함은 resolver 가 아니라 **운영 주차 uws 생성 플로우 부재**다. 본 설계는 검수 완료(공표)를 "주차 결과 확정 및 uws persist" 이벤트로 정식화한다.

### 0.1 프로세스 포인트 SoT (2026-07-08 추가 조사)

verdict 의 check 게이트가 읽는 포인트의 출처를 코드로 확정했다:

- **원장 SoT = `process_point_awards`** (프로세스 체크 완료 시 적립. `(source, ref_id, user_id)` UNIQUE·멱등).
- **`user_weekly_points.points` = 파생값** = `SUM(process_point_awards.point_check)` for (user, iso_year, iso_week) — **재계산(recompute)이며 증분 아님**(`processPointAccrual.ts:114`).
- **check 게이트가 읽는 값 = `user_weekly_points.points` 단일 SoT** (`WeekCheckGate.earned`, `lineAvailability.ts:1028`). 고객 카드(`points.star`)·어드민 크루결과·이력서·weekly-league 가 **전부 동일 컬럼**을 읽는다 → verdict 의 게이트와 화면 표시가 100% 같은 SoT.
- 적립 트리거: 정규 체크 완료(`accrueForCompletedRegular`)·변동(`accrueForCompletedIrregular`)·due-sweep·worker 브리지·Action Control — 전부 `applyAward → recomputeWeeklyPoints` 단일 choke point.

**본 설계는 이 적립 로직을 일절 변경하지 않는다** — uws 생성기는 verdict 엔진을 통해 `user_weekly_points.points` 를 **읽기만** 한다(쓰기 대상은 `user_week_statuses` 뿐, 물리적으로 분리).

### 0.2 ⚠ 필수 전제조건 — "적립 완료 후 검수 완료"

check 게이트는 `earned = user_weekly_points.points`(행 없으면 **0**)를 읽는다. 따라서 **그 주차의 프로세스 체크 적립이 끝나기 전에 검수 완료를 누르면 전원 `earned=0` → check 게이트 전원 실패 → uws 전원 `fail` 확정** 사고가 난다.

→ **운영 순서(불변): 프로세스 체크 완료·적립 → (user_weekly_points.points 확정) → 검수 완료(uws 확정).**
→ 이 순서를 코드로 강제하는 **안전장치**(§안전장치)를 추가한다.

---

## 1. 검수 완료 시 uws upsert 전체 흐름

`markTeamPartsWeekReviewed(weekId, actor)` 를 아래 순서로 확장한다. **단계 순서가 곧 정합의 핵심**이다.

```
[0] 주차 로드 + 게이트
    - weeks row (id, season_key, week_number, start_date, end_date,
                 result_published_at, result_reviewed_at) 조회
    - 레거시 게이트: start_date < CLUSTER4_SLOT_POLICY_EFFECTIVE_FROM(2026 여름 W1)
      → uws 생성 단계 전체 SKIP (기존 동작 그대로: publish+review 만). §5 참조
    - 현재/미래 주차 게이트: start_date >= 현재 주차 시작 → uws 생성 SKIP. §4 참조

[1] 코호트 산정 (roster 기반 — uws 기반 아님)         → §2
    cohortUserIds = 해당 주차 season 참여자 ∩ org ∩ (test/QA 정책)

[2] 주차 종합 verdict 계산 (기존 엔진 재사용)          → §3
    perUser: Map<userId, "success"|"fail"|"personal_rest"|null>

[3] uws upsert (멱등·레거시 보호·provenance 기록)      → §5·§6·§8
    - 각 cohort user 에 대해 status 결정(§4) 후 upsert
    - 생성/갱신 provenance 를 finalize run-log 에 기록(롤백용)

[4] 공표: weeks.result_published_at 세팅 (미공표 시)    → 기존 로직
    - ⚠ org/club 스코프 결정 필요(§2 열린 이슈)

[5] snapshot 재계산 (uws 확정 후!)                    → §7
    recomputeWeeklyCardsSnapshotsForUsers(cohortUserIds)

[6] 성장 캐시 재집계
    recalcUserGrowthStats(각 cohort user)  (best-effort)

[7] 검수: weeks.result_reviewed_at 세팅                → 기존 로직

[8] run-log 반환/저장 (§8 롤백 근거)
```

핵심 원칙: **uws 를 먼저 확정(2~3)한 뒤 공표(4)·스냅샷(5)** 을 한다. 그래야 스냅샷 재계산 시점에 resolver 가 읽는 uws.status 가 이미 최종값이라 카드가 정확히 success/fail 로 굳는다(no_data 드롭 원천 소멸).

---

## 2. 코호트 산정 기준

### 2.1 왜 기존 `loadCohort` 를 못 쓰는가
`adminWeeklyCardFinalizationData.ts:199` `loadCohort` 는 `user_week_statuses` 를 `week_start_date` 로 스캔한다 → **uws 가 이미 있다는 전제**. uws 를 "생성"하는 본 설계에는 순환이라 사용 불가.

### 2.2 새 코호트 = 시즌 로스터 기반
```
cohort =
  user_season_statuses  WHERE season_key = week.season_key          -- 그 주차 시즌 참여자
    ∩ user_profiles.organization_slug = <org>                        -- org 스코프
    ∩ (test/QA 정책, 아래)
    − user_profiles.growth_status ∈ {suspended, paused}              -- 성장 중단 제외(개설 게이트와 동일 원칙)
```
- **season_key** 은 대상 주차의 `weeks.season_key`(=2026-summer). 카드 skeleton 열거(`computeWeeklyCards:497`)와 동일한 "시즌 참여자" 정의 → 화면과 코호트 일치.
- **org**: 아래 §2.4 열린 이슈 참조.
- 참여 상태별: `active`/`graduated` = 정상 판정 대상, `rest`(시즌 전체 휴식) = 그 주차 `personal_rest`(§4).

### 2.3 mode=test 테스트 유저 포함 + QA_HIDE_REAL_USERS 정책 유지
기존 `recomputeCohortSnapshots`(`adminWeekRecognitionsData.ts:711`)·`loadCohort`(`:219`)와 **동일 기준을 그대로 재사용**한다(새 기준 금지):
- `keepTestOnly = QA_HIDE_REAL_USERS || scope === "qa"` → true 면 코호트를 `fetchTestUserMarkerIds()` 등재 유저로 좁힘(실유저 uws 무접촉).
- 운영(QA_HIDE_REAL_USERS=false, operating) → 코호트에서 test_user_markers 제외(실유저만).
- 즉 **"화면에 보이는 모집단 == uws 를 쓰는 대상"** 불변식 유지. mode=test 페이지는 QA 정책 스위치를 통해 테스트 유저만 대상이 된다.

### 2.4 ⚠ 열린 이슈 — org/club 스코프 vs 전역 공표
`weeks.result_published_at` 은 **주차 전역(org 무관)** 이다. 그런데 검수 완료 버튼은 **club=encre** 처럼 org 스코프다. 만약 encre 검수 완료가 (a) 전역 공표하면서 (b) encre 로스터 uws 만 생성하면, **oranke/phalanx 참여자는 "공표됨 + uws 없음" → 동일한 no_data 드롭**이 재현된다.

해결 옵션(구현 전 결정 필요):
- **옵션 A (권장): 전역 공표 시 전체 org 로스터 uws 를 생성.** club 파라미터는 UI/act-check 뷰 스코프일 뿐, uws 생성 코호트는 그 주차 전체 시즌 참여자(모든 org). 공표가 전역이므로 uws 도 전역이어야 정합.
- **옵션 B: org별 공표로 전환.** `weeks.result_published_at`(전역) 대신 org별 공표 상태 테이블 도입 → 대규모 변경. 비권장(범위 과다).
- **옵션 C: 공표를 "모든 club 검수 완료" 까지 지연.** club별 uws 만 생성하고, 마지막 club 검수 시 전역 공표. 워크플로우 복잡.

→ **권장 = 옵션 A.** 이하 설계는 옵션 A 기준(코호트 = 대상 주차 시즌 참여자 전체 org, QA 정책 적용).

---

## 3. 주차 종합 verdict 계산 방식 (새 공식 금지)

### 3.1 왜 weeklyLeaguePmsAggregation 을 못 쓰는가
`lib/weeklyLeaguePmsAggregation.ts:25` `WEEKLY_LEAGUE_SEASON_KEY = "2026-spring"` — **spring 전용, 여름은 자동 비활성**(usable=false). 따라서 2026-summer verdict 소스로 부적합.

### 3.2 여름 verdict SoT = 카드 read-time 엔진 (그대로 재사용)
2026-summer(신정책) 주차의 주차 성공/실패는 이미 카드가 read-time 으로 계산한다. **그 계산을 그대로 재사용**해 uws 에 persist 하면 "카드 == uws" 가 구조적으로 보장된다. 구성요소(전부 기존 함수):

1. **실무 경험 필수 슬롯 verdict** — `fetchExperienceRequiredSlotStatusByWeek(userId, weekIds, now, {alwaysOpenWeekIds, organizationSlug, effectiveFrom})`
   - 필수 슬롯(도출·분석·견문·관리) 평점 ≥4 → pass, ≤3 → fail, 미평가 → pending.
2. **check 게이트(신정책 v21)** — 이미 위 verdict 의 `checkGate` 에 내장됨:
   `user_weekly_points.points >= org_week_thresholds.check_threshold ?? weeks.check_threshold ?? 30`.
   신정책 주차는 `enforced=true` → check 미달이면 verdict fail.
3. **휴식** — `official_rest_periods` / `crew_personal_rest_periods` / `user_season_statuses.status='rest'`.

### 3.3 verdict → base status 파생 (유일한 신규 glue, 새 "공식" 아님)
현재 `resolveWeekResultStatus` 는 uws.status 를 base 로 받아 experience-fail 만 overlay 한다(생성 불가). uws 를 **생성**하려면 base 를 verdict 에서 파생해야 한다. 파생 규칙(신정책 주차 한정):

| experienceVerdict.status | 파생 uws.status |
|---|---|
| `pass` | `success` |
| `fail` | `fail` |
| `pending`(미평가) | **uws 미생성 → tallying 유지** (평가 입력 전 확정 불가) |
| `not_applicable`(내 팀 미개설) | **uws 미생성 → tallying 유지** 또는 정책상 fail (아래 열린 이슈) |

이 파생값은 `resolveWeekResultStatus` 가 "uws.status 가 그 값이었다면" 산출할 값과 동일 → 카드 표시 불변, 단지 persist 될 뿐.

⚠ **열린 이슈(정책 확인 필요)**: `pending`/`not_applicable` 참여자를 공표 시점에 어떻게 확정할지.
- 권장: `pending`(평가 미입력) = **아직 공표 부적격** → 그 주차는 검수 완료를 막거나, 해당 유저만 uws 미생성(tallying 유지, 평가 입력 후 재검수).
- `not_applicable`(그 유저 팀에 필수 슬롯 미개설) = 성장 도전 대상 아님 → uws 미생성(카드에서 자연 제외) 또는 fail. **비개발자 확인 필요.**

---

## 4. status 매핑

대상 주차의 각 cohort user 에 대해:

| 조건 | uws.status | 비고 |
|---|---|---|
| 공식 휴식 주차(`weeks.is_official_rest` 또는 rule/period) | **uws 미생성** | resolver 가 `official_rest` 우선 판정(uws 무관). 건드리지 않음 |
| 그 유저 개인 휴식(rest period/`uss.status='rest'`) | `personal_rest` | |
| 신정책 verdict = pass | `success` | §3.3 |
| 신정책 verdict = fail | `fail` | §3.3 |
| verdict = pending/not_applicable | **uws 미생성**(tallying 유지) | §3.3 열린 이슈 |
| **현재 주차**(start == 현재 주차 시작) | **uws 미생성** | "running = DB 미반영" 설계(`cluster4WeeklyGrowthData.ts:1745`) |
| **미래 주차**(start > 현재 주차) | **uws 미생성** | 결과 없음 |
| 비참여자(코호트 밖) | **uws 미생성** | |

`official_rest` 는 **uws 에 쓰지 않는다** — resolver 가 seasonCalendar/period 로 우선 판정하므로 uws 로 중복 기록하면 SoT 이중화. (기존 카드 동작과 동일.)

uws row shape(스크립트 INSERT 미러):
```
{ user_id, year: iso_year, week_number: iso_week, week_start_date: start_date,
  season_key, status, is_official_rest_override: false }
```

---

## 5. 레거시 주차 보호 (2026-summer 이전 절대 불변)

- **게이트**: `week.start_date < CLUSTER4_SLOT_POLICY_EFFECTIVE_FROM`(2026 여름 W1) 이면 **§1의 [1]~[3](코호트·verdict·uws upsert) 전체 SKIP**. 검수 완료는 기존대로 publish+review 만 수행(현행 동작 100% 보존).
- 근거: 레거시 uws 는 마이그레이션으로 정렬된 SoT 이며, 기존 sync 도 `r.week_start_date < effectiveFromDate` 를 **update 금지**로 보호한다(`cluster4WeeklyGrowthData.ts:1774`). 본 설계도 동일 경계 재사용.
- 추가 물리 가드: uws upsert 시 `.neq` 또는 사전 조회로 레거시 주차 row 를 대상에서 배제(이중 안전).

---

## 6. 멱등성

검수 완료를 여러 번 눌러도 결과 동일해야 한다.

- **verdict 재계산은 순수**: 같은 입력(라인/평가/포인트 불변)이면 같은 verdict → 같은 uws.status.
- **upsert 는 `onConflict: (user_id, year, week_number)`**(uws 유니크 키) → 2번째 클릭은 동일 값으로 덮어써 no-op 효과.
- **status 회귀 방지 가드**: 이미 확정된 uws 를 부적절히 뒤집지 않도록 —
  - `success ↔ fail` 재판정은 verdict 가 실제로 바뀐 경우만(입력 변경 시). 동일 verdict 재클릭 = 동일 값.
  - `personal_rest`/`official_rest` 는 verdict 로 덮지 않음(휴식 우선).
- **공표/검수 멱등**: 기존 `.is("result_published_at", null)` / `.is("result_reviewed_at", null)` 가드 유지(이미 공표/검수면 스킵). 2번째 클릭은 uws 재확인(동일값 upsert) + 스냅샷 재계산만.
- **run-log 기반 provenance**: 각 실행이 "생성한 uws id" vs "갱신한 uws(이전 status)" 를 기록 → 재실행 시 중복 생성 없음(upsert), 롤백 시 정확 복원.

---

## 7. snapshot 재계산 순서

**반드시 uws upsert(§1 [3]) 완료 후 → 공표(4) → snapshot 재계산(5)** 순서.

- 이유: `recomputeWeeklyCardsSnapshotsForUsers` → `getCluster4WeeklyCardsForProfileUser` → `resolveWeekResultStatus` 가 **그 시점 uws.status 를 읽는다**. uws 를 먼저 확정해야 스냅샷에 최종 success/fail 이 굳는다. 순서가 뒤바뀌면 (구)no-uws 상태로 스냅샷이 굳어 카드가 사라진다(현재 버그).
- 코호트 = §2 로스터 코호트(uws 를 쓴 대상과 동일 집합) → 스냅샷도 그 유저만 재계산(전원 일괄 금지, 504 방지 원칙 유지).
- best-effort 격리(기존과 동일): 사용자별 실패는 로그+계속, 공표/uws 는 롤백 안 함.

---

## 8. 롤백 / 실행 취소 시 되돌릴 데이터

`revertTeamPartsWeekReview`(DELETE) 를 확장. 현재는 `result_published_at=NULL + result_reviewed_at=NULL + 스냅샷 재계산` 만 한다(`adminWeeklyCardFinalizationData.ts:573`). uws 생성이 추가되므로 **uws 도 되돌려야** 한다:

- **finalize 가 생성한 uws** → **삭제**(run-log 의 "생성 id" 목록 기준. 이관/기존 uws 는 절대 삭제 금지).
- **finalize 가 갱신한 uws**(예: tallying→success 로 status 바꾼 기존 row) → run-log 의 "이전 status" 로 복원.
- 그 다음: `result_published_at=NULL`, `result_reviewed_at=NULL`, 코호트 스냅샷 재계산, `recalcUserGrowthStats` 재집계 → 카드가 tallying(집계 중)/skeleton 으로 복귀.
- **레거시 주차·이관 uws 무접촉** 불변식 유지.
- 멱등: 이미 미공표/생성분 삭제 완료면 no-op.

→ 롤백 정확성을 위해 **finalize 는 반드시 uws provenance(created ids + updated {id, prevStatus}) 를 run-log(예: `cluster4_week_finalize_runs` 또는 반환 DTO)에 남긴다.**

---

## 9. HTTP API 기준 검증 계획

전부 direct==HTTP 원칙, 운영 DB 무손상(테스트 유저/QA 코호트로만 write-path 검증).

### 9.1 `POST /admin/team-parts/info/weeks/[weekId]/review`
- 대상 = 2026-summer W1(`496656d0-…`), club=encre, mode=test(QA 코호트).
- 실행 전/후 `user_week_statuses` diff: 코호트 test 유저에 대해 (없던 행 생성 / status 값) 검증.
- 멱등: 2회 호출 → 2회차 uws diff=0, 값 동일.
- 레거시 무접촉: 실행 전후 레거시 주차 uws 스냅샷 byte-identical.
- 검증 스크립트(신규): `scripts/verify-uws-operating-creation{,-http}.ts` (기존 `verify-team-parts-info-week-review.ts` 패턴 확장).

### 9.2 고객 앱 `GET /api/cluster4/weekly-cards`
- 대상 test 유저(demoUserId)로 조회 → **여름 W1 카드가 공표 후에도 존재**하고 status=success/fail(확정)로 표시되는지.
- 회귀: 공표 전(tallying) → 공표 후(success/fail) 전이만, 카드 개수 감소 0.
- 일반/데모 경로 동일 DTO 확인(mode 무관 snapshot key).

### 9.3 weekly ranking (`/api/weekly-league`, front)
- ⚠ 현재 spring 전용이므로 2026-summer 랭킹 활성화 여부는 별개 이슈. 최소한 uws 생성이 **기존 spring 랭킹 수치에 회귀 0** 임을 확인(여름 write 가 spring 코호트 무접촉).

### 9.4 `user_growth_stats`
- 공표 후 코호트 test 유저의 `approved_weeks` 가 uws success 수와 일치(`recalcUserGrowthStats` 반영).
- 롤백 후 원복(생성 uws 삭제 → approved_weeks 원상).

### 9.5 브라우저 E2E
- `/admin/team-parts/info/weeks/[weekId]?club=encre&mode=test` 검수 완료 클릭 → 고객 cluster-4(테스트 유저)에서 여름 W1 카드 유지 확인 → ↩ 실행 취소 → tallying 복귀.

---

## 결론 — "검수 완료 버튼이 확정 저장하는 데이터" (비개발자용)

> **검수 완료 버튼은 "이번 주차, 우리 클럽 회원들이 각자 성공/실패했는지를 최종 계산해서 회원별 주차 성적표(`user_week_statuses`)로 도장 찍어 저장하는" 버튼입니다.**
>
> 지금까지는 이 도장 데이터가 과거 데이터를 옮겨올 때(이관)만 만들어졌고, 새 시즌(2026 여름)부터는 아무도 안 만들어줘서, 검수 완료를 누르면 오히려 "성적표가 없는데 결과는 공개됨" 상태가 되어 카드가 사라졌습니다.
>
> 새 설계에서 검수 완료 버튼은 누르는 순간:
> 1. **누가 이번 주차 대상인지**(그 시즌·그 클럽 참여 회원) 명단을 뽑고,
> 2. **각자 성공/실패를 계산**(실무 경험 평가 + 프로세스 체크 통과 여부 등, 기존 계산 그대로)해서,
> 3. **회원별 주차 성적표(uws)를 만들어 저장**하고,
> 4. 그 성적표를 바탕으로 **결과를 공개(공표)** 하고 **고객 카드를 갱신**합니다.
>
> 즉 검수 완료는 "검수했다는 표시만" 남기는 버튼이 아니라, **그 주차의 회원별 최종 성적(성공·실패·휴식)을 확정 저장하는 버튼**이 됩니다. 잘못 눌러도 **실행 취소**로 그 성적표를 만들기 이전으로 되돌릴 수 있습니다. 과거(2026 여름 이전) 시즌 성적은 절대 건드리지 않습니다.

---

## 안전장치 — 적립 미완료 시 검수 완료 차단

`markTeamPartsWeekReviewed` [0] 게이트 직후, uws 생성 전에 `assertWeekAccrualComplete(week)` 를 실행한다:

1. **미완료 체크 존재** → `process_check_statuses` WHERE `week_id` AND `status='pending'` COUNT > 0 → **422 차단**.
   (`ProcessCheckStatus = needed|pending|completed`. `pending` = 예정됐으나 미완료 = 적립 안 됨.)
2. **미완료 변동** → `process_irregular_acts` WHERE `week_id` AND `kind='review_request'` AND `status='pending'` COUNT > 0 → **422 차단**.
3. **적립 기록 0** (보조) → `process_point_awards` WHERE (iso_year, iso_week) COUNT = 0 이고 그 주차에 활성 check-target 액트가 있으면 → **422 차단**(적립 미실행 의심).

차단 메시지(관리자용, 이해 쉬움):
> **"프로세스 체크 적립이 완료된 뒤 검수 완료를 진행해주세요."** (미완료 체크 N건 / 적립 기록 M건)

이 게이트는 레거시 주차·현재/미래 주차에는 미적용(uws 생성 자체를 안 하므로). 신정책(2026-summer+) 과거 주차 검수 완료에만 적용.

---

## ⚠ 실측 결과 (2026-07-08, read-only 프리뷰) — mass-fail 리스크 발견

`scripts/verify-uws-operating-finalization.ts`(쓰기 0)로 대상 주차(`496656d0`, 2026-summer W1)를 실측:

- 이미 **공표+검수 완료**(2026-07-07)됨 → 그래서 카드가 사라진 상태.
- 코호트 **85명**(encre 29·oranke 28·phalanx 28), **전원 uws 없음**(= 전원 드롭). 단일 유저 문제가 아니라 **전 org 전원**.
- 적립 게이트 **통과**(awardCount=17, pending 0).
- **그러나 verdict = 샘플 20명 전원 `fail`.** 원인: 이 주차에 **실무 경험 라인 0개·타깃 0개**(오픈 config 체크만 있고 `cluster4_lines` 미생성). 신정책 "필수 슬롯 항상-개설"이 빈 슬롯을 `required_fail` 로 계산 → 전원 실패.

→ **이 상태로 finalize 하면 실사용자 85명이 전원 '성장 실패' 확정되는 사고**가 난다. 적립(포인트) 게이트로는 못 막는다(포인트는 있으나 라인이 없음).

**추가 안전장치(구현됨)**: finalize 는 "그 주차 experience 라인 0개 AND (휴식 제외) 전원 fail" 이면 **차단**한다 —
> "이 주차에 실무 경험 라인이 개설되지 않아 대상자 전원이 '성장 실패'로 확정될 수 있습니다. 라인 개설·결과 입력을 완료한 뒤 검수 완료를 진행해주세요."

**미해결(사용자 판단 필요)**: 2026-summer W1 이 (a) 원래 실무 경험 라인이 있어야 하는데 미생성된 것인지(→ 라인 개설·평가 입력 후 finalize 가 정답), (b) 실무 경험 챌린지가 없는 주차인지(→ not_applicable 처리 + 카드 유지용 별도 정책 필요). 이 결정 전에는 **write finalize 를 실행하지 않는다.**

## 확정된 정책 (2026-07-08)

1. **§2.4 org 스코프 = 옵션 A**: 전역 공표 시 **전체 org·전체 시즌 참여자** 대상 uws 생성(club 파라미터는 UI 스코프일 뿐). oranke/phalanx 도 동시에 uws 가 채워져 no_data 드롭 원천 차단.
2. **§3.3 verdict 매핑**:
   - `pass` → `success`, `fail` → `fail`.
   - **`pending` → 검수 완료 전체 차단**(평가 미입력 주차는 확정 불가). 422 + 미평가 대상 안내.
   - **`not_applicable` → uws 미생성**(임의 fail 금지). ⚠ 잔여 이슈: 이 참여자 카드는 공표 후에도 드롭될 수 있어, 이 부분집합에 한해 최소 resolver keep(skeleton 유지)이 별도로 필요할 수 있음 — 실측 후 결정.
3. **run-log = 신규 테이블 `cluster4_week_finalize_runs`**: uws 생성 id / 갱신 {id, prevStatus} provenance 저장(실행 취소 정확 복원). 마이그레이션 필요(SQL Editor 수동 적용).
4. **레거시(2026-summer 이전) 절대 불변**: §5 게이트로 uws 생성 단계 전체 스킵.
5. verdict 계산은 **검수 완료 인라인**(1단계) — 별도 마감 배치는 후속 옵션.

## 잔여 확인 (구현 후)

- **§3.3 not_applicable 참여자**의 실제 존재 여부 — 대상 주차/유저 DB 실측으로 확인. 존재하면 최소 resolver keep 추가 여부 결정.
- verdict per-user N쿼리 비용 — 코호트 규모 크면 concurrency 제한(4~8) + 후속 배치 분리 검토.
