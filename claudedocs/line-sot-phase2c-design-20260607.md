# Phase 2C 설계 — registrations → 기존 개설 플로우 브리지 (2026-06-07)

> **설계 + SQL preview 전용 — 구현/SQL 실행/DB 변경 없음.**
> 전제: Phase 2A 조사(`line-sot-phase2-survey-20260607.json`) · 2B 통합 조회 완료.
> 원칙: 기존 개설 플로우·snapshot·고객앱 무수정. 브리지는 "registrations → 허브별 마스터
> find-or-create → 기존 개설 POST 그대로" 방식으로 기존 FK/판정 경로를 100% 보존한다.

---

## 1. organization_slug 컬럼 설계

### 왜 필요한가
- 강화율 분모A org 판정(`collectLineOrgAudience`)과 고객 weekly-cards Step1/2 노출 필터의
  **org SoT 가 허브 마스터의 `organization_slug`** 다 (line_code 토큰은 보조).
- 브리지가 마스터를 find-or-create 하려면 마스터의 복합 unique 키
  **`UNIQUE (organization_slug, line_code)`** (경험 `2026-05-28_experience_line_masters_org_slug.sql`,
  역량 `2026-05-28_cluster4_competency_line_masters.sql` — DDL 실측 확인)에 맞는 org 값이 필수.
- org 없이 마스터를 만들면 판정 불가 → **fail-closed(라인 비노출·분모 누락)** — Phase 2A 위험 1번.

### 허용값
`'encre' | 'oranke' | 'phalanx' | 'common'`
- 기존 `lib/organizations.ts` ORGANIZATIONS 3종 + **`common`**.
- `common` 포함 근거: 마스터 운영 데이터 실측 — EXBS-UN0000([통합])의 organization_slug='common',
  BS 코드 = 조직 무관 공통 정책(weekly-cards Step2 'common' = 전원 노출).

### nullable 제안: **NULL 허용**
- 기존 등록 행·org 미정 등록을 깨지 않는 additive 원칙 유지 (NOT NULL 강제 시 기존 행 임의 백필 필요).
- 대신 **브리지(개설 연결) 게이트는 API 레이어에서 org NOT NULL 행만 허용** —
  "org 미지정 등록분은 개설 브리지 불가, 등록 화면에서 org 지정 후 가능" 정책.
- 등록 폼(2C 구현 시)에 "소속 조직" 드롭다운 추가: `- / 공통(common) / Encre / Oranke / Phalanx`.

### 기존 등록 데이터(검증 더미 13건+) 처리
- 전수 검증 더미(`검증 */UL검증 */브라우저 *` — 실 운영 등록 0건)이므로 **2C 적용 전 일괄 삭제 권장**.
  절차: dry-run 스크립트로 id 목록 확정 → 보고 → 삭제(스크립트, rollback 로그 보존).
- 대안(보수적): 삭제하지 않고 org=NULL 로 잔존 — partial unique index(아래) 덕분에 충돌 없음,
  브리지 게이트에서 자동 배제. 단 라인 정보 화면에 더미가 계속 노출되므로 권장하지 않음.

## 2. SQL preview (미실행 — 적용은 별도 승인 후)

```sql
-- 2026-06-08_line_registrations_org_slug.sql  (PREVIEW — 실행 금지 상태)
-- Phase 2C 선행: 소속 조직 컬럼 + 브리지 추적 컬럼 + 중복 방지 인덱스. 전부 additive.

-- 1) 소속 조직 (NULL = 미지정 → 브리지 불가, API 게이트)
ALTER TABLE public.line_registrations
  ADD COLUMN IF NOT EXISTS organization_slug text NULL;

DO $$ BEGIN
  ALTER TABLE public.line_registrations
    ADD CONSTRAINT line_registrations_org_chk
    CHECK (organization_slug IS NULL
           OR organization_slug IN ('encre','oranke','phalanx','common'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 2) 중복 방지 — hub+org+code 복합 unique (org 지정 행만; NULL 행은 제외 = 기존 더미 무충돌)
CREATE UNIQUE INDEX IF NOT EXISTS uq_line_registrations_hub_org_code
  ON public.line_registrations (hub, organization_slug, line_code)
  WHERE organization_slug IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_line_registrations_org
  ON public.line_registrations (organization_slug);

-- 3) 브리지 추적 (rollback·중복 브리지 방지용 — 마스터/기존 테이블에는 아무것도 추가하지 않음)
ALTER TABLE public.line_registrations
  ADD COLUMN IF NOT EXISTS bridged_master_id uuid NULL,      -- 생성/매칭된 마스터(또는 career_projects) id
  ADD COLUMN IF NOT EXISTS bridged_at timestamptz NULL;

COMMENT ON COLUMN public.line_registrations.organization_slug IS
  '소속 조직 (encre/oranke/phalanx/common). NULL=미지정 — 개설 브리지 불가(API 게이트). 마스터 UNIQUE(org,line_code) 정합용.';
COMMENT ON COLUMN public.line_registrations.bridged_master_id IS
  '브리지로 find-or-create 된 허브 마스터(career 는 career_projects) id. NULL=미브리지.';
```

