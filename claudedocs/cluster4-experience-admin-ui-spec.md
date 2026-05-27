# Cluster4 실무 경험 허브 — 어드민 UI/API 설계

> 작성일: 2026-05-27
> 상태: Phase 1 DB Migration 적용 완료, UI/API 설계 단계

---

## 1. 메뉴 구조

### 1-1. 사이드바 변경

현재 사이드바 `라인 개설` 섹션:

```
라인 개설
├─ 실무 정보       (enabled)   → /admin/line-opening/practical-info
├─ 실무 경험       (disabled)  → /admin/line-opening/practical-experience
├─ 실무 역량       (disabled)  → /admin/line-opening/practical-competency
└─ 실무 경력       (enabled)   → /admin/career-projects
```

변경 후:

```
라인 개설
├─ 실무 정보       (enabled)   → /admin/line-opening/practical-info
├─ 실무 경험       (enabled)   → /admin/line-opening/practical-experience   ← 활성화
├─ 실무 역량       (disabled)  → /admin/line-opening/practical-competency
└─ 실무 경력       (enabled)   → /admin/career-projects
```

변경: `lib/adminLineOpening.ts` 에서 `practical-experience` 항목의 `enabled: true` 로 전환.

### 1-2. 실무 경험 페이지 내부 탭 구조

`/admin/line-opening/practical-experience` 페이지 내에 3개 탭을 배치한다.

```
┌────────────────────────────────────────────────────────────────┐
│  실무 경험 관리                                                 │
│                                                                │
│  [라인 개설]  [라인 마스터]  [평가 관리]                          │
│  ─────────   ──────────   ──────────                           │
│                                                                │
│  (탭별 콘텐츠)                                                  │
└────────────────────────────────────────────────────────────────┘
```

| 탭 | key | 용도 |
|---|---|---|
| 라인 개설 | `line-opening` | 주차별 실무 경험 라인 개설 |
| 라인 마스터 | `line-masters` | experience_line_masters CRUD |
| 평가 관리 | `evaluations` | experience_line_evaluations 관리 |

기본 활성 탭: `라인 개설`

탭 전환은 URL query parameter `?tab=line-masters` 또는 로컬 state로 관리.
기존 PracticalInfoManager.tsx 가 단일 컴포넌트인 것과 달리, 이 페이지는 3개 서브컴포넌트로 분리한다.

```
PracticalExperienceManager.tsx
├─ ExperienceLineOpeningTab.tsx     (탭 1)
├─ ExperienceLineMastersTab.tsx     (탭 2)
└─ ExperienceEvaluationsTab.tsx     (탭 3)
```

---

## 2. 라인 마스터 관리 UI

### 2-1. 화면 레이아웃

```
┌──────────────────────────────────────────────────────────────────────────┐
│  라인 마스터 관리                                               [+ 추가] │
│                                                                         │
│  ┌──────────────────────────────────────────────────────────────────────┐│
│  │ (향후) 엑셀 Import 영역 — 현재는 "준비 중" 표시                       ││
│  └──────────────────────────────────────────────────────────────────────┘│
│                                                                         │
│  ┌──────────────────────────────────────────────────────────────────────┐│
│  │ 라인 코드 │ 라인명     │ 기본 타이틀 │ 팀        │ 상태   │ 수정     ││
│  ├──────────────────────────────────────────────────────────────────────┤│
│  │ exp-design│ 디자인 실무│ 디자인 과제 │ 디자인팀  │ 활성   │ [편집]   ││
│  │ exp-mkt   │ 마케팅 실무│ 마케팅 과제 │ 마케팅팀  │ 활성   │ [편집]   ││
│  │ exp-dev   │ 개발 실무  │ (없음)      │ (미지정)  │ 비활성 │ [편집]   ││
│  └──────────────────────────────────────────────────────────────────────┘│
└──────────────────────────────────────────────────────────────────────────┘
```

### 2-2. 추가/수정 폼

`[+ 추가]` 또는 `[편집]` 클릭 시 인라인 모달 또는 확장 패널로 표시.

