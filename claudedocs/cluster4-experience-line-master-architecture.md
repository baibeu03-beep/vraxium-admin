# Cluster4 실무 경험 라인 마스터 아키텍처

> **작성일**: 2026-05-27
> **상태**: 설계 보완 — 구현 착수 전 최종 계약
> **선행 문서**: `cluster4-line-opening-field-contract.md`, `cluster4-line-final-architecture.md`
> **변경 범위**: 코드/SQL/UI 수정 없음. 설계 전용.

---

## 1. 문제 정의

### 1-1. 현재 설계의 오류

`cluster4-line-opening-field-contract.md` §3-2에서 실무 경험을 다음과 같이 설계했다:

```
라인 선택 → activity_types WHERE cluster_id='practical_experience' 드롭다운
line_code  → activity_types.line_code 자동 불러오기
main_title → activity_types.name 자동 불러오기
평점       → user_activity_details.rating (사용자 입력)
```

**이 설계는 전부 틀렸다.**

### 1-2. 실제 운영 구조

| 항목 | 기존 설계 (잘못됨) | 실제 |
|---|---|---|
| 라인 데이터 소스 | `activity_types` 테이블 | **엑셀 파일** |
| 라인 선택 기준 | `cluster_id='practical_experience'` 필터 | **별도 마스터 테이블** 필요 |
| 평점 입력 주체 | 사용자 (프론트 2차 정보) | **어드민** (평가 점수) |
| 평점 저장 위치 | `user_activity_details.rating` | **별도 평가 테이블** 필요 |

### 1-3. 해결해야 할 문제 3가지

1. **라인 마스터 부재**: 실무 경험 라인 정보가 DB에 없다. 엑셀로만 보유.
2. **평가 테이블 부재**: 어드민 평점을 저장할 곳이 없다.
3. **분류 체계 연결**: 기존 `classifyActivityType()` 로직이 `activity_types.cluster_id` 기반이므로, 새 마스터 테이블과의 연결 경로가 필요하다.

---

## 2. activity_types를 쓰지 않는 이유

### 2-1. 데이터 소스 불일치

`activity_types`는 시스템 내부에서 정의하는 **정적 분류 마스터**이다.

| 특성 | activity_types | 실무 경험 라인 |
|---|---|---|
| 데이터 원본 | 시스템 seed (SQL INSERT) | **엑셀 파일** (외부 관리) |
| 변경 빈도 | 거의 없음 (9개 info 고정) | **시즌/주기별 변경** 가능 |
| 관리 주체 | 개발자 | **운영자** |
| 행 수 | 고정적 (~20개 이내) | **유동적** (엑셀 row 수에 따라) |

activity_types에 실무 경험 행을 넣으면:
- 운영자가 엑셀을 업데이트할 때마다 개발자가 SQL seed를 수정해야 함
- activity_types에 team_id, source_file_name 같은 경험 전용 필드를 추가해야 하는데, 다른 허브(info/competency)에는 불필요한 컬럼이 됨
- 라인 코드 중복 방지, 팀 연결 등의 경험 고유 비즈니스 로직을 activity_types의 범용 제약조건에 끼워 넣어야 함

### 2-2. 평점 주체 불일치

| 항목 | activity_types 기반 설계 | 실제 |
|---|---|---|
| 평점 저장 | `user_activity_details.rating` | 사용자 입력용 필드 (2차 정보) |
| 평점 주체 | 사용자 | **어드민** |
| 평점 시점 | 제출 시 | **제출 후, 어드민이 결과 확정 시** |

`user_activity_details.rating`은 사용자가 프론트에서 입력하는 자기 평가 값이다.
어드민 평가 점수를 이 필드에 넣으면 사용자 입력과 어드민 입력이 뒤섞인다.

### 2-3. 결론

```
activity_types는 info/competency/career의 분류 마스터로만 사용한다.
실무 경험은 독립된 마스터 테이블 + 독립된 평가 테이블이 필요하다.
```

---

## 3. 실무 경험 라인 마스터 테이블 설계

### 3-1. cluster4_experience_line_masters

| 컬럼 | 타입 | NULL | DEFAULT | 용도 |
|---|---|---|---|---|
| `id` | uuid | NOT NULL | gen_random_uuid() | PK |
| `line_code` | text | NOT NULL | — | 라인 고유 코드 (UNIQUE) |
| `line_name` | text | NOT NULL | — | 라인 표시명 (드롭다운 라벨) |
| `default_main_title` | text | NULL | — | 개설 시 main_title 자동 입력 기본값 |
| `team_id` | uuid | NULL | — | 팀 연결 (nullable — 팀 무관 라인 허용) |
| `source_file_name` | text | NULL | — | 데이터 출처 엑셀 파일명 (추적용) |
| `is_active` | boolean | NOT NULL | true | 활성 여부 (비활성 시 드롭다운에서 제외) |
| `created_at` | timestamptz | NOT NULL | now() | 생성일 |
| `updated_at` | timestamptz | NOT NULL | now() | 수정일 |

