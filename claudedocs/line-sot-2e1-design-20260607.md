# Phase 2E-1 — 마스터 vs line_registrations 등가성 diff 검증 + 2E 전환 설계 (2026-06-07)

> read-only 검증만 수행 — 코드/DB/SoT/API 무변경. 원시 데이터: `claudedocs/line-sot-2e1-diff-20260607.json`
> (`scripts/diag-line-sot-2e1-diff.ts` — 상시 drift 감시용으로 재실행 가능)

## 1. 기존 마스터 참조 코드 경로 (전수)

### cluster4_experience_line_masters
| 경로 | 용도 | 분류 |
|---|---|---|
| `lib/cluster4WeeklyCardsData.ts` fetchExperienceMasterMetaByIds | snapshot 생성 메타 (category/slot/lineName/org) | 교체 대상 (2E-4) |
| `lib/adminCluster4LinesData.ts` collectLineOrgAudience | 분모A org 판정 | 교체 대상 (2E-3) |
| `lib/lineAvailability.ts` ×3 (legacy unified id by line_name · slot lookup ×2) | 주차 판정/4넘버 | 교체 대상 (2E-4) |
| `lib/cluster4LinesData.ts` (고객 lines/detail category/slot) | 고객 상세 메타 | 교체 대상 (2E-4) |
| `api/cluster4/experience-lines` POST · `experience-line-masters`(+[id]) · `adminExperienceLineData` | 개설 검증·마스터 CRUD | 개설 검증=교체 대상(2E-3), CRUD=deprecated 처리(2E-6) |
| `lib/adminExperienceDraftData.ts` (drafts FK NOT NULL) | 경험 입력→검수→개설 워크플로 | **대체 불가** (스키마 결합 — drafts 개편 전까지 마스터 행 유지 필요 → 브리지 find-or-create 가 마스터 행을 공급하므로 충돌 없음) |
| `adminLineCatalogData` · `adminLineBridgeData` | 2B/2C 신규 | 유지 (통합 뷰/브리지 자체) |

### cluster4_competency_line_masters
weekly-cards 메타 · collectLineOrgAudience · competency-lines POST · 마스터 CRUD · catalog/bridge — 구조 동일 (drafts 없음).

### career_projects
admin CRUD/개설/sponsor 메타 + **고객앱(../vraxium) 직조 2곳**(`/api/career-records`, `/api/cluster-4-ranking`) — **대체 금지** (고객앱 수정 금지 + 2D 제외로 등가성 미충족).

## 2~3. 대체 가능 / 불가 경로

- **대체 가능 (diff 0 실측)**: exp/comp 의 모든 *읽기* 경로 — 개설 드롭다운 목록, 개설 검증, org 판정, weekly-cards 메타, lineAvailability slot/category, 고객 lines/detail 메타. 키 = `bridged_master_id` 역참조(56건 전수 1:1) 또는 (org, line_code).
- **대체 불가/금지**: ① 고객앱 career_projects 직조 ② exp drafts FK(스키마 결합) ③ cluster4_lines 의 master FK 컬럼 자체(인스턴스 결합 — 계속 기록) ④ career 전반(2D 제외 + manager_profile NULL 정책) ⑤ 마스터 CRUD API(교체가 아니라 쓰기 차단으로 수렴).

## 4. diff 결과 (2026-06-07 실측)

| 축 | 결과 |
|---|---|
| 개설 목록 — 경험 26건 | **diff 0** (line_name·default_main_title·category·slot·is_active·org 필드 단위) |
| 개설 목록 — 역량 30건 | **diff 0** (line_name·main_title·is_active·org) |
| 개설 목록 — career | 알려진 diff 1 (마스터 1 vs 등록 0 — 2D 의도적 제외) |
| org 판정 — 개설 라인 227건 전수(master FK 보유) | **diff 0** |
| line-history | 마스터 미참조 — 교체 무관 (구조적 diff 0) |
| weekly-cards 메타 — 실사용 exp 12·comp 3 master | **diff 0** (category/slot/lineName/org) |
| career sponsor 메타 — 사용 중 1건 | 알려진 diff (registrations 미커버) |
| 고객앱 | exp/comp 마스터 직조 0건 — 영향 없음. career_projects 직조만 존재(대체 금지) |
| demoUserId / 일반 | 동일 코드 경로 — 차이 없음 |
| snapshot | fingerprint 불변 (122/0/364/1233) — 본 검증 read-only |

