# Cluster4 어드민 라인 개설 UI 설계서

> **작성일**: 2026-05-27
> **상태**: 설계 초안
> **기준 문서**: `cluster4-line-final-architecture.md`, `cluster4-line-implementation-impact-review.md`

---

## 1. 어드민 메뉴 구조

### 현재 상태

```
라인 개설 (Briefcase 아이콘)
  └── 실무 경력           ← 유일한 enabled 항목 (href: /admin/career-projects)
```

### 설계 목표 구조

```
라인 개설 (Briefcase 아이콘)
  ├── 실무 정보           href: /admin/line-opening/practical-info
  ├── 실무 경험           href: /admin/line-opening/practical-experience
  ├── 실무 역량           href: /admin/line-opening/practical-competency
  └── 실무 경력           href: /admin/career-projects (기존 유지)
```

### 메뉴 변경 사항

| 파일 | 변경 |
|---|---|
| `lib/adminLineOpening.ts` | 4개 파트 모두 `enabled: true` |
| `components/admin/Sidebar.tsx` | `matchPaths`에 `/admin/line-opening` 추가 |

### 라우트 구조

```
app/admin/line-opening/
  ├── practical-info/page.tsx
  ├── practical-experience/page.tsx
  └── practical-competency/page.tsx

app/admin/career-projects/         ← 기존 유지
  ├── page.tsx
  └── [id]/page.tsx
```

---

## 2. 공통 정책

### 2-1. 조직 범위 제한

- 운영자는 본인이 속한 club/organization의 데이터만 조회·수정 가능
- API 레벨에서 `admin_users.organization_id` 기반 필터링
- 다른 조직의 크루/사용자는 대상 선택 목록에 노출되지 않음

### 2-2. 주차 자동 지정

- 개설 주차는 **현재 개설 가능한 주차**로 자동 결정
- 판정 로직: `computeCurrentWeekInfo()` → 현재 날짜 기준 시즌 + 주차 번호 계산
- `weeks` 테이블에서 `start_date <= today <= end_date`인 행 조회
- 공식 휴식 주차(`is_official_rest = true`)는 개설 불가 → UI에 "이번 주는 공식 휴식 주차입니다" 표시
- 운영자는 주차를 직접 수정할 수 없음
- UI에는 현재 주차 정보만 읽기 전용으로 표시:
  - 예: `S1 시즌 · 4주차 (2026-05-25 ~ 2026-05-31)`

### 2-3. target_mode 정책

- Phase 1: `target_mode = 'user'`만 지원
- `target_mode = 'rule'`은 UI에 비활성화 상태로 표시하거나 숨김
- 모든 대상 지정은 개별 사용자 ID 기반

### 2-4. 제출 기간 자동 계산

운영자는 제출 기간을 설정하지 않음. 시스템이 자동 계산함.

```
submission_opens_at = 해당 주차 start_date의 00:00:00 KST
submission_closes_at = 해당 주차 수요일 22:00:00 KST
```

계산 방법:
- `weeks.start_date` → 해당 주차의 월요일 (또는 시작일)
- `start_date + 2일` = 수요일
- `submission_closes_at = 수요일 22:00:00 Asia/Seoul`

UI 표시:
- "제출 기간: 2026-05-25 (월) 00:00 ~ 2026-05-28 (수) 22:00" (읽기 전용)
- 수정 불가 — input이 아닌 텍스트로 표시

API 처리:
- POST 요청 시 클라이언트가 `submission_opens_at`, `submission_closes_at`을 보내지 않음
- 서버가 `week_id` 기반으로 자동 계산하여 저장

### 2-5. 사용자 2차 정보 입력 마감

- 항상 해당 주차 수요일 22:00 KST
- `submission_closes_at`와 동일
- UI에 안내 텍스트 표시: "크루원의 2차 정보 입력 마감: 수요일 22:00"

---

## 3. Output Asset 정책

### 3-1. 규칙

4개 허브 공통으로 운영자가 입력하는 Output Asset:

| 항목 | 설명 |
|---|---|
| Output Link | URL (텍스트 입력) |
| Output Image | 이미지 URL 또는 업로드 (텍스트 입력) |

제한:

```
Link 수 + Image 수 >= 1   (최소 1개)
Link 수 + Image 수 <= 2   (최대 2개)
```

허용 조합:

| Link | Image | 합계 | 허용 |
|---|---|---|---|
| 0 | 0 | 0 | **불가** |
| 1 | 0 | 1 | 허용 |
| 0 | 1 | 1 | 허용 |
| 1 | 1 | 2 | 허용 |
| 2 | 0 | 2 | 허용 |
| 0 | 2 | 2 | 허용 |
| 2 | 1 | 3 | **불가** |
| 1 | 2 | 3 | **불가** |
| 2 | 2 | 4 | **불가** |

### 3-2. 현재 DB 구조 검토

현재:
```
cluster4_lines.output_link_1    text NULL        — 링크 1개만 저장 가능
cluster4_lines.output_images    jsonb DEFAULT '[]' — 이미지 복수 저장 가능
```

정책 요구사항 대비:
- Link 2개 저장 → `output_link_1` 1개만으로 부족
- Image 2개 저장 → `output_images` jsonb로 충족

### 3-3. 대안 비교

| 대안 | 장점 | 단점 | 권장 |
|---|---|---|---|
| **A. output_link_2 컬럼 추가** | 단순, 기존 패턴 유지 | 컬럼 증가. 3개 이상 확장 시 또 추가 필요 | △ |
| **B. output_links jsonb로 변경** | 유연, 확장 용이 | output_link_1 기존 데이터 마이그레이션 필요. 프론트 호환 DTO 변환 필요 | △ |
| **C. output_assets jsonb 통합** | Link+Image 통합 관리. 타입 구분 포함 | 기존 컬럼 2개(output_link_1, output_images) 폐기 필요. 마이그레이션 복잡 | × |
| **D. 현 구조 유지 + UI 제한** | 마이그레이션 없음. 기존 코드 수정 최소 | Link 최대 1개 제한 (정책의 Link 2개 허용 불가) | × |

### 3-4. 권장안: B안 (output_links jsonb)

