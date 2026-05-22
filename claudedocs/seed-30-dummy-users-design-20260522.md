# 30명 샘플 사용자 Seed 설계 보고서 v1

> **작성일**: 2026-05-22
> **상태**: 🟡 설계 단계 — SQL 적용 전 검토 필수
> **선결 조건**: §1-A "스키마 확인 필요" 항목들 live DB 조회로 확정 필요
> **핵심 원칙**: phalanx 실사용자 34명 zero-touch, 모든 더미 다층 식별 가능, 새 테이블만 추가하고 기존 테이블 ALTER 없음.
> **선행 문서**: [olympus-vraxium-field-mapping-matrix-20260522.md](./olympus-vraxium-field-mapping-matrix-20260522.md)
>
> **🟢 v2 정정 (2026-05-22)**:
> - 조직 배정: A'안 채택 (oranke 20 / encre 10 / phalanx 0) — encre/oranke 실사용자 0명 확인
> - `seasons.is_current` 컬럼 부재 확인 → 현재 시즌 선택 규칙: `ended_at IS NULL` 우선 → `started_at DESC` → `season_index DESC`
> - `weeks.week_number` 컬럼 부재, 실제 `week_index` (정정)
> - **§8 검증 SQL 은 `seed-step1-prereq-verification-20260522.sql` 별도 파일로 분리됨** (Q1~Q15)
> - **§9 Seed SQL v2 는 `seed-v2-20260522.sql` 별도 파일로 분리됨** — 본 §9 v1 SQL 은 deprecated

---

## §0. 산출물 11종 체크리스트

| # | 산출물 | 위치 |
|---|---|---|
| 1 | 현재 스키마 조사 결과 | §1 |
| 2 | 테스트 사용자 구분 정책 | §2 |
| 3 | 조직 배정 추천안 | §3 |
| 4 | Seed 대상 테이블 목록 | §5 |
| 5 | Insert 순서 | §6 |
| 6 | FK 의존성 | §6 |
| 7 | 30명 분포표 | §4 |
| 8 | 생성 전 검증 SQL | §8 |
| 9 | Seed SQL 초안 | §9 |
| 10 | Rollback SQL 초안 | §10 |
| 11 | 실사용자 보호 검증 SQL | §11 |

---

## §1. 현재 Supabase 스키마 조사 결과

### 1-A. 🔴 스키마 확인 필요 (live DB 조회 필수)

> 아래 항목은 repo 내 migration 에 없거나 ALTER 만 있어 정확한 컬럼 구조를 확정할 수 없음. **Seed SQL 작성 전에 `information_schema.columns` 조회 필수**.

| 테이블 | 확인 필요 사항 |
|---|---|
| `organizations` | CREATE TABLE 부재. slug/name/display_name/is_active 외 컬럼 구조 미확정. **encre/oranke/phalanx 외 다른 slug 존재 여부** |
| ~~`seasons`~~ ✅ 확정 | `id uuid, season_index integer, name text, started_at timestamptz, ended_at timestamptz nullable` — **is_current 컬럼 없음**. 현재 시즌 선택: `ended_at IS NULL` 우선 |
| ~~`weeks`~~ ✅ 확정 | `id uuid, season_id uuid, week_index integer, started_at timestamptz, ended_at timestamptz` — **week_number 컬럼 없음**, week_index 사용 |
| `user_memberships` | PK 정의 (composite? user_id?). is_current 운영 정책. NOT NULL 컬럼 |
| `user_cumulative_points` | NOT NULL 컬럼, default 값 (특히 total_shields = 5 여부) |
| `user_growth_stats` | NOT NULL 컬럼, default 값 |
| `user_cluster2` | 모든 17개 컬럼의 NOT NULL/default. timestamps 존재 여부 |
| `user_introductions` | rating 타입 (smallint vs integer), CHECK 제약 |
| `user_educations` | admission_year/graduation_year/grade_value 실제 타입 (text/integer/numeric) |
| `user_season_histories` | rating 외 모든 컬럼, FK 구조 |
| `activity_types` | 데이터 row 수 (canonical seed 적재 여부) |
| `reputation_keywords` | 100 키워드 seed 적재 여부 |
| `portfolio_top_cards` | jsonb 컬럼들 (sub_image_urls, roles, tools, metrics, links) 정확한 shape |
| `portfolio_channel_cards` | rating 타입, image_urls/metrics jsonb shape |
| `career_projects` | 마스터 테이블 row 수 (이미 운영중 데이터 존재 여부) |
| `legacy_crew_import` | row 수 (phalanx 34명 매핑 포함 여부) |
| RLS 정책 | service_role bypass 가능 여부 확인 |
| `auth.users` 생성 권한 | service_role 로 SQL INSERT 가능 여부 (또는 Auth API 필수) |

### 1-B. ✅ 확정된 스키마 (migration source)

| 테이블 | source | 주요 제약 |
|---|---|---|
| `applicants` | 2026-05-08 | provider/status CHECK, UNIQUE(lower(email), provider), linked_user_id FK |
| `admin_users` | 2026-05-08 (ALTER) | role CHECK('owner','admin','viewer'), is_active default true |
| `user_profiles.auth_email` | 2026-05-08 | UNIQUE lower index |
| `user_resume_card_settings` | 2026-05-07 | medal_week_override >= 0 |
| `organization_resume_card_settings` | 2026-05-07 | organization_slug CHECK IN ('encre','oranke','phalanx'), medal_theme CHECK IN ('OK','EC','PX') |
| `site_resume_card_settings` | 2026-05-07 | id=1 singleton |
| `user_review_links` | 2026-05-13 | week_index CHECK IN (3,6,...,30), PK(user_id, week_index) |
| `user_edit_windows` | 2026-05-13 | UNIQUE(user_id, resource_key) |
| `activity_types` | 2026-05-21 | cluster_id CHECK IN ('practical_competency','practical_experience','practical_career') |
| `weekly_reviews` | 2026-05-21 | rating 1-10 int, content 1-200, UNIQUE(user_id, week_card_id) |
| `weekly_colleagues` | 2026-05-21 | rank 1-3, message ≤200, UNIQUE(user_id, week_card_id, colleague_id), user_id<>colleague_id |
| `weekly_reputations` | 2026-05-21 | rating 0-10 half-step, content 1-100, UNIQUE(reviewer, target, week), reviewer<>target |
| `season_reputations` | 2026-05-21 | rating 1-10 half-step, content 1-300, keyword_{1,2,3} distinct, UNIQUE(reviewer, target, season_history) |
| `reputation_keywords` | 2026-05-21 | cluster_number 1-5, keyword UNIQUE |
| `user_activity_details` | 2026-05-22 | rating 0-10, UNIQUE(user_id, week_id, activity_type_id) |
| `career_projects` | 2026-05-22 | NULL 허용 다수 (master) |
| `career_project_weeks` | 2026-05-22 | PK(project_id, week_id) |
| `career_records` | 2026-05-22 | grade CHECK S/A/B/C/D, enhancement_status CHECK, UNIQUE(user_id, week_id, project_id) |

### 1-C. 🔴 테스트 마커 컬럼 조사 결과

**모든 테이블에서 부재**:
- `is_test_user` 컬럼 → **없음**
- `seed_batch_id` 컬럼 → **없음**
- `is_dummy` / `test_user` 컬럼 → **없음**
- `metadata jsonb` 컬럼 → **없음**
- `created_via` 컬럼 → **없음**

→ 식별 정책 §2 가 가장 큰 안전장치이며, **기존 테이블 ALTER 없이 별도 마커 테이블 + 합성 식별자 다층 방어** 가 유일한 안전 접근.

---