제약조건:

```
PRIMARY KEY (id)
UNIQUE (line_code)
INDEX (team_id) WHERE team_id IS NOT NULL
INDEX (is_active)
```

### 3-2. team_id 연결 문제

현재 프로젝트에 **전용 teams 테이블이 없다.**

팀 정보는 `legacy_crew_import.team_name` (text)으로 관리되고 있다.
`cluster4_lines.team_id`도 FK 없이 free UUID로 존재한다.

**선택지**:

| 방안 | 장점 | 단점 | 판정 |
|---|---|---|---|
| A. team_id를 text (팀명)로 변경 | legacy_crew_import와 일관 | UUID 기반 구조와 불일치 | △ |
| B. 간이 teams 테이블 신설 | 정규화, FK 가능 | 추가 migration, 기존 team_name 매핑 필요 | **권장** |
| C. team_id를 NULL 유지, 팀명을 별도 text 컬럼 | 단순 | 정규화 위반 | × |

**권장안 B — 간이 teams 테이블**:

```
cluster4_teams (간이 팀 마스터)

id         uuid         PK  DEFAULT gen_random_uuid()
team_name  text         NOT NULL  UNIQUE
is_active  boolean      NOT NULL  DEFAULT true
created_at timestamptz  NOT NULL  DEFAULT now()
```

- `cluster4_experience_line_masters.team_id` → FK → `cluster4_teams.id`
- `cluster4_lines.team_id` → FK → `cluster4_teams.id` (기존 컬럼에 FK 추가)
- 초기 seed: `legacy_crew_import`의 DISTINCT team_name으로 생성
- 행 수: 소규모 (5~15개 팀 수준)

**대안**: teams 테이블 신설이 과도하다면, `team_id`를 text로 변경하여 팀명을 직접 저장하는 A안도 수용 가능. 이 경우 `team_name text NULL`로 컬럼명 변경.

### 3-3. line_code 고유성

`line_code`는 시스템 전체에서 고유해야 한다.

```
UNIQUE (line_code) ON cluster4_experience_line_masters
```

고유성 범위:
- 실무 경험 라인 내에서만 고유 (다른 허브의 line_code와 충돌 가능)
- 기존 info 라인의 line_code (wisdom, essay 등)와 네임스페이스가 다름
- 충돌 방지를 위해 경험 라인은 `exp-` 접두사 권장: `exp-design`, `exp-backend` 등

이 접두사 규칙은 기존 `classifyActivityType()` 로직의 prefix fallback과 호환된다:

```typescript
if (clusterId === "practical_experience" || clusterId.startsWith("exp-")) return "experience";
```

### 3-4. activity_types와의 관계

실무 경험 라인 마스터는 activity_types와 **완전히 독립**이다.

```
activity_types:
  - practical_info 라인 (wisdom, essay, ...)       ← info 허브용
  - practical_competency 라인 (comp-1, ...)        ← 역량 허브용
  - practical_career 라인 (car-1, ...)             ← 경력 허브용
  - practical_experience 행 → 존재하지 않거나, 있어도 사용하지 않음

cluster4_experience_line_masters:
  - exp-design, exp-backend, exp-pm, ...           ← 경험 허브 전용
```

경험 라인 개설 시 `cluster4_lines.activity_type_id`는 **NULL**로 둔다.
대신 `experience_line_master_id` FK를 추가한다 (§7에서 상세).

### 3-5. user_activity_details 연결

`user_activity_details`의 UNIQUE 키는 `(user_id, week_id, activity_type_id)`이다.

경험 라인의 경우 `activity_type_id`에 **line_code를 그대로 사용**한다:

```
user_activity_details.activity_type_id = cluster4_experience_line_masters.line_code
예: 'exp-design', 'exp-backend'
```

이유:
- `activity_type_id`에 FK 제약이 없음 (free text)
- 기존 prefix fallback 분류(`exp-` → experience)가 자동으로 작동
- `classifyActivityType()`에서 `clusterMap`에 없어도 `exp-` 접두사로 올바르게 분류됨
- activity_types 테이블에 경험용 행을 넣을 필요 없음

---

## 4. 엑셀 Import 방식

### 4-1. 엑셀 파일 형식 (가정)

| 열 | 예시 | 매핑 대상 |
|---|---|---|
| 라인 코드 | exp-design | `line_code` |
| 라인명 | 디자인 실무 | `line_name` |
| 기본 타이틀 | 디자인 실무 경험 | `default_main_title` |
| 팀명 | 디자인팀 | `team_id` (팀 매칭 후) |

### 4-2. Import 방식 비교