```
┌──────────────────────────────────────────┐
│  라인 마스터 추가 (또는 수정)              │
│                                          │
│  라인 코드 *   [exp-design        ]      │
│  라인명 *      [디자인 실무        ]      │
│  기본 타이틀   [디자인 과제        ]      │
│  팀 연결       [디자인팀       ▾]        │
│  원본 파일명   [design_tasks.xlsx ]      │
│  활성 상태     [✓]                       │
│                                          │
│              [취소]  [저장]               │
└──────────────────────────────────────────┘
```

### 2-3. 필드 정의

| 필드 | DB 컬럼 | 필수 | 규칙 |
|---|---|---|---|
| 라인 코드 | `line_code` | O | text, UNIQUE, 수정 시 읽기 전용 |
| 라인명 | `line_name` | O | text, 1~100자 |
| 기본 타이틀 | `default_main_title` | X | text, null이면 라인 개설 시 line_name으로 fallback |
| 팀 연결 | `team_id` | X | cluster4_teams 드롭다운, null 허용 |
| 원본 파일명 | `source_file_name` | X | text, 엑셀 import 이력 추적용 |
| 활성 상태 | `is_active` | O | boolean, default true |

### 2-4. 엑셀 Import 영역

현재는 비활성 상태로 다음 placeholder를 표시:

```
┌──────────────────────────────────────────────────────────────┐
│  📁 엑셀 Import                                              │
│                                                              │
│  라인 마스터를 엑셀에서 일괄 등록하는 기능은 준비 중입니다.      │
│  현재는 [+ 추가] 버튼으로 단건 등록해주세요.                    │
└──────────────────────────────────────────────────────────────┘
```

향후 구현 시:
- 엑셀 파일 업로드 → 파싱 → 미리보기 → 확인 후 bulk insert
- `source_file_name` 에 원본 파일명 자동 기록

### 2-5. 삭제 정책

물리 삭제 대신 `is_active = false` 비활성화를 사용한다.
- 해당 마스터에 연결된 `cluster4_lines` 가 존재하면 삭제 불가 (비활성화만 가능)
- UI 에서는 `[비활성화]` 버튼으로 표시

---

## 3. 실무 경험 라인 개설 UI

### 3-1. 화면 레이아웃

PracticalInfoManager.tsx 패턴을 따르되, 실무 경험 고유 필드를 반영.

```
┌──────────────────────────────────────────────────────────────────┐
│  실무 경험 라인 개설                                              │
│                                                                  │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │  현재 주차 정보                                             │  │
│  │  시즌: 2026-S1  │  12주차  │  05/26 ~ 06/01               │  │
│  │  제출 기간: 05/26 00:00 ~ 05/28 22:00 (KST)               │  │
│  └────────────────────────────────────────────────────────────┘  │
│                                                                  │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │  개설된 라인 목록                                           │  │
│  │  ─────────────────────────────────────────────────────────  │  │
│  │  라인 코드 │ 라인명     │ 팀     │ 대상 │ 상태  │ 생성일    │  │
│  │  exp-design│ 디자인 실무│ 디자인 │ 3명  │ 활성  │ 05/26    │  │
│  │  exp-mkt   │ 마케팅 실무│ 마케팅 │ 5명  │ 활성  │ 05/26    │  │
│  └────────────────────────────────────────────────────────────┘  │
│                                                                  │
│  [새 라인 개설] ← canOpen 일 때만 활성                            │
│                                                                  │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │  새 라인 개설 폼 (showForm = true 일 때 표시)               │  │
│  │                                                            │  │
│  │  라인 선택 *     [디자인 실무 (exp-design)  ▾]              │  │
│  │                                                            │  │
│  │  라인 코드       exp-design       (읽기 전용, 자동 표시)    │  │
│  │  팀              디자인팀         (읽기 전용 또는 선택)      │  │
│  │                                                            │  │
│  │  메인 타이틀 *   [디자인 과제                     ]         │  │
│  │                  (default_main_title 자동 입력, 수정 가능)  │  │
│  │                                                            │  │
│  │  ── Output Asset (합산 1~2개) ──                           │  │
│  │  Output Link 1   [https://...                    ]         │  │
│  │  Output Image 1  [📁 업로드] [미리보기] [삭제]              │  │
│  │                                                            │  │
│  │  ── 대상 크루 선택 ──                                      │  │
│  │  검색: [크루 이름 검색...        ]                          │  │
│  │  [전체 선택] [전체 해제]                                    │  │
│  │  ☑ 김철수   ☑ 이영희   ☐ 박민수   ☑ 최수진                │  │
│  │  ☐ 정현우   ☑ 강지은   ...                                 │  │
│  │                                                            │  │
│  │              [취소]  [개설]                                 │  │
│  └────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────┘
```

