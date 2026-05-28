# Cluster4 실무 역량 라인 마스터 아키텍처

> 작성일: 2026-05-28
> 상태: 설계 (코드 미반영)

---

## 1. 문제 정의

### 현재 상태

실무 역량(competency)은 `activity_types` 테이블의 `cluster_id = 'practical_competency'`로 관리되도록 설계되어 있었다. 그러나 실무 경험(experience)과 마찬가지로, 실무 역량 라인도 **조직별 운영자가 관리하는 외부 마스터 데이터**(엑셀 등)에서 유래한다.

### 문제점

| 항목 | activity_types 기반 (기존) | 라인 마스터 기반 (목표) |
|------|---------------------------|------------------------|
| 관리 주체 | 개발자 (seed/migration) | 운영자 (어드민 UI) |
| 데이터 원본 | 코드 내 하드코딩 | 엑셀 → 어드민 등록 |
| 조직 구분 | 없음 (전역) | organization_slug 기반 |
| CRUD | 불가 (migration only) | 어드민 UI에서 CRUD |
| line_code 형식 | `comp-1` 등 임의 | `CP99A - CR0001` 등 운영 코드 |

### 결론

`activity_types`는 실무 역량의 마스터 테이블로 적합하지 않다. 실무 경험과 동일한 패턴의 **전용 라인 마스터 테이블**이 필요하다.

---

## 2. 실무 경험 구조와의 공통점/차이점

### 공통점

| 항목 | 실무 경험 | 실무 역량 |
|------|----------|----------|
| 마스터 테이블 | cluster4_experience_line_masters | cluster4_competency_line_masters |
| organization_slug | O | O |
| line_code | 마스터에서 불러옴 | 마스터에서 불러옴 |
| main_title | 마스터에서 불러옴 (읽기 전용) | 마스터에서 불러옴 (읽기 전용) |
| line_name | O | O |
| source_file_name | O | O |
| UNIQUE 제약 | (organization_slug, line_code) | (organization_slug, line_code) |
| cluster4_lines 연결 | experience_line_master_id FK | competency_line_master_id FK |
| Output Asset | Link + Image 합산 1~2개 | Link + Image 합산 1~2개 |
| 대상자 선택 | 수동 (Phase 1) | 수동 (Phase 1) |
| 라인 개설 API | POST /experience-lines | POST /competency-lines |

### 차이점

| 항목 | 실무 경험 | 실무 역량 |
|------|----------|----------|
| team_id FK | O (마스터에 팀 연결) | X (팀 연결 없음) |
| 평가 테이블 | cluster4_experience_line_evaluations | 없음 (이번 범위 외) |
| Phase 2 대상자 | 없음 | 카페 링크 집계 기반 자동 추출 |
| UI 탭 순서 | 라인 마스터 → 라인 개설 → 평가 관리 | 라인 개설 → 라인 마스터 → 카페 링크 집계 |
| activity_types 연동 | 완전 분리 | 완전 분리 (기존 comp- 시드는 deprecated) |

---

## 3. 데이터 모델

### 3-1. cluster4_competency_line_masters (신규)

```
┌──────────────────────────────────────────────────────────┐
│  cluster4_competency_line_masters                        │
├──────────────────────────────────────────────────────────┤
│  id                  uuid        PK  DEFAULT gen_random  │
│  organization_slug   text        NOT NULL                │
│  line_code           text        NOT NULL                │
│  line_name           text        NOT NULL                │
│  main_title          text        NULL                    │
│  source_file_name    text        NULL                    │
│  is_active           boolean     NOT NULL DEFAULT true   │
│  created_at          timestamptz NOT NULL DEFAULT now()  │
│  updated_at          timestamptz NOT NULL DEFAULT now()  │
├──────────────────────────────────────────────────────────┤
│  UNIQUE (organization_slug, line_code)                   │
│  INDEX  (organization_slug)                              │
│  INDEX  (is_active)                                      │
└──────────────────────────────────────────────────────────┘
```

**team_id 미포함 이유**: 실무 역량 라인은 팀 단위가 아닌 조직 전체 대상이다. 실무 경험은 팀별 업무 분리가 필요하지만, 실무 역량은 조직 횡단적 역량 평가이다.

**main_title**: DB 컬럼명은 `main_title`로 한다. 실무 경험의 `default_main_title`과 달리 새 테이블이므로 처음부터 통일된 명칭을 사용한다.

