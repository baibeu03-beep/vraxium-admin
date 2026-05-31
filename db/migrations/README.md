# Migrations

Supabase SQL Editor에서 **파일명 알파벳 순서대로** 실행한다.
모든 파일은 idempotent — 이미 적용된 환경에서 다시 돌려도 안전하다.

자동 실행 도구는 두지 않는다. 운영 DB와 신규 환경 모두 SQL Editor에 붙여넣어 수동으로 적용하는 것이 원칙이다.

## 적용 순서

| #  | File                                          | Purpose                                                                                              |
| -- | --------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| 1  | `2026-05-05_admin_crew_management.sql`        | `legacy_crew_import` 관리 컬럼(`is_visible`, `admin_note`, `updated_at`) + `crew_list_view` 재정의 |
| 2  | `2026-05-05_organization_aware_crew.sql`      | `organization_slug` join + `admin_crew_list_view` + `set_crew_organization()` RPC                    |
| 3  | `2026-05-07_resume_card_admin.sql`            | resume-card admin 3개 테이블 (`user_resume_card_settings`, `organization_resume_card_settings`, `site_resume_card_settings`) + seed |
| 4  | `2026-05-08_admin_applicants.sql`             | `public.applicants` + `auth_email` unique index + `touch_applicants_updated_at` trigger                |
| 5  | `2026-05-08_admin_users_hardening.sql`        | admin user-profiles 운영 컬럼 보강                                                                     |
| 6  | `2026-05-11_users_legacy_user_id_default.sql` | `users.legacy_user_id`에 synthetic bigint sequence default 부여 (신규 승인 사용자용, 100000000+)   |
| 7  | `2026-05-11_applicants_email_provider_unique.sql` | Kakao 재로그인 idempotency를 위한 `applicants(lower(email), provider)` unique index            |
| 8  | `2026-05-12_schools_source_unique.sql`        | `schools(source, source_id)` 복합 unique index — 외부 sync 의 idempotent upsert 용              |
| 9  | `2026-05-13_user_edit_windows.sql`            | 범용 사용자×리소스 편집 가능 기간 관리 (`user_edit_windows`) — 1차 resource: `cluster2.review_links` |
| 10 | `2026-05-13_user_review_links.sql`            | Cluster2 Club Review 10개 슬롯 저장 (`user_review_links`) + 기존 `cluving_review_link` backfill |
| 11 | `2026-05-22_cluster4_card_base_step1_user_activity_details.sql` | Cluster4-card 활동 모달 canonical 테이블 (`user_activity_details`) — `rating smallint` (0..10 CHECK) + `UNIQUE(user_id, week_id, activity_type_id)` 포함, updated_at trigger 도입 |
| 12 | `2026-05-22_cluster4_card_base_step2_career_projects.sql`        | Work Career 마스터 (`career_projects`) — admin SELECT 컬럼 + Career-Resume Front secondary info 컬럼(`output_links` 등) 포함 |
| 13 | `2026-05-22_cluster4_card_base_step3_career_project_weeks.sql`   | Work Career 프로젝트×주차 junction (`career_project_weeks`) — PK `(project_id, week_id)`, **step2 의존** |
| 14 | `2026-05-22_cluster4_card_base_step4_career_records.sql`         | Work Career user 기록 (`career_records`) — `UNIQUE(user_id, week_id, project_id)` + `grade`/`enhancement_status`/`grade_points` CHECK, **step2 의존** |
| 15 | `2026-05-22_peer_review_pivot_cleanup_drop_score_archive.sql`    | peer-review pivot step1 의 archive 두 개(`weekly_reputation_scores`, `season_reputation_scores`) 제거. **STEP A pre-flight probe + STEP B rollback DDL 캡처 후 적용** (row 0, code ref 0 확인됨) |
| 16 | `2026-05-22_permissions_matrix_step1_tables.sql`                 | 권한 매트릭스 canonical 테이블 3종 (`permissions`, `role_permissions`, `role_permissions_audit`) — CHECK / index / updated_at trigger 포함 |
| 17 | `2026-05-22_permissions_matrix_step2_seed.sql`                   | `permissions` 카탈로그 seed (Cluster1~3 v1 확정분 13개) — `ON CONFLICT (key) DO UPDATE`, **step1 의존**. `role_permissions` 는 seed 하지 않음 |
| 18 | `2026-05-22_account_management_step1_schema.sql`                 | 계정 관리: `user_profiles.role` 컬럼 (CHECK 7개 user-facing role, NULL 허용) + `user_role_audit` 테이블 |
| 19 | `2026-05-22_account_management_step2_backfill_operators.sql`     | 계정 관리: 기존 운영자 2명 `users` / `user_profiles` 백필 (role='super_admin'), **step1 의존**. probe 결과 id+email 명시 |
| 20 | `2026-05-22_account_management_step3_promote_operators_to_owner.sql` | 계정 관리: 기존 운영자 2명 `admin_users.role` `admin` → `owner` 승격 (super_admin gate 통과), **step2 의존**. 적용 직후 운영자 로그인 스모크 필수 |
| 21 | `2026-05-22_career_projects_admin_meta.sql`                          | `career_projects` 어드민 CRUD 메타: `updated_at` 컬럼 + `created_at DESC` 인덱스 + BEFORE UPDATE 트리거. **#12 (step2) 의존**, 기존 컬럼 변경 없음 |
| 22 | `2026-05-25_cluster3_growth_indicators.sql`   | Cluster3 성장 지표 최소 스키마: `activity_started_at/ended_at` + `user_week_statuses` + `total_raw_advantages` + 시드 + 검증 |
| 23 | `2026-05-25_cluster3_growth_seed_diversify.sql` | 시드 데이터 다양화: 30명을 6그룹(A~F)으로 재배분 + 특수 상태(weekly_rest/seasonal_rest/graduated/suspended) 포함. ⚠ 시드 전용, 운영 환경 실행 금지 |
| 24 | `2026-05-25_season_definitions_and_user_seasons.sql` | `season_definitions` (2021~2029 시즌 36개, 52주 고정 체인 공식 기반, 전환 주차 귀속 포함) + `user_season_statuses` (사용자별 시즌 success/rest) + 30명 시드 |
| 25 | `2026-05-25_official_rest_weeks_and_override.sql` | `official_rest_weeks` (공식 휴식 주차 정의) + `user_week_statuses.is_official_rest_override` + override 샘플 |
| 26 | `2026-05-25_week_season_key_attribution.sql` | `user_week_statuses.season_key` + `resolve_season_key(date)` 함수 + 기존 데이터 backfill |
| 27 | `2026-05-25_season_rest_request_policy.sql` | `user_season_statuses.requested_at` + `validate_season_rest_request()` 함수 + 1주차 비활동 전환 + 더미 보정 |
| 28 | `2026-05-25_fix_activity_started_at_backfill.sql` | `activity_started_at IS NULL` 전체 백필 — #22 의 `growth_status IS NOT NULL` 조건 제거. 모든 사용자에게 성장 시작일 보장 |
| 29 | `2026-05-27_org_settings_add_point_label.sql` | `organization_resume_card_settings.point_label` 컬럼 추가 + 3개 조직 시드 (encre→별, oranke→단감, phalanx→투구). 실무 경험 포인트 UI 표시명 |
| 30 | `2026-05-27_cluster4_experience_phase1.sql` | Cluster4 실무 경험 Phase 1 — `cluster4_teams` + `cluster4_experience_line_masters` + `cluster4_experience_line_evaluations` 테이블 3종 생성, `cluster4_lines` 에 `line_code`·`experience_line_master_id` 추가 + 기존 `team_id` FK 부여, info/competency/career line_code backfill. **#29 의존 없음, step1_tables·bridge_columns 의존** |
| 31 | `2026-05-27_cluster4_teams_org_slug.sql` | `cluster4_teams` 조직별 팀 마스터 재구성 — `organization_slug` 컬럼 추가, UNIQUE(team_name)→UNIQUE(organization_slug, team_name), 잘못 seed된 encre/oranke 삭제, 3개 조직 13팀 seed. **#30 의존** |
| 32 | `2026-05-30_experience_masters_category_slot.sql` | `cluster4_experience_line_masters` 에 `experience_category`(5종)·`experience_slot_order`(1~5) append + 도메인/1:1 정합 CHECK + 인덱스 + line_code 기준 25행 백필 + NULL 검증 NOTICE. **org_slug seed·xlsx seed 의존, append-only** |
| 33 | `2026-05-31_user_edit_windows_week_scope.sql` | 주간 자원(주간 회고/동료/평판) 편집 권한을 주차 단위로 분리 — `user_edit_windows` 에 `week_id`(weeks FK)·`season_key`(season_definitions FK) append, 기존 `UNIQUE(user_id, resource_key)` 제거 후 부분 unique index 2종(week別 / 전역 NULL)으로 대체 + 조회 인덱스. **#9·#24·weeks 의존, append-only / 기존 row 는 week_id=NULL 전역 권한 유지** |
| 34 | `2026-05-31_official_rest_periods.sql` | 날짜 이동형 공식 휴식(설/추석/임시) 신규 테이블 `official_rest_periods`(start_date~end_date 기준, type CHECK 4종, end_date≥start_date CHECK, updated_at trigger, 부분/타입 인덱스) **생성만**(시드 없음, 운영자가 Admin 에서 등록). 공식 휴식 판정 = seasonCalendar rule ∨ official_rest_periods overlap. **legacy `official_rest_weeks`·`weeks.is_official_rest` 는 보존(deprecated COMMENT), 삭제·backfill 금지**, 의존 없음 |

