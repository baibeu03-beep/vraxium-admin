# Cluster4 Supabase DB 실사 보고서

> **작성일**: 2026-05-27
> **목적**: 프론트 UI 감사 보고서 기준, 실제 Supabase DB 구조 대조 및 Gap 분석
> **대상**: Cluster4 라인 개설 기능 관련 테이블 전수
> **수정 사항 없음** — 조사 및 보고만 진행

---

## 1. 테이블 존재 여부

### 조사 대상 14개 테이블

| # | 테이블명 | 존재 여부 | Migration 파일 | 비고 |
|---|---|---|---|---|
| 1 | `weekly_activities` | **존재 (추정)** | **없음** (양 repo 모두) | 코드에서 활발히 쿼리됨. DDL 없이 운영 DB에 직접 생성된 것으로 추정 |
| 2 | `activity_records` | **존재 (추정)** | **없음** (양 repo 모두) | 동일. 코드에서 활발히 쿼리됨 |
| 3 | `user_activity_details` | **존재** | `2026-05-22_cluster4_card_base_step1_user_activity_details.sql` | |
| 4 | `career_projects` | **존재** | `2026-05-22_cluster4_card_base_step2_career_projects.sql` | |
| 5 | `career_records` | **존재** | `2026-05-22_cluster4_card_base_step4_career_records.sql` | |
| 6 | `user_week_statuses` | **존재** | `2026-05-25_cluster3_growth_indicators.sql` | |
| 7 | `user_weekly_points` | **존재** | `2026-05-25_club_rank_weekly_points.sql` | |
| 8 | `weeks` | **존재** | `2026-05-25_cluster4_weeks_schema_alignment.sql` | Career-Resume 원본 + admin 정규화 |
| 9 | `season_definitions` | **존재** | `2026-05-25_season_definitions_and_user_seasons.sql` | |
| 10 | `activity_types` | **존재** | `2026-05-21_activity_types_canonical.sql` | |
| 11 | `teams` | **존재 (추정)** | **없음** (양 repo 모두) | 코드에서 쿼리됨 |
| 12 | `parts` | **존재 (추정)** | **없음** (양 repo 모두) | 코드에서 쿼리됨 |
| 13 | `user_team_parts` | **존재 (추정)** | **없음** (양 repo 모두) | 코드에서 쿼리됨 |
| 14 | `user_role_history` | **존재 (추정)** | **없음** (양 repo 모두) | 코드에서 쿼리됨 |

### 조사 대상 외 관련 테이블

| 테이블명 | Migration 파일 | 용도 |
|---|---|---|
| `career_project_weeks` | `2026-05-22_..._step3_career_project_weeks.sql` | career_projects × weeks junction |
| `weekly_reviews` | `2026-05-21_..._step1_create_weekly_reviews.sql` | 주차 리뷰 |
| `weekly_colleagues` | `2026-05-21_..._step2_create_weekly_colleagues.sql` | 연계 동료 |
| `weekly_reputations` | `2026-05-21_peer_review_pivot_step2_create_peer_review.sql` | 주차 평판 |
| `reputation_keywords` | 동일 파일 | 평판 키워드 마스터 |
| `season_reputations` | 동일 파일 | 시즌 평판 |
| `user_season_statuses` | `2026-05-25_season_definitions_and_user_seasons.sql` | 사용자 시즌 상태 |
| `cluster4_lines` | `2026-05-26_cluster4_line_opening_step1_tables.sql` | 라인 개설 (신규) |
| `cluster4_line_targets` | 동일 파일 | 라인 대상 매핑 (신규) |
| `cluster4_line_submissions` | 동일 파일 | 라인 제출 (신규) |

---

## 2. 테이블 구조

### 2-1. weekly_activities (Migration 없음 — 코드 추론)

> DDL이 양 repo 어디에도 없음. 운영 DB에 직접 생성된 것으로 추정.
> 아래 스키마는 Career-Resume 코드의 SELECT 문에서 추론한 것임.

```
컬럼명              데이터 타입      NULL 허용     비고
──────────────────────────────────────────────────────────────────
id                  uuid            NOT NULL      PK
week_id             uuid            NOT NULL      FK → weeks.id
activity_type_id    text            NOT NULL
title               text            NULL          Main Title (profile API L519에서 select)
is_active           boolean         NOT NULL
opened_at           timestamptz     NULL
deadline            timestamptz     NULL
team_id             uuid            NULL          실무 경험 팀 지정 (activity-details API L238)
output_links        jsonb           NULL          운영진 Output Link (profile API L519)
output_images       jsonb           NULL          운영진 Output Image (Cluster4CardContent L5607 주석)

PK: id
FK: week_id → weeks.id (추정)
UNIQUE: 불명
Index: 불명
```

**근거 코드**:
- `Career-Resume/app/(host)/api/profile/route.ts:518-519`: `.select("id, activity_type_id, title, is_active, opened_at, output_links")`
- `Career-Resume/app/(host)/api/activity-details/route.ts:237-238`: `.select('is_active, opened_at, deadline, team_id')`
- `Career-Resume/scripts/diag_week9_competency.mjs:32`: `.select("id, activity_type_id, is_active, team_id, ...")`
- `Career-Resume/components/cluster-4-card/Cluster4CardContent.tsx:5607`: `weekly_activities.output_images` 참조

### 2-2. activity_records (Migration 없음 — 코드 추론)

