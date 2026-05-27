# Cluster4 Phase 0: 운영 DB 스키마 실사 보고서

> **작성일**: 2026-05-27
> **목적**: 최종 설계서 Migration A-1, A-2 확정을 위한 레거시 테이블 스키마 파악
> **기준 문서**: `cluster4-sync-bridge-final-design.md`
> **수정 사항 없음** — 조사 및 보고만 진행

---

## 조사 방법 및 한계

### 방법

운영 Supabase DB에 직접 접속(`\d+`)할 수 없으므로, 아래 증거를 총동원하여 스키마를 재구성했다.

```
1. Career-Resume/backend/database/schema/*.sql — 23개 파일 전수 확인
2. Career-Resume/app/(host)/api/**/*.ts — 모든 .from() 쿼리의 .select() / .insert() / .update() 절
3. Career-Resume/lib/*.ts — 서버 빌더 함수의 쿼리 컬럼
4. Career-Resume/components/**/*.tsx — 프론트 컴포넌트의 데이터 참조
5. Career-Resume/scripts/diag_*.mjs — 진단 스크립트의 쿼리
6. vraxium-admin/db/migrations/*.sql — 41개 마이그레이션 파일
```

### 한계

```
⚠ 아래 6개 테이블은 양 repo 어디에도 CREATE TABLE DDL이 없다.
  weekly_activities, activity_records, teams, parts, user_team_parts, user_role_history

⚠ 스키마는 코드 쿼리에서 추론한 것이며, 실제 DB에 추가 컬럼이 있을 수 있다.
⚠ DEFAULT 값, 일부 NOT NULL 제약, 인덱스는 확인 불가.
⚠ FK 관계는 추정이며, 실제 제약조건 존재 여부는 미확인.
```

**Migration A-1, A-2 확정 전 필수 작업**:

```sql
-- Supabase SQL Editor 또는 psql에서 실행
SELECT column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_name = 'weekly_activities'
ORDER BY ordinal_position;

SELECT column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_name = 'activity_records'
ORDER BY ordinal_position;

-- 인덱스 및 제약조건
SELECT conname, contype, pg_get_constraintdef(oid)
FROM pg_constraint
WHERE conrelid = 'public.weekly_activities'::regclass;

SELECT conname, contype, pg_get_constraintdef(oid)
FROM pg_constraint
WHERE conrelid = 'public.activity_records'::regclass;
```

---

## 1. weekly_activities 실제 DDL 요약

### DDL 탐색 결과

```
Career-Resume/backend/database/schema/ — 해당 파일 없음
Career-Resume/backend/database/migrations/ — 디렉토리 없음
vraxium-admin/db/migrations/ — 해당 파일 없음
```

**DDL 미존재 확정.** 운영 DB에 직접 생성된 것으로 판단.

### 코드 증거 기반 스키마 (확인도 순서)

| 컬럼명 | 추론 타입 | NULL | 확인도 | 근거 |
|---|---|---|---|---|
| `id` | uuid | NOT NULL | **확정** | profile/route.ts:519 `.select("id, ...")` |
| `week_id` | uuid | NOT NULL | **확정** | 모든 쿼리에서 `.eq("week_id", ...)` 필터 |
| `activity_type_id` | text | NOT NULL | **확정** | 모든 쿼리에서 select + eq 사용. 값: 'wisdom', 'essay' 등 text 형식 |
| `title` | text | NULL | **확정** | profile/route.ts:519 `.select("..., title, ...")` |
| `is_active` | boolean | NOT NULL | **확정** | 모든 쿼리에서 `.eq("is_active", true)` 필터 |
| `opened_at` | timestamptz | NULL | **확정** | activity-details/route.ts:238, ranking/route.ts:256 |
| `deadline` | timestamptz | NULL | **확정** | activity-details/route.ts:238, ranking/route.ts:256 |
| `team_id` | uuid | NULL | **확정** | activity-details/route.ts:238, diag_week9_competency.mjs:32 |
| `output_links` | jsonb | NULL | **확정** | profile/route.ts:519, Cluster4CardContent.tsx에서 `activity?.output_links` 사용 |
| `output_images` | jsonb | NULL | **높음** | Cluster4CardContent.tsx:5607 주석에서 `weekly_activities.output_images` 명시적 참조. 직접 select에서는 미출현 |