```sql
-- (별도 파일) 검증 더미 정리 PREVIEW — 실제 적용은 dry-run 스크립트로 id 확정 후
-- DELETE FROM public.line_registrations
--  WHERE line_name ~ '^(검증|UL검증|브라우저)';   -- 2026-06-07 기준 전수 더미
```

## 3. 브리지 설계표 (registrations → 기존 SoT)

| 허브 | find 키 | 없으면 create (registrations → 마스터 컬럼 매핑) | 이후 |
|---|---|---|---|
| **실무 경험** | `cluster4_experience_line_masters (organization_slug, line_code)` | line_code·line_name 그대로, `default_main_title` ← mainTitleMode=fixed ? main_title : NULL(변동), `organization_slug` ← org, `experience_category` ← line_type 한글→영문 역매핑, `experience_slot_order` ← **CHECK 고정쌍 자동 파생** (도출1·분석2·평가3·확장4·관리5 — `cluster4_exp_masters_cat_slot_pair_chk` DDL 실측), is_active=true | 기존 `POST experience-lines`(master id 검증) 또는 drafts 플로우 그대로 |
| **실무 역량** | `cluster4_competency_line_masters (organization_slug, line_code)` | line_code·line_name·`main_title`(fixed 값/변동 NULL)·organization_slug. **라인 종류(원리/기술/관점/자원)는 마스터에 컬럼이 없어 저장 불가** — registrations 에만 보존(2E 전환 시 합류) | 기존 `POST competency-lines` 그대로 |
| **실무 경력** | `career_projects (organization_slug, line_code)` — unique 제약 없음 → 브리지 코드에서 조회 후 분기(동률 시 최신 1건) | line_code·line_name·`default_main_title`, `company_name` ← partner_company, `company_logo_url` ← company_logo_url, `supervisor_name/position/department` ← manager_name/position/job, `supervisor_profile_img` ← manager_profile_key 의 public 이미지 경로 매핑(LINE_REGISTRATION_PROFILE_IMAGE_MAP — 절대 URL 변환) 또는 NULL, organization_slug, `default_target_user_ids=[]` | 기존 career 등록 탭/개설 플로우(career-line-options 드롭다운에 자동 노출 → `POST career-lines`) 그대로 |
| **실무 정보** | 마스터 없음 — find/create 대상 없음 | **생성 없음.** 개설 화면(PracticalInfoManager)에서 registration 선택 시 main_title(고정)·line_code 를 **프리필만** 하고, 활동 유형(activity_type) 선택과 N-1 주차 강제는 기존 `POST info-lines` 로직 그대로 | cluster4_lines 직접 생성(기존과 동일) |

공통: 브리지 성공 시 `line_registrations.bridged_master_id/bridged_at` 기록(재브리지 시 find 단계에서 자연 멱등). **마스터·cluster4_lines·snapshot 코드에는 신규 컬럼/변경 없음.**

## 4. 기존 cluster4_lines FK 보존 방식

| FK | 보존 방법 |
|---|---|
| `experience_line_master_id` | 브리지가 마스터 행을 먼저 확보 → 기존 POST experience-lines 가 그 id 로 기존 로직 그대로 기록 |
| `competency_line_master_id` | 동일 (POST competency-lines) |
| `career_project_id` | 동일 (POST career-lines — career_projects 행 확보 후) |
| `activity_type_id` (info) | 브리지가 생성하지 않음 — 기존 UI 의 활동 유형 선택 그대로 |

