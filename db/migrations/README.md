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

## 주의사항

- **1·2번 SQL의 user 매칭 컬럼**: 파일 내 `⚠` 라인(`up.user_id::text = lci.legacy_user_id::text`)은 운영 DB의 `user_profiles` 키 컬럼이 `user_id`인지 `id`인지에 맞춰 한 번 조정해야 한다. STEP 0 probe 쿼리 참조.
- **3번 SQL은 1번에 의존**: `user_resume_card_settings.user_id`가 `user_profiles(user_id)`를 FK로 참조한다.
- **권한 정책**: 신규 테이블은 모두 `anon`/`authenticated` SELECT만, write는 `service_role`(=`supabaseAdmin`) 경유 admin API에서만. 별도 RLS 정책은 두지 않는다.
- **신규 환경 부트스트랩**: 1 → 2 → 3 순서로 실행하면 admin app이 기대하는 schema가 그대로 만들어진다.

## 신규 마이그레이션 추가 시

- 파일명: `YYYY-MM-DD_<snake_case_purpose>.sql` — 날짜는 작성일 기준
- 첫 줄에 파일명 주석 + 1줄 목적 요약
- `CREATE TABLE IF NOT EXISTS`, `CREATE OR REPLACE FUNCTION`, `DROP TRIGGER IF EXISTS` 후 `CREATE TRIGGER`, `INSERT ... ON CONFLICT DO NOTHING` 패턴으로 idempotent 유지
- 위 표에 한 줄 추가