```
컬럼명              데이터 타입      NULL 허용     비고
──────────────────────────────────────────────────────────────────
id                  uuid            NOT NULL      PK
user_id             uuid            NOT NULL      FK → user_profiles.user_id
week_id             uuid            NOT NULL      FK → weeks.id
activity_type_id    text            NOT NULL
is_completed        boolean         NOT NULL      강화 성공/실패 판정 기준

PK: id
FK: user_id → user_profiles.user_id, week_id → weeks.id (추정)
UNIQUE: 불명 (아마 (user_id, week_id, activity_type_id))
Index: 불명
```

**근거 코드**:
- `Career-Resume/app/(host)/api/profile/route.ts:555,760`: `.select("id, week_id, activity_type_id, is_completed")`
- `Career-Resume/app/(host)/api/cluster-4-ranking/route.ts:263-264`: `.select('user_id, activity_type_id, is_completed')`

### 2-3. user_activity_details (Migration 확인됨)

```
컬럼명                데이터 타입      NULL 허용   DEFAULT              비고
──────────────────────────────────────────────────────────────────────────
id                    uuid            NOT NULL    gen_random_uuid()    PK
user_id               uuid            NOT NULL                         FK → user_profiles.user_id ON DELETE CASCADE
week_id               uuid            NOT NULL                         FK → weeks.id ON DELETE RESTRICT
activity_type_id      text            NOT NULL                         FK 없음 (자유 텍스트 키)
sub_title             text            NULL
output_links          jsonb           NOT NULL    '[]'::jsonb
growth_point          text            NULL
image_urls            text[]          NOT NULL    '{}'
image_captions        text[]          NOT NULL    '{}'
growth_image_url      text            NULL
growth_image_caption  text            NULL
rating                smallint        NULL                              CHECK: 0~10
created_at            timestamptz     NOT NULL    now()
updated_at            timestamptz     NOT NULL    now()                 trigger 자동 갱신

PK: id
UNIQUE: (user_id, week_id, activity_type_id)
Index: user_id / (user_id, week_id) / activity_type_id
Trigger: updated_at 자동 갱신
```

### 2-4. career_projects (Migration 확인됨)

```
컬럼명                     데이터 타입      NULL 허용   DEFAULT
──────────────────────────────────────────────────────────────────────
id                         uuid            NOT NULL    gen_random_uuid()    PK
company_name               text            NULL
company_logo_url           text            NULL
job_position               text            NULL
project_name               text            NULL
project_description        text            NULL
line_code                  text            NULL
line_name                  text            NULL
output_links               jsonb           NOT NULL    '[]'::jsonb
output_images              jsonb           NOT NULL    '[]'::jsonb
company_homepage_links     jsonb           NOT NULL    '[]'::jsonb
secondary_info_deadline    timestamptz     NULL
supervisor_name            text            NULL
supervisor_position        text            NULL
supervisor_department      text            NULL
supervisor_company         text            NULL
supervisor_profile_img     text            NULL
created_at                 timestamptz     NOT NULL    now()

PK: id
FK: 없음 (마스터 테이블)
```

### 2-5. career_project_weeks (Migration 확인됨)

```
컬럼명        데이터 타입      NULL 허용   DEFAULT
──────────────────────────────────────────────────────
project_id    uuid            NOT NULL    FK → career_projects.id ON DELETE CASCADE
week_id       uuid            NOT NULL    FK → weeks.id ON DELETE RESTRICT
is_active     boolean         NOT NULL    true
created_at    timestamptz     NOT NULL    now()

PK: (project_id, week_id) — 복합 PK
Index: week_id
```

### 2-6. career_records (Migration 확인됨)

```
컬럼명                데이터 타입     NULL 허용   DEFAULT              비고
──────────────────────────────────────────────────────────────────────────
id                    uuid           NOT NULL    gen_random_uuid()    PK
user_id               uuid           NOT NULL                         FK → user_profiles ON DELETE CASCADE
week_id               uuid           NOT NULL                         FK → weeks ON DELETE RESTRICT
project_id            uuid           NOT NULL                         FK → career_projects ON DELETE RESTRICT
enhancement_status    text           NULL                              CHECK: not_applicable/pending/enhanced/failed
grade                 text           NULL                              CHECK: S/A/B/C/D
grade_points          integer        NULL                              CHECK: >= 0
career_code           text           NULL
created_at            timestamptz    NOT NULL    now()

PK: id
UNIQUE: (user_id, week_id, project_id)
Index: user_id / (user_id, week_id) / project_id
```

### 2-7. user_week_statuses (Migration 확인됨)

```
컬럼명            데이터 타입      NULL 허용   DEFAULT              비고
──────────────────────────────────────────────────────────────────────────
id                uuid            NOT NULL    gen_random_uuid()    PK
user_id           uuid            NOT NULL                         FK → user_profiles ON DELETE CASCADE
year              smallint        NOT NULL
week_number       smallint        NOT NULL                         CHECK: 1~53
week_start_date   date            NOT NULL
status            text            NOT NULL                         CHECK: success/fail/personal_rest/official_rest
note              text            NULL
created_at        timestamptz     NOT NULL    now()
updated_at        timestamptz     NOT NULL    now()

PK: id
UNIQUE: (user_id, year, week_number)
Index: user_id / (year, week_number) / (user_id, status)
Trigger: updated_at 자동 갱신
RPC: get_week_status_counts(uuid) 집계 함수
```

### 2-8. user_weekly_points (Migration 확인됨)