## §2. 테스트 사용자 식별 정책 추천

### 옵션 비교

| 옵션 | 변경 범위 | 안전성 | 운영 영향 | 비고 |
|---|---|---|---|---|
| A. `user_profiles.is_test_user` 추가 | 기존 테이블 ALTER | 🟢 단순 | 🔴 운영 스키마 영향, 모든 쿼리에 WHERE 추가 필요 | 기존 쿼리에 영향 가능 (방어 누락 시 더미 노출) |
| B. `user_profiles.seed_batch_id` 추가 | 기존 테이블 ALTER | 🟢 batch별 식별 | 🔴 동일 영향 | A와 동일 |
| C. `user_profiles.metadata jsonb` 추가 | 기존 테이블 ALTER | 🟡 jsonb 인덱싱 비용 | 🔴 동일 | jsonb 쿼리 복잡도 |
| D. prefix 합성 (display_name `[TEST]`, email `@vraxium.test`, phone `010-9900-*`, legacy_user_id 900001-900030) | 0 ALTER | 🟡 단일 마커 | 🟢 zero touch | 합성 prefix 우회 가능 |
| **E. 신규 `test_user_markers` 테이블 + 옵션 D 합성 마커 다층 방어** ⭐ | **0 ALTER (CREATE only)** | **🟢 다층** | **🟢 zero touch** | **추천** |

### ⭐ 추천: **옵션 E (다층 방어)**

```sql
CREATE TABLE IF NOT EXISTS public.test_user_markers (
  user_id uuid PRIMARY KEY REFERENCES public.user_profiles(user_id) ON DELETE CASCADE,
  seed_batch_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  note text
);
CREATE INDEX IF NOT EXISTS test_user_markers_batch_idx
  ON public.test_user_markers(seed_batch_id);
```

**4중 식별 마커** (모두 OR 가 아닌 AND — rollback 시 모두 일치해야 삭제):
1. `test_user_markers` row 존재 (seed_batch_id = '2026-05-22_seed_30users_v1')
2. `user_profiles.legacy_user_id` BETWEEN 900001 AND 900030
3. `user_profiles.auth_email` LIKE '%@vraxium.test'
4. `user_profiles.display_name` LIKE '[TEST] %'

**왜 다층인가**: rollback 시 단일 마커만 사용하면 실수 위험. 4중 AND 로 보호하면 운영 데이터가 우연히 한두 조건 매칭되어도 절대 삭제되지 않음.

**장점**:
- 기존 테이블 ALTER zero → 운영 무영향, 쿼리 영향 zero
- `test_user_markers` 만 JOIN 으로 식별 → rollback SQL 단순
- 향후 다른 seed batch 추가 시 batch_id 만 분기

**리스크 / 완화책**:
- ⚠️ admin 화면이 `[TEST]` prefix 사용자를 그대로 노출 → 시연 / 데모용으로는 의도된 동작이라 OK. 실수로 prod 환경 적용 시에는 명확히 보임.
- ⚠️ phone `010-9900-*` 가 운영 사용자 phone 과 충돌 가능 → §8 검증 SQL 로 사전 확인.

---

## §3. 조직 배정 전략 추천

### 비교

| 안 | 분배 | phalanx 격리 | encre/oranke 실사용자 | 다조직 시나리오 |
|---|---|---|---|---|
| A. 30명 전부 oranke | oranke 30 | 🟢 100% | 🟡 oranke 실사용자 있으면 섞임 (확인 필요) | 🔴 단일 조직 |
| B. 각 10명 | encre 10 / oranke 10 / phalanx 10 | 🔴 phalanx 34명과 한 조직에 섞임 | 🟡 동일 | 🟢 풀 커버리지 |
| C. 테스트 전용 slug 신설 | test_seed 30 | 🟢 완전 격리 | 🟢 완전 격리 | 🟡 단일 격리 조직 |
| **A'. oranke 20 + encre 10 (phalanx 0)** ⭐ | 격리 + 2조직 시나리오 | 🟢 100% | 🟡 동일 | 🟡 2조직 커버 |

### ⭐ 추천: **A'안 (oranke 20 + encre 10, phalanx 0)** — 조건부

**전제 확인 필요** (§8 검증 SQL 에 포함):
- encre / oranke 실사용자 수 확인. 둘 다 0 또는 극소이면 A' 채택.
- 만약 encre 또는 oranke 에도 실사용자 다수 존재하면 → **C안 (테스트 전용 slug 신설)** 로 폴백.

**A' 채택 이유**:
- phalanx 실사용자 34명 zero-touch 보장
- 운영 스키마 ALTER 없음 (organization_resume_card_settings CHECK 깨지 않음, 기존 슬러그 그대로 사용)
- 2개 조직 분산으로 organization_slug 분기 로직 테스트 가능
- C안 대비 운영 시스템 변경 최소

**C안 비추천 이유**:
- `organization_resume_card_settings.organization_slug` CHECK 가 `('encre','oranke','phalanx')` 만 허용 → CHECK ALTER 필요
- `organizations` 테이블 자체에 새 row 추가 필요 → 운영 데이터 수정 (사용자 금지 조건 위배 우려)

**B안 비추천 이유**:
- phalanx 에 더미 10명 + 실사용자 34명 → 한 조직에 섞이는 것이 사용자 명시적 금지 조건에 가장 가깝게 위배

### 분배 안

| organization_slug | 사용자 수 | 분포 |
|---|---|---|
| oranke | 20 | 신입 4 + 일반 8 + 고활동 6 + 운영진 1 + 상태 이슈 1 |
| encre | 10 | 신입 2 + 일반 4 + 고활동 2 + 운영진 1 + 상태 이슈 1 |
| phalanx | **0** | 🔴 더미 0명 (실사용자 34명 보호) |

---

## §4. 30명 사용자 유형 분포표

| 유형 | 수 | legacy_user_id | organization_slug | status | level | 누적주차 | 인정주차 | total_stars | total_shields | 추가 콘텐츠 |
|---|---:|---|---|---|---|---:|---:|---:|---:|---|
| 신입 | 6 | 900001~900006 | oranke 4, encre 2 | active | 일반 | 0~3 | 0~2 | 0~30 | 5 | newbie_checklist row만 (Cluster1만) |
| 일반 활동자 | 12 | 900007~900018 | oranke 8, encre 4 | active | 일반 | 4~8 | 3~7 | 20~70 | 4~5 | activity_details 1-2, weekly_review 1, slogan 1-2 |
| 고활동자 | 8 | 900019~900026 | oranke 6, encre 2 | active | 심화 | 9~14 | 8~13 | 60~120 | 3~5 | activity_details 2-3, weekly_review 2, slogan 2-3, portfolio_top_card 1-2, weekly_colleague 1-2, weekly_reputation 일부 |
| 운영진 | 2 | 900027~900028 | oranke 1, encre 1 | active | 운영진 | 12~16 | 10~14 | 80~150 | 5 | admin_users row 추가, 모든 컨텐츠 영역 일부 |
| 상태 이슈 | 2 | 900029~900030 | oranke 1, encre 1 | weekly_rest 1, graduated 1 | 일반 | 5~10 | 4~8 | 30~80 | 0~5 | 정지/졸업 상태 표시 위한 최소 데이터 |

**총합 검증**: 6 + 12 + 8 + 2 + 2 = **30 ✓**
**조직 검증**: oranke 4+8+6+1+1 = 20 / encre 2+4+2+1+1 = 10 / phalanx 0 ✓

**Gender 분배**: 남 15 / 여 15 (legacy_user_id 홀수=남, 짝수=여)

---

## §5. Seed 대상 테이블

