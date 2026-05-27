# Cluster4 라인 개설 필드 계약서

> **작성일**: 2026-05-27
> **상태**: 설계 보완 — 구현 착수 전 최종 계약
> **선행 문서**: `cluster4-line-final-architecture.md`, `cluster4-admin-line-ui-spec.md`
> **변경 범위**: 코드/SQL/UI 수정 없음. 설계 보완 전용.

---

## 1. 용어 재정의

기존 설계 문서에서 "활동 유형 선택(activity_type 선택)"이라는 표현이 쓰였으나,
운영 관점에서는 **"라인 선택"**이 정확한 용어이다.

| 기존 표현 | 재정의 | 비고 |
|---|---|---|
| 활동 유형 선택 | **라인 선택** | 4허브 공통. UI 라벨도 "라인" 통일 |
| activity_type_id | 내부 식별자 (line_code 해석 키) | DB/API에서는 유지하되 UI에는 노출하지 않음 |
| line_code | 라인 코드 (라인 선택 시 자동 불러오기) | 운영자가 직접 입력하지 않음 |

**원칙**: 운영자는 "라인을 선택"하고, line_code는 시스템이 자동으로 해석한다.

---

## 2. 4허브 공통 정책

### 2-1. line_code 필수

4개 허브 모두 `line_code`가 필요하다.

- 운영자가 직접 입력하지 않음
- **라인 선택 시 자동으로 불러오는 구조**
- 저장 위치: `cluster4_lines.line_code` (신규 컬럼)
- 데이터 소스: 허브별 상이 (아래 §4에서 상세)

### 2-2. 개설 주차 자동 지정

- 시스템이 현재 개설 가능한 주차를 자동 결정
- **운영자는 주차를 수정할 수 없음**
- `weeks` 테이블에서 `start_date <= today <= end_date`인 행 기준
- 공식 휴식 주차(`is_official_rest = true`)는 개설 불가

### 2-3. 운영자 라인 개설 권장 마감

- **월요일 오후 10:00 (KST)** 권장
- 시스템상 제한은 걸지 않음
- **UI에는 안내 문구로만 표시**:
  > "라인 개설 권장 마감: 월요일 22:00"

### 2-4. 사용자 2차 정보 입력 마감

- **수요일 오후 10:00 (KST)**
- 이 시간 이후에는 **시스템상 입력/수정을 제한**
- `submission_closes_at = 해당 주차 수요일 22:00:00 Asia/Seoul`
- API에서 시간 검증 후 거부 (HTTP 403 또는 422)

### 2-5. 강화 성공/실패 판정 기준

기존 설계에서는 "제출 여부"가 기준이었으나, 명시적으로 재정의한다:

| 조건 | 판정 |
|---|---|
| 라인 결과 **제출자** | **강화 성공** |
| 라인 결과 **미제출자** | **강화 실패** |
| 2차 정보 미입력 + 제출 완료 | **강화 성공** (2차 정보는 판정 기준이 아님) |

판정 근거:

```
cluster4_line_submissions 존재 → 강화 성공
cluster4_line_submissions 미존재 + 기간 만료 → 강화 실패
cluster4_line_submissions 미존재 + 기간 내 → 미제출 (아직 판정 전)
```

### 2-6. Output Asset 정책

| 항목 | 규칙 |
|---|---|
| 합산 최소 | 1개 |
| 합산 최대 | 2개 |
| 이미지 입력 방식 | **업로드** (URL 직접 입력이 아님) |
| 링크 입력 방식 | URL 텍스트 입력 |

DB 구조:

```
output_link_1   text NULL       ← 링크 슬롯 1
output_link_2   text NULL       ← 링크 슬롯 2
output_images   jsonb DEFAULT '[]'  ← 업로드된 이미지 URL 배열
```

Validation:

```
link_count  = (output_link_1 ? 1 : 0) + (output_link_2 ? 1 : 0)
image_count = length(output_images)

link_count + image_count >= 1   // 필수
link_count + image_count <= 2   // 상한
```

이미지 업로드 플로우:

```
1. 운영자가 이미지 파일 선택 (드래그앤드롭 또는 파일 선택)
2. 클라이언트가 Supabase Storage (또는 지정 버킷)에 업로드
3. 업로드 완료 후 반환된 public URL을 output_images 배열에 추가
4. 라인 저장 시 output_images: ["https://.../img1.png"] 형태로 전송
```

---

## 3. 허브별 수동 입력 / 자동 불러오기 항목

### 3-1. 실무 정보 (info)

| 항목 | 입력 방식 | 소스 | 매핑 컬럼 |
|---|---|---|---|
| 라인 선택 | 드롭다운 (9개 info 라인) | `activity_types WHERE cluster_id='practical_info'` | `cluster4_lines.activity_type_id` |
| line_code | **자동 불러오기** | `activity_types.line_code` → 라인 선택 시 resolve | `cluster4_lines.line_code` |
| 메인 타이틀 | **주관식 입력** | 운영자 직접 입력 | `cluster4_lines.main_title` |
| 개설 대상 크루 | 체크박스 멀티 선택 | 조직 크루원 목록 | `cluster4_line_targets.target_user_id` |
| Output Link | URL 텍스트 | 운영자 직접 입력 | `output_link_1`, `output_link_2` |
| Output Image | **파일 업로드** | 운영자 업로드 | `output_images` |
| 개설 주차 | 자동 | 시스템 현재 주차 | `cluster4_line_targets.week_id` |
| 제출 기간 | 자동 | 시스템 계산 | `submission_opens_at`, `submission_closes_at` |