```
컬럼명            데이터 타입      NULL 허용   DEFAULT              비고
──────────────────────────────────────────────────────────────────────────
id                uuid            NOT NULL    gen_random_uuid()    PK
user_id           uuid            NOT NULL                         FK → user_profiles ON DELETE CASCADE
year              smallint        NOT NULL
week_number       smallint        NOT NULL                         CHECK: 1~53
week_start_date   date            NOT NULL
points            integer         NOT NULL    0                    해당 주 points
advantages        integer         NOT NULL    0                    해당 주 advantages
penalty           integer         NOT NULL    0                    해당 주 penalty
created_at        timestamptz     NOT NULL    now()
updated_at        timestamptz     NOT NULL    now()

PK: id
UNIQUE: (user_id, year, week_number)
Index: user_id / (year, week_number)
Trigger: updated_at 자동 갱신
```

### 2-9. weeks (Migration 확인됨)

```
컬럼명              데이터 타입      NULL 허용   DEFAULT              비고
──────────────────────────────────────────────────────────────────────────
id                  uuid            NOT NULL    gen_random_uuid()    PK
week_number         smallint        NULL                              레거시 week_index에서 백필
start_date          date            NULL                              레거시 started_at에서 백필
end_date            date            NULL                              레거시 ended_at에서 백필
season_key          text            NULL                              FK → season_definitions.season_key ON DELETE SET NULL
is_official_rest    boolean         NOT NULL    false
holiday_name        text            NULL
iso_year            smallint        NULL                              start_date에서 계산
iso_week            smallint        NULL                              start_date에서 계산
created_at          timestamptz     NOT NULL    now()

PK: id
UNIQUE: (iso_year, iso_week) — 조건부 (중복 시 skip)
FK: season_key → season_definitions.season_key
Index: (iso_year, iso_week) / start_date / season_key
```

### 2-10. season_definitions (Migration 확인됨)

```
컬럼명          데이터 타입      NULL 허용   DEFAULT     비고
──────────────────────────────────────────────────────────────
id              smallserial     NOT NULL                 PK
season_key      text            NOT NULL                 UNIQUE. 예: '2026-spring'
season_label    text            NOT NULL                 예: '2026년도 봄시즌'
season_type     text            NOT NULL                 CHECK: spring/summer/autumn/winter
start_date      date            NOT NULL
end_date        date            NOT NULL                 CHECK: end_date >= start_date
year            smallint        NULL                     schema alignment에서 추가

PK: id
UNIQUE: season_key
Index: (start_date, end_date)
시드: 2021~2029 총 36개 시즌
```

### 2-11. activity_types (Migration 확인됨)

```
컬럼명                          데이터 타입     NULL 허용   DEFAULT     비고
────────────────────────────────────────────────────────────────────────
id                              text           NOT NULL                PK (text: 'comp-1' 등 short code)
name                            text           NOT NULL
line_code                       text           NOT NULL
cluster_id                      text           NOT NULL                CHECK: practical_competency/practical_experience/practical_career
description                     text           NULL
eligible_min_approved_weeks     integer        NULL
eligible_max_approved_weeks     integer        NULL                    CHECK: min <= max
count_once_in_total             boolean        NOT NULL    false
is_active                       boolean        NOT NULL    true
created_at                      timestamptz    NOT NULL    now()
updated_at                      timestamptz    NOT NULL    now()

PK: id
Index: (cluster_id, is_active) / is_active
Trigger: updated_at 자동 갱신
```

### 2-12. teams (Migration 없음 — 코드 추론)

```
컬럼명    데이터 타입     NULL 허용   비고
────────────────────────────────────────
id        uuid           NOT NULL    PK
name      text           NOT NULL    팀 표시명

근거: cluster4-weekly-cards.ts L118: .from("teams").select("id, name")
```

### 2-13. parts (Migration 없음 — 코드 추론)

```
컬럼명     데이터 타입     NULL 허용   비고
─────────────────────────────────────────
id         uuid           NOT NULL    PK
name       text           NOT NULL    파트 표시명
team_id    uuid           NULL        FK → teams.id (ranking API L236에서 select)

근거: cluster-4-ranking/route.ts L236: .select("id, name, team_id")
```

### 2-14. user_team_parts (Migration 없음 — 코드 추론)

```
컬럼명            데이터 타입       NULL 허용   비고
──────────────────────────────────────────────────────
id                uuid             NOT NULL    PK (추정)
user_id           uuid             NOT NULL    FK → user_profiles
team_id           uuid             NOT NULL    FK → teams
part_id           uuid             NOT NULL    FK → parts
joined_at         date/text        NOT NULL    가입일
left_at           date/text        NULL        탈퇴일 (NULL=활성)
generation        integer          NULL        세대 번호
managed_team_id   uuid             NULL        관리 대상 팀 (파트장용)

근거: cluster4-weekly-cards.ts L116
```

### 2-15. user_role_history (Migration 없음 — 코드 추론)

```
컬럼명        데이터 타입     NULL 허용   비고
──────────────────────────────────────────────
id            uuid           NOT NULL    PK (추정)
user_id       uuid           NOT NULL    FK → user_profiles
role          text           NOT NULL    역할명 (crew/part_leader/agent 등)
started_at    date/text      NOT NULL    역할 시작일
ended_at      date/text      NULL        역할 종료일 (NULL=현재)

근거: cluster4-weekly-cards.ts L117, permissions.ts L87-95
```