### PK / UNIQUE / FK 추정

```
PK:     id (uuid)
UNIQUE: (week_id, activity_type_id) 또는 (week_id, activity_type_id, team_id)
FK:     week_id → weeks.id (추정)
        team_id → teams.id (추정, nullable)
        activity_type_id → activity_types.id (FK 미부여 — 기존 관례)
```

**UNIQUE 키 불확실성**:
activity-details/route.ts:259 코드에서 같은 (week_id, activity_type_id)에 team_id가 다른 여러 행이 존재할 수 있음을 시사:

```
// 실무경험은 team_id 별로 weekly_activities 가 분리되어 있어서
// 유저 팀에 해당하는 행을 골라야 한다.
candidateRows.find(row => row.team_id === null)
  || candidateRows.find(row => row.team_id === userTeamId)
```

이 코드는 **UNIQUE가 (week_id, activity_type_id, team_id)**임을 시사한다.
(week_id, activity_type_id)만으로는 UNIQUE가 아닐 수 있다.

### output_images 존재 확인 상세

직접 `.select()`에 `output_images`가 나타나는 곳은 없으나, 프론트 코드가 이 필드를 참조한다:

```
Cluster4CardContent.tsx:5607:
  // 어드민 output_images(weekly_activities.output_images) 와 크루 image_urls 병합

Cluster4CardContent.tsx:5609:
  const adminImgs = (activity?.output_images || []).filter(...)
```

이는 `/api/profile` 응답의 weekBundle.weeklyActivities 배열에 output_images가 포함됨을 의미하나, profile/route.ts의 select 절에는 output_images가 없다.

**가능성**:
1. profile/route.ts의 select가 `"*"` 또는 더 넓은 컬럼을 포함하는 다른 경로가 존재
2. output_images가 별도 API에서 추가됨
3. output_images가 output_links의 일부로 jsonb에 포함

**→ 운영 DB 확인 필수.**

---

## 2. activity_records 실제 DDL 요약

### DDL 탐색 결과

```
Career-Resume/backend/database/schema/ — 해당 파일 없음
vraxium-admin/db/migrations/ — 해당 파일 없음
```

**DDL 미존재 확정.**

### 코드 증거 기반 스키마

| 컬럼명 | 추론 타입 | NULL | 확인도 | 근거 |
|---|---|---|---|---|
| `id` | uuid | NOT NULL | **확정** | profile/route.ts:555 `.select("id, ...")`, profile/summary/route.ts:153 |
| `user_id` | uuid | NOT NULL | **확정** | ranking/route.ts:264 `.select("user_id, ...")`, `.eq("user_id", ...)` 필터 |
| `week_id` | uuid | NOT NULL | **확정** | 모든 쿼리에서 `.eq("week_id", ...)` 또는 select 포함 |
| `activity_type_id` | text | NOT NULL | **확정** | 모든 쿼리에서 select 포함. text 형식 ('wisdom' 등) |
| `is_completed` | boolean | NOT NULL | **확정** | profile/route.ts:555, ranking/route.ts:264, 강화 판정의 유일 SoT |

### 추가 컬럼 탐색

코드에서 activity_records에 대한 INSERT/UPDATE/UPSERT 호출이 **발견되지 않았다**.
이 테이블은 Career-Resume 코드에서 **읽기 전용**으로만 사용된다.

쓰기 경로 추정:
- 별도 admin 도구 또는 Supabase Dashboard에서 직접 관리
- 또는 아직 미구현된 배치 프로세스

**→ 실제 DB에 `created_at`, `updated_at` 등 추가 컬럼이 있을 수 있다. 운영 DB 확인 필수.**

### PK / UNIQUE / FK 추정

```
PK:     id (uuid)
UNIQUE: (user_id, week_id, activity_type_id) — 추정
FK:     user_id → user_profiles.user_id (추정)
        week_id → weeks.id (추정)
INDEX:  (user_id) — .eq("user_id", ...) 패턴 빈출
        (week_id) — .eq("week_id", ...) 패턴 빈출
```

