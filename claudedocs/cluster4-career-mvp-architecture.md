# Cluster4 실무 경력 허브 MVP 설계

## 1. 문제 정의

Cluster4 라인 개설 시스템은 info/experience/competency 3개 파트가 이미 가동 중이나, **career(실무 경력)** 파트만 아직 개설 파이프라인이 없다.

career 파트는 다른 파트와 다른 고유 특성을 갖는다:

| 차이점 | info / experience / competency | career |
|--------|-------------------------------|--------|
| 마스터 등록 | activity_types / line_masters 시드 | **운영자가 직접 프로젝트 등록** |
| 크루 사전 지정 | 개설 시점에만 | **등록 시 선발 크루 확정, 개설 시 기본 로드** |
| 단계 | 1단계 (개설) | **2단계** (등록 → 개설) |
| supervisor 메타 | 없음 | **기업명/로고/담당자명** |

이 2단계 구조를 기존 `career_projects` 마스터 + `cluster4_lines` 개설 체계 위에 MVP로 구축해야 한다.

---

## 2. 기존 career 테이블 실사 요약

### 2-1. career_projects (마스터)

```
migration: 2026-05-22_cluster4_card_base_step2_career_projects.sql
           2026-05-22_career_projects_admin_meta.sql (updated_at 추가)
```

| 컬럼 | 타입 | 비고 |
|------|------|------|
| id | uuid PK | |
| company_name | text NULL | 회사명 |
| company_logo_url | text NULL | 회사 로고 |
| job_position | text NULL | 직무 |
| project_name | text NULL | 프로젝트명 |
| project_description | text NULL | 프로젝트 설명 |
| line_code | text NULL | 라인 코드 |
| line_name | text NULL | 라인명 |
| output_links | jsonb DEFAULT '[]' | Career-Resume Front용 |
| output_images | jsonb DEFAULT '[]' | Career-Resume Front용 |
| company_homepage_links | jsonb DEFAULT '[]' | Career-Resume Front용 |
| secondary_info_deadline | timestamptz NULL | 2차 정보 마감 |
| supervisor_name | text NULL | 담당자명 |
| supervisor_position | text NULL | |
| supervisor_department | text NULL | |
| supervisor_company | text NULL | 기업명 |
| supervisor_profile_img | text NULL | |
| created_at | timestamptz | |
| updated_at | timestamptz | |

**평가**: 기본 구조는 경력 라인 마스터 역할에 적합. 단, MVP 필수 컬럼 누락 있음 (아래 §6 참조).

### 2-2. career_project_weeks (주차 junction)

```
migration: 2026-05-22_cluster4_card_base_step3_career_project_weeks.sql
PK: (project_id, week_id)
```

| 컬럼 | 타입 | 비고 |
|------|------|------|
| project_id | uuid FK → career_projects CASCADE | |
| week_id | uuid FK → weeks RESTRICT | |
| is_active | boolean DEFAULT true | |
| created_at | timestamptz | |

**평가**: 원래 목적은 "특정 프로젝트가 특정 주차에 열려 있는지" 표현. 라인 개설과는 별개 — 개설은 `cluster4_lines` + `cluster4_line_targets` 가 담당. career_project_weeks는 Career-Resume Front의 주차별 프로젝트 목록용으로 유지하되, MVP 라인 개설 흐름에서는 직접 사용하지 않는다.

### 2-3. career_records (사용자별 기록)

```
migration: 2026-05-22_cluster4_card_base_step4_career_records.sql
UNIQUE: (user_id, week_id, project_id)
```

| 컬럼 | 타입 | 비고 |
|------|------|------|
| id | uuid PK | |
| user_id | uuid FK → user_profiles CASCADE | |
| week_id | uuid FK → weeks RESTRICT | |
| project_id | uuid FK → career_projects RESTRICT | |
| enhancement_status | text NULL CHECK | 평가 상태 |
| grade | text NULL CHECK | S/A/B/C/D |
| grade_points | integer NULL CHECK ≥ 0 | |
| career_code | text NULL | |
| created_at | timestamptz | |

**"선발 크루 명단 저장용으로 사용 가능한가?" → 부적합.**