| 테이블 | 필수 여부 | 생성 row 수 | FK 의존성 | 생성 순서 | 비고 |
|---|---|---:|---|---:|---|
| `test_user_markers` (신규) | 🟢 필수 | 30 | user_profiles | 9 | 마커 테이블 신설 |
| `auth.users` | 🟢 필수 | 30 | — | 1 | Supabase Auth API 사용 권장 (SQL 직접 INSERT 시 비밀번호 해시·트리거 검증 필요) |
| `user_profiles` | 🟢 필수 | 30 | auth.users (implicit) | 2 | 핵심 마스터 |
| `user_memberships` | 🟢 필수 | 30 | user_profiles | 3 | live-DB only — 컬럼 확인 필요 |
| `user_cumulative_points` | 🟢 필수 | 30 | user_profiles | 4 | live-DB only |
| `user_growth_stats` | 🟢 필수 | 30 | user_profiles | 5 | live-DB only |
| `applicants` | 🟡 권장 | 30 | user_profiles | 6 | linked_user_id 채우기 (status='approved') |
| `admin_users` | 🟡 권장 | 2 | auth.users | 7 | 운영진 2명만 |
| `user_cluster2` | 🟡 권장 | 30 (또는 22 활동자만) | user_profiles | 10 | photo/video NULL OK, 일반 활동자부터 |
| `user_introductions` | 🟡 권장 | ~24 (활동자 이상) | user_profiles | 11 | slogan 1~3개씩 |
| `user_educations` | 🟡 권장 | 30 | user_profiles | 12 | 1인당 1 row |
| `user_resume_card_settings` | 🟢 권장 | 30 | user_profiles | 13 | hexagon_link 1~3 일부만 |
| `user_review_links` | 🟢 권장 | ~50 (고활동자 위주) | user_profiles | 14 | week_index 3,6,9 부터 |
| `portfolio_top_cards` | 🟡 선택 | ~16 (고활동자+운영진) | user_profiles | 15 | card_type='output' 또는 'detail' |
| `portfolio_channel_cards` | 🟡 선택 | ~10 (고활동자) | user_profiles | 16 | card_index 0~2 |
| `user_activity_details` | 🟢 필수 | ~60 (일반+고활동+운영진 22명×주차) | user_profiles, weeks, activity_types | 17 | UNIQUE(user_id, week_id, activity_type_id) |
| `weekly_reviews` | 🟢 필수 | ~40 | user_profiles, weeks | 18 | rating 1-10 int |
| `weekly_colleagues` | 🟡 권장 | ~30 | user_profiles, weeks, user_profiles(colleague) | 19 | colleague 도 더미 사용자에 한정 |
| `weekly_reputations` | 🟡 권장 | ~50 | user_profiles, weeks | 20 | reviewer/target 모두 더미 (실사용자 노출 금지) |
| `user_season_histories` | 🟢 권장 | ~22 (활동자) | user_profiles, seasons | 21 | rating 0-10 int |
| `season_reputations` | 🟡 선택 | ~20 | user_profiles, user_season_histories | 22 | keyword_1/2/3 distinct |
| `career_records` | 🟡 선택 | ~10 (고활동자) | user_profiles, weeks, career_projects | 23 | career_projects 존재 시에만 |
| `career_projects` | 🟡 마스터 확인 | 0 또는 1-2 (없을 시) | — | 0 (사전) | 마스터 — 운영 데이터 추가 우려 시 skip |
| `user_edit_windows` | 🟢 선택 | 0 (생략) | user_profiles | — | 더미는 기본 권한으로 충분 |
| `organizations` | 🔴 확인만 | 0 (encre/oranke 존재 가정) | — | 0 (사전) | 신규 row 생성 금지 |
| `seasons` / `weeks` | 🔴 확인만 | 0 (현재 시즌 row 존재 가정) | — | 0 (사전) | 신규 row 생성 금지 |
| `activity_types` | 🔴 확인만 | 0 (canonical seed 존재 가정) | — | 0 (사전) | 부재 시 별도 작업 필요 |
| `reputation_keywords` | 🔴 확인만 | 0 (100 키워드 seed 존재 가정) | — | 0 (사전) | 부재 시 별도 작업 필요 |
| `legacy_crew_import` | 🔴 확인만 | 0 | — | — | 신규 더미는 synthetic 시퀀스, 매핑 row 불필요 |

---

## §6. Insert 순서 및 FK 의존성

```
[Phase 0 — 사전 검증]
├── organizations 존재 (encre/oranke)
├── seasons 현재 시즌 row 존재
├── weeks 현재 시즌 주차들 존재
├── activity_types canonical seed 적재
├── reputation_keywords 100 키워드 seed 적재
└── §8 검증 SQL 전부 통과

[Phase 1 — 마커 테이블 생성]
└── (1) test_user_markers CREATE TABLE (idempotent)

[Phase 2 — Auth & Identity (FK 루트)]
├── (2) auth.users × 30  ← Supabase Auth admin API (권장) 또는 SQL
└── (3) user_profiles × 30   ← user_id = auth.users.id

[Phase 3 — 1:1 보조 테이블]
├── (4) user_memberships × 30
├── (5) user_cumulative_points × 30
├── (6) user_growth_stats × 30
├── (7) applicants × 30        ← linked_user_id FK
├── (8) admin_users × 2        ← id = auth.users.id (운영진 2명)
└── (9) test_user_markers × 30 ← seed_batch_id 기록

[Phase 4 — Cluster1 콘텐츠]
└── (생략 — 위 모두 Cluster1)

[Phase 5 — Cluster2 콘텐츠]
├── (10) user_cluster2 × ~22
├── (11) user_introductions × ~24
├── (12) user_educations × 30
├── (13) user_resume_card_settings × 30 (or skip — admin UI 기본값)
└── (14) user_review_links × ~50

[Phase 6 — Cluster3 (포트폴리오)]
├── (15) portfolio_top_cards × ~16
└── (16) portfolio_channel_cards × ~10

[Phase 7 — Cluster4 콘텐츠]
├── (17) user_activity_details × ~60   ← weeks, activity_types FK
├── (18) weekly_reviews × ~40           ← weeks FK
├── (19) weekly_colleagues × ~30        ← weeks, user_profiles (colleague_id) FK
├── (20) weekly_reputations × ~50       ← weeks FK
├── (21) user_season_histories × ~22    ← seasons FK
├── (22) season_reputations × ~20       ← user_season_histories FK
└── (23) career_records × ~10           ← weeks, career_projects FK (조건부)
```

**FK 의존성 그래프**:
```
auth.users
  ↓
user_profiles ──┬─→ user_memberships, user_cumulative_points, user_growth_stats
                ├─→ applicants.linked_user_id
                ├─→ user_cluster2, user_introductions, user_educations
                ├─→ user_resume_card_settings, user_review_links
                ├─→ portfolio_top_cards, portfolio_channel_cards
                ├─→ user_activity_details (+ weeks + activity_types)
                ├─→ weekly_reviews (+ weeks)
                ├─→ weekly_colleagues (+ weeks + user_profiles[colleague])
                ├─→ weekly_reputations (+ weeks)
                ├─→ user_season_histories (+ seasons)
                ├─→ season_reputations (+ user_season_histories)
                ├─→ career_records (+ weeks + career_projects)
                └─→ test_user_markers
auth.users → admin_users (별 경로, 2명만)
```

**사용자가 예상한 순서 vs 실제**: 사용자 예상 순서는 거의 맞으나 다음만 조정:
- `applicants` 는 `user_profiles` **이후** (linked_user_id FK 때문) — 사용자 예상 순서 4와 일치 ✓
- `admin_users` 는 `auth.users` 이후 어디든 OK — Phase 3 으로 묶음
- `weeks`/`seasons`/`activity_types`/`reputation_keywords` 는 **사전 검증만** (신규 생성 금지)

