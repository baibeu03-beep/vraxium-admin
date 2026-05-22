# 계산값 매트릭스 v1 — 백엔드 조사 보고서

> 작성일: 2026-05-21
> 대상 레포: `vraxium-admin` (Next.js 15 admin)
> 근거 범위: `app/api/**`, `lib/admin*.ts`, `lib/*Data.ts`, `db/migrations/*.sql`, `openapi.json` 만.
> 작성 원칙:
> - 프론트 인벤토리(`frontend-quantitative-inventory-20260521.md`)의 지표 명칭을 기준으로 매핑.
> - 계산 공식 신규 설계 / migration 작성 / SQL 작성 / 코드 수정 일체 없음.
> - 백엔드 코드에 흔적이 없는 것은 "**모름**" 으로 표기.
> - 본 admin 레포는 user-app(Career-Resume) 과 **별도 레포**. 프론트가 호출한다고 적은 `/api/profile`, `/api/profile/summary`, `/api/slogans`, `/api/portfolio-channel-cards`, `/api/portfolio-top-cards` 는 이 레포에 존재하지 않으며 user-app 레포 책임 — 본 보고서에서는 admin 측 source-of-truth 만 확인.

---

## 0. 사전 사실 (재확인된 백엔드 현황)

### 0-1. 실재 확인된 캐노니컬 테이블 (admin lib 또는 마이그레이션 직접 참조)

`openapi.json` (PostgREST 스냅샷 — 컬럼 단언용) + admin lib code의 `.from(...)` 호출 + `db/migrations/*.sql` 교차 검증 결과.

| 테이블 | 실재 근거 | 핵심 컬럼 (확인된 것만) |
|---|---|---|
| `user_profiles` | openapi + 마이그레이션 다수 | user_id(uuid PK), display_name, birth_date, gender, contact_phone/email/available, profile_photo_url, vision, status, growth_status, organization_slug, school_name, department_name, address, auth_email |
| `users` | openapi + adminCrewData | id(uuid PK), legacy_user_id(integer) |
| `legacy_crew_import` | openapi + 마이그레이션 (2026-05-05) | legacy_user_id(integer PK), display_name, … cumulative_weeks(integer), is_visible, admin_note |
| `applicants` | 마이그레이션 (2026-05-08) | id, email, name, provider, status, linked_user_id, reviewed_at |
| `admin_users` | openapi + adminAuth | (role 게이트용) |
| `organizations` | openapi | (org meta) |
| `schools` | openapi + 마이그레이션 (2026-05-12) | source unique |
| `user_introductions` | openapi(부분) + adminCluster2Data | user_id, slogan_1/2/3, slogan_1/2/3_tag, slogan_1/2/3_rating (integer). openapi 스냅샷은 slogan_*_tag/rating 누락 → 후속 마이그레이션으로 추가됨 (adminCluster2Data:89 코멘트 참조). |
| `user_cluster2` | openapi | sidebar_photo_url, main_photo_url, sub_photo_1~4_url, video_url_1~3, growth_story / social_experience / career_direction / work_style / personal_story, cluving_review_link |
| `user_memberships` | openapi | team_name, part_name, membership_level, membership_state, is_current |
| `user_educations` | openapi(코어) + adminCluster2Data:30~33 (extra) | school_name, major_name_1/2/3, sort_order(int), is_primary(bool), education_level, status, major_category, admission_year/month, graduation_year/month, grade_max_type, grade_value, note (extra는 모두 text) |
| `user_resume_card_settings` | 마이그레이션 (2026-05-07) | hexagon_link_1/2/3, help_tooltip_text, medal_week_override(smallint, ≥0) |
| `organization_resume_card_settings` | 마이그레이션 (2026-05-07) | organization_slug PK (encre/oranke/phalanx), medal_theme(OK/EC/PX), notice_top_text/stamp |
| `site_resume_card_settings` | 마이그레이션 (2026-05-07) | id=1 singleton, notice_bottom_text/stamp, help_tooltip_default |
| `user_growth_stats` | openapi + adminResumeCardData:232, adminCrewData:258 | **user_id, cumulative_weeks(int), approved_weeks(int), spring_cutoff_date** |
| `user_cumulative_points` | openapi + adminResumeCardData:238 | **user_id, total_stars(int), total_shields(int), total_lightnings(int), updated_at** |
| `user_review_links` | 마이그레이션 (2026-05-13) | user_id, week_index ∈ {3,6,9,12,15,18,21,24,27,30}, url, is_visible |
| `user_edit_windows` | 마이그레이션 (2026-05-13) | user_id, resource_key, opened_at, expires_at, granted_by, note. UNIQUE(user_id, resource_key) |

