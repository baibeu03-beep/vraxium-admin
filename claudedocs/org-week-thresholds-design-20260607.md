# org_week_thresholds 설계 — 조직별 check_threshold SoT (2026-06-07)

> 상태: **설계 + DDL preview only — DB write 0 · 코드 수정 0**
> 전제 정책 (사용자 확정):
> 1. threshold 적용 조직 = **source_system → organization_slug 매핑** (`lib/pmsMigration.ts` 단일 SoT: oranke→oranke · hrdb→encre · olympus→phalanx)
> 2. `usersinfo.Team` 은 team_name 전용 — org 판정 사용 금지 (타입으로 차단됨: `mapUsersinfoTeamPart`)
> 3. 과거 주차 조직 이력 추적 없음 — 이관 source_system 기준 `user_profiles.organization_slug` 가 SoT
>
> 불변 제약 (기존 정책 유지):
> - snapshot-only 구조 유지 (조회 API 는 계산하지 않음)
> - 판정 전환(enforce) SoT = `user_weekly_points.checks_migrated` 행 단위 플래그만 — check 값 분포 추론 금지
> - uws 불변 (read-time 판정, 레거시 주차 소급 강등 금지)

---

## 0. 현황 요약 (2026-06-07 조사 결과)

- `weeks.check_threshold` 는 **B7 apply(06-06)로 ORANKE `weekssettings.confirmStar` 가 백필된 상태**
  (`scripts/apply-b7-weeks-backfill.ts` — weeks 103 insert / 25 update, 2025-summer 합성주차 thr=0).
  즉 현재 이 컬럼은 "공통 기준값"이 아니라 **사실상 ORANKE 달력값**이다.
- 판정용 read 지점은 단 한 곳: `lib/lineAvailability.ts` `fetchLegacyUnifiedExperienceByWeek`
  (weeks.check_threshold 직독 → `LegacyUnifiedWeekState.checkThreshold` → `reduceLegacyUnifiedVerdict` 게이트).
- hrdb/olympus 는 같은 StartDate 그리드의 주차에서 **oranke 와 다른 confirmStar** 를 가짐
  (`scripts/diag-multisource-calendar-person.mjs` 실증: 겹치는 주차에서 oranke≠hrdb threshold 차이 존재).
  → 단일 컬럼으로는 3개 소스의 confirmStar 동시 표현 불가.
- org 출처: `user_profiles.organization_slug` (adminCrewData.ts:455). 주차별 org 이력 없음 — 정책 3에 따라 현재값 SoT.

---

## 1. DDL preview (수동 적용 — Supabase SQL Editor, idempotent)

```sql
-- db/migrations/2026-06-07_org_week_thresholds.sql  (preview — 아직 미적용)
--
-- 조직별 "주차 인정 point.check 기준값" SoT.
-- 해석 순서(코드 계약): org_week_thresholds(week_id, org) → weeks.check_threshold → 30.
-- weeks.check_threshold 는 공통 폴백으로 존치 (B7 백필값 = ORANKE 달력 — §2 공존 방식 참조).
-- organization_slug 는 source_system 매핑(lib/pmsMigration.ts)으로만 결정 — Team 파생 금지.

CREATE TABLE IF NOT EXISTS public.org_week_thresholds (
  week_id           uuid NOT NULL REFERENCES public.weeks(id) ON DELETE CASCADE,
  organization_slug text NOT NULL
    CHECK (organization_slug IN ('encre', 'oranke', 'phalanx')),  -- lib/organizations.ts ORGANIZATIONS 와 동기 유지
  check_threshold   integer NOT NULL CHECK (check_threshold >= 0),

  -- ── 이관 provenance (legacy_point_ledger 와 동일 계약) ──
  source_system     text NULL,     -- 'oranke' | 'hrdb' | 'olympus' | NULL(관리자 수동)
  source_table      text NULL,     -- 예: 'hrdb.weekssettings' (소스 프리픽스 네임스페이스, ledgerSourceTable 규약)
  source_pk         text NULL,     -- 소스 행 PK (weekssettings 식별자)
  inferred          boolean NOT NULL DEFAULT false,  -- false=원본 직접값 / true=보간·유추 (백필 리포트 표식)
  payload           jsonb NULL,    -- 원본 행 스냅 (confirmStar·StartDate·공표상태 등 감사용)

  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (week_id, organization_slug)
);

-- 이관 멱등 키: 소스 행 1개 = org 행 1개 (수동 행은 source_pk NULL — 제외)
CREATE UNIQUE INDEX IF NOT EXISTS uq_owt_source
  ON public.org_week_thresholds (source_table, source_pk)
  WHERE source_pk IS NOT NULL;

COMMENT ON TABLE public.org_week_thresholds IS
  '조직별 주차 인정 point.check 기준값. 해석: org행 → weeks.check_threshold → 30. organization_slug 는 source_system 매핑 SoT(pmsMigration.ts).';
```

