# 멀티소스(oranke/hrdb/olympus) PMS 이관 감사 (read-only, 2026-06-07)

> `scripts/audit-pms-multisource.ts` → `audit-pms-multisource-20260607.json` · 보조 probe `diag-multisource-calendar-person.mjs`
> **기존 보고 수치(1,369명·활동자 99명·FLIP 2,053 등)는 전부 ORANKE 전용** — 본 감사가 3개 시스템 최초 통합 실측.
> 방법론: 라이브 weeks(153)는 ORANKE 달력만 백필된 상태 → 3자 비교를 위해 **각 시스템 자체 weekssettings 달력** 기준으로 동일 로직(dryrun-1092 미러) 적용. ORANKE 라이브 기준 수치는 기존 보고(`audit-pms-full/active-20260607.md`) 병기.

## 시스템별 11항 실측

| 항목 | ORANKE | HRDB(→encre) | OLYMPUS(→phalanx) |
|---|---|---|---|
| ① 전체 사용자 | 1,369 | **1,670** | 303 |
| ② State | 정지860·졸업410·일반83·운영진16 | 정지1,003·졸업521·일반133·운영진13 | 정지236·일반31·졸업26·운영진10 |
| ③ 활동자 | 99 | **146** | 41 |
| ④ 활동자 최소 주차 | 2024-spring W5 (04-01) | **2024-winter W4 (2024-01-22)** | 2024-spring W2 (03-11) |
| ⑤ Week 재현율* | 37.0% (라이브 기준 66.7%·활동자 78.8%) | 35.0% | 49.8% |
| ⑥ success 재현율* | 94.4% (12,327→11,956) | 96.0% (13,753→13,537) | 94.2% (2,406→2,374) |
| ⑦ FLIP* | 688 | 551 | 140 |
| ⑧ 귀속 실패* | 활동 5,422/28,100 · 로그 71,415 | **활동 13,203/36,019(37%) · 로그 228,779(31%)** | 활동 343/3,240 · 로그 4,510 |
| ⑨ adjustment 100+ * | 526명 | 878명 | 48명 |
| ⑩ legacy 충돌 | 34 (UserId 1~1374) | 25 (1~1712) | 28 (1~303) |
| ⑪ 실무 경험 | subtitle 99.9%·rating 100% | subtitle 99.9%·rating 100% | subtitle 100%·rating 100% |

\* ⑤~⑨는 "자체 weekssettings(86/94/76주)만" 기준 — **주차 차원 결번이 수치를 지배**. ORANKE 실증: 자체달력 37.0% → 라이브 백필 후 66.7% → 활동자 한정 78.8%. hrdb/olympus 도 B7급 백필(weekssettings+seasondates 머지) 후 동급 개선 예상이 합리적이나, 백필 전 수치가 위 표의 실측.

## 교차 시스템 실측 (신규 발견 2건)

1. **동일 주차 threshold 상이 — 단일 weeks 구조 수용 불가 (차단급)**
   주차 그리드는 정렬(시작일 oranke∩hrdb 83/86 일치 — 같은 월요일 격자)되나, **겹치는 83주 중 73주에서 oranke≠hrdb confirmStar** (예: 2026-05-25 주 — oranke 37 / hrdb 30 / olympus 0). 공표 차이는 1주뿐.
   → Vraxium `weeks` 는 org 차원 없는 글로벌 단일 달력이고 v18 게이트가 `weeks.check_threshold` 직독(+snapshot 에 구움) — **hrdb/olympus 이관 전 "소스(org)별 threshold 차원" 설계 결정 필수** (예: org별 weeks 행 분리 vs threshold 테이블 분리 vs uwp 행에 required 고정).

2. **시스템 간 동일인**: oranke∩hrdb 16 · oranke∩olympus 6 · hrdb∩olympus 8 (이름+생일). **활동자 간은 0명** — 활동자 우선 이관이면 당장 비차단, 졸업/정지자 이관 시 계정 병합 정책 필요.

추가: 3개 시스템 모두 UserId 1~N 점유 → `legacyUserIdFor` offset 네임스페이스(이미 구조 구현·값 미확정)가 시스템 간 충돌 차단의 전제임이 실증.

## 이관 준비 상태 평가

| 기준 | 평가 |
|---|---|
| **ORANKE 단독** | **준비 최상** — weeks 백필 완료(153)·summer 정본 복원 완료·활동자 99 기준 잔존 게이트 = FLIP 정책 서면 1건. 즉시 진행 가능 수준 |
| **HRDB 단독** | **미준비** — ① weeks 백필 자체 없음(라이브=oranke 달력) ② threshold 73주 상이 → org 차원 설계 차단 ③ 자체 달력 결번으로 귀속실패 37%(백필 필요량 최대) ④ offset 미확정 ⑤ legacy 25. 활동자 146명·최고(最古) 2024-winter |
| **OLYMPUS 단독** | **미준비(소규모)** — HRDB 와 동일 구조 이슈, 데이터량은 1/5 수준(귀속실패 343행)·활동자 41명 |
| **3개 통합** | 활동자 합 **286명**(99+146+41) · 전체 3,342명 · 통합 최소 이관 시즌 = **2024-winter(2024-01-22, hrdb)**. 선결: ① org별 threshold 차원 설계(차단) ② hrdb/olympus weeks 백필 2건(B7 패턴 재사용) ③ offset 확정 ④ FLIP 정책(3시스템 공통 서면) ⑤ legacy 34 선처리 ⑥ 교차 동일인 30쌍 정책(활동자 0 — 보류 가능) |

권장 순서: ORANKE 활동자 99 선행 이관(잔존 게이트 1건) → org-threshold 설계 확정 → hrdb/olympus weeks 백필(B7 dry-run→apply 패턴) → 시스템별 1명 dry-run(1092 동급) → 활동자 146/41 → 졸업·정지자 일괄은 별도 단계.