### 2-16. weekly_reviews (Migration 확인됨)

```
컬럼명          데이터 타입      NULL 허용   DEFAULT              비고
──────────────────────────────────────────────────────────────────────
id              uuid            NOT NULL    gen_random_uuid()    PK
user_id         uuid            NOT NULL                         FK → user_profiles ON DELETE CASCADE
week_card_id    uuid            NOT NULL                         FK → weeks ON DELETE RESTRICT
rating          smallint        NOT NULL                         CHECK: 1~10
content         text            NOT NULL                         CHECK: 1~200자
created_at      timestamptz     NOT NULL    now()
updated_at      timestamptz     NOT NULL    now()

PK: id
UNIQUE: (user_id, week_card_id)
Index: user_id / week_card_id
```

### 2-17. weekly_colleagues (Migration 확인됨)

```
컬럼명          데이터 타입      NULL 허용   DEFAULT              비고
──────────────────────────────────────────────────────────────────────
id              uuid            NOT NULL    gen_random_uuid()    PK
user_id         uuid            NOT NULL                         FK → user_profiles ON DELETE CASCADE
week_card_id    uuid            NOT NULL                         FK → weeks ON DELETE RESTRICT
colleague_id    uuid            NOT NULL                         FK → user_profiles ON DELETE CASCADE
rank            smallint        NOT NULL                         CHECK: 1~3
message         text            NULL                              CHECK: <= 200자
created_at      timestamptz     NOT NULL    now()
updated_at      timestamptz     NOT NULL    now()

PK: id
UNIQUE: (user_id, week_card_id, colleague_id)
CHECK: user_id <> colleague_id (자기 등록 금지)
Index: (user_id, week_card_id) / colleague_id
```

### 2-18. weekly_reputations (Migration 확인됨)

```
컬럼명            데이터 타입       NULL 허용   DEFAULT              비고
──────────────────────────────────────────────────────────────────────────
id                uuid             NOT NULL    gen_random_uuid()    PK
reviewer_id       uuid             NOT NULL                         FK → user_profiles ON DELETE CASCADE
target_user_id    uuid             NOT NULL                         FK → user_profiles ON DELETE CASCADE
week_card_id      uuid             NOT NULL                         FK → weeks ON DELETE RESTRICT
rating            numeric(3,1)     NOT NULL                         CHECK: 0~10, 0.5 단위
content           text             NOT NULL                         CHECK: 1~100자
keyword           text             NOT NULL                         CHECK: >= 1자
created_at        timestamptz      NOT NULL    now()
updated_at        timestamptz      NOT NULL    now()

PK: id
UNIQUE: (reviewer_id, target_user_id, week_card_id)
CHECK: reviewer_id <> target_user_id (자기 리뷰 금지)
Index: (target_user_id, week_card_id) / (reviewer_id, week_card_id)
```

### 2-19. cluster4_lines (Migration 확인됨 — 신규)

```
컬럼명                  데이터 타입      NULL 허용   DEFAULT              비고
──────────────────────────────────────────────────────────────────────────────
id                      uuid            NOT NULL    gen_random_uuid()    PK
part_type               text            NOT NULL                         CHECK: info/experience/competency/career
main_title              text            NOT NULL                         CHECK: btrim != ''
output_link_1           text            NULL
submission_opens_at     timestamptz     NOT NULL
submission_closes_at    timestamptz     NOT NULL                         CHECK: opens <= closes
is_active               boolean         NOT NULL    true
created_by              uuid            NULL                              FK → admin_users ON DELETE SET NULL
updated_by              uuid            NULL                              FK → admin_users ON DELETE SET NULL
created_at              timestamptz     NOT NULL    now()
updated_at              timestamptz     NOT NULL    now()

PK: id
Index: (part_type, is_active, submission_opens_at, submission_closes_at) / (created_at DESC)
```

### 2-20. cluster4_line_targets (Migration 확인됨 — 신규)

```
컬럼명            데이터 타입     NULL 허용   DEFAULT            비고
──────────────────────────────────────────────────────────────────────
id                uuid           NOT NULL    gen_random_uuid()  PK
line_id           uuid           NOT NULL                        FK → cluster4_lines ON DELETE CASCADE
week_id           uuid           NOT NULL                        FK → weeks ON DELETE CASCADE
target_mode       text           NOT NULL                        CHECK: user/rule
target_user_id    uuid           NULL                             FK → user_profiles ON DELETE CASCADE
target_rule       jsonb          NOT NULL    '{}'::jsonb
created_by        uuid           NULL                             FK → admin_users
updated_by        uuid           NULL                             FK → admin_users
created_at        timestamptz    NOT NULL    now()
updated_at        timestamptz    NOT NULL    now()

PK: id
UNIQUE(partial): (line_id, week_id, target_user_id) WHERE target_mode='user'
UNIQUE(partial): (line_id, week_id, md5(target_rule)) WHERE target_mode='rule'
CHECK: user모드 → target_user_id NOT NULL + target_rule='{}'
       rule모드 → target_user_id IS NULL + target_rule is object
Index: (week_id, target_mode) / (target_user_id, week_id) WHERE user
```

### 2-21. cluster4_line_submissions (Migration 확인됨 — 신규)