→ `collectLineOrgAudience`(마스터 organization_slug lookup), weekly-cards 마스터/career 메타 lookup,
career sponsor-card 모두 **기존 FK 체인을 그대로 타므로 판정·표시 불변**. 개설된 라인은
기존 개설과 구별 불가능한 동일 데이터 형태가 된다(브리지 흔적은 registrations 쪽에만).

## 5. 중복 방지

- registrations 자체 키: **`UNIQUE (hub, organization_slug, line_code)` (partial — org NOT NULL 행만)** 권장.
  - `(line_code, org)` 만으로 부족한 이유: line_code 가 자유 입력이라 허브 간 동일 코드 입력 가능 —
    hub 포함이 안전. 마스터 측 충돌 검사는 어차피 허브별 테이블이 분리돼 있어 (org, code) 로 수행.
  - partial 인덱스 이유: Postgres unique 는 NULL 을 중복 허용하지만 명시적으로 org 미지정 행을
    제외해 기존 더미(전부 org NULL 백필)와의 충돌 가능성을 0 으로 만든다.
- 기존 더미 13건+ 충돌: 실측 — registrations 내 code 중복 0, 마스터/career/lines 와 교차 0.
  컬럼 추가 시 전부 org=NULL → partial index 비대상 → **충돌 없음** (삭제 전제가 아니어도 안전).
- 브리지 시점 추가 검사(코드 레이어): 동일 (org, line_code) 마스터가 이미 있으면 find 로 연결만 하고
  마스터 필드를 **덮어쓰지 않는다** (기존 마스터 수정 금지 원칙).

## 6. snapshot 영향

| 축 | 판정 |
|---|---|
| 생성/조회 코드 | **무변경** — 브리지는 마스터 insert + 기존 개설 POST 호출뿐. targets inner-join 구조 그대로 |
| 신규 라인 개설 시 | 기존 개설과 동일한 무효화 경로(타깃 생성 → 기존 invalidate)가 그대로 동작 — 별도 처리 불필요 |
| recompute 필요 조건 | **없음** (자동). 유일한 예외 = 운영자가 org 를 잘못 지정해 개설 후 마스터 org 를 수정하는 경우 — 기존에도 동일한 운영 시나리오이며 기존 마스터 PATCH 경로의 invalidate 정책을 따른다 |
| 데이터 리스크 | 마스터 자동 생성이므로 org 오입력이 분모A audience 오산정으로 직결 — 등록/브리지 양쪽에서 CHECK + enum 검증으로 차단 |

## 7. rollback 가능성

1. **SQL(컬럼/인덱스)**: additive — 코드만 롤백해도 무해(컬럼 잔존 OK). 완전 제거 시
   `DROP INDEX uq_…; ALTER TABLE … DROP COLUMN organization_slug, bridged_master_id, bridged_at;` (역순 1파일).
2. **브리지로 생성된 마스터 행**: `bridged_master_id` 가 registrations 에 기록되므로 전수 식별 가능.
   - 그 마스터로 개설된 cluster4_lines 가 **없으면**: 마스터 행 삭제 가능.
   - 개설이 이미 있으면: 마스터 삭제 대신 `is_active=false` (기존 비활성 정책) — 개설된 라인은
     기존 라인 삭제 플로우(DELETE /api/admin/cluster4/lines/[id], 타깃·snapshot 무효화 내장)로 정리.
3. **UI**: 개설 드롭다운의 registration 항목 제거(컴포넌트 1곳) — 기존 마스터 직접 선택 경로는
   2C 에서도 병행 유지되므로 운영 공백 없음.

## 8. 구현 전 반드시 정해야 할 사항 (결정 요청)

1. **검증 더미 처리**: 삭제(권장) vs org=NULL 잔존.
2. **common 허용 여부 확정**: 등록 폼 org 드롭다운에 '공통(common)' 노출 여부 (마스터 실데이터에 존재 — 포함 권장).
3. **역량 라인 종류 유실 허용**: 2C 동안 마스터에 종류 미저장(컬럼 부재) — registrations 보존으로 충분한지.
4. **career 프로필 이미지**: manager_profile_key 토큰 → public 이미지 경로 변환 저장 vs NULL 저장.
5. **info 브리지 수준**: 프리필 전용(권장, 테이블 무변) vs registrations 에 activity_type_id 컬럼 추가.
6. **bridged_* 추적 컬럼 채택 여부**: rollback 정밀도를 위해 권장 (미채택 시 생성 마스터 식별이 시간 기반 추정으로 약화).