### 3-2. cluster4_lines 확장

```
ALTER TABLE cluster4_lines
  ADD COLUMN IF NOT EXISTS competency_line_master_id uuid NULL;

-- FK
ALTER TABLE cluster4_lines
  ADD CONSTRAINT cluster4_lines_competency_line_master_id_fkey
  FOREIGN KEY (competency_line_master_id)
  REFERENCES cluster4_competency_line_masters(id)
  ON DELETE SET NULL;

-- Index
CREATE INDEX cluster4_lines_competency_line_master_id_idx
  ON cluster4_lines (competency_line_master_id)
  WHERE competency_line_master_id IS NOT NULL;
```

**line_code**: 기존 `cluster4_lines.line_code` 컬럼을 그대로 사용한다. 라인 생성 시 마스터의 `line_code`를 복사한다.

### 3-3. 기존 테이블 재사용 (변경 없음)

- `cluster4_line_targets` — 대상자 연결 (target_mode='user')
- `cluster4_line_submissions` — 제출물 관리
- `cluster4_teams` — 실무 역량에서는 미참조

### 3-4. ER 관계

```
cluster4_competency_line_masters
         │
         │ competency_line_master_id (nullable FK)
         ▼
   cluster4_lines (part_type = 'competency')
         │
         │ line_id FK
         ▼
 cluster4_line_targets (target_mode = 'user')
         │
         │ line_target_id FK
         ▼
cluster4_line_submissions
```

---

## 4. line_code / main_title 자동 불러오기 정책

### 정책 요약

| 필드 | 입력 방식 | 수정 가능 | 출처 |
|------|----------|----------|------|
| line_name | 드롭다운 선택 | 선택만 가능 | cluster4_competency_line_masters |
| line_code | 자동 표시 | 읽기 전용 | 선택된 마스터의 line_code |
| main_title | 자동 표시 | 읽기 전용 | 선택된 마스터의 main_title |

### 자동 불러오기 흐름

```
운영자가 라인 선택 (line_name 드롭다운)
  ↓
line_code 자동 표시 (readonly)
  ↓
main_title 자동 표시 (readonly)
  ↓
Output Asset 입력 (Link/Image)
  ↓
대상 크루 선택
  ↓
저장
```

### 저장 시 데이터 매핑

```
cluster4_lines INSERT:
  part_type                    = 'competency'
  competency_line_master_id    = 선택한 마스터 id
  line_code                    = 마스터의 line_code (복사)
  main_title                   = 마스터의 main_title (복사)
  output_link_1                = 입력값
  output_link_2                = 입력값
  output_images                = 업로드된 이미지 URL 배열
  submission_opens_at          = 현재 주차 기준 자동 계산
  submission_closes_at         = 현재 주차 기준 자동 계산
  is_active                    = true
  created_by                   = 현재 어드민 ID
```

### 4개 허브 메인 타이틀 정책 비교

| 허브 | 메인 타이틀 입력 | 출처 |
|------|-----------------|------|
| 실무 정보 | 직접 입력 | 운영자 타이핑 |
| 실무 경험 | 자동 불러오기 (읽기 전용) | cluster4_experience_line_masters.main_title |
| 실무 역량 | 자동 불러오기 (읽기 전용) | cluster4_competency_line_masters.main_title |
| 실무 경력 | 등록된 값 자동 불러오기 | career_projects (별도 정책) |

---

## 5. 어드민 UI 설계

### 5-1. 라우트

```
/admin/line-opening/practical-competency
```

`lib/adminLineOpening.ts`에서 `enabled: true`로 전환.

### 5-2. 탭 구조

```
┌──────────────┬──────────────┬──────────────────┐
│  라인 개설    │  라인 마스터   │  카페 링크 집계   │
│  (active)    │              │  (준비 중)        │
└──────────────┴──────────────┴──────────────────┘
```

**탭 순서 근거**: 운영자의 주 작업은 "라인 개설"이므로 첫 번째 탭에 배치. 마스터 관리는 초기 설정 후 빈도가 낮으므로 두 번째. 카페 링크 집계는 Phase 2.

### 5-3. 라인 개설 탭