```
변경 전:
  output_link_1    text NULL

변경 후:
  output_links     jsonb NOT NULL DEFAULT '[]'::jsonb

기존 데이터 마이그레이션:
  output_links = CASE
    WHEN output_link_1 IS NOT NULL THEN jsonb_build_array(output_link_1)
    ELSE '[]'::jsonb
  END

output_link_1 컬럼:
  마이그레이션 후 DROP (또는 deprecated 마킹 후 Phase 2에서 DROP)
```

jsonb 형식:
```json
["https://example.com/link1", "https://example.com/link2"]
```

output_images 형식 (기존 유지):
```json
["https://example.com/image1.png", "https://example.com/image2.png"]
```

UI Validation:
```
length(output_links) + length(output_images) >= 1
length(output_links) + length(output_images) <= 2
```

### 3-5. 대안 유보: A안 (output_link_2 추가)

B안의 마이그레이션이 리스크로 판단될 경우 A안 채택 가능:

```
output_link_1    text NULL    — 기존 유지
output_link_2    text NULL    — 신규 추가

UI Validation:
  link_count = (output_link_1 ? 1 : 0) + (output_link_2 ? 1 : 0)
  image_count = length(output_images)
  link_count + image_count >= 1
  link_count + image_count <= 2
```

**최종 결정**: 구현 단계에서 마이그레이션 복잡도를 고려하여 A안 또는 B안 중 확정.
본 설계서에서는 두 안 모두 대응 가능하도록 UI를 설계함.

---

## 4. 공통 데이터 모델

### 4-1. cluster4_lines (어드민 1차 정보)

| 컬럼 | 타입 | NULL | DEFAULT | 용도 | 운영자 입력 |
|---|---|---|---|---|---|
| id | uuid | NOT NULL | gen_random_uuid() | PK | 자동 |
| part_type | text | NOT NULL | | info/experience/competency/career | 화면별 고정 |
| activity_type_id | text | NULL | | 활동 분류 식별자 | 드롭다운 선택 |
| main_title | text | NOT NULL | | 메인 타이틀 | 주관식 입력 |
| output_link_1 | text | NULL | | 운영자 링크 (A안) | 텍스트 입력 |
| output_images | jsonb | NOT NULL | '[]' | 운영자 이미지 | 텍스트 입력 |
| team_id | uuid | NULL | | 팀 지정 (experience 전용) | 드롭다운 선택 |
| career_project_id | uuid | NULL | | 경력 프로젝트 (career 전용) | 드롭다운 선택 |
| submission_opens_at | timestamptz | NOT NULL | | 제출 시작 | **시스템 자동** |
| submission_closes_at | timestamptz | NOT NULL | | 제출 마감 | **시스템 자동** |
| is_active | boolean | NOT NULL | true | 활성 여부 | 토글 |
| created_by | uuid | NULL | | 생성자 | 자동 |
| updated_by | uuid | NULL | | 수정자 | 자동 |
| created_at | timestamptz | NOT NULL | now() | 생성일 | 자동 |
| updated_at | timestamptz | NOT NULL | now() | 수정일 | 자동 |

### 4-2. cluster4_line_targets (주차 × 대상 매핑)

| 컬럼 | 타입 | NULL | 용도 | 운영자 입력 |
|---|---|---|---|---|
| id | uuid | NOT NULL | PK | 자동 |
| line_id | uuid | NOT NULL | FK → cluster4_lines | 자동 (라인 생성 시) |
| week_id | uuid | NOT NULL | FK → weeks | **시스템 자동** (현재 주차) |
| target_mode | text | NOT NULL | 'user' (Phase 1 고정) | 자동 고정 |
| target_user_id | uuid | NULL | FK → user_profiles | 크루원 선택 |
| target_rule | jsonb | NOT NULL | '{}' (Phase 1 미사용) | 없음 |
| created_by | uuid | NULL | 생성자 | 자동 |
| updated_by | uuid | NULL | 수정자 | 자동 |
| created_at | timestamptz | NOT NULL | 생성일 | 자동 |
| updated_at | timestamptz | NOT NULL | 수정일 | 자동 |

### 4-3. user_activity_details (사용자 2차 정보 — 참조용)

| 컬럼 | 타입 | 용도 |
|---|---|---|
| sub_title | text | 사용자가 입력하는 부제 |
| growth_point | text | 성장 포인트 |
| output_links | jsonb | 사용자 제출 링크 |
| image_urls | text[] | 사용자 이미지 URL |
| image_captions | text[] | 이미지 캡션 |
| rating | smallint | 평점 (0~10) |

이 테이블은 어드민 라인 개설 시 직접 조작하지 않음. 사용자가 프론트에서 입력.

---

## 5. 허브별 화면 설계

### 5-1. 실무 정보 (Practical Info)

**라우트**: `/admin/line-opening/practical-info`
**part_type**: `info`

#### 화면 레이아웃

```
┌─────────────────────────────────────────────────────────┐
│  실무 정보 라인 개설                                      │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  📅 현재 주차: S1 시즌 · 4주차 (2026-05-25 ~ 2026-05-31) │
│  ⏰ 제출 기간: 05-25 (월) 00:00 ~ 05-28 (수) 22:00       │
│  ℹ️ 크루원 2차 정보 입력 마감: 수요일 22:00               │
│                                                         │
│  ─────────────────────────────────────────────────────── │
│                                                         │
│  활동 유형 *                                             │
│  ┌──────────────────────────┐                            │
│  │ 위즈덤                 ▾ │  ← activity_types 드롭다운  │
│  └──────────────────────────┘     (cluster_id='practical_info')
│                                                         │
│  메인 타이틀 *                                             │
│  ┌──────────────────────────────────────────────────┐   │
│  │                                                  │   │
│  └──────────────────────────────────────────────────┘   │
│                                                         │
│  Output Asset (최소 1개, 최대 2개)                        │
│  ┌──────────────────────────────────────────────────┐   │
│  │ Link 1:  [________________________]              │   │
│  │ Link 2:  [________________________]  (선택)       │   │
│  │ Image 1: [________________________]  (선택)       │   │
│  │ Image 2: [________________________]  (선택)       │   │
│  │                                                  │   │
│  │ ※ Link + Image 합산 최소 1개, 최대 2개            │   │
│  │   현재: 1/2                                      │   │
│  └──────────────────────────────────────────────────┘   │
│                                                         │
│  개설 대상 크루 *                                        │
│  ┌──────────────────────────────────────────────────┐   │
│  │ □ 김철수  □ 이영희  □ 박민수  □ 최수진            │   │
│  │ □ 정대한  □ 한지연  □ 오승환  □ ...              │   │
│  │                                                  │   │
│  │ [전체 선택] [선택 해제]  선택됨: 5명               │   │
│  └──────────────────────────────────────────────────┘   │
│                                                         │
│               [취소]  [저장]                             │
└─────────────────────────────────────────────────────────┘
```

