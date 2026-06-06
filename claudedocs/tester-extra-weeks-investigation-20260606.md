# 더미 테스터 전용 "추가 활동 주차" 생성 방식 조사 (2026-06-06, read-only)

방향 정정 반영: 공식 휴식 주차 override **금지**. 부족분(a=26 < 임계 30)은 실제 활동 주차 4개 추가로 충족.

## 결론 요약

**가능하며, 후보 구간은 2025-summer (2025-06-30 ~ 2025-08-18, W1~W8)이다.**
weeks 캘린더 자체는 전역(공용)이지만, 고객 노출 경로 전부가 "본인 uws 행 존재" 기준이므로
uws 를 테스터 6명에게만 시드하면 **사실상 테스터 전용 주차**가 된다.
실사용자(31명) 최소 uws 주차=2026-05-04 → 2025-summer 는 모든 실사용자 카드 범위 밖.

## 1) 테스터 전용 주차 메커니즘 존재 여부

- 전용 메커니즘은 없음 — weeks 는 단일 공용 캘린더.
- 그러나 카드/성장 지표의 주차 모집단은 weeks 전체가 아니라
  **[본인 최소 uws 주차, 현재 주차]** 범위 (lib/cluster4WeeklyGrowthData.ts:377-399).
  uws 없는 주차는 카드 미생성·uws 자동 생성 코드 없음(전 경로 확인) →
  weeks 행 + 테스터-only uws = 테스터에게만 보이는 주차.
- 변형 A(완전 무접촉): weeks 행 없이 uws 만 추가 — orphan 합성 주차
  (cluster4WeeklyGrowthData.ts:406-449, synthetic=공표 완료 취급 → a 가산됨).
  단, 카드 제목 주차번호가 uws.week_number(ISO) 폴백 → "여름 시즌 27주차" 식
  시즌 초과 표기 결함(06-05에 고친 버그와 동일 패턴) + week_id 없어 라인 생성 불가 → **비권장**.
- 변형 B(권장): weeks 행 4개 추가 + uws 시드 — 정상 표기·정상 데이터 모형.

## 2) weeks 추가 시 실사용자/운영 화면 영향

| 표면 | 영향 | 근거 |
|---|---|---|
| 고객 카드목록/성장지표(a·h) | 없음 | 범위=[본인 최소 uws(실사용자 2026-05-04), 현재]; uws 자동생성 없음 |
| user_growth_stats | 없음 | uws 직접 합산(weeks 비조인, lib/userGrowthStatsData.ts:39-79) |
| 이력서 seasonRecords | 없음 | season_definitions × 본인 uws 파생(lib/cluster1ResumeData.ts:245-) |
| 분모A(통합라인 개설 신호) | 없음 | 신호는 주차 전역이지만 해당 주차가 실사용자 카드 범위 밖 |
| admin /admin/season-weeks | **노출됨** | 전역 weeks 열거 — 관리자 화면 한정(유일한 가시 영향) |
| admin 주차인정/엑셀 import | 행 증가만 | 결과 확정(publish)은 신규 행에 미리 세팅하므로 운영 액션 불필요 |

## 3) 테스트 전용 시즌/주차 가능 여부

- **가상 시즌 신설은 비권장**: seasonCalendar 는 DB 무관 하드코딩(앵커 2023-01-02·364일 주기,
  lib/seasonCalendar.ts:22-31) — 임의 키/날짜는 규칙과 충돌(전환·휴식 오판).
- 대신 **실존하되 캘린더(weeks)에 미수록된 2025-summer** 가 사실상 테스트 전용 시즌:
  - 캘린더 규칙 판정 실측: 2025-06-30~08-18 전부 `running`(전환·규칙휴식 아님), 08-25=transition
  - official_rest_periods overlap 없음(활성 행은 2026 설 연휴 1건뿐)
  - season_definitions 에 이미 행 존재(id=18, "2025년도 여름시즌")
  - weeks 현행 범위는 2025-09-01부터(2025-autumn 17 + 2026-winter 9 + 2026-spring 16 = 42행)
  - 테스터 활동시작=2025-09-01 직전 시즌이라 히스토리상 자연스러움 → **운영 캘린더 의미 훼손 없음**