부적합 사유:
1. **week_id 필수**: career_records는 (user_id, week_id, project_id) UNIQUE. 선발 크루는 프로젝트 레벨이지 주차 레벨이 아님
2. **목적 불일치**: career_records는 평가(grade, enhancement_status) 저장용. 크루 선발과 혼재하면 "이 레코드가 선발인지 평가인지" 구분 불가
3. **week_id 부재 시 삽입 불가**: 등록 시점에 특정 주차가 정해지지 않으므로 week_id에 더미값을 넣어야 함 → 데이터 오염

### 2-4. cluster4_lines (개설된 라인)

```
migration: 2026-05-26_cluster4_line_opening_step1_tables.sql + 확장 컬럼들
```

career 관련 주요 컬럼:
- `part_type = 'career'` CHECK
- `career_project_id uuid FK → career_projects SET NULL` (bridge column)
- `line_code text NULL`
- `main_title text NOT NULL`
- `output_link_1, output_link_2 text NULL`
- `output_images jsonb DEFAULT '[]'`
- `submission_opens_at / submission_closes_at timestamptz`

**평가**: experience/competency와 동일한 구조. career_project_id FK가 이미 존재하므로 마스터 연결 준비 완료.

### 2-5. cluster4_line_targets (개설 대상)

| 컬럼 | 타입 | 비고 |
|------|------|------|
| id | uuid PK | |
| line_id | uuid FK → cluster4_lines CASCADE | |
| week_id | uuid FK → weeks CASCADE | |
| target_mode | text CHECK (user/rule) | |
| target_user_id | uuid FK → user_profiles CASCADE | user 모드 시 |
| target_rule | jsonb | rule 모드 시 |

**평가**: 그대로 사용. 개설 시 선발 크루 수만큼 `target_mode='user'` row 생성.

---

## 3. MVP 범위

### 포함

| # | 기능 | 비고 |
|---|------|------|
| 1 | 경력 라인 등록 | career_projects CRUD + 선발 크루 |
| 2 | 경력 라인 개설 | cluster4_lines + cluster4_line_targets 생성 |
| 3 | 개설 대상 크루 지정 | 등록 시 사전 선발, 개설 시 수정 가능 |
| 4 | 메인 타이틀 / Output Link / Output Image | 등록 시 선택, 개설 시 필수(합산 1~2개) |
| 5 | 라인 개설 리스트 조회 | 개설된 career 라인 목록 확인 |

### 제외

- 경력 평가/등급(grade, grade_points) 입력
- career_records 평가 관리
- supervisor 편집 고급 UI
- 엑셀 import
- career_project_weeks 관리 (기존 /admin/career-projects에서 별도 운영)

---

## 4. 경력 라인 등록 UI 설계

### 4-1. 화면 위치

```
/admin/line-opening/practical-career → Tab 1: 경력 라인 등록
```

### 4-2. 화면 구성

#### 목록 뷰 (기본)

| 항목 | 설명 |
|------|------|
| 테이블 컬럼 | line_code, line_name, supervisor_company, supervisor_name, 선발 크루 수, 등록일 |
| 검색 | line_name 또는 line_code ilike |
| 액션 | 신규 등록, 수정, 삭제 |
| 페이지네이션 | offset/limit 기반 |

#### 등록/수정 폼

**필수 입력:**

| 필드 | DB 컬럼 | 타입 | Validation |
|------|---------|------|------------|
| 클럽 주차 | career_project_weeks 연결 | 주차 선택 UI | 최소 1주차 |
| 실제 시작일 | start_date | date | NOT NULL |
| 실제 종료일 | end_date | date | NOT NULL, ≥ start_date |
| 라인명 | line_name | text | NOT BLANK |
| 라인 코드 | line_code | text | NOT BLANK, UNIQUE per org |
| 기업명 | supervisor_company | text | NOT BLANK |
| 기업 로고 | company_logo_url | text (URL) | NOT BLANK |
| 담당자명 | supervisor_name | text | NOT BLANK |
| 선발 크루 | default_target_user_ids | uuid[] | 최소 1명 |