#### 입력 항목 상세

| 항목 | 입력 방식 | 필수 | 매핑 컬럼 |
|---|---|---|---|
| 활동 유형 | 드롭다운 (9개 info 타입) | 필수 | `cluster4_lines.activity_type_id` |
| 메인 타이틀 | 주관식 텍스트 | 필수 | `cluster4_lines.main_title` |
| Output Link 1 | URL 텍스트 | 조건부 | `cluster4_lines.output_link_1` |
| Output Link 2 | URL 텍스트 | 조건부 | `cluster4_lines.output_link_2` (A안) 또는 `output_links[1]` (B안) |
| Output Image 1 | URL 텍스트 | 조건부 | `cluster4_lines.output_images[0]` |
| Output Image 2 | URL 텍스트 | 조건부 | `cluster4_lines.output_images[1]` |
| 개설 대상 | 체크박스 멀티 선택 | 최소 1명 | `cluster4_line_targets.target_user_id` |

활동 유형 드롭다운 목록 (activity_types WHERE cluster_id = 'practical_info'):

| id | name |
|---|---|
| wisdom | 위즈덤 |
| essay | 에세이 |
| infodesk | 씽크탱크 |
| calendar | 캘린더 |
| forum | 포럼 |
| session | 세션 |
| practical_lecture | 프랙티컬 렉처 |
| community | 커뮤니티 |
| etc_a | 기타 A |

#### 저장 시 동작

1. `cluster4_lines` INSERT:
   - `part_type = 'info'`
   - `activity_type_id = 선택된 활동 유형 id`
   - `main_title = 입력된 제목`
   - `output_link_1, output_images = 입력된 asset`
   - `submission_opens_at, submission_closes_at = 시스템 자동 계산`
   - `is_active = true`
   - `created_by = 현재 어드민 user_id`

2. `cluster4_line_targets` BULK INSERT (선택된 크루 수만큼):
   - `line_id = 생성된 line.id`
   - `week_id = 현재 개설 가능 주차 id`
   - `target_mode = 'user'`
   - `target_user_id = 각 크루원 id`

#### 중복 방지

- `activity_type_id` 부분 UNIQUE (WHERE is_active = true)
- 이미 활성 상태인 라인이 존재하는 activity_type은 드롭다운에서 `(사용중)` 표시 + 선택 불가

---

### 5-2. 실무 경험 (Practical Experience)

**라우트**: `/admin/line-opening/practical-experience`
**part_type**: `experience`

#### 화면 레이아웃

```
┌─────────────────────────────────────────────────────────┐
│  실무 경험 라인 개설                                      │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  📅 현재 주차: S1 시즌 · 4주차 (2026-05-25 ~ 2026-05-31) │
│  ⏰ 제출 기간: 05-25 (월) 00:00 ~ 05-28 (수) 22:00       │
│                                                         │
│  ─────────────────────────────────────────────────────── │
│                                                         │
│  팀 *                                                    │
│  ┌──────────────────────────┐                            │
│  │ 디자인팀              ▾  │  ← teams 드롭다운          │
│  └──────────────────────────┘                            │
│                                                         │
│  활동 유형 *                                             │
│  ┌──────────────────────────┐                            │
│  │ exp-1                 ▾  │  ← activity_types 드롭다운  │
│  └──────────────────────────┘     (cluster_id='practical_experience')
│                                                         │
│  메인 타이틀                                               │
│  ┌──────────────────────────────────────────────────┐   │
│  │ (activity_types.name 자동 불러오기)               │   │
│  └──────────────────────────────────────────────────┘   │
│  ※ 활동 유형 선택 시 해당 name이 자동 입력됩니다.         │
│    운영자가 수정할 수 있습니다.                            │
│                                                         │
│  Output Asset (최소 1개, 최대 2개)                        │
│  ┌──────────────────────────────────────────────────┐   │
│  │ (실무 정보와 동일한 Asset 입력 UI)                │   │
│  └──────────────────────────────────────────────────┘   │
│                                                         │
│  개설 대상 크루 *                                        │
│  ┌──────────────────────────────────────────────────┐   │
│  │ (실무 정보와 동일한 크루 선택 UI)                 │   │
│  └──────────────────────────────────────────────────┘   │
│                                                         │
│               [취소]  [저장]                             │
└─────────────────────────────────────────────────────────┘
```

#### 입력 항목 상세

| 항목 | 입력 방식 | 필수 | 매핑 컬럼 |
|---|---|---|---|
| 팀 | 드롭다운 | 필수 | `cluster4_lines.team_id` |
| 활동 유형 | 드롭다운 (experience 타입) | 필수 | `cluster4_lines.activity_type_id` |
| 메인 타이틀 | 텍스트 (자동 입력 + 수정 가능) | 필수 | `cluster4_lines.main_title` |
| Output Asset | Link/Image 입력 | 최소 1개 | `output_link_1, output_images` |
| 개설 대상 | 체크박스 멀티 선택 | 최소 1명 | `cluster4_line_targets.target_user_id` |

#### main_title 자동 불러오기

- `activity_type_id` 선택 시 → `activity_types.name` 조회 → `main_title` 필드에 자동 입력
- 운영자가 수정 가능 (자동 입력은 기본값 역할)

#### rating 정책

- rating은 사용자가 프론트에서 입력하는 2차 정보 (`user_activity_details.rating`)
- 어드민 개설 시 rating을 설정하지 않음
- 어드민 목록 화면에서는 대상 크루원의 rating 현황을 조회할 수 있음 (읽기 전용)