| 방안 | 설명 | 장점 | 단점 | 판정 |
|---|---|---|---|---|
| **A. 어드민 UI 업로드** | 어드민이 엑셀 파일을 웹에서 업로드 | 운영자 자율 관리 | 파싱 로직 구현 필요, 에러 핸들링 복잡 | **Phase 2** |
| **B. CLI 스크립트** | 개발자가 스크립트 실행하여 DB에 적재 | 단순, 검증 용이 | 개발자 개입 필요 | **Phase 1 (MVP)** |
| **C. 수동 입력** | 어드민이 관리 UI에서 행을 하나씩 추가 | 엑셀 파싱 불필요 | 대량 등록 시 비효율 | **보조** |

### 4-3. MVP Import 전략

**Phase 1**: B안 (CLI 스크립트) + C안 (수동 입력 보조)

```
1. 개발자가 엑셀을 받아 CSV로 변환
2. CLI 스크립트가 CSV를 읽어 cluster4_experience_line_masters에 UPSERT
   - line_code 기준 중복 체크
   - team_name → cluster4_teams.id 매칭
   - 매칭 실패 시 에러 리포트 출력
3. 어드민이 관리 UI에서 소규모 수정/추가 가능
```

**Phase 2**: A안 (어드민 UI 업로드)

```
1. /admin/line-opening/practical-experience/import 페이지
2. 엑셀 파일 업로드 → 서버 파싱 (xlsx library)
3. 미리보기 테이블 표시 (파싱 결과 확인)
4. 확인 버튼 → UPSERT 실행
5. 결과 리포트: 성공 N건, 실패 N건, 중복 N건
```

### 4-4. Import API 계약

```
POST /api/admin/cluster4/experience-line-masters/import

Content-Type: multipart/form-data
Body: { file: xlsx/csv }

Response (성공):
{
  "success": true,
  "data": {
    "imported": 12,
    "updated": 3,
    "skipped": 1,
    "errors": [
      { "row": 5, "lineCode": "exp-xxx", "reason": "팀명 'ABC팀'이 존재하지 않습니다" }
    ]
  }
}
```

### 4-5. 라인 마스터 CRUD API

Import 외에 개별 관리용 API:

| Method | URL | 용도 |
|---|---|---|
| GET | `/api/admin/cluster4/experience-line-masters` | 목록 조회 (검색, 필터) |
| POST | `/api/admin/cluster4/experience-line-masters` | 단건 추가 |
| PATCH | `/api/admin/cluster4/experience-line-masters/[id]` | 수정 |
| DELETE | `/api/admin/cluster4/experience-line-masters/[id]` | 삭제 (참조 없는 경우만) |

---

## 5. 어드민 라인 개설 UI 변경안

### 5-1. 기존 설계 (잘못됨) → 변경안

| 항목 | 기존 설계 | 변경안 |
|---|---|---|
| 라인 선택 드롭다운 소스 | `activity_types WHERE cluster_id='practical_experience'` | **`cluster4_experience_line_masters WHERE is_active=true`** |
| line_code 소스 | `activity_types.line_code` | **`cluster4_experience_line_masters.line_code`** |
| main_title 기본값 | `activity_types.name` | **`cluster4_experience_line_masters.default_main_title`** |
| 팀 선택 | 별도 드롭다운 (독립) | **라인에 team_id가 있으면 자동 세팅, 없으면 수동 선택** |
| 평점 입력 | 사용자 (프론트) | **어드민 (별도 평가 UI)** |

### 5-2. 변경된 라인 개설 화면

```
┌─────────────────────────────────────────────────────────┐
│  실무 경험 라인 개설                                      │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  📅 현재 주차: S1 시즌 · 4주차 (2026-05-25 ~ 2026-05-31)│
│  ⚠️ 라인 개설 권장 마감: 월요일 22:00                    │
│  ⏰ 제출 기간: 05-25 (월) 00:00 ~ 05-28 (수) 22:00      │
│                                                         │
│  ─────────────────────────────────────────────────────── │
│                                                         │
│  라인 선택 *                                             │
│  ┌──────────────────────────┐                            │
│  │ 디자인 실무            ▾  │  ← experience_line_masters │
│  └──────────────────────────┘     드롭다운               │
│                                                         │
│  ↓ 자동 불러오기 ↓                                      │
│                                                         │
│  line_code: exp-design (읽기 전용)                       │
│  팀: 디자인팀 (자동 세팅, 읽기 전용 — 라인 마스터에 팀 지정됨)│
│                                                         │
│  메인 타이틀 *                                             │
│  ┌──────────────────────────────────────────────────┐   │
│  │ 디자인 실무 경험          (자동 입력, 수정 가능)  │   │
│  └──────────────────────────────────────────────────┘   │
│                                                         │
│  Output Asset (최소 1개, 최대 2개)                        │
│  ┌──────────────────────────────────────────────────┐   │
│  │ Link 1:  [________________________]              │   │
│  │ Link 2:  [________________________]  (선택)       │   │
│  │ Image 1: [업로드              ]  (선택)           │   │
│  │ Image 2: [업로드              ]  (선택)           │   │
│  └──────────────────────────────────────────────────┘   │
│                                                         │
│  개설 대상 크루 *                                        │
│  ┌──────────────────────────────────────────────────┐   │
│  │ □ 김철수  □ 이영희  □ 박민수  □ 최수진            │   │
│  │ [전체 선택] [선택 해제]  선택됨: 5명               │   │
│  └──────────────────────────────────────────────────┘   │
│                                                         │
│               [취소]  [개설]                              │
└─────────────────────────────────────────────────────────┘
```