### 0-2. admin lib 가 참조하지만 openapi 스냅샷에 없는 테이블 (live DB 존재 여부 "모름" — graceful degrade 코드로만 보호되어 있음)

`adminCluster4Data.ts:47-72`(`isMissingRelationError` + handleResult)와 마이그레이션 step1/step2 코멘트 모두 "테이블이 없어도 빈 결과로 graceful degrade" 로직임을 시사. 즉 다음 테이블들은 코드 흔적은 있으나 **이 레포 단독으로는 컬럼 확정 불가**:

| 테이블 | 코드 위치 | 컬럼 흔적 (코드/마이그레이션에서 사용된 것만) |
|---|---|---|
| `seasons` | adminCluster4Data:121 | `select("*")` — 컬럼 명세 코드 내 없음. **모름** |
| `weeks` | adminCluster4Data:122 | `select("*")` — **모름** |
| `user_season_histories` | adminCluster4Data:123,229~263 + 마이그레이션 2026-05-21 | id, user_id, rating(0~10 정수, NULL 허용, `floor(rating)=rating`), review |
| `season_reputations` (NEW peer-review schema, step2 후) | 마이그레이션 step2 | id, reviewer_id, target_user_id, season_history_id, rating(1~10, 0.5 step), content(1~300자), keyword_1/2/3(각 1~10자, 서로 다름), unique(reviewer_id,target_user_id,season_history_id) |
| `season_reputations` (admin lib 기대 shape) | adminCluster4Data:289~349 | **id, user_id, keyword_key, score** — step2 적용 후 **컬럼 불일치** (아래 5-1 참조) |
| `weekly_reputations` (NEW peer-review schema, step2 후) | 마이그레이션 step2 | id, reviewer_id, target_user_id, week_card_id, rating(0~10, 0.5 step), content(1~100자), keyword |
| `weekly_reputations` (admin lib 기대 shape) | weeklyReputationsTypes:27 + Data:19 | **id, user_id, week_id, keyword_key, score** — step2 적용 후 **컬럼 불일치** |
| `reputation_keywords` (NEW, step2 후) | 마이그레이션 step2/step3 | id(uuid), cluster_number(1..5), cluster_name, cluster_color, keyword(unique). |
| `reputation_keywords` (admin lib 기대 shape) | reputationKeywordsTypes:25 | **keyword_key, label, description, category, sort_order, is_active** — step2 적용 후 **컬럼 불일치** |
| `reputation_score_keys` / `weekly_reputation_scores` / `season_reputation_scores` | 마이그레이션 step1 | step1 rename 이후 캐노니컬 이름. admin lib 는 아직 *_scores 가 아닌 옛 이름을 부름 (step1 코멘트가 "Admin 측 코드 갈아끼우는 PR 별도" 라고 명시). |
| `portfolio_channel_cards` | adminCluster3Data:198,461,495 + adminCluster3Types:45-64 | id, user_id, card_index(smallint 1~16), channel_name, platform, management, start_year/month/day(text), rating(text), status, link, image_urls(text[]), insight, experience, metrics, created_at, updated_at. unique(user_id, card_index) — **이 레포 어디에도 CREATE TABLE 없음. live DB 에서 외부 마이그레이션으로 생성된 것으로 추정. 본 레포 단독으로는 schema 단언 불가지만 admin lib 가 컬럼 17개로 hardcode 됨.** |
| `portfolio_top_cards` | adminCluster3Data:203,772,794 + adminCluster3Types:67-95 | id, user_id, card_type('output'\|'detail'), card_index(smallint), main_title, sub_title, role_description, report, insight, platform, contribution(smallint), period_start/end_year/month/day(smallint), roles(text[]), tools(text[]), main_image_url, sub_image_urls(text[]), main_image_caption, sub_image_captions(text[]), metrics(text[]), links(text[]), created_at, updated_at. unique(user_id, card_type, card_index). **동상 — 이 레포에 CREATE TABLE 없음.** |

---

## 1. 지표별 매핑 (프론트 인벤토리 ↔ admin 백엔드 현황)

> "현재 API" = 본 admin 레포 내부 라우트만. user-app `/api/profile*`, `/api/slogans` 등은 admin 측 source 아님.
> "이미 구현된 계산 로직": admin 백엔드에서 발견된 집계/계산 흔적. **공식 의미는 결정하지 않음** — 단지 코드에 존재 여부만 표기.