---

### 5-3. 실무 역량 (Practical Competency)

**라우트**: `/admin/line-opening/practical-competency`
**part_type**: `competency`

#### 화면 레이아웃

```
┌─────────────────────────────────────────────────────────┐
│  실무 역량 라인 개설                                      │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  📅 현재 주차: S1 시즌 · 4주차 (2026-05-25 ~ 2026-05-31) │
│  ⏰ 제출 기간: 05-25 (월) 00:00 ~ 05-28 (수) 22:00       │
│                                                         │
│  ─────────────────────────────────────────────────────── │
│                                                         │
│  활동 유형 *                                             │
│  ┌──────────────────────────┐                            │
│  │ comp-1                ▾  │  ← activity_types 드롭다운  │
│  └──────────────────────────┘     (cluster_id='practical_competency')
│                                                         │
│  메인 타이틀 *                                             │
│  ┌──────────────────────────────────────────────────┐   │
│  │                                                  │   │
│  └──────────────────────────────────────────────────┘   │
│                                                         │
│  Output Asset (최소 1개, 최대 2개) — 전체 대상자 공통     │
│  ┌──────────────────────────────────────────────────┐   │
│  │ (실무 정보와 동일한 Asset 입력 UI)                │   │
│  │                                                  │   │
│  │ ※ 이 Output은 선택된 모든 대상자에게               │   │
│  │   동일하게 적용됩니다.                             │   │
│  └──────────────────────────────────────────────────┘   │
│                                                         │
│  ── 대상자 선택 방식 ──                                  │
│                                                         │
│  ○ 수동 선택 (Phase 1)                                  │
│  ● 카페 링크 집계 기반 (Phase 2 — 비활성)                │
│                                                         │
│  개설 대상 크루 * (수동 선택)                             │
│  ┌──────────────────────────────────────────────────┐   │
│  │ (실무 정보와 동일한 크루 선택 UI)                 │   │
│  └──────────────────────────────────────────────────┘   │
│                                                         │
│               [취소]  [저장]                             │
└─────────────────────────────────────────────────────────┘
```

#### Phase 1 vs Phase 2 대상 선택

| Phase | 방식 | 상태 |
|---|---|---|
| Phase 1 | 수동 대상자 선택 (체크박스) | **구현 대상** |
| Phase 2 | 카페 링크 집계 기반 대상자 자동 추출 | 설계만, 비활성 |

Phase 2 카페 링크 집계 설계 (미구현, 참고용):
```
1. 운영자가 카페 게시물 URL 입력
2. 시스템이 해당 게시물의 댓글 작성자 목록 추출
3. 댓글 작성자 ↔ 크루원 매칭
4. 매칭된 크루원을 자동으로 대상자 목록에 채움
5. 운영자가 검토 후 확정
```

#### 사용자별 라인 차이 구조

- 실무 역량은 사용자마다 **다른 라인이 할당될 수 있음**
- 예: 사용자 A는 comp-1 (디자인 역량), 사용자 B는 comp-2 (개발 역량)
- 현재 구조로 대응 가능:
  - `cluster4_lines` 1행 = 1개 activity_type_id (comp-1)
  - `cluster4_line_targets` N행 = 해당 라인에 속한 사용자들
  - 다른 activity_type의 역량 라인은 별도 `cluster4_lines` 행으로 개설
- 운영자 플로우: 같은 주차에 comp-1 라인과 comp-2 라인을 각각 개설하고, 각 라인에 해당 사용자를 배정

#### Output Asset 정책 (역량 특수)

- Output Link와 Output Image는 **모든 대상자에게 공통** 적용
- 1개의 라인에 속한 모든 target_user가 동일한 Output Asset을 참조
- 사용자별로 다른 Output이 필요하면 별도 라인으로 개설

---

### 5-4. 실무 경력 (Practical Career)

**라우트**: `/admin/career-projects` (기존 유지)
**part_type**: `career`

실무 경력은 기존 `career_projects` + `career_records` 체계를 유지하면서,
`cluster4_lines(part_type='career')`로 제출 기간을 관리하는 **이중 구조**.

#### 경력 관리 화면 구조

```
실무 경력
  ├── [탭 1] 경력 프로젝트 목록     ← 기존 career_projects CRUD
  ├── [탭 2] 경력 라인 개설          ← cluster4_lines(career) 생성
  └── [탭 3] 경력 기록 관리          ← career_records 조회/수정
```

#### 탭 1: 경력 프로젝트 목록 (기존)

기존 `/admin/career-projects` 페이지 유지.

관리 항목:
- 회사명, 로고, 직무
- 프로젝트명, 설명
- 라인 코드, 라인명
- Output Links, Output Images, 회사 홈페이지 링크
- Supervisor 정보 (이름, 직위, 부서, 회사, 프로필 이미지)
- 주차 연결 (career_project_weeks attach/detach/set_active)

#### 탭 2: 경력 라인 개설

```
┌─────────────────────────────────────────────────────────┐
│  경력 라인 개설                                          │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  📅 현재 주차: S1 시즌 · 4주차 (2026-05-25 ~ 2026-05-31) │
│  ⏰ 제출 기간: 05-25 (월) 00:00 ~ 05-28 (수) 22:00       │
│                                                         │
│  ─────────────────────────────────────────────────────── │
│                                                         │
│  경력 프로젝트 *                                         │
│  ┌──────────────────────────┐                            │
│  │ [ABC Corp] 웹 리뉴얼   ▾ │  ← career_projects 드롭다운 │
│  └──────────────────────────┘                            │
│  ※ 선택 시 해당 프로젝트의 정보가 하단에 요약 표시됩니다.  │
│                                                         │
│  ┌──────────────────────────────────────────────────┐   │
│  │ 📋 프로젝트 요약                                  │   │
│  │ 회사: ABC Corp                                   │   │
│  │ 직무: Frontend Developer                         │   │
│  │ Supervisor: 김매니저 (개발팀장)                    │   │
│  └──────────────────────────────────────────────────┘   │
│                                                         │
│  메인 타이틀 *                                             │
│  ┌──────────────────────────────────────────────────┐   │
│  │ (project_name 자동 입력, 수정 가능)               │   │
│  └──────────────────────────────────────────────────┘   │
│                                                         │
│  Output Asset (최소 1개, 최대 2개)                        │
│  ┌──────────────────────────────────────────────────┐   │
│  │ (공통 Asset 입력 UI)                              │   │
│  └──────────────────────────────────────────────────┘   │
│                                                         │
│  개설 대상 크루 *                                        │
│  ┌──────────────────────────────────────────────────┐   │
│  │ (공통 크루 선택 UI)                               │   │
│  └──────────────────────────────────────────────────┘   │
│                                                         │
│               [취소]  [저장]                             │
└─────────────────────────────────────────────────────────┘
```

