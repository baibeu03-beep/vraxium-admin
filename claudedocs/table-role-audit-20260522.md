# Supabase `public` 스키마 — 테이블 역할 중복 점검 (2026-05-22)

본 문서는 **삭제·통합을 시행하지 않고**, 각 테이블의 현재 역할만 확정한다.
조사 범위는 사용자가 지정한 5개 그룹 14개 식별자.

## 조사 방법

| 항목 | 출처 |
|------|------|
| row 수 | `scripts/audit-tables.mjs` — service_role 키로 REST `count=exact` HEAD 호출 (실측 2026-05-22) |
| view / base table | `db/migrations/*.sql` 의 `CREATE VIEW` vs `CREATE TABLE` |
| 코드 참조 | `Grep` `from("…")` + 식별자 raw 검색 (lib/, app/api/, components/, openapi.json, claudedocs/) |
| FK / UNIQUE / CHECK | 마이그레이션 본문 (이 레포 외부에서 생성된 테이블은 `openapi.json` 추정에 기재된 범위만) |
| 분류 5종 | 원천 / 화면 저장 / 계산 캐시 / import 임시 / 설정 |
| 권장 조치 | 유지 / 보류 / deprecated 후보 / 통합 검토 (삭제 후보 표현은 사용하지 않음) |

> **주의**: `user_profiles` / `user_introductions` / `user_cluster2` / `user_growth_stats` / `user_cumulative_points` 는 본 admin 레포에 `CREATE TABLE` 정의가 없다. 운영 Supabase 에서는 이전(legacy / 외부 레포)에 생성된 base table 로, 본 점검은 admin 측 소비 패턴 기준 분류이다.

---

## 결과 표

