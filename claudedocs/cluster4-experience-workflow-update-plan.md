# Cluster4 실무 경험 워크플로우 업데이트 설계서

> **작성일**: 2026-05-28
> **상태**: 설계 및 영향도 검토 — 코드 수정 전
> **선행 문서**: `cluster4-experience-line-master-architecture.md`, `cluster4-experience-admin-ui-spec.md`

---

## 1. 변경 배경

### 1-1. 기존 설계

현재 실무 경험 어드민은 **관리자가 직접 라인을 개설**하는 단일 단계 구조이다.

```
[관리자] → 라인 마스터 선택 → 대상 사용자 선택 → 즉시 개설
                                                    ↓
                                           cluster4_lines 생성
                                           cluster4_line_targets 생성
```

### 1-2. 실제 운영 흐름

실제 운영은 3단계 승인 프로세스이다:

```
[파트장 입력] → [에이전트 검수] → [팀장 최종 개설]
  draft/submitted    approved/rejected     opened
  월요일 14:00까지    월요일 20:00까지       월요일 22:00까지
```

### 1-3. MVP 원칙

- 현재 역할별 계정 권한 미적용 상태
- **최고 관리자 계정 하나로 3단계 모두 조작** 가능해야 함
- 마감 시간은 안내 문구로만 표시, 시스템 제한 없음
- `entered_by` / `reviewed_by` / `opened_by` 필드를 저장하여 추후 권한 적용 대비

---

## 2. 기존 실무 경험 설계와의 차이

| 항목 | 기존 | 변경 후 |
|---|---|---|
| 탭 구조 | 라인 마스터 / 라인 개설 / 평가 관리 | 라인 마스터 / 입력 관리 / 검수 관리 / 최종 개설 |
| 라인 생성 시점 | 관리자가 즉시 생성 | 팀장 최종 개설 시에만 생성 |
| 중간 저장 | 없음 (바로 cluster4_lines) | draft 테이블에 초안 저장 |
| 평점 입력 | 미구현 (평가 관리 탭 비활성) | 파트장 입력 단계에 포함 |
| 검수 프로세스 | 없음 | 에이전트 검수 → 승인/반려 |
| 상태 추적 | 없음 | draft → submitted → approved → opened |

### 유지 항목

- **라인 마스터 CRUD**: 기존 `cluster4_experience_line_masters` 테이블 및 API 완전 유지
- **팀 마스터**: `cluster4_teams` 테이블 유지
- **크루 목록 조회**: `listCrewsForTargetSelection()` 함수 유지
- **이미지 업로드**: `/api/admin/cluster4/upload-image` 유지
- **주차 조회**: `/api/admin/cluster4/current-week` 유지

### 폐기 항목

- **기존 라인 개설 탭 UI**: `PracticalExperienceManager.tsx`의 "opening" 탭 전체 교체
- **기존 experience-lines POST API**: `app/api/admin/cluster4/experience-lines/route.ts` — draft 기반 흐름으로 대체
- **평가 관리 탭**: 별도 탭 불필요, 평점이 입력 단계에 흡수됨

### 검토 필요 항목

- **`cluster4_experience_line_evaluations` 테이블**: 현재 미사용. draft의 rating 필드와의 관계 정리 필요 (§5-3 참조)

---

## 3. 신규 3단계 워크플로우

### 3-1. 상태 전이 규칙

```
            ┌──────────┐
            │  draft    │  파트장 입력 중 (저장은 했으나 제출 전)
            └────┬─────┘
                 │ 제출
            ┌────▼─────┐
            │submitted  │  파트장 입력 완료
            └────┬─────┘
                 │
          ┌──────┴──────┐
          │              │
     ┌────▼─────┐  ┌────▼─────┐
     │ approved  │  │ rejected  │  에이전트 검수
     └────┬─────┘  └────┬─────┘
          │              │ 수정 후 재제출
          │         ┌────▼─────┐
          │         │submitted  │
          │         └──────────┘
     ┌────▼─────┐
     │  opened   │  팀장 최종 개설
     └──────────┘
```

**허용되는 상태 전이:**

| From | To | 행위자 | 조건 |
|---|---|---|---|
| (없음) | `draft` | 파트장 | 신규 초안 생성 |
| `draft` | `submitted` | 파트장 | 필수 항목 모두 입력 완료 |
| `draft` | `draft` | 파트장 | 수정 저장 |
| `submitted` | `approved` | 에이전트 | 검수 통과 |
| `submitted` | `rejected` | 에이전트 | 수정 필요 |
| `rejected` | `draft` | 파트장 | 수정 시작 (재입력) |
| `rejected` | `submitted` | 파트장 | 수정 완료 후 재제출 |
| `approved` | `opened` | 팀장 | 최종 개설 실행 |