**선택 입력:**

| 필드 | DB 컬럼 | 타입 | Validation |
|------|---------|------|------------|
| 메인 타이틀 | default_main_title | text NULL | 없으면 개설 시 line_name 사용 |
| Output Link 1 | default_output_link_1 | text NULL | URL 형식 |
| Output Link 2 | default_output_link_2 | text NULL | URL 형식 |
| Output Image | default_output_images | jsonb | Supabase Storage 업로드 |

**Output 제약 (등록 단계):**
- Link + Image 합산 최소 0개, 최대 2개
- 이미지는 업로드 방식 (POST /api/admin/cluster4/upload-image)

#### 크루 선택 UI

- 기존 `GET /api/admin/cluster4/crews` 재사용
- 체크박스 방식으로 다중 선택
- 선택된 크루 목록 표시 (이름, organization)

---

## 5. 경력 라인 개설 UI 설계

### 5-1. 화면 위치

```
/admin/line-opening/practical-career → Tab 2: 경력 라인 개설
```

### 5-2. 개설 흐름

```
┌─────────────────────────────────────────────────┐
│ Step 1: 등록된 경력 라인 선택 (드롭다운)         │
│   → career_projects 목록에서 선택                │
│   → line_code 자동 표시 (읽기 전용)              │
├─────────────────────────────────────────────────┤
│ Step 2: 개설 정보 자동 로드 + 수정               │
│   → 메인 타이틀: default_main_title ?? line_name │
│   → Output Link/Image: 등록값 기본, 수정 가능    │
│   → 크루 목록: default_target_user_ids 기본,     │
│     수정 가능 (추가/제거)                        │
├─────────────────────────────────────────────────┤
│ Step 3: 개설 주차 확인                           │
│   → 서버에서 현재 주차 자동 결정                  │
│   → 운영자 수정 불가 (읽기 전용)                 │
│   → submission window 자동 계산                  │
├─────────────────────────────────────────────────┤
│ Step 4: 저장                                     │
│   → cluster4_lines 1건 생성                      │
│   → cluster4_line_targets N건 생성               │
│   → (선택) career_project_weeks 자동 attach      │
└─────────────────────────────────────────────────┘
```

### 5-3. Output 제약 (개설 단계)

- Link + Image 합산 **최소 1개**, 최대 2개
- 등록 시 값이 있으면 기본값으로 로드
- 개설 시 수정 가능

### 5-4. 개설 완료 리스트

| 항목 | 설명 |
|------|------|
| 테이블 컬럼 | line_code, main_title, 대상 크루 수, 개설 주차, 제출 기간, is_active, 개설일 |
| 필터 | 현재 주차 / 전체 |
| 상태 | 활성(is_active=true) / 비활성 |

---

## 6. 데이터 모델

### 6-1. career_projects 추가 컬럼

기존 컬럼은 유지하고, 다음 컬럼을 추가한다:

| 컬럼 | 타입 | 기본값 | 목적 |
|------|------|--------|------|
| `start_date` | date NULL | NULL | 프로젝트 실제 시작일 |
| `end_date` | date NULL | NULL | 프로젝트 실제 종료일 |
| `default_main_title` | text NULL | NULL | 개설 시 기본 메인 타이틀 |
| `default_output_link_1` | text NULL | NULL | 개설 시 기본 Output Link 1 |
| `default_output_link_2` | text NULL | NULL | 개설 시 기본 Output Link 2 |
| `default_output_images` | jsonb | '[]' | 개설 시 기본 Output Images |
| `default_target_user_ids` | jsonb | '[]' | 선발 크루 UUID 배열 |
| `organization_slug` | text NOT NULL | 'oranke' | 조직 구분 (다른 마스터와 일관성) |

**기존 컬럼 재활용:**
- `line_code`, `line_name` → 그대로 사용
- `supervisor_company`, `supervisor_name` → 그대로 사용 (기업명, 담당자명)
- `company_logo_url` → supervisor 기업 로고로 사용