| 지표 (프론트 식별자 / UI 라벨) | 현재 API (admin) | 현재 테이블 (canonical 후보) | Raw/Derived | 구현 상태 | 이관 필요 (legacy → Supabase) | 결정 필요 사항 |
|---|---|---|---|---|---|---|
| **일정 신뢰도** `reliabilityRate`, `circles.scheduleReliability` | admin 라우트 없음 — user-app `/api/profile` 가 채움 (추정) | **백엔드 흔적 없음** | 모름 | **컬럼/계산 흔적 admin 측 없음** | 모름 | 분자/분모 정의, 0–1 vs 0–100, 시즌/주차/누적 스코프 |
| **활동 완료율** `completionRate`, `progress.*.rate` | admin 라우트 없음 | **백엔드 흔적 없음** | 모름 | admin lib 내 `completionRate` / `progress.rate` 컬럼 또는 계산 코드 없음 | 모름 | 4 카테고리 합산 룰, 분자/분모, source row |
| **승인 주차 수** `approved_weeks`, `growthPeriodStats.approvedWeeks`, 메달 숫자 | `GET /api/admin/crews/[id]` (computed 필드), `GET /api/admin/crews/[id]/resume-card` | `user_growth_stats.approved_weeks (int)` (canonical, openapi 단언) — Cluster1 GET 이 직접 select (adminResumeCardData:232). `legacy_crew_import.cumulative_weeks` 는 별개 컬럼 (cumulative ≠ approved). | Derived 가능성 높음 (어떻게 적재되는지는 admin 코드에 없음) | **컬럼만 존재, 산정 로직은 admin 레포 외부**. `legacyCrewImport.cumulative_weeks` 와 `user_growth_stats.cumulative_weeks` 가 preferNumber 폴백 체인으로 정렬됨 (adminCrewData:354~358). | `legacy_crew_import.cumulative_weeks` → `user_growth_stats.cumulative_weeks` 이관 가능성 시사. 단 `approved_weeks` 는 legacy 측에 없음 → **신규 산정 필요** | "메달 내부 숫자"가 `approved_weeks` 인지 (overide 컬럼 `user_resume_card_settings.medal_week_override` 존재 — 별개 표시 override). 시즌별 approved vs 누적 approved 분리 |
| **실패 주차 수** `growthPeriodStats.unapprovedWeeks` | 없음 | **백엔드 흔적 없음** | 모름 | 없음 | 모름 | 정의 (= total - approved? rest 제외?) |
| **휴식 주차 수** `restWeeks`, `clubBreakWeeks`, `availableWeeks` | 없음 | **백엔드 흔적 없음** (seasons/weeks 테이블 존재성 자체 미확인) | 모름 | 없음 | 모름 | 개인휴식 / 공식휴식 / 가능주차 구분, week status 코드 |
| **시즌 수** `seasonHistories.length`, `growthPeriodStats.restSeasons/approvedSeasons` | `GET /api/admin/crews/[id]/cluster4` | `user_season_histories` (admin lib :123) — rating(0~10 int), review. **컬럼 외 다른 컬럼 코드에 없음**. seasons 테이블 별도 존재(`select("*")`) | Raw (시즌 row) + Derived (count) | Row 자체는 있음(가정), count 산정 코드 없음 | 모름 | `restSeasons` 정의 (어떤 status 인지), season_id ↔ year/name 매핑 |
| **별 / 단감** `badges.stars`, `pointsData.dangam`, `stats.dangam`, `points.star` | `GET /api/admin/crews/[id]/resume-card` (computed) | **`user_cumulative_points.total_stars (int)`** (adminResumeCardData:238, openapi 단언) | Derived (cumulative 라는 이름) | Cluster1 응답 `computed.totalStars` 로 노출. 산정 로직 admin 측에는 없음. | 모름 (legacy 측 score table 추정) | 시즌별 stars vs 누적 stars 분리 여부, "단감" 라벨이 stars 와 같은 값인지 |
| **방패 / 인절미** `badges.shields`, `pointsData.injeolmi`, `stats.injeolmi`, `points.shield` | 동상 | `user_cumulative_points.total_shields (int)` | Derived | 동상 | 모름 | 동상 |
| **번개 / 어흥** `badges.lightnings`, `pointsData.eoheung`, `stats.eoheung`, `points.lightning` | 동상 | `user_cumulative_points.total_lightnings (int)` | Derived | 동상. **컬럼 부호 제약 없음** (CHECK 없음, openapi=integer). 프론트가 `Math.abs(...)` 처리. | 모름 | 음수 저장 정책 (DB CHECK 추가 여부) |
| **품계 / 등급** `gradeStats.grade` (1~10), `gradeStats.gradeLabel`, `gradeStats.avgPercentile` | 없음 | **백엔드 흔적 없음** | 모름 | admin 측 어디에도 `grade`, `gradeLabel`, `avgPercentile` 컬럼/계산 흔적 없음 | 모름 | 1~10 매핑표, label 사전, "상위 %" 분자/분모 |
| **시즌 별점** `season.rating`, `user_season_histories.rating` | `PATCH /api/admin/crews/[id]/cluster4` (admin 가 직접 set) | `user_season_histories.rating` — DB CHECK: `NULL OR (0..10 정수)` (2026-05-21 마이그레이션). | Raw | admin 가 정수 0..10 으로만 입력 허용 (adminCluster4Data:96~110). PATCH 시 review 동시 업데이트. | 모름 | 0..10 정수 정책 확정됨. **단, 별점 5단계 표시는 프론트 책임**. |
| **주차 리뷰 별점** `weeklyReviewFromDB.rating` | 없음 (admin 미작성) | step1 이전: `weekly_reputations.score` (numeric, 모름). step2 이후: `weekly_reputations.rating numeric(3,1) 0..10 0.5단위`. | Raw | step2 마이그레이션 후 정책 명시. admin lib 는 아직 옛 shape (`score`) 가정. | 모름 | step1 rename 후 admin lib 가 `weekly_reputation_scores` 와 신규 `weekly_reputations` 중 어느 쪽을 부를지 |
| **평판 점수 / FM** `fmScore`, `seasonReputations.reduce(rating*3)` | 없음 | step2 이후 `season_reputations.rating(1..10 0.5 step)`. **`fmScore`/`*3` 가공 로직은 admin 측에 전무.** | Derived (프론트 가공) | admin 미구현 | 모름 | `*3` 의미 (가중치/표시 스케일), 합산 단위(주차 vs 시즌) |
| **성장률** `circles.seasonGrowth`, `growthRate.{rate,count,total}` | 없음 | **백엔드 흔적 없음** | 모름 | 없음 | 모름 | 분자/분모 정의 |
| **practicalCounts** `info / competency / experience / career` | 없음 | **백엔드 흔적 없음** (user_profiles, user_cluster2, user_growth_stats, user_cumulative_points, user_introductions 어느 곳에도 컬럼 없음) | 모름 | 없음 | 모름 | 4개 카운트가 어떤 활동을 집계하는지 |
| **growthPeriodStats** (7종 합본) | 없음 | **백엔드 흔적 없음** — admin 측 어디에도 구조체/조회 코드 없음. user-app 의 `/api/profile` 가 자체 계산하는 것으로 추정. | 모름 | 없음 | 모름 | 각 7개 카운트(approved/unapproved/rest/clubBreak/available/restSeasons/availableSeasons) 정의 |
| **gradeStats** (grade/gradeLabel/avgPercentile) | 없음 | **백엔드 흔적 없음** | 모름 | 없음 | 모름 | 산정식, 매핑표, 정의 |
| **Cluster3 채널 카드 rating** | `GET/PATCH /api/admin/crews/[id]/cluster3` | `portfolio_channel_cards.rating` (text NULL) — **컬럼 타입이 text** (adminCluster3Types:55). | Raw | admin 가 text 그대로 read/write | 모름 | text(예: "8") vs numeric 정책. 0~10 vs 1~10. |
| **Cluster3 Output contribution** | 동상 | `portfolio_top_cards.contribution (smallint NULL)` (adminCluster3Types:78) | Raw | admin 가 smallint 로 read/write | 모름 | 범위, 의미, % vs absolute |
| **슬로건 별점** `sloganData.slogan*.rating` (1~10) | `GET/PATCH /api/admin/crews/[id]/cluster2` (간접 — INTRODUCTION_FIELDS 화이트리스트) | `user_introductions.slogan_1/2/3_rating (integer)` (adminCluster2Data:89). openapi 스냅샷에는 미반영. | Raw | admin lib SLOGAN_FIELDS 에 포함, integer normalize | 모름 | 0..10 정수 정책 확정 여부, 5별 표시 매핑 |
| **Cluving Review (Club Review) 슬롯** | `GET /api/review-link`, `POST /api/admin/edit-windows/...` 와 연동 | `user_review_links` (PK user_id+week_index, CHECK week_index ∈ {3,6,9,12,15,18,21,24,27,30}) | Raw | 신규 (2026-05-13). 권한은 `user_edit_windows.resource_key='cluster2.review_links'` 게이트. | 기존 `user_cluster2.cluving_review_link` 는 backfill 완료 (week_index=30 으로) | 슬롯 ↔ "활동 주차" 의미 동치 여부 |