**금지:**
- `opened` 이후 상태 변경 불가 (별도 취소 정책은 추후 정의)
- `approved` → `rejected` 역전이 불가 (재검수가 필요하면 운영 정책으로 처리)

### 3-2. 역할별 업무 및 마감 기준

| 단계 | 역할 | 운영 기준 마감 | MVP 적용 |
|---|---|---|---|
| 1단계 입력 | 파트장 | 매주 월요일 14:00 | 안내 문구만 (제한 없음) |
| 2단계 검수 | 에이전트 | 매주 월요일 20:00 | 안내 문구만 (제한 없음) |
| 3단계 개설 | 팀장 | 매주 월요일 22:00 | 안내 문구만 (제한 없음) |

---

## 4. 탭/화면 구조 제안

### 4-1. 페이지 경로

```
/admin/line-opening/practical-experience
```

기존 경로 유지. 내부 탭 구조만 변경.

### 4-2. 탭 구성

```
┌─────────────┬─────────────┬─────────────┬─────────────┐
│ 라인 마스터   │  입력 관리    │  검수 관리    │  최종 개설    │
└─────────────┴─────────────┴─────────────┴─────────────┘
```

기존 TabKey: `"masters" | "opening" | "evaluation"`
변경 TabKey: `"masters" | "input" | "review" | "open"`

### 4-3. 탭별 화면 요소

#### 탭 1: 라인 마스터 (기존 유지)

변경 없음. 기존 CRUD 그대로 유지.

- 마스터 목록 테이블 (line_code, line_name, mainTitle, team, isActive)
- [+ 새 마스터] → 인라인 생성 폼
- 수정/삭제 액션

#### 탭 2: 입력 관리

```
┌─────────────────────────────────────────────────────────────┐
│ 📅 현재 주차: S2 W04 (2026.05.25 ~ 05.31)                    │
│ ⏰ 입력 권장 마감: 월요일 오후 2:00                              │
├─────────────────────────────────────────────────────────────┤
│ 필터: [팀 ▼] [파트 ▼] [상태 ▼: 전체/미입력/draft/submitted]     │
├─────────────────────────────────────────────────────────────┤
│ 사용자 목록 테이블                                             │
│ ┌──────────┬──────┬──────┬────────┬────────┬──────┬──────┐ │
│ │ 사용자     │ 팀    │ 파트  │ 라인     │ 평점    │ 상태   │ 액션  │ │
│ ├──────────┼──────┼──────┼────────┼────────┼──────┼──────┤ │
│ │ 홍길동     │ A팀   │ 1파트 │ EX02A  │ 8      │ 제출완료│ 수정  │ │
│ │ 김철수     │ A팀   │ 1파트 │ -      │ -      │ 미입력 │ 입력  │ │
│ └──────────┴──────┴──────┴────────┴────────┴──────┴──────┘ │
├─────────────────────────────────────────────────────────────┤
│ 입력/수정 폼 (사용자 선택 시 확장)                               │
│ ┌─────────────────────────────────────────────────────────┐ │
│ │ 대상: 홍길동 (A팀 / 1파트)                                │ │
│ │ 라인 선택: [라인 마스터 드롭다운 ▼]                         │ │
│ │ Line Code: EX02A - ES0001 (자동)                         │ │
│ │ 메인 타이틀: [콘텐츠] 마케팅 실무 (자동, 수정 가능)            │ │
│ │ Output Link 1: [________________]                        │ │
│ │ Output Link 2: [________________]                        │ │
│ │ Output Image: [업로드] [업로드]                             │ │
│ │ 평점: [0~10 선택 ▼]                                       │ │
│ │ 메모: [________________] (선택)                            │ │
│ │                                                          │ │
│ │ [임시 저장 (draft)]  [제출 (submitted)]                     │ │
│ └─────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

**핵심 동작:**
- 저장 시 `cluster4_experience_line_drafts` 테이블에만 저장
- `cluster4_lines`는 생성하지 않음
- "임시 저장"은 `input_status: draft`, "제출"은 `input_status: submitted`
- 한 사용자에 대해 동일 주차에 여러 라인 입력 가능 (1:N)

#### 탭 3: 검수 관리

```
┌─────────────────────────────────────────────────────────────┐
│ 📅 현재 주차: S2 W04                                         │
│ ⏰ 검수 권장 마감: 월요일 오후 8:00                              │
├─────────────────────────────────────────────────────────────┤
│ 필터: [팀 ▼] [파트 ▼] [검수상태 ▼: 전체/미검수/승인/반려]         │
├─────────────────────────────────────────────────────────────┤
│ 제출 완료 항목 테이블 (input_status = 'submitted' 인 것만)       │
│ ┌──────────┬──────┬────────┬────────┬──────┬──────┬──────┐ │
│ │ 사용자     │ 팀    │ 라인     │ 평점    │ 검수상태│ 검수자 │ 액션  │ │
│ ├──────────┼──────┼────────┼────────┼──────┼──────┼──────┤ │
│ │ 홍길동     │ A팀   │ EX02A  │ 8      │ 미검수 │ -    │ 검수  │ │
│ │ 이영희     │ B팀   │ EX99A  │ 6      │ 승인   │ 관리자│ -    │ │
│ └──────────┴──────┴────────┴────────┴──────┴──────┴──────┘ │
├─────────────────────────────────────────────────────────────┤
│ 검수 상세 패널 (행 클릭 시)                                     │
│ ┌─────────────────────────────────────────────────────────┐ │
│ │ 입력 내용 전체 확인 (읽기 전용)                              │ │
│ │ - 라인: EX02A - ES0001 [콘텐츠] 마케팅 실무                │ │
│ │ - Output Link 1: https://...                             │ │
│ │ - 평점: 8                                                │ │
│ │ - 입력자: admin@... / 입력 시간: 2026.05.26 13:45          │ │
│ │                                                          │ │
│ │ 반려 사유: [________________] (반려 시 필수)                 │ │
│ │                                                          │ │
│ │ [승인 (approved)]  [반려 (rejected)]                       │ │
│ └─────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