---

## 3. teams / parts / user_team_parts / user_role_history 구조 요약

### 3-1. teams

| 컬럼명 | 추론 타입 | NULL | 확인도 | 근거 |
|---|---|---|---|---|
| `id` | uuid | NOT NULL | **확정** | cluster4-weekly-cards.ts:118, cached-data.ts:31 |
| `name` | text | NOT NULL | **확정** | 동일 |

**PK**: id. **추가 컬럼 유무 불명.**

### 3-2. parts

| 컬럼명 | 추론 타입 | NULL | 확인도 | 근거 |
|---|---|---|---|---|
| `id` | uuid | NOT NULL | **확정** | cluster4-weekly-cards.ts:119, cached-data.ts:42 |
| `name` | text | NOT NULL | **확정** | 동일 |
| `team_id` | uuid | NULL | **확정** | cached-data.ts:42, ranking/route.ts:236 `.select("id, name, team_id")` |

**PK**: id. **FK**: team_id → teams.id (추정).

### 3-3. user_team_parts

| 컬럼명 | 추론 타입 | NULL | 확인도 | 근거 |
|---|---|---|---|---|
| `id` | uuid | NOT NULL | **높음** | PK 추정 (직접 select에 미출현이나, 표준 패턴) |
| `user_id` | uuid | NOT NULL | **확정** | profile/route.ts:560, `.eq("user_id", ...)` 필터 |
| `team_id` | uuid | NOT NULL | **확정** | cluster4-weekly-cards.ts:116, activity-details/route.ts:242 |
| `part_id` | uuid | NOT NULL | **확정** | cluster4-weekly-cards.ts:116 |
| `joined_at` | date/text | NOT NULL | **확정** | permissions.ts:112 `.lte("joined_at", today)` |
| `left_at` | date/text | NULL | **확정** | permissions.ts:113 `.or("left_at.is.null,left_at.gt.${today}")` |
| `generation` | integer | NULL | **확정** | cluster4-weekly-cards.ts:116, profile/route.ts:560 |
| `managed_team_id` | uuid | NULL | **확정** | cluster4-weekly-cards.ts:116, profile/route.ts:560 |

**PK**: id (추정). **FK**: user_id → user_profiles.user_id, team_id → teams.id, part_id → parts.id.

### 3-4. user_role_history

| 컬럼명 | 추론 타입 | NULL | 확인도 | 근거 |
|---|---|---|---|---|
| `id` | uuid | NOT NULL | **확정** | profile/route.ts:554 `.select("id, ...")` |
| `user_id` | uuid | NOT NULL | **확정** | 동일, `.eq("user_id", ...)` 필터 |
| `role` | text | NOT NULL | **확정** | permissions.ts:87, cluster4-weekly-cards.ts:117 |
| `started_at` | date/text | NOT NULL | **확정** | permissions.ts:90 `.lte("started_at", today)` |
| `ended_at` | date/text | NULL | **확정** | permissions.ts:91 `.or("ended_at.is.null,ended_at.gt.${today}")` |

**PK**: id. **FK**: user_id → user_profiles.user_id.

**role 값 목록** (cluster4-weekly-cards.ts:41-50, permissions.ts:14-46):

| 역할 | role 값 | 분류 |
|---|---|---|
| 일반 | `crew`, `crew_regular`, `crew_normal` | 일반 크루 |
| 파트장 | `part_leader`, `crew_partleader`, `crew_advanced_part_leader` | 심화 |
| 에이전트 | `crew_agent`, `crew_advanced_agent` | 심화 |
| 앰배서더 | `crew_ambassador`, `admin_ambassador`, `operations_ambassador` | 운영진 |
| 팀장 | `crew_team_leader`, `admin_team_leader`, `operations_teamleader` | 운영진 |

---

## 4. activity_types 실데이터 분석

### 현재 스키마 (Migration 확인됨)

```
activity_types (vraxium-admin/db/migrations/2026-05-21_activity_types_canonical.sql)

  id            text PK
  name          text NOT NULL
  line_code     text NOT NULL
  cluster_id    text NOT NULL    CHECK: practical_competency / practical_experience / practical_career
  description   text NULL
  eligible_min_approved_weeks  integer NULL
  eligible_max_approved_weeks  integer NULL
  count_once_in_total          boolean NOT NULL DEFAULT false
  is_active     boolean NOT NULL DEFAULT true
```