### 5-3. 라인 선택 시 자동 동작

```
운영자가 드롭다운에서 "디자인 실무" 선택
  ↓
1. line_code = "exp-design"           ← 읽기 전용 표시
2. default_main_title = "디자인 실무 경험"  ← main_title 필드에 자동 입력 (수정 가능)
3. team_id = "uuid-of-design-team"    ← 라인 마스터에 team_id가 있으면 자동 세팅
                                        없으면 팀 선택 드롭다운 활성화
```

### 5-4. 팀 선택 로직

| 라인 마스터의 team_id | UI 동작 |
|---|---|
| `NOT NULL` (팀 지정됨) | 팀 자동 세팅. 읽기 전용. 운영자 수정 불가 |
| `NULL` (팀 미지정) | 팀 선택 드롭다운 활성화. 운영자가 수동 선택 |

이 설계는 "라인이 팀에 종속된 경우"와 "범용 라인인 경우"를 모두 지원한다.

### 5-5. line-options API 변경

`GET /api/admin/cluster4/line-options?partType=experience` 응답 소스 변경:

```
기존: activity_types WHERE cluster_id='practical_experience'
변경: cluster4_experience_line_masters WHERE is_active=true
```

변경된 응답:

```json
{
  "success": true,
  "data": {
    "partType": "experience",
    "options": [
      {
        "lineCode": "exp-design",
        "displayName": "디자인 실무",
        "defaultMainTitle": "디자인 실무 경험",
        "activityTypeId": null,
        "careerProjectId": null,
        "experienceLineMasterId": "uuid-of-master",
        "teamId": "uuid-of-design-team",
        "teamName": "디자인팀",
        "teamRequired": true,
        "teamAutoSet": true,
        "ratingRequired": true,
        "ratingBy": "admin",
        "alreadyOpened": false,
        "selectable": true,
        "sourceTable": "cluster4_experience_line_masters"
      }
    ]
  }
}
```

변경/추가 필드:

| 필드 | 설명 |
|---|---|
| `activityTypeId` | 항상 `null` (experience는 activity_types를 쓰지 않음) |
| `experienceLineMasterId` | 라인 마스터 UUID. API 요청 시 이 값을 전송 |
| `teamId` | 라인 마스터에 지정된 팀 UUID (null이면 수동 선택) |
| `teamName` | 팀 표시명 (UI 편의) |
| `teamAutoSet` | `true`면 팀 자동 세팅 (읽기 전용), `false`면 수동 선택 |
| `ratingBy` | `"admin"` (어드민 평가) — info/competency는 이 필드 없음 |

---

## 6. 어드민 평점 입력 UI/API 설계

### 6-1. cluster4_experience_line_evaluations

| 컬럼 | 타입 | NULL | DEFAULT | 용도 |
|---|---|---|---|---|
| `id` | uuid | NOT NULL | gen_random_uuid() | PK |
| `line_target_id` | uuid | NOT NULL | — | FK → `cluster4_line_targets.id` ON DELETE CASCADE |
| `user_id` | uuid | NOT NULL | — | FK → `user_profiles.user_id` ON DELETE CASCADE |
| `rating` | smallint | NOT NULL | — | 평가 점수 (0~10). points = rating (1:1). 별도 points 컬럼 불필요. |
| `evaluated_by` | uuid | NULL | — | FK → `admin_users.id` (평가자) |
| `evaluated_at` | timestamptz | NULL | — | 평가 시점 |
| `created_at` | timestamptz | NOT NULL | now() | 생성일 |
| `updated_at` | timestamptz | NOT NULL | now() | 수정일 |

제약조건:

```
PRIMARY KEY (id)
UNIQUE (line_target_id, user_id)
CHECK (rating >= 0 AND rating <= 10)
CHECK (points IS NULL OR points >= 0)
FK (line_target_id) → cluster4_line_targets(id) ON DELETE CASCADE
FK (user_id) → user_profiles(user_id) ON DELETE CASCADE
FK (evaluated_by) → admin_users(id) ON DELETE SET NULL
INDEX (user_id, evaluated_at)
```

### 6-2. user_activity_details.rating과의 관계

| 테이블 | 역할 | 입력 주체 | 대상 허브 |
|---|---|---|---|
| `user_activity_details.rating` | 사용자 자기 평가 | 사용자 | info (해당 시 사용), competency |
| `cluster4_experience_line_evaluations.rating` | 어드민 평가 점수 | 어드민 | **experience 전용** |
| `career_records.grade` / `grade_points` | 어드민 등급/점수 | 어드민 | career 전용 |