**핵심 동작:**
- `input_status = 'submitted'`이면서 `review_status IN ('pending', 'approved', 'rejected')` 표시
- 승인: `review_status → approved`, `reviewed_by`, `reviewed_at` 기록
- 반려: `review_status → rejected`, `rejection_reason` 필수 입력, `reviewed_by`, `reviewed_at` 기록
- 반려 시 파트장이 수정 후 재제출 가능 (`input_status → draft` or `submitted`)

#### 탭 4: 최종 개설

```
┌─────────────────────────────────────────────────────────────┐
│ 📅 현재 주차: S2 W04                                         │
│ ⏰ 라인 개설 권장 마감: 월요일 오후 10:00                         │
├─────────────────────────────────────────────────────────────┤
│ 검수 완료 항목 (review_status = 'approved')                    │
│ ┌────┬──────────┬──────┬────────┬────────┬──────┬─────────┐│
│ │ ☐  │ 사용자     │ 팀    │ 라인     │ 평점    │ 검수자 │ 개설상태  ││
│ ├────┼──────────┼──────┼────────┼────────┼──────┼─────────┤│
│ │ ☑  │ 홍길동     │ A팀   │ EX02A  │ 8      │ 관리자│ 대기     ││
│ │ ☑  │ 이영희     │ B팀   │ EX99A  │ 6      │ 관리자│ 대기     ││
│ │ -  │ 박민수     │ A팀   │ EX02A  │ 7      │ 관리자│ 개설완료  ││
│ └────┴──────────┴──────┴────────┴────────┴──────┴─────────┘│
├─────────────────────────────────────────────────────────────┤
│ ⚠️ 미검수 항목 N건 경고 (검수 관리 탭 이동 링크)                  │
├─────────────────────────────────────────────────────────────┤
│ [선택 항목 일괄 개설]                                          │
└─────────────────────────────────────────────────────────────┘
```

**핵심 동작:**
- 체크박스로 다건 선택 → [일괄 개설] 클릭
- 개설 시 각 draft에 대해:
  1. `cluster4_lines` INSERT (part_type='experience')
  2. `cluster4_line_targets` INSERT (target_user_id 매핑)
  3. draft의 `open_status → opened`, `opened_line_id`, `opened_by`, `opened_at` 기록
- 개설 완료된 항목은 체크박스 비활성 + "개설완료" 뱃지

---

## 5. DB 변경안

### 5-1. 후보 비교

| 기준 | 후보 A: 신규 draft 테이블 | 후보 B: cluster4_lines 상태 컬럼 추가 |
|---|---|---|
| 의미 보존 | cluster4_lines = "개설된 라인"만 저장 | cluster4_lines에 draft가 섞임 |
| 고객 페이지 안전성 | draft가 cluster4_lines에 없으므로 노출 위험 없음 | WHERE workflow_status='opened' 필터 누락 시 draft 노출 |
| 기존 코드 영향 | 기존 cluster4_lines 조회 로직 변경 불필요 | 모든 기존 쿼리에 `workflow_status='opened'` 조건 추가 필요 |
| 검수/반려 이력 | draft 테이블에 자연스럽게 포함 | cluster4_lines에 review 관련 컬럼 혼재 |
| 코드 수정량 | 신규 API + 신규 UI (기존 코드 영향 적음) | 기존 API 전체 수정 + 고객 API 수정 |