---

## §7. 더미 데이터 생성 규칙

### 7-A. 식별자 규칙

| 항목 | 규칙 | 예시 |
|---|---|---|
| `legacy_user_id` | 900001 ~ 900030 | 900001, 900002, ... |
| `display_name` | `[TEST] 더미크루{NN}` (NN = 01~30) | `[TEST] 더미크루01` |
| `auth_email` | `dummy{NN}@vraxium.test` (lowercase) | `dummy01@vraxium.test` |
| `contact_email` | 동일 (`dummy{NN}@vraxium.test`) | 동일 |
| `contact_phone` | `010-9900-00{NN}` (NN = 01~30) | `010-9900-0001`, `010-9900-0030` |
| `applicants.provider` | `'kakao'` (운영 기본값) | — |
| `applicants.status` | `'approved'` (이미 가입 완료 가정) | — |
| `seed_batch_id` | `2026-05-22_seed_30users_v1` | — |

### 7-B. 콘텐츠 규칙 (빈 화면 방지)

| Cluster | 최소 콘텐츠 |
|---|---|
| Cluster1 | 30명 전원 user_profiles + user_memberships + user_cumulative_points + user_growth_stats (필수 4종) |
| Cluster2 | 22명 (활동자) user_cluster2 (growth_story 1줄 텍스트만), 24명 slogan 1-3개, 30명 user_educations 1 row |
| Cluster3 | 8명 (고활동) portfolio_top_cards 1-2 + 5명 portfolio_channel_cards 1 |
| Cluster4 | 22명 user_activity_details 2-3 (rating 5-9), 14명 weekly_reviews 1-2, 10명 weekly_colleagues 1-2, 8명 weekly_reputations 2-3 |

### 7-C. 분포 규칙

- **gender**: legacy_user_id 홀수 → 남, 짝수 → 여
- **school_name**: ['서울대', '연세대', '고려대', '카이스트', '포스텍', '한양대', '서강대', '성균관대'] 라운드로빈
- **department_name**: ['경영학과', '컴퓨터공학과', '디자인학과', '미디어학과', '전자공학과', '심리학과'] 라운드로빈
- **birth_date**: `2000-01-01` ~ `2005-12-31` 범위 (`2001-{MM-DD}` 분포)
- **status**: 6 신입 + 12 일반 + 8 고활동 + 2 운영진 → active, 1 → weekly_rest, 1 → graduated
- **organization_slug**: 1-4(oranke), 5-6(encre) → 신입 분포; 같은 패턴으로 다른 유형들 분배
- **total_stars**: 신입 0~30, 일반 20~70, 고활동 60~120, 운영진 80~150, 상태이슈 30~80 (random)
- **total_shields**: 신입 5 고정, 일반 4-5, 고활동 3-5, 운영진 5, 상태이슈 0-5
- **total_lightnings**: 0~10 random
- **cumulative_weeks**: 신입 0-3, 일반 4-8, 고활동 9-14, 운영진 12-16, 상태이슈 5-10
- **approved_weeks**: cumulative_weeks - 0~2 (단, ≥0)

---

## §8. 생성 전 검증 SQL

```sql
-- ===== §8-1. 환경 상태 확인 =====

-- 1. organization slug 존재 확인 (CHECK 제약 깨지 않음 확인)
SELECT DISTINCT organization_slug
FROM public.organization_resume_card_settings
ORDER BY organization_slug;
-- Expected: encre, oranke, phalanx (3 row)

-- 2. organizations 테이블 직접 확인 (live DB only — 스키마 확인 필요)
-- ⚠️ 컬럼명 추정. 실제는 information_schema 로 확인 후 조정
SELECT *
FROM public.organizations
LIMIT 5;

-- 3. 현재 시즌 / 주차 row 존재 확인 (v2 정정: is_current 컬럼 부재, week_number → week_index)
WITH target_season AS (
  SELECT id, season_index, name, started_at, ended_at
  FROM public.seasons
  ORDER BY
    CASE WHEN ended_at IS NULL THEN 0 ELSE 1 END,
    started_at DESC,
    season_index DESC
  LIMIT 1
)
SELECT * FROM target_season;

SELECT w.id, w.season_id, w.week_index, w.started_at, w.ended_at
FROM public.weeks w
WHERE w.season_id = (
  SELECT id FROM public.seasons
  ORDER BY
    CASE WHEN ended_at IS NULL THEN 0 ELSE 1 END,
    started_at DESC,
    season_index DESC
  LIMIT 1
)
ORDER BY w.week_index;

-- 4. activity_types canonical seed 확인
SELECT cluster_id, COUNT(*) AS row_count
FROM public.activity_types
WHERE is_active = true
GROUP BY cluster_id;
-- Expected: 3개 cluster_id 각각 row 다수

-- 5. reputation_keywords 100 키워드 확인
SELECT cluster_number, COUNT(*) AS keyword_count
FROM public.reputation_keywords
GROUP BY cluster_number
ORDER BY cluster_number;
-- Expected: 5개 cluster_number 각각 키워드 분포 (총 100)

-- ===== §8-2. 실사용자 분포 확인 (조직 배정 추천 검증) =====

-- 6. 조직별 실사용자 수
SELECT
  organization_slug,
  COUNT(*) AS user_count,
  COUNT(*) FILTER (WHERE display_name LIKE '[TEST]%') AS existing_test_count
FROM public.user_profiles
WHERE organization_slug IS NOT NULL
GROUP BY organization_slug
ORDER BY organization_slug;
-- Expected: phalanx 34, encre ?, oranke ?
-- → encre/oranke 실사용자 수 보고 §3 추천안 (A' vs C) 최종 결정

-- ===== §8-3. 식별자 충돌 사전 점검 =====

-- 7. legacy_user_id 900001-900030 대역 충돌 확인
SELECT legacy_user_id, display_name, organization_slug
FROM public.user_profiles
WHERE legacy_user_id BETWEEN 900001 AND 900030;
-- Expected: 0 row

-- 8. auth_email @vraxium.test 도메인 충돌 확인
SELECT user_id, auth_email, organization_slug
FROM public.user_profiles
WHERE lower(auth_email) LIKE '%@vraxium.test';
-- Expected: 0 row

-- 9. contact_phone 010-9900-* prefix 충돌 확인
SELECT user_id, display_name, contact_phone
FROM public.user_profiles
WHERE contact_phone LIKE '010-9900-%';
-- Expected: 0 row

-- 10. display_name '[TEST]' prefix 충돌 확인
SELECT user_id, display_name
FROM public.user_profiles
WHERE display_name LIKE '[TEST]%';
-- Expected: 0 row

-- ===== §8-4. 마커 테이블 미생성 확인 =====

-- 11. test_user_markers 테이블 부재 확인
SELECT EXISTS (
  SELECT 1 FROM pg_tables
  WHERE schemaname = 'public' AND tablename = 'test_user_markers'
) AS markers_table_exists;
-- Expected: false (없으면 CREATE 진행)

-- ===== §8-5. 핵심 테이블 컬럼 구조 확인 =====

-- 12. live-DB only 테이블 컬럼 dump
SELECT table_name, column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name IN (
    'organizations', 'seasons', 'weeks',
    'user_profiles', 'user_memberships', 'user_cumulative_points', 'user_growth_stats',
    'user_cluster2', 'user_introductions', 'user_educations',
    'portfolio_top_cards', 'portfolio_channel_cards',
    'user_season_histories', 'career_projects'
  )
ORDER BY table_name, ordinal_position;
-- Seed SQL 작성 전 출력 결과로 실제 컬럼 NOT NULL/default 검증
```