#### 저장 시 동작 (경력 라인)

1. `cluster4_lines` INSERT:
   - `part_type = 'career'`
   - `activity_type_id = NULL` (career는 activity_type 대신 career_project_id 사용)
   - `career_project_id = 선택된 프로젝트 id`
   - `main_title = 입력된 제목`
   - `output_link_1, output_images = 입력된 asset`
   - `submission_opens_at, submission_closes_at = 시스템 자동 계산`

2. `cluster4_line_targets` BULK INSERT

3. `career_project_weeks` 자동 연결:
   - 해당 career_project + week 조합이 career_project_weeks에 없으면 자동 attach
   - `is_active = true`

#### 탭 3: 경력 기록 관리

```
┌─────────────────────────────────────────────────────────┐
│  경력 기록 관리                                          │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  경력 프로젝트 선택:                                     │
│  ┌──────────────────────────┐                            │
│  │ [ABC Corp] 웹 리뉴얼   ▾ │                            │
│  └──────────────────────────┘                            │
│                                                         │
│  ┌──────────────────────────────────────────────────┐   │
│  │ 크루원         │ 등급    │ 점수   │ 강화 상태     │   │
│  ├──────────────────────────────────────────────────┤   │
│  │ 김철수         │ A [▾]  │ 95     │ enhanced [▾]  │   │
│  │ 이영희         │ B+ [▾] │ 88     │ pending  [▾]  │   │
│  │ 박민수         │ — [▾]  │ —      │ not_applicable│   │
│  └──────────────────────────────────────────────────┘   │
│                                                         │
│  Supervisor 정보 수정                                    │
│  ┌──────────────────────────────────────────────────┐   │
│  │ 이름:     [김매니저          ]                     │   │
│  │ 직위:     [개발팀장          ]                     │   │
│  │ 부서:     [개발본부          ]                     │   │
│  │ 회사:     [ABC Corp         ]                     │   │
│  │ 프로필:   [URL              ]                     │   │
│  └──────────────────────────────────────────────────┘   │
│                                                         │
│               [저장]                                    │
└─────────────────────────────────────────────────────────┘
```

#### career_records 관리 항목

| 항목 | 입력 방식 | 매핑 컬럼 |
|---|---|---|
| 등급 (grade) | 드롭다운 (A/A-/B+/B/B-/C+/C/D/F) | `career_records.grade` |
| 점수 (grade_points) | 숫자 입력 | `career_records.grade_points` |
| 강화 상태 | 드롭다운 (4-state) | `career_records.enhancement_status` |

enhancement_status 4-state:
- `not_applicable`: 해당 없음
- `pending`: 대기
- `enhanced`: 강화 완료
- `failed`: 강화 실패

#### Supervisor 정보

- career_projects 테이블의 supervisor_* 컬럼
- 경력 기록 관리 탭에서 직접 수정 가능
- 수정 시 PATCH /admin/career-projects/[id] 호출

---

## 6. API 계약 초안

### 6-1. 공통 조회 API

#### GET /api/admin/cluster4/current-week

현재 개설 가능한 주차 정보 조회.

| 항목 | 값 |
|---|---|
| URL | `/api/admin/cluster4/current-week` |
| Method | GET |
| 사용 화면 | 4개 허브 공통 (주차 표시 + 제출 기간 계산) |

Request: 없음 (서버에서 현재 날짜 기준 자동 판정)

Response:
```json
{
  "success": true,
  "data": {
    "weekId": "uuid",
    "seasonKey": "2026-S1",
    "weekNumber": 4,
    "startDate": "2026-05-25",
    "endDate": "2026-05-31",
    "isOfficialRest": false,
    "submissionOpensAt": "2026-05-25T00:00:00+09:00",
    "submissionClosesAt": "2026-05-28T22:00:00+09:00",
    "canOpen": true
  }
}
```

`canOpen = false`인 경우 (공식 휴식 주차):
```json
{
  "success": true,
  "data": {
    "weekId": "uuid",
    "seasonKey": "2026-S1",
    "weekNumber": 7,
    "startDate": "2026-06-15",
    "endDate": "2026-06-21",
    "isOfficialRest": true,
    "holidayName": "공식 휴식",
    "submissionOpensAt": null,
    "submissionClosesAt": null,
    "canOpen": false
  }
}
```

---

#### GET /api/admin/cluster4/activity-types

활동 유형 목록 조회.

| 항목 | 값 |
|---|---|
| URL | `/api/admin/cluster4/activity-types` |
| Method | GET |
| Query | `cluster_id` (필수): `practical_info` / `practical_experience` / `practical_competency` / `practical_career` |
| 사용 화면 | 실무 정보, 실무 경험, 실무 역량 |

Request:
```
GET /api/admin/cluster4/activity-types?cluster_id=practical_info
```

Response:
```json
{
  "success": true,
  "data": [
    {
      "id": "wisdom",
      "name": "위즈덤",
      "lineCode": "wisdom",
      "description": null,
      "isActive": true,
      "hasActiveLine": false
    },
    {
      "id": "essay",
      "name": "에세이",
      "lineCode": "essay",
      "description": null,
      "isActive": true,
      "hasActiveLine": true
    }
  ]
}
```

`hasActiveLine = true`: 이미 활성 라인이 존재 → 드롭다운에서 선택 불가 표시

---

#### GET /api/admin/cluster4/crews

조직 내 크루원 목록 조회.