| 그룹 | 테이블명 | row 수 | 코드 참조 여부 | 현재 역할 | 중복 의심도 | 권장 조치 |
|------|---------|--------|----------------|-----------|------------|-----------|
| **Crew** | `crew_list_view` | 34 | 본 admin 레포에선 직접 select 안 함 — User App `/crews` 가 anon 권한으로 읽는 공개 뷰 (마이그레이션 주석 명시) | **VIEW** — `legacy_crew_import × user_profiles` JOIN, `is_visible=true` 필터. User App 표시용 (legacy_user_id, display_name, team_name, part_name, cumulative_weeks, organization_slug, club) | 낮음 | **유지** (외부 User App 의존) |
| **Crew** | `admin_crew_list_view` | 34 | **참조 없음** — `db/migrations/README.md:29` 가 "2026-05-11 이후 admin app 사용 안 함, 후속 cleanup migration 으로 drop 예정" 명시. admin 은 `legacy_crew_import + user_profiles` 직접 조회로 전환됨 | **VIEW** — admin 서버용 (is_visible/admin_note/updated_at + organization_slug 포함). service_role 만 부여 | **높음** vs `legacy_crew_import + user_profiles` 직접 join | **deprecated 후보** (이미 README 에 명시됨) |
| **Crew** | `legacy_crew_import` | 34 | `lib/adminCrewData.ts:fetchCrewSourceRows` (read), `app/api/admin/crews/route.ts` POST (insert) | **BASE TABLE — 원천 데이터** (phalanx import) + admin 운영 컬럼 (`is_visible`, `admin_note`, `updated_at` + trigger). PK 는 운영 DB 정의(이 레포에 ADD COLUMN 만), 1:N join key = `legacy_user_id` ⇄ `user_profiles.user_id::text` | 낮음 — canonical 명단 | **유지** |
| **Reputation** | `season_reputations` | 1 | admin 레포 lib 직접 read 없음 (Front 가 canonical 소비자). 본 admin Cluster4 readonly 탭은 step1 이전 이름인 `from("season_reputations")` 가 step2 fresh 빈 테이블을 가리키도록 의도됨 (peer-review pivot step1 주석) | **BASE TABLE — 화면 저장 데이터** (peer-review row). FK `user_profiles(reviewer_id, target_user_id)` ON DELETE CASCADE, FK `user_season_histories(season_history_id)` ON DELETE RESTRICT, UNIQUE `(reviewer_id, target_user_id, season_history_id)`, no-self-review CHECK, rating 1..10 half-step CHECK, keyword_1/2/3 distinct CHECK, content 1..300 자 | 낮음 (신규 canonical, 2026-05-21 step2 생성) | **유지** |
| **Reputation** | `season_reputation_scores` | 0 | **참조 없음** — step1 에서 옛 `season_reputations`(score-grid) 를 rename 하여 보존한 archive 식 빈 테이블 | **BASE TABLE — 이전 스키마 보존 archive** (peer-review pivot 이전 컬럼 셋). 데이터 0건 이지만 향후 cleanup PR 까지 보존 | **높음** vs canonical `season_reputations` (이름 충돌 직후, 운영 사용 없음) | **deprecated 후보** (pivot 정착 확인 후) |
| **Reputation** | `weekly_reputations` | 1 | `lib/weeklyReputationsData.ts:listWeeklyReputations`, `app/api/weekly-reputations/route.ts` (GET, admin guard); admin Cluster4 readonly 탭 | **BASE TABLE — 화면 저장 데이터** (주차 peer-review row). FK `user_profiles(reviewer_id, target_user_id)` ON DELETE CASCADE, FK `weeks(week_card_id)` ON DELETE RESTRICT, UNIQUE `(reviewer_id, target_user_id, week_card_id)`, rating 0..10 half-step CHECK, content 1..100 자 CHECK, no-self-review CHECK, updated_at trigger | 낮음 (신규 canonical) | **유지** |
| **Reputation** | `weekly_reputation_scores` | 0 | **참조 없음** — step1 rename archive | **BASE TABLE — 이전 스키마 보존 archive** | **높음** vs canonical `weekly_reputations` | **deprecated 후보** |
| **User core** | `user_profiles` | 35 | 이 레포 전반의 canonical user identity. read/write 진입점이 광범위함 — `lib/adminCrewData.ts`, `lib/adminCluster2Data.ts`, `lib/adminCluster3Data.ts`, `lib/adminCluster4Data.ts`, `lib/adminMembersData.ts`, `lib/adminAppUsersData.ts`, `lib/adminApplicantData.ts`, `lib/adminResumeCardData.ts`, `lib/careerRecordsData.ts`, `lib/weeklyReputationsData.ts`, `app/api/admin/user-profiles/*` 3개, `app/api/admin/crews/[legacy_user_id]/cluster{2,3,4}/route.ts`, `app/auth/callback/route.ts`, applicants approve flow 등 | **BASE TABLE — 원천 데이터** (canonical user identity). PK `user_id` (uuid). 본 레포에 CREATE 없음 (외부 정의). 다수 테이블의 FK 타깃 | 없음 (canonical) | **유지** |
| **User core** | `user_introductions` | 2 | `lib/adminCluster2Data.ts:487, 635` (read/upsert), `lib/adminResumeCardData.ts:220, 398, 404, 413, 419` (find-or-create), `components/admin/Cluster2Editor.tsx`, `components/admin/cluster2/PhotoSlots.tsx`, `components/admin/ResumeCardEditor.tsx`. lib 주석이 schema source-of-truth 역할 | **BASE TABLE — 화면 저장 데이터** (cluster2 슬로건/태그/평점 1:1). 컬럼: `slogan_1/2/3`, `slogan_*_tag`, `slogan_*_rating` (0..10), `sub_photo_5`, `video_url_*` 일부. PK `user_id`. 본 레포에 CREATE 없음 | **중간** vs `user_cluster2` — 둘 다 cluster2 컨텐츠의 1:1 분할 (photo/video/essay 는 `user_cluster2`, slogan/태그/sub_photo_5 는 `user_introductions`). 동일 사용자 키, 동일 화면 (Cluster2Editor) 가 양쪽을 함께 upsert | **통합 검토** (cluster2 1:1 컨텐츠 컬럼셋 통합 가능성) — 단 외부 (Front, ResumeCard) 사용자가 분리 가정에 의존 중이므로 단독 결정 금지 |
| **User core** | `user_cluster2` | 1 | `lib/adminCluster2Data.ts:475, 611` (read/upsert), `app/api/review-link/route.ts:82, 226` (readonly `cluving_review_link`), `db/migrations/2026-05-13_user_review_links.sql` (backfill 출처), `components/admin/Cluster2Editor.tsx`, `components/admin/cluster2/PhotoSlots.tsx` | **BASE TABLE — 화면 저장 데이터** (cluster2 미디어 + 5문항). 컬럼: `main_photo_url`, `sub_photo_1_url`~`sub_photo_4_url`, `sidebar_photo_url` (legacy, 미사용), `video_url_1`~`video_url_3`, `growth_story`/`social_experience`/`career_direction`/`work_style`/`personal_story`, `cluving_review_link` (readonly, week_index=30 으로 backfill 됨). PK `user_id`. 본 레포에 CREATE 없음 | **중간** vs `user_introductions` (위 항목과 대칭) | **통합 검토** |
| **Career** | `career_records` | 0 | `lib/careerRecordsData.ts:listCareerRecords / upsertCareerRecord / deleteCareerRecord`, `components/admin/Cluster4Editor.tsx` → `components/admin/cluster4/ActivityTab.tsx` | **BASE TABLE — 화면 저장 데이터** (사용자 단위 주차×프로젝트 기록). FK `user_profiles(user_id)` CASCADE, `weeks(week_id)` RESTRICT, `career_projects(project_id)` RESTRICT, UNIQUE `(user_id, week_id, project_id)`, CHECK `enhancement_status IN {not_applicable, pending, enhanced, failed}`, CHECK `grade IN {S,A,B,C,D}`, CHECK `grade_points >= 0`. step4 (2026-05-22) | 낮음 (신규, FK 강제) | **유지** |
| **Career** | `career_projects` | 0 | `lib/careerRecordsData.ts` PROJECT_SELECT (join 대상 + UI 표시). 본문 직접 write 코드 없음 — admin UI seed 별도 | **BASE TABLE — 원천 데이터(마스터)** (회사·직무·프로젝트 정의 + 멘토 정보 + Front Career-Resume secondary info: `output_links`, `output_images`, `company_homepage_links` jsonb, `secondary_info_deadline`). step2 (2026-05-22) | 낮음 (신규 마스터) | **유지** |
| **Career** | `career_project_weeks` | 0 | **참조 없음** (코드 read/write 0건). `lib/careerRecordsTypes.ts:14` 주석에만 schema 가 명시됨 | **BASE TABLE — 설정/junction** (project ⇄ week 가용성 게이트). PK `(project_id, week_id)`, FK `career_projects(id)` CASCADE, FK `weeks(id)` RESTRICT, `is_active boolean DEFAULT true`. step3 (2026-05-22) | 낮음 (junction 고유 역할) | **보류** (소비 코드 정착 전 — admin UI / Front secondary info 페이지에서 가용 프로젝트 필터에 사용 예정으로 마이그레이션에 명기됨) |
| **Growth/Points** | `user_cumulative_points` | 0 | `lib/adminResumeCardData.ts:238` (read only — `total_stars / total_shields / total_lightnings`); `claudedocs/backend-quantitative-survey-20260521.md` 의 D-2 가 **이 레포에 ingest 코드가 없음** 을 경고 ("누가 어떻게 적재하는지 본 레포 흔적 없음 — cron? user-app? 외부 ETL?") | **BASE TABLE — 계산 캐시** (누적 별/방패/번개). PK 추정 `user_id`. 본 레포에 CREATE 없음, openapi.json 기준 컬럼 단언만 | **중간** vs `user_growth_stats` (둘 다 derived 누적 캐시, ingest 출처 불명) | **보류** (ingest 주체 확정 전에는 분류·통합 검토 불가) |
| **Growth/Points** | `user_growth_stats` | 34 | `lib/adminCrewData.ts:258` (read — `cumulative_weeks, approved_weeks`), `lib/adminResumeCardData.ts:232` (read), `app/api/admin/crews/[legacy_user_id]/route.ts:20` 주석 ("user_profiles / user_memberships / user_growth_stats 가 crew source") | **BASE TABLE — 계산 캐시** (사용자 단위 누적 주차 / 승인 주차). row 34 = `legacy_crew_import` row 34 = `user_profiles` row 35 — 사실상 1:1 매핑이지만 1건 차이 존재. 본 레포에 CREATE 없음 | **중간** vs `user_cumulative_points` (위 항목과 대칭) | **보류** (ingest 주체 확정 전) |