### 핵심 발견: `practical_info` cluster_id가 존재하지 않음

CHECK 제약조건:
```sql
cluster_id IN ('practical_competency', 'practical_experience', 'practical_career')
```

**info 타입은 activity_types 테이블에 포함되지 않는다.**

### info 타입 ID 목록 (하드코딩)

| 소스 파일 | 목록 | 개수 |
|---|---|---|
| `Cluster4CardContent.tsx:4855` | wisdom, essay, infodesk, calendar, forum, session, practical_lecture, community, etc_a | **9개** |
| `cluster-4-ranking/route.ts:9` | calendar, essay, forum, infodesk, session, wisdom, etc_a | **7개** |
| `Cluster4CardContent.tsx:549` (demo) | wisdom, essay, infodesk, calendar, forum, session, practical_lecture, community, etc_a | **9개** |

**불일치 발견**: ranking API에 `practical_lecture`, `community` 2개가 누락.

### competency 타입 (activity_types 테이블에서 관리)

```
cluster_id = 'practical_competency'

코드 참조 패턴:
  activity_types 테이블에서 cluster_id='practical_competency' AND is_active=true 쿼리
  → 결과의 id 값들이 competencyTypeIds
  → 검증 fixture: 'verify-comp-1' (seed에서 사용)
  → demo: 'comp-1', 'comp-2', 'comp-3', 'comp-4', 'comp-5'
```

### experience 타입 (activity_types 테이블에서 관리)

```
cluster_id = 'practical_experience'

코드 참조 패턴:
  activity_types 테이블에서 cluster_id='practical_experience' AND is_active=true 쿼리
  → eligible_min/max_approved_weeks로 적격 주차 범위 관리
  → 검증 fixture: 'verify-exp-1'
  → demo: 'exp-1', 'exp-2', 'exp-3', 'exp-4'
```

### career 타입 (activity_types 테이블에서 관리)

```
cluster_id = 'practical_career'

코드 참조 패턴:
  activity_types 테이블에서 cluster_id='practical_career' AND is_active=true 쿼리
  → careerTypeIds 배열
  → fallback: ["practical_project"] (careerTypeIds 비어있을 때)
  → 검증 fixture: 'verify-car-1'
```

### 운영 seed 데이터

activity_types 마이그레이션에 명시:
> "운영 row seed (taxonomy 마스터 정의) — 별도 단계 (운영 정책 결정 후)"

**운영 데이터 미시드 상태.** 테스트용 verify-* fixture만 존재.

### info 파트 분류 방식 결정

| 방식 | 설명 | 장점 | 단점 |
|---|---|---|---|
| **A. cluster_id 추가** | activity_types에 `practical_info` 추가 + info 타입 9개 INSERT | DB 기반 통합 관리, 드롭다운 자동 생성 가능 | CHECK 제약조건 변경 필요, 운영 seed 선행 |
| **B. 하드코딩 유지** | 현재 프론트/API의 하드코딩 목록 그대로 사용 | 변경 없음, 즉시 사용 가능 | 목록 불일치 (9개 vs 7개), 관리 분산, 어드민 드롭다운에 반영 불가 |

**권장: A (cluster_id 추가)**

근거:
1. 최종 설계서 §5에서 "어드민 UI에서 activity_types 드롭다운 필수 제공" 결정
2. 드롭다운 제공을 위해서는 info 타입도 activity_types에 존재해야 함
3. 하드코딩 목록 불일치 (9개 vs 7개)가 이미 버그 가능성 — DB 기반으로 통합하면 해결
4. CHECK 제약조건 변경은 단순 ALTER (위험도 낮음)

필요 작업:
```
1. activity_types CHECK 제약조건 변경:
   cluster_id IN ('practical_info', 'practical_competency', 'practical_experience', 'practical_career')

2. info 타입 9개 INSERT:
   wisdom, essay, infodesk, calendar, forum, session, practical_lecture, community, etc_a
   → cluster_id = 'practical_info'
   → line_code, name, description 등은 운영 정책에 따라 결정
```