**결론: 후보 A 채택 (신규 draft 테이블)**

기존 `cluster4_lines`의 의미("개설된 라인")를 유지하고, 고객 페이지에 draft가 노출될 위험을 원천 차단한다.

### 5-2. 신규 테이블: `cluster4_experience_line_drafts`

```
cluster4_experience_line_drafts
├── id                          uuid PK DEFAULT gen_random_uuid()
├── week_id                     uuid NOT NULL FK→weeks(id)
├── organization_slug           text NOT NULL DEFAULT 'oranke'
├── team_id                     uuid NULL FK→cluster4_teams(id)
├── part_name                   text NULL
├── target_user_id              uuid NOT NULL FK→user_profiles(user_id)
├── experience_line_master_id   uuid NOT NULL FK→cluster4_experience_line_masters(id)
├── line_code                   text NOT NULL
├── main_title                  text NOT NULL
├── output_link_1               text NULL
├── output_link_2               text NULL
├── output_images               text[] DEFAULT '{}'
├── rating                      smallint NULL CHECK (rating >= 0 AND rating <= 10)
├── memo                        text NULL
│
│  ── 상태 필드 ──
├── input_status                text NOT NULL DEFAULT 'draft'
│                               CHECK (input_status IN ('draft','submitted'))
├── review_status               text NOT NULL DEFAULT 'pending'
│                               CHECK (review_status IN ('pending','approved','rejected'))
├── open_status                 text NOT NULL DEFAULT 'pending'
│                               CHECK (open_status IN ('pending','opened'))
├── rejection_reason            text NULL
│
│  ── 행위자/시간 추적 ──
├── entered_by                  uuid NULL FK→admin_users(id)
├── entered_at                  timestamptz NULL
├── reviewed_by                 uuid NULL FK→admin_users(id)
├── reviewed_at                 timestamptz NULL
├── opened_by                   uuid NULL FK→admin_users(id)
├── opened_at                   timestamptz NULL
│
│  ── 개설 결과 연결 ──
├── opened_line_id              uuid NULL FK→cluster4_lines(id)
│
│  ── 시스템 ──
├── created_at                  timestamptz NOT NULL DEFAULT now()
└── updated_at                  timestamptz NOT NULL DEFAULT now()

UNIQUE(week_id, target_user_id, experience_line_master_id)
```

**인덱스:**
- `(week_id)` — 주차별 조회
- `(organization_slug, week_id)` — 조직+주차 필터
- `(target_user_id, week_id)` — 사용자별 주차 조회
- `(input_status, review_status, open_status)` — 상태 필터

**UNIQUE 제약:**
- `(week_id, target_user_id, experience_line_master_id)` — 동일 주차에 동일 사용자+동일 라인 중복 방지

### 5-3. 평점(rating)과 기존 evaluation 테이블의 관계

기존 `cluster4_experience_line_evaluations`는 **개설된 라인의 line_target_id 기준** 평가를 저장한다.

변경 후:
- **초안 평점**: `cluster4_experience_line_drafts.rating`에 저장 (파트장 입력 단계)
- **확정 평점**: 최종 개설 시 draft의 rating을 `cluster4_experience_line_evaluations`에 복사

이렇게 하면:
1. 파트장은 draft에서 평점 입력
2. 에이전트가 검수 시 평점도 확인
3. 팀장이 개설하면 → cluster4_lines + cluster4_line_targets 생성 → evaluations에 rating 복사
4. 고객 페이지는 기존대로 evaluations 조회

**대안**: evaluations 테이블을 사용하지 않고 draft.rating → cluster4_lines 확장 컬럼으로 옮기는 방식도 가능하나, 기존 evaluations 테이블이 line_target_id 기반이므로 현재 설계를 유지하는 것이 일관성 있음.

### 5-4. 기존 테이블 변경

**변경 없음.** 기존 테이블 (`cluster4_lines`, `cluster4_line_targets`, `cluster4_experience_line_masters`, `cluster4_experience_line_evaluations`)의 스키마는 수정하지 않는다.

---

## 6. API 계약 초안

### 6-1. 기존 유지 API