**원칙**: 실무 경험의 `user_activity_details` 행에서 `rating` 컬럼은 **사용하지 않는다** (NULL 유지).
어드민 평가는 반드시 `cluster4_experience_line_evaluations`에 저장한다.

### 6-3. 평점 입력 시점

```
[라인 개설]
  운영자 → 라인 생성 + 대상 크루 지정
  ↓
[사용자 제출]
  크루원 → 라인 결과 제출 (submission)
  크루원 → 2차 정보 입력 (user_activity_details — rating 제외)
  ↓
[제출 마감] 수요일 22:00
  ↓
[어드민 평가]
  운영자 → 제출 완료된 크루원에 대해 평점(0~10) 입력
  시스템 → points 자동 환산
```

어드민 평가는 제출 마감 후에 진행하는 것이 일반적이나, 시스템상 제한은 두지 않는다.
(제출 전 크루원에 대한 평가는 UI에서 비활성화 처리)

### 6-4. 평점 → 포인트 환산 (2026-05-27 확정)

**확정 정책**: points = rating (1:1 직접 대입)

| 평점 | 포인트 | 예시 |
|------|--------|------|
| 10   | 10     | 10 별 / 10 단감 / 10 투구 |
| 8    | 8      | 8 별 / 8 단감 / 8 투구 |
| 0    | 0      | — |

- DB에는 rating(0~10 정수)만 저장. points 별도 컬럼 불필요.
- points = rating 이므로 계산값으로 취급.
- 포인트 표시명은 조직별로 다름 → `organization_resume_card_settings.point_label` 에서 조회.
  - encre → 별, oranke → 단감, phalanx → 투구
- UI 표시: `{rating} {point_label}` (예: "8 별")

~~B안 (`points = rating * 10`) 폐기~~ — 별도 환산이 불필요하며 직관성 우선.

### 6-5. 평가 UI

```
┌─────────────────────────────────────────────────────────┐
│  실무 경험 평가 — 디자인 실무 (exp-design) · 4주차        │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  ┌──────────────────────────────────────────────────┐   │
│  │ 크루원     │ 제출 │ 평점(0~10) │ 포인트 │ 평가일 │   │
│  ├──────────────────────────────────────────────────┤   │
│  │ 김철수     │ ✅   │ [8  ▾]    │ 8 별   │ —      │   │
│  │ 이영희     │ ✅   │ [7  ▾]    │ 7 별   │ —      │   │
│  │ 박민수     │ ❌   │ (비활성)   │ —      │ —      │   │
│  │ 최수진     │ ✅   │ [9  ▾]    │ 9 별   │ —      │   │
│  └──────────────────────────────────────────────────┘   │
│                                                         │
│  ※ 미제출자는 평가할 수 없습니다.                        │
│  ※ 포인트 = 평점 (1:1). 표시명은 조직 설정에 따름.       │
│                                                         │
│               [저장]                                    │
└─────────────────────────────────────────────────────────┘
```

접근 경로:
- `/admin/line-opening/practical-experience` → 라인 목록 → 라인 클릭 → 평가 탭
- 또는 라인 목록에서 "평가" 버튼으로 직접 진입

### 6-6. 평가 API

| Method | URL | 용도 |
|---|---|---|
| GET | `/api/admin/cluster4/experience-evaluations?line_id={uuid}` | 라인별 평가 현황 조회 |
| POST | `/api/admin/cluster4/experience-evaluations` | 평가 생성 (단건 또는 벌크) |
| PATCH | `/api/admin/cluster4/experience-evaluations/[id]` | 평가 수정 |

GET 응답:

```json
{
  "success": true,
  "data": [
    {
      "id": "uuid",
      "lineTargetId": "uuid",
      "userId": "uuid",
      "displayName": "김철수",
      "hasSubmission": true,
      "rating": 8,
      "points": 80,
      "evaluatedBy": "uuid",
      "evaluatedAt": "2026-05-29T14:30:00+09:00"
    }
  ]
}
```

POST 요청 (벌크):

```json
{
  "evaluations": [
    { "line_target_id": "uuid", "user_id": "uuid", "rating": 8 },
    { "line_target_id": "uuid", "user_id": "uuid", "rating": 7 }
  ]
}
```

서버에서 `points = rating` (1:1 직접 대입). 별도 points 컬럼 불필요.

---

## 7. line_code 저장/자동 불러오기 방식

### 7-1. cluster4_lines 테이블 변경

`cluster4-line-opening-field-contract.md` §4에서 `cluster4_lines.line_code` 컬럼 추가를 설계했다.
experience 허브의 line_code 해석 경로를 수정한다.