---

## 2. 보조 분석

### A. 현재 Supabase 에서 이미 **canonical 구조로 볼 수 있는** 테이블

(= admin lib 가 source-of-truth 로 직접 read/write 하고 있고, 스키마가 마이그레이션 또는 openapi 로 단언 가능한 것)

1. `user_profiles` — 프로필 식별/조직/연락처. **사용자 1행 = crew 1행** (adminCrewData 코멘트 명시).
2. `users` — auth ↔ legacy_user_id 매핑.
3. `legacy_crew_import` — 운영 메타데이터 (is_visible, admin_note, cumulative_weeks) 용 보조. **row source 가 아님** (adminCrewData:5~13).
4. `user_memberships` (is_current=true 단일 행) — team/part/membership_level/state.
5. `user_educations` — 학력 1:N. Cluster2 가 canonical writer (delete+insert 전체).
6. `user_introductions` — slogan 1/2/3 + tag + rating + 자기소개 5문항. **Cluster2 = canonical writer** (Cluster1 측 slogan_1 작성 라인은 dual-write 정리됨, INTRODUCTION_FIELDS=[]).
7. `user_cluster2` — Cluster2 사진/비디오/스토리. Cluster2 가 canonical writer.
8. `user_growth_stats` — **approved_weeks, cumulative_weeks** (integer). Cluster1 GET 가 직접 select. **컬럼만 canonical**, 산정 로직은 본 레포 외부.
9. `user_cumulative_points` — **total_stars / total_shields / total_lightnings** (integer). 동상.
10. `user_resume_card_settings` / `organization_resume_card_settings` / `site_resume_card_settings` — Cluster1 3-tier 설정.
11. `user_review_links` — Cluving 주차 슬롯 10개.
12. `user_edit_windows` — 범용 편집 권한 윈도우.
13. `applicants` + `admin_users` + `organizations` + `schools` — 운영 인프라.
14. `portfolio_channel_cards` / `portfolio_top_cards` — **CREATE TABLE 이 본 레포에 없으나** admin lib 가 17 / 27 컬럼을 hardcode 한 채 read/write. live DB 에 존재하는 것으로 운영상 가정.

