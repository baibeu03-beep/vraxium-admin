# Cluster3 stats-cards — canonical API + 프론트 연동 가이드

**작성일**: 2026-05-29
**범위**: 사용자용 cluster3 stats-cards 3영역(Process / Period / Point)을 백엔드 API SoT 로 통일.
**이 레포(vraxium-admin) 작업**: 백엔드 API + DTO + 매퍼 + 검증 스크립트. (프론트 페이지/`/api/profile` 은 별도 프론트 레포 소관 — 본 레포 미수정)

---

## 1. 신규 파일 (수정 파일 없음)

| 파일 | 역할 |
|------|------|
| `app/api/cluster3/stats-cards/route.ts` | **신규 라우트** `GET /api/cluster3/stats-cards`. 세션 인증 + DTO 반환. |
| `lib/cluster3StatsCardsTypes.ts` | **DTO 계약** `Cluster3StatsCards` (browser-safe — 프론트 레포로 복사 가능). |
| `lib/cluster3StatsCardsData.ts` | **서버 매퍼** `getCluster3StatsCards(userId)` — `getGrowthIndicators()` 결과를 DTO 로 매핑(재계산 없음). |
| `scripts/verify-cluster3-stats-cards.ts` | DTO ↔ admin SoT 1:1 정합 검증. |

기존 코드는 **무수정**. 계산식은 기존 `lib/cluster3GrowthData.ts` 를 100% 재사용.

---

## 2. 라우트 계약

```
GET /api/cluster3/stats-cards
```

- **인증**: 세션 쿠키 (`getSupabaseServerClient().auth.getUser()`).
  `resolveProfileUserId(auth.id, auth.email)` 로 본인 `user_profiles.user_id` 해소 → 본인 데이터만 반환.
- **Query parameter**: 없음. (대상 사용자는 세션에서 도출 — admin 처럼 `[legacy_user_id]` 를 받지 않음)
- **성공 응답**: `{ success: true, data: Cluster3StatsCards }`
- **에러**: `401`(미인증) / `404`(프로필 없음) / `error.status`(GrowthError) / `500`. 모두 `{ success: false, error: string }`.

> `/api/cluster3/club-rank` 와 완전히 동일한 인증 모델. 프론트는 두 경로를 같은 방식으로 호출하면 된다.

---

## 3. DTO 구조 · 원천 테이블 · 계산식

`user_growth_stats` / `user_grade_stats` **캐시 테이블은 사용하지 않음**. 전부 실시간 계산값.

### process (성장 진행 상태)
| 필드 | 타입 | 원천 | 계산식 |
|------|------|------|--------|
| `growthStatus` | string | `user_profiles.growth_status` + `user_week_statuses`(현재 주차) | 10종 우선순위 표시 라벨 (`resolveDisplayKey` → `GROWTH_DISPLAY_LABELS`) |
| `growthStatusKey` | enum | 동일 | 머신 키(`active`/`official_rest`/`onboarding`/… i18n·스타일용) |
| `growthStatusRaw` | string\|null | `user_profiles.growth_status` | DB 원본값(가공 없음) |
| `growthStartDate` | string\|null | `user_profiles.activity_started_at` | ISO timestamp 원본 |
| `growthStartDateDisplay` | string | 동일 | `"YYYY-MM-DD"` 또는 `"—"` |
| `growthEndDate` | string\|null | `user_profiles.activity_ended_at` | ISO timestamp 원본 |
| `growthEndDateDisplay` | string | 동일 | `"YYYY-MM-DD"` 또는 `"Be Cluving"` |
| `isBeCluving` | boolean | `user_profiles.activity_ended_at` | `activity_ended_at === null` |

### period (성장 기간 집계)
| 필드 | 타입 | 원천 | 계산식 |
|------|------|------|--------|
| `successWeeks` | number | `user_week_statuses.status` | `COUNT(status='success')` |
| `successWeeksPending` | number\|null | **없음** | **원천 없음 — 정의 필요. 현재 항상 `null`** |
| `failWeeks` | number | `user_week_statuses.status` | `COUNT(status='fail')` |
| `personalRestWeeks` | number | `user_week_statuses.status` | `COUNT(status='personal_rest')` |
| `personalRestWeeksPending` | number\|null | **없음** | **원천 없음 — 정의 필요. 현재 항상 `null`** |
| `officialRestWeeks` | number | `user_week_statuses.status` | `COUNT(status='official_rest')` |
| `growableWeeks` | number | `user_week_statuses.status` | `success + fail + personal_rest` (공식 휴식 제외) |
| `physicalWeeks` | number | `user_week_statuses.status` | `success + fail + personal_rest + official_rest` (참고용 추가) |
| `personalRestSeasons` | number | `user_season_statuses.status` | `COUNT(status='rest')` |
| `successSeasons` | number | `user_season_statuses.status` | `COUNT(status≠'rest')` |