| API | 변경 | 비고 |
|---|---|---|
| GET `/api/admin/cluster4/experience-line-masters` | 없음 | 라인 마스터 목록 |
| POST `/api/admin/cluster4/experience-line-masters` | 없음 | 마스터 생성 |
| GET `/api/admin/cluster4/experience-line-masters/[id]` | 없음 | 마스터 상세 |
| PATCH `/api/admin/cluster4/experience-line-masters/[id]` | 없음 | 마스터 수정 |
| DELETE `/api/admin/cluster4/experience-line-masters/[id]` | 없음 | 마스터 삭제 |
| GET `/api/admin/cluster4/teams` | 없음 | 팀 목록 |
| GET `/api/admin/cluster4/crews` | 없음 | 크루 목록 |
| GET `/api/admin/cluster4/current-week` | 없음 | 현재 주차 |
| POST `/api/admin/cluster4/upload-image` | 없음 | 이미지 업로드 |

### 6-2. 폐기 API

| API | 사유 |
|---|---|
| POST `/api/admin/cluster4/experience-lines` | draft → open 흐름으로 대체 |

### 6-3. 신규 API

#### (1) Draft 목록 조회

```
GET /api/admin/cluster4/experience-drafts
```

| 항목 | 값 |
|---|---|
| Method | GET |
| Auth | ADMIN_READ_ROLES |
| Query Params | `week_id` (필수), `organization` (기본 'oranke'), `team`, `part`, `input_status`, `review_status`, `open_status` |

**Response 200:**
```json
{
  "success": true,
  "data": [
    {
      "id": "uuid",
      "weekId": "uuid",
      "organizationSlug": "oranke",
      "teamId": "uuid | null",
      "teamName": "A팀",
      "partName": "1파트",
      "targetUserId": "uuid",
      "targetUserName": "홍길동",
      "experienceLineMasterId": "uuid",
      "lineCode": "EX02A - ES0001",
      "lineName": "[콘텐츠] 마케팅 실무",
      "mainTitle": "[콘텐츠] 마케팅 실무",
      "outputLink1": "https://...",
      "outputLink2": null,
      "outputImages": [],
      "rating": 8,
      "memo": null,
      "inputStatus": "submitted",
      "reviewStatus": "pending",
      "openStatus": "pending",
      "rejectionReason": null,
      "enteredBy": "uuid",
      "enteredAt": "2026-05-26T13:45:00Z",
      "reviewedBy": null,
      "reviewedAt": null,
      "openedBy": null,
      "openedAt": null,
      "openedLineId": null,
      "createdAt": "2026-05-26T13:45:00Z",
      "updatedAt": "2026-05-26T13:45:00Z"
    }
  ]
}
```

#### (2) Draft 생성 (파트장 입력)

```
POST /api/admin/cluster4/experience-drafts
```

| 항목 | 값 |
|---|---|
| Method | POST |
| Auth | EXPERIENCE_LINE_WRITE_ROLES |

**Request Body:**
```json
{
  "week_id": "uuid",
  "organization_slug": "oranke",
  "team_id": "uuid | null",
  "part_name": "1파트",
  "target_user_id": "uuid",
  "experience_line_master_id": "uuid",
  "line_code": "EX02A - ES0001",
  "main_title": "[콘텐츠] 마케팅 실무",
  "output_link_1": "https://...",
  "output_link_2": null,
  "output_images": [],
  "rating": 8,
  "memo": null,
  "input_status": "draft" | "submitted"
}
```

**Validation:**
- `week_id`: 필수, UUID, weeks 테이블 존재 확인
- `target_user_id`: 필수, UUID, user_profiles 존재 확인
- `experience_line_master_id`: 필수, UUID, 활성 마스터 존재 확인
- `line_code`, `main_title`: 필수, 비어 있지 않을 것
- `rating`: 선택, 0~10 정수 (submitted 시 필수)
- `input_status`: `draft` 또는 `submitted`
- output 자산: submitted 시 최소 1개 필수 (link + image 합산), 최대 2개
- UNIQUE 위반 시 409

**상태 전이:**
- 신규 생성 → `input_status: draft|submitted`, `review_status: pending`, `open_status: pending`

**Response 201:**
```json
{
  "success": true,
  "data": { /* DraftDto */ }
}
```

#### (3) Draft 수정 (파트장 수정/재제출)

```
PATCH /api/admin/cluster4/experience-drafts/[id]
```

| 항목 | 값 |
|---|---|
| Method | PATCH |
| Auth | EXPERIENCE_LINE_WRITE_ROLES |

**Request Body:** 생성과 동일한 필드의 부분 집합.