### B. **아직 canonical 구조가 없는** 영역 (백엔드 코드/스키마 단언 불가)

= 프론트 인벤토리에는 등장하지만 본 admin 레포의 `lib/*` 또는 `db/migrations/*` 어디에도 컬럼/계산 흔적이 없는 것.

1. **일정 신뢰도 (`reliabilityRate`, `circles.scheduleReliability`)** — 분자/분모/스코프 어디에도 명세 없음.
2. **활동 완료율 (`completionRate`, `progress.*.rate`)** — 동상.
3. **growthPeriodStats 7종** (approved/unapproved/rest/clubBreak/available/restSeasons/availableSeasons) — admin 어디에도 구조체/조회 없음. `user_growth_stats` 컬럼은 `approved_weeks` + `cumulative_weeks` 만 단언됨.
4. **gradeStats** (`grade`, `gradeLabel`, `avgPercentile`) — 어디에도 없음. **품계/등급 도메인이 백엔드에 전혀 미정의** 상태.
5. **성장률 (`circles.seasonGrowth`, `growthRate.*`)** — 분자/분모 없음.
6. **평판 점수 / FM (`fmScore`, `seasonReputations.reduce(rating*3)`)** — step2 마이그레이션이 raw row storage 만 정의 (rating, content, keyword). aggregation/ranking/grade 는 "본 PR 범위 외" 라고 step2 헤더가 명시.
7. **practicalCounts 4종** (info/competency/experience/career) — 어디에도 없음.
8. **랭킹** — 코드/스키마 모두 흔적 없음 (프론트도 없음).
9. **Admin Dashboard 의 "정량 지표"** — 본 레포 `loadDashboardSnapshot` 은 totalMembers/pendingApplicants/openEditWindows/recentlyUpdatedMembers **운영 카운트** 만 집계. 프론트 인벤토리의 "Admin Dashboard" 정의가 화면 자체 부재라고 기록한 것과 일치.

### C. 기존(C#) 데이터 이관 시 **가장 위험한 영역**

> 본 레포만으로는 C# 측 스키마를 확인할 수 없으므로 "위험" 의 근거는 **현재 Supabase 측 canonical 구조의 부재 / 불일치** 임. C# 측 컬럼 매핑은 모름.