**§8 통과 기준**:
- 6번: phalanx ≥ 1 row 확인되면 격리 정책 발동, encre/oranke 실사용자 수에 따라 §3 A' vs C 결정
- 7,8,9,10번: 모두 0 row 여야 식별자 충돌 없음
- 11번: false 여야 CREATE TABLE 진행
- 12번: live-DB only 테이블의 모든 NOT NULL 컬럼 파악 후 Seed SQL 의 INSERT 컬럼 목록 확정

---

## §9. Seed SQL 초안

> 🔴 **DEPRECATED (2026-05-22)** — 본 §9 v1 SQL 은 user_profiles.legacy_user_id 부재로 인해 사용 불가.
> ✅ **최신 적용 파일: [`seed-v3-20260522.sql`](./seed-v3-20260522.sql)**
> - test_user_markers 에 legacy_user_id 분리 저장
> - user_profiles INSERT 에서 legacy_user_id 제거
> - 모든 검증·rollback 에서 `test_user_markers` JOIN 패턴
>
> ⚠️ **이 SQL 은 §1-A, §8 통과 후에만 실행**. 일부 컬럼은 "스키마 확인 필요" 처리되어 placeholder. live DB 조회 결과로 보완 필요.

```sql
-- ============================================================
-- SEED: 30 dummy users (batch_id = '2026-05-22_seed_30users_v1')
-- 적용 전 §8 검증 SQL 모두 통과 확인 필수
-- 트랜잭션 단위로 적용 (rollback 가능)
-- ============================================================

BEGIN;

-- ----- Phase 1: test_user_markers 테이블 생성 -----
CREATE TABLE IF NOT EXISTS public.test_user_markers (
  user_id uuid PRIMARY KEY REFERENCES public.user_profiles(user_id) ON DELETE CASCADE,
  seed_batch_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  note text
);
CREATE INDEX IF NOT EXISTS test_user_markers_batch_idx
  ON public.test_user_markers(seed_batch_id);

-- ----- Phase 2: auth.users + user_profiles -----
-- ⚠️ auth.users 생성 방법 2가지:
--   (A) Supabase Auth admin API 호출 (권장) — TypeScript 스크립트로 30회 호출
--   (B) 직접 SQL INSERT INTO auth.users — RLS/트리거 검증 필요, password hash 직접 생성
-- 본 SQL 은 (B) 방식 가정. (A) 사용 시 user_profiles INSERT 의 user_id 는 API 응답 UUID 사용.

-- ⚠️ 비밀번호 해시는 Supabase 가 사용하는 crypt(bcrypt) 알고리즘 — pgcrypto extension 필수
-- 더미 비밀번호 'TestSeed!2026' (모두 동일, rollback 후 폐기)
WITH seed_data AS (
  SELECT
    gs.idx,
    gen_random_uuid() AS user_uuid,
    900000 + gs.idx AS legacy_id,
    'dummy' || lpad(gs.idx::text, 2, '0') || '@vraxium.test' AS email,
    '[TEST] 더미크루' || lpad(gs.idx::text, 2, '0') AS display_name,
    '010-9900-' || lpad(gs.idx::text, 4, '0') AS phone,
    CASE
      WHEN gs.idx BETWEEN 1 AND 6 THEN 'newbie'
      WHEN gs.idx BETWEEN 7 AND 18 THEN 'normal'
      WHEN gs.idx BETWEEN 19 AND 26 THEN 'high_activity'
      WHEN gs.idx BETWEEN 27 AND 28 THEN 'admin'
      ELSE 'status_issue'
    END AS user_type,
    CASE
      -- oranke 20명: 1-4, 7-14, 19-24, 27, 29
      WHEN gs.idx IN (1,2,3,4, 7,8,9,10,11,12,13,14, 19,20,21,22,23,24, 27, 29) THEN 'oranke'
      ELSE 'encre'
    END AS org_slug,
    CASE WHEN gs.idx % 2 = 1 THEN '남' ELSE '여' END AS gender,
    CASE
      WHEN gs.idx = 29 THEN 'weekly_rest'
      WHEN gs.idx = 30 THEN 'graduated'
      ELSE 'active'
    END AS status_value
  FROM generate_series(1, 30) AS gs(idx)
)
-- 2-A: auth.users INSERT (옵션 B 방식 — Supabase Auth 내부 컬럼 참조)
-- ⚠️ 스키마 확인 필요: auth.users 컬럼 (id, email, encrypted_password, email_confirmed_at, raw_user_meta_data 등)
-- 본 SQL 적용 전 SELECT 로 컬럼 구조 확인 필수.
INSERT INTO auth.users (
  id, instance_id, email, encrypted_password,
  email_confirmed_at, created_at, updated_at,
  aud, role, raw_app_meta_data, raw_user_meta_data
)
SELECT
  user_uuid,
  '00000000-0000-0000-0000-000000000000'::uuid,
  email,
  crypt('TestSeed!2026', gen_salt('bf')),
  now(), now(), now(),
  'authenticated', 'authenticated',
  '{"provider":"email","providers":["email"]}'::jsonb,
  jsonb_build_object('seed_batch_id', '2026-05-22_seed_30users_v1')
FROM seed_data;

-- 2-B: user_profiles INSERT
INSERT INTO public.user_profiles (
  user_id, legacy_user_id, display_name, gender, birth_date,
  contact_phone, contact_email, auth_email,
  school_name, department_name, address,
  organization_slug, status, created_at, updated_at
)
SELECT
  sd.user_uuid,
  sd.legacy_id,
  sd.display_name,
  sd.gender,
  '2001-' || lpad(((sd.idx % 12) + 1)::text, 2, '0') || '-' || lpad(((sd.idx % 28) + 1)::text, 2, '0'),
  sd.phone,
  sd.email,
  sd.email,
  (ARRAY['서울대','연세대','고려대','카이스트','포스텍','한양대','서강대','성균관대'])[((sd.idx - 1) % 8) + 1],
  (ARRAY['경영학과','컴퓨터공학과','디자인학과','미디어학과','전자공학과','심리학과'])[((sd.idx - 1) % 6) + 1],
  '서울시 성북구 (TEST)',
  sd.org_slug,
  sd.status_value,
  now(), now()
FROM seed_data sd;

-- ----- Phase 3: 1:1 보조 테이블 -----

-- user_memberships
-- ⚠️ 스키마 확인 필요: PK 정의, NOT NULL 컬럼
INSERT INTO public.user_memberships (
  user_id, team_name, part_name, membership_level, membership_state, is_current
)
SELECT
  sd.user_uuid,
  (ARRAY['브랜딩','기획','미디어','신입'])[((sd.idx - 1) % 4) + 1],
  CASE sd.user_type
    WHEN 'newbie' THEN '신입'
    WHEN 'admin' THEN 'admin'
    WHEN 'high_activity' THEN '심화'
    ELSE '일반'
  END,
  CASE sd.user_type
    WHEN 'admin' THEN '운영진'
    WHEN 'high_activity' THEN '심화'
    ELSE '일반'
  END,
  sd.status_value,
  true
FROM (
  SELECT user_uuid, legacy_id, user_type, status_value,
         (legacy_id - 900000) AS idx
  FROM public.user_profiles
  WHERE legacy_user_id BETWEEN 900001 AND 900030
) sd;

-- user_cumulative_points
INSERT INTO public.user_cumulative_points (user_id, total_stars, total_shields, total_lightnings)
SELECT
  up.user_id,
  CASE
    WHEN up.legacy_user_id BETWEEN 900001 AND 900006 THEN floor(random() * 30)::int
    WHEN up.legacy_user_id BETWEEN 900007 AND 900018 THEN 20 + floor(random() * 50)::int
    WHEN up.legacy_user_id BETWEEN 900019 AND 900026 THEN 60 + floor(random() * 60)::int
    WHEN up.legacy_user_id BETWEEN 900027 AND 900028 THEN 80 + floor(random() * 70)::int
    ELSE 30 + floor(random() * 50)::int
  END,
  CASE
    WHEN up.legacy_user_id BETWEEN 900001 AND 900006 THEN 5
    ELSE 3 + floor(random() * 3)::int
  END,
  floor(random() * 10)::int
FROM public.user_profiles up
WHERE up.legacy_user_id BETWEEN 900001 AND 900030;

-- user_growth_stats
INSERT INTO public.user_growth_stats (user_id, cumulative_weeks, approved_weeks)
SELECT
  up.user_id,
  CASE
    WHEN up.legacy_user_id BETWEEN 900001 AND 900006 THEN floor(random() * 4)::int
    WHEN up.legacy_user_id BETWEEN 900007 AND 900018 THEN 4 + floor(random() * 5)::int
    WHEN up.legacy_user_id BETWEEN 900019 AND 900026 THEN 9 + floor(random() * 6)::int
    WHEN up.legacy_user_id BETWEEN 900027 AND 900028 THEN 12 + floor(random() * 5)::int
    ELSE 5 + floor(random() * 6)::int
  END,
  GREATEST(
    0,
    CASE
      WHEN up.legacy_user_id BETWEEN 900001 AND 900006 THEN floor(random() * 3)::int
      WHEN up.legacy_user_id BETWEEN 900007 AND 900018 THEN 3 + floor(random() * 5)::int
      WHEN up.legacy_user_id BETWEEN 900019 AND 900026 THEN 8 + floor(random() * 6)::int
      WHEN up.legacy_user_id BETWEEN 900027 AND 900028 THEN 10 + floor(random() * 5)::int
      ELSE 4 + floor(random() * 5)::int
    END
  )
FROM public.user_profiles up
WHERE up.legacy_user_id BETWEEN 900001 AND 900030;

-- applicants
INSERT INTO public.applicants (email, name, provider, status, linked_user_id, reviewed_at, created_at, updated_at)
SELECT
  up.auth_email,
  up.display_name,
  'kakao',
  'approved',
  up.user_id,
  now() - INTERVAL '30 days',
  now() - INTERVAL '60 days',
  now()
FROM public.user_profiles up
WHERE up.legacy_user_id BETWEEN 900001 AND 900030;

-- admin_users (운영진 2명 — legacy 900027, 900028)
INSERT INTO public.admin_users (id, email, role, is_active, created_at, updated_at)
SELECT
  up.user_id,
  up.auth_email,
  CASE WHEN up.legacy_user_id = 900027 THEN 'owner' ELSE 'admin' END,
  true,
  now(), now()
FROM public.user_profiles up
WHERE up.legacy_user_id IN (900027, 900028);

-- ----- Phase 4: 식별 마커 기록 -----
INSERT INTO public.test_user_markers (user_id, seed_batch_id, note)
SELECT
  up.user_id,
  '2026-05-22_seed_30users_v1',
  'Created by 30-user seed design v1 (' ||
    CASE
      WHEN up.legacy_user_id BETWEEN 900001 AND 900006 THEN 'newbie'
      WHEN up.legacy_user_id BETWEEN 900007 AND 900018 THEN 'normal'
      WHEN up.legacy_user_id BETWEEN 900019 AND 900026 THEN 'high_activity'
      WHEN up.legacy_user_id BETWEEN 900027 AND 900028 THEN 'admin'
      ELSE 'status_issue'
    END || ')'
FROM public.user_profiles up
WHERE up.legacy_user_id BETWEEN 900001 AND 900030;

-- ----- Phase 5: Cluster2~4 콘텐츠 (생략 — §1-A 컬럼 확인 후 별도 작성) -----
-- ⚠️ user_cluster2, user_introductions, user_educations, portfolio_*,
--    user_activity_details, weekly_reviews, weekly_colleagues, weekly_reputations,
--    user_season_histories, season_reputations, career_records
-- → §1-A 의 live DB 컬럼 정보 확보 후 Phase 5 INSERT 문 추가
-- → 그 전까지는 Phase 4 까지만 COMMIT 하여 Cluster1 정도만 렌더링 가능 상태

-- 검증: 30 row 생성 확인
DO $$
DECLARE
  marker_count int;
  profile_count int;
BEGIN
  SELECT COUNT(*) INTO marker_count
  FROM public.test_user_markers
  WHERE seed_batch_id = '2026-05-22_seed_30users_v1';

  SELECT COUNT(*) INTO profile_count
  FROM public.user_profiles
  WHERE legacy_user_id BETWEEN 900001 AND 900030;

  IF marker_count <> 30 OR profile_count <> 30 THEN
    RAISE EXCEPTION 'Seed 검증 실패: markers=%, profiles=% (각 30 이어야 함)', marker_count, profile_count;
  END IF;
END $$;

COMMIT;
```