**Validation:**
- `open_status = 'opened'`이면 수정 불가 (400)
- `review_status = 'approved'`이면 수정 불가 (400) — 승인 후 수정은 운영 정책으로 별도 처리
- `input_status`를 `submitted`로 변경 시 필수 항목 재검증
- `input_status`를 `draft`로 변경 시 `review_status → pending` 자동 리셋

**상태 전이:**
- `draft` → `draft` (수정 저장)
- `draft` → `submitted` (제출)
- `rejected` → `draft` (수정 시작)
- `rejected` → `submitted` (수정 완료 후 재제출, `review_status → pending` 리셋)

**Response 200:**
```json
{
  "success": true,
  "data": { /* DraftDto */ }
}
```

#### (4) Draft 검수 (에이전트)

```
PATCH /api/admin/cluster4/experience-drafts/[id]/review
```

| 항목 | 값 |
|---|---|
| Method | PATCH |
| Auth | EXPERIENCE_LINE_WRITE_ROLES |

**Request Body:**
```json
{
  "review_status": "approved" | "rejected",
  "rejection_reason": "수정 필요 사유..." // rejected 시 필수
}
```

**Validation:**
- draft의 `input_status`가 `submitted`가 아니면 400
- draft의 `open_status`가 `opened`이면 400
- `rejected` 시 `rejection_reason` 필수
- `approved` 시 `rejection_reason` 무시

**상태 전이:**
- `submitted` + `review_status: pending` → `review_status: approved|rejected`
- `reviewed_by`, `reviewed_at` 기록

**Response 200:**
```json
{
  "success": true,
  "data": { /* DraftDto */ }
}
```

#### (5) 최종 개설 (팀장)

```
POST /api/admin/cluster4/experience-drafts/open
```

| 항목 | 값 |
|---|---|
| Method | POST |
| Auth | EXPERIENCE_LINE_WRITE_ROLES |

**Request Body:**
```json
{
  "draft_ids": ["uuid1", "uuid2", "uuid3"]
}
```

**Validation:**
- 모든 draft_ids가 유효한 UUID
- 모든 draft의 `review_status = 'approved'` 확인
- 모든 draft의 `open_status = 'pending'` 확인 (이미 opened된 건 거부)
- 모든 draft의 week_id가 동일해야 함

**처리 로직 (트랜잭션):**

각 draft에 대해:
1. `cluster4_lines` INSERT
   - `part_type: 'experience'`
   - `experience_line_master_id`, `line_code`, `main_title`, `team_id` ← draft에서 복사
   - `output_link_1`, `output_link_2`, `output_images` ← draft에서 복사
   - `submission_opens_at`, `submission_closes_at` ← current_week에서 계산
   - `created_by`, `updated_by` ← 현재 admin

2. `cluster4_line_targets` INSERT
   - `line_id` ← 위에서 생성한 cluster4_lines.id
   - `week_id` ← draft.week_id
   - `target_mode: 'user'`
   - `target_user_id` ← draft.target_user_id

3. `cluster4_experience_line_evaluations` INSERT (rating이 있는 경우)
   - `line_target_id` ← 위에서 생성한 cluster4_line_targets.id
   - `user_id` ← draft.target_user_id
   - `rating` ← draft.rating
   - `evaluated_by` ← draft.entered_by (평점 입력자)
   - `evaluated_at` ← draft.entered_at

4. draft 업데이트
   - `open_status → 'opened'`
   - `opened_line_id` ← cluster4_lines.id
   - `opened_by` ← 현재 admin
   - `opened_at` ← now()

**동일 라인 마스터 + 주차에 여러 사용자가 있는 경우:**

같은 `experience_line_master_id` + `week_id`를 가진 draft들은 **하나의 `cluster4_lines`** 행을 공유해야 한다 (output 자산은 라인 단위, 대상 사용자는 line_targets로 분리).

따라서 개설 로직은:
1. draft_ids를 `(experience_line_master_id, week_id)` 기준으로 그룹핑
2. 그룹당 하나의 `cluster4_lines` 생성
3. 그룹 내 각 draft에 대해 `cluster4_line_targets` + `cluster4_experience_line_evaluations` 생성
4. 그룹 내 모든 draft의 `opened_line_id`에 동일한 line_id 기록

**Response 200:**
```json
{
  "success": true,
  "data": {
    "openedCount": 3,
    "linesCreated": 2,
    "targetsCreated": 3,
    "results": [
      {
        "draftId": "uuid",
        "lineId": "uuid",
        "targetId": "uuid",
        "status": "opened"
      }
    ]
  }
}
```

#### (6) 워크플로우 요약 조회

```
GET /api/admin/cluster4/experience-workflow-summary
```

| 항목 | 값 |
|---|---|
| Method | GET |
| Auth | ADMIN_READ_ROLES |
| Query Params | `week_id` (필수), `organization` (기본 'oranke') |