### points (성장 점수 기록)
| 필드 | 타입 | 원천 | 계산식 |
|------|------|------|--------|
| `totalStars` | number | `user_cumulative_points.total_stars` | 저장값 직접 사용 (j) |
| `totalShields` | number | `user_cumulative_points.total_raw_advantages`, `total_lightnings` | `total_raw_advantages - abs(total_lightnings)` (k = k0 − l, netAdvantages) |
| `totalLightning` | number | `user_cumulative_points.total_lightnings` | `abs(total_lightnings)` (l) |
| `starsLabel`/`shieldsLabel`/`lightningLabel` | string | `lib/pointLabels.ts`(조직별) | org 별 라벨(예: oranke=단감/인절미/어흥, encre=별/방패/번개) |

> `successWeeksPending` / `personalRestWeeksPending`: user_week_statuses 는 `success/fail/personal_rest/official_rest` 4종만 저장하며 "대기/미승인" 상태가 없다. **임의로 현재 주차나 override 카운트에 매핑하지 않음.** 정책 정의 후 별도 작업으로 연결.

---

## 4. admin 계산식 재사용

- `getCluster3StatsCards()` → `getGrowthIndicators()` (= 어드민 `GET /api/admin/crews/[legacy_user_id]/cluster3/growth` 가 쓰는 바로 그 함수) 를 호출.
- stats-cards 는 그 결과를 **이름만 바꿔 매핑**할 뿐 재계산이 없다.
- 따라서 어드민 화면과 사용자 화면은 **구조적으로 항상 동일한 값**을 본다.

---

## 5. 프론트 레포에서 해야 할 작업

### 5-A. 직접 Supabase 조회 제거 → API 호출로 교체

```ts
// BEFORE: supabase.from('user_week_statuses')... / from('user_cumulative_points')... 등 직접 조회 + 프론트 집계
// AFTER:
const res = await fetch('/api/cluster3/stats-cards', { credentials: 'include' });
const { success, data, error } = await res.json();
if (!success) { /* 401/404/500 처리 */ }
// data: Cluster3StatsCards — 표시만 (집계·계산 금지)
```

- **Query parameter**: 없음(본인 세션 기준).
- 제거 대상: `user_week_statuses`, `user_season_statuses`, `user_cumulative_points`, `user_growth_stats`, `user_grade_stats` 직접 조회 및 프론트단 COUNT/합산/`k0-l` 계산.
- `lib/cluster3StatsCardsTypes.ts` 를 프론트 레포로 복사하면 응답 타입을 그대로 사용 가능.

### 5-B. 기존 화면 필드 → 새 DTO 매핑표

| 화면 표기 | 새 DTO 필드 |
|-----------|-------------|
| 성장 상태 | `process.growthStatus` (라벨) / `process.growthStatusKey` (스타일) |
| 성장 시작일 | `process.growthStartDateDisplay` (또는 `growthStartDate`) |
| 성장 종료일 | `process.growthEndDateDisplay` (`isBeCluving=true` 면 "Be Cluving") |
| 성장 성공 주차 | `period.successWeeks` |
| 성장 실패 주차 | `period.failWeeks` |
| 개인 휴식 주차 | `period.personalRestWeeks` |
| 공식 휴식 주차 | `period.officialRestWeeks` |
| 성장 가능 주차 | `period.growableWeeks` |
| 개인 휴식 시즌 | `period.personalRestSeasons` |
| 성장 성공 시즌 | `period.successSeasons` |
| 별(총합) | `points.totalStars` (라벨 `points.starsLabel`) |
| 방패(총합) | `points.totalShields` (라벨 `points.shieldsLabel`) |
| 번개(총합) | `points.totalLightning` (라벨 `points.lightningLabel`) |
| 성장 성공(대기) / 개인 휴식(대기) | `period.*Pending` — **정책 정의 후 연결 필요** (현재 `null`) |

---

## 6. 검증 결과

`npx tsx --env-file=.env.local scripts/verify-cluster3-stats-cards.ts`

- 샘플 8명 전원 `getCluster3StatsCards()` ↔ `getGrowthIndicators()` **19개 필드 1:1 일치 (8 OK / 0 FAIL)**.
- `tsc --noEmit` 통과, `eslint` 통과.
