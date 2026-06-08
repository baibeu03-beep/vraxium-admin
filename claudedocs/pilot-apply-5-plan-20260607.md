# 5명 Pilot Apply 계획 (2026-06-07 — preview only · write 0 · **v2 교체 확정**)

> 상태: **계획 문서 — apply 미실행.** 모든 수치는 per-user dry-run 산출물 기준
> (`dryrun-pms-{1092,hrdb-1463,olympus-249,olympus-248,olympus-251}-20260607.json`).
> 계약: B안 composite key · PMS 인정 우선(FLIP=checks_migrated:false) · 3중 키 매칭 ·
> org_week_thresholds 해석 · ORANKE 916/873 제외 · **운영진=활동행 보유자만(8명 제외 — 276명)**.
> v1→v2: 이유나(hrdb 1348)·선우은교(olympus 180)는 활동행 0 운영진으로 판명 — 이관 대상
> 자체에서 제외(정책 2026-06-07 확정), pilot 은 olympus 249·251 로 교체.

## 1. 5명 선정 근거 — 요구 케이스 전수 커버 (v2)

| # | 사용자 | 케이스 커버 |
|---|---|---|
| P1 | **oranke 1092 장승완** | 신규 생성 + **FLIP 보유(2주)** + oranke org행 threshold |
| P2 | **hrdb 1463 안은비** | 신규 생성 + **threshold 조직 분리**(encre org행 42주) |
| P3 | **olympus 249 성채윤** | **기존 브리지 매칭 2호** — 3중 키 완전 일치(birth+phone+email)·legacy 249 유지·source 최초 기록·uws 기간 분리·snapshot 5→19 재계산 |
| P4 | **olympus 248 박시은** | **기존 브리지 매칭 1호** + **uws 상태충돌 1건**(건별 run log 검증) + snapshot 재계산 |
| P5 | **olympus 251 정혜빈** | 신규 생성(일반 W28·실활동 풍부) + phalanx threshold |

미커버 케이스(의도): synthetic legacy(1억)→원본 재기록 매칭은 이유나가 유일했으나 활동행 0
운영진 제외 정책으로 대상 이탈 — 해당 코드 경로는 후속 매칭 사용자 발생 시 검증.

## 2. 사용자별 예상 write 수 (dry-run 실측 · v2)

| write 대상 | P1 장승완 | P2 안은비 | P3 성채윤 | P4 박시은 | P5 정혜빈 | 합계 |
|---|---|---|---|---|---|---|
| users | insert 1 | insert 1 | **update 1** (source='olympus' 최초 기록 — legacy 249 유지) | **update 1** (동일 — legacy 248 유지) | insert 1 | 5 |
| user_profiles | insert 1 | insert 1 | **0** (기존 보존·diff 리포트) | **0** | insert 1 | 3 |
| user_memberships/educations | insert ~2 | insert ~2 | 0 | 0 | insert ~2 | ~6 |
| user_week_statuses | insert 28 | insert 42 | insert 16 + 덮어쓰기 3 (충돌 0) | insert 16 + 덮어쓰기 3 (**상태충돌 1 — 건별 run log**) | insert 29 | **131 insert + 6 덮어쓰기** |
| user_weekly_points | insert 48 + sentinel 1 | insert 51 + 1 | insert 31 + 덮어쓰기 4 + 1 | insert 24 + 덮어쓰기 4 + 1 | insert 40 + 1 | **194 insert + 8 덮어쓰기 + sentinel 5** |
| └ checks_migrated=false (FLIP) | **2행** | 0 | 0 | 0 | 0 | 2 |
| legacy_point_ledger | 510 | 982 | 448 | 408 | 695 | **3,043** |
| 실무 경험 (targets/submissions/evaluations) | 28/28/28 | 42/42/42 | 19/19/19 | 19/19/19 | 29/29/29 | **137×3** |
| adjustment sentinel (1900-W0) | Star+12/D20 | +8/D19 | +6/D14 | −14/D5 | −4/D17 | 5행 |
| snapshot | 신규 1 | 신규 1 | **재계산 1** (5→19) | **재계산 1** (5→19) | 신규 1 | 5 |