**기존 컬럼 유지 but MVP 미사용:**
- `output_links`, `output_images`, `company_homepage_links` → Career-Resume Front 전용. 개설 default와는 별개.
- `supervisor_position`, `supervisor_department`, `supervisor_profile_img` → MVP에서 입력 대상 아님, 기존 값 보존.

### 6-2. 왜 default_target_user_ids (jsonb) 인가

| 방안 | 장점 | 단점 |
|------|------|------|
| A) career_records 재활용 | 테이블 추가 없음 | week_id 필수, 목적 불일치, 평가 컬럼 오염 |
| B) career_project_members junction | FK 정합성 | 테이블 추가, MVP 오버엔지니어링 |
| **C) jsonb 배열** | **변경 최소, 패턴 일관** | FK 없음 (API 검증으로 보완) |

**채택: C안** — experience_line_masters에 crew 사전 등록이 없는 것과 달리, career만의 고유 요구사항. jsonb 배열이 MVP 최소 변경이며, 개설 API에서 실존 유저 검증으로 정합성 확보.

### 6-3. 관계도 (MVP)

```
career_projects (마스터)
  │
  ├── default_target_user_ids: jsonb     ← 선발 크루 UUID 배열 (NEW)
  ├── default_main_title: text           ← 기본 메인 타이틀 (NEW)
  ├── default_output_link_1/2: text      ← 기본 Output (NEW)
  ├── start_date / end_date: date        ← 실제 프로젝트 기간 (NEW)
  │
  │         개설 시
  │         ▼
  cluster4_lines (개설된 라인)
  │  part_type = 'career'
  │  career_project_id → career_projects.id
  │  line_code ← career_projects.line_code
  │  main_title ← default_main_title ?? line_name
  │  output_link_1/2 ← default_output_link_1/2 (수정 가능)
  │  output_images ← default_output_images (수정 가능)
  │
  └── cluster4_line_targets (대상 크루)
       line_id → cluster4_lines.id
       week_id → weeks.id (현재 주차)
       target_mode = 'user'
       target_user_id → user_profiles.user_id
```

### 6-4. cluster4_lines 기존 컬럼 활용

career 개설 시 cluster4_lines에 기록되는 값:

| cluster4_lines 컬럼 | career 개설 시 값 |
|---------------------|------------------|
| part_type | 'career' |
| career_project_id | 선택한 career_projects.id |
| line_code | career_projects.line_code (자동) |
| main_title | 개설 폼에서 입력 (기본: default_main_title ?? line_name) |
| output_link_1 | 개설 폼에서 입력 (기본: default_output_link_1) |
| output_link_2 | 개설 폼에서 입력 (기본: default_output_link_2) |
| output_images | 개설 폼에서 입력 (기본: default_output_images) |
| submission_opens_at | 서버 계산 (주차 시작) |
| submission_closes_at | 서버 계산 (수요일 22:00 KST) |
| is_active | true |
| created_by / updated_by | 현재 admin |

---

## 7. 필요한 Migration 목록

### Migration 1: career_projects 컬럼 확장

```
파일명: 2026-05-28_career_projects_career_line_defaults.sql
```

추가할 컬럼:
1. `start_date date NULL`
2. `end_date date NULL`
3. `default_main_title text NULL`
4. `default_output_link_1 text NULL`
5. `default_output_link_2 text NULL`
6. `default_output_images jsonb NOT NULL DEFAULT '[]'::jsonb`
7. `default_target_user_ids jsonb NOT NULL DEFAULT '[]'::jsonb`
8. `organization_slug text NOT NULL DEFAULT 'oranke'`

CHECK 제약:
- `end_date IS NULL OR start_date IS NULL OR end_date >= start_date`

인덱스:
- `career_projects_org_line_code_idx UNIQUE (organization_slug, line_code) WHERE line_code IS NOT NULL`

기존 데이터 영향: 모든 추가 컬럼이 NULL 또는 DEFAULT → 기존 row 무영향.

### 주의: 추가 Migration 불필요

- cluster4_lines에는 이미 `career_project_id` FK 존재
- cluster4_line_targets는 변경 없음
- 새 테이블 생성 없음

---

## 8. API 계약

### 8-1. 경력 라인 등록 API