| 항목 | 값 |
|---|---|
| URL | `/api/admin/cluster4/crews` |
| Method | GET |
| Query | `organization` (자동: 어드민 소속 조직) |
| 사용 화면 | 4개 허브 공통 (대상 크루 선택) |

Response:
```json
{
  "success": true,
  "data": [
    {
      "userId": "uuid",
      "displayName": "김철수",
      "profileImg": "url",
      "role": "member",
      "approvedWeekCount": 12
    }
  ]
}
```

---

#### GET /api/admin/cluster4/teams

팀 목록 조회.

| 항목 | 값 |
|---|---|
| URL | `/api/admin/cluster4/teams` |
| Method | GET |
| 사용 화면 | 실무 경험 (팀 선택) |

Response:
```json
{
  "success": true,
  "data": [
    {
      "id": "uuid",
      "name": "디자인팀",
      "memberCount": 5
    }
  ]
}
```

---

### 6-2. 라인 CRUD API

#### GET /api/admin/cluster4/lines

라인 목록 조회 (기존).

| 항목 | 값 |
|---|---|
| URL | `/api/admin/cluster4/lines` |
| Method | GET |
| Query | `partType`, `weekId`, `q`, `limit`, `offset` |
| 사용 화면 | 4개 허브 목록 화면 |

Response: 기존 `ListCluster4LinesResult` + 신규 필드 (`activityTypeId`, `outputImages`, `teamId`, `careerProjectId`)

---

#### POST /api/admin/cluster4/lines

라인 생성.

| 항목 | 값 |
|---|---|
| URL | `/api/admin/cluster4/lines` |
| Method | POST |
| 사용 화면 | 4개 허브 생성 폼 |

Request:
```json
{
  "part_type": "info",
  "activity_type_id": "wisdom",
  "main_title": "이번 주 위즈덤",
  "output_link_1": "https://example.com/wisdom",
  "output_link_2": null,
  "output_images": ["https://example.com/img1.png"],
  "team_id": null,
  "career_project_id": null,
  "target_user_ids": ["uuid1", "uuid2", "uuid3"]
}
```

**주의**: `submission_opens_at`, `submission_closes_at`은 요청에 포함하지 않음.
서버가 current-week 기반으로 자동 계산.

Response:
```json
{
  "success": true,
  "data": {
    "line": { "id": "uuid", ... },
    "targets": [
      { "id": "uuid", "lineId": "uuid", "weekId": "uuid", "targetUserId": "uuid1" },
      { "id": "uuid", "lineId": "uuid", "weekId": "uuid", "targetUserId": "uuid2" }
    ],
    "targetCount": 3
  }
}
```

설계 포인트:
- `target_user_ids` 배열을 body에 포함하여 **라인 + 타겟을 한 번에 생성**
- 2-step (라인 생성 → 타겟 추가) 대비 UX 단순화
- 서버에서 트랜잭션으로 처리

---

#### PATCH /api/admin/cluster4/lines/[id]

라인 수정 (기존).

| 항목 | 값 |
|---|---|
| URL | `/api/admin/cluster4/lines/{id}` |
| Method | PATCH |
| 사용 화면 | 라인 수정 모달/폼 |

Request (부분 수정):
```json
{
  "main_title": "수정된 제목",
  "output_link_1": "https://new-link.com",
  "is_active": false
}
```

---

#### POST /api/admin/cluster4/lines/[id]/targets

타겟 추가 (기존).

| 항목 | 값 |
|---|---|
| URL | `/api/admin/cluster4/lines/{id}/targets` |
| Method | POST |
| 사용 화면 | 대상 크루 추가 |

Request:
```json
{
  "week_id": "uuid",
  "target_mode": "user",
  "target_user_id": "uuid"
}
```

---

#### DELETE /api/admin/cluster4/lines/[id]/targets/[targetId]

타겟 삭제 (기존).

| 항목 | 값 |
|---|---|
| URL | `/api/admin/cluster4/lines/{id}/targets/{targetId}` |
| Method | DELETE |
| 사용 화면 | 대상 크루 제거 |

---

### 6-3. 경력 전용 API

#### GET /api/admin/career-projects

경력 프로젝트 목록 (기존).

| 항목 | 값 |
|---|---|
| URL | `/api/admin/career-projects` |
| Method | GET |
| Query | `q`, `limit`, `offset` |
| 사용 화면 | 실무 경력 > 경력 프로젝트 목록 탭 |

---

#### POST /api/admin/career-projects

경력 프로젝트 생성 (기존).

| 항목 | 값 |
|---|---|
| URL | `/api/admin/career-projects` |
| Method | POST |
| 사용 화면 | 실무 경력 > 경력 프로젝트 생성 |

---

#### PATCH /api/admin/career-projects/[id]

경력 프로젝트 수정 (기존).

| 항목 | 값 |
|---|---|
| URL | `/api/admin/career-projects/{id}` |
| Method | PATCH |
| 사용 화면 | 실무 경력 > Supervisor 정보 수정, 프로젝트 수정 |

---

#### GET /api/admin/career-records

경력 기록 조회.

| 항목 | 값 |
|---|---|
| URL | `/api/admin/career-records` |
| Method | GET |
| Query | `project_id` (필수), `week_id` (선택) |
| 사용 화면 | 실무 경력 > 경력 기록 관리 탭 |

Response:
```json
{
  "success": true,
  "data": [
    {
      "id": "uuid",
      "projectId": "uuid",
      "userId": "uuid",
      "displayName": "김철수",
      "weekId": "uuid",
      "grade": "A",
      "gradePoints": 95,
      "enhancementStatus": "enhanced"
    }
  ]
}
```

---

#### PATCH /api/admin/career-records/[id]

경력 기록 수정.

| 항목 | 값 |
|---|---|
| URL | `/api/admin/career-records/{id}` |
| Method | PATCH |
| 사용 화면 | 실무 경력 > 경력 기록 관리 탭 |

Request:
```json
{
  "grade": "A",
  "grade_points": 95,
  "enhancement_status": "enhanced"
}
```

---

### 6-4. API 전체 목록 요약