### 3-2. 라인 선택 드롭다운

- 데이터 소스: `cluster4_experience_line_masters` (is_active = true)
- 표시 형식: `{line_name} ({line_code})`
- 선택 시 자동 설정:
  - `line_code` → 읽기 전용 표시
  - `team_id` → 마스터에 team_id가 있으면 읽기 전용, 없으면 팀 드롭다운 활성화
  - `main_title` → `default_main_title ?? line_name` 으로 자동 입력 (운영자 수정 가능)
  - `experience_line_master_id` → 저장 시 자동 설정

### 3-3. 팀 표시 로직

```
if (selectedMaster.team_id) {
  // 마스터에 팀이 연결됨 → 읽기 전용 표시
  팀: "디자인팀" (읽기 전용)
} else {
  // 마스터에 팀 없음 → 드롭다운으로 선택 가능
  팀: [선택하세요 ▾]  (cluster4_teams 목록)
}
```

### 3-4. Output Asset 규칙

| 항목 | 규칙 |
|---|---|
| Output Link 1 | URL 텍스트 입력, 선택 |
| Output Image 1 | 이미지 업로드, 선택 |
| 합산 제약 | link + image 합산 최소 1개, 최대 2개 |
| 이미지 업로드 | `/api/admin/cluster4/upload-image` 기존 엔드포인트 재사용 |

info-lines 의 `output_link_1` + `output_link_2` + `output_images` 3칸 구조 대신,
experience 는 link 1개 + image 1개 = 최대 2개 슬롯으로 단순화한다.

DB 매핑:
- link → `cluster4_lines.output_link_1`
- image → `cluster4_lines.output_images[0]` (jsonb 배열)

### 3-5. 개설 대상 크루 선택

info-lines 와 동일한 UI 패턴 재사용:
- `/api/admin/cluster4/users` 에서 크루 목록 조회
- 검색 필터 (display_name 검색)
- 체크박스 다중 선택 + 전체 선택/해제
- 최소 1명 이상 선택 필수

### 3-6. 저장 시 생성 흐름

```
POST /api/admin/cluster4/experience-lines
  ↓
1. experience_line_master_id 검증 (존재 + is_active)
2. week_id 검증 (존재)
3. 중복 체크: 같은 experience_line_master_id + week_id 로 활성 라인 존재 여부
4. cluster4_lines INSERT
   - part_type = 'experience'
   - experience_line_master_id = 선택값
   - line_code = 마스터의 line_code
   - team_id = 마스터의 team_id 또는 운영자 선택값
   - main_title = 입력값
   - output_link_1, output_images = 입력값
   - submission_opens_at, submission_closes_at = 현재 주차 기준 자동
5. cluster4_line_targets BULK INSERT
   - 각 target_user_id 에 대해 1 row (target_mode = 'user')
6. 응답: { line, targets, targetCount }
```

---

## 4. 평가 관리 UI

### 4-1. 화면 레이아웃