설계 노트:
- **PK = (week_id, organization_slug)** — 자연키 그대로. 주차×조직당 1행 강제, upsert `onConflict` 키로 직사용.
- **check_threshold NOT NULL** — "org 행이 있는데 값이 NULL" 상태를 금지. "조직 오버라이드 해제" = 행 삭제(폴백 복귀)로 표현 — weeks.check_threshold 의 `null=기본값` 의미론과 혼선 방지.
- `updated_at` 은 앱 writer 가 명시 갱신 (트리거 미사용 — 프로젝트 관례).
- RLS: 기존 weeks 와 동일하게 service-role 전용 (admin supabaseAdmin 경로만 접근) — 별도 정책 불요.

---

## 2. weeks.check_threshold 공존 방식

| 레이어 | 역할 | 변경 |
|---|---|---|
| `org_week_thresholds(week_id, org)` | **1순위** — 조직별 값 | 신규 |
| `weeks.check_threshold` | **2순위 공통 폴백** — org 행 부재 시 | 존치 (스키마·writer 무변경) |
| `DEFAULT_WEEK_CHECK_THRESHOLD = 30` | 3순위 코드 기본값 | 존치 |

- **weeks.check_threshold 는 삭제·이동하지 않는다.** B7 백필값(ORANKE 달력)이 그대로 남고,
  org 행이 없는 사용자(organization_slug NULL = "공통", 또는 org 행 미백필 주차)는 현행과 100% 동일하게 동작.
- **오염 해소 절차**: oranke org 행을 **라이브 weeks.check_threshold 에서 복사 seed** (§10 Step 1).
  값이 by construction 동일하므로 oranke 판정 불변. 이후 weeks.check_threshold 는
  "ORANKE 달력값이지만 공통 폴백 역할"로 유지 — encre/phalanx 사용자가 생기기 **전에**
  hrdb/olympus org 행을 백필하면 잘못된 폴백을 실제로 타는 사용자는 0명이다 (§9·§10 순서 보장).
- 컬럼 미적용 DB 방어 패턴(기존 fallback select)과 동일하게, **테이블 미생성 DB 방어**:
  org_week_thresholds 조회 실패 시 warn + 폴백 체인 계속 (fail-open to 현행 동작).

---

## 3. fetchLegacyUnifiedExperienceByWeek 수정 계획 (lib/lineAvailability.ts)

판정 read 지점이 한 곳이므로 여기만 바꾸면 판정 전체가 바뀐다.

```
시그니처 (additive — 기존 호출부 무수정 동작):
  fetchLegacyUnifiedExperienceByWeek(
    userId, weekIds, now,
    opts?: { organizationSlug?: OrganizationSlug | null }   // ← 신규
  )
```