```
┌─────────────────────────────────────────────────────────┐
│  현재 개설 주차                                          │
│  2026 S1 W5 (2026. 5. 26. (월) ~ 2026. 6. 1. (일))     │
│  제출 기간: 2026. 5. 26. (월) 오전 9:00 ~ ...           │
├─────────────────────────────────────────────────────────┤
│  개설된 실무 역량 라인 (2개)                               │
│  ┌────────────┬────────────────┬───────┬──────┬──────┐  │
│  │ 라인 코드   │ 메인 타이틀     │ 대상  │ 활성 │ 생성일│  │
│  ├────────────┼────────────────┼───────┼──────┼──────┤  │
│  │ CP99A-CR01 │ [역량 평가]... │ 15명  │  ✓  │5.26. │  │
│  └────────────┴────────────────┴───────┴──────┴──────┘  │
├─────────────────────────────────────────────────────────┤
│  [+ 새 실무 역량 라인 개설]                                │
├─────────────────────────────────────────────────────────┤
│  라인 *                                                  │
│  ┌─────────────────────────────────────┐                │
│  │ [콘텐츠] 마케팅 역량 평가        ▾  │                │
│  └─────────────────────────────────────┘                │
│                                                         │
│  ┌─ 자동 표시 (읽기 전용) ────────────────────┐          │
│  │  라인 코드: CP99A - CR0003                  │          │
│  │  메인 타이틀: [콘텐츠 마케팅] 마케터가 ...  │          │
│  └──────────────────────────────────────────┘          │
│                                                         │
│  Output Asset * (1/2)                                   │
│  Link 1: [https://...]                                  │
│  Image 1: [이미지 업로드]                                │
│                                                         │
│  개설 대상 크루 * (선택됨: 12명)                          │
│  ┌────────┬────────┬────────┬────────┐                  │
│  │전체 팀 ▾│전체 파트▾│전체 레벨▾│활동중 ▾│                  │
│  └────────┴────────┴────────┴────────┘                  │
│  [이름 검색...]  [전체 선택] [선택 해제]                   │
│  ┌──────────────────────────────────────┐               │
│  │ ☑ 김OO        콘텐츠 / 기획          │               │
│  │ ☑ 이OO        콘텐츠 / 제작          │               │
│  │ ☐ 박OO        커머스 / 운영          │               │
│  └──────────────────────────────────────┘               │
│                                                         │
│                         [취소]  [저장]                    │
└─────────────────────────────────────────────────────────┘
```

### 5-4. 라인 마스터 탭

```
┌─────────────────────────────────────────────────────────┐
│  실무 역량 라인 마스터                  [+ 새 마스터]     │
│  등록된 마스터 6개 (oranke)                              │
│  ┌────────────────┬──────────────────┬────────┬──────┐  │
│  │ 라인 코드       │ 라인명           │ 메인타이틀│ 활성│  │
│  ├────────────────┼──────────────────┼────────┼──────┤  │
│  │ CP99A - CR0001 │ [콘텐츠] 역량... │  ...   │  ✓  │  │
│  │ CP99A - CR0002 │ [퍼포먼스]...    │  ...   │  ✓  │  │
│  └────────────────┴──────────────────┴────────┴──────┘  │
├─────────────────────────────────────────────────────────┤
│  새 라인 마스터 / 수정                                    │
│  라인 코드 *: [CP99A - CR0007]                           │
│  라인명 *:    [[커리어] 신규 역량]                         │
│  메인 타이틀:  [역량 평가 설명문...]                       │
│  원본 파일명:  [source.xlsx]                              │
│                         [취소]  [저장]                    │
└─────────────────────────────────────────────────────────┘
```

### 5-5. 카페 링크 집계 탭

