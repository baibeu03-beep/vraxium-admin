# Olympus PMS → Vraxium Supabase 필드 매핑 매트릭스

> **작성일**: 2026-05-22
> **작성 목적**: 30명 샘플 사용자 더미 데이터 생성 전, 기존 Olympus 데이터가 현재 Vraxium 의 어느 테이블/컬럼으로 이관되는지 정리
> **조사 기준**
> - Olympus: MySQL `olympus` + MSSQL `Olympus_db` (Identity 전용) + `HrAppCore.Models` Entity / `Olympus/Pages/Users/*.razor` UI / `UserRepositoryEfCoreAsync`
> - Vraxium: `db/migrations/*.sql` (2026-05-05 ~ 2026-05-22) + `lib/admin*Data.ts` 실독·쓰기 경로 + 기존 base schema (live DB only)
>
> **중요 정정**: vraxium-admin 코드베이스에서 **Cluster3 = 포트폴리오 카드 (별도 앱)**, **시즌·주차·peer-review·동료 평가는 Cluster4 영역**임. 사용자 요청의 "Cluster3" 매핑은 vraxium 의 peer-review/weekly_reviews 영역으로 해석.
>
> **상태 구분**
> - `DIRECT` = 이미 매핑됨
> - `TRANSFORM` = 형태 변경 후 매핑
> - `SPLIT` = 하나의 필드가 여러 필드로 분리
> - `MERGE` = 여러 필드가 하나로 합쳐짐
> - `NEW` = Vraxium 신규 필드
> - `DROPPED` = 더 이상 사용 안 함

---

## 1. 마스터 매핑 매트릭스

### 1-A. `users` (Olympus 인적 마스터)

| Olympus Table | Olympus Column | Vraxium Table | Vraxium Column | Status | Notes |
|---|---|---|---|---|---|
| users | UserId (int PK) | users | legacy_user_id (bigint) | TRANSFORM | bigint default seq 100_000_000+ (`2026-05-11`); 신규 PK 는 `user_profiles.user_id` uuid |
| users | UserId | user_profiles | user_id (uuid) | NEW | uuid 신규 채번, legacy_user_id 와 bridge |
| users | Name | user_profiles | display_name | DIRECT | text |
| users | BirthDay (varchar(6) "220926") | user_profiles | birth_date (text, ISO date) | TRANSFORM | "YYMMDD" → "YYYY-MM-DD" 변환 필요 |
| users | Gender ('남'/'여') | user_profiles | gender (text) | DIRECT | enum 미정의, 자유 text |
| users | School | user_profiles | school_name | DIRECT | + user_educations.school_name (1:N) |
| users | Major | user_profiles | department_name | DIRECT | + user_educations.major_name_1 |
| users | Address | user_profiles | address | DIRECT | live DB에만 존재 (migration 없음, TS 사용 중) |
| users | Contact | user_profiles | contact_phone | DIRECT | unique 제약 Olympus 측만; Vraxium 측 unique index 없음 |
| users | mail | user_profiles | contact_email | DIRECT | 표시용 |
| users | mail | user_profiles | auth_email | TRANSFORM | lowercase, applicants 연동 키 |

### 1-B. `usersinfo` (멤버십 상태)

| Olympus Table | Olympus Column | Vraxium Table | Vraxium Column | Status | Notes |
|---|---|---|---|---|---|
| usersinfo | InfoID | — | — | DROPPED | identity, 의미 없음 |
| usersinfo | UserID (FK CASCADE) | user_memberships | user_id (uuid) | TRANSFORM | int → uuid 변환 (user_profiles 매핑) |
| usersinfo | Team | user_memberships | team_name | DIRECT | base table (live DB only) |
| usersinfo | Part | user_memberships | part_name | DIRECT | base table |
| usersinfo | Week (누적주차) | user_growth_stats | cumulative_weeks | DIRECT | + legacy_crew_import.cumulative_weeks 미러 |
| usersinfo | Week | user_growth_stats | approved_weeks | TRANSFORM | useractivities.IsActive=1 count |
| usersinfo | Level | user_memberships | membership_level | DIRECT | 일반/심화/운영진 |
| usersinfo | StartDate | user_memberships | (없음) | NEW | **joined_at / created_at 컬럼 없음** — 추가 필요 |
| usersinfo | State (일반/활동정지/졸업/운영진) | user_profiles | status | TRANSFORM | enum: active, weekly_rest, seasonal_rest, graduated, suspended |
| usersinfo | State | user_memberships | membership_state | DIRECT | 중복 보관 |
| usersinfo | UserRole ('admin') | admin_users | role | TRANSFORM | 자유 text → CHECK('owner','admin','viewer') |
| usersinfo | TeamRole ('팀장') | — | — | NEW | **현재 매핑 없음** — 별도 role_assignments 신설 필요 |

