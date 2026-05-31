# 성장 상태 SoT & sync 운영 정책 (2026-05-31)

## SoT 확정
- **주차 성장 상태의 단일 SoT = `user_week_statuses.status`**
- 허용값: `success` / `fail` / `personal_rest` / `official_rest` (+ 런타임 전용 `running`/`tallying`은 DB 미저장)
- `user_profiles.growth_status`(active/graduated/suspended 등 활동 **생애주기**)는 **다른 도메인** — 주차 상태와 혼동 금지.

## 클러스터별 읽기 구조 (모두 `user_week_statuses.status` 기반)
| 클러스터 | 진입점 | read-time override |
|---|---|---|
| cluster4 | `getWeeklyGrowth` → `cluster4WeeklyCardsData` | **적용** (experienceGrowth verdict=fail → success를 화면상 fail로) |
| cluster3 | `getGrowthIndicators().period` | 미적용 (raw DB) |
| cluster1 | `getCluster1Resume().scheduleReliability` | 미적용 (raw DB) |

## 정책
1. cluster4의 `experienceGrowth` read-time override는 **sync 전 갭 보정용으로만** 유지.
2. 최종 정합성은 **sync로 `user_week_statuses.status`에 fail을 영속화**해서 맞춘다.
3. **cluster1/cluster3에 override를 추가하지 않는다.**
4. 세 클러스터 모두 최종적으로 `user_week_statuses.status`를 읽는 구조 유지.

## ⚠ sync 전/후 동작 (운영자 필독)
- **sync 전**: 같은 주차가 **cluster4에서만 '성장(실패)'**로 보이고, cluster1(이력서)·cluster3(성장지표)는 raw DB(success)를 읽어 **'성공'으로 집계**될 수 있음 (일시적 불일치, 정상).
- **sync 후**: `user_week_statuses.status=fail` 영속화 → cluster4 override가 **no-op** → **cluster1/cluster3/cluster4 모두 fail로 일치**.

## sync 실행 절차 (개발자 모드 기준)
- **devMode=ON(`?dev=true`)**: 테스트 사용자(`display_name ILIKE '%T%'`)만 대상. "성장 동기화(테스트)" 버튼. 즉시 반영(안전·멱등).
- **devMode=OFF(운영)**: "전체 동기화(운영)" 버튼 → **dry-run으로 영향 범위 확인 → confirm 시에만 DB 반영**. 실사용자 포함.
- 개인 sync API: 테스트 사용자는 항상 반영 / 실사용자는 devMode=OFF + confirm=true 일 때만 반영(그 외 dry-run).

## 불변식
- success→fail **단방향**, **현재주(running) 제외**, `personal_rest`/`official_rest`는 success-only 가드로 **물리적 미변경**, **멱등**.
- sync는 `user_week_statuses.status`만 write. **info/평점/강화율/5슬롯은 별개 source로 영향 없음.**

## 검증 결과 (2026-05-31, read-only 실측)
- **sync 전(실사용자 예: 성채윤)**: raw `success=3 fail=0` / cluster1 `approved=3 fail=0` / **cluster4 `approved=2 failed=1` (override +1)** → cluster4만 fail. 불일치 확인 ✅
- **sync 후(테스트 예: T신하윤)**: raw `success=3 fail=1` / cluster1 `approved=3 fail=1` / **cluster4 `approved=3 failed=1` (override no-op)** → 3클러스터 일치 ✅
- rest는 flip 후보 아님 ✅ / 운영 dry-run = 미반영(현재 실사용자 17명·17주차 confirm 대기) ✅
- 테스트 sync 멱등(추가 flip 0) ✅

## 알려진 무관 이슈 (별건)
- `cluster3GrowthData.getGrowthIndicators`는 현재 환경에서 `user_cumulative_points.total_stars` 컬럼 부재로 **포인트 쿼리에서 throw**할 수 있음. 주차 상태(period) 로직과 무관한 **포인트 스키마 드리프트**이며 본 SoT 정책과 별개. (cluster3의 period는 코드상 raw 카운트로 override 없음 — 변경 불필요.)