1. **org 결정**: `opts.organizationSlug` 가 주어지면 그대로 사용 (weekly-growth 파이프라인은
   crewMeta.organizationSlug 를 이미 보유 — 추가 쿼리 0).
   미제공 시 내부에서 `user_profiles.organization_slug` 1회 조회 (maybeSingle).
   `null`/비정상 slug → org 조회 생략 = 현행 동작 (공통 폴백).
2. **org 행 조회**: 기존 weeks meta 조회(`:1175~`) 직후,
   `org_week_thresholds.select("week_id,check_threshold").eq("organization_slug", org).in("week_id", ids)` 1쿼리.
   결과 ≤ 주차 수(현행 weekIds 패턴상 수십 행) — PostgREST 1000행 cap 비해당.
   실패(테이블 부재 포함) 시 warn + 무시 (fail-open).
3. **해석**: `s.checkThreshold = orgRow?.check_threshold ?? (w.check_threshold ?? DEFAULT)`.
   `checkCount`/`checkDataMigrated`(enforce SoT) 로직은 **무변경** — checks_migrated 플래그 의미론 그대로.
4. `reduceLegacyUnifiedVerdict` — **무수정** (state 주입값만 소비하는 순수 함수).

호출부 전파 (3곳, 모두 additive):
- `lib/cluster4WeeklyGrowthData.ts:577` — `{ organizationSlug: crewMeta.organizationSlug }` 전달.
- `lib/lineAvailability.ts:1378` (`fetchExperienceRequiredSlotStatusByWeek` 내부) —
  동 함수 opts 에 organizationSlug passthrough 추가.
- `cluster4WeeklyGrowthData.ts:1640` (`syncExperienceGrowthWeekStatuses`) — org 전달.
  단 이 writer 는 **레거시 주차 update 금지**(소급 강등 금지)라 threshold 적용 주차에 write 하지 않음 —
  전달은 정합성용이며 행동 변화 없음. growth_stats(uws raw 직독)도 무변경.

---

## 4. updateWeekCheckThreshold / PATCH route 수정 계획

- **기존 계약 보존**: `PATCH /api/admin/weeks/[week_id]/check-threshold` body `{check_threshold}` =
  공통(weeks 컬럼) 수정 — 현행 그대로.
- **additive 확장**: body `{ check_threshold: number|null, organization_slug?: OrganizationSlug }`.
  - `organization_slug` 있음 + number → org 행 upsert (`onConflict: week_id,organization_slug`,
    `source_system=null, inferred=false, payload={by:'admin-ui'}`, updated_at 갱신).
  - `organization_slug` 있음 + null → **org 행 delete** (오버라이드 해제 = 폴백 복귀).
  - 없음 → 기존 weeks.check_threshold 경로.
- **snapshot 재계산**: 기존 패턴 그대로 재사용 (그 주차 uws 보유자 전원, concurrency 3, best-effort).
  org 변경 시 해당 org 사용자만 재계산하는 최적화는 선택 사항 — superset 재계산도 정합성은 동일.
- 응답 DTO additive 확장: `org_thresholds: Array<{organization_slug, check_threshold}>` +
  조직별 `effective_check_threshold` (§8).
- 검증 규칙은 기존과 동일 (0~10000 정수). `isOrganizationSlug` 로 slug fail-closed.

---

## 5. WeekRecognitionsView 관리 UI 영향

- 현행: "check 기준 관리" 탭(`WeekRecognitionsView.tsx:763~`) — 주차 행당 입력 1개 + "기본값" 배지.
- 변경: 주차 행을 **공통(weeks) + 조직 3열(encre/oranke/phalanx)** 매트릭스로 확장.
  - 각 셀: 값 입력 + 유효값 표시. 배지 3단: `조직값` / `공통값 적용`(org 행 부재 → weeks 값) / `기본값(30)`.
  - org 셀 비우고 저장 = org 행 삭제 (폴백 복귀) — §4 의 delete 의미론과 1:1.
  - provenance 표시(선택): source_system 비-null 행은 "이관값" 잠금 배지 + 수정 시 경고
    (이관 원본을 수동으로 덮으면 payload 에 이력 보존 — 재이관 시 충돌 리포트 근거).