### 1-C. `userspoint` (포인트 잔액)

| Olympus Table | Olympus Column | Vraxium Table | Vraxium Column | Status | Notes |
|---|---|---|---|---|---|
| userspoint | PointId | — | — | DROPPED | identity |
| userspoint | UserID | user_cumulative_points | user_id (uuid) | TRANSFORM | int → uuid |
| userspoint | Star | user_cumulative_points | total_stars | DIRECT | |
| userspoint | Shield | user_cumulative_points | total_shields | DIRECT | 기본값 Olympus=5, Vraxium 측 default 미확인 |
| — | — | user_cumulative_points | total_lightnings | NEW | Olympus 없음, Vraxium 신규 화폐 |

### 1-D. `useraccounts` (SNS ID) — **🔴 전체 미매핑**

| Olympus Table | Olympus Column | Vraxium Table | Vraxium Column | Status | Notes |
|---|---|---|---|---|---|
| useraccounts | AccountNum | — | — | DROPPED | identity |
| useraccounts | UserID | — | — | NEW | user_social_accounts 신설 필요 |
| useraccounts | NaverIdComment | — | — | NEW | Vraxium 측 SNS 계정 테이블 부재 |
| useraccounts | NaverIdLike | — | — | NEW | 동일 |
| useraccounts | NaverIdCafe (autoscrap critical) | — | — | NEW | unique 보장 필수 |
| useraccounts | YoutubeId | — | — | NEW | |
| useraccounts | InstaId | — | — | NEW | |
| useraccounts | TstoryId | — | — | NEW | |

### 1-E. `usersmoreinfo` (자유 메모)

| Olympus Table | Olympus Column | Vraxium Table | Vraxium Column | Status | Notes |
|---|---|---|---|---|---|
| usersmoreinfo | MoreId | — | — | DROPPED | identity |
| usersmoreinfo | UserID | user_profiles | vision (text) | MERGE | 1:N → 1:1 단일 필드로 압축 가능 (Title/Info 합쳐) |
| usersmoreinfo | Title | user_profiles | (없음) | NEW | user_notes 1:N 신설 권장 |
| usersmoreinfo | Info | user_profiles | vision | TRANSFORM | 단일 필드 fallback |

### 1-F. `useractivities` (활동 기록 → Cluster4)

| Olympus Table | Olympus Column | Vraxium Table | Vraxium Column | Status | Notes |
|---|---|---|---|---|---|
| useractivities | ActivityId | user_activity_details | id (uuid) | TRANSFORM | int → uuid |
| useractivities | UserId | user_activity_details | user_id | TRANSFORM | int → uuid |
| useractivities | Activity (longtext) | user_activity_details | sub_title + growth_point | SPLIT | 자유 입력 → 모달 영역 분할 |
| useractivities | StartDate | weeks (via week_id) | weeks.started_at | TRANSFORM | 직접 컬럼 없음 — week_id FK 로 표현 |
| useractivities | EndDate | weeks (via week_id) | weeks.ended_at | TRANSFORM | 동일 |
| useractivities | Star (0~10) | user_activity_details | rating (smallint 0..10) | DIRECT | CHECK 일치 |
| useractivities | Season | weeks→seasons | seasons.* | TRANSFORM | seasons FK |
| useractivities | SeasonWeek | weeks | weeks.week_number | TRANSFORM | week 차원 |
| useractivities | UserWeek | user_growth_stats | approved_weeks | TRANSFORM | 누적 계산값 |
| useractivities | IsActive (tinyint) | — | — | NEW | **인정 여부 컬럼 없음** — user_activity_details 에 is_approved 추가 필요 (또는 별도 review row) |
| useractivities | Reason | — | — | NEW | 미인정 사유 컬럼 없음 |
| useractivities | UserLevel/Team/Part (snapshot) | — | — | DROPPED | snapshot 정책 미정 — user_memberships history 로 대체 가능 |
| useractivities | activity_type 분류 | user_activity_details | activity_type_id (text) | TRANSFORM | Olympus 자유 text → activity_types 마스터로 정규화 |