| 허브 | line_code 소스 | 연결 FK |
|---|---|---|
| info | `activity_types.line_code` | `cluster4_lines.activity_type_id` → activity_types |
| competency | `activity_types.line_code` | `cluster4_lines.activity_type_id` → activity_types |
| **experience** | **`cluster4_experience_line_masters.line_code`** | **`cluster4_lines.experience_line_master_id`** → experience_line_masters |
| career | `career_projects.line_code` | `cluster4_lines.career_project_id` → career_projects |

### 7-2. cluster4_lines에 experience_line_master_id 추가

| 컬럼 | 타입 | NULL | 용도 |
|---|---|---|---|
| `experience_line_master_id` | uuid | NULL | FK → `cluster4_experience_line_masters.id` ON DELETE SET NULL |

기존 패턴과의 일관성:

```
cluster4_lines 허브별 FK 구조:

  info / competency  →  activity_type_id (text, FK 없음)
  experience         →  experience_line_master_id (uuid, FK 있음)  ← 신규
  career             →  career_project_id (uuid, FK 있음)
```

experience에서는 `activity_type_id = NULL`.

### 7-3. line_code 해석 경로 (experience)

```
POST /api/admin/cluster4/lines (part_type='experience') 처리:

  1. experience_line_master_id를 body에서 수신
  2. SELECT line_code, default_main_title, team_id
     FROM cluster4_experience_line_masters
     WHERE id = :experience_line_master_id
  3. cluster4_lines.line_code = resolved line_code
  4. cluster4_lines.experience_line_master_id = :experience_line_master_id
  5. cluster4_lines.activity_type_id = NULL  (experience는 사용 안 함)
  6. cluster4_lines.team_id = master.team_id (NULL이면 body에서 수동 team_id 수신)
```

### 7-4. 성장률 계산과의 연결

현재 성장률 계산 흐름:

```
user_activity_details (activity_type_id)
  → activity_types.cluster_id 조회 (clusterMap)
  → classifyActivityType(cluster_id) → "experience"
  → experience completed++
```

경험 라인의 `activity_type_id`로 `line_code`를 사용하면 (`exp-design` 등):

```
activity_types 테이블에 해당 id가 없음
  → clusterMap.get("exp-design") = undefined
  → classifyActivityType(null) 호출
  → prefix fallback: "exp-design".startsWith("exp-") → "experience" ✅
```

**기존 코드 수정 없이 정상 동작한다.**

`classifyActivityType()` 함수의 prefix fallback이 정확히 이 케이스를 처리:

```typescript
function classifyActivityType(clusterId: string | null): LineCategory {
  if (!clusterId) return "info";
  // ...
  if (clusterId === "practical_experience" || clusterId.startsWith("exp-")) return "experience";
  // ...
}
```

단, 현재 코드는 `clusterMap.get(activity_type_id)`의 결과를 `classifyActivityType`에 넘긴다.
clusterMap에 `exp-design`이 없으면 `null`이 전달되어 **`"info"`로 잘못 분류될 수 있다.**

수정 방안:

```
classifyActivityType의 인자로 cluster_id가 아닌 activity_type_id 자체도 fallback 체크

또는:

clusterMap에 experience line master의 line_code도 등록:
  clusterMap.set("exp-design", "practical_experience")
  clusterMap.set("exp-backend", "practical_experience")
```

**권장**: clusterMap 구축 시 experience line masters도 포함

```typescript
// 기존: activity_types만 조회
const clusterMapRes = await supabaseAdmin
  .from("activity_types")
  .select("id,cluster_id");

// 추가: experience line masters도 조회하여 clusterMap에 merge
const expMastersRes = await supabaseAdmin
  .from("cluster4_experience_line_masters")
  .select("line_code")
  .eq("is_active", true);

for (const m of expMastersRes.data) {
  clusterMap.set(m.line_code, "practical_experience");
}
```

이렇게 하면 `classifyActivityType`이 올바르게 `"experience"`를 반환한다.

### 7-5. 포인트와 성장률의 독립성

`cluster4-line-opening-field-contract.md` §6-5의 원칙 재확인:

```
성장률 = ceil(completedLines / availableLines × 100)
  → user_activity_details 행 존재 여부 기반
  → 평점과 무관

포인트 = 평가 점수 기반 가산
  → cluster4_experience_line_evaluations.points
  → user_weekly_points에 적립
  → FM Score 누적
```

**성장률과 포인트는 독립적으로 계산**되며, 둘 다 주차 카드에 표시된다.

---

## 8. 필요한 Migration 목록

