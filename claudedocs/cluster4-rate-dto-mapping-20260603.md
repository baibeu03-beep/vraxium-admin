# Cluster4 4허브 rate DTO 매핑 — `Cluster4RateDto { rate, count, total }` 기준 (2026-06-03)

## 결론 (검증 완료)

요청 2건은 **현재 코드에서 이미 충족**되며 실제 HTTP·direct 응답으로 검증했다. 코드 변경 없음.

1. **not_applicable("해당 없음") 라인은 분자·분모 모두에서 이미 제외된다.**
2. **일반 모드와 `demoUserId` 테스트 모드는 동일 DTO를 사용한다** (동일 계산식·동일 shape·동일 fallback).

값은 이미 정확·통일되어 있고, **DTO별 필드명만 다르다.** 프론트(별도 repo)가 현재 필드명을 그대로 소비 중이므로
필드명은 변경하지 않는다. 본 문서는 `Cluster4RateDto { rate, count, total }` 개념 기준으로 4개 DTO의
필드명 매핑만 기록한다.

## 표준 개념: `Cluster4RateDto`

| 개념 필드 | 의미 |
|---|---|
| `rate`  | `round(count / total * 100)`, `total === 0` → `0` (`roundGrowthRate` / `pct`) |
| `count` | 분자 = 강화 성공(이행) 라인 수 (not_applicable 제외) |
| `total` | 분모 = 가용(=개설·배정, success+fail+pending) 라인 수 (not_applicable 제외) |

## DTO별 실제 필드명 매핑

| 화면/지표 | DTO (`shared/cluster4.contracts.ts`) | rate | count(분자) | total(분모) |
|---|---|---|---|---|
| 주차 성장률 (cluster4-card) | `Cluster4WeeklyCardDto` | `weeklyGrowthRate` | `growthNumerator` | `growthDenominator` |
| 라인별 (cluster4-card 라인 칸) | `Cluster4LineDetailDto` | `rate` | `numerator` | `denominator` |
| 시즌 성장률 (cluster4-1 area-6) | `Cluster4AreaSixCirclesDto` | `seasonGrowth` | `completedLines` | `availableLines` |
| 허브 강화율 (cluster4-1 area-7) | `Cluster4SeasonAreaProgressItem` | `rate` | `earned` | `total` |

> 의미는 모두 동일하다. `count/total` 은 위 표의 분자/분모 필드를 읽으면 된다.

## not_applicable 제외가 보장되는 지점 (SoT = `lib/cluster4WeeklyGrowthData.computeWeeklyCards`)

- **part 단위 분모**: info/experience/competency 의 `available(A)` = 그 주차 "개설된 distinct 라인 수"
  (`fetchWeeksWithOpenLinesByPart`). 미개설(=not_applicable)이면 `A=0`. career 의 `A` = 본인 배정 수
  (`careerLineMap`), 미선발(=not_applicable)이면 `0`. → not_applicable part 는 분모에 `0` 기여.
- **per-line DTO**: `lib/cluster4WeeklyCardsData.attachLineBreakdown` — `available <= 0` 이면
  `numerator=denominator=rate=null` 로 내려 분자·분모 양쪽에서 제외.
- **area-6 / area-7**: `lib/cluster4SeasonCircles.ts` — `den <= 0` 또는 `null` 라인을 `continue` 로 제외,
  카드당 part 1회만 합산(sub-line 중복 방지).
- 따라서 분모 = (success + fail + pending) 가용 라인, not_applicable 은 분자·분모 모두 제외.
  예) 가용 10 = success 4 + fail/pending 3 + not_applicable 3 → `count=4 / total=7 = 57%`.

## demo == normal 동일 DTO 경로

- **weekly-cards** (snapshot-only): `app/api/cluster4/weekly-cards/route.ts` — demo·일반 모두 동일
  `loadWeeklyCards(profileUserId)` → 동일 snapshot → 동일 `computeAreaSixCircles` /
  `computeSeasonAreaProgress`. demo 분기는 인증·조회대상(userId 우선) 해소만 다르고 계산식/shape 동일.
- **weekly-growth** (live): `app/api/cluster4/weekly-growth/route.ts` — demo→`getWeeklyGrowth(id)`,
  일반→`getWeeklyGrowthByUserId`→`resolveProfileUserId`→`getWeeklyGrowth(id)`. 동일 함수.

## 검증 결과 (2026-06-03, dev server `:3000` + `.env.local`)

`scripts/diag-cluster4-rate-not-applicable.ts [userId]` (4소스 비교: live / stored snapshot / HTTP demo
weekly-cards / HTTP demo weekly-growth), `scripts/diag-cluster4-rate-sweep.ts` (테스트 유저 90명 전수).

- not_applicable 누수(분자/분모 침투) 라인: **0** / 90명 (NA 라인은 한 유저만 153건 보유).
- 카드 `growthDenominator` ≠ Σ(non-NA part) 불일치: **0**.
- stored snapshot ≠ live recompute (stale): **0명** (dto_version=10 전원 fresh).
- HTTP demo weekly-cards == live recompute: **동일**. weekly-growth demo == direct: **동일 DTO**.
- 비제로 예시 — T강지아 area-7 실무 역량: `rate=33% / count=1 / total=3` (NA 제외, total 부풀지 않음).

## 결정 (사용자 확정)

- 필드명 **하드 리네임 안 함** (프론트 별도 repo 가 현 필드명 사용 중 — breaking 회피).
- `Cluster4RateDto` 타입 **신설 안 함**, `dto_version` **bump 안 함**, snapshot **재계산 안 함**.
- 본 매핑 문서로 갈음. 향후 `count/total` 이 필요하면 위 표의 분자/분모 필드를 직접 읽는다.
