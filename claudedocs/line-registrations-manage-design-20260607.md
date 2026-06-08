# line_registrations 관리 기능 설계 (2E-6 선행, 2026-06-07 — 설계 전용)

> 구현 없음. 목표: 통합 SoT(line_registrations)에서 라인을 직접 수정/비활성화 —
> 기존 마스터 deprecated(2E-6) 전의 마지막 선행 기능.
> 전제(현 상태): 56건 전부 bridged 1:1 연결, 런타임 읽기 registrations-first 완료,
> 마스터→registration sync(2E-2/2E-5) 가동, **개설 드롭다운 목록 GET 은 아직 마스터 원천**.

## 1. 추천 UI 위치

- **/admin/lines/info 의 source=registration 행에 "수정" 버튼 → 편집 모달** (권장).
  - 근거: 라인 정보가 이미 통합 카탈로그 + "개설 연결" 액션 보유 — 관리 동선 일원화.
    별도 상세 라우트(/admin/lines/info/[id])는 모달로 부족해질 때 후속.
  - 마스터 원천 행(경험/역량 마스터 뱃지)은 read-only 유지 — 수정은 registration 행에서만.
    (주의: 카탈로그는 마스터+등록을 병렬 표시하므로 등록 행 수정 시 sync 로 마스터 행도
    함께 갱신되어 두 행이 같이 변함 — 정상 동작. 2E-6 에서 마스터 행 숨김으로 해소.)
- 비활성화 토글은 같은 모달 안(또는 행 액션) — 삭제 버튼은 두지 않음.

## 2. 수정 가능 / 금지 필드

| 필드 | 정책 | 근거 |
|---|---|---|
| 라인명 | ✅ 허용 | mirror sync 대상. 개설된 라인의 고객 노출 lineName(weekly-cards 메타)도 바뀜 — **기존 마스터 PATCH 와 동일한 운영 동작**(신규 위험 아님) |
| 라인 코드 | ⚠ **개설 라인 0건일 때만 허용** | ① cluster4_lines.line_code 는 개설 시점 스냅 — 변경 시 정의·인스턴스 불일치 ② line_code 토큰(BS/EC/OK/PX)이 org 노출 판정 보조축 ③ (hub,org,code) unique + 마스터 (org,code) unique 재검사 필요. 0건이면 안전 |
| 소속 허브 | ❌ **금지** | 허브 변경 = mirror 테이블 자체가 바뀜(exp↔comp↔career) — FK/mirror 체계 전체와 충돌. 운영 시나리오는 "비활성화 후 신규 등록" 으로 유도 |
| 라인 종류 | ✅ exp/comp 허용 — 단 **exp 는 개설 라인 0건일 때만** | exp 종류=category↔slot 고정쌍 → slot 은 lineAvailability 4넘버/3슬롯 판정 입력 — 개설 라인이 있으면 과거 판정과 어긋남. comp 는 마스터 컬럼 부재라 registration 만 갱신(임시 한계 유지) |
| 메인 타이틀 (고정/변동+값) | ✅ 허용 | mirror sync(variable→null). 개설된 라인의 main_title 은 개설 시점 스냅 — 소급되지 않음(기존 정책 그대로, 안내 문구로 명시) |
| 유닛 링크 | ✅ 허용 | registration 전용 — mirror 무관 |
| organization_slug | ⚠ **개설 라인 0건일 때만 허용** | org 는 분모A/노출 판정 SoT — 개설 라인 보유 상태에서 변경하면 audience 가 바뀌어 snapshot 재계산 필요 상황 발생. 0건이면 안전(unique 재검사). bridged 행에서 NULL 복귀 금지(마스터 org NOT NULL) |
| career 전용 6필드 | ✅ career 행만 | mirror sync(company/supervisor 5필드). manager_profile_key 는 registration 만(프로필 Phase 보류 — supervisor_profile_img NULL 정책 유지) |
| is_active | ✅ 비활성/재활성 | 아래 비활성화 정책 |
| bridged_master_id / bridged_at | ❌ 금지 (시스템 필드) | 브리지/sync 전용 |

"개설 라인 0건" 판정 = cluster4_lines 에서 `bridged_master_id` 를 해당 FK
(experience_line_master_id / competency_line_master_id / career_project_id)로 참조하는 행 수.
GET 상세 응답에 `openedLineCount` 로 노출해 UI 가 게이트 필드를 미리 잠근다.

## 3. Sync 정책 (registration → mirror, 신규 방향)

- PATCH 성공 시 `bridged_master_id` 가 있으면 **mirror 마스터를 직접 DB update** (신규
  `syncMasterFromRegistration()` — lineMasterDriftGuard 에 추가).
  - exp: line_name·default_main_title·organization_slug·line_code·is_active + line_type→category/slot 고정쌍
  - comp: line_name·main_title·organization_slug·line_code·is_active (종류는 컬럼 부재 — 제외)
  - career: line_name·default_main_title·organization_slug·line_code + company/supervisor 5필드 (profile_img 제외, is_active 컬럼 부재 — 제외)