## 4) snapshot 재계산 범위

- **6명의 weekly-cards snapshot 재계산만** (recomputeAndStoreWeeklyCardsSnapshot)
  + recalcUserGrowthStats(6명) — uws writer 계약.
- audience 전파 불필요: 다른 테스터(90명 포함) 최소 uws=2025-09-01 → 신규 주차가 그들 범위 밖.
- 이력서/front graft = admin live(내부적으로 동일 snapshot 직독) → 별도 재계산 없음.
- 품계(grade-stats): 포인트 합 불변 설계(아래 5) 시 sync 불필요.

## 5) 신규 row 필요 테이블 (B안, 4주차 × 테스터 6명)

| 테이블 | 행수 | 핵심 컬럼/주의 |
|---|---|---|
| weeks | 4 | id, **season_id=기존 단일 uuid 재사용**(전 42행이 '33333358-…' 한 행을 가리킴 — 신규 seasons 행 불필요), week_index, started_at/ended_at(ts NOT NULL), week_number(1~8 중), start_date/end_date, season_key='2025-summer', is_official_rest=false, iso_year/iso_week, **result_published_at 필수 세팅**(미공표면 a 미가산 — 2026-05-25 실증), check_threshold |
| user_week_statuses | 24 | status='success', season_key, year/week_number(ISO), is_official_rest_override=false |
| cluster4_lines / line_targets / line_submissions / experience_line_evaluations | 선택 4 / 24 / 24 / 24 | v17 통합라인 모형 재현(rating≥4). **생략 가능** — '미개설=uws 보존' 규칙(reduceLegacyUnifiedVerdict)으로 recompute 가 success 를 뒤집지 않음. 단 생략 시 카드가 "라인 없음+성공" 표시 |
| user_weekly_points | 선택 24 | (i) 생략=미이관 fail-safe(보존·카드 포인트 '-') 또는 (ii) points=0·checks_migrated=true + weeks.check_threshold=0. **points≥30 금지** — 이력서 누적포인트(전기간 직접합산) +120 오염 |
| user_growth_stats | 6 upsert | recalcUserGrowthStats 호출 |
| user_profiles | 선택 6 | activity_started_at 2025-09-01→2025-06-30(일정신뢰도 physicalWeeks 정합용·a 계산 무관) |
| seasons / user_season_histories | 0 | 불필요 (ush 는 시즌평판 저장 시에만) |

적용 후: a 26→30 → graduated 재승격은 별도 스텝(growth_status 원복).

## 6) 실사용자 무영향 보장 방법

- 구조적: 실사용자 최소 uws=2026-05-04(31명 전수 확인) ≫ 2025-08-18 → 카드 범위 밖,
  uws 자동생성 없음, growth_stats=uws 직접합산. 메모리 제약("실유저 활동시작 이전 주차만 안전")과 정확히 부합.
- 절차적: 쓰기 직전 test_user_markers assert, writer 화이트리스트=6 uid 고정,
  dry-run→apply 2단계, 적용 전후 실사용자 지문(uws/growth_stats/snapshot 카운트+해시) diff=0 검증.

## 기각 대안

- 미래 주차 자연 누적 대기(2026-summer 6/29~): 신체계(허브/라인 v14+) 성공 요건 + 실사용자 공존 주차 → 백필 제약 위반.
- 졸업 임계 하향: 코드 전역 상수(GRADUATION_THRESHOLDS) → 실사용자 영향.
- 공식 휴식 override: 기획 의도 위배로 금지(사용자 지시 2026-06-06).

## 근거 산출물

- `claudedocs/diag-tester-extra-weeks-feasibility-20260606.json` (라이브 실태)
- `scripts/diag-tester-extra-weeks-feasibility.ts`, `scripts/diag-candidate-week-calendar.ts` (read-only 재현)