### 1-G. `pointlogs` (포인트 원장 67k rows) — **🔴 전체 미매핑**

| Olympus Table | Olympus Column | Vraxium Table | Vraxium Column | Status | Notes |
|---|---|---|---|---|---|
| pointlogs | LogNum (int PK) | — | — | NEW | **point_ledger 테이블 신설 필요 (Cluster4)** |
| pointlogs | UserID | — | — | NEW | |
| pointlogs | code (report/bonus/manual) | — | — | NEW | event_type lookup 필요 |
| pointlogs | Star (signed delta) | — | — | NEW | |
| pointlogs | Shield (signed delta) | — | — | NEW | |
| pointlogs | log ("2026봄 3주차") | — | — | NEW | 또는 (season_id, week_id) FK 분리 |
| pointlogs | info | — | — | NEW | |
| pointlogs | etc (varchar 5000) | — | — | NEW | metadata jsonb 권장 |
| pointlogs | ActivityTime | — | — | NEW | occurred_at |
| pointlogs | createtime | — | — | NEW | created_at |
| pointlogs | Creater | — | — | NEW | actor_user_id (FK admin_users) |
| pointlogs | IsDeleted / DeletedTime | — | — | NEW | voided_at |
| pointlogs | IsHide | — | — | NEW | is_hidden boolean |

### 1-H. `userselectedteams` (시즌 팀 선택) — **미매핑**

| Olympus Table | Olympus Column | Vraxium Table | Vraxium Column | Status | Notes |
|---|---|---|---|---|---|
| userselectedteams | Id | — | — | NEW | season_team_choices 신설 권장 |
| userselectedteams | UserId | — | — | NEW | |
| userselectedteams | UserTeam (snapshot) | — | — | NEW | |
| userselectedteams | Team (1순위 선택) | — | — | NEW | |
| userselectedteams | Part (1순위) | — | — | NEW | |
| userselectedteams | IsDone / CompletedTime | — | — | NEW | |

### 1-I. `rest*` (휴식/정지) — **미매핑**

| Olympus Table | Olympus Column | Vraxium Table | Vraxium Column | Status | Notes |
|---|---|---|---|---|---|
| restdates | UserId, StartDate, EndDate, info | user_profiles.status | 'weekly_rest'/'seasonal_rest' | MERGE | 상태값만 반영, 기간/사유 미보관 |
| restdates | (전체) | — | — | NEW | user_rest_periods 신설 필요 |
| restlogs | (전체) | — | — | NEW | user_rest_history 신설 |
| restchangelogs | OldValue/NewValue, Lightning | — | — | NEW | 변경 이력 — Vraxium lightning 화폐와 연동 검토 |
| seasonrestlogs | (전체) | — | — | NEW | |
| stopuserlogs | UserId, Info, StopDate | user_profiles.status | 'suspended' | MERGE | 상태만 반영 |
| stopuserlogs | (전체) | — | — | NEW | user_status_history 신설 |

### 1-J. `graduate*` (졸업) — **미매핑**

| Olympus Table | Olympus Column | Vraxium Table | Vraxium Column | Status | Notes |
|---|---|---|---|---|---|
| graduateusers | UserId, State, 7 boolean (IsConfirm/IsEnd/IsUpload/IsCreateFile/IsFinalFile/IsRefund) | user_profiles.status | 'graduated' | MERGE | 상태값만 반영 |
| graduateusers | (전체 워크플로우) | — | — | NEW | graduation_workflows 신설 필요 |
| graduatelogs | (전체) | — | — | NEW | |
| essaylinks | Link, ImageLink, Category | — | — | NEW | graduation_essays 신설 |

### 1-K. 인증 (별도 DB)