```
┌──────────────────────────────────────────────────────────────────────────┐
│  실무 경험 평가 관리                                                      │
│                                                                          │
│  라인 선택: [디자인 실무 (exp-design) · 12주차    ▾]                      │
│                                                                          │
│  포인트 명칭: 별 (encre 기준)                                             │
│                                                                          │
│  ┌──────────────────────────────────────────────────────────────────────┐│
│  │ 크루원     │ 제출 여부 │ 평점 (0~10) │ 포인트   │ 평가일   │ 저장    ││
│  ├──────────────────────────────────────────────────────────────────────┤│
│  │ 김철수     │ ✅ 제출  │ [8    ▾]    │ 8 별     │ 05/27   │ [저장]  ││
│  │ 이영희     │ ✅ 제출  │ [—    ▾]    │ —        │ —       │ [저장]  ││
│  │ 박민수     │ ❌ 미제출 │ (비활성)    │ —        │ —       │         ││
│  │ 최수진     │ ✅ 제출  │ [9    ▾]    │ 9 별     │ 05/27   │ [저장]  ││
│  └──────────────────────────────────────────────────────────────────────┘│
│                                                                          │
│  요약: 대상 4명 │ 제출 3명 │ 평가 완료 2명 │ 미평가 1명                    │
└──────────────────────────────────────────────────────────────────────────┘
```

### 4-2. 라인 선택 드롭다운

- 데이터 소스: `cluster4_lines` WHERE `part_type = 'experience'`
- 표시 형식: `{main_title} ({line_code}) · {week_number}주차`
- 정렬: 최신 주차 → 과거 주차

### 4-3. 평가 테이블 데이터 구성

라인 선택 후 아래 데이터를 조합하여 테이블을 렌더링한다:

```
1. 대상 크루 목록
   ← cluster4_line_targets WHERE line_id = 선택한 라인
   → target_user_id 목록

2. 제출 여부
   ← cluster4_line_submissions WHERE line_target_id IN (위 target IDs)
   → submitted: boolean (row 존재 여부)

3. 기존 평가
   ← cluster4_experience_line_evaluations WHERE line_target_id IN (위 target IDs)
   → rating, evaluated_at

4. 크루 프로필
   ← user_profiles WHERE user_id IN (target_user_ids)
   → display_name

5. 포인트 표시명
   ← organization_resume_card_settings.point_label
   (현재 어드민의 organization 기준)
```

### 4-4. 평가 입력 규칙

| 규칙 | 설명 |
|---|---|
| 제출자만 평가 가능 | submission row가 없으면 rating 입력 비활성화 |
| rating 범위 | 0~10 정수 (드롭다운 또는 숫자 입력) |
| 포인트 표시 | `{rating} {point_label}` (예: "8 별") |
| 신규 평가 | POST → `cluster4_experience_line_evaluations` INSERT |
| 평가 수정 | PATCH → 기존 row UPDATE (rating, evaluated_at) |
| 중복 방지 | UNIQUE(line_target_id, user_id) 에 의해 DB 레벨 보장 |

### 4-5. 저장 흐름

```
[저장] 클릭 시:

기존 평가 없음:
  POST /api/admin/cluster4/experience-evaluations
  → INSERT (line_target_id, user_id, rating, evaluated_by, evaluated_at)

기존 평가 있음:
  PATCH /api/admin/cluster4/experience-evaluations/[id]
  → UPDATE (rating, evaluated_at)
```

개별 행 저장 방식 (행별 [저장] 버튼).
벌크 저장은 향후 검토.

---

## 5. API 계약

### 5-1. 팀 목록 조회

```
GET /api/admin/cluster4/teams?organization={slug}
```

| 항목 | 값 |
|---|---|
| Method | GET |
| URL | `/api/admin/cluster4/teams` |
| Auth | requireAdminApi() |
| Query | `organization` (선택, organization_slug 필터) |
| Response | `{ success: true, data: TeamDto[] }` |
| 사용 화면 | 라인 마스터 편집, 라인 개설 폼 |

```typescript
type TeamDto = {
  id: string;
  teamName: string;
  organizationSlug: string;
  isActive: boolean;
};
```

Response 예시:
```json
{
  "success": true,
  "data": [
    { "id": "uuid-1", "teamName": "비주얼", "organizationSlug": "encre", "isActive": true },
    { "id": "uuid-2", "teamName": "갤러리", "organizationSlug": "encre", "isActive": true },
    { "id": "uuid-3", "teamName": "IT", "organizationSlug": "phalanx", "isActive": true }
  ]
}
```