```
컬럼명            데이터 타입      NULL 허용   DEFAULT              비고
──────────────────────────────────────────────────────────────────────────
id                uuid            NOT NULL    gen_random_uuid()    PK
line_target_id    uuid            NOT NULL                          FK → cluster4_line_targets ON DELETE CASCADE
user_id           uuid            NOT NULL                          FK → user_profiles ON DELETE CASCADE
subtitle          text            NULL                               CHECK: NULL or btrim != ''
output_link_2     text            NULL
output_link_3     text            NULL
output_link_4     text            NULL
output_link_5     text            NULL
submitted_at      timestamptz     NOT NULL    now()
created_at        timestamptz     NOT NULL    now()
updated_at        timestamptz     NOT NULL    now()

PK: id
UNIQUE(partial): (line_target_id, user_id)
Trigger: user_id = target_user_id 검증 (user모드 시)
Index: (user_id, updated_at DESC)
```

---

## 3. 실제 관계도

### Migration 확인된 테이블 (FK 실존)

```
season_definitions
  ↑ (season_key FK)
  weeks
    ├── user_activity_details.week_id → weeks.id (RESTRICT)
    ├── career_project_weeks.week_id → weeks.id (RESTRICT)
    ├── career_records.week_id → weeks.id (RESTRICT)
    ├── weekly_reviews.week_card_id → weeks.id (RESTRICT)
    ├── weekly_colleagues.week_card_id → weeks.id (RESTRICT)
    ├── weekly_reputations.week_card_id → weeks.id (RESTRICT)
    ├── cluster4_line_targets.week_id → weeks.id (CASCADE)
    └── user_week_statuses (iso_year/iso_week 논리 연결, FK 없음)

user_profiles
  ├── user_activity_details.user_id → user_profiles.user_id (CASCADE)
  ├── career_records.user_id → user_profiles.user_id (CASCADE)
  ├── weekly_reviews.user_id → user_profiles.user_id (CASCADE)
  ├── weekly_colleagues.user_id → user_profiles.user_id (CASCADE)
  ├── weekly_colleagues.colleague_id → user_profiles.user_id (CASCADE)
  ├── weekly_reputations.reviewer_id → user_profiles.user_id (CASCADE)
  ├── weekly_reputations.target_user_id → user_profiles.user_id (CASCADE)
  ├── user_week_statuses.user_id → user_profiles.user_id (CASCADE)
  ├── user_weekly_points.user_id → user_profiles.user_id (CASCADE)
  ├── cluster4_line_targets.target_user_id → user_profiles.user_id (CASCADE)
  └── cluster4_line_submissions.user_id → user_profiles.user_id (CASCADE)

career_projects
  ├── career_project_weeks.project_id → career_projects.id (CASCADE)
  └── career_records.project_id → career_projects.id (RESTRICT)

admin_users
  ├── cluster4_lines.created_by → admin_users.id (SET NULL)
  ├── cluster4_lines.updated_by → admin_users.id (SET NULL)
  ├── cluster4_line_targets.created_by → admin_users.id (SET NULL)
  └── cluster4_line_targets.updated_by → admin_users.id (SET NULL)

cluster4_lines
  └── cluster4_line_targets.line_id → cluster4_lines.id (CASCADE)

cluster4_line_targets
  └── cluster4_line_submissions.line_target_id → cluster4_line_targets.id (CASCADE)
```

### Migration 없는 테이블 (코드 추론 관계)

```
teams
  └── parts.team_id → teams.id (추정)
  └── user_team_parts.team_id → teams.id (추정)

parts
  └── user_team_parts.part_id → parts.id (추정)

user_team_parts
  └── user_profiles.user_id ← user_team_parts.user_id (추정)

user_role_history
  └── user_profiles.user_id ← user_role_history.user_id (추정)

weekly_activities
  ├── weeks.id ← weekly_activities.week_id (추정)
  └── activity_types.id ← weekly_activities.activity_type_id (추정, FK 미부여)

activity_records
  ├── user_profiles.user_id ← activity_records.user_id (추정)
  └── weeks.id ← activity_records.week_id (추정)
```

---

## 4. 프론트 ↔ DB 매핑표

### 4-1. 실무 정보 (Work Info) 허브

| 항목 | 프론트 사용 | DB 존재 | 저장 위치 |
|---|---|---|---|
| Main Title | O | O | `weekly_activities.title` |
| Sub Title | O | O | `user_activity_details.sub_title` |
| Growth Point | O | O | `user_activity_details.growth_point` |
| Output Link (운영자) | O | O | `weekly_activities.output_links` |
| Output Link (사용자) | O | O | `user_activity_details.output_links` |
| Output Image (운영자) | O | O | `weekly_activities.output_images` |
| Output Image (사용자) | O | O | `user_activity_details.image_urls` |
| Image Caption | O | O | `user_activity_details.image_captions` |
| Enhancement Status | O | O (계산) | `activity_records.is_completed` 기반 계산 |
| Category | O | O | `activity_types.name` config 매핑 |
| is_active | O | O | `weekly_activities.is_active` |
| deadline | O | O | `weekly_activities.deadline` |

### 4-2. 실무 역량 (Work Ability) 허브

| 항목 | 프론트 사용 | DB 존재 | 저장 위치 |
|---|---|---|---|
| Main Title | O | O | `weekly_activities.title` |
| Line Code | O | O | `activity_types.line_code` |
| Line Name | O | O | `activity_types.name` → config 매핑 |
| Sub Title | O | O | `user_activity_details.sub_title` |
| Growth Point | O | O | `user_activity_details.growth_point` |
| Output Link (운영자) | O | O | `weekly_activities.output_links` |
| Output Link (사용자) | O | O | `user_activity_details.output_links` |
| Output Image (운영자) | O | O | `weekly_activities.output_images` |
| Output Image (사용자) | O | O | `user_activity_details.image_urls` |
| Enhancement Status | O | O (계산) | `activity_records.is_completed` 기반 계산 |