---

## §10. Rollback SQL 초안

> ⚠️ **4중 AND 마커 검증으로 운영 데이터 보호**. 단일 조건 매칭으로는 절대 삭제되지 않음.

```sql
-- ============================================================
-- ROLLBACK: 30 dummy users (batch_id = '2026-05-22_seed_30users_v1')
-- 4중 AND 마커 검증 후 삭제
-- ============================================================

BEGIN;

-- ----- §10-1. 삭제 대상 user_id 목록 사전 추출 (검증용 임시 테이블) -----
-- v3 정정: user_profiles.legacy_user_id 부재 → test_user_markers.legacy_user_id 참조
CREATE TEMP TABLE rollback_targets AS
SELECT
  up.user_id,
  tm.legacy_user_id,
  up.auth_email,
  up.display_name,
  up.organization_slug
FROM public.user_profiles up
JOIN public.test_user_markers tm ON tm.user_id = up.user_id
WHERE
  -- 4중 AND 식별 마커 검증
  tm.seed_batch_id = '2026-05-22_seed_30users_v1'
  AND tm.legacy_user_id BETWEEN 900001 AND 900030
  AND lower(up.auth_email) LIKE '%@vraxium.test'
  AND up.display_name LIKE '[TEST] %';

-- ----- §10-2. 30명 정확히 매칭 검증 -----
DO $$
DECLARE
  target_count int;
  phalanx_in_targets int;
BEGIN
  SELECT COUNT(*) INTO target_count FROM rollback_targets;
  SELECT COUNT(*) INTO phalanx_in_targets
  FROM rollback_targets WHERE organization_slug = 'phalanx';

  IF target_count <> 30 THEN
    RAISE EXCEPTION 'Rollback 중단: 삭제 대상이 30 이 아님 (실제: %). 운영 데이터 보호를 위해 abort.', target_count;
  END IF;

  IF phalanx_in_targets > 0 THEN
    RAISE EXCEPTION 'Rollback 중단: 삭제 대상에 phalanx 가 % 명 포함됨. 운영 데이터 보호를 위해 abort.', phalanx_in_targets;
  END IF;
END $$;

-- ----- §10-3. 자식 row 명시적 삭제 (FK CASCADE 로 자동 처리되지만 명시) -----
-- Cluster4
DELETE FROM public.season_reputations
WHERE reviewer_id IN (SELECT user_id FROM rollback_targets)
   OR target_user_id IN (SELECT user_id FROM rollback_targets);

DELETE FROM public.weekly_reputations
WHERE reviewer_id IN (SELECT user_id FROM rollback_targets)
   OR target_user_id IN (SELECT user_id FROM rollback_targets);

DELETE FROM public.weekly_colleagues
WHERE user_id IN (SELECT user_id FROM rollback_targets)
   OR colleague_id IN (SELECT user_id FROM rollback_targets);

DELETE FROM public.weekly_reviews
WHERE user_id IN (SELECT user_id FROM rollback_targets);

DELETE FROM public.user_activity_details
WHERE user_id IN (SELECT user_id FROM rollback_targets);

DELETE FROM public.career_records
WHERE user_id IN (SELECT user_id FROM rollback_targets);

DELETE FROM public.user_season_histories
WHERE user_id IN (SELECT user_id FROM rollback_targets);

-- Cluster3
DELETE FROM public.portfolio_top_cards
WHERE user_id IN (SELECT user_id FROM rollback_targets);

DELETE FROM public.portfolio_channel_cards
WHERE user_id IN (SELECT user_id FROM rollback_targets);

-- Cluster2
DELETE FROM public.user_review_links
WHERE user_id IN (SELECT user_id FROM rollback_targets);

DELETE FROM public.user_resume_card_settings
WHERE user_id IN (SELECT user_id FROM rollback_targets);

DELETE FROM public.user_educations
WHERE user_id IN (SELECT user_id FROM rollback_targets);

DELETE FROM public.user_introductions
WHERE user_id IN (SELECT user_id FROM rollback_targets);

DELETE FROM public.user_cluster2
WHERE user_id IN (SELECT user_id FROM rollback_targets);

-- Cluster1 보조
DELETE FROM public.admin_users
WHERE id IN (SELECT user_id FROM rollback_targets);

DELETE FROM public.applicants
WHERE linked_user_id IN (SELECT user_id FROM rollback_targets);

DELETE FROM public.user_growth_stats
WHERE user_id IN (SELECT user_id FROM rollback_targets);

DELETE FROM public.user_cumulative_points
WHERE user_id IN (SELECT user_id FROM rollback_targets);

DELETE FROM public.user_memberships
WHERE user_id IN (SELECT user_id FROM rollback_targets);

DELETE FROM public.user_edit_windows
WHERE user_id IN (SELECT user_id FROM rollback_targets);

-- 마커 (CASCADE 로 자동 삭제되지만 명시)
DELETE FROM public.test_user_markers
WHERE user_id IN (SELECT user_id FROM rollback_targets);

-- ----- §10-4. user_profiles 삭제 (CASCADE 자식들 자동 정리) -----
DELETE FROM public.user_profiles
WHERE user_id IN (SELECT user_id FROM rollback_targets);

-- ----- §10-5. auth.users 삭제 -----
DELETE FROM auth.users
WHERE id IN (SELECT user_id FROM rollback_targets);

-- ----- §10-6. 사후 검증 (v3 정정 — test_user_markers 기반) -----
DO $$
DECLARE
  remaining int;
BEGIN
  -- 마커 테이블 row 잔존 (CASCADE 로 자동 삭제되어야)
  SELECT COUNT(*) INTO remaining
  FROM public.test_user_markers
  WHERE seed_batch_id = '2026-05-22_seed_30users_v1';
  IF remaining > 0 THEN
    RAISE EXCEPTION 'Rollback 불완전: test_user_markers (batch v1) 잔존 % 건', remaining;
  END IF;

  -- [TEST] prefix 사용자 잔존
  SELECT COUNT(*) INTO remaining
  FROM public.user_profiles
  WHERE display_name LIKE '[TEST] %';
  IF remaining > 0 THEN
    RAISE EXCEPTION 'Rollback 불완전: [TEST] prefix 잔존 % 건', remaining;
  END IF;

  -- @vraxium.test 도메인 사용자 잔존
  SELECT COUNT(*) INTO remaining
  FROM public.user_profiles
  WHERE lower(auth_email) LIKE '%@vraxium.test';
  IF remaining > 0 THEN
    RAISE EXCEPTION 'Rollback 불완전: @vraxium.test 도메인 잔존 % 건', remaining;
  END IF;

  RAISE NOTICE 'Rollback 완료: 30 dummy users 정상 제거';
END $$;

COMMIT;

-- Optional: test_user_markers 테이블 자체도 drop (다른 batch 가 없을 때만)
-- DROP TABLE public.test_user_markers;
```