---

### 5-2. 라인 마스터 목록 조회

```
GET /api/admin/cluster4/experience-line-masters
```

| 항목 | 값 |
|---|---|
| Method | GET |
| URL | `/api/admin/cluster4/experience-line-masters` |
| Auth | requireAdminApi() |
| Query | `?active=true` (선택, 기본 전체) |
| Response | `{ success: true, data: ExperienceLineMasterDto[] }` |
| 사용 화면 | 라인 마스터 탭, 라인 개설 드롭다운 |

```typescript
type ExperienceLineMasterDto = {
  id: string;
  lineCode: string;
  lineName: string;
  defaultMainTitle: string | null;
  teamId: string | null;
  teamName: string | null;       // JOIN cluster4_teams.team_name
  sourceFileName: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
};
```

---

### 5-3. 라인 마스터 생성

```
POST /api/admin/cluster4/experience-line-masters
```

| 항목 | 값 |
|---|---|
| Method | POST |
| URL | `/api/admin/cluster4/experience-line-masters` |
| Auth | requireAdminApi() |
| Request Body | `ExperienceLineMasterCreateInput` |
| Response | `{ success: true, data: ExperienceLineMasterDto }` (201) |
| 사용 화면 | 라인 마스터 탭 [+ 추가] |

```typescript
type ExperienceLineMasterCreateInput = {
  line_code: string;          // 필수, unique
  line_name: string;          // 필수, 1~100자
  default_main_title?: string | null;
  team_id?: string | null;    // cluster4_teams.id
  source_file_name?: string | null;
  is_active?: boolean;        // default true
};
```

Validation:
- `line_code`: 필수, 비어있지 않은 문자열, DB UNIQUE 제약으로 중복 체크
- `line_name`: 필수, 1~100자
- `team_id`: null 허용, 제공 시 cluster4_teams 에 존재해야 함
- `default_main_title`: null 허용, 제공 시 1~200자

에러 응답:
- 400: validation 실패
- 409: line_code 중복

---

### 5-4. 라인 마스터 수정

```
PATCH /api/admin/cluster4/experience-line-masters/[id]
```

| 항목 | 값 |
|---|---|
| Method | PATCH |
| URL | `/api/admin/cluster4/experience-line-masters/{id}` |
| Auth | requireAdminApi() |
| Request Body | `ExperienceLineMasterPatchInput` (partial) |
| Response | `{ success: true, data: ExperienceLineMasterDto }` |
| 사용 화면 | 라인 마스터 탭 [편집] |

```typescript
type ExperienceLineMasterPatchInput = {
  line_name?: string;
  default_main_title?: string | null;
  team_id?: string | null;
  source_file_name?: string | null;
  is_active?: boolean;
};
```

주의: `line_code` 는 수정 불가 (PK 역할의 식별자).

---

### 5-5. 라인 마스터 비활성화

별도 DELETE 엔드포인트 없음. PATCH 로 `is_active: false` 전환.

```
PATCH /api/admin/cluster4/experience-line-masters/{id}
Body: { "is_active": false }
```

Validation:
- 해당 마스터에 연결된 `cluster4_lines` 가 활성(is_active=true) 상태로 존재하면 비활성화 불가.
  → 400 응답: "활성 라인이 존재하는 마스터는 비활성화할 수 없습니다."

---

### 5-6. 실무 경험 라인 개설

```
POST /api/admin/cluster4/experience-lines
```

| 항목 | 값 |
|---|---|
| Method | POST |
| URL | `/api/admin/cluster4/experience-lines` |
| Auth | requireAdminApi() |
| Request Body | `ExperienceLineCreateInput` |
| Response | `{ success: true, data: { line, targets, targetCount } }` (201) |
| 사용 화면 | 라인 개설 탭 [개설] |

```typescript
type ExperienceLineCreateInput = {
  experience_line_master_id: string;   // 필수, UUID
  main_title: string;                  // 필수
  output_link_1?: string | null;       // URL
  output_images?: string[];            // 이미지 URL 배열
  team_id?: string | null;             // 마스터에 없을 때만 사용
  target_user_ids: string[];           // 필수, 1명 이상
  week_id: string;                     // 필수, UUID
  submission_opens_at: string;         // ISO datetime
  submission_closes_at: string;        // ISO datetime
};
```

