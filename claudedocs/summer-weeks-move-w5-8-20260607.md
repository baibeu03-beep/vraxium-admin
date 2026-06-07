# 2025-summer 합성 주차 이동 보고 — W1~W4 → W5~W8 (2026-06-07)

> **적용 시각**: 2026-06-07 00:28 UTC (09:28 KST) · **run log**: `claudedocs/tester-summer-weeks-20260606.json` runs[] `MOVE W1~4 → W5~8`
> **스크립트**: `scripts/apply-summer-weeks-move-to-w5-8.ts` · 사후 검증 `scripts/verify-summer-weeks-move.ts` + `scripts/verify-tester-summer-weeks-all.ts`

## 배경

REDUCE-TO-4(06-06)가 8주 생성분의 꼬리(W5~8)를 잘라 W1~4 가 남았으나, 테스터 6명의
연속 활동이 2025-09-01(가을)부터라 **가을 직전에 붙는 W5~W8 이 활동 이력상 자연스러움**
(2026-06-07 지시). 수치 전부 불변: a=30 · graduated · 이력서 "4/8 정상 완료".

## 수행 내역

| 단계 | 내용 |
|---|---|
| 생성 | weeks W5~W8 4행 (07-28/08-04/08-11/08-18, week_number 5~8, iso W31~34, published 선세팅, threshold=0) + 통합라인 4 + 타깃/제출/평가 각 24 + uws success 24 |
| 삭제 | W1~W4 합성분 전량 — evals 24 → subs 24 → targets 24 → lines 4 → uws 24 → weeks 4 (id 화이트리스트, 참조 역순) |
| 프로필 | 6명 `activity_started_at` 2025-06-30 → **2025-07-28** (growth_status 무접촉, graduated 가드) |
| 재계산 | recalcUserGrowthStats + weekly-cards snapshot × 6명 |

## 검증 결과 (이동 특화 36/36 + 공통 64/64 pass)

- 6명 전원 **a=30 유지** (h=41, 임계 30 정확 일치) · graduated · ended 원값 유지
- 이력서 direct·HTTP 모두 **"25 여름 4/8 정상 완료"** + 정상 졸업 1건(26 봄)
- snapshot stale=false · 여름 카드 4장 = **weekNumber [5,6,7,8]** 전부 success · W1~4 카드 0 · weekId == 신규 행
- uws: 여름 4행 전부 W5~8 시작일·success, W1~4 시작일 행 0
- direct == HTTP (stats-cards·resume·front weekly-growth) · demoUserId 부착==미부착
- front "시즌 중 졸업"(2026-spring) + 2025-summer "시즌 성공" 유지
- oranke 유지 3명 회귀: graduated·a=26 불변
- **실사용자 지문 diff=0** (uws 1474·profiles 116·points 1462·snapshots 116, hash `0f5366e2…` 전후 동일 — REDUCE 직후와도 동일)

## 원복 키

run log `MOVE W1~4 → W5~8` 항목의 `insertedWeeks/…/insertedUws`(신규 W5~8 id) +
`removed`(W1~4 원행 전체: weeks id·week_number 포함) + `profileBefore`(started 원값).

## 후속 유의

- PMS 이관(§12) 시 2025-summer 8주의 PMS 속성 재정합 잔여 항목(B7 보고서 #2)은
  이제 **W1~4 가 빈 자리(신규 생성 자유), W5~8 이 합성 속성 충돌 구간**으로 반전됨.