- 미브리지 행: registration 만 갱신 (mirror 없음 — 정상).
- **양방향 동시 가동의 루프 없음**: 양쪽 sync 모두 라우트가 아닌 직접 DB write 라 재귀 불가.
  병행 기간엔 어느 쪽을 고쳐도 정합 유지(2E-2/2E-5 역방향 + 본 정방향).
- sync 실패: registration 수정은 유지 + `driftSync.warning` 표면화(기존 패턴) + diff 스크립트 탐지.
- 2C "기존 마스터 무덮어쓰기" 원칙과의 관계: 그 원칙은 **브리지(find 시)** 한정 — 운영자의
  명시적 수정은 mirror 에 전파되는 것이 mirror 의 정의(이번에 의도적으로 확장).

## 4. 비활성화 정책

- **soft-only** (DELETE API 미제공, 행 영구 보존).
- is_active=false 효과: ① 개설 검증 404(2E-3 에서 이미 registrations is_active 판정)
  ② mirror is_active=false sync → 기존 개설 드롭다운(마스터 GET 원천)에서도 동일하게 제외 —
  마스터 PATCH is_active=false 와 완전 등가 ③ 라인 정보 "비활성" 뱃지(이미 표시) + 개설 연결 버튼 비활성.
- **기존 개설 라인 무영향 보장**: cluster4_lines.is_active 는 독립 컬럼 — 본 기능은 절대 건드리지
  않음. 고객 노출·snapshot·제출/평가 전부 불변(검증 항목으로 명문화).
- career: mirror 에 is_active 가 없어 registration 비활성만으로 개설 검증·개설 연결이 차단됨
  (career-line-options 노출은 잔존 — 2E-6 에서 목록 교체 시 해소, 설계 노트).

## 5. API 설계

| API | 내용 |
|---|---|
| `GET /api/admin/lines/registrations/[id]` (신규) | 단건 상세 + `openedLineCount` + bridged 정보 — 편집 모달 프리필/게이트용 |
| `PATCH /api/admin/lines/registrations/[id]` (신규) | partial update. 검증: 허브별 line_type enum · org enum · (hub,org,code) unique 사전 검사 · **게이트 필드(line_code/org/exp 종류)는 openedLineCount=0 일 때만** · hub/bridged_* 거부. 성공 시 mirror sync → `driftSync` 응답. career 필드 변경 + 개설 라인 보유 시 sponsor-meta 와 동일한 markStale+recompute 재사용(0건이면 no-op) |
| DELETE | 미제공 — 비활성화로 대체 |

기존 POST/GET(list)/bridge 무변. 파서는 `parseLineRegistrationPatchBody` 를
adminLineRegistrationsTypes 에 추가(기존 create 파서 패턴).

## 6. DB 변경 필요 여부 — **불필요**

모든 대상 필드·updated_at 트리거·partial unique 가 이미 존재. DDL 0건.

## 7. snapshot / demoUserId 영향

- 게이트 설계로 snapshot 입력 변동 경로를 차단: org·exp slot 변경은 개설 0건 행에서만 가능
  → audience/판정 불변. 라인명/타이틀 수정은 기존 마스터 PATCH 와 동일 semantics
  (snapshot 저장값은 다음 재계산 때 반영 — 현행과 등가, 신규 invalidate 없음).
- career 필드 수정 + 개설 라인 보유 시에만 기존 sponsor-meta 의 stale+recompute 경로 재사용 — 기존 동작 등가.
- 조회 로직(readWeeklyCardsSnapshot)·고객앱 무수정. demoUserId/일반 = 공통 경로라 차이 없음.

## 8. 2E-6 진행 전 필수 조건 체크리스트

1. **본 관리 기능 구현·검증** (PATCH+비활성, diff 0 유지 게이트 — diff 스크립트 회귀 필수)
2. **개설 드롭다운 목록 GET 교체** — 현재 exp/comp 마스터 GET·career-line-options 가 마스터/mirror
   원천. mirror sync 덕에 등가가 유지되므로 2E-6 본체에서 registrations 기준으로 교체
3. **drafts 플로우 방침** — 마스터 FK NOT NULL 결합: 2E-6 에서도 마스터 행은 (read-mirror 로) 존치하므로 충돌 없음을 명시
4. diff 스크립트 정기 실행 0 확인 (관리 기능 배포 후 1회 포함)
5. career mirror 자동 생성(브리지) 경로 유지 확인

구현 승인 시 작업 범위: 파서+GET/PATCH 라우트+`syncMasterFromRegistration`+카탈로그 편집 모달 — 검증은 기존 12항목 패턴(직접/HTTP/카나리/브라우저/diff/snapshot).
