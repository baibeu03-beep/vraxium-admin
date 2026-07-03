# 운영 데이터 정합성 점검 런북 (매일 1회)

고객 앱과 어드민 페이지의 수치가 어긋나지 않도록, **direct(lib 함수) = DB 캐시/snapshot = admin HTTP = customer HTTP** 인지 매일 비교하고, 불일치가 있으면 **필요한 항목만** targeted resync/재계산한다.

- **스크립트**: `scripts/daily-consistency-check.ts`
- **결과**: `claudedocs/daily-consistency-report.json` (매 실행 덮어씀)
- **원칙**: 무조건 전체 resync 금지 — 먼저 비교하고 **불일치한 user_id만** 재계산. 코드 grep 아님, 실제 DB 값 + HTTP 응답 기준.

## 실행 방법

```bash
# 1) 감지만 (write 0) — 매일 먼저 이걸로 확인
npx tsx --env-file=.env.local scripts/daily-consistency-check.ts

# 2) 감지 + stale 항목만 targeted 교정 + 재검증
npx tsx --env-file=.env.local scripts/daily-consistency-check.ts --fix

# 상세 로그
npx tsx --env-file=.env.local scripts/daily-consistency-check.ts --fix --verbose
```

기본은 **DETECT-ONLY**. `--fix`를 줘야 교정하며, 그때도 **불일치한 id만** 대상으로 한다(전체 X). 교정 후 같은 비교를 다시 수행(재검증)하고 `converged` 여부를 보고한다.

## 실행 순서 (요청 사양 1~9 매핑)

각 remediable 체크는 아래 루프를 돈다:

1. **direct** lib 함수 결과 확인 (SoT 산식)
2. **DB 캐시/snapshot** 값 확인
3. **admin HTTP** 응답 확인 (internal-key)
4. **customer HTTP** 응답 확인 (테스터 — QA 모집단)
5. `direct == DB == admin HTTP == customer HTTP` 비교
6. 불일치 분류: `stale-cache / stale-snapshot / dto-divergence / fallback / demo-branch / structural`
7. stale-cache·stale-snapshot이면 **targeted** resync/재계산 (`--fix`)
8. 재실행 후 같은 비교 재수행 (converged 판정)
9. admin/customer 최종 일치 + 브라우저 반영 확인

## 점검 항목 ↔ 타깃 ↔ SoT ↔ 교정기

| # | 체크 | 타깃 | 비교(SoT) | DB 캐시/snapshot | 교정기(targeted) | 종류 |
|---|---|---|---|---|---|---|
| 1 | grade cache (avgPercentile/품계) | 1,2,7 | `getClubRankGradeBatch` (live, 1 scan) = `/api/cluster3/club-rank` | `user_grade_stats.avg_percentile` | `resyncGradeStatsBatch(mismatchIds)` | remediable |
| 2 | growth stats (approved/cumulative weeks) | 3 | uws 집계(전환 제외) = `getGrowthStatsMismatchedUserIds()` | `user_growth_stats` | `recalcUserGrowthStats(id)` × id | remediable |
| 3 | weekly-card snapshot | 4 | `readWeeklyCardsSnapshot` / DTO v`31` | `cluster4_weekly_card_snapshots` (`is_stale`, `dto_version`) | `recomputeWeeklyCardsSnapshotsForUsers(badIds)` | remediable |
| 4 | cumulative points ledger | 5 | `Σ user_weekly_points`(points·penalty) | `user_cumulative_points` (`total_checks`, `total_penalties`) | `sync_cumulative_points_for_user` RPC × id | remediable |
| 5 | cross-app HTTP parity (테스터) | 3,6,7,8 | customer `/api/profile`·`weekly-cards` vs admin `cluster1/resume`·`club-rank`·`weekly-cards` + direct `getWeeklyGrowth` | — | 없음(코드 이슈) | **detect-only** |
| 6 | 구조 정합성 | 보조 | `getOperationHealthCheck()` (uws↔season↔weeks 매핑) | — | 없음(사람 판단) | **detect-only** |

### 원인 분류 → 조치 매핑

| cause | 의미 | 조치 |
|---|---|---|
| `stale-cache` | 캐시가 SoT보다 오래됨 (품계·성장·누적) | 해당 캐시 writer **targeted** 재실행 (`--fix`) |
| `stale-snapshot` | `is_stale=true` 또는 `dto_version≠현재` | `recompute…ForUsers(badIds)` (`--fix`) |
| `dto-divergence` | 같은 의미 필드가 다른 DTO/형태로 산출 | **코드 수정** (resync로 해결 안 됨) — 리포트만 |
| `fallback` | 고객 graft 실패 시 null/로컬 폴백 (예: reliability/completion=null) | 어드민 warm 확인·graft 타임아웃 조정 — 리포트만 |
| `demo-branch` | `?userId=` vs `?demoUserId=` DTO 분기 | **코드 수정** (경로가 갈리면 안 됨) — 리포트만 |
| `structural` | uws↔season↔weeks 매핑/시즌휴식 정합 | 데이터 수정·사람 판단 — 리포트만 |

