# Cluster4 — Reputation System Foundation 설계 보고

> **작성일**: 2026-05-20
> **작성 컨텍스트**: vraxium-admin repo / Claude Code 진단
> **상태**: 설계 단계 (코드/마이그레이션 변경 전, 검토용)
> **선행 문서**: `claudedocs/cluster4-admin-design.md`

---

## 0. 범위 (확정)

이 단계는 **Reputation 생태계의 두 테이블만** 만들고, Front UI / aggregation / ranking / growth / completionRate / grade / statistics 는 **전부 후속 단계로 이연**합니다.

| 포함 | 제외 |
|---|---|
| `reputation_keywords` (master) | `weekly_reviews` |
| `weekly_reputations` (user-level) | `weekly_colleagues` |
| seed 전략 | `user_activity_details` |
| readonly GET API 2개 (설계만) | growth aggregation / completionRate |
| | ranking / grade / statistics |
| | PATCH/POST mutation (다음 단계) |
| | Front UI / Cluster4Editor 갱신 (다음 단계) |

설계 동기: **Cluster4 의 다른 모든 평판/성장 derived 값은 결국 `keyword_key + score` 의 합산이므로, master 키 표를 먼저 못 박지 않으면 후속 aggregation 이 synthetic key 위험에 노출됨** (선행 문서 §부록 위험표 참조).

---

## 1. 발견된 사실 (기존 코드 단서)

| 사실 | 위치 |
|---|---|
| `season_reputations` 는 이미 `keyword_key` (text) 를 stable key 로 사용 중 | `lib/adminCluster4Data.ts:269` |
| `weekly_reputations` / `reputation_keywords` 는 UI 에 "NOT_IMPLEMENTED_TABLES" 로 표기 — Supabase 에 아직 존재하지 않음 | `components/admin/Cluster4Editor.tsx:75-79` |
| `weeks` 마스터는 admin GET 에서 select("*") 로 가져옴 — **컬럼/PK 타입 미확인** | `lib/adminCluster4Data.ts:91` |
| 마이그레이션 컨벤션: `gen_random_uuid()` PK, `user_profiles(user_id)` FK CASCADE, `touch_*_updated_at` 트리거 | `db/migrations/2026-05-13_user_edit_windows.sql` 외 |

**보강 필요**: `weeks.id` 의 실제 타입(uuid vs smallint vs text). 본 설계는 두 가지 후보를 모두 제시하되, 최종 SQL 확정 전 schema 확인 1회 요청.

---

## 2. 스키마 제안

### 2-A. `reputation_keywords` (master)

```
keyword_key   text         PRIMARY KEY    -- stable text id, e.g. 'leadership'
label         text         NOT NULL       -- 표시명 (한글)
description   text         NULL           -- 키워드 설명 (admin/UI tooltip)
category      text         NULL           -- 그룹핑 ('soft_skill', 'execution', ...)
sort_order    integer      NOT NULL DEFAULT 0
is_active     boolean      NOT NULL DEFAULT true
created_at    timestamptz  NOT NULL DEFAULT now()
updated_at    timestamptz  NOT NULL DEFAULT now()
```

**결정 근거**:
- `keyword_key` 를 PK 로 직접 사용 → UUID id 를 추가하지 않음. 사용자 지침 "UUID FK 강제하지 말 것" + "text 기반 stable key 유지" 와 정합.
- `season_reputations.keyword_key` 와 동일 타입(text)이므로 향후 FK 추가 시 자연스럽게 정합.
- soft-delete: `is_active=false` 로 비활성화 (DELETE 하지 않음).

**보조 인덱스**: PK 만으로 충분. 단 정렬 조회 빈도가 높으면 `(is_active, sort_order)` 추가 가능 — 1차에선 불필요.

### 2-B. `weekly_reputations` (user-level)

```
id            uuid         PRIMARY KEY DEFAULT gen_random_uuid()
user_id       uuid         NOT NULL
                           REFERENCES public.user_profiles(user_id) ON DELETE CASCADE
week_id       <weeks.id>   NOT NULL
                           REFERENCES public.weeks(id)              ON DELETE RESTRICT
keyword_key   text         NOT NULL
                           REFERENCES public.reputation_keywords(keyword_key)
                           ON UPDATE CASCADE ON DELETE RESTRICT
score         numeric(5,2) NOT NULL
created_at    timestamptz  NOT NULL DEFAULT now()
updated_at    timestamptz  NOT NULL DEFAULT now()

UNIQUE (user_id, week_id, keyword_key)
CHECK (score >= 0)
```