### 3-2. 실무 경험 (experience)

| 항목 | 입력 방식 | 소스 | 매핑 컬럼 |
|---|---|---|---|
| 팀 선택 | 드롭다운 | `teams` 테이블 | `cluster4_lines.team_id` |
| 라인 선택 | 드롭다운 (experience 라인) | `activity_types WHERE cluster_id='practical_experience'` | `cluster4_lines.activity_type_id` |
| line_code | **자동 불러오기** | `activity_types.line_code` → 라인 선택 시 resolve | `cluster4_lines.line_code` |
| 메인 타이틀 | **자동 불러오기** (수정 가능) | `activity_types.name` → 라인 선택 시 prefill | `cluster4_lines.main_title` |
| 개설 대상 크루 | 체크박스 멀티 선택 | 조직 크루원 목록 | `cluster4_line_targets.target_user_id` |
| Output Link | URL 텍스트 | 운영자 직접 입력 | `output_link_1`, `output_link_2` |
| Output Image | **파일 업로드** | 운영자 업로드 | `output_images` |
| 평점 | 사용자가 프론트에서 입력 (2차 정보) | `user_activity_details.rating` | — |

**주의**: "activity_type 선택"이 아니라 **"라인 선택"**으로 표기.
내부적으로는 activity_types 테이블의 행을 선택하는 동작이지만,
UI 라벨과 운영 가이드에서는 "라인"으로 통일한다.

**평점 → 포인트 환산**: §6에서 별도 설계.

### 3-3. 실무 역량 (competency)

| 항목 | 입력 방식 | 소스 | 매핑 컬럼 |
|---|---|---|---|
| 라인 선택 | 드롭다운 (competency 라인) | `activity_types WHERE cluster_id='practical_competency'` | `cluster4_lines.activity_type_id` |
| line_code | **자동 불러오기** | `activity_types.line_code` → 라인 선택 시 resolve | `cluster4_lines.line_code` |
| 메인 타이틀 | **자동 불러오기** (수정 가능) | `activity_types.name` → 라인 선택 시 prefill | `cluster4_lines.main_title` |
| 개설 대상 크루 | **수동 선택** (Phase 1) | 조직 크루원 목록 | `cluster4_line_targets.target_user_id` |
| Output Link/Image | **전체 대상자 공통** | 운영자 입력/업로드 | `output_link_1`, `output_link_2`, `output_images` |

특수 사항:

- **카페 링크 집계를 통한 사용자 추출**이 최종 목표 (Phase 2)
- Phase 1에서는 수동 대상자 선택 우선
- **사용자별 라인이 다를 수 있음**: 사용자 A는 comp-1, 사용자 B는 comp-2
  - 운영자가 같은 주차에 여러 라인을 각각 개설하고, 각 라인에 해당 사용자를 배정
- Output Link/Image는 **해당 라인의 모든 대상자에게 공통 적용**

### 3-4. 실무 경력 (career) — 등록/개설 분리

실무 경력은 **"경력 라인 등록"**과 **"경력 라인 개설"**을 UI와 개념적으로 분리한다.

#### 등록 (Registration) — career_projects 관리

| 항목 | 입력 방식 | 필수 | 매핑 컬럼 |
|---|---|---|---|
| 기간 | 시작/종료일 선택 | 필수 | `career_projects` 확장 필요 (§10 참조) |
| 라인명 | 주관식 텍스트 | 필수 | `career_projects.line_name` |
| line_code | 주관식 텍스트 또는 규칙 기반 생성 | 필수 | `career_projects.line_code` |
| supervisor 정보 | 이름/직위/부서/회사/프로필 | 선택 | `career_projects.supervisor_*` |
| 프로젝트 선발 크루 명단 | 크루원 멀티 선택 | 필수 | `career_records` 행 생성 |
| 메인 타이틀 | 주관식 텍스트 | **선택** | `career_projects.project_name` (재활용) |
| Output Link/Image | URL/업로드 | **선택** | `career_projects.output_links`, `career_projects.output_images` |

#### 개설 (Opening) — cluster4_lines 생성

| 항목 | 입력 방식 | 소스 | 매핑 컬럼 |
|---|---|---|---|
| 기존 등록 라인 선택 | 드롭다운 | `career_projects` 목록 | `cluster4_lines.career_project_id` |
| line_code | **자동 불러오기** | `career_projects.line_code` → 라인 선택 시 resolve | `cluster4_lines.line_code` |
| 메인 타이틀 | **자동 불러오기** (수정 가능) | `career_projects.project_name` → prefill | `cluster4_lines.main_title` |
| Output Link/Image | **자동 불러오기** (수정 가능) | `career_projects.output_links/output_images` → prefill | `output_link_1`, `output_link_2`, `output_images` |
| 평점 | 어드민이 결과 확정 후 입력 | 직접 입력 | `career_records.grade`, `career_records.grade_points` |
| 개설 대상 크루 | **자동 불러오기** (등록 시 선발 명단) | `career_records WHERE project_id = X` | `cluster4_line_targets.target_user_id` |