**diff 원인**: 전부 career(2D 의도적 제외 + 프로필 NULL 정책). exp/comp 는 이미 등가.
**diff 0 에 필요한 작업**: ① career 실데이터 이관(또는 테스트 1건 정리 결정) ② manager_profile 이미지 자산 매핑 — 이 2건 전까지 career 는 기존 SoT 유지.

**drift 리스크(중요)**: 현재 마스터·registrations 는 이중 저장 — 운영자가 마스터를 직접 수정(PATCH 마스터 CRUD/PracticalCareerManager)하면 diff 가 다시 벌어진다. 2E-1 diff 0 은 "현 시점" 스냅 — 전환 전까지 2E-2 가드 + diff 스크립트 주기 실행 필요.

## 5. snapshot 영향

2E-1 자체 = 없음(read-only). 전환 시: 메타 lookup 입력값이 diff 0 이므로 **snapshot 산출물 불변 → recompute 불필요**가 기대값. 단 2E-4 적용 직후 카나리(테스트 유저 1명 weekly-cards DTO before/after 비교)로 실증 후 전체 적용.

## 6. 안전한 2E 하위 단계 제안

| 단계 | 내용 | 위험 | rollback |
|---|---|---|---|
| **2E-1 (완료)** | 등가성 diff 검증 | — | — |
| **2E-2** | drift 가드 — 마스터 직접 쓰기 경로를 "등록→브리지"로 유도(soft 안내 → hard 차단), diff 스크립트 주기 실행 | 낮음 (쓰기 UX 만) | UI/가드 revert |
| **2E-3** | admin 읽기 교체 1차 — 개설 검증 + `collectLineOrgAudience` org 판정을 registrations(bridged 역참조) 기준으로 교체 → 직후 diff 재실행 + stale 0 확인 | 중 (분모A) | 함수 단위 revert (DB 무변) |
| **2E-4** | snapshot 생성 메타·lineAvailability·고객 lines/detail 교체 — 카나리(1명 DTO diff 0) → 전체. diff 0 이므로 recompute 불필요 기대, 이상 시 recompute-snapshots 1회 | 중상 (고객 노출) | 함수 단위 revert + recompute 1회 |
| **2E-5** | career 등가성 확보 — 실 career 라인을 등록→브리지 경로로 생성 + 테스트 1건 처리 결정 + 프로필 자산 매핑 | 중 | career 는 기존 SoT 병행 유지라 단계 독립 |
| **2E-6** | 마스터 deprecated — 쓰기 차단 → read-mirror 안정기 → COMMENT/정리(드랍은 별도 승인) | 낮음 | 쓰기 차단 해제 |

각 단계는 코드 스위치(함수 단위) + DDL 없음(2E-6 정리 전까지) — 단계별 독립 배포/롤백 가능.

## 7. rollback 계획

- 2E-2~4: **DB 무변경** — 교체 함수 revert 만으로 완전 복귀. 마스터는 그대로 존재(브리지가 계속 행을 공급).
- snapshot: 교체 후 이상 징후 시 `recompute-snapshots` 운영 API 1회 (diff 0 전제라 기대상 불필요).
- drift 발생 시: 2E-1 diff 스크립트로 항목 식별 → 마스터 값 기준 registrations 보정 스크립트(역방향 sync, 별도 승인) — 마스터는 항상 무수정 원칙 유지.
- 2E-6 이전까지 마스터가 물리적으로 온전하므로 어느 시점에서든 "registrations 읽기 → 마스터 읽기" 즉시 복귀 가능.