- 데이터 공급: `adminWeekRecognitionsData.fetchWeekRows` 에 org 행 일괄 조회 1쿼리 추가,
  `WeekOption` DTO 에 `org_thresholds` additive 필드. 기존 필드 의미 불변.

---

## 6. snapshot 생성/조회 영향

- **구조 무변경**: snapshot 은 per-user 캐시(`recomputeAndStoreWeeklyCardsSnapshot` →
  `getCluster4WeeklyCardsForProfileUser`)이고 `checkGate.required` 는 **이미 해석된 숫자**로 저장됨 —
  같은 주차에 사용자별로 다른 required 가 들어가도 스키마·DTO 구조 변화 없음.
- **dto_version bump 불요**: 구조 동일. oranke seed 는 값도 동일(§10 Step 1)이라 강제 전체 재계산 불요.
- **무효화 경로**: org threshold 변경(PATCH/백필) → 그 주차 참여자 snapshot 재계산 — §4 기존 패턴.
  hrdb/olympus 백필 시점에는 해당 org 의 enforced 사용자(uws+checks_migrated 행)가 아직 0명이므로
  재계산 대상 0 (이관 파이프라인이 사용자 기록 후 snapshot 생성 — 기존 이관 계약 그대로).
- **조회 API 불변**: snapshot-only 원칙 유지 — 조회 경로는 여전히 계산하지 않음. 실시간 경로
  (weekly-growth)와 snapshot 경로(weekly-cards)가 같은 `fetchLegacyUnifiedExperienceByWeek` 를
  타므로 divergence 없음 (재계산 전 snapshot 이 옛 값을 보일 수 있는 것은 기존 stale 정책과 동일).

---

## 7. demoUserId / 일반 사용자 경로 동일성 검증 계획

- 코드 사실: demoUserId 는 **인증 우회 + 조회 대상 override 뿐** — weekly-cards(:251)·weekly-growth(:39)
  모두 resolve 된 대상 userId 로 동일 파이프라인 호출. org resolution 이
  `fetchLegacyUnifiedExperienceByWeek` 내부(또는 crewMeta 전달)에 있으므로 두 경로는 구조적으로 동일.
- 검증 (적용 후, read-only):
  1. 같은 테스트 유저 U(oranke)에 대해 (a) 세션 인증 GET (b) `?demoUserId=U` GET —
     `checkGate` 전 주차 deep-equal diff = 0.
  2. foreign viewer 케이스: demoUserId=T1 이 userId=T2 페이지 조회 — checkGate 가
     **T2(페이지 주인) org 기준**인지 확인 (viewer org 혼입 금지 — 기존 4허브 카드 규약과 동일).
  3. ENABLE_DEMO_MODE 게이트(Vercel env)는 무관 — 로컬 검증.

---

## 8. DTO/API 계약 변경 여부

| 계약 | 변경 | 비고 |
|---|---|---|
| `checkGate{required,earned,passed,enforced}` (shared/cluster4.contracts.ts) | **무변경** | required 에 org 값이 흘러갈 뿐 — 구조 동일 |
| front repo (../vraxium) | **무변경** | snapshot DTO 숫자 표시만 |
| `WEEKLY_CARDS_DTO_VERSION` | **bump 불요** | 구조 동일 + oranke 값 동일 seed |
| admin `WeekRecognitionFilterOptions.weeks[]` | additive (`org_thresholds`) | 기존 필드 의미 불변 |
| PATCH check-threshold body/response | additive (`organization_slug` 옵션) | 기존 호출 호환 |
| `LegacyUnifiedWeekState` / 함수 시그니처 | additive opts | 기존 호출부 무수정 동작 |

---

## 9. ORANKE 단독 이관 영향 분석