기존 `/api/admin/career-projects` 엔드포인트를 확장한다.

#### GET /api/admin/career-projects

기존 API 그대로 사용. 추가 컬럼은 응답에 자동 포함.

| 항목 | 값 |
|------|---|
| method | GET |
| URL | `/api/admin/career-projects` |
| query params | `?limit=20&offset=0&q=검색어` |
| response | `{ rows: CareerProjectDto[], total, limit, offset }` |
| 권한 | ADMIN_READ_ROLES (owner, admin, viewer) |
| 사용 화면 | Tab 1 목록 |

CareerProjectDto 확장 필드:

```typescript
// 기존 필드에 추가
startDate: string | null;         // "2026-03-01"
endDate: string | null;           // "2026-05-31"
defaultMainTitle: string | null;
defaultOutputLink1: string | null;
defaultOutputLink2: string | null;
defaultOutputImages: string[];    // URL 배열
defaultTargetUserIds: string[];   // UUID 배열
organizationSlug: string;
```

#### POST /api/admin/career-projects

기존 API 확장. 새 필드 포함 가능.

| 항목 | 값 |
|------|---|
| method | POST |
| URL | `/api/admin/career-projects` |
| body | CareerProjectUpsertInput (확장) |
| response | `{ success: true, data: CareerProjectDto }` |
| validation | line_code + organization_slug UNIQUE |
| 권한 | CAREER_PROJECTS_WRITE_ROLES (owner) |
| 사용 화면 | Tab 1 등록 폼 |

Request body 확장:

```json
{
  "line_code": "CP-001",
  "line_name": "마케팅 전략 프로젝트",
  "start_date": "2026-03-01",
  "end_date": "2026-05-31",
  "supervisor_company": "브랙시움",
  "company_logo_url": "https://...",
  "supervisor_name": "김담당",
  "default_main_title": "브랙시움 마케팅 전략 수립",
  "default_output_link_1": "https://notion.so/...",
  "default_output_link_2": null,
  "default_output_images": ["https://storage.../img1.png"],
  "default_target_user_ids": ["uuid-1", "uuid-2", "uuid-3"],
  "organization_slug": "oranke"
}
```

#### PATCH /api/admin/career-projects/[id]

기존 API 확장. 동일 body 구조로 부분 업데이트.

| 항목 | 값 |
|------|---|
| method | PATCH |
| URL | `/api/admin/career-projects/{id}` |
| body | CareerProjectUpsertInput (부분) |
| response | `{ success: true, data: CareerProjectDto }` |
| validation | line_code 변경 시 UNIQUE 검증 |
| 권한 | CAREER_PROJECTS_WRITE_ROLES (owner) |
| 사용 화면 | Tab 1 수정 폼 |

---

### 8-2. 경력 라인 개설 API

#### GET /api/admin/cluster4/career-line-options

등록된 경력 프로젝트 중 개설 가능한 목록을 반환한다.

| 항목 | 값 |
|------|---|
| method | GET |
| URL | `/api/admin/cluster4/career-line-options` |
| query params | `?organization=oranke` (선택) |
| response | 아래 참조 |
| 권한 | ADMIN_READ_ROLES |
| 사용 화면 | Tab 2 드롭다운 |

Response:

```json
{
  "success": true,
  "data": {
    "options": [
      {
        "id": "career-project-uuid",
        "lineCode": "CP-001",
        "lineName": "마케팅 전략 프로젝트",
        "supervisorCompany": "브랙시움",
        "supervisorName": "김담당",
        "companyLogoUrl": "https://...",
        "defaultMainTitle": "브랙시움 마케팅 전략 수립",
        "defaultOutputLink1": "https://...",
        "defaultOutputLink2": null,
        "defaultOutputImages": [],
        "defaultTargetUserIds": ["uuid-1", "uuid-2"],
        "startDate": "2026-03-01",
        "endDate": "2026-05-31"
      }
    ],
    "currentWeek": {
      "weekId": "week-uuid",
      "weekNumber": 12,
      "weekStart": "2026-05-25",
      "weekEnd": "2026-05-31",
      "submissionOpensAt": "2026-05-24T15:00:00Z",
      "submissionClosesAt": "2026-05-27T13:00:00Z"
    }
  }
}
```

