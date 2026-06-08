# B7 apply 구현 보고 — seasons·weeks 백필 적용기 (쓰기 미수행)

> **작성일**: 2026-06-06 · **상태**: 코드 구현 + preview 검증 완료, **실제 쓰기 0건** (--apply 미실행)
> **스크립트**: `scripts/apply-b7-weeks-backfill.ts`
> **실행**: `npx tsx --env-file=.env.local scripts/apply-b7-weeks-backfill.ts` (preview) / `--apply` / `--rollback <runlog>`

## 운영 확정 반영 (2026-06-06)

| 확정 | 반영 |
|---|---|
| 2026-winter W8 = 공식 휴식주 | 06-05 fix(`apply-winter-rest-week-sot-fix.mjs`)로 **이미 라이브 적용 완료** (W8=설 연휴·휴식 플래그 단 1건). 본 적용은 W8 무접촉 — preflight **무회귀 가드** + plan 이 W8 을 쓰기 대상으로 포함하면 중단하는 구조 가드 |
| Vraxium-native(05-04~) = 더미 / PMS = 실사용자 SoT | B8 Part C 우려(컷오버 경계) **해소** — §12-①-3 "겹침 주차 pms 집계 덮어씀 + checks_migrated=true" 정당. 라이브 spring W10~13 실사용자 uws success 64행도 이관 시 pms IsActive 기준 재정렬 대상(이관 단계 확인 항목) |
| checks_migrated 단독 판정 전환 SoT | 본 적용은 플래그 무접촉 — threshold 값만 공급 (v18 계약 그대로) |
| snapshot-only / DTO·API 계약 / demoUserId 동일 | 코드·계약 무변경. snapshot 은 apply 후 명시 재계산만(기존 룰) |

## 설계 — "dry-run plan = 실행 계약"

apply 는 plan 을 재계산하지 않고 `claudedocs/backfill-seasons-weeks-dryrun-20260605.json` 의 plan 행을 **그대로 실행**한다 (검토된 산출물이 곧 계약).

1. **preflight (fail-closed)**: plan↔live 전수 drift 검사 — insert 대상 start_date 의 라이브 선점, update 대상의 `diff.live` 스냅샷과 현재값 불일치, 비허용 diff 컬럼(화이트리스트: check_threshold·holiday_name·is_official_rest), winter 휴식=[W8] 가드. **drift 1건이라도 있으면 전체 중단** (dry-run 재생성 요구).
2. **seasons insert 12** (이름 기준 멱등): 2023 봄~2026 겨울, started_at 시간순 season_index 2..13 (기존 2026-spring=1 무접촉 — season_index 소비처는 `testUsers.resolveCurrentSeasonName` 의 최후순위 tiebreaker 뿐, 신설 행 전부 ended_at 보유·과거 started_at 이라 현재 시즌 해석 불변 검증).
3. **weeks insert 111**: 라이브 컨벤션 미러 실측 반영 — `week_index = iso_week`, `started_at/ended_at = date 00:00Z`. season_id 는 신설 seasons 참조 (기존 42행 season_id 재배선 없음 — 단일 행 quirk 보존).
4. **weeks update 25** (= B8 감사 주차와 동일 집합): `check_threshold NULL → 37` (24주) / `→ 35` (2025-autumn W9). 컬럼 단위 PATCH + prior 값 가드(`.is/.eq`) + 갱신 행수 1 검증.
5. **conflict 7행 스킵** (라이브 보존): 2025-10-06/13/20(가을 휴식), 2025-12-01/08/15/22(12월 휴식·시즌 경계) — 수동 확정 큐 유지.
6. **`result_published_at` 구조적 제외**: insert payload 에 키 자체가 없음 / update 화이트리스트 밖 / 사후 검증에서 publish 보유 수 변동=0 단언. publish 는 기존 PATCH publish-result(409 비가역) 경로 전용.
7. **사후 검증**: weeks 행수 42→153, update 25 값 일치, publish 변동 0, winter 휴식=[W8].
8. **snapshot 명시 재계산**: checks_migrated=true 행 보유 사용자 **90명** (`recomputeAndStoreWeeklyCardsSnapshot` lib 재사용) — checkGate.required 가 snapshot 에 구워져 있어 필수.
9. **롤백**: run log(`claudedocs/b7-apply-<ts>.json`, 쓰기마다 저장)에 insertedSeasonIds/insertedWeekIds/updatedRows(prior 포함) 기록 → `--rollback` 이 insert 삭제 + prior 복원(현재값=적용값 가드, 이후 수동변경 행 보호) + snapshot 재계산. 부분 실패 시에도 로그가 남아 동일 경로로 복구.

