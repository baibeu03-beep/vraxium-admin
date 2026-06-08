# B7 apply 실행 보고서 — seasons·weeks 백필 적용 완료

> **적용 시각**: 2026-06-06 01:23 UTC (10:23 KST) · **run log**: `claudedocs/b7-apply-2026-06-06T01-23-18.json`
> **스크립트**: `scripts/apply-b7-weeks-backfill.ts` · 사후 검증 `scripts/verify-b7-apply.mjs`
> **범위 준수**: weeks/seasons 만 — uwp·uws·실무 경험 데이터·PMS 실사용자 이관 **무접촉** (write 테이블 = seasons·weeks 2개 + snapshot 캐시 재계산)

## 적용 중 발견 — 병행 작업 충돌 (drift 가드 작동)

preflight 가 **drift 8건을 감지하고 중단** (fail-closed 정상 작동): 06-05 dry-run 이후 별도 작업
`apply-tester-summer-weeks.ts`(졸업 테스터 충족용, 06-06 09:57 실행)가 **2025-summer W1~8 을 의도적으로 생성**
(check_threshold=0·publish 세팅 — 합성 주차 설계, `tester-summer-weeks-20260606.json`).
→ 처리: conflict 와 동일하게 **스킵(라이브 보존)** — 테스터 졸업 충족 설계 유지. pms 기대값
(confirmStar 24/24/34/34/37/37/35/37·**미공표**)은 run log `concurrentSkipped` 에 기록, **실사용자 이관 단계 재결정 항목**.
(테스터 영향 없음 — 해당 주차 uwp 행 부재 → enforced=false, threshold 값 무관)

## 검증 결과 — 요청 10항

| # | 항목 | 결과 |
|---|---|---|
| 1 | 실제 write | **seasons insert 12** (2023봄~2026겨울, idx 2~13·기존 spring=1 무접촉) · **weeks insert 103** · **weeks update 25** (check_threshold NULL→37×24·→35×1 = B8 감사 주차 1:1) · **conflict skip 7** + **병행작업 skip 8** · weeks 50→**153행**·seasons 13행 |
| 2 | W8 공식 휴식 | ✅ 유지 — winter 휴식 플래그 단 1건 = W8 "설 연휴" (preflight 무회귀 가드 + 사후 단언) |
| 3 | result_published_at | ✅ **변경 0건** — insert payload 에 키 구조적 부재, 신규 103행 전부 NULL, publish 보유 수 46 불변 |
| 4 | direct | ✅ 재시드 30행(테스터 2명) success + checkGate required=**37**·earned=신값·passed·enforced=true / 케이스 B fail+강화 success 분리 유지 |
| 5 | HTTP | ✅ 운영 admin(internal key)·front proxy 모두 200, 동일 DTO |
| 6 | direct == HTTP | ✅ 필드 단위 완전 일치 (30행) + front proxy(userId) == admin internal **deep equal** |
| 7 | snapshot | ✅ 122개 전부 is_stale=false·v18 — apply 직후 cm 90명 명시 재계산 90/90 완료, snapshot==direct 일치 |
| 8 | demoUserId == 일반 | ✅ 로컬 dev(demo 게이트 활성)에서 `?demoUserId=` vs `?userId=`+internal **deep equal 완전 동일** + 코드 실증(두 경로 모두 `loadWeeklyCards` 단일 로더, route.ts demo 분기). 운영 admin 직접 demoUserId 호출 401/400 은 ENABLE_DEMO_MODE 미설정 **env 게이트**(알려진 비대칭, 메모리 등재) — 데이터/DTO 차이 아님. 운영 front 의 데모 읽기 실경로 = internal-key proxy(검증 #6에 포함) |
| 9 | rollback | ✅ 가능 — run log 에 insertedSeasonIds 12·insertedWeekIds 103·updatedRows 25(prior=null 보존) 무결, `--rollback <runlog>` 경로 구현(현재값 가드 + snapshot 재계산 포함). 리허설은 미수행(적용 무효화 방지) |
| 10 | 브라우저 (운영 front) | ✅ 카드 12장 렌더·단감 37/38 표시·성장(성공) 라벨·W13 집계 중·콘솔 에러 0 — `browser-reseed-37-tester-cards.png` |

## B8 재실행 (read-only, 라이브 37 기준)

- **Part A: universe 783 · flips 0 · alreadyDemoted 0** — 테스터 재시드 + threshold 백필 조합으로 표시 뒤집힘 **0 실측**.
- 실사용자: enforced 행 0 그대로 — checkGate enforced=false·success 표시 보존 (direct 재검증 통과).
- Part B 198건(80명)은 **PMS 실사용자 이관 시점**의 정책 결정 사항(권장: PMS 인정 우선=해당 행 flag false) — 이번 작업 범위 밖, 변동 없음.

## 잔여 항목 (이관 단계로 이월)

1. conflict 7건 수동 확정 (2025-10 가을 휴식 3 · 2025-12 시즌 경계 4 — 라이브 보존 중)
2. 2025-summer 8주 pms 속성 재정렬 여부 (threshold 0·publish 세팅 vs pms confirmStar·미공표 — 테스터 졸업 설계와 조율)
3. PMS 뒤집힘 198행 정책 (PMS 인정 우선 권장) + §12 dry-run 1명(pms 1092)