| # | 대상 | 내용 | 의존 | 우선순위 |
|---|---|---|---|---|
| **M-1** | `cluster4_teams` | 간이 팀 마스터 테이블 생성 | 없음 | 필수 |
| **M-2** | `cluster4_teams` | `legacy_crew_import` DISTINCT team_name으로 초기 seed | M-1 | 필수 |
| **M-3** | `cluster4_experience_line_masters` | 라인 마스터 테이블 생성 (team_id FK → cluster4_teams) | M-1 | 필수 |
| **M-4** | `cluster4_experience_line_evaluations` | 평가 테이블 생성 | 없음 | 필수 |
| **M-5** | `cluster4_lines` | `experience_line_master_id uuid NULL` 컬럼 추가 + FK + 인덱스 | M-3 | 필수 |
| **M-6** | `cluster4_lines` | 기존 `team_id`에 FK → `cluster4_teams.id` 추가 (선택) | M-1 | 선택 |

### M-1 ~ M-2: cluster4_teams

```
테이블: cluster4_teams
  id         uuid PK DEFAULT gen_random_uuid()
  team_name  text NOT NULL UNIQUE
  is_active  boolean NOT NULL DEFAULT true
  created_at timestamptz NOT NULL DEFAULT now()

Seed:
  INSERT INTO cluster4_teams (team_name)
  SELECT DISTINCT team_name
  FROM legacy_crew_import
  WHERE team_name IS NOT NULL AND trim(team_name) != ''
  ON CONFLICT DO NOTHING;
```

### M-3: cluster4_experience_line_masters

```
테이블: cluster4_experience_line_masters
  id                  uuid PK DEFAULT gen_random_uuid()
  line_code           text NOT NULL UNIQUE
  line_name           text NOT NULL
  default_main_title  text NULL
  team_id             uuid NULL FK → cluster4_teams(id) ON DELETE SET NULL
  source_file_name    text NULL
  is_active           boolean NOT NULL DEFAULT true
  created_at          timestamptz NOT NULL DEFAULT now()
  updated_at          timestamptz NOT NULL DEFAULT now()

인덱스:
  (team_id) WHERE team_id IS NOT NULL
  (is_active)
```

### M-4: cluster4_experience_line_evaluations

```
테이블: cluster4_experience_line_evaluations
  id              uuid PK DEFAULT gen_random_uuid()
  line_target_id  uuid NOT NULL FK → cluster4_line_targets(id) ON DELETE CASCADE
  user_id         uuid NOT NULL FK → user_profiles(user_id) ON DELETE CASCADE
  rating          smallint NOT NULL CHECK (rating >= 0 AND rating <= 10)
  points          integer NULL CHECK (points IS NULL OR points >= 0)
  evaluated_by    uuid NULL FK → admin_users(id) ON DELETE SET NULL
  evaluated_at    timestamptz NULL
  created_at      timestamptz NOT NULL DEFAULT now()
  updated_at      timestamptz NOT NULL DEFAULT now()

제약:
  UNIQUE (line_target_id, user_id)

인덱스:
  (user_id, evaluated_at)
```

### M-5: cluster4_lines 확장

```
ALTER TABLE cluster4_lines
  ADD COLUMN IF NOT EXISTS experience_line_master_id uuid NULL;

FK: → cluster4_experience_line_masters(id) ON DELETE SET NULL
INDEX: (experience_line_master_id) WHERE experience_line_master_id IS NOT NULL
```

---

## 9. 실무 경험 MVP 구현 순서

### Phase 0: 설계 확정 (현 문서)

- [x] 아키텍처 문서 작성
- [ ] 미결 사항 확정 (§10)
- [ ] `cluster4-line-opening-field-contract.md` §3-2, §4, §5, §6 수정 반영

### Phase 1: DB 기반 구축

| 순서 | 작업 | 의존 |
|---|---|---|
| 1-1 | M-1: `cluster4_teams` 테이블 생성 | 없음 |
| 1-2 | M-2: teams 초기 seed (legacy_crew_import에서) | 1-1 |
| 1-3 | M-3: `cluster4_experience_line_masters` 테이블 생성 | 1-1 |
| 1-4 | M-4: `cluster4_experience_line_evaluations` 테이블 생성 | 없음 |
| 1-5 | M-5: `cluster4_lines.experience_line_master_id` 추가 | 1-3 |

### Phase 2: 라인 마스터 관리

| 순서 | 작업 | 의존 |
|---|---|---|
| 2-1 | CLI 스크립트: 엑셀/CSV → `cluster4_experience_line_masters` UPSERT | 1-3 |
| 2-2 | 라인 마스터 CRUD API (GET/POST/PATCH/DELETE) | 1-3 |
| 2-3 | 라인 마스터 관리 UI (목록 + 단건 추가/수정) | 2-2 |

### Phase 3: 라인 개설 연동

| 순서 | 작업 | 의존 |
|---|---|---|
| 3-1 | `GET /api/admin/cluster4/line-options?partType=experience` 변경 (소스: experience_line_masters) | 2-2 |
| 3-2 | `POST /api/admin/cluster4/lines` experience 분기 추가 (experience_line_master_id 수신, line_code resolve) | 1-5, 3-1 |
| 3-3 | 타입/DTO 업데이트: `Cluster4LineDto`에 `experienceLineMasterId` 추가 | 1-5 |
| 3-4 | 실무 경험 라인 개설 페이지 UI | 3-1, 3-2 |