**중요**: `dto-divergence`·`fallback`·`demo-branch`·`structural`은 resync로 못 고친다. `--fix`는 `stale-cache`·`stale-snapshot`만 건드리고, 나머지는 리포트만 한다. direct와 HTTP가 다르면 완료로 보지 말고 이 분류부터 처리.

## 핵심 SoT 정의 (snapshot-only 관점)

- **avgPercentile/품계** 최종 SoT = **live `getClubRank`** (`/api/cluster3/club-rank`). `user_grade_stats`는 파생 캐시(어드민 로스터 품계 컬럼 전용). 고객 `/api/profile`은 admin-first graft가 정답. → [[project_grade-clubrank-sot-divergence]]
- **주차 카드** SoT = `cluster4_weekly_card_snapshots` (읽기 전용 hot path·단건 lazy recompute). 고객 weekly-cards는 admin proxy + `lineRating`만 self-edit enrich. DTO v31.
- **성장 통계**(approved/cumulative weeks) = uws 집계(전환 주차 제외). `user_growth_stats`는 캐시.
- **누적 포인트** = `Σ user_weekly_points`. `user_cumulative_points`는 트리거/RPC 동기 캐시.
- **demoUserId** = 읽기 대상 override only. DTO/코드 분기 없음(분기 발견 시 버그).

## 왜 매일 돌려야 하나 (근본 원인)

- **품계(avgPercentile)는 global-relative** — 한 명의 포인트 변경이 전원의 백분위를 이동시킨다. accrual/PMS 경로 대부분은 `syncGradeStats(1명)`만 호출 → 나머지 전원 stale. **cron 없음**(`vercel.json` crons 부재)이라 full resync가 스케줄되지 않음 → 매일 점검 필요.
- **weekly-card snapshot**은 `is_stale`로 마킹되고 조회 시 lazy recompute되지만, 조회 안 된 사용자는 stale로 남는다. 매일 proactive recompute로 첫 조회 지연·표시 지연을 없앤다.

## 스케줄링

Vercel Hobby cron 제한이 있으므로([[project_vercel-cron-hobby-block]]) 다음 중 하나:

- **(권장) 로컬 PC 폴러**에 하루 1회 `--fix` 실행 추가 — 프로세스 체크 워커와 동일 인프라([[project_process-check-worker.md]] 계열).
- 또는 `POST /api/admin/sync/grade-stats`(전체 grade resync)만 별도 호출 + 이 스크립트는 수동 확인용.
- **detect-only를 먼저** 매일 실행해 리포트만 보고, `stale-*`가 있을 때만 `--fix`.

## 브라우저 반영 확인

이 체크들은 서버가 반환하는 HTTP 응답을 화면이 그대로 렌더한다(주차 카드·프로필은 서버가 같은 API/snapshot을 읽음). 따라서 **admin HTTP == customer HTTP == snapshot**이 확인되면 브라우저 표시값도 동일하다. 별도 DOM 확인이 필요하면 `scripts/browser-verify-*.mjs`(playwright-core) 계열을 사용한다. 단 고객 prod는 QA 모드라 실유저는 403(`qaModeBlocked`) — 브라우저 확인도 **테스터 계정**으로.

## 환경 제약 (점검 전제)

- 고객 prod = **QA 모드**: 실유저 403(`qaModeBlocked`), 모집단 = `test_user_markers`. cross-app 비교는 **테스터**로.
- 어드민 prod `?demoUserId=` = **401** (`ENABLE_DEMO_MODE` off). 어드민 demo HTTP는 로컬 전용. demo 경로 검증은 **고객** `?userId=` vs `?demoUserId=`로 수행(고객 prod는 demo enabled).
- 어드민 `cluster4/weekly-growth` = internal-key 미수용 → direct `getWeeklyGrowth`로 비교.
- 어드민 랭킹/리그 = internal-key 엔드포인트 없음(구조적 독립).

## 관련 스크립트

- `scripts/audit-cross-app-parity.ts` — 6개 화면 카테고리 admin↔customer HTTP 파리티 감사(1회성 정밀).
- `scripts/verify-grade-cache-writer-parity.ts` — 품계 캐시 stale 원인 규명(cache vs live vs writer vs HTTP).
- `scripts/verify-grade-cache-postresync.ts` — grade resync 후 6기준 사후검증.