미귀속 hold: P1 6·P2 7·P3 4·P4 0·P5 4행 → adjustment 흡수 + run log 보존.
P3·P4 direct/HTTP 현재 deepEqual=false 는 기존 자연 stale(snapshot 06-05 계산본의
checkGate.required 구값 — B7 이전) — apply 의 snapshot 재계산이 해소.

## 3. rollback 시 삭제/복구 대상 (run log prior 기반 — B7 패턴)

역순 실행:
1. **cluster4 경험 행** — (source_pk=ActivityId 멱등키) 신규 89×3행 삭제
2. **uws** — 신규 86행 삭제 + P4 덮어쓰기 3행 prior 복원
3. **uwp** — sentinel 5행 삭제 + 신규 141행 삭제 + P4 덮어쓰기 4행 prior 복원 (checks_migrated 포함)
4. **legacy_point_ledger** — (source_table, source_pk) 기준 1,925행 삭제 (read-only 아카이브 — 소비처 없음)
5. **users** — P1/P2/P5 신규 행 삭제(+profiles/memberships/educations 연쇄), P3/P4 는 source_system NULL·(P3) legacy 1억 복원 — **불변 트리거가 막으므로 관리 SQL 경유** (run log 에 prior 명기)
6. **recalcUserGrowthStats + snapshot 재계산** → 이관 전 fingerprint diff=0 확인 (P3·P4 기존 snapshot prior 보존)

rollback 가능 시한 제약 없음 (5명 단계는 전부 신규/최초 기록 — 복합키 중복 미발생).

## 4. apply 직후 검증 순서 (지정 순서 준수)

1. **direct function** — 5명 전원 `getCluster4WeeklyCardsForProfileUser` 호출: 카드 수(P1 28·P2 42·P3 4 유지·P4 19·P5 0+) · FLIP 주차 checkGate(enforced=false) · sentinel(1900-W0) 카드 미생성 확인
2. **HTTP API** — `/api/cluster4/weekly-cards?userId=` (internal-key) 5명 응답
3. **direct == HTTP** — canonical(키 정렬) deep-equal 5/5 (snapshot JSONB 키 순서 함정 방지)
4. **snapshot 영향** — 5명 외 전원 snapshot fingerprint 전후 불변 (oranke 테스터 30·encre/phalanx 테스터 60·기존 실사용자)
5. **snapshot 재계산 필요 여부** — 5명: 파이프라인 7단계가 즉시 재계산(신규 3 생성·기존 2 재계산). **그 외 0명** — uws/uwp 쓰기가 5명에 한정되므로 광역 재계산 불요
6. **브라우저** — admin /crews 5명 카드·front 데모 불가(실사용자)이므로 admin 화면 렌더 + (P4) crews 상세에서 legacy 메타(olympus graft) 유지 확인 — 스크린샷 보존

추가 보고 항목:
- **snapshot-only 구조**: 유지 — 조회 API 무변경, 쓰기는 파이프라인 7단계의 명시 재계산만
- **demoUserId 경로**: 영향 0 — 게이트가 테스터 전용(5명 전원 실사용자라 demo 비대상), 코드 경로는 조회 대상 override뿐(기존 실증)
- **기존 실사용자 영향**: 5명 외 0 — 대상 한정 write + 비대상 fingerprint 검증(4번)으로 증명. 테스터 90명 무접촉

## 검증 중 발견·수정된 파이프라인 버그 1건 (apply 전 수정 완료)
per-user 매칭의 3중 키 비교가 `null==null`·`""==""`를 일치로 처리 — 생일/연락처 누락 후보가
strong 에 끼어 이유나(후보 2)의 단일 매칭을 모호로 오판. **양쪽 값 존재 시에만 일치**로 수정
(전화는 뒤 8자리 비교로 배치 스크립트와 통일). 수정 후 이유나 phone 키 단일 매칭 확정.

## 실행 전제 (이미 충족)
- DDL(composite)·코드 6파일·이관 파이프라인 B안 전환·284명 dry-run 차단 0
- apply 스크립트는 본 계획 승인 후 작성 (run log·prior 기록·fail-closed drift 교차검증 — B7 패턴)