## Preview 실측 (2026-06-06, 쓰기 0)

```
plan: insert 111 / update 25 / conflict(스킵) 7 / noop 9
seasons: insert 12 / noop 1 — 라이브 42행 → 적용 후 153행
✅ drift 0 — plan 과 라이브 정합 (06-05 W5/W8 fix 이후에도 plan 유효 확인)
update 25 = check_threshold 만 (holiday/rest diff 없음) — B8 감사 주차와 1:1
snapshot 재계산 대상 90명
```

## 영향 범위

| 영역 | 영향 |
|---|---|
| 실사용자 표시 | **없음** — enforced(checks_migrated=true) 행 보유자는 전원 테스터(B8 실측). 실사용자 uwp 는 flag=false → 게이트 미강제 보존 |
| 테스터 (90명) | B8 실측 **358주차 표시 success→fail** (시드가 30 기준) + snapshot 재계산 후 즉시 반영. 시연 시나리오 분포 변형 — 수용 or 재시드(threshold 37 기준) 운영 결정 잔여 |
| uws / uwp / growth_stats | 무접촉 (read-time 게이트 — uws 소급 write 경로 없음 확인: `syncExperienceGrowthWeekStatuses` 레거시 update 금지) |
| 신규 weeks 111행 | uws/카드 없는 주차 — weekly-cards 는 uws·snapshot 기반이라 카드 미생성(무영향). 이관 파이프라인의 week 룩업 대상으로만 기능 |
| seasons 12행 | 참조 0 (신규 weeks 만 참조). 현재 시즌 해석 불변 (`resolveCurrentSeasonName` 규칙 검증) |
| DTO/API/demoUserId | 계약 무변경. weekly-cards demoUserId=조회대상 override only(동일 snapshot 직독) |
| publish | 변동 0 (구조적 제외 + 사후 단언) |

## 검증 계획 (apply 실행 시)

1. **스크립트 내장**: preflight drift 0 → 사후 행수/값/publish/W8 단언 (실패 시 예외 + 롤백 경로 안내).
2. **direct**: `verify-week-check-policy.ts` 재사용 — 테스터 케이스 샘플의 checkGate.required=37(W9=35)·enforced=true, B8 Part A flip 명세 행 userWeekStatus=fail 전환 확인.
3. **HTTP == direct**: `GET /api/cluster4/weekly-cards?userId=` (x-internal-api-key) — userWeekStatus·checkGate 필드 단위 일치.
4. **snapshot**: dto_version=18·is_stale=false·cards==direct (재계산 직후).
5. **demoUserId == 일반**: 동일 대상 양 경로 응답 deep-diff=0.
6. **실사용자 보존**: 실사용자 success 주차 표시 유지 + checkGate.enforced=false (B8 Part A 재실행으로 자동 검증 가능 — `b8-reaudit-threshold37.mjs` 멱등 재실행, Part A alreadyDemoted/flips 값이 "적용 후 기대"로 이동했는지 대조).
7. **롤백 리허설** (§10 체크리스트): 적용 → `--rollback` → weeks 42행·threshold NULL·snapshot 원상 복귀 diff=0 — 운영 승인 후 1회 수행 권장.

## apply 실행 전 잔여 결정 (운영)

1. **테스터 358주차 flip**: 수용(시연 데이터 변형) vs threshold 37 기준 재시드 — apply 와 동시 또는 직후.
2. conflict 7건: apply 가 스킵하므로 차단 아님 — 별도 수동 확정 시점 자유.