---

## §11. 실사용자 보호 검증 SQL

> Seed 적용 전/직후/Rollback 후 각 단계에서 실행. **phalanx 34명 row count + checksum 이 동일해야 통과**.

```sql
-- ============================================================
-- §11. 실사용자 보호 검증
-- 적용 단계: Seed 전, Seed 직후, Rollback 직후
-- ============================================================

-- ----- §11-1. phalanx 실사용자 인벤토리 (Seed 전 baseline 캡처용) -----
SELECT
  COUNT(*) AS phalanx_user_count,
  COUNT(DISTINCT user_id) AS distinct_user_ids,
  MIN(created_at) AS earliest_created,
  MAX(updated_at) AS latest_updated,
  md5(string_agg(user_id::text || '|' || COALESCE(display_name, ''), ',' ORDER BY user_id)) AS phalanx_checksum
FROM public.user_profiles
WHERE organization_slug = 'phalanx'
  AND (display_name IS NULL OR display_name NOT LIKE '[TEST] %');
-- Seed 전 결과를 baseline 으로 기록.
-- Seed 직후·Rollback 직후 동일 쿼리 결과가 baseline 과 100% 일치해야 함.

-- ----- §11-2. encre / oranke 실사용자 영향 검증 -----
SELECT
  organization_slug,
  COUNT(*) FILTER (WHERE display_name NOT LIKE '[TEST]%' OR display_name IS NULL) AS real_user_count,
  COUNT(*) FILTER (WHERE display_name LIKE '[TEST]%') AS test_user_count,
  md5(string_agg(
    CASE WHEN display_name NOT LIKE '[TEST]%' OR display_name IS NULL
         THEN user_id::text || '|' || COALESCE(display_name, '')
         ELSE NULL
    END,
    ',' ORDER BY user_id
  )) AS real_user_checksum
FROM public.user_profiles
WHERE organization_slug IN ('encre', 'oranke')
GROUP BY organization_slug;

-- ----- §11-3. 운영 데이터 UPDATE 흔적 탐지 -----
-- updated_at 변화 탐지: Seed 전 phalanx max(updated_at) 와 Seed 후 비교
SELECT
  organization_slug,
  MAX(updated_at) AS latest_updated_at,
  COUNT(*) FILTER (WHERE updated_at >= now() - INTERVAL '5 minutes') AS recently_updated_count
FROM public.user_profiles
WHERE organization_slug = 'phalanx'
GROUP BY organization_slug;
-- Seed 직후 recently_updated_count = 0 이어야 (phalanx 영향 없음)

-- ----- §11-4. 자식 테이블 영향 검증 -----
SELECT
  'user_memberships' AS table_name,
  COUNT(*) AS phalanx_row_count
FROM public.user_memberships um
JOIN public.user_profiles up ON up.user_id = um.user_id
WHERE up.organization_slug = 'phalanx'
UNION ALL
SELECT 'user_cumulative_points', COUNT(*)
FROM public.user_cumulative_points ucp
JOIN public.user_profiles up ON up.user_id = ucp.user_id
WHERE up.organization_slug = 'phalanx'
UNION ALL
SELECT 'user_growth_stats', COUNT(*)
FROM public.user_growth_stats ugs
JOIN public.user_profiles up ON up.user_id = ugs.user_id
WHERE up.organization_slug = 'phalanx'
UNION ALL
SELECT 'user_activity_details', COUNT(*)
FROM public.user_activity_details uad
JOIN public.user_profiles up ON up.user_id = uad.user_id
WHERE up.organization_slug = 'phalanx'
UNION ALL
SELECT 'weekly_reviews', COUNT(*)
FROM public.weekly_reviews wr
JOIN public.user_profiles up ON up.user_id = wr.user_id
WHERE up.organization_slug = 'phalanx';
-- Seed 전/후 phalanx 자식 테이블 row count 가 모두 동일해야

-- ----- §11-5. peer-review 교차 오염 검증 -----
-- 더미 사용자가 phalanx 실사용자를 reviewer/target/colleague 로 참조하면 안 됨
SELECT
  'weekly_reputations cross-org leak' AS check_name,
  COUNT(*) AS leak_count
FROM public.weekly_reputations wr
JOIN public.user_profiles reviewer ON reviewer.user_id = wr.reviewer_id
JOIN public.user_profiles target ON target.user_id = wr.target_user_id
WHERE
  (reviewer.display_name LIKE '[TEST] %' AND target.organization_slug = 'phalanx')
  OR (target.display_name LIKE '[TEST] %' AND reviewer.organization_slug = 'phalanx')
UNION ALL
SELECT
  'weekly_colleagues cross-org leak',
  COUNT(*)
FROM public.weekly_colleagues wc
JOIN public.user_profiles user_p ON user_p.user_id = wc.user_id
JOIN public.user_profiles colleague_p ON colleague_p.user_id = wc.colleague_id
WHERE
  (user_p.display_name LIKE '[TEST] %' AND colleague_p.organization_slug = 'phalanx')
  OR (colleague_p.display_name LIKE '[TEST] %' AND user_p.organization_slug = 'phalanx');
-- 두 결과 모두 leak_count = 0 이어야

-- ----- §11-6. test_user_markers 기반 batch 격리 검증 (v3 정정) -----
-- user_profiles.legacy_user_id 부재 → test_user_markers.legacy_user_id 사용
SELECT
  CASE
    WHEN tm.legacy_user_id BETWEEN 900001 AND 900030 THEN 'dummy_range'
    ELSE 'out_of_range'
  END AS range_class,
  COUNT(*) AS marker_count
FROM public.test_user_markers tm
WHERE tm.seed_batch_id = '2026-05-22_seed_30users_v1'
GROUP BY range_class;
-- dummy_range = 30 (Seed 후), 0 (Rollback 후) 이어야

-- 추가: user_profiles 전체 row 변화량 검증 (실사용자 자동 보호)
SELECT
  COUNT(*) FILTER (WHERE tm.user_id IS NOT NULL) AS dummy_user_count,
  COUNT(*) FILTER (WHERE tm.user_id IS NULL) AS real_user_count
FROM public.user_profiles up
LEFT JOIN public.test_user_markers tm ON tm.user_id = up.user_id;
-- dummy_user_count: Seed 후 30, Rollback 후 0
-- real_user_count: Seed 전/후 동일 (phalanx 34 + encre 0 + oranke 0 + (null org) X)
```