### 4-3. 실무 경험 (Work Exp) 허브

| 항목 | 프론트 사용 | DB 존재 | 저장 위치 |
|---|---|---|---|
| Main Title | O | O | `weekly_activities.title` |
| Line Code | O | O | `activity_types.line_code` |
| Badge (Name) | O | O | `activity_types.name` |
| Rating | O | O | `user_activity_details.rating` (0~10→0~5 변환) |
| Sub Title | O | O | `user_activity_details.sub_title` |
| Growth Point | O | O | `user_activity_details.growth_point` |
| Output Link (운영자) | O | O | `weekly_activities.output_links` |
| Output Link (사용자) | O | O | `user_activity_details.output_links` |
| Team 지정 | O | O | `weekly_activities.team_id` |
| Enhancement Status | O | O (계산) | `activity_records.is_completed` 기반 계산 |
| Crew 대상 지정 | O | **부분** | `weekly_activities`에 user 필터 없음. 새 시스템은 `cluster4_line_targets` |

### 4-4. 실무 경력 (Work Career) 허브

| 항목 | 프론트 사용 | DB 존재 | 저장 위치 |
|---|---|---|---|
| Company Name | O | O | `career_projects.company_name` |
| Company Logo | O | O | `career_projects.company_logo_url` |
| Project Name | O | O | `career_projects.project_name` |
| Job Position | O | O | `career_projects.job_position` |
| Line Code | O | O | `career_projects.line_code` |
| Line Name | O | O | `career_projects.line_name` |
| Grade | O | O | `career_records.grade` |
| Grade Points | O | O | `career_records.grade_points` |
| Enhancement Status | O | O | `career_records.enhancement_status` |
| Supervisor Name | O | O | `career_projects.supervisor_name` |
| Supervisor Position | O | O | `career_projects.supervisor_position` |
| Supervisor Dept | O | O | `career_projects.supervisor_department` |
| Supervisor Company | O | O | `career_projects.supervisor_company` |
| Supervisor Profile | O | O | `career_projects.supervisor_profile_img` |
| Output Link (운영자) | O | O | `career_projects.output_links` |
| Output Image (운영자) | O | O | `career_projects.output_images` |
| Company Homepage | O | O | `career_projects.company_homepage_links` |
| Sub Title | O | O | `user_activity_details.sub_title` (fallback: career_projects.project_description) |
| Growth Point | O | O | `user_activity_details.growth_point` |
| Output Link (사용자) | O | O | `user_activity_details.output_links` |
| Output Image (사용자) | O | O | `user_activity_details.image_urls` |
| 2차정보 마감 | O | O | `career_projects.secondary_info_deadline` |

### 4-5. 헤더 영역

| 항목 | 프론트 사용 | DB 존재 | 저장 위치 |
|---|---|---|---|
| Week Number | O | O | `weeks.week_number` |
| Season Year | O | O | `season_definitions.year` |
| Season Name | O | O | `season_definitions.season_type` |
| Start/End Date | O | O | `weeks.start_date` / `weeks.end_date` |
| Growth Status | O | O | `user_week_statuses.status` |
| Team Name | O | O | `teams.name` (via `user_team_parts`) |
| Part Name | O | O | `parts.name` (via `user_team_parts`) |
| Role Label | O | O | `user_role_history.role` → ROLE_LABELS |
| Points (star/shield/lightning) | O | **부분** | `user_weekly_points`에 points/advantages/penalty. 프론트는 star/shield/lightning 이름 사용 |

### 4-6. 부가 영역

| 항목 | 프론트 사용 | DB 존재 | 저장 위치 |
|---|---|---|---|
| 주차 리뷰 (rating + content) | O | O | `weekly_reviews` |
| 주차 평판 (rating + content + keyword) | O | O | `weekly_reputations` |
| 평판 FM Score | O | **X** | `weekly_reputations`에 `fm_score` 컬럼 없음 |
| 연계 동료 (rank + message) | O | O | `weekly_colleagues` |

---

## 5. Gap 분석

### 유지 가능 (이미 존재, 그대로 사용 가능)

```
user_activity_details.sub_title
user_activity_details.growth_point
user_activity_details.output_links
user_activity_details.image_urls
user_activity_details.image_captions
user_activity_details.rating (0~10)
user_activity_details.growth_image_url
user_activity_details.growth_image_caption

career_projects.company_name
career_projects.company_logo_url
career_projects.job_position
career_projects.project_name
career_projects.project_description
career_projects.line_code
career_projects.line_name
career_projects.output_links
career_projects.output_images
career_projects.company_homepage_links
career_projects.secondary_info_deadline
career_projects.supervisor_name / position / department / company / profile_img

career_records.enhancement_status
career_records.grade
career_records.grade_points

career_project_weeks.project_id / week_id / is_active

weeks.week_number / start_date / end_date / season_key / iso_year / iso_week
season_definitions.season_key / season_label / season_type / year / start_date / end_date

user_week_statuses.status (success/fail/personal_rest/official_rest)
user_weekly_points.points / advantages / penalty

activity_types.id / name / line_code / cluster_id / eligible_min/max_approved_weeks

weekly_reviews.rating / content
weekly_colleagues.rank / message / colleague_id
weekly_reputations.rating / content / keyword

cluster4_lines.part_type / main_title / output_link_1 / submission_opens_at / closes_at / is_active
cluster4_line_targets.line_id / week_id / target_mode / target_user_id / target_rule
cluster4_line_submissions.line_target_id / user_id / subtitle / output_link_2~5
```