```
┌─────────────────────────────────────────────────────────┐
│                                                         │
│           카페 링크 집계 기능은 준비 중입니다              │
│    이 기능은 Phase 2에서 제공될 예정입니다.               │
│                                                         │
│    - 카페 게시물 링크 자동 수집                           │
│    - 링크 기반 대상자 자동 추출                           │
│    - 수동 선택 없이 대상자 확정                           │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

---

## 6. API 계약

### 6-1. 라인 마스터 CRUD

**GET /api/admin/cluster4/competency-line-masters**

```
Query: ?organization=oranke
Auth: ADMIN_READ_ROLES
Response:
{
  success: true,
  data: [{
    id: "uuid",
    organizationSlug: "oranke",
    lineCode: "CP99A - CR0001",
    lineName: "[콘텐츠] 마케팅 역량 평가",
    mainTitle: "[콘텐츠 마케팅] 마케터가 제대로...",
    sourceFileName: "source.xlsx",
    isActive: true,
    createdAt: "ISO",
    updatedAt: "ISO"
  }]
}
```

**POST /api/admin/cluster4/competency-line-masters**

```
Auth: CLUSTER4_LINE_WRITE_ROLES (owner)
Body:
{
  organization_slug: "oranke",
  line_code: "CP99A - CR0007",
  line_name: "[신규] 역량 평가",
  main_title: "역량 평가 설명문",
  source_file_name: "source.xlsx"
}
Response: { success: true, data: { ...CompetencyLineMasterDto } }
Status: 201
```

**PATCH /api/admin/cluster4/competency-line-masters/[id]**

```
Auth: CLUSTER4_LINE_WRITE_ROLES (owner)
Body: (partial) { line_name: "수정된 라인명" }
Response: { success: true, data: { ...CompetencyLineMasterDto } }
```

**DELETE /api/admin/cluster4/competency-line-masters/[id]**

```
Auth: CLUSTER4_LINE_WRITE_ROLES (owner)
Response: { success: true }
```

### 6-2. 라인 개설

**POST /api/admin/cluster4/competency-lines**

```
Auth: CLUSTER4_LINE_WRITE_ROLES (owner)
Body:
{
  competency_line_master_id: "uuid",
  line_code: "CP99A - CR0001",        // 마스터에서 복사
  main_title: "[콘텐츠 마케팅] ...",    // 마스터에서 복사
  output_link_1: "https://...",
  output_link_2: null,
  output_images: ["https://..."],
  target_user_ids: ["uuid", "uuid"],
  week_id: "uuid",
  submission_opens_at: "ISO",
  submission_closes_at: "ISO"
}
Response:
{
  success: true,
  data: {
    line: { ...cluster4_lines row },
    targets: [...],
    targetCount: 12
  }
}
Status: 201
```

**검증 규칙:**
- Output Asset: Link + Image 합산 최소 1, 최대 2
- target_user_ids: 최소 1명
- competency_line_master_id: 존재 + is_active=true 확인
- week_id: 존재 확인

### 6-3. 기존 API 재사용

| API | 용도 | 변경 |
|-----|------|------|
| GET /api/admin/cluster4/current-week | 현재 주차 조회 | 없음 |
| GET /api/admin/cluster4/lines?partType=competency | 기존 역량 라인 목록 | 없음 |
| GET /api/admin/cluster4/admin-org | 어드민 조직 조회 | 없음 |
| GET /api/admin/cluster4/teams?organization= | 팀 목록 (크루 필터용) | 없음 |
| GET /api/admin/cluster4/crews?organization= | 크루 목록 (필터 포함) | 없음 |
| POST /api/admin/cluster4/upload-image | 이미지 업로드 | 없음 |

---

## 7. Migration 필요 목록

### Migration 1: cluster4_competency_line_masters 테이블 생성

```
파일명: 2026-05-XX_cluster4_competency_line_masters.sql

내용:
1. CREATE TABLE cluster4_competency_line_masters
   - id, organization_slug, line_code, line_name, main_title,
     source_file_name, is_active, created_at, updated_at
   - UNIQUE(organization_slug, line_code)
   - INDEX(organization_slug), INDEX(is_active)
   - updated_at trigger (touch_cluster4_updated_at)
   - GRANT SELECT TO anon, authenticated

2. ALTER TABLE cluster4_lines
   - ADD COLUMN competency_line_master_id uuid NULL
   - ADD FK → cluster4_competency_line_masters(id) ON DELETE SET NULL
   - ADD INDEX (competency_line_master_id) WHERE NOT NULL

3. oranke seed (운영 데이터 확정 후)