---

## 5. Migration A-1 확정안 (weekly_activities canonical DDL)

### 상태: 초안 (운영 DB 확인 후 최종 확정)

```
Table: weekly_activities

컬럼:
  id                uuid         NOT NULL  DEFAULT gen_random_uuid()  PK
  week_id           uuid         NOT NULL                             FK → weeks.id
  activity_type_id  text         NOT NULL
  title             text         NULL
  is_active         boolean      NOT NULL  DEFAULT true
  opened_at         timestamptz  NULL
  deadline          timestamptz  NULL
  team_id           uuid         NULL
  output_links      jsonb        NOT NULL  DEFAULT '[]'::jsonb
  output_images     jsonb        NOT NULL  DEFAULT '[]'::jsonb
  created_at        timestamptz  NOT NULL  DEFAULT now()              (추정)

PK: id
UNIQUE: (week_id, activity_type_id, team_id)  ← team_id 포함 여부 운영 DB 확인 필수
FK:
  week_id → weeks.id ON DELETE RESTRICT
  team_id → (FK 미부여 가능 — teams DDL 부재)

Index:
  (week_id)
  (week_id, is_active)
```

### 미확정 사항

| 항목 | 미확정 이유 | 확인 방법 |
|---|---|---|
| UNIQUE 키 구성 | team_id 포함 여부 불명 | `\d+ weekly_activities` |
| output_images 컬럼 존재 | select 절에 직접 출현 안 함 | `information_schema.columns` |
| created_at / updated_at 존재 | 코드에서 미참조 | `information_schema.columns` |
| DEFAULT 값 | 코드에서 확인 불가 | `information_schema.columns` |
| 추가 컬럼 유무 | 코드 미참조 컬럼이 있을 수 있음 | `information_schema.columns` |

---

## 6. Migration A-2 확정안 (activity_records canonical DDL)

### 상태: 초안 (운영 DB 확인 후 최종 확정)

```
Table: activity_records

컬럼:
  id                uuid         NOT NULL  DEFAULT gen_random_uuid()  PK
  user_id           uuid         NOT NULL                             FK → user_profiles.user_id
  week_id           uuid         NOT NULL                             FK → weeks.id
  activity_type_id  text         NOT NULL
  is_completed      boolean      NOT NULL  DEFAULT false
  created_at        timestamptz  NOT NULL  DEFAULT now()              (추정)

PK: id
UNIQUE: (user_id, week_id, activity_type_id)
FK:
  user_id → user_profiles.user_id ON DELETE CASCADE
  week_id → weeks.id ON DELETE RESTRICT

Index:
  (user_id)
  (user_id, week_id)
  (week_id)
```

### 미확정 사항

| 항목 | 미확정 이유 | 확인 방법 |
|---|---|---|
| updated_at 존재 | 코드에서 미참조 | `information_schema.columns` |
| 추가 컬럼 유무 (completed_at 등) | INSERT/UPDATE 코드 미발견 | `information_schema.columns` |
| FK 실제 존재 여부 | 추정 | `pg_constraint` |
| is_completed DEFAULT | false 추정이나 미확인 | `information_schema.columns` |

---

## 7. 최종 권장안

### 즉시 실행 필요: 운영 DB 스키마 덤프

이 보고서의 Migration A-1, A-2 초안은 **코드 추론 기반**이다.
확정을 위해 아래 쿼리를 Supabase SQL Editor에서 실행해야 한다.