**Response 200:**
```json
{
  "success": true,
  "data": {
    "weekId": "uuid",
    "totalCrews": 45,
    "notEntered": 12,
    "drafts": 5,
    "submitted": 18,
    "approved": 8,
    "rejected": 2,
    "opened": 0
  }
}
```

각 탭에서 상단 요약 카드로 사용.

---

## 7. 권한 정책

### 7-1. 현재 MVP

| 기능 | 접근 권한 | 비고 |
|---|---|---|
| 라인 마스터 CRUD | `EXPERIENCE_LINE_WRITE_ROLES` = `["owner"]` | 기존 유지 |
| 입력 관리 (읽기) | `ADMIN_READ_ROLES` | 기존 유지 |
| 입력 관리 (쓰기) | `EXPERIENCE_LINE_WRITE_ROLES` | 최고 관리자만 |
| 검수 관리 | `EXPERIENCE_LINE_WRITE_ROLES` | 최고 관리자만 |
| 최종 개설 | `EXPERIENCE_LINE_WRITE_ROLES` | 최고 관리자만 |

모든 탭이 최고 관리자에게 열려 있으며, UI 문구로 "파트장 입력", "에이전트 검수", "팀장 개설" 역할을 표시한다.

### 7-2. 추후 역할 적용 시

| 기능 | 팀장 | 파트장 | 에이전트 | 최고 관리자 |
|---|---|---|---|---|
| 라인 마스터 | CRUD | 읽기 | 읽기 | CRUD |
| 입력 | 전체 입력 | 자기 파트만 | 읽기 | 전체 입력 |
| 검수 | 전체 검수 | 읽기 | 검수 | 전체 검수 |
| 최종 개설 | 개설 | - | - | 개설 |

구현 시 필요한 변경:
- `admin_users` 테이블에 role 컬럼 또는 별도 역할 테이블
- 파트장: `entered_by`와 `part_name` 기반 필터
- 에이전트: review 전용 API 접근
- 각 API에 역할별 분기 추가

---

## 8. 기존 구현에서 유지할 것 / 폐기할 것

### 유지

| 구성요소 | 파일 | 사유 |
|---|---|---|
| 라인 마스터 타입/파서 | `lib/adminExperienceLineTypes.ts` | 그대로 사용 |
| 라인 마스터 데이터 계층 | `lib/adminExperienceLineData.ts` | 마스터 CRUD + 크루 조회 유지 |
| 마스터 API 라우트 | `app/api/admin/cluster4/experience-line-masters/*` | 그대로 사용 |
| 팀 API | `app/api/admin/cluster4/teams/route.ts` | 그대로 사용 |
| 크루 API | `app/api/admin/cluster4/crews/route.ts` | 그대로 사용 |
| 주차 API | `app/api/admin/cluster4/current-week/route.ts` | 그대로 사용 |
| 이미지 업로드 | `app/api/admin/cluster4/upload-image/route.ts` | 그대로 사용 |
| 페이지 엔트리 | `app/(portal)/admin/line-opening/practical-experience/page.tsx` | 그대로 사용 |
| DB 마이그레이션 | `2026-05-27_cluster4_experience_phase1.sql` | 이미 적용됨 |
| PracticalExperienceManager의 "masters" 탭 | `components/admin/PracticalExperienceManager.tsx` | 탭 1은 코드 유지 |

### 교체/폐기

| 구성요소 | 파일 | 사유 |
|---|---|---|
| "opening" 탭 UI | `PracticalExperienceManager.tsx` 내 Tab 2 | draft 기반 입력/검수/개설로 교체 |
| "evaluation" 탭 UI | `PracticalExperienceManager.tsx` 내 Tab 3 | 평점이 입력 단계에 흡수 |
| experience-lines POST API | `app/api/admin/cluster4/experience-lines/route.ts` | draft → open 흐름으로 대체 |

### 신규 생성

| 구성요소 | 경로 (예상) | 설명 |
|---|---|---|
| Draft 타입/파서 | `lib/adminExperienceDraftTypes.ts` | DraftDto, Create/Patch 파서 |
| Draft 데이터 계층 | `lib/adminExperienceDraftData.ts` | Draft CRUD + 워크플로우 함수 |
| Draft 목록/생성 API | `app/api/admin/cluster4/experience-drafts/route.ts` | GET, POST |
| Draft 수정 API | `app/api/admin/cluster4/experience-drafts/[id]/route.ts` | PATCH |
| Draft 검수 API | `app/api/admin/cluster4/experience-drafts/[id]/review/route.ts` | PATCH |
| Draft 개설 API | `app/api/admin/cluster4/experience-drafts/open/route.ts` | POST |
| 워크플로우 요약 API | `app/api/admin/cluster4/experience-workflow-summary/route.ts` | GET |
| DB 마이그레이션 | `db/migrations/2026-05-28_experience_drafts.sql` | 신규 테이블 생성 |