| Olympus Table | Olympus Column | Vraxium Table | Vraxium Column | Status | Notes |
|---|---|---|---|---|---|
| members (MySQL) | MemberId | — | — | DROPPED | Supabase auth.users 가 대체 |
| members | Email | applicants | email | TRANSFORM | applicant flow 통과 후 user_profiles.auth_email |
| members | Password (hash) | auth.users | encrypted_password | TRANSFORM | BCrypt → argon2 재해시 필요 (강제 비밀번호 재설정 권장) |
| members | UserId (→users.UserId) | applicants | linked_user_id (uuid) | TRANSFORM | int → uuid 매핑 |
| members | UserName | user_profiles | display_name | DIRECT | 중복, users.Name 우선 |
| members | Contact | user_profiles | contact_phone | DIRECT | 중복 |
| members | Role | admin_users | role | TRANSFORM | 운영진만 admin_users row 생성 |
| AspNetUsers (MSSQL) | Id (GUID) | — | — | DROPPED | auth.users.id 대체 |
| AspNetUsers | Email | admin_users | email | DIRECT | + auth.users.email |
| AspNetUsers | PasswordHash | auth.users | encrypted_password | TRANSFORM | 동일 (재해시) |
| AspNetUsers | LockoutEnd/LockoutEnabled | — | — | DROPPED | Supabase Auth 자체 lockout 메커니즘 |
| AspNetRoles | Name (admin/a000../m000..) | admin_users.role + (future) role_assignments | role | TRANSFORM | 운영진 분류 — 별도 role catalog 필요 |

### 1-L. SNS 이력/추적 — **미매핑**

| Olympus Table | Olympus Column | Vraxium Table | Vraxium Column | Status | Notes |
|---|---|---|---|---|---|
| snsidchangelogs | OldNaver*/NewNaver* etc | — | — | NEW | sns_id_history 신설 |
| trackinglinks | UserId, Link, State, IsDone | — | — | NEW | naver_cafe 호응 trackinglinks 신설 |
| navercafedatas | (공용) | — | — | NEW | 공용 호응 풀 |
| qnaboards / qnacomments | (1:1 문의) | — | — | NEW | 별 도메인 |
| boards / comments | (게시판) | — | — | NEW | 별 도메인 |

### 1-M. 체크리스트 — **미매핑**

| Olympus Table | Olympus Column | Vraxium Table | Vraxium Column | Status | Notes |
|---|---|---|---|---|---|
| newbiechecklists | UserId, 11 boolean checks, Star | — | — | NEW | newbie_checklists 신설 (Week≤3 한정) |
| userschecklists | UserId, CheckListId, IsChecked | — | — | NEW | user_checklist_items 신설 |
| crewchecklists | (마스터) | — | — | NEW | checklist_catalog 신설 |

---

## 2. 부록

### 2-1. Cluster1 매핑 현황 (사용자 정체성·소속·인적 정보·로그인)

**✅ 매핑 완료**
- users.{Name, BirthDay, Gender, School, Major, Address, Contact, mail} → user_profiles
- usersinfo.{Team, Part, Level, State} → user_memberships + user_profiles.status
- userspoint.{Star, Shield} → user_cumulative_points
- members + AspNetUsers → applicants + admin_users + auth.users

**⚠️ 부분 매핑**
- usersinfo.UserRole (자유 text "admin") → admin_users.role enum (`owner`/`admin`/`viewer`) — 운영진 분류 손실
- usersinfo.TeamRole ("팀장") → **현재 매핑 없음**, role_assignments 신설 필요
- usersinfo.StartDate → user_memberships 에 joined_at/created_at 컬럼 부재
- usersmoreinfo.{Title, Info} 1:N → user_profiles.vision 1:1 (1차 압축), 다중 메모 손실

**🔴 전체 미매핑**
- **useraccounts (SNS ID 7종)** — Vraxium 측 user_social_accounts 테이블 부재 → autoscrap 카페 호응 시스템 작동 불가
- usersinfo.Week → user_growth_stats 에 매핑되지만 migration 없음 (live DB only)

---

### 2-2. Cluster2 매핑 현황 (이력서·자기소개·외부링크·리뷰)

**Olympus → Vraxium Cluster2 매핑은 거의 없음** (Cluster2 는 Vraxium 신규 영역).

**관련성 일부**
- usersmoreinfo.Info → user_cluster2.{growth_story, social_experience, career_direction, work_style, personal_story} 중 하나로 매핑 가능 (수동 분류)
- 졸업 essaylinks → user_cluster2 자기소개 5포인트 또는 별도 graduation_essays