**핵심 차이**: 등록 시 입력한 메인 타이틀, Output Link/Image는 개설 시 **기본값으로 불러오되, 운영자가 수정 가능**하다.

---

## 4. line_code 데이터 소스 결정

### 4-1. 후보 비교

| 후보 | 적용 허브 | 장점 | 단점 | 판정 |
|---|---|---|---|---|
| **A. `activity_types.line_code`** | info, experience, competency | 이미 존재. 1:1 대응. 추가 테이블 불필요 | career에는 적용 불가 | **info/experience/competency 채택** |
| **B. `career_projects.line_code`** | career | 이미 존재. 경력별 고유 코드 | 다른 3허브에는 적용 불가 | **career 채택** |
| **C. 신규 통합 line master table** | 4허브 공통 | 단일 SoT. 깔끔한 구조 | 신규 테이블 + 마이그레이션. activity_types와 중복 | **기각** |
| **D. 허브별 line master table** | 4허브 각각 | 허브별 맞춤 필드 가능 | 4개 테이블 관리 부담. 과도한 분리 | **기각** |

### 4-2. 결정안: 허브별 기존 테이블 활용 + cluster4_lines에 저장

```
info / experience / competency:
  데이터 소스 = activity_types.line_code
  해석 경로:  라인 선택 → activity_type_id → JOIN activity_types → line_code
  저장:       cluster4_lines.line_code (denormalized, 생성 시 write)

career:
  데이터 소스 = career_projects.line_code
  해석 경로:  등록 라인 선택 → career_project_id → JOIN career_projects → line_code
  저장:       cluster4_lines.line_code (denormalized, 생성 시 write)
```

### 4-3. cluster4_lines에 line_code 컬럼 추가 — 필요

| 항목 | 값 |
|---|---|
| 컬럼명 | `line_code` |
| 타입 | `text` |
| NULL | `NOT NULL` |
| DEFAULT | 없음 |
| 인덱스 | `CREATE INDEX ... ON cluster4_lines (line_code)` |

추가 근거:

1. **프론트 소비 편의**: 프론트가 line_code를 표시할 때 매번 activity_types나 career_projects를 JOIN하지 않아도 됨
2. **데이터 일관성**: 라인 생성 시점에 확정된 line_code를 기록. 원본(activity_types 등)의 line_code가 나중에 변경되어도 이미 개설된 라인은 영향받지 않음
3. **허브 무관 통합 조회**: `cluster4_lines.line_code`만으로 어떤 라인인지 식별 가능

쓰기 규칙:

```
POST /api/admin/cluster4/lines 처리 시:

if (part_type in ['info', 'experience', 'competency']):
    line_code = SELECT line_code FROM activity_types WHERE id = :activity_type_id
    assert line_code IS NOT NULL

if (part_type == 'career'):
    line_code = SELECT line_code FROM career_projects WHERE id = :career_project_id
    assert line_code IS NOT NULL
    
→ cluster4_lines.line_code = resolved line_code
```

### 4-4. 기존 컬럼과의 관계

```
cluster4_lines 최종 식별자 체계:

  ┌─────────────┬──────────────────┬───────────────────┬────────────┐
  │ 컬럼         │ 역할             │ 허브별 사용       │ NULL 허용  │
  ├─────────────┼──────────────────┼───────────────────┼────────────┤
  │ line_code    │ 라인 코드 (신규) │ 4허브 공통        │ NOT NULL   │
  │ activity_type_id │ 원본 테이블 FK │ info/exp/comp    │ NULL       │
  │ career_project_id │ 원본 테이블 FK │ career           │ NULL       │
  │ part_type    │ 허브 구분        │ 4허브 공통        │ NOT NULL   │
  └─────────────┴──────────────────┴───────────────────┴────────────┘

제약:
  - info/experience/competency: activity_type_id NOT NULL, career_project_id NULL
  - career: activity_type_id NULL, career_project_id NOT NULL
  - line_code: 항상 NOT NULL (생성 시 resolve)
```

---

## 5. 자동 불러오기 API 계약

### 5-1. 라인 옵션 조회 API

```
GET /api/admin/cluster4/line-options?partType={info|experience|competency|career}
```

| 항목 | 값 |
|---|---|
| Method | GET |
| Query | `partType` (필수) |
| 권한 | admin 이상 |
| 용도 | 라인 선택 드롭다운 데이터 |

#### partType=info 응답

소스: `activity_types WHERE cluster_id = 'practical_info' AND is_active = true`