Validation:
- `experience_line_master_id`: 필수, cluster4_experience_line_masters 에 존재 + is_active
- `main_title`: 필수, 비어있지 않은 문자열
- Output asset: link count + image count 합산 1~2개
- `target_user_ids`: 1명 이상, 각 UUID가 user_profiles 에 존재
- `week_id`: weeks 테이블에 존재
- 중복 체크: 같은 `experience_line_master_id`로 활성 라인이 이미 해당 주차에 존재하면 409

서버 자동 설정:
- `part_type` = `'experience'`
- `line_code` = 마스터의 `line_code`
- `team_id` = 마스터의 `team_id` (마스터에 없으면 요청값 사용)
- `activity_type_id` = null (experience 는 activity_types 와 무관)

---

### 5-7. 개설된 실무 경험 라인 목록

기존 `GET /api/admin/cluster4/lines?partType=experience` 재사용.
신규 엔드포인트 불필요.

Response 에 `line_code`, `experience_line_master_id` 추가 필요 (LINE_SELECT 확장).

---

### 5-8. 평가 조회

```
GET /api/admin/cluster4/experience-evaluations?lineId={uuid}
```

| 항목 | 값 |
|---|---|
| Method | GET |
| URL | `/api/admin/cluster4/experience-evaluations` |
| Auth | requireAdminApi() |
| Query | `lineId` (필수, cluster4_lines.id) |
| Response | `{ success: true, data: EvaluationViewDto[] }` |
| 사용 화면 | 평가 관리 탭 |

```typescript
type EvaluationViewDto = {
  targetId: string;              // cluster4_line_targets.id
  userId: string;
  displayName: string;
  hasSubmission: boolean;        // cluster4_line_submissions 존재 여부
  evaluation: {
    id: string;
    rating: number;
    evaluatedBy: string | null;
    evaluatedAt: string | null;
  } | null;
};
```

서버 조합 로직:

```
1. cluster4_line_targets WHERE line_id = lineId
   → targetIds[], userIds[]

2. cluster4_line_submissions WHERE line_target_id IN (targetIds)
   → submittedTargetIds Set

3. cluster4_experience_line_evaluations WHERE line_target_id IN (targetIds)
   → evaluationMap (line_target_id → evaluation)

4. user_profiles WHERE user_id IN (userIds)
   → nameMap (user_id → display_name)

5. 조합 → EvaluationViewDto[]
```

---

### 5-9. 평가 생성

```
POST /api/admin/cluster4/experience-evaluations
```

| 항목 | 값 |
|---|---|
| Method | POST |
| URL | `/api/admin/cluster4/experience-evaluations` |
| Auth | requireAdminApi() |
| Request Body | `EvaluationCreateInput` |
| Response | `{ success: true, data: EvaluationDto }` (201) |
| 사용 화면 | 평가 관리 탭 [저장] (신규) |

```typescript
type EvaluationCreateInput = {
  line_target_id: string;    // 필수, UUID
  user_id: string;           // 필수, UUID
  rating: number;            // 필수, 0~10 정수
};
```

Validation:
- `line_target_id`: cluster4_line_targets 에 존재
- `user_id`: user_profiles 에 존재
- `rating`: 0~10 정수
- 제출 확인: cluster4_line_submissions 에 해당 line_target_id + user_id row 존재해야 함
  → 미제출자 평가 시도 시 400: "미제출 크루는 평가할 수 없습니다."
- 중복 확인: UNIQUE(line_target_id, user_id) 위반 시 409
  → "이미 평가가 존재합니다. 수정은 PATCH를 사용하세요."

서버 자동 설정:
- `evaluated_by` = 현재 admin_users.id
- `evaluated_at` = now()

---

### 5-10. 평가 수정

```
PATCH /api/admin/cluster4/experience-evaluations/[id]
```