로직:
1. career_projects 중 line_code IS NOT NULL인 행을 조회
2. 현재 주차 정보를 `seasonCalendar`에서 계산
3. 공식 휴식 주차면 빈 options + null currentWeek 반환

#### POST /api/admin/cluster4/career-lines

경력 라인을 현재 주차에 개설한다. experience-lines/competency-lines와 동일한 복합 생성 패턴.

| 항목 | 값 |
|------|---|
| method | POST |
| URL | `/api/admin/cluster4/career-lines` |
| body | 아래 참조 |
| response | `{ success: true, data: { line, targets, targetCount } }` |
| 권한 | CLUSTER4_LINE_WRITE_ROLES (owner) |
| 사용 화면 | Tab 2 개설 폼 저장 |

Request body:

```json
{
  "career_project_id": "career-project-uuid",
  "main_title": "브랙시움 마케팅 전략 수립",
  "output_link_1": "https://notion.so/...",
  "output_link_2": null,
  "output_images": ["https://storage.../img1.png"],
  "target_user_ids": ["uuid-1", "uuid-2", "uuid-3"]
}
```

서버 로직:
1. `career_project_id`로 career_projects 조회 → line_code 추출
2. `resolveCurrentWeek()`로 현재 주차 + submission window 결정
3. 공식 휴식 주차면 400 반환
4. weeks 테이블에서 (iso_year, iso_week) → week_id 조회
5. cluster4_lines INSERT (part_type='career', career_project_id, line_code, main_title, outputs, window)
6. cluster4_line_targets bulk INSERT (target_mode='user', 크루 수만큼)
7. 성공 응답 (line + targets)

---

### 8-3. 보조 API (기존 재사용)

| API | 용도 | 상태 |
|-----|------|------|
| GET /api/admin/cluster4/crews | 크루 선택 목록 | 기존 |
| GET /api/admin/cluster4/current-week | 현재 주차 정보 | 기존 |
| POST /api/admin/cluster4/upload-image | 이미지 업로드 | 기존 |
| GET /api/admin/cluster4/users | 사용자 목록 | 기존 |

---

## 9. Validation

### 9-1. 경력 라인 등록 Validation

| 필드 | 규칙 | 에러 메시지 |
|------|------|------------|
| line_code | NOT BLANK | "라인 코드를 입력해주세요" |
| line_code | UNIQUE per org | "이미 사용 중인 라인 코드입니다" (409) |
| line_name | NOT BLANK | "라인명을 입력해주세요" |
| start_date | NOT NULL | "시작일을 입력해주세요" |
| end_date | NOT NULL, ≥ start_date | "종료일은 시작일 이후여야 합니다" |
| supervisor_company | NOT BLANK | "기업명을 입력해주세요" |
| company_logo_url | NOT BLANK | "기업 로고를 등록해주세요" |
| supervisor_name | NOT BLANK | "담당자명을 입력해주세요" |
| default_target_user_ids | 최소 1명 | "선발 크루를 최소 1명 이상 선택해주세요" |
| default_target_user_ids | 모두 유효 UUID | "유효하지 않은 사용자 ID가 포함되어 있습니다" |
| Output 합산 (등록) | 0 ≤ count ≤ 2 | "Output은 최대 2개까지 입력 가능합니다" |

### 9-2. 경력 라인 개설 Validation

| 필드 | 규칙 | 에러 메시지 |
|------|------|------------|
| career_project_id | 유효 UUID, 존재 확인 | "해당 경력 프로젝트를 찾을 수 없습니다" (404) |
| main_title | NOT BLANK | "메인 타이틀을 입력해주세요" |
| target_user_ids | 최소 1명 | "개설 대상을 최소 1명 이상 선택해주세요" |
| target_user_ids | 모두 유효 UUID | "유효하지 않은 사용자 ID" |
| Output 합산 (개설) | **1 ≤ count ≤ 2** | "Output을 최소 1개 입력해주세요" |
| 현재 주차 | 공식 휴식 아님 | "현재 주차에 라인을 개설할 수 없습니다" (400) |
| weeks row | 존재 확인 | "현재 주차 데이터를 찾을 수 없습니다" (404) |