---

## §12. 미해결 결정사항 (사용자 확정 필요)

| # | 결정사항 | 옵션 | 권장 |
|---|---|---|---|
| 1 | encre/oranke 실사용자 수 확인 | §8-6번 결과 따라 분기 | A' 안 (oranke 20 + encre 10) 가능성 |
| 2 | auth.users 생성 방식 | (A) Supabase Auth admin API / (B) 직접 SQL INSERT | **(A) 권장** — 트리거·해시 호환성 보장 |
| 3 | activity_types canonical seed 적재 여부 | 미적재 시 별도 작업 필요 | §8-4 로 확인 |
| 4 | reputation_keywords 100개 seed 적재 여부 | 미적재 시 별도 작업 필요 | §8-5 로 확인 |
| 5 | career_projects 운영 row 존재 여부 | 부재 시 더미 마스터 1-2개 추가 vs career_records 생략 | 운영 데이터 영향 우려 → **career_records 생략** |
| 6 | seasons.is_current = true 시즌 존재 여부 | 부재 시 weeks 매핑 불가 → 모든 cluster4 콘텐츠 skip | §8-3 으로 확인 |
| 7 | Phase 5 (Cluster2~4 콘텐츠) 적용 시점 | Cluster1 적용 후 별도 PR / 동시 적용 | **별도 단계** — Cluster1 검증 후 Cluster2~4 |
| 8 | 더미 비밀번호 정책 | 동일 패스워드 vs 모두 다름 | 동일 (`TestSeed!2026`) 권장 — rollback 후 즉시 폐기 |
| 9 | RLS 정책 영향 | service_role bypass 가능 여부 | Supabase 기본 정책 — service_role 은 RLS 통과 (확인) |

---

## §13. 다음 단계

1. **사용자 결정 대기**: §12 9개 항목 중 #1, #2, #5 우선 결정
2. **§8 검증 SQL 실행**: 운영 DB Supabase SQL Editor 에서 실행, 결과 첨부
3. **§1-A live DB 컬럼 dump**: `information_schema.columns` 결과로 Seed SQL 의 placeholder 컬럼 확정
4. **Seed SQL 보완**: Phase 5 (Cluster2~4 콘텐츠) 추가
5. **Staging 환경 dry-run**: 운영 DB 직접 적용 전 staging 에서 §11 baseline / 적용 / rollback 시나리오 검증
6. **PR 작성**: `db/migrations/2026-05-22_test_user_markers.sql` 마커 테이블만 별도 PR, seed SQL 은 별도 script (migration 디렉토리 외부)

---

## 핵심 발견 요약

1. **테스트 마커 컬럼 부재** — `is_test_user` / `seed_batch_id` / `metadata jsonb` 모두 현재 스키마에 없음. 기존 테이블 ALTER 대신 신규 `test_user_markers` 테이블 + 합성 식별자 (legacy_user_id 900001-900030 + `[TEST]` prefix + `@vraxium.test` + `010-9900-*`) **4중 AND 다층 방어** 추천.

2. **조직 배정 추천 A' (oranke 20 + encre 10, phalanx 0)** — 사용자 명시 조건 "phalanx 영향 zero" 보장. 단, **encre/oranke 실사용자 수 확인 후 최종 결정** (§8-6번). 실사용자 다수 존재 시 C안 (테스트 전용 slug) 폴백 — 하지만 운영 CHECK 제약 ALTER 필요.

3. **🔴 18개 테이블 컬럼 구조 미확정** (live-DB only) — `organizations`, `seasons`, `weeks`, `user_memberships`, `user_cluster2`, `user_introductions`, `user_educations`, `portfolio_*` 등. **§8-12 information_schema 쿼리 결과 확보 전 Seed SQL 확정 불가**.

4. **분포 30명 확정**: 신입 6 + 일반 12 + 고활동 8 + 운영진 2 + 상태이슈 2 → oranke 20, encre 10, phalanx 0.

5. **Seed 2단계 적용 권장** — Phase 1-4 (Cluster1 + 마커) 먼저, Phase 5 (Cluster2-4 콘텐츠) 는 live DB 컬럼 확정 후 별도 단계.

6. **Rollback 안전장치 3중**: (a) 4중 AND 마커 검증, (b) target_count <> 30 시 abort, (c) phalanx in targets > 0 시 abort. 운영 데이터는 어떤 시나리오에서도 보호됨.

7. **§12 미해결 9건** — 사용자 결정 필요: encre/oranke 실사용자 수, auth.users 생성 방식 (Auth API 권장), career_projects 존재 여부, seasons.is_current 시즌 존재 여부 등.