---

## 9. 구현 우선순위

### Phase 1: DB + 데이터 계층

1. `cluster4_experience_line_drafts` 마이그레이션 SQL 작성 및 적용
2. `lib/adminExperienceDraftTypes.ts` — DTO, 파서
3. `lib/adminExperienceDraftData.ts` — CRUD 함수

### Phase 2: API 라우트

4. `GET /experience-drafts` — 목록 조회
5. `POST /experience-drafts` — 생성
6. `PATCH /experience-drafts/[id]` — 수정
7. `PATCH /experience-drafts/[id]/review` — 검수
8. `POST /experience-drafts/open` — 최종 개설
9. `GET /experience-workflow-summary` — 요약

### Phase 3: UI 교체

10. `PracticalExperienceManager.tsx` TabKey 변경 (`masters | input | review | open`)
11. 입력 관리 탭 구현
12. 검수 관리 탭 구현
13. 최종 개설 탭 구현
14. 기존 "opening" 탭 코드 제거
15. 기존 "evaluation" 탭 코드 제거

### Phase 4: 정리

16. `app/api/admin/cluster4/experience-lines/route.ts` 폐기 또는 redirect
17. 스모크 테스트: 전체 워크플로우 (입력 → 검수 → 개설 → 고객 카드 확인)

---

## 10. 미결 사항

### 10-1. 동일 라인 + 다수 사용자 그룹핑 정책

현재 기존 라인 개설은 "1 라인 : N 사용자"를 한 번에 처리한다. draft 테이블은 "1 draft = 1 사용자 + 1 라인"이다.

최종 개설 시 동일 `(experience_line_master_id, week_id)`를 가진 draft들을 하나의 `cluster4_lines`로 묶어야 하는데:

- **output 자산(link/image)이 draft마다 다를 수 있는가?**
  - 같은 라인이면 output은 동일해야 하는가, 사용자별로 다를 수 있는가?
  - 현재 기존 구조는 output이 라인 단위 (cluster4_lines에 저장)
  - → **결정 필요**: 동일 라인의 output은 첫 번째 draft 기준으로 통일? 또는 draft별 별도 output?

### 10-2. 반려 후 재검수 흐름

- 반려된 draft를 파트장이 수정 → 재제출 시 `review_status`를 `pending`으로 리셋하는 것이 맞는가?
- 검수 이력을 보존해야 하는가? (별도 이력 테이블 필요?)
- → **MVP에서는**: 리셋으로 처리, 이력은 `updated_at`으로만 추적

### 10-3. 주차 변경 시 draft 처리

- 현재 주차가 바뀌면 이전 주차의 미개설 draft는 어떻게 되는가?
  - 자동 만료? 다음 주차로 이월?
  - → **MVP에서는**: 수동 관리. UI에서 주차 선택 드롭다운으로 과거 주차도 조회 가능. 자동 만료 없음.

### 10-4. 평점 확정 시점

- draft.rating은 "초안 평점"인가, "확정 평점"인가?
- 에이전트 검수 시 평점을 수정할 수 있는가?
- → **제안**: draft.rating은 파트장이 입력한 초안. 에이전트는 검수만 하고 평점 수정 불가. 최종 개설 시 그대로 evaluations에 복사하여 확정.

### 10-5. 기존 experience-lines로 이미 개설된 데이터

- 기존 POST `/experience-lines`로 생성된 `cluster4_lines` 행이 있다면, 이 데이터는 유지하되 새 워크플로우에는 영향 없음
- 기존 데이터에는 `opened_line_id`가 연결된 draft가 없으므로, 최종 개설 탭에서는 표시되지 않음
- → **별도 마이그레이션 불필요**. 기존 데이터는 그대로 유효.

### 10-6. `cluster4_experience_line_evaluations` 테이블 유지 여부

- 현재 미사용 상태. 최종 개설 시 rating을 복사하는 대상으로 활용 제안.
- 대안: evaluations 테이블을 사용하지 않고, 고객 페이지에서 draft.rating을 직접 조회.
  - 이 경우 draft 테이블이 고객 페이지 API의 의존 대상이 되어 결합도가 높아짐.
- → **제안**: evaluations 테이블 유지. 개설 시 복사. 고객 페이지는 evaluations만 조회.