| 항목 | 값 |
|---|---|
| Method | PATCH |
| URL | `/api/admin/cluster4/experience-evaluations/{id}` |
| Auth | requireAdminApi() |
| Request Body | `{ rating: number }` |
| Response | `{ success: true, data: EvaluationDto }` |
| 사용 화면 | 평가 관리 탭 [저장] (수정) |

Validation:
- `id`: cluster4_experience_line_evaluations 에 존재
- `rating`: 0~10 정수

서버 자동 설정:
- `evaluated_by` = 현재 admin_users.id
- `evaluated_at` = now()

---

### 5-11. API 요약 테이블

| # | Method | URL | 용도 | 우선순위 |
|---|---|---|---|---|
| 1 | GET | `/api/admin/cluster4/teams` | 팀 목록 | P1 |
| 2 | GET | `/api/admin/cluster4/experience-line-masters` | 마스터 목록 | P1 |
| 3 | POST | `/api/admin/cluster4/experience-line-masters` | 마스터 생성 | P1 |
| 4 | PATCH | `/api/admin/cluster4/experience-line-masters/[id]` | 마스터 수정/비활성화 | P1 |
| 5 | POST | `/api/admin/cluster4/experience-lines` | 라인 개설 | P2 |
| 6 | GET | `/api/admin/cluster4/lines?partType=experience` | 개설 라인 목록 (기존 API) | P2 |
| 7 | GET | `/api/admin/cluster4/experience-evaluations?lineId=` | 평가 조회 | P3 |
| 8 | POST | `/api/admin/cluster4/experience-evaluations` | 평가 생성 | P3 |
| 9 | PATCH | `/api/admin/cluster4/experience-evaluations/[id]` | 평가 수정 | P3 |

---

## 6. 데이터 흐름

### 6-1. 라인 마스터 → 라인 개설 → 평가

```
cluster4_teams
  │
  ├─→ cluster4_experience_line_masters.team_id
  │     │
  │     ├─→ cluster4_lines.experience_line_master_id
  │     │     │
  │     │     ├─→ cluster4_line_targets (대상 크루)
  │     │     │     │
  │     │     │     ├─→ cluster4_line_submissions (크루 제출)
  │     │     │     │
  │     │     │     └─→ cluster4_experience_line_evaluations (어드민 평가)
  │     │     │           rating (0~10) = points
  │     │     │
  │     │     └─→ cluster4_lines.line_code (마스터에서 복사)
  │     │
  │     └─→ cluster4_lines.team_id (마스터에서 복사 또는 직접 선택)
  │
  └─→ cluster4_lines.team_id (직접 선택)

organization_resume_card_settings.point_label
  └─→ UI 에서 "8 별", "8 단감" 등으로 표시
```

### 6-2. 화면별 데이터 소스

| 화면 | 읽기 | 쓰기 |
|---|---|---|
| 라인 마스터 탭 | experience_line_masters + teams | experience_line_masters |
| 라인 개설 탭 | current-week + experience_line_masters + teams + users + lines | lines + line_targets |
| 평가 관리 탭 | lines + line_targets + line_submissions + evaluations + user_profiles + org_settings | evaluations |

---

## 7. Validation 종합

### 7-1. 라인 마스터

| 필드 | 규칙 |
|---|---|
| `line_code` | 필수, unique, 수정 불가, 공백 trim |
| `line_name` | 필수, 1~100자 |
| `default_main_title` | 선택, null 허용, 1~200자 |
| `team_id` | 선택, null 허용, 존재 시 cluster4_teams 에 매칭 |
| `source_file_name` | 선택, null 허용 |
| `is_active` | boolean, 비활성화 시 활성 라인 존재 체크 |

### 7-2. 라인 개설

| 필드 | 규칙 |
|---|---|
| `experience_line_master_id` | 필수, UUID, 존재 + is_active 체크 |
| `main_title` | 필수, 비어있지 않음 |
| Output Asset | link + image 합산 1~2개 |
| `target_user_ids` | 최소 1명, user_profiles 존재 체크 |
| `week_id` | 필수, weeks 테이블 존재 체크 |
| 제출 기간 | 현재 주차 기준 자동 계산, 클라이언트 수정 불가 |
| 중복 | 같은 마스터 + 같은 주차 활성 라인 존재 시 409 |