- **org_week_thresholds 없이도 ORANKE 단독 이관은 이미 가능하다** — B7 apply 가
  oranke confirmStar 를 weeks.check_threshold 에 백필 완료(06-06), B8 재감사·§12 dry-run(1092)이
  현행 판정과 일치함을 검증. 즉 "A. ORANKE 먼저"는 현 구조로 충족된 상태.
- 단 그 순간 weeks.check_threshold 의 의미가 "공통"→"oranke 달력"으로 굳어진다.
  hrdb/olympus 사용자가 이관되는 즉시 이들이 **oranke 기준값으로 판정**되는 잠재 오류가 생기므로,
  hrdb/olympus 의 **사용자(uws·checks_migrated) 이관 전에** §10 백필 + §3 코드가 반드시 선행돼야 한다.
- 역방향 안전성: org_week_thresholds 적용(코드+oranke seed)은 ORANKE 기존 데이터를 건드리지 않음 —
  oranke org 행 = 라이브 weeks 값 복사라 판정 결과 불변 (§11 dry-run 으로 flip 0 확인).

## 10. HRDB/OLYMPUS threshold 백필 계획 (preview — write 금지 상태)

> 선행 조건: DDL 적용(§1) → 코드 resolution 배포(§3) → Step 1 → Step 2. 사용자 이관은 그 뒤.

**Step 1 — oranke seed (무변화 보증층)**
- 라이브 `weeks` 에서 `check_threshold IS NOT NULL` 행 전수 →
  `org_week_thresholds(week_id,'oranke', 같은 값)` upsert.
- provenance: `source_system='oranke', source_table='public.weeks', source_pk=week_id,
  inferred=false, payload={copied_from:'weeks.check_threshold', b7_origin:'oranke.weekssettings.confirmStar'}`.
- 라이브 값 복사(원본 MySQL 재추출 아님)로 **값 동일성을 구성적으로 보장** — B8 수동 보정분 포함.
- NULL 주차는 seed 하지 않음 (기본값 30 의미론 보존).

**Step 2 — hrdb / olympus 백필**
- 소스별 `({src}).weekssettings` 추출: StartDate·confirmStar·공표 상태 (`tsx --env-file` MYSQL 접속 —
  비밀번호 특수문자 단정 주의, 기존 dryrun-pms-1092 패턴).
- 매칭: `DATE(StartDate)` = `weeks.start_date` (B7 과 동일 그리드 — diag 실증상 oranke∩hrdb 시작일 겹침 확인).
- upsert: `(week_id, 'encre'|'phalanx', confirmStar)` — org 는 **`resolveOrganizationSlug(source)` 만** 사용
  (fail-closed: 미등록 소스 throw). `source_table=ledgerSourceTable(src,'weekssettings')`, `source_pk=소스 PK`,
  `payload=원본 행`, `inferred=false`.
- 예외 처리:
  - **weeks 행 부재** 소스 주차 → skip + 리포트 (필요 시 B7류 weeks 백필 별도 계획 — 본 작업 범위 밖).
  - confirmStar NULL/음수/비정상 → skip + 리포트 (org 행 미생성 = 공통 폴백 — fail-safe).
  - 동일 (week,org) 재실행 → upsert 멱등 (PK + uq_owt_source).
  - 기존 캘린더 충돌 10건(2023-autumn 오기·2024-autumn legacy·2025 설)은 conflict 리포트로 표면화만 — 자동 보정 금지.
- **하지 않는 것**: uws write 0 · user_weekly_points write 0 · checks_migrated 변경 0 ·
  snapshot 재계산 0 (해당 org enforced 사용자 0명) · weeks.check_threshold 변경 0.

## 11. dry-run 계획

**산출물**: `claudedocs/org-week-thresholds-dryrun-<date>.{json,md}` + fingerprint before/after (B7 패턴).