```json
{
  "success": true,
  "data": {
    "partType": "info",
    "options": [
      {
        "lineCode": "wisdom",
        "displayName": "위즈덤",
        "defaultMainTitle": null,
        "activityTypeId": "wisdom",
        "careerProjectId": null,
        "teamRequired": false,
        "ratingRequired": false,
        "alreadyOpened": false,
        "selectable": true,
        "sourceTable": "activity_types"
      },
      {
        "lineCode": "essay",
        "displayName": "에세이",
        "defaultMainTitle": null,
        "activityTypeId": "essay",
        "careerProjectId": null,
        "teamRequired": false,
        "ratingRequired": false,
        "alreadyOpened": true,
        "selectable": false,
        "sourceTable": "activity_types"
      }
    ]
  }
}
```

필드 설명:

| 필드 | 설명 |
|---|---|
| `lineCode` | 자동 불러오기 대상. 라인 선택 시 cluster4_lines.line_code에 저장 |
| `displayName` | 드롭다운에 표시되는 라인 이름 |
| `defaultMainTitle` | info: `null` (운영자 직접 입력). experience/competency: `displayName` 복사 |
| `activityTypeId` | 내부 식별자. API 요청 시 이 값을 전송 |
| `careerProjectId` | career 전용. 비-career 허브에서는 항상 `null` |
| `teamRequired` | experience에서만 `true` |
| `ratingRequired` | experience, career에서 `true` |
| `alreadyOpened` | 현재 주차에 이미 활성 라인이 존재하는지 (부분 UNIQUE 기반) |
| `selectable` | 선택 가능 여부. `alreadyOpened=true`면 `selectable=false` |
| `sourceTable` | 원본 테이블명 (디버깅/로깅용) |

#### partType=experience 응답

소스: `activity_types WHERE cluster_id = 'practical_experience' AND is_active = true`

```json
{
  "success": true,
  "data": {
    "partType": "experience",
    "options": [
      {
        "lineCode": "exp-design",
        "displayName": "디자인 실무",
        "defaultMainTitle": "디자인 실무",
        "activityTypeId": "exp-design",
        "careerProjectId": null,
        "teamRequired": true,
        "ratingRequired": true,
        "alreadyOpened": false,
        "selectable": true,
        "sourceTable": "activity_types"
      }
    ]
  }
}
```

차이점:
- `defaultMainTitle`: `displayName`과 동일 (라인 선택 시 메인 타이틀 자동 입력)
- `teamRequired`: `true` (팀 선택 UI 활성화)
- `ratingRequired`: `true` (사용자 2차 정보에 평점 입력 필요)

#### partType=competency 응답

소스: `activity_types WHERE cluster_id = 'practical_competency' AND is_active = true`

```json
{
  "success": true,
  "data": {
    "partType": "competency",
    "options": [
      {
        "lineCode": "comp-1",
        "displayName": "역량 라인 1",
        "defaultMainTitle": "역량 라인 1",
        "activityTypeId": "comp-1",
        "careerProjectId": null,
        "teamRequired": false,
        "ratingRequired": false,
        "alreadyOpened": false,
        "selectable": true,
        "sourceTable": "activity_types"
      }
    ]
  }
}
```

차이점:
- `defaultMainTitle`: `displayName`과 동일

#### partType=career 응답

소스: `career_projects` (등록된 경력 프로젝트 목록)

```json
{
  "success": true,
  "data": {
    "partType": "career",
    "options": [
      {
        "lineCode": "career-abc-web",
        "displayName": "[ABC Corp] 웹 리뉴얼",
        "defaultMainTitle": "웹 리뉴얼",
        "activityTypeId": null,
        "careerProjectId": "uuid-of-project",
        "teamRequired": false,
        "ratingRequired": true,
        "alreadyOpened": false,
        "selectable": true,
        "sourceTable": "career_projects",
        "careerMeta": {
          "companyName": "ABC Corp",
          "supervisorName": "김매니저",
          "supervisorPosition": "개발팀장",
          "outputLinks": ["https://example.com"],
          "outputImages": ["https://example.com/img.png"],
          "crewUserIds": ["uuid1", "uuid2"]
        }
      }
    ]
  }
}
```

차이점:
- `activityTypeId`: `null` (career는 activity_types가 아닌 career_projects 기반)
- `careerProjectId`: 경력 프로젝트 UUID
- `defaultMainTitle`: `career_projects.project_name`
- `careerMeta`: 추가 메타 정보 (프로젝트 요약 표시용)
  - `outputLinks` / `outputImages`: 등록 시 입력된 Output 기본값
  - `crewUserIds`: 등록 시 선발된 크루 명단 (개설 대상 자동 불러오기)

### 5-2. 자동 불러오기 동작 정리

| 허브 | 라인 선택 시 자동 세팅 항목 | 수정 가능 여부 |
|---|---|---|
| info | `line_code` | 수정 불가 (시스템 확정) |
| experience | `line_code`, `main_title` (displayName) | main_title만 수정 가능 |
| competency | `line_code`, `main_title` (displayName) | main_title만 수정 가능 |
| career | `line_code`, `main_title`, Output Link/Image, 대상 크루 | main_title, Output, 대상 크루 모두 수정 가능 |

---

## 6. 평점/포인트 처리 설계

### 6-1. 평점이 필요한 허브