---

## 분류 5종 매핑 요약

| 분류 | 해당 테이블 |
|------|-------------|
| 원천 데이터 | `legacy_crew_import` (phalanx import), `user_profiles` (canonical identity), `career_projects` (master) |
| 화면 저장 데이터 | `user_cluster2`, `user_introductions`, `career_records`, `weekly_reputations`, `season_reputations` |
| 계산 캐시 | `user_growth_stats`, `user_cumulative_points` |
| import 임시 / archive | `weekly_reputation_scores`, `season_reputation_scores` (peer-review pivot 직전 rename archive) |
| 설정 / junction | `career_project_weeks` (project ⇄ week 가용성 게이트) |
| **View (저장 없음)** | `crew_list_view` (User App 공개 뷰), `admin_crew_list_view` (deprecated) |

---

## 권장 조치별 묶음

### 유지
- `crew_list_view` — 외부 User App 이 anon 으로 읽음, 마이그레이션 주석에 의존 명시
- `legacy_crew_import` — admin crew 화면의 canonical 명단
- `user_profiles` — 이 레포 전반의 canonical user identity
- `weekly_reputations`, `season_reputations` — peer-review pivot 후 canonical (step2, 2026-05-21)
- `career_records`, `career_projects` — Cluster4-card base 묶음 (step2/4, 2026-05-22)