### 9-3. 공통 정책 Validation

| 정책 | 구현 위치 |
|------|----------|
| 개설 주차 자동 지정 (수정 불가) | 서버: resolveCurrentWeek() |
| 사용자 2차 정보 마감: 수요일 22:00 KST | cluster4_lines.submission_closes_at |
| 운영자 개설 권장 마감: 월요일 22:00 KST | UI 안내문구 (시스템 제한 없음) |
| line_code 자동 불러오기 | career_projects.line_code → UI 읽기전용 |

---

## 10. 구현 우선순위

### Phase 1: DB 기반 (Migration)

| 순서 | 작업 | 영향 |
|------|------|------|
| 1-1 | career_projects 컬럼 확장 migration | DB only, 기존 기능 무영향 |
| 1-2 | adminCareerProjectsTypes.ts DTO/Input 확장 | Types only |

### Phase 2: 경력 라인 등록 (기존 API 확장)

| 순서 | 작업 | 영향 |
|------|------|------|
| 2-1 | adminCareerProjectsData.ts 확장 (새 컬럼 SELECT/INSERT/UPDATE) | Server data layer |
| 2-2 | POST/PATCH /api/admin/career-projects 확장 | API |
| 2-3 | 등록 폼 UI 컴포넌트 (Tab 1) | Frontend |

### Phase 3: 경력 라인 개설 (새 API + UI)

| 순서 | 작업 | 영향 |
|------|------|------|
| 3-1 | GET /api/admin/cluster4/career-line-options | New API |
| 3-2 | POST /api/admin/cluster4/career-lines | New API |
| 3-3 | 개설 폼 UI 컴포넌트 (Tab 2) | Frontend |

### Phase 4: 통합 + 메뉴

| 순서 | 작업 | 영향 |
|------|------|------|
| 4-1 | /admin/line-opening/practical-career 페이지 생성 | New page |
| 4-2 | adminLineOpening.ts href 업데이트 | Menu config |
| 4-3 | 개설된 라인 리스트 표시 (기존 lines API 활용) | UI |

---

## 11. 미결 사항

### 11-1. 설계 확인 필요

| # | 질문 | 영향 | 의견 |
|---|------|------|------|
| 1 | career_projects.line_code를 organization_slug 단위 UNIQUE로 할지 전역 UNIQUE로 할지 | Migration | experience/competency는 org 단위 UNIQUE. 일관성상 org 단위 추천 |
| 2 | 기존 /admin/career-projects 페이지를 유지할지, /admin/line-opening/practical-career로 완전 이전할지 | 라우팅 | 완전 이전 추천. 기존 페이지에서 redirect 처리 |
| 3 | 하나의 career_project에서 여러 주차에 반복 개설 가능한지 | 비즈니스 | cluster4_lines에 career_project_id UNIQUE 제약 없으므로 현재 가능. 의도적인지 확인 필요 |
| 4 | career_project_weeks를 개설 시 자동 attach 할지 | 연동 | Career-Resume Front와의 연동을 위해 자동 attach 추천. 단 MVP에서는 수동 운영도 가능 |
| 5 | default_target_user_ids에 저장된 UUID가 탈퇴 시 정리 정책 | 운영 | API 레벨에서 개설 시 실존 유저 검증으로 충분. 마스터의 stale UUID는 허용 (개설 시 필터링) |

### 11-2. 후속 확장 예정

| 항목 | 설명 | 시점 |
|------|------|------|
| Tab 3: 경력 기록/평가 | career_records grade/enhancement 관리 | MVP 이후 |
| supervisor 편집 고급 UI | 직위, 부서, 프로필 이미지 | MVP 이후 |
| 엑셀 import | career_projects 대량 등록 | MVP 이후 |
| career_project_members junction | default_target_user_ids → 정규화 테이블 전환 | 운영 규모 확대 시 |
| LINE_SELECT 확장 | cluster4_lines 조회에 career_project_id 포함 | Phase 3에서 필요 시 |