1. **D-1. score-grid → peer-review 피벗 (Cluster4 평판)** — 2026-05-21 step1 migration 이 옛 `reputation_keywords / weekly_reputations / season_reputations` 를 `*_scores` 로 rename, step2 가 **완전히 다른 shape** (peer-review: reviewer_id/target_user_id/week_card_id, rating numeric(3,1) 0.5 step, content, keyword) 의 동명 테이블을 생성. admin lib (`reputationKeywordsData.ts`, `weeklyReputationsData.ts`, `adminCluster4Data.ts` 의 season_reputations PATCH 블록) 는 **옛 컬럼명 (`keyword_key`, `score`, `label`, `is_active`, `category`) 을 SELECT/UPDATE 한다**. step2 가 운영 DB 에 적용된 순간 admin Cluster4 readonly 탭과 season_reputations PATCH 는 컬럼 부재로 깨질 수 있음. step1 헤더 코멘트도 "Admin 측 코드 갈아끼우는 PR 별도" 라고 인정. **이관 전에 admin lib 의 *_scores 전환 + 신 shape 적응이 선행되어야 함.**
2. **D-2. `user_growth_stats` / `user_cumulative_points` 의 산정 출처가 본 레포에 없음** — 두 테이블은 컬럼만 canonical 이고, **누가 어떻게 적재하는지** (cron? user-app? 외부 ETL?) 가 이 레포에 흔적 없음. C# 측 누적값을 단순 backfill 하면 향후 산정 주체가 동일 행을 덮어쓸 위험.
3. **D-3. `legacy_crew_import.cumulative_weeks` vs `user_growth_stats.cumulative_weeks` 이중 컬럼** — `adminCrewData.ts:354~358` 가 `preferNumber(growth?.cumulative_weeks, legacy?.cumulative_weeks)` 로 폴백 체인을 두지만, **두 컬럼이 다를 때 어느 쪽이 옳은지 정책 없음**. legacy 가 oo 주차, growth_stats 가 yy 주차일 수 있음.
4. **D-4. `growth_status` / `status` 텍스트 컬럼이 `user_profiles` 에 존재** (openapi 확인) — 값 enum 이 코드에서 정의되지 않음. legacy 의 상태값을 mapping table 없이 옮기면 미정의 텍스트가 들어갈 위험.
5. **D-5. `portfolio_channel_cards.rating` 컬럼 타입이 text** — 별점/등급/숫자/문자 중 어느 의도인지 admin 측 검증 없음 (sanitize 만 함). 이관 시 "1~10 정수" vs "텍스트 라벨" 결정 누락 위험.
6. **D-6. `weekly_reputations` rating 정책 변경** — step2 가 numeric(3,1) 0..10 의 0.5 단위로 강제. 옛 `weekly_reputation_scores.score` (numeric, scale 모름) 이관 시 0.5 단위 위반 row 가 CHECK 실패할 수 있음.
7. **D-7. `season_reputations.rating` 최소값 차이** — `weekly_reputations` 는 0 허용 / `season_reputations` 는 ≥1 (CHECK 강제). 옛 데이터에 시즌 평판 0 값이 있으면 이관 실패.
8. **D-8. `user_introductions.slogan_*_rating` 정수 0~10** — openapi 스냅샷에는 컬럼이 없어 DB CHECK 존재 여부 단언 불가. C# 측 별점이 0.5 단위면 데이터 손실 가능.

### D. 계산 공식 확정 전에 **반드시 결정해야 하는 항목** (admin 백엔드 관점)

1. **승인 주차 (`approved_weeks`) 의 산정 주체** — admin 이 직접 set 하는가? (현재 PATCH 라우트 없음 — `user_growth_stats` 는 PATCH 코드 미존재. **갱신 경로 자체가 불명**.)
2. **누적 포인트 3종 (`stars/shields/lightnings`) 의 적재 경로** — admin 이 직접 set 하는가? 누적이 어떻게 증가하는가? (PATCH 코드 없음.)
3. **`user_growth_stats.spring_cutoff_date` 의 의미** — openapi 에 존재 확인. 코드에서 select 하지 않음. 시즌 컷오프? 모름.
4. **`reputation_keywords` 의 두 후보 schema 중 채택** — peer-review (cluster_number/keyword) vs 옛 score-grid (keyword_key/label/is_active). step2/step3 가 이미 작성되어 있으나 **본 레포의 admin lib 는 옛 shape 가정 중**. 정책 확정 + admin lib 교체 PR 이 선행되어야 derived table 설계 가능.
5. **`*_scores` 이름의 옛 테이블을 계속 운영할지 결정** — step1 이 보존을 위해 rename 한 것이므로, 향후 derived 계산 시 (a) *_scores 를 history로 두고 신 *_reputations 만 사용 vs (b) *_scores 도 함께 보존 vs (c) drop 결정 필요.
6. **`weekly_reputations.keyword` vs `reputation_keywords.keyword` FK 미설정** — step2 코멘트가 명시적으로 "키워드 컬럼은 자유 텍스트, FK X" 라고 함. derived 집계 시 keyword 표기 변형 (대소문자, 공백) 정규화 정책 필요.
7. **`week_index` ↔ `week_id` 매핑** — `user_review_links.week_index smallint` vs `weekly_reputations.week_card_id uuid REFERENCES weeks(id)`. 동일 "주차" 개념을 두 테이블이 다른 타입으로 식별. weeks 테이블 schema 모름.
8. **시즌 ↔ 주차 환산 룰** — `user_season_histories` / `seasons` / `weeks` 간 FK 관계가 본 레포 코드에 없음 (step2 의 `season_reputations.season_history_id REFERENCES user_season_histories(id)` 만 확정). 시즌 1개당 주차 N개 매핑 정책 필요.
9. **메달 표시 주차값의 출처 우선순위** — 이미 코드상 `user_resume_card_settings.medal_week_override` (smallint, ≥0) override 존재. override vs approved_weeks vs growth_period_stats.approvedWeeks 의 우선순위 정책 확정.
10. **`portfolio_channel_cards.rating` text vs numeric** — derived 평균/등급 계산 전에 컬럼 타입 정책 확정 (현재 text 그대로 read/write).