| 허브 | 평점 필요 | 저장 위치 | 입력 주체 |
|---|---|---|---|
| 실무 정보 | 아니오 | — | — |
| 실무 경험 | **예** | `user_activity_details.rating` | 사용자 (프론트 2차 정보) |
| 실무 역량 | 아니오 | — | — |
| 실무 경력 | **예** | `career_records.grade`, `career_records.grade_points` | 어드민 (결과 확정) |

### 6-2. 실무 경험 — 사용자 평점

저장 위치:

```
user_activity_details.rating   smallint NULL   CHECK (0 <= rating <= 10)
```

입력 시점: 사용자가 프론트에서 2차 정보 입력 시 (수요일 22:00 마감 전)

어드민은 평점을 설정하지 않음. 조회만 가능 (읽기 전용).

### 6-3. 실무 경력 — 어드민 등급/점수

저장 위치:

```
career_records.grade           text NULL       CHECK: 'S'|'A'|'B'|'C'|'D'
career_records.grade_points    integer NULL    CHECK (grade_points >= 0)
```

입력 시점: 어드민이 경력 기록 관리 화면에서 결과 확정 시

### 6-4. 평점 → 포인트 환산 구조

#### 실무 경험 환산

`user_activity_details.rating` (0~10) → 포인트 환산:

| 단계 | 설명 |
|---|---|
| 1. 평점 입력 | 사용자가 0~10 점 입력 |
| 2. 포인트 환산 | `rating` 값을 기준으로 주차 포인트에 가산 |
| 3. 환산 공식 | **미결** — 아래 후보 중 택 1 |

환산 공식 (2026-05-27 확정):

**points = rating** (1:1 직접 대입). DB 에 points 컬럼 불필요, 계산값으로 취급.
포인트 표시명은 `organization_resume_card_settings.point_label` 에서 조회.

| rating | points | 표시 예시 (encre) |
|--------|--------|-------------------|
| 8      | 8      | 8 별              |
| 10     | 10     | 10 별             |

#### 실무 경력 환산

`career_records.grade` → `career_records.grade_points`:

| 등급 | 기본 점수 | 비고 |
|---|---|---|
| S | 100 | 최상위 |
| A | 90 | |
| B | 80 | |
| C | 70 | |
| D | 60 | 최하위 |

어드민이 `grade`를 선택하면 `grade_points`가 자동 세팅되되, 수동 조정도 허용.

### 6-5. 주차 성장률 계산과의 연결

현재 성장률 공식:

```typescript
weeklyGrowth.rate = ceil((completedLines / availableLines) * 100)
```

평점/포인트는 **성장률(rate)** 계산에는 직접 관여하지 않는다.

```
성장률: 라인 제출 여부 기반 (완료 수 / 가용 수)
포인트: 평점 기반 가산 → user_weekly_points에 적립
FM Score: cumulativePoints + advantages * 3 - penalty * 5
```

연결 구조:

```
평점 입력 (rating / grade)
    ↓
포인트 환산 (formula)
    ↓
user_weekly_points.points 가산
    ↓
FM Score 누적 계산
```

성장률과 포인트는 **독립적으로 계산**되며, 둘 다 주차 카드에 표시된다.

---

## 7. 실무 경력: career_projects / career_records / cluster4_lines 관계 재정리

### 7-1. 세 테이블의 역할

```
career_projects (등록 마스터)
  │ 회사명, supervisor, line_code, line_name, output_links/images
  │ 역할: 경력 라인의 메타데이터 저장소
  │
  ├── career_records (사용자별 기록)
  │     │ user_id, week_id, project_id, grade, grade_points, enhancement_status
  │     │ 역할: 크루원별 등급/점수/강화 상태 관리
  │     │
  │     └── UNIQUE (user_id, week_id, project_id)
  │
  ├── career_project_weeks (주차 연결)
  │     │ project_id, week_id, is_active
  │     │ 역할: 해당 프로젝트가 어떤 주차에 활성인지 관리
  │     │
  │     └── UNIQUE (project_id, week_id)
  │
  └── cluster4_lines (개설 인스턴스)
        │ career_project_id → career_projects.id
        │ line_code (denormalized from career_projects.line_code)
        │ main_title, output_link_1/2, output_images
        │ submission_opens_at, submission_closes_at
        │ 역할: 해당 주차의 제출 기간/대상/Output 관리
        │
        └── cluster4_line_targets (주차 × 대상 매핑)
              │ week_id, target_user_id
              └── cluster4_line_submissions (제출 확인)
```

### 7-2. 등록 vs 개설 데이터 흐름

```
[등록 시점]
  운영자 → career_projects INSERT (회사/supervisor/line_code/크루 명단)
         → career_records INSERT × N (선발 크루원 수만큼)

[개설 시점]
  운영자 → career_projects 선택 (드롭다운)
         → cluster4_lines INSERT (line_code, main_title, output 자동 불러오기)
         → cluster4_line_targets INSERT × N (대상 크루 자동 불러오기 또는 수정)
         → career_project_weeks UPSERT (해당 주차에 프로젝트 자동 연결)

[결과 확정 시점]
  운영자 → career_records PATCH (grade, grade_points, enhancement_status)
```