**Vraxium 신규 (Olympus 없음)**
- user_resume_card_settings (hexagon_link_1/2/3, medal_week_override, help_tooltip_text)
- organization_resume_card_settings (medal_theme, notice_top)
- site_resume_card_settings (singleton)
- user_review_links (10개 weekly slots @ week 3,6,9,12,15,18,21,24,27,30)
- user_edit_windows (resource_key 기반 권한)
- user_cluster2 photos/videos/intros
- user_introductions (slogan 3종 × tag × rating)
- user_educations (1:N 교육 이력)

---

### 2-3. Cluster3 매핑 현황 (peer-review / weekly_reviews)

> Vraxium-admin 의 Cluster3 = 포트폴리오 카드 (별도 앱). 사용자가 요청한 "peer-review·동료 평가"는 실제로는 **Cluster4 도메인**으로 분류되어 있음.

**Olympus → Vraxium 매핑은 없음** (peer-review 는 Olympus 에 부재).

**Vraxium 신규**
- reputation_keywords (100개 키워드 × 5 cluster × cluster_color)
- weekly_reputations (reviewer→target 주차 평가, rating 0-10 half-step)
- season_reputations (시즌 평가, rating 1-10 half-step, keyword_1/2/3)

---

### 2-4. Cluster4 매핑 현황 (활동·커리어·시즌·주차)

**✅ 매핑 가능**
- useractivities.{Star, Activity, Season, SeasonWeek} → user_activity_details.{rating, sub_title+growth_point, week_id (via weeks→seasons)}
- useractivities.activity 분류 → activity_types 마스터로 정규화

**⚠️ 부분 매핑**
- useractivities.IsActive → user_activity_details 에 is_approved 컬럼 없음 (rating IS NULL 로 표현 가능하지만 모호)
- useractivities.Reason (미인정 사유) → 컬럼 없음
- useractivities.UserLevel/Team/Part (snapshot) → user_memberships history 활용 필요

**🔴 전체 미매핑**
- **pointlogs (67k rows)** — point_ledger 테이블 부재. user_cumulative_points 만 있고 ledger 없어 거래 이력 / 미인정 사유 / 잔액 검증 불가
- userselectedteams (시즌 팀 선택)
- weekly_reviews / weekly_colleagues 는 Vraxium 신규 (Olympus 없음)

**Vraxium 신규**
- career_projects (관리자 정의 프로젝트 마스터)
- career_project_weeks (project × week junction)
- career_records (user × project × week 기록 + grade S/A/B/C/D + enhancement_status)
- weekly_reviews (1-10 self-rating + 1-200 char content)
- weekly_colleagues (rank 1-3, message ≤200)
- activity_types (4-grid 분류 마스터)

---

### 2-5. 아직 Supabase에 없는 Olympus 데이터 (이관 위한 신규 테이블 필요)

🔴 **Critical (사용자 운영 기능 직결)**
1. **user_social_accounts** — Naver*/Youtube/Insta/Tstory 7컬럼 (autoscrap 카페 호응 시스템 의존)
2. **point_ledger** — pointlogs 67k rows 이관처. user_cumulative_points 잔액 검증 키
3. **user_rest_periods / user_rest_history** — restdates / restlogs / seasonrestlogs (휴식 관리)
4. **user_status_history** — stopuserlogs / restchangelogs (활동정지 사유 이력)
5. **season_team_choices** — userselectedteams (시즌 팀 선택 워크플로우)

🟡 **Important**
6. **user_role_assignments** — usersinfo.UserRole + TeamRole (운영진/팀장 자유 text 정규화)
7. **graduation_workflows** + **graduation_essays** — graduateusers 7-boolean state machine + essaylinks
8. **newbie_checklists** + **user_checklist_items** — newbiechecklists + userschecklists
9. **user_notes** — usersmoreinfo 1:N 자유 메모 (vision 단일 필드로는 손실)
10. **sns_id_history** + **tracking_links** + **naver_cafe_pool** — snsidchangelogs + trackinglinks + navercafedatas

🟢 **Nice-to-have (low priority)**
11. **qna_threads** / **community_posts** — qnaboards / boards (별 도메인이라 마이그레이션 우선순위 낮음)

---

### 2-6. Olympus에는 없지만 Vraxium에 새로 생긴 데이터