### Migration 필요 (DDL 미존재 — 운영 DB 직접 생성 추정)

```
weekly_activities
  현재 상태: DDL 파일 양 repo 모두 없음. 운영 DB에서 직접 생성된 것으로 추정.
  필요 조치: canonical DDL 문서화 후 migration 파일 작성 필요.
  관련 컬럼: id, week_id, activity_type_id, title, is_active, opened_at, deadline, team_id,
             output_links, output_images

activity_records
  현재 상태: DDL 파일 양 repo 모두 없음. 운영 DB에서 직접 생성된 것으로 추정.
  필요 조치: canonical DDL 문서화 후 migration 파일 작성 필요.
  관련 컬럼: id, user_id, week_id, activity_type_id, is_completed

teams
  현재 상태: DDL 파일 없음.
  관련 컬럼: id, name

parts
  현재 상태: DDL 파일 없음.
  관련 컬럼: id, name, team_id

user_team_parts
  현재 상태: DDL 파일 없음.
  관련 컬럼: id, user_id, team_id, part_id, joined_at, left_at, generation, managed_team_id

user_role_history
  현재 상태: DDL 파일 없음.
  관련 컬럼: id, user_id, role, started_at, ended_at
```

### 신규 컬럼 필요

```
weekly_reputations.fm_score
  현재 상태: 프론트 UI 감사 보고서에서 fm_score 표시 확인. DB 컬럼 없음.
  DB 테이블: weekly_reputations
  필요 타입: numeric 또는 integer (추정)
```

### 구조 개선 검토

```
1. weekly_activities ↔ cluster4_lines 이중 구조

   현재 상태:
     - weekly_activities: 기존 라인 개설 시스템 (DDL 없음, 레거시)
     - cluster4_lines + cluster4_line_targets + cluster4_line_submissions: 신규 라인 개설 시스템

   검토 사항:
     - 두 시스템이 동일 도메인을 커버함
     - weekly_activities의 title/output_links/output_images 역할을
       cluster4_lines.main_title/output_link_1 과 cluster4_line_submissions 이 대체하는 구조
     - 전환 시점과 공존 기간 동안의 데이터 정합성 관리 필요

2. activity_records ↔ cluster4_line_submissions 이중 구조

   현재 상태:
     - activity_records.is_completed: 기존 강화 성공/실패 판정
     - cluster4_line_submissions: 신규 시스템에서의 제출 기록

   검토 사항:
     - 기존 강화 상태 계산 로직이 activity_records.is_completed에 의존
     - 신규 시스템 전환 시 강화 판정 로직도 함께 마이그레이션 필요

3. user_weekly_points 컬럼명 ↔ 프론트 이름 불일치

   현재 위치: user_weekly_points.points / advantages / penalty
   프론트 이름: star / shield / lightning
   검토 사항: 이름 불일치이지만 매핑으로 해결 가능. 구조 변경 불필요.

4. weekly_reputations.keyword 단일 컬럼 vs 프론트 keyword_1~3

   현재 위치: weekly_reputations.keyword (단일 text)
   프론트 감사: keyword_1, keyword_2, keyword_3 (3개)
   실제 DB: 주차 평판은 keyword 1개, 시즌 평판(season_reputations)은 keyword_1/2/3
   상태: 정상. 주차 = 1개, 시즌 = 3개로 의도된 설계.
```

---

## 6. 기능별 구현 가능 여부 평가

### 실무 정보 (Work Info)

| 항목 | 평가 | 근거 |
|---|---|---|
| 라인 개설 가능 여부 | **가능** | `cluster4_lines`(part_type='info') + `cluster4_line_targets` 으로 개설 가능 |
| 개설 대상 사용자 지정 | **가능** | `cluster4_line_targets.target_mode='user'` + `target_user_id` |
| 규칙 기반 대상 지정 | **가능** | `cluster4_line_targets.target_mode='rule'` + `target_rule` jsonb |
| Main Title 저장 | **가능** | `cluster4_lines.main_title` |
| Output Link 1 저장 | **가능** | `cluster4_lines.output_link_1` |
| 제출 기간 설정 | **가능** | `cluster4_lines.submission_opens_at / closes_at` |

### 실무 경험 (Work Exp)

| 항목 | 평가 | 근거 |
|---|---|---|
| 라인 개설 가능 여부 | **가능** | `cluster4_lines`(part_type='experience') |
| 팀 지정 가능 여부 | **부분 가능** | 기존 `weekly_activities.team_id` 존재. 신규 `cluster4_lines`에는 team_id 없음 |
| 평점 관리 가능 여부 | **가능** | `user_activity_details.rating` (0~10) 존재 |
| 사용자 2차 정보 저장 | **가능** | `user_activity_details` 또는 `cluster4_line_submissions` |

### 실무 역량 (Work Ability)

| 항목 | 평가 | 근거 |
|---|---|---|
| 라인 개설 가능 여부 | **가능** | `cluster4_lines`(part_type='competency') |
| 사용자별 라인 배정 | **가능** | `cluster4_line_targets` |
| 사용자 2차 정보 저장 | **가능** | `user_activity_details` 또는 `cluster4_line_submissions` |