의존: 2026-05-26_cluster4_line_opening_step1_tables.sql
```

### Migration 2: oranke 라인 마스터 seed

```
운영팀에서 oranke 실무 역량 라인 데이터 확정 후 seed.
line_code, line_name, main_title 3개 필드 확인 필요.
```

---

## 8. 구현 우선순위

### Phase 1 (MVP)

| 순번 | 항목 | 상세 |
|------|------|------|
| 1 | Migration | cluster4_competency_line_masters 생성 + cluster4_lines 확장 |
| 2 | Seed | oranke 실무 역량 라인 마스터 등록 |
| 3 | Types | lib/adminCompetencyLineTypes.ts (experience와 동일 패턴) |
| 4 | Data Layer | lib/adminCompetencyLineData.ts |
| 5 | 마스터 API | GET/POST/PATCH/DELETE /competency-line-masters |
| 6 | 라인 개설 API | POST /competency-lines |
| 7 | UI 컴포넌트 | PracticalCompetencyManager.tsx (3탭) |
| 8 | 페이지 | /admin/line-opening/practical-competency |
| 9 | 메뉴 활성화 | adminLineOpening.ts enabled: true |

### Phase 2 (카페 링크 집계)

| 순번 | 항목 | 상세 |
|------|------|------|
| 1 | 카페 링크 수집 테이블 설계 | 링크 URL, 작성자, 수집일시 |
| 2 | 카페 링크 집계 API | 링크 기반 대상자 자동 추출 |
| 3 | 카페 링크 집계 UI | 세 번째 탭 활성화 |
| 4 | target_mode='rule' | 규칙 기반 대상자 자동 설정 |

### 코드 재사용 전략

실무 경험과 90% 동일한 구조이므로:
- Types: experience 패턴 복제 후 이름만 변경 (team_id 제외)
- Data Layer: experience 패턴 복제 (team join 제거)
- API: experience 패턴 복제 (마스터 검증 대상 테이블만 변경)
- UI: PracticalExperienceManager.tsx 기반으로 탭 순서 변경, team 필드 제거, 카페 링크 탭 추가

---

## 9. 미결 사항

### 9-1. oranke 실무 역량 Seed 데이터

운영팀에서 실무 역량 라인 데이터를 확정해야 한다.

필요 필드: `line_code`, `line_name`, `main_title`

실무 경험 6개가 등록된 것처럼, 실무 역량도 동일 형식의 데이터가 필요하다.

### 9-2. activity_types 기존 competency 데이터 처리

현재 `activity_types`에 `cluster_id = 'practical_competency'`로 등록된 검증용 시드(`verify-comp-1`)가 있다.

**선택지:**
- A) 기존 activity_types competency 데이터를 마스터로 마이그레이션
- B) 검증용 시드이므로 무시하고 새 마스터 테이블만 사용
- C) activity_types의 competency 시드를 비활성화(is_active=false) 처리

**권장**: B — 검증용 시드(`verify-comp-1`)는 이미 클린업 대상이며, 실운영 competency 데이터는 없다.

### 9-3. classifyActivityType 함수 영향

`lib/cluster4WeeklyGrowthData.ts`의 `classifyActivityType()`이 `comp-` prefix로 competency를 분류한다. 새 마스터의 line_code 형식이 `CP99A - CR0001`이면 이 함수를 업데이트해야 한다.

```typescript
// 현재
if (clusterId === "practical_competency" || clusterId.startsWith("comp-"))
  return "ability"

// 변경 필요
if (clusterId === "practical_competency"
    || clusterId.startsWith("comp-")
    || clusterId.startsWith("CP"))     // 새 line_code 패턴
  return "ability"
```

**또는** cluster4_lines.part_type 기반 분류로 전환하면 line_code 패턴 의존을 제거할 수 있다.

### 9-4. encre/phalanx 조직 확장 시점

oranke 이외 조직의 실무 역량 마스터는 언제 등록하는가? 동일 마이그레이션에서 seed하는가, 별도 시점인가?

### 9-5. 라인 마스터 공통화 검토

실무 경험(experience_line_masters)과 실무 역량(competency_line_masters)의 구조가 거의 동일하다(team_id 유무만 다름). 장기적으로 하나의 `cluster4_line_masters` 테이블에 `part_type` 컬럼을 두어 통합하는 방안도 검토 가능하나, 현 단계에서는 별도 테이블이 안전하다.

**통합 미적용 이유:**
- 실무 경험은 team_id FK가 필요하고, 실무 역량은 불필요
- 각 허브별 시드 데이터와 운영 정책이 독립적
- 테이블 분리 시 FK 제약이 명확하고, 실수로 다른 part_type 마스터를 참조하는 것을 방지
- 추후 통합 판단은 3개 이상 유사 마스터가 생길 때 재검토
