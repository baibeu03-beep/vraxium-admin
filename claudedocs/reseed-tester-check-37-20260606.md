# 테스터 check 재시드 보고서 — threshold 37/35 기준 정렬 (B7 apply 와 분리)

> **작성일**: 2026-06-06 · **상태**: 적용 + 검증 완료
> **스크립트**: `scripts/reseed-tester-check-37.ts` (dry-run 기본 / --apply) · run log `claudedocs/reseed-tester-check-37-20260606.json`
> **검증**: `scripts/verify-reseed-37.ts` (direct/HTTP/snapshot/실사용자) · `scripts/verify-reseed-37-browser.mjs` (운영 front)

## 재시드 규칙 (케이스 의도 보존)

- 대상: `test_user_markers` 테스터 × b8AuditWeekSet 25주 × `checks_migrated=true` ∧ `uws=success` ∧ 평점 ok ∧ `points∈[30, 신기준)`
- 액션: `points += (신기준−30)` (+7, 가을 W9 +5) — 분포 평행이동으로 케이스 A(주차 성공) 유지
- 무접촉: 케이스 B(uws=fail)·C/D(평점 fail)·신기준 이미 충족 행·감사 25주 밖 주차(threshold 30 유지)·**실사용자 전체**
- 행 단위 갱신 (id + 구값 가드·행수 1 검증), run log 에 구값 보존(롤백 가능), 멱등(재실행 시 대상 0)

## 검증 결과 — 요청 10항

| # | 항목 | 결과 |
|---|---|---|
| 1 | 수정 대상 테스터 수 | **83명** (테스터 90명 중 — 7명은 해당 행 없음) |
| 2 | 수정 user_weekly_points 행 | **380행** = B8 공표 주차 flip 358 + 미공표 2026-spring W13 22 (주차별 분포 run log) |
| 3 | 수정 user_week_statuses 행 | **0행** — 케이스 의도가 uws 에 이미 정렬(케이스 B=fail 유지), 수치만 기준 이동 |
| 4 | 37/35 재판정 flip | **0건** ✅ (적용 직후 전수 시뮬레이션) |
| 5 | direct | ✅ 재시드 30행(샘플 테스터 2명) — success 유지 + checkGate earned=신값·passed·enforced=true |
| 6 | HTTP(운영 admin API) | ✅ 동일 30행 응답 일치 |
| 7 | direct == HTTP | ✅ userWeekStatus·checkGate 필드 단위 완전 일치 (snapshot==direct 도 일치) |
| 8 | snapshot 재계산 | ✅ **83/83** (dto_version 18 · is_stale=false) |
| 9 | 브라우저(운영 front /cluster-4) | ✅ weekly-cards 200 · 카드 12장 렌더 · **단감(check) 37/38개 표시 실증** · 성장(성공) 라벨 · W13=집계 중 · 콘솔 에러 0 — `browser-reseed-37-tester-cards.png` |
| 10 | 실사용자 영향 | **0건** ✅ — 적용 전/후 비테스터 uwp·uws 전행 fingerprint 동일 + 실사용자 2명 direct 검증(success 보존·enforced=false) |

## 부가 검증

- **케이스 B 분리 표시 보존**: 5b3c0935 2026-03-02 — 주차 fail + 강화 success ✅ (강화성공·주차실패 분리 계약 유지)
- 스킵 집계: 비success 320 · 평점 fail 0 · 신기준 이미 충족 403 — 시드 계약 위반(uws=success ∧ points<30) **0건**
- 현재(threshold NULL→30) 화면 표시 **불변** — earned 만 +7/+5. B7 apply 로 required 가 37/35 가 되어도 earned≥신기준이라 flip 0 (의도)

## B7 apply 게이트 상태

테스터 358주차 flip 게이트 **해소** (수용 대신 재시드 완료). weeks 테이블 무접촉이므로 B7 preflight(plan↔live drift)도 유효 그대로 — **B7 apply 즉시 실행 가능** (`apply-b7-weeks-backfill.ts --apply`).