---

## 3. 종합 표 (요구 포맷)

| 지표 | 현재 API | 현재 테이블 | Raw/Derived | 구현 상태 | 이관 필요 | 결정 필요 사항 |
|---|---|---|---|---|---|---|
| 일정 신뢰도 | (admin 없음) | (없음) | 모름 | 미구현 | 모름 | 분자/분모, 0–1 vs 0–100, 스코프 |
| 활동 완료율 | (admin 없음) | (없음) | 모름 | 미구현 | 모름 | 4 카테고리 합산 룰, 스코프 |
| 승인 주차 수 | `GET /api/admin/crews/[id]/resume-card`, `GET /api/admin/crews/[id]` | `user_growth_stats.approved_weeks` (int) | Derived (산정 주체 unknown) | 컬럼만 존재 / 산정 코드 admin 외부 | legacy → 신규 산정 필요 (legacy 측 없음) | 산정 주체, 시즌별 vs 누적, override 우선순위 |
| 실패 주차 수 | (admin 없음) | (없음) | 모름 | 미구현 | 모름 | 정의 자체 |
| 휴식 주차 수 (개인/공식/가능) | (admin 없음) | (없음 — weeks 테이블 단언 불가) | 모름 | 미구현 | 모름 | 휴식 종류 구분 |
| 시즌 수 | `GET /api/admin/crews/[id]/cluster4` | `user_season_histories` (graceful degrade), `seasons` (모름) | Raw + count | row 자체는 존재(가정) | 모름 | restSeasons 정의 |
| 별 / 단감 | `GET /api/admin/crews/[id]/resume-card` (computed) | `user_cumulative_points.total_stars` (int) | Derived | 컬럼만 / 산정 코드 외부 | 모름 | "단감" ↔ stars 동치, 시즌별 vs 누적 |
| 방패 / 인절미 | 동상 | `user_cumulative_points.total_shields` | Derived | 동상 | 모름 | 동상 |
| 번개 / 어흥 | 동상 | `user_cumulative_points.total_lightnings` | Derived | 동상 / CHECK 없음 | 모름 | 음수 저장 정책 |
| 품계 / 등급 (1~10) | (admin 없음) | (없음) | 모름 | 미구현 | 모름 | 매핑표, label 사전 |
| 상위 % (avgPercentile) | (admin 없음) | (없음) | 모름 | 미구현 | 모름 | 분자/분모 |
| 시즌 별점 (`rating` 0..10 int) | `PATCH /api/admin/crews/[id]/cluster4` | `user_season_histories.rating` | Raw | 정수 0..10 admin write 확정 (2026-05-21) | 모름 | 5단계 표시 매핑 |
| 주차 리뷰 별점 | (admin 없음) | `weekly_reputations.rating` (step2 후 numeric(3,1) 0..10 0.5단위) | Raw | step2 마이그레이션만 / admin lib 미적응 | 모름 | admin lib 교체 시점 |
| 평판 점수 (FM) | (admin 없음) | `season_reputations.rating` (step2 후 1..10 0.5단위) | Derived (`*3` 가공) | aggregation 미구현 | 모름 | `*3` 의미, 합산 단위 |
| 성장률 | (admin 없음) | (없음) | 모름 | 미구현 | 모름 | 분자/분모 |
| practicalCounts (info/competency/experience/career) | (admin 없음) | (없음) | 모름 | 미구현 | 모름 | 정의 자체 |
| growthPeriodStats (7종) | (admin 없음) | `user_growth_stats` 컬럼 부분 일치 (approved/cumulative 만), 나머지 5개 모름 | Derived | 5/7 미구현 | 모름 | 각 7개 정의 |
| gradeStats (grade/gradeLabel/avgPercentile) | (admin 없음) | (없음) | 모름 | 미구현 | 모름 | 산정식 |
| Cluster3 채널 rating | `GET/PATCH /api/admin/crews/[id]/cluster3` | `portfolio_channel_cards.rating (text)` | Raw | text 그대로 read/write | 모름 | text vs numeric, 범위 |
| Cluster3 Output contribution | 동상 | `portfolio_top_cards.contribution (smallint)` | Raw | smallint read/write | 모름 | 범위/단위 |
| 슬로건 별점 | `GET/PATCH /api/admin/crews/[id]/cluster2` | `user_introductions.slogan_*_rating (integer)` | Raw | integer normalize | 모름 | CHECK 제약 추가 여부 |
| Cluving 주차 슬롯 | `GET /api/review-link`, `/api/admin/edit-windows/*` | `user_review_links` (week_index ∈ {3,6,...,30}) | Raw | 신규 (2026-05-13) | `user_cluster2.cluving_review_link` backfill 완료 | 슬롯 ↔ 활동주차 의미 동치 |