### 실무 경력 (Work Career)

| 항목 | 평가 | 근거 |
|---|---|---|
| 경력 라인 등록 가능 여부 | **가능** | `career_projects` + `career_project_weeks` |
| 경력 라인 개설 가능 여부 | **가능** | `cluster4_lines`(part_type='career') 또는 기존 `career_project_weeks` |
| 감독자 정보 관리 | **가능** | `career_projects.supervisor_*` 컬럼 완비 |
| 등급/점수 관리 | **가능** | `career_records.grade / grade_points` |
| 강화 상태 관리 | **가능** | `career_records.enhancement_status` |

### 공통

| 항목 | 평가 | 근거 |
|---|---|---|
| 사용자 2차 정보 저장 | **가능** | `user_activity_details` 테이블 완비 (sub_title, growth_point, output_links, image_urls, image_captions) |
| 강화 성공/실패 판정 | **부분 가능** | 기존: `activity_records.is_completed` 기반. 신규 cluster4 시스템에서는 별도 판정 로직 필요 |
| 주차 성장률 계산 | **가능** | `user_week_statuses` + `user_weekly_points` + `weeks` 조합으로 계산 가능 |
| 포인트 관리 | **가능** | `user_weekly_points.points / advantages / penalty` |
| 주차 리뷰/평판/동료 | **가능** | `weekly_reviews` / `weekly_reputations` / `weekly_colleagues` 완비 |

---

## 7. 권장 Migration 대상 목록

> SQL 작성 금지. 목록만 기재.

### 우선순위 1: canonical DDL 문서화 (기존 테이블)

```
1. weekly_activities     — 운영 DB 스키마 덤프 후 canonical DDL 확정
2. activity_records      — 동일
3. teams                 — 동일
4. parts                 — 동일
5. user_team_parts       — 동일
6. user_role_history     — 동일
```

이 6개 테이블은 운영 DB에 존재하나 DDL이 어느 repo에도 없음. 운영 DB에서 `\d+ 테이블명` 또는 `pg_dump --schema-only` 으로 실제 스키마를 확인한 후 canonical migration 파일을 작성해야 함.

### 우선순위 2: 신규 컬럼 추가

```
7. weekly_reputations.fm_score — 프론트에서 표시하나 DB 컬럼 미존재
```

### 우선순위 3: 신규 시스템 ↔ 레거시 연결

```
8. cluster4_lines.team_id        — 실무 경험 팀 지정 (기존 weekly_activities.team_id 대응)
9. cluster4_lines ↔ activity_types 연결 방안 확정
   — activity_type_id FK 또는 part_type 기반 매핑 규칙
10. cluster4_line_submissions ↔ activity_records 연동 방안
    — 강화 성공/실패 판정을 신규 시스템에서 어떻게 처리할지 결정
11. cluster4_lines ↔ weekly_activities 공존/전환 계획
    — 동일 도메인 이중 구조의 전환 시점 및 데이터 정합성 관리
```

### 우선순위 4: 구조 개선 후보

```
12. weekly_activities.output_images → cluster4_lines 이전 시 output_image 저장 구조 확정
13. career_projects ↔ cluster4_lines(part_type='career') 연동 방안
    — career_projects는 독립 마스터, cluster4_lines는 라인 개설 시스템
    — 이중 관리 or 통합 결정 필요
```

---

## 부록: 조사에 사용된 소스

### vraxium-admin 마이그레이션 (41개 SQL 파일)
- `db/migrations/2026-05-21_activity_types_canonical.sql`
- `db/migrations/2026-05-21_cluster4_card_blocker_step1_create_weekly_reviews.sql`
- `db/migrations/2026-05-21_cluster4_card_blocker_step2_create_weekly_colleagues.sql`
- `db/migrations/2026-05-21_peer_review_pivot_step2_create_peer_review.sql`
- `db/migrations/2026-05-22_cluster4_card_base_step1_user_activity_details.sql`
- `db/migrations/2026-05-22_cluster4_card_base_step2_career_projects.sql`
- `db/migrations/2026-05-22_cluster4_card_base_step3_career_project_weeks.sql`
- `db/migrations/2026-05-22_cluster4_card_base_step4_career_records.sql`
- `db/migrations/2026-05-25_cluster3_growth_indicators.sql`
- `db/migrations/2026-05-25_cluster4_weeks_schema_alignment.sql`
- `db/migrations/2026-05-25_season_definitions_and_user_seasons.sql`
- `db/migrations/2026-05-25_club_rank_weekly_points.sql`
- `db/migrations/2026-05-26_cluster4_line_opening_step1_tables.sql`

### Career-Resume 코드 참조
- `app/(host)/api/profile/route.ts:518-519` — weekly_activities select
- `app/(host)/api/activity-details/route.ts:237-238` — weekly_activities select (team_id)
- `app/(host)/api/cluster-4-ranking/route.ts:255-266` — weekly_activities + activity_records
- `lib/cluster4-weekly-cards.ts:113-129` — 전체 테이블 쿼리
- `lib/permissions.ts:87-116` — user_role_history, user_team_parts
- `components/cluster-4-card/Cluster4CardContent.tsx:5607` — output_images 주석

### 프론트 UI 감사 보고서
- `Career-Resume/claudedocs/cluster4-card-ui-audit.md`