| # | Method | URL | 신규/기존 | 사용 화면 |
|---|---|---|---|---|
| 1 | GET | /api/admin/cluster4/current-week | **신규** | 4개 허브 공통 |
| 2 | GET | /api/admin/cluster4/activity-types | **신규** | info, experience, competency |
| 3 | GET | /api/admin/cluster4/crews | **신규** | 4개 허브 공통 |
| 4 | GET | /api/admin/cluster4/teams | **신규** | experience |
| 5 | GET | /api/admin/cluster4/lines | 기존 (확장) | 4개 허브 목록 |
| 6 | POST | /api/admin/cluster4/lines | 기존 (확장) | 4개 허브 생성 |
| 7 | PATCH | /api/admin/cluster4/lines/[id] | 기존 | 라인 수정 |
| 8 | POST | /api/admin/cluster4/lines/[id]/targets | 기존 | 타겟 추가 |
| 9 | DELETE | /api/admin/cluster4/lines/[id]/targets/[targetId] | 기존 | 타겟 삭제 |
| 10 | GET | /api/admin/career-projects | 기존 | 경력 프로젝트 목록 |
| 11 | POST | /api/admin/career-projects | 기존 | 경력 프로젝트 생성 |
| 12 | PATCH | /api/admin/career-projects/[id] | 기존 | 경력 프로젝트 수정 |
| 13 | GET | /api/admin/career-records | **신규** | 경력 기록 조회 |
| 14 | PATCH | /api/admin/career-records/[id] | **신규** | 경력 기록 수정 |