### 7-3. 등록 UI에 필요한 career_projects 확장

현재 career_projects에 없는 필드:

| 필드 | 타입 | 용도 | 현재 상태 |
|---|---|---|---|
| 기간 (start_date / end_date) | `date` | 프로젝트 기간 | **미존재** — 신규 추가 필요 |
| 선발 크루 명단 | — | career_records 행으로 관리 | 기존 구조 활용 가능 |

`career_projects`에 `start_date` / `end_date` 컬럼 추가가 필요한지,
또는 `career_project_weeks`의 첫/마지막 주차로 대체할 수 있는지는 **미결**.

---

## 8. 구현 전 필요한 DB/API 변경 목록

### 8-1. DB 변경 (Migration)

| # | 대상 테이블 | 변경 내용 | 우선순위 |
|---|---|---|---|
| M-1 | `cluster4_lines` | `line_code text NOT NULL` 컬럼 추가 | **필수** |
| M-2 | `cluster4_lines` | `line_code` 인덱스 추가 | **필수** |
| M-3 | `cluster4_lines` | 기존 행의 line_code 역채움 (backfill) | **필수** |
| M-4 | `career_projects` | `start_date date NULL`, `end_date date NULL` 컬럼 추가 검토 | 선택 |

M-3 역채움 SQL 예시:

```sql
-- info/experience/competency: activity_types에서 가져오기
UPDATE cluster4_lines cl
SET line_code = at.line_code
FROM activity_types at
WHERE cl.activity_type_id = at.id
  AND cl.activity_type_id IS NOT NULL
  AND cl.line_code IS NULL;

-- career: career_projects에서 가져오기
UPDATE cluster4_lines cl
SET line_code = cp.line_code
FROM career_projects cp
WHERE cl.career_project_id = cp.id
  AND cl.career_project_id IS NOT NULL
  AND cl.line_code IS NULL;
```

**주의**: 기존 데이터 중 `line_code`가 NULL인 행이 역채움 후에도 남으면 `NOT NULL` 제약 적용 불가. 이 경우:
- 역채움 불가능한 행에 대한 기본값 정책 필요 (예: `'unknown'`)
- 또는 기존 행은 NULL 허용, 신규 행만 NOT NULL 강제 (application-level)

### 8-2. API 변경

| # | 엔드포인트 | 변경 내용 | 우선순위 |
|---|---|---|---|
| A-1 | `GET /api/admin/cluster4/line-options` | **신규** — 라인 옵션 조회 | **필수** |
| A-2 | `POST /api/admin/cluster4/lines` | `line_code` 자동 resolve 로직 추가 | **필수** |
| A-3 | `GET /api/admin/cluster4/lines` | 응답 DTO에 `lineCode` 필드 추가 | **필수** |
| A-4 | `PATCH /api/admin/cluster4/lines/[id]` | `line_code` 변경 불가 (activity_type_id 변경 시에만 연동) | 필수 |
| A-5 | `Cluster4LineDto` | `lineCode: string` 필드 추가 | **필수** |
| A-6 | `Cluster4LineUpsertInput` | `lineCode` 필드 제거 (서버에서 자동 resolve) | 필수 |

### 8-3. 타입/파서 변경

| # | 파일 | 변경 내용 |
|---|---|---|
| T-1 | `lib/adminCluster4LinesTypes.ts` | `Cluster4LineDto`에 `lineCode: string` 추가 |
| T-2 | `lib/adminCluster4LinesTypes.ts` | `parseCluster4LineCreateBody`에서 line_code 직접 수신하지 않음 (서버 자동) |
| T-3 | `lib/adminCluster4LinesData.ts` | 라인 생성 로직에 line_code resolve 추가 |
| T-4 | `lib/cluster4LinesTypes.ts` | 사용자향 DTO에 `lineCode` 추가 |

---

## 9. 구현 우선순위

### Phase 0: 설계 확정 (현 문서)

- [x] 필드 계약 문서 작성
- [ ] 미결 사항 확정 (§11)

### Phase 1: DB + 타입 기반

| 순서 | 작업 | 의존 |
|---|---|---|
| 1-1 | `cluster4_lines` → `line_code` 컬럼 추가 Migration | 없음 |
| 1-2 | 기존 데이터 `line_code` 역채움 | 1-1 |
| 1-3 | `Cluster4LineDto`, `Cluster4LineUpsertInput` 타입 업데이트 | 1-1 |
| 1-4 | `parseCluster4LineCreateBody` 파서 수정 (line_code 미수신) | 1-3 |

### Phase 2: 라인 옵션 API

| 순서 | 작업 | 의존 |
|---|---|---|
| 2-1 | `GET /api/admin/cluster4/line-options` 신규 구현 | 1-1 |
| 2-2 | `POST /api/admin/cluster4/lines` line_code 자동 resolve 로직 | 1-3, 2-1 |
| 2-3 | `GET /api/admin/cluster4/lines` DTO에 lineCode 포함 | 1-3 |

### Phase 3: 실무 경험 MVP