**결정 근거**:
- `id uuid PK` + `(user_id, week_id, keyword_key) UNIQUE` 패턴: cluster2/3 mutation 코드가 항상 `id` 로 upsert 하는 컨벤션과 일치.
- `week_id`: `<weeks.id>` 는 placeholder. 실제 타입 확정 후 결정 (§5 위험 참조).
- `keyword_key` FK:
  - `ON UPDATE CASCADE` → master 의 keyword_key 변경 시 자동 전파. (단, master 키는 사실상 immutable 권장 — §5 위험 #2)
  - `ON DELETE RESTRICT` → 사용 중인 키워드 삭제 차단. 운영 사고 방지.
- `score numeric(5,2)`: 소수점 가능, 범위 -999.99 ~ 999.99. **점수 상한(예: 100)** 은 후속 단계의 비즈니스 룰이 확정된 뒤 CHECK 로 추가 권장.

**보조 인덱스**:
- `(user_id, week_id)` — 주 단위 조회 (가장 빈번한 read 패턴).
- `(week_id, keyword_key)` — (후속) 키워드별 cohort 집계용. **이번 단계에서는 추가하지 않음** (사용자 지침: aggregation 금지).

### 2-C. ER 다이어그램 (간단)

```
user_profiles            weeks                  reputation_keywords
  user_id (PK)            id (PK)                 keyword_key (PK)
      ▲                    ▲                          ▲
      │  CASCADE           │  RESTRICT                │  RESTRICT (UPDATE CASCADE)
      │                    │                          │
      └──────── weekly_reputations ──────────────────┘
                  id PK, score, ...
                  UNIQUE (user_id, week_id, keyword_key)
```

---

## 3. Migration SQL (실행 금지 — 검토용)

> 사용자 지침: **migration 자동 실행 금지**. 아래 파일은 작성 제안만 하고, `db/migrations/` 에 commit 하기 전에 본 보고서 승인을 거칩니다.

### 3-A. `db/migrations/2026-05-21_reputation_keywords.sql`

```sql
-- 2026-05-21_reputation_keywords.sql
-- Cluster4 평판 시스템의 마스터 키워드 표.
-- season_reputations.keyword_key / (신규) weekly_reputations.keyword_key 가 본 표를 참조.
-- stable text key 컨벤션. UUID id 는 두지 않음.

CREATE TABLE IF NOT EXISTS public.reputation_keywords (
  keyword_key   text         PRIMARY KEY,
  label         text         NOT NULL,
  description   text         NULL,
  category      text         NULL,
  sort_order    integer      NOT NULL DEFAULT 0,
  is_active     boolean      NOT NULL DEFAULT true,
  created_at    timestamptz  NOT NULL DEFAULT now(),
  updated_at    timestamptz  NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION public.touch_reputation_keywords_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS reputation_keywords_set_updated_at
  ON public.reputation_keywords;

CREATE TRIGGER reputation_keywords_set_updated_at
BEFORE UPDATE ON public.reputation_keywords
FOR EACH ROW
EXECUTE FUNCTION public.touch_reputation_keywords_updated_at();
```

### 3-B. `db/migrations/2026-05-21_weekly_reputations.sql`

> **선행 의존**: 3-A 가 먼저 실행되어야 함.
> **TBD**: `<weeks_id_type>` 자리에 실제 `weeks.id` 컬럼 타입을 확인해 넣을 것 (§5-위험 #1).

```sql
-- 2026-05-21_weekly_reputations.sql
-- 사용자 × 주차 × 평판 키워드 단위 점수 저장.
-- 본 단계에서 trigger/aggregation 은 추가하지 않는다. 그건 후속 단계.

CREATE TABLE IF NOT EXISTS public.weekly_reputations (
  id            uuid         PRIMARY KEY DEFAULT gen_random_uuid(),

  user_id       uuid         NOT NULL
                             REFERENCES public.user_profiles(user_id) ON DELETE CASCADE,

  week_id       <weeks_id_type> NOT NULL
                             REFERENCES public.weeks(id) ON DELETE RESTRICT,

  keyword_key   text         NOT NULL
                             REFERENCES public.reputation_keywords(keyword_key)
                             ON UPDATE CASCADE ON DELETE RESTRICT,

  score         numeric(5,2) NOT NULL,

  created_at    timestamptz  NOT NULL DEFAULT now(),
  updated_at    timestamptz  NOT NULL DEFAULT now(),

  CONSTRAINT weekly_reputations_score_nonneg_check CHECK (score >= 0),
  CONSTRAINT weekly_reputations_unique_user_week_keyword
    UNIQUE (user_id, week_id, keyword_key)
);

CREATE INDEX IF NOT EXISTS weekly_reputations_user_week_idx
  ON public.weekly_reputations (user_id, week_id);

CREATE OR REPLACE FUNCTION public.touch_weekly_reputations_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS weekly_reputations_set_updated_at
  ON public.weekly_reputations;

CREATE TRIGGER weekly_reputations_set_updated_at
BEFORE UPDATE ON public.weekly_reputations
FOR EACH ROW
EXECUTE FUNCTION public.touch_weekly_reputations_updated_at();
```

### 3-C. (선택) RLS 정책

이 repo 의 admin 라우트는 `supabaseAdmin` (service role) 으로 RLS 우회하므로 **이번 단계에서는 RLS 정책을 추가하지 않습니다**. 만약 Front 앱이 anon/authed key 로 직접 조회한다면 별도 PR 에서 RLS 정책을 정의 (선행 문서 §2-A 의 owner/admin 가드와 동일 원칙).

---

## 4. Seed 전략

### 4-A. 원칙
1. **별도 파일**로 분리. 스키마 마이그레이션과 데이터 마이그레이션은 분리.
2. **idempotent**: `ON CONFLICT (keyword_key) DO UPDATE` 로 라벨/순서/설명 변경이 재실행 가능.
3. **delete 하지 않음**: 키워드를 빼고 싶으면 `is_active=false` 로만 표시. 외래키 무결성 유지.
4. **key naming**: `snake_case`, ASCII 만. 영어 base. 다국어는 `label` 컬럼으로 분리.

### 4-B. 1차 seed 후보 (사용자 예시 그대로)

| keyword_key | label | category | sort_order |
|---|---|---|---|
| `leadership` | 리더십 | soft_skill | 10 |
| `communication` | 커뮤니케이션 | soft_skill | 20 |
| `responsibility` | 책임감 | soft_skill | 30 |
| `execution` | 실행력 | execution | 40 |
| `teamwork` | 팀워크 | soft_skill | 50 |
| `creativity` | 창의성 | execution | 60 |

> `category` 값(`soft_skill` / `execution`) 은 잠정 분류. **확정은 운영팀 결정 필요** — 1차 seed 는 우선 모두 `NULL` 로 두고, 카테고리 정책이 정해진 뒤 별도 PR 로 채워도 무방.

### 4-C. `db/migrations/2026-05-21_reputation_keywords_seed.sql` (예시)

```sql
-- 2026-05-21_reputation_keywords_seed.sql
-- idempotent seed for reputation_keywords. 운영팀 합의된 6개 키워드.
-- DELETE 사용 금지. 비활성화는 별도 PR 에서 is_active=false 로.

INSERT INTO public.reputation_keywords
  (keyword_key, label, description, category, sort_order, is_active)
VALUES
  ('leadership',     '리더십',         NULL, 'soft_skill', 10, true),
  ('communication',  '커뮤니케이션',   NULL, 'soft_skill', 20, true),
  ('responsibility', '책임감',         NULL, 'soft_skill', 30, true),
  ('execution',      '실행력',         NULL, 'execution',  40, true),
  ('teamwork',       '팀워크',         NULL, 'soft_skill', 50, true),
  ('creativity',     '창의성',         NULL, 'execution',  60, true)
ON CONFLICT (keyword_key) DO UPDATE
SET
  label       = EXCLUDED.label,
  category    = EXCLUDED.category,
  sort_order  = EXCLUDED.sort_order,
  is_active   = EXCLUDED.is_active,
  updated_at  = now();
-- description 은 conflict 시 덮어쓰지 않는다 (운영팀이 description 편집 후 재실행해도 잃지 않도록).
```

### 4-D. 기존 `season_reputations.keyword_key` 와의 정합

후속 PR 에서 (이번 단계 아님) 다음 검증을 수행 권장:
```sql
SELECT DISTINCT keyword_key
FROM public.season_reputations
WHERE keyword_key NOT IN (SELECT keyword_key FROM public.reputation_keywords);
```
- 결과 > 0 → seed 에 누락된 키가 있다는 뜻. 운영팀과 협의 후 seed 보강.
- 결과 = 0 → 추후 `season_reputations.keyword_key` 에도 동일 FK 추가 가능 (별도 PR).

---

## 5. API Response Shape (readonly GET — 설계만)

> **사용자 지침**: PATCH/POST 는 아직 구현하지 말 것. 설계도 본 단계 범위에서 제외.
> **위치 가정**: 이 admin repo 내부 라우트로 우선 설계. Front 앱에서 사용할 경우 같은 shape 를 Front repo 에서 재구현하거나, 본 admin route 를 공통 API 로 승격하는 별도 논의 필요.

### 5-A. `GET /api/reputation-keywords`

**Auth**: `requireAdmin(ADMIN_READ_ROLES)` (선행 문서의 admin GET 가드와 동일).
**Query params**:
- `active_only` (optional, default `true`): `true` 시 `is_active=true` 만 반환.
- `category` (optional): 카테고리 필터.

**200 응답**:
```jsonc
{
  "success": true,
  "data": {
    "keywords": [
      {
        "keyword_key": "leadership",
        "label": "리더십",
        "description": null,
        "category": "soft_skill",
        "sort_order": 10,
        "is_active": true
      }
      // ... sort_order ASC, keyword_key ASC 순
    ]
  }
}
```

**에러**:
- 401 — `{ success: false, error: "Unauthorized" }`
- 500 — `{ success: false, error: "<message>" }`

### 5-B. `GET /api/weekly-reputations`

**Auth**: `requireAdmin(ADMIN_READ_ROLES)` + `user_id` 가드 — `?userId=` 가 호출자의 admin 권한 안에 있어야 함.
**Query params**:
- `user_id` (required): 조회 대상 사용자 UUID (또는 `legacy_user_id` 매칭 — admin repo 컨벤션).
- `week_id` (optional): 특정 주차만 필터.
- `keyword_key` (optional): 특정 키워드만 필터.

**200 응답**:
```jsonc
{
  "success": true,
  "data": {
    "user_id": "<uuid>",
    "reputations": [
      {
        "id": "<uuid>",
        "user_id": "<uuid>",
        "week_id": "<weeks.id>",
        "keyword_key": "leadership",
        "score": 4.50,
        "created_at": "2026-05-19T08:32:11.000Z",
        "updated_at": "2026-05-19T08:32:11.000Z"
      }
      // ... ORDER BY week_id, keyword_key
    ]
  }
}
```

**중요**: 이번 단계 응답에는 **aggregation, average, ranking, completionRate, grade, weeks join, keyword label** 모두 포함하지 않음. 순수 row 만. 후속 단계가 별도 endpoint 로 합산을 다룬다.

**에러**:
- 400 — 필수 `user_id` 누락
- 401 — 미인증
- 403 — admin 권한 부족 OR cross-user 접근 차단 (선행 문서 §2-A 가드 패턴)
- 500 — 그 외

### 5-C. 응답 컨벤션 메모
- **snake_case** — 기존 Front 응답 (`season_reputations` 등) 과 정합. Admin Editor 에서만 camelCase 로 변환 (`lib/adminCluster4Data.ts` 패턴).
- `score` 는 numeric → JSON 직렬화 시 number. **string 으로 내보내지 말 것** (Supabase 클라이언트 기본 동작 검증 필요 — §5 위험 #3).
- 모든 row 의 `created_at`/`updated_at` 은 ISO 8601 UTC.

---

## 6. 위험 요소

| # | 위험 | 영향 | 대응 |
|---|---|---|---|
| 1 | `weeks.id` 타입 미확인 (uuid? smallint? text?) | 마이그레이션 자체가 실패하거나 FK 부정합 | **확정 전 SQL 작성 보류**. 사용자에게 `\d public.weeks` 또는 information_schema 결과 1회 요청 |
| 2 | `reputation_keywords.keyword_key` 텍스트 PK 의 rename 위험 | `ON UPDATE CASCADE` 가 데이터를 따라가지만, Front bundle 의 하드코딩 키, 분석 로그, 캐시 등이 어긋남 | 정책상 "**keyword_key 는 immutable**" 로 운영 가이드. rename 필요 시 새 row 추가 + 기존 row `is_active=false` 권장 |
| 3 | Supabase JS 클라이언트가 `numeric` 을 string 으로 반환할 가능성 | API 응답에서 `score: "4.50"` 같이 string 으로 노출 | route handler 에서 `Number(row.score)` 변환을 1회 정의 (헬퍼). 또는 응답 직전 sanitize. 첫 통신 시 검증 |
| 4 | seed 의 `category` 값 미확정 | 후속 UI 가 카테고리별 그룹핑할 때 재seed 필요 | 1차 seed 는 `category=NULL`로 두고, 정책 확정 후 별도 idempotent PR |
| 5 | `weekly_reputations.score` 상한 미정 | 점수 범위가 비즈니스 룰과 다르면 잘못된 데이터 진입 | 1차에는 `score >= 0` 만 강제. 상한 (예: 100, 5.0 등) 확정 시 ALTER TABLE 로 CHECK 추가 |
| 6 | Front 앱이 이미 `weekly_reputations` 라는 이름의 client-side 타입을 정의했을 가능성 | 응답 shape 충돌, 양쪽 동시 PR 필요 | Front repo 의 `weekly_reputations` 관련 타입/요청 코드 grep 결과 1회 공유 요청 |
| 7 | `keyword_key` FK 추가 후 기존 `season_reputations` 의 비-마스터 키 (있다면) 가 무결성 위반 | 후속 PR 에서 `season_reputations.keyword_key` FK 추가 시 마이그레이션 실패 | §4-D 의 사전 SELECT 검증을 별도 PR 에서 실행 후, 필요한 시드만 보강 |
| 8 | `/api/weekly-reputations` 가 admin 외부에서 호출될 때 cross-user read 노출 | 본 admin repo 가 service role 이면 가드 누락 시 RLS 우회로 타인 데이터 노출 | route handler 에서 `requireAdmin(ADMIN_READ_ROLES)` 필수. Front 가 같은 path 를 쓴다면 선행 문서 §2-A 의 owner/admin 가드 동일 적용 |
| 9 | 사용자 지침 위반 유혹: 한 PR 에 aggregation 끼워넣기 | 후속 단계 결합도 증가, 회귀 위험 | 본 PR 의 endpoint 는 row 만 반환. average/ranking/completionRate 류 필드 추가는 **별도 endpoint 로만** 진행 |

---

## 7. 다음 단계 (확인 필요 — 본 보고 승인 전)

1. **`weeks.id` 컬럼 타입 확인** (1회 SQL 또는 schema dump 공유). 확인 후 §3-B 의 `<weeks_id_type>` 자리를 확정.
2. seed 의 **6개 키워드 정책 확정** — label 한국어 표기, category 분류 정책, sort_order 간격 (10 단위 권장).
3. **score 단위/상한** — numeric(5,2) 로 충분한지, 정수 1~5 인지, 0~100 인지.
4. API 위치 — 이 admin repo 의 `/api/reputation-keywords`, `/api/weekly-reputations` 로 진행할지, 또는 admin 컨벤션을 따라 `/api/admin/...` prefix 로 격리할지 결정.
5. 위 확정 후, 본 보고서를 기반으로 **두 마이그레이션 + 한 seed 파일 + 두 route 파일** 의 코드 PR 을 별도 작업으로 진행.

---

## 부록 A. 본 단계가 의도적으로 **하지 않는** 것 (Anti-scope)

| 영역 | 사유 |
|---|---|
| Front UI / Cluster4Editor 갱신 | 사용자 지침: "Front UI 보다 schema + API foundation 우선" |
| `weekly_reviews`, `weekly_colleagues`, `user_activity_details` | 명시적 후속 단계 |
| growth aggregation / completionRate / ranking / grade / statistics | 명시적 후속 단계 — keyword master 가 stable 해진 뒤 안전하게 도입 |
| PATCH/POST mutation route | 본 단계는 readonly GET 설계까지만 |
| `EDITABLE_RESOURCES` 에 cluster4.weekly_reputations 추가 | 본 admin repo 의 admin route 는 edit-window 무관. 추가 필요 시 별도 PR |
| `season_reputations.keyword_key` 에 FK 추가 | 데이터 정합 검증(§4-D) 후 별도 PR |
| RLS 정책 | admin repo 는 service role 사용 — 본 단계에서 불필요. Front 가 별도 키로 조회 시 후속 PR |