### Phase 4: 어드민 평가

| 순서 | 작업 | 의존 |
|---|---|---|
| 4-1 | 평가 API (GET/POST/PATCH) | 1-4 |
| 4-2 | 평가 UI (라인별 크루원 평점 입력) | 4-1, 3-4 |
| 4-3 | points → user_weekly_points 적립 로직 | 4-1 |

### Phase 5: 성장률 연동

| 순서 | 작업 | 의존 |
|---|---|---|
| 5-1 | `computeWeeklyCards()` clusterMap에 experience line masters 포함 | 1-3 |
| 5-2 | experience availability 계산 연동 (동적 → line_masters 기반) | 5-1 |

### Phase 6: 검증

| 순서 | 작업 |
|---|---|
| 6-1 | 엑셀 import → 라인 마스터 등록 검증 |
| 6-2 | 라인 선택 → line_code 자동 불러오기 검증 |
| 6-3 | 팀 자동 세팅 검증 (라인 마스터 team_id) |
| 6-4 | 어드민 평점 입력 → points 환산 검증 |
| 6-5 | 성장률 계산 — experience 분류 정확성 검증 |
| 6-6 | user_activity_details.rating 미사용 확인 |

---

## 10. 미결 사항

### U-1. 엑셀 파일 포맷

- 실제 엑셀의 열 구성 미확인
- 열 이름, 데이터 타입, 필수/선택 등
- **필요 시점**: Phase 2 (CLI 스크립트) 착수 전

### U-2. ~~평점 → 포인트 환산 공식 최종 확정~~ (2026-05-27 확정 완료)

- **확정**: points = rating (1:1 직접 대입). DB 에 points 컬럼 불필요.
- 포인트 표시명은 `organization_resume_card_settings.point_label` 에서 조회.
- 마이그레이션: `2026-05-27_org_settings_add_point_label.sql`

### U-3. teams 테이블 신설 여부

- B안 (`cluster4_teams` 간이 테이블) 권장
- A안 (team_id를 text로 변경)도 수용 가능
- **필요 시점**: Phase 1 Migration 작성 전

### U-4. 기존 experience 데이터 마이그레이션

- `user_activity_details`에 이미 `exp-*` activity_type_id로 저장된 행이 있는지 확인 필요
- 있다면 해당 행의 rating 값 처리 방침 (NULL로 리셋? 그대로 유지?)
- **필요 시점**: Phase 1 완료 후

### U-5. experience availability 동적 전환

- 현재 `EXPERIENCE_AVAILABLE` = 하드코딩 2
- 라인 마스터 도입 후 동적으로 변경할지 (해당 주차에 개설된 라인 수 기반)
- 또는 기존 고정값 유지할지
- **필요 시점**: Phase 5

### U-6. 부분 UNIQUE 인덱스

- `cluster4_lines`의 기존 부분 UNIQUE: `UNIQUE (activity_type_id) WHERE is_active=true`
- experience는 `activity_type_id = NULL`이므로 이 제약에 걸리지 않음
- experience 전용 중복 방지: `UNIQUE (experience_line_master_id) WHERE is_active=true AND experience_line_master_id IS NOT NULL` 추가 필요 여부
- **필요 시점**: M-5 작성 시

### U-7. `cluster4-line-opening-field-contract.md` 수정 범위

본 문서로 인해 field contract에서 수정이 필요한 섹션:

| 섹션 | 변경 내용 |
|---|---|
| §3-2 실무 경험 | 라인 소스: activity_types → experience_line_masters |
| §4 line_code 데이터 소스 | experience 행 추가 (소스: experience_line_masters) |
| §4-4 기존 컬럼 관계 | experience_line_master_id 추가 |
| §5-1 line-options API (experience) | 응답 소스/필드 변경 |
| §6-1 평점 필요 허브 | experience: 사용자 → 어드민 |
| §6-2 실무 경험 사용자 평점 | 삭제 또는 어드민 평점으로 교체 |
| §8-2 API 변경 | experience-evaluations API 추가 |
| 부록 A 매트릭스 | experience 행 업데이트 |

이 수정은 설계 확정 후 별도로 진행한다.

### U-8. 실무 경험에서 user_activity_details 사용 방식

경험 라인의 사용자 2차 정보(sub_title, growth_point, image_urls 등)는 여전히 `user_activity_details`에 저장한다.
단, `rating` 컬럼만 사용하지 않는다.

```
user_activity_details (experience 행):
  activity_type_id = "exp-design" (line_code)
  sub_title        = 사용자 입력 ✅
  growth_point     = 사용자 입력 ✅
  image_urls       = 사용자 입력 ✅
  rating           = NULL (사용 안 함) ← 핵심 변경
```

평점은 별도 테이블 `cluster4_experience_line_evaluations`에서 관리.