| 순서 | 작업 | 의존 |
|---|---|---|
| 3-1 | `practical_experience` activity_types seed 확인/보완 | 없음 |
| 3-2 | 실무 경험 라인 개설 페이지 UI | 2-1, 2-2 |
| 3-3 | 팀 선택 + 평점 표시 연동 | 3-2 |
| 3-4 | 평점 → 포인트 환산 로직 구현 | 환산 공식 확정 후 |

### Phase 4: 실무 역량 + 경력

| 순서 | 작업 | 의존 |
|---|---|---|
| 4-1 | 실무 역량 라인 개설 페이지 | 2-1, 2-2 |
| 4-2 | 경력 라인 등록/개설 UI 분리 | 2-1 |
| 4-3 | career_records 등급/점수 관리 UI | career_records API |

### Phase 5: 검증

| 순서 | 작업 |
|---|---|
| 5-1 | line_code 자동 불러오기 검증 (4허브) |
| 5-2 | 주차 자동 지정 검증 |
| 5-3 | 강화 판정 기준 검증 (제출 기반) |
| 5-4 | Output Asset 합산 제한 검증 |
| 5-5 | 이미지 업로드 → output_images 저장 검증 |
| 5-6 | 권장 마감 안내 문구 표시 검증 |
| 5-7 | 2차 정보 수요일 22:00 제한 검증 |

---

## 10. 실무 경력 등록/개설 분리 상세

### 10-1. 등록 UI (career_projects 관리)

```
경로: /admin/career-projects/new (신규) 또는 /admin/career-projects/[id] (수정)

입력 항목:
  ┌─────────────────────────────────────────────────────────┐
  │  경력 라인 등록                                          │
  ├─────────────────────────────────────────────────────────┤
  │                                                         │
  │  ── 기본 정보 ──                                        │
  │  기간 *     시작: [2026-03-01]  종료: [2026-08-31]       │
  │  라인명 *   [웹 리뉴얼 프로젝트          ]                │
  │  라인 코드  [career-abc-web] (자동 생성 또는 수동)        │
  │                                                         │
  │  ── Supervisor 정보 ──                                  │
  │  이름       [김매니저          ]                          │
  │  직위       [개발팀장          ]                          │
  │  부서       [개발본부          ]                          │
  │  회사       [ABC Corp         ]                          │
  │  프로필 이미지 [업로드]                                   │
  │                                                         │
  │  ── 선발 크루 ──                                        │
  │  □ 김철수  □ 이영희  □ 박민수  □ 최수진                  │
  │  선택됨: 3명                                             │
  │                                                         │
  │  ── Output (선택) ──                                    │
  │  메인 타이틀  [웹 리뉴얼                     ] (선택)     │
  │  Output Link  [https://...               ] (선택)       │
  │  Output Image [업로드                    ] (선택)        │
  │                                                         │
  │               [취소]  [등록]                              │
  └─────────────────────────────────────────────────────────┘
```

### 10-2. 개설 UI (cluster4_lines 생성)

```
경로: /admin/line-opening/practical-career

입력 항목:
  ┌─────────────────────────────────────────────────────────┐
  │  경력 라인 개설                                          │
  ├─────────────────────────────────────────────────────────┤
  │                                                         │
  │  📅 현재 주차: S1 시즌 · 4주차 (2026-05-25 ~ 2026-05-31)│
  │  ⚠️ 라인 개설 권장 마감: 월요일 22:00                    │
  │  ⏰ 제출 기간: 05-25 (월) 00:00 ~ 05-28 (수) 22:00      │
  │                                                         │
  │  ── 등록 라인 선택 ──                                   │
  │  ┌──────────────────────────┐                            │
  │  │ [ABC Corp] 웹 리뉴얼   ▾ │                            │
  │  └──────────────────────────┘                            │
  │                                                         │
  │  ↓ 자동 불러오기 ↓                                      │
  │                                                         │
  │  line_code: career-abc-web (읽기 전용)                   │
  │                                                         │
  │  메인 타이틀 *   [웹 리뉴얼          ] (수정 가능)        │
  │  Output Link    [https://...     ] (수정 가능)           │
  │  Output Image   [img1.png        ] (수정 가능)           │
  │                                                         │
  │  개설 대상 크루 (자동 불러오기 + 수정 가능)               │
  │  ☑ 김철수  ☑ 이영희  ☑ 박민수  □ 최수진                 │
  │  선택됨: 3명                                             │
  │                                                         │
  │               [취소]  [개설]                              │
  └─────────────────────────────────────────────────────────┘
```

### 10-3. 개설 후 → 평점 입력

```
경로: /admin/career-projects 내 경력 기록 관리 탭

  ┌──────────────────────────────────────────────────────┐
  │ 경력 기록: [ABC Corp] 웹 리뉴얼 — 4주차              │
  ├──────────────────────────────────────────────────────┤
  │ 크루원     │ 제출 │ 등급  │ 점수 │ 강화 상태         │
  ├──────────────────────────────────────────────────────┤
  │ 김철수     │ ✅   │ A [▾] │ 90   │ enhanced         │
  │ 이영희     │ ✅   │ B [▾] │ 80   │ enhanced         │
  │ 박민수     │ ❌   │ — [▾] │ —    │ failed           │
  └──────────────────────────────────────────────────────┘
```