### 7-3. 평가

| 필드 | 규칙 |
|---|---|
| `line_target_id` | 필수, cluster4_line_targets 존재 |
| `user_id` | 필수, user_profiles 존재 |
| `rating` | 0~10 정수, 필수 |
| 제출 확인 | line_submissions 에 row 존재해야 평가 가능 |
| 중복 | UNIQUE(line_target_id, user_id), 수정은 PATCH |

---

## 8. 구현 우선순위

### Phase 2-A: 라인 마스터 CRUD (P1)

1. `GET /api/admin/cluster4/teams` 구현
2. `GET /api/admin/cluster4/experience-line-masters` 구현
3. `POST /api/admin/cluster4/experience-line-masters` 구현
4. `PATCH /api/admin/cluster4/experience-line-masters/[id]` 구현
5. `ExperienceLineMastersTab.tsx` 컴포넌트 구현
6. `lib/adminLineOpening.ts` 에서 `practical-experience` 활성화

### Phase 2-B: 실무 경험 라인 개설 (P2)

7. `POST /api/admin/cluster4/experience-lines` 구현
8. 기존 `LINE_SELECT` / `Cluster4LineDto` 에 `lineCode`, `experienceLineMasterId` 추가
9. `ExperienceLineOpeningTab.tsx` 컴포넌트 구현

### Phase 2-C: 평가 관리 (P3)

10. `GET /api/admin/cluster4/experience-evaluations` 구현
11. `POST /api/admin/cluster4/experience-evaluations` 구현
12. `PATCH /api/admin/cluster4/experience-evaluations/[id]` 구현
13. `ExperienceEvaluationsTab.tsx` 컴포넌트 구현

### Phase 3: 엑셀 Import (후순위)

14. 엑셀 파싱 로직
15. bulk upsert API
16. Import UI

---

## 9. 미결 사항

### U-1. LINE_SELECT 확장 범위

기존 `LINE_SELECT` 상수와 `Cluster4LineDto` 타입에 `line_code`, `experience_line_master_id`를 추가해야 한다.
이 변경이 기존 info/career 라인 조회에 영향을 주는지 확인 필요.
→ `SELECT *` 이 아니라 명시적 컬럼 목록이므로, 추가만 하면 하위 호환성 문제 없음.

### U-2. 주차별 중복 라인 정책

같은 마스터로 같은 주차에 2개 이상 라인을 개설할 수 있는지?
→ 현재 설계: 활성 라인 기준 1개로 제한 (409). 비활성 라인은 히스토리로 보존.

### U-3. 벌크 평가 저장

현재 설계는 개별 행 저장. 향후 "전체 저장" 버튼으로 벌크 PATCH 지원 검토.
→ 벌크 API: `POST /api/admin/cluster4/experience-evaluations/bulk` (배열 입력)

### U-4. 평가 삭제

현재 설계에 평가 삭제(DELETE) 는 포함하지 않음.
운영 정책상 평가 취소가 필요하면 rating=0 으로 수정하거나, 별도 DELETE 엔드포인트 추가.

### U-5. 크루 필터링 (조직별)

라인 개설 시 크루 선택에서 조직 필터를 적용할지?
현재 `/api/admin/cluster4/users` 는 optional organization 필터 지원.
실무 경험은 조직 무관하게 전체 크루 대상인지, 조직별 분리인지 확인 필요.

### U-6. Output Asset 구조 확인

info-lines 는 link 2개 + image 배열이지만, experience-lines 는 link 1 + image 1 (최대 2개)로 단순화했다.
기획 확인 필요: link 2개가 필요한 경우가 있는지?

### U-7. 팀 CRUD

현재 `cluster4_teams` 는 seed 기반으로만 생성됨.
어드민에서 팀을 추가/수정/삭제할 수 있어야 하는지?
→ 현재 설계: 읽기 전용 드롭다운. 팀 관리 UI 는 향후 필요 시 추가.