**이력서·포트폴리오 신규**
- user_resume_card_settings (hexagon_link_1/2/3, medal_week_override, help_tooltip_text)
- organization_resume_card_settings (medal_theme: OK/EC/PX, notice_top_text/stamp)
- site_resume_card_settings (singleton, notice_bottom, help_tooltip_default)
- user_cluster2 (main/sub_photo_1~4, video_url_1/2/3, growth_story/social_experience/career_direction/work_style/personal_story)
- user_introductions (slogan_1/2/3 × tag(8 enum) × rating(0-10))
- user_educations (1:N education_level/status/major_category/major_name_1/2/3/admission~graduation/grade)
- user_review_links (10 weekly slots)
- user_edit_windows (resource_key 기반 권한 윈도우)

**Peer Review 신규**
- reputation_keywords (5 cluster × 100 키워드 × cluster_color)
- weekly_reputations (reviewer→target rating 0-10 half-step + content 100자 + keyword)
- season_reputations (시즌 rating 1-10 + content 300자 + keyword_1/2/3 distinct)

**Cluster4 활동 신규**
- activity_types (cluster_id: practical_competency/experience/career + eligibility_min/max_weeks + count_once_in_total)
- user_activity_details (output_links jsonb, image_urls[]/captions[], growth_image)
- career_projects (company_name/logo/job_position/project_name/supervisor_*)
- career_project_weeks (project × week junction)
- career_records (grade S/A/B/C/D + enhancement_status + grade_points)
- weekly_reviews (self-review)
- weekly_colleagues (rank 1-3 동료 nomination)

**인증/조직 신규**
- organizations (organization_slug 정규화)
- admin_users (운영진 전용 테이블 분리)
- applicants (kakao login flow 진입점)
- user_growth_stats (cumulative_weeks/approved_weeks)
- user_cumulative_points (Olympus 의 userspoint 와 1:1 이지만 total_lightnings 추가)
- weeks / seasons (시간 차원 정규화)
- user_season_histories (시즌별 사용자 종합 rating)
- schools (외부 sync source/source_id unique)
- permissions / role_permissions / role_permissions_audit (권한 매트릭스)

---

### 2-7. 30명 더미 생성 시 반드시 채워야 하는 필드

> RegistConfirm.razor:200~272 실insert 흐름 + Vraxium NOT NULL/CHECK 제약 통과 기준.

**테이블 #1: `user_profiles` (필수 30 row)**

| 컬럼 | 필수 이유 | 더미 값 |
|---|---|---|
| user_id (uuid) | PK | gen_random_uuid() |
| legacy_user_id (bigint) | Olympus 매핑 키 | 1001..1030 |
| display_name | UI 모든 화면 | "테스트크루01"~30 |
| birth_date | UI 헤더 표시 | "2001-01-01" 등 ISO |
| gender | UI 표시 | 남/여 균등 |
| school_name | UI 표시 | "ㅇㅇ대" |
| department_name | UI 표시 | "경영학과" |
| address | UI 표시 (live DB only) | "서울시 성북구" |
| contact_phone | unique 필요 | 010-9000-0001..30 |
| contact_email | UI 표시 | pms.dummy01..30@gmail.com |
| auth_email | UNIQUE lower(index) | 동일, lowercase |
| organization_slug | FK organizations | "encre"/"oranke"/"phalanx" 분배 |
| status | enum | active 25, weekly_rest 2, graduated 2, suspended 1 |
| created_at / updated_at | DEFAULT now() | 자동 |

**테이블 #2: `user_memberships` (필수 30 row)**

| 컬럼 | 필수 이유 | 더미 값 |
|---|---|---|
| user_id | FK | user_profiles.user_id |
| team_name | UI 표시 | 브랜딩/기획/미디어/신입 분배 |
| part_name | UI 표시 | 일반/심화/신입/admin |
| membership_level | UI 표시 | 일반 22, 심화 6, 운영진 2 |
| membership_state | UI 표시 | status 와 동일 분포 |
| is_current | 현재 시즌 식별 | true |

**테이블 #3: `user_cumulative_points` (필수 30 row)**

| 컬럼 | 필수 이유 | 더미 값 |
|---|---|---|
| user_id | FK | user_profiles.user_id |
| total_stars | UI 표시 | 0~120 random |
| total_shields | Olympus default | **5** (Shield 기본값 — UserPoint.cs:11) |
| total_lightnings | Vraxium 신규 | 0~10 random |