---

## 11. 미결 사항

### ~~U-1. 평점 → 포인트 환산 공식~~ (2026-05-27 확정 완료)

- **확정**: points = rating (1:1 직접 대입). DB 에 points 컬럼 불필요.
- 포인트 표시명은 `organization_resume_card_settings.point_label` 에서 조회.
- 마이그레이션: `2026-05-27_org_settings_add_point_label.sql`

### U-2. 경력 등급 기본 점수 매핑

- `grade` → `grade_points` 기본값 (S=100, A=90 등) 확정 필요
- 어드민 수동 조정 범위 (상한/하한) 결정 필요
- **결정 필요 시점**: Phase 4 착수 전

### U-3. career_projects 기간 필드

- `start_date` / `end_date` 컬럼 추가 vs `career_project_weeks` 기반 추론
- 등록 UI에서 기간을 직접 입력할지, 주차 연결로 대체할지
- **결정 필요 시점**: Phase 4 착수 전

### U-4. line_code NOT NULL 적용 전략

- 기존 `cluster4_lines` 행에 line_code가 없는 경우 역채움 가능 여부
- 역채움 실패 행에 대한 처리 방침 (기본값 vs NULL 허용)
- **결정 필요 시점**: Phase 1 Migration 작성 시

### U-5. 이미지 업로드 저장소

- Supabase Storage 사용 여부
- 버킷 구조 (`cluster4-lines/images/` 등)
- 파일 크기 제한, 허용 포맷
- **결정 필요 시점**: Phase 2 UI 구현 전

### U-6. 부분 UNIQUE 인덱스 범위 재검토

- 현재: `UNIQUE (activity_type_id) WHERE is_active = true`
- line_code 추가 후: `UNIQUE (line_code, part_type) WHERE is_active = true` 고려
- 실무 경험 팀별 멀티 라인: `UNIQUE (activity_type_id, team_id) WHERE is_active = true` 고려
- **결정 필요 시점**: Phase 1 Migration 작성 시

### U-7. 실무 역량 카페 링크 집계 (Phase 2)

- 카페 API 연동 방식
- 댓글 작성자 ↔ 크루원 매칭 로직
- **결정 필요 시점**: Phase 1 완료 후

### U-8. 경력 라인과 career_project_weeks 이중 관리

- cluster4_line_targets (career) + career_project_weeks 병존 정책 유지
- 장기적으로 한쪽 통합/폐기 필요
- **결정 필요 시점**: Phase 4 이후

### U-9. 운영자 라인 개설 마감 이후 동작

- 월요일 22:00 이후에도 라인 개설이 가능 (시스템 제한 없음)
- 단, 해당 주차의 남은 제출 기간이 짧아지므로 경고 표시 여부
- 예: "현재 제출 마감까지 XX시간 남았습니다" 안내
- **결정 필요 시점**: Phase 3 UI 구현 시

---

## 부록 A: 허브별 필드 매트릭스 (요약)

| 필드 | info | experience | competency | career |
|---|---|---|---|---|
| **라인 선택** | activity_types dropdown | activity_types dropdown | activity_types dropdown | career_projects dropdown |
| **line_code** | 자동 (activity_types) | 자동 (activity_types) | 자동 (activity_types) | 자동 (career_projects) |
| **팀 선택** | — | 필수 | — | — |
| **메인 타이틀** | 수동 입력 | 자동 + 수정 가능 | 자동 + 수정 가능 | 자동 + 수정 가능 |
| **Output Link** | 수동 입력 | 수동 입력 | 수동 (공통) | 자동 + 수정 가능 |
| **Output Image** | 업로드 | 업로드 | 업로드 (공통) | 자동 + 수정 가능 |
| **대상 크루** | 수동 선택 | 수동 선택 | 수동 (Phase1) | 자동 + 수정 가능 |
| **개설 주차** | 시스템 자동 | 시스템 자동 | 시스템 자동 | 시스템 자동 |
| **제출 기간** | 시스템 자동 | 시스템 자동 | 시스템 자동 | 시스템 자동 |
| **평점** | — | 사용자 입력 | — | 어드민 입력 |
| **포인트 환산** | — | rating → points | — | grade → grade_points |

## 부록 B: 자동 불러오기 API 경로 요약

| 엔드포인트 | 용도 |
|---|---|
| `GET /api/admin/cluster4/line-options?partType=info` | 실무 정보 라인 목록 |
| `GET /api/admin/cluster4/line-options?partType=experience` | 실무 경험 라인 목록 |
| `GET /api/admin/cluster4/line-options?partType=competency` | 실무 역량 라인 목록 |
| `GET /api/admin/cluster4/line-options?partType=career` | 경력 프로젝트 목록 (등록 라인) |
| `GET /api/admin/cluster4/current-week` | 현재 주차 + 제출 기간 |
| `GET /api/admin/cluster4/crews` | 조직 크루원 목록 |
| `GET /api/admin/cluster4/teams` | 팀 목록 (experience 전용) |