### 보류
- `career_project_weeks` — 신규(step3) junction. lib 소비 코드 미정착이지만 step2/4 FK 의존성과 Front secondary info 사용 예정이 마이그레이션에 명기됨. 코드 정착 전까지 판단 보류
- `user_growth_stats`, `user_cumulative_points` — 둘 다 derived 누적값. ingest 주체(cron / user-app / 외부 ETL) 가 본 admin 레포에 없음. 정체 확정 전 통합·중복 판단 불가 (`claudedocs/backend-quantitative-survey-20260521.md` D-2 미해결 항목)

### deprecated 후보
- `admin_crew_list_view` — `db/migrations/README.md:29` 가 이미 "후속 cleanup migration 으로 drop 예정" 명시. 코드 참조 0건, admin 은 `user_profiles.organization_slug` 직접 조회로 전환됨
- `weekly_reputation_scores`, `season_reputation_scores` — peer-review pivot step1 의 rename archive. 데이터 0건, 코드 참조 0건. pivot 정착 확인 후 cleanup 권장

### 통합 검토
- `user_cluster2` ⇄ `user_introductions` — 둘 다 cluster2 컨텐츠 1:1 분할 (photo/video/essay vs slogan/태그/sub_photo_5). 동일 사용자 키, 동일 화면(`Cluster2Editor`) 이 함께 upsert. 단 외부(Front, ResumeCard) 소비자가 분리 가정에 의존 중이므로 admin 단독 결정 금지 — 외부 레포의 select shape 와 함께 검토 필요

---

## 검증 보류 항목 (본 점검 범위 밖)

1. **`user_growth_stats` / `user_cumulative_points` 의 ingest 주체** — 이 레포에 코드 없음. 외부 레포 / cron / ETL 추적 필요
2. **`user_introductions.sub_photo_5` 의 노출 위치** — `PhotoSlots.tsx:61` 의 hint 가 user_introductions 인데 다른 4개는 `user_cluster2` 임. 컬럼 위치 불일치 검증 별도 필요
3. **`legacy_crew_import` row 34 vs `user_profiles` row 35** — 1건 차이. 신규 승인 사용자 1명이 아직 legacy import 안 됐을 가능성 (`2026-05-11_users_legacy_user_id_default.sql` 의 synthetic sequence). 본 점검에선 단순 기록
4. **`user_introductions` row 2** vs **`user_cluster2` row 1** vs **`user_profiles` row 35** — 화면 저장 데이터의 채움률이 매우 낮음. 운영 상태일 가능성, 본 점검 범위 밖

---

## 실측 row 수 (2026-05-22, service_role)

```
crew_list_view              34
admin_crew_list_view        34
legacy_crew_import          34
season_reputations           1
season_reputation_scores     0
weekly_reputations           1
weekly_reputation_scores     0
user_profiles               35
user_introductions           2
user_cluster2                1
career_records               0
career_projects              0
career_project_weeks         0
user_cumulative_points       0
user_growth_stats           34
```

조회 스크립트: `scripts/audit-tables.mjs` (one-off, service_role REST `count=exact` HEAD).
