# 2025-summer PMS 정본 복원 보고서 — W1~W8 구조 복원 완료

> **적용 시각**: 2026-06-07 01:03 UTC · **run log**: `claudedocs/summer-pms-restore-2026-06-07T01-03-07.json` (rollback 가능)
> **스크립트**: `scripts/apply-summer-pms-restore.ts` · 검증 `scripts/verify-summer-pms-restore.ts`(22/22) · 브라우저 `scripts/verify-summer-restore-browser.mjs`(4/4)
> **정책**: PMS 실데이터=SoT · 테스터=졸업 테스트용 더미(분리 처리·이관 판단 제외) · weeks/seasons 구조만 변경

## 실제 write (weeks 단일 테이블 + snapshot 캐시)

| 작업 | 내용 |
|---|---|
| weeks insert 4 | W1~4 (06-30/07-07/07-14/07-21, thr 24/24/34/34, 미공표) — pms 정본(B7 run log concurrentSkipped) |
| weeks update 8건 | W5~8: thr 0→37/37/35/37 · result_published_at→NULL (prior 보존 — 합성 행 ops 정정 예외) |
| snapshot | 테스터 6명 invalidate + 명시 재계산 6/6 (B7 패턴 recomputeAndStoreWeeklyCardsSnapshot) |
| **무접촉** | uws(1750 불변)·uwp(1689 불변)·실무 경험·seasons(13) — 금지 계약 검증 통과 |

## 검증 필수 6항

| # | 항목 | 결과 |
|---|---|---|
| 1 | direct | ✅ 테스터 6명 — summer 카드 4장(W5~8)·W1~4 카드 0 (uws 없는 주차 카드 미생성 계약) |
| 2 | HTTP | ✅ 운영 admin internal 200 ×6 |
| 3 | direct == HTTP | ✅ 46장 ×6명 정규화 deep equal diffs=0. **1차 deep equal 실패 원인 분석**: PG jsonb 가 snapshot 저장 시 키 순서를 정규화 → stringify 비교 아티팩트 (키 재귀 정렬 후 완전 동일 — `diag-summer-direct-vs-http.ts` 실증, 실질 데이터 diff 0. 기존 검증들이 필드 단위 비교였던 이유) |
| 4 | snapshot 영향 | ✅ 122개 전부 is_stale=false·v18, 테스터 외 116명 무접촉 |
| 5 | snapshot 재계산 | ✅ 필요(checkGate.required/resultStatus 구워짐) — 6명 명시 재계산 완료, snapshot==direct |
| 6 | 브라우저 | ✅ 운영 front /cluster-4 — 여름 필터 시 W5~8 정확 4장·"성장(집계 중)" 라벨·콘솔 에러 0. 목록은 페이지네이션(10장/페이지)이라 시즌 필터로 검증. `browser-summer-restore-tester-cards.png` |

## 테스터 6명 — 전 항목 불변

graduated 유지 ✅ · approvedWeeks 31 불변 ✅ · cumulativeWeeks 44 불변 ✅ · growth_status='graduated' 불변 ✅ (6/6)
W5~8 더미 uws 24행 success 보존 · Details "성장 시작 주차 = 2025년 여름 5주차" 정상.
표시 변화 1건(사전 승인): summer 카드 확정→**집계 중** (미공표 정본 — 졸업/누적 수치 무관).

## 실사용자 이관 정확도 향상 (1092 dry-run 라이브 실측)

| 지표 | 복원 전(06-07 회귀 상태) | **복원 후 실측** |
|---|---|---|
| uws success | 12 (Week 14 재현 깨짐) | **14 ✅ (pms Week=14 완전 재현 회복)** |
| 판정 역방향 | 1 | **0** (summer W4 thr 34 로 pms 와 일치) |
| FLIP | 2 | 2 (기지수 — autumn W13·winter W5 수동 인정) |
| 미귀속 pointlogs | 46 | **6** (W1~8 이 시즌 갭 로그 흡수) |
| adjustment 잔차 | Star +98 | **Star +12** (원장-잔액 정합 향상) |
| 활동 귀속 실패 큐 | 6 | **0** |

overlay preview(`--summer-pms-overlay`)와 실측 완전 일치 — preview 메커니즘 신뢰성도 확보.

## 잔여 게이트 (1092 apply 전)

① FLIP 정책 서면 확정(PMS 인정 우선 권장) ② legacy_user_id 오염 34명 선처리(≥1억 재채번 or 매칭 제외) ③ apply 스크립트 작성+롤백 리허설. 1092 Apply·실사용자 이관은 지시대로 미실행.