```sql
-- 1. weekly_activities 전체 스키마
SELECT column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'weekly_activities'
ORDER BY ordinal_position;

-- 2. activity_records 전체 스키마
SELECT column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'activity_records'
ORDER BY ordinal_position;

-- 3. 제약조건 (PK, UNIQUE, FK, CHECK)
SELECT c.conname, c.contype,
  CASE c.contype
    WHEN 'p' THEN 'PRIMARY KEY'
    WHEN 'u' THEN 'UNIQUE'
    WHEN 'f' THEN 'FOREIGN KEY'
    WHEN 'c' THEN 'CHECK'
  END AS type_label,
  pg_get_constraintdef(c.oid) AS definition
FROM pg_constraint c
JOIN pg_class t ON c.conrelid = t.oid
WHERE t.relname IN ('weekly_activities', 'activity_records')
ORDER BY t.relname, c.contype;

-- 4. 인덱스
SELECT tablename, indexname, indexdef
FROM pg_indexes
WHERE tablename IN ('weekly_activities', 'activity_records')
ORDER BY tablename, indexname;

-- 5. teams / parts / user_team_parts / user_role_history (보조)
SELECT column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name IN ('teams', 'parts', 'user_team_parts', 'user_role_history')
ORDER BY table_name, ordinal_position;

-- 6. activity_types 실데이터 (info 분류 결정용)
SELECT id, name, line_code, cluster_id, is_active,
  eligible_min_approved_weeks, eligible_max_approved_weeks,
  count_once_in_total
FROM activity_types
ORDER BY cluster_id, id;
```

### 운영 DB 확인 후 작업 흐름

```
Step 1: 위 6개 쿼리 실행 → 결과를 이 보고서에 추가

Step 2: 추론 스키마와 실제 스키마 비교
  → 불일치 항목 식별
  → Migration A-1, A-2 초안 수정

Step 3: Migration A-1, A-2 최종 확정
  → CREATE TABLE IF NOT EXISTS (이미 존재하므로 안전)
  → 또는 ALTER TABLE로 누락 컬럼/제약조건 추가

Step 4: activity_types CHECK 변경 + info 타입 seed
  → 'practical_info' cluster_id 추가
  → 9개 info 타입 INSERT

Step 5: Migration B-1 작성 (cluster4_lines 브릿지 컬럼)
  → activity_type_id, output_images, team_id 추가
  → 부분 UNIQUE 인덱스
```

### 추론 기반 확정 가능 항목 (운영 DB 미확인으로도 안전)

```
✅ activity_records 5개 컬럼 (id, user_id, week_id, activity_type_id, is_completed)
   → 모든 코드에서 일관되게 이 5개만 사용. 추가 컬럼이 있어도 sync에 영향 없음.

✅ activity_type_id는 text 타입
   → 'wisdom', 'comp-1' 등 text 값이 코드에서 직접 사용됨. uuid가 아님.

✅ weekly_activities의 핵심 10개 컬럼
   → 코드에서 직접 참조. 존재는 확정.

✅ info 타입 9개 목록
   → 프론트에서 하드코딩. 다만 ranking API 불일치는 별도 수정 필요.
```

### 추론 기반 확정 불가 항목 (운영 DB 확인 필수)

```
❓ weekly_activities UNIQUE 키 구성: (week_id, activity_type_id) vs (week_id, activity_type_id, team_id)
   → sync 함수의 ON CONFLICT 절에 직접 영향

❓ weekly_activities.output_images 컬럼 실제 존재 여부
   → Migration A-1에 포함 여부 결정

❓ activity_records 추가 컬럼 (created_at, updated_at, completed_at 등)
   → sync 함수에서 채워야 할 추가 필드 유무

❓ FK 제약조건 실제 존재 여부
   → Migration에서 FK 추가/수정 필요 여부
```

---

## 부록: info 타입 불일치 상세

### 프론트 (9개) vs Ranking API (7개) 비교

| activity_type_id | 프론트 (4855행) | Ranking API (9행) | 상태 |
|---|---|---|---|
| `wisdom` | O | O | 일치 |
| `essay` | O | O | 일치 |
| `infodesk` | O | O | 일치 |
| `calendar` | O | O | 일치 |
| `forum` | O | O | 일치 |
| `session` | O | O | 일치 |
| `etc_a` | O | O | 일치 |
| `practical_lecture` | O | **X** | **불일치** |
| `community` | O | **X** | **불일치** |

`practical_lecture`와 `community`가 ranking API에서 누락되어 있다.
이 2개 타입이 실제 운영에서 사용되는지 운영 DB의 weekly_activities 데이터로 확인 필요:

```sql
SELECT DISTINCT activity_type_id
FROM weekly_activities
WHERE activity_type_id IN ('practical_lecture', 'community')
  AND is_active = true;
```