**테이블 #4: `user_growth_stats` (필수 30 row, live DB only)**

| 컬럼 | 필수 이유 | 더미 값 |
|---|---|---|
| user_id | FK | user_profiles.user_id |
| cumulative_weeks | UI 표시 | 0~12 random |
| approved_weeks | UI 표시 | cumulative_weeks 와 ≤ |

**테이블 #5: `applicants` (운영진 + 신규 가입 link, 필수 ≥30)**

| 컬럼 | 필수 이유 | 더미 값 |
|---|---|---|
| email | UNIQUE(lower(email), provider) | user_profiles.contact_email 와 일치 |
| provider | NOT NULL | "kakao" |
| status | CHECK | "approved" (30명 모두 가입 승인 완료) |
| linked_user_id | FK user_profiles | 매핑됨 |

**테이블 #6: `admin_users` (운영진 1~3명만)**

| 컬럼 | 필수 이유 | 더미 값 |
|---|---|---|
| id (uuid) | = auth.users.id | gen_random_uuid() |
| email | UNIQUE | admin01@vraxium.test |
| role | CHECK | 'owner'/'admin' |
| is_active | NOT NULL | true |

**테이블 #7: `auth.users` (Supabase Auth, 30 row)**
- email = user_profiles.auth_email
- encrypted_password = Supabase Auth 자체 생성 (비밀번호 재설정 토큰 권장)

---

## 3. 더미 생성 전 미해결 결정사항 (Open Questions)

| # | 결정사항 | 영향 | 권장안 |
|---|---|---|---|
| 1 | user_social_accounts 신설 여부 | 미신설 시 더미에 SNS 데이터 누락 → autoscrap 테스트 불가 | 신설 권장 (Critical) |
| 2 | point_ledger 신설 여부 | 미신설 시 user_cumulative_points 잔액만 들어가고 거래 이력 부재 | 신설 권장 (Critical) |
| 3 | birth_date 포맷 변환 | Olympus "220926" → "2022-09-26" 시 세기 가정 (19xx vs 20xx) | 30살 기준 분기 (96 → 1996, 03 → 2003) |
| 4 | TeamRole "팀장" 매핑처 | 운영진/팀장 분류 손실 | user_memberships.role 컬럼 추가 또는 별도 role_assignments |
| 5 | mail/Contact unique 강제 위치 | Olympus 측만 unique, Vraxium 측 인덱스 없음 | Vraxium 측에도 unique index 추가 |
| 6 | 운영진 1~2명 더미 admin_users.role | 권한 분리 명확화 | owner 1명 + admin 2명 |
| 7 | organization_slug 분배 정책 | 더미 사용자 클럽 소속 | encre/oranke/phalanx 균등 (10+10+10) |

---

## 4. 핵심 발견 요약

1. **Cluster1**: 인적 마스터·멤버십·잔액·인증은 대부분 매핑 완료. **useraccounts(SNS 7컬럼) 전체 미매핑 — autoscrap 카페 호응 시스템 작동 불가**.

2. **Cluster2**: Vraxium 신규 영역으로, Olympus 와 거의 1:0. usersmoreinfo.Info 만 user_cluster2 자기소개 5포인트로 부분 흡수 가능.

3. **Cluster3 (포트폴리오 카드)**: vraxium-admin 코드베이스의 Cluster3 정의가 사용자 요청과 다름. **peer-review/weekly_reviews 는 Cluster4 영역으로 분류됨**.

4. **Cluster4**: useractivities → user_activity_details 매핑은 양호하나 **IsActive/Reason 컬럼 부재**, **pointlogs 67k rows 이관처(point_ledger) 전체 부재**.

5. **신설 필요 테이블 5개 Critical**: user_social_accounts · point_ledger · user_rest_* · user_status_history · season_team_choices.

6. **30명 더미 최소 7 테이블 row 생성**: user_profiles + user_memberships + user_cumulative_points + user_growth_stats + applicants + admin_users(일부) + auth.users.

7. **미해결 결정사항 7건** — 더미 데이터 생성 전 스키마 추가 여부 / 변환 룰 / unique 정책 확정 필요.