신규 API: 5개 (#1, #2, #3, #4, #13, #14 중 #13, #14 합산)
기존 확장: 2개 (#5, #6)
기존 유지: 5개 (#7, #8, #9, #10, #11, #12)

---

## 7. Validation 규칙

### 7-1. 공통 규칙

| 필드 | 규칙 | 에러 메시지 |
|---|---|---|
| main_title | 필수, 비어있으면 안 됨 | "메인 타이틀은 필수입니다" |
| activity_type_id | info/experience/competency: 필수 | "활동 유형을 선택해주세요" |
| activity_type_id | career: NULL 허용 (career_project_id 대신 사용) | — |
| target_user_ids | 최소 1명 | "개설 대상을 최소 1명 이상 선택해주세요" |
| Output Asset 합산 | `link_count + image_count >= 1` | "Output을 최소 1개 입력해주세요" |
| Output Asset 합산 | `link_count + image_count <= 2` | "Output은 최대 2개까지 입력 가능합니다" |
| Output Link | URL 형식 검증 | "유효한 URL을 입력해주세요" |
| Output Image | URL 형식 검증 | "유효한 이미지 URL을 입력해주세요" |
| submission_opens_at | 시스템 자동 — 운영자 수정 불가 | — |
| submission_closes_at | 시스템 자동 — 운영자 수정 불가 | — |

### 7-2. 허브별 추가 규칙

| 허브 | 필드 | 규칙 | 에러 메시지 |
|---|---|---|---|
| info | activity_type_id | 활성 라인 중복 불가 (부분 UNIQUE) | "해당 활동 유형에 이미 활성 라인이 존재합니다" |
| experience | team_id | 필수 | "팀을 선택해주세요" |
| experience | activity_type_id | cluster_id='practical_experience' | "실무 경험 유형만 선택할 수 있습니다" |
| competency | activity_type_id | cluster_id='practical_competency' | "실무 역량 유형만 선택할 수 있습니다" |
| career | career_project_id | 필수 | "경력 프로젝트를 선택해주세요" |
| career | activity_type_id | NULL (사용 안 함) | — |

### 7-3. 서버 Validation

| 검증 | 위치 | 설명 |
|---|---|---|
| 주차 유효성 | POST /lines | current-week이 공식 휴식인지 확인 → 휴식이면 400 |
| 조직 범위 | POST /lines | target_user_ids의 사용자가 어드민 소속 조직인지 확인 |
| 활성 라인 중복 | POST /lines | activity_type_id 부분 UNIQUE 위반 시 409 |
| career_project 존재 | POST /lines | career_project_id가 유효한 UUID이고 존재하는지 확인 |
| team 존재 | POST /lines | team_id가 유효한 UUID이고 존재하는지 확인 |
| Output Asset 합산 | POST /lines | 서버에서도 합산 1~2 범위 재검증 |

### 7-4. 클라이언트 Validation (UX)

| 검증 | 시점 | 동작 |
|---|---|---|
| 필수값 미입력 | 저장 버튼 클릭 시 | 해당 필드 하단에 에러 메시지 표시 |
| Output Asset 초과 | 3번째 입력 시도 시 | 추가 입력 필드 비활성화 |
| 활동 유형 사용중 | 드롭다운 렌더링 시 | `(사용중)` 라벨 + disabled |
| 공식 휴식 주차 | 페이지 로드 시 | 폼 전체 비활성화 + 안내 메시지 |

---

## 8. 구현 우선순위

### Phase A: 기반 (Migration + API)

| 순서 | 작업 | 의존 |
|---|---|---|
| A-1 | cluster4_lines 컬럼 추가 (activity_type_id, output_images, team_id, career_project_id) | 없음 |
| A-2 | activity_types CHECK 변경 + practical_info 9개 seed | 없음 |
| A-3 | Output Link 구조 결정 (A안 output_link_2 vs B안 output_links jsonb) + 마이그레이션 | A-1 |
| A-4 | 어드민 타입/DTO/파서에 신규 필드 반영 (adminCluster4LinesTypes.ts) | A-1 |
| A-5 | 어드민 데이터 레이어에 신규 필드 반영 (adminCluster4LinesData.ts) | A-4 |

### Phase B: 신규 API

| 순서 | 작업 | 의존 |
|---|---|---|
| B-1 | GET /api/admin/cluster4/current-week | A-1 |
| B-2 | GET /api/admin/cluster4/activity-types | A-2 |
| B-3 | GET /api/admin/cluster4/crews | 없음 |
| B-4 | GET /api/admin/cluster4/teams | 없음 |
| B-5 | POST /api/admin/cluster4/lines 확장 (일괄 생성: line + targets) | A-5, B-1 |
| B-6 | GET/PATCH /api/admin/career-records | 없음 |

### Phase C: 어드민 UI

| 순서 | 작업 | 의존 |
|---|---|---|
| C-1 | adminLineOpening.ts 4개 파트 enabled | 없음 |
| C-2 | 실무 정보 개설 페이지 | B-1, B-2, B-3, B-5 |
| C-3 | 실무 경험 개설 페이지 | B-1, B-2, B-3, B-4, B-5 |
| C-4 | 실무 역량 개설 페이지 | B-1, B-2, B-3, B-5 |
| C-5 | 실무 경력 탭 구조 + 경력 라인 개설 | B-1, B-5, B-6 |
| C-6 | 경력 기록 관리 UI | B-6 |

### Phase D: 검증

| 순서 | 작업 |
|---|---|
| D-1 | info 라인 개설 → 카드 표시 확인 |
| D-2 | experience 라인 개설 → 팀 연결 확인 |
| D-3 | competency 라인 개설 → 대상자별 라인 분리 확인 |
| D-4 | career 라인 개설 → career_projects 연동 확인 |
| D-5 | Output Asset 합산 제한 검증 |
| D-6 | 제출 기간 자동 계산 검증 |
| D-7 | 중복 activity_type_id 방지 검증 |

---

## 9. 미결 사항

### 9-1. Output Link 구조 확정

- A안 (output_link_2 추가) vs B안 (output_links jsonb) 중 최종 선택 필요
- 기존 output_link_1 데이터의 마이그레이션 전략 확정 필요
- 결정 기한: Phase A 시작 전

### 9-2. 부분 UNIQUE 인덱스 범위

- 현재: `UNIQUE (activity_type_id) WHERE is_active = true`
- 실무 경험의 팀별 멀티 라인 필요 시: `UNIQUE (activity_type_id, team_id) WHERE is_active = true`
- Phase 1에서는 단순 UNIQUE 유지. 팀별 분리 요구 시 조정.

### 9-3. 카페 링크 집계 (Phase 2)

- 실무 역량의 Phase 2 대상자 자동 추출 UI 설계
- 카페 API 연동 또는 수동 URL 입력 → 댓글 파싱 방식 결정
- Phase 1 구현 후 요구사항 재확인 필요

### 9-4. 경력 라인과 career_project_weeks 이중 관리

- cluster4_line_targets (career) + career_project_weeks가 같은 주차 데이터를 관리
- 현재: 양쪽 병존 허용
- 장기: 통합 또는 한쪽 폐기 결정 필요

### 9-5. 실무 경험 main_title 자동 불러오기 소스

- activity_types.name을 기본값으로 사용할지
- 기존에 정의된 별도 마스터 테이블이 있는지 확인 필요
- 운영자가 수정 가능하므로 자동 입력은 편의 기능

### 9-6. 크루원 목록 조회 범위

- `approved` 상태 크루원만 표시할지
- 승인 대기(`pending`) 크루원도 대상 선택 가능한지
- approved_weeks 기반 적격성 필터 적용 여부 (activity_types.eligible_min/max_approved_weeks)

### 9-7. 라인 수정/삭제 정책

- 이미 submission이 존재하는 라인의 수정 범위
- 타겟 삭제 시 해당 submission 처리 방침
- is_active = false로 비활성화 시 프론트 노출 정책

---

## 10. 메인 타이틀 Preset 설계 (구현 미포함)

### 10-1. 배경

향후에는 주차별 메인 타이틀 데이터가 엑셀로 존재함.
과거 주차에는 해당 데이터를 불러와서 자동 입력하고,
현재 또는 미래 주차에는 운영자가 주관식으로 직접 입력하는 방식.

### 10-2. Preset 테이블 설계 (안)

```
cluster4_info_line_presets

id                uuid         PK  DEFAULT gen_random_uuid()
week_id           uuid         NOT NULL  FK → weeks.id
activity_type_id  text         NOT NULL  FK → activity_types.id
main_title        text         NOT NULL
output_links      jsonb        NOT NULL  DEFAULT '[]'
output_images     jsonb        NOT NULL  DEFAULT '[]'
source            text         NOT NULL  DEFAULT 'manual'  CHECK: excel/manual
created_at        timestamptz  NOT NULL  DEFAULT now()
updated_at        timestamptz  NOT NULL  DEFAULT now()

UNIQUE (week_id, activity_type_id)
```

### 10-3. 필드 설명

| 필드 | 설명 |
|---|---|
| week_id | 해당 preset이 속한 주차 |
| activity_type_id | 활동 유형 (wisdom, essay, ...) |
| main_title | 미리 설정된 메인 타이틀 텍스트 |
| output_links | 미리 설정된 Output Link 목록 (jsonb array) |
| output_images | 미리 설정된 Output Image URL 목록 (jsonb array) |
| source | 데이터 출처 — `excel`: 엑셀 import, `manual`: 수동 입력 |

### 10-4. 조회 방식

```
과거 주차 (week.end_date < today):
  1. GET /api/admin/cluster4/info-presets?week_id={id}
  2. 해당 주차의 preset 목록 반환
  3. 운영자가 활동 유형 선택 시 preset에서 main_title, output_links, output_images 자동 입력
  4. 운영자가 수정 가능

현재/미래 주차:
  1. preset 없음 또는 무시
  2. 현행과 동일하게 운영자가 직접 입력
```

### 10-5. 엑셀 Import 플로우 (향후)

```
1. 운영자가 엑셀 파일 업로드 (특정 포맷)
2. 서버에서 파싱:
   - 주차 → week_id 매핑
   - 활동 유형 → activity_type_id 매핑
   - 메인 타이틀, Output Link/Image 추출
3. cluster4_info_line_presets에 UPSERT (source = 'excel')
4. 이미 해당 (week_id, activity_type_id)에 preset이 있으면 덮어쓰기
5. Import 결과 리포트 (성공/실패 건수)
```

### 10-6. 현재 UI와의 관계

- 현재 구현: 메인 타이틀은 항상 운영자가 직접 입력
- Preset 구현 시: 활동 유형 선택 시 preset 존재 여부 확인 → 있으면 자동 입력 + 수정 가능
- 운영자가 직접 입력한 값이 항상 최종 저장값 (preset은 초기값 역할)