## 주의사항

- **Deprecated (2026-05-11 이후 admin app 사용 안 함)**: `admin_crew_list_view` 와 `set_crew_organization(text, text)` RPC. admin `/admin/crews/[slug]` 경로가 `user_profiles.organization_slug` 를 source of truth 로 직접 조회하면서 더는 참조하지 않는다. 사용자 앱이 아직 `crew_list_view` 를 읽을 수 있으므로 그쪽은 유지한다. 후속 cleanup migration 으로 drop 예정.
- **Deprecated archive (2026-05-22 cleanup 대기)**: `weekly_reputation_scores`, `season_reputation_scores` — peer-review pivot step1 의 rename archive. row 0, admin code ref 0 확인. cleanup migration #15 가 STEP A pre-flight probe / STEP B rollback DDL 캡처 / STEP C non-cascading DROP 순서로 정리. **prod·staging 모두 STEP A 통과 + Front·User App 레포 string grep 0건 확인 후 적용**.
- **1·2번 SQL의 user 매칭 컬럼**: 파일 내 `⚠` 라인(`up.user_id::text = lci.legacy_user_id::text`)은 운영 DB의 `user_profiles` 키 컬럼이 `user_id`인지 `id`인지에 맞춰 한 번 조정해야 한다. STEP 0 probe 쿼리 참조.
- **3번 SQL은 1번에 의존**: `user_resume_card_settings.user_id`가 `user_profiles(user_id)`를 FK로 참조한다.
- **권한 정책**: 신규 테이블은 모두 `anon`/`authenticated` SELECT만, write는 `service_role`(=`supabaseAdmin`) 경유 admin API에서만. 별도 RLS 정책은 두지 않는다.
- **신규 환경 부트스트랩**: 1 → 2 → 3 순서로 실행하면 admin app이 기대하는 schema가 그대로 만들어진다.
- **Cluster4-card base 묶음 (#11~#14)**: `step1 → step2 → step3 → step4` 순서로만 적용 가능 (step3·step4 가 step2 의 `career_projects(id)` FK 를 참조). 파일명 알파벳순 = 의존성 순서로 일치하므로 README 순서 그대로 실행. 적용 전 `weeks`, `user_profiles`, `activity_types` 존재 확인 필요 (FK target).
- **계정 관리 묶음 (#18~#20)**: `step1 → step2 → step3` 순서로만 적용 가능. step2 는 step1 의 `user_profiles.role` 컬럼에 의존하고, step3 는 step2 가 백필한 user_profiles row 에 의존한다. step2/step3 는 probe 2026-05-22 결과 (admin_users 2 rows + users/user_profiles row 부재 + role 컬럼 부재) 기준으로 운영자 id/email 을 직접 명시했으므로 다른 환경 적용 시 해당 값 검토 필요. step3 직후 운영자 본인이 로그인 스모크 + 권한 설정 페이지 토글 활성 확인 필수.

## 신규 마이그레이션 추가 시

- 파일명: `YYYY-MM-DD_<snake_case_purpose>.sql` — 날짜는 작성일 기준
- 첫 줄에 파일명 주석 + 1줄 목적 요약
- `CREATE TABLE IF NOT EXISTS`, `CREATE OR REPLACE FUNCTION`, `DROP TRIGGER IF EXISTS` 후 `CREATE TRIGGER`, `INSERT ... ON CONFLICT DO NOTHING` 패턴으로 idempotent 유지
- 위 표에 한 줄 추가