---

## 4. 향후 derived table 필요 가능성 (관찰만, 설계 금지)

본 레포에서 발견된 **derived 후보 컬럼이 이미 존재**하는 항목과, **derived 도메인 자체가 부재**한 항목을 구분:

- **이미 derived 컬럼이 있는 곳** (덮어쓰는 주체 결정만 필요):
  - `user_growth_stats.approved_weeks`, `user_growth_stats.cumulative_weeks`
  - `user_cumulative_points.total_stars / shields / lightnings`
- **derived 컬럼이 전혀 없는 곳** (별도 테이블 신설 또는 view 가 필요할 가능성 — **본 보고서는 신설 제안 아님**):
  - 일정 신뢰도, 활동 완료율, 성장률 (분자/분모 source row 모두 미정)
  - 평판 점수(FM), 주차별 4 활동 완료율, 시즌 성장률, gradeStats
  - growthPeriodStats 7종 중 5종 (unapproved/rest/clubBreak/available/restSeasons/availableSeasons)
- **step2 가 명시적으로 "본 PR 범위 외" 라고 한 도메인**:
  - peer-review aggregation / ranking / grade / derived metric / growth stats (step2 헤더 인용)

---

## 5. 부록: admin lib 와 신규 마이그레이션의 불일치 (회귀 위험)

### 5-1. step2 적용 후 admin lib 와 컬럼 불일치 목록

(step2 = `2026-05-21_peer_review_pivot_step2_create_peer_review.sql`)

| admin lib 호출 위치 | 가정 컬럼 | step2 적용 후 실제 컬럼 |
|---|---|---|
| `reputationKeywordsData.ts:20` SELECT `keyword_key,label,description,category,sort_order,is_active,created_at,updated_at` | 옛 score-grid shape | NEW: `id, cluster_number, cluster_name, cluster_color, keyword, created_at` |
| `weeklyReputationsData.ts:19` SELECT `id,user_id,week_id,keyword_key,score,created_at,updated_at` | 옛 score-grid shape | NEW: `id, reviewer_id, target_user_id, week_card_id, rating, content, keyword, created_at, updated_at` |
| `adminCluster4Data.ts:289~349` PATCH `season_reputations` SET `keyword_key, score` | 옛 score-grid shape | NEW: `rating, content, keyword_1/2/3` (CHECK + UNIQUE 강화) |
| `adminCluster4Data.ts:124` `from("season_reputations").select("*").eq("user_id", userId)` | `user_id` 컬럼 가정 | NEW: 컬럼이 `reviewer_id` / `target_user_id` 로 분리. 단일 `user_id` 없음 |

> step1 헤더가 이미 인정한 사항이지만, 이관/계산 매트릭스 결정에 직접 영향. **본 보고서는 수정 제안 아님 — 사실 기록만.**

### 5-2. 본 레포에서 CREATE TABLE 단언이 없는 테이블 (운영 DB 존재 가정)

- `seasons`, `weeks`, `user_season_histories`, `portfolio_channel_cards`, `portfolio_top_cards`, `user_cluster2`, `user_growth_stats`, `user_cumulative_points`, `user_introductions` (admin lib `.from()` 호출이 graceful degrade 또는 openapi 단언으로만 보장됨)
- 이 중 openapi 스냅샷이 보장하는 것: `user_cluster2`, `user_growth_stats`, `user_cumulative_points`, `user_introductions` (부분 컬럼).
- 보장 없는 것: `seasons`, `weeks`, `user_season_histories`, `portfolio_channel_cards`, `portfolio_top_cards` — 본 레포 단독으로는 컬럼 단언 불가.

---

> **본 보고서 한계**
> - user-app(Career-Resume) 레포 미열람 → `/api/profile`, `/api/profile/summary`, `/api/slogans`, `/api/portfolio-channel-cards`, `/api/portfolio-top-cards` 의 응답 shape 와 산정 코드는 모두 모름.
> - live Supabase 의 실제 row/CHECK 단언 불가 → 본 보고서는 모두 코드+마이그레이션+openapi 스냅샷 기준.
> - 계산 공식의 "의미"는 의도적으로 미작성.