**Phase 0 — 사전 감사 (read-only, DDL 적용 전 가능)**
1. 라이브 weeks.check_threshold 전수 덤프 (fingerprint-before).
2. MySQL 3소스 weekssettings 추출 → StartDate 그리드 매칭률·결번·confirmStar 분포 리포트.
3. oranke: 라이브 값 vs 소스 confirmStar diff (B8 수동 보정분 식별 — seed 는 라이브 우선 원칙 확인).
4. hrdb/olympus: oranke 와 다른 값을 갖는 주차 수 — "org 분리가 실제로 필요한 주차" 정량화.

**Phase 1 — 판정 시뮬레이션 (코드 수정 전, 스크립트 내 resolution 재현)**
1. enforced 모집단 = `user_weekly_points.checks_migrated=true` 행 보유 (사용자×주차) 전수 —
   **플래그 직독만, check 값 분포 추론 0**.
2. 각 (user,week): 구 threshold(weeks ?? 30) vs 신 threshold(org행 ?? weeks ?? 30) → verdict 재계산 diff.
3. 합격 기준: **oranke flip 0건** (Step 1 이 값 복사이므로 0이어야 정상 — 1건이라도 있으면 중단·원인 규명).
   hrdb/olympus 는 enforced 사용자 0명이므로 diff 대상 자체가 0 임을 확인.

**Phase 2 — 적용 후 4중 검증 (direct / HTTP / snapshot / browser)**
1. **direct**: tsx 스크립트로 `fetchLegacyUnifiedExperienceByWeek` 직접 호출 —
   org 별 가상 사용자(oranke 실유저 + org 행 유/무 주차)에서 checkThreshold 해석 순서 단정.
2. **HTTP**: `/api/cluster4/weekly-growth`·`/api/cluster4/weekly-cards` before/after checkGate diff
   (기존 `verify-week-check-policy.ts`·`audit-sot-direct-vs-http.ts` 패턴 재사용). direct vs HTTP 일치 단정.
3. **snapshot**: `cluster4_weekly_cards_snapshots.cards[].experienceGrowth.checkGate` before/after diff = 0 (oranke).
4. **browser**: Playwright (`verify-week-check-browser.mts` 패턴, page.evaluate 문자열 + MSYS_NO_PATHCONV) —
   admin week-recognitions "check 기준 관리" 매트릭스 표시 + front 카드 상세 checkGate 표기.
5. **demo 동일성**: §7 의 (a)/(b)/foreign-viewer 3케이스.

---

## 최종 결론

**A. ORANKE만 먼저 이관 가능한가 — 가능 (이미 충족).**
B7 이 oranke confirmStar 를 weeks.check_threshold 로 백필 완료했고 B8·dry-run 1092 로 판정 일치가
검증된 상태라, ORANKE 단독 이관에는 org_week_thresholds 가 필요 없다.

**B. 3개 조직 이관에는 org_week_thresholds 선적용이 필수인가 — 필수.**
hrdb/olympus 는 동일 주차에 oranke 와 다른 confirmStar 를 가지므로(실증) 단일 weeks 컬럼으로 표현 불가.
순서 고정: DDL → 코드 resolution → oranke seed(Step 1) → hrdb/olympus threshold 백필(Step 2) →
**그 다음에야** hrdb/olympus 사용자(uws·checks_migrated) 이관. 사용자 이관이 백필보다 먼저 오면
encre/phalanx 사용자가 oranke 폴백값으로 판정되는 결함이 즉시 발생한다.

**C. 기존 ORANKE 데이터가 깨지지 않는가 — 깨지지 않음 (구성적 보장 + dry-run 게이트).**
(1) oranke org 행 = 라이브 weeks 값 복사 → 값 동일, (2) org 행/테이블 부재 시 폴백 체인 = 현행 경로,
(3) enforce SoT(checks_migrated)·uws·growth_stats·snapshot 구조·DTO 계약 전부 무변경,
(4) Phase 1 dry-run "oranke flip 0건" 을 적용 게이트로 강제.
