# pms-migration(MySQL) → Vraxium(Supabase) 데이터 마이그레이션 매핑 분석

> **작성일**: 2026-06-05
> **성격**: 분석/설계 전용 — 실데이터 이관 없음
> **소스 기준**
> - pms-migration(Olympus MySQL): `claudedocs/olympus-vraxium-field-mapping-matrix-20260522.md` 의 컬럼 수준 분석 (단, 본 문서에서 Vraxium 측은 전면 갱신)
> - Vraxium: **2026-06-05 라이브 스키마** (`claudedocs/live-schema-dump-20260605.json`, PostgREST OpenAPI 직조회 — 문서 아님). 61개 public 테이블/뷰.
> - 레거시 수용 계약: v17 통합 라인(`a5196b5`), v18 check 게이트(`d935d76`) + `db/migrations/2026-06-05_user_weekly_points_checks_migrated.sql`
>
> **05-22 매트릭스 대비 핵심 변경 (반드시 인지)**
> 1. `user_cumulative_points` 컬럼 개편: ~~total_stars/total_shields/total_lightnings~~ → **total_checks / total_advantages / total_penalties / total_raw_advantages** (구버전은 `_backup_cumulative_points_20260528`). 또한 이 테이블은 **dead cache** — 누적 포인트 SoT 는 `user_weekly_points` 직접 합산.
> 2. **v17 레거시 통합 라인**: 2026 여름 W1(06-29) 이전 전체 주차는 `[통합] 주차 활동 내역` 1라인으로 표현 (`cluster4_lines`+`cluster4_line_targets`+`cluster4_experience_line_evaluations`). 평점 4↑=강화 성공.
> 3. **v18 check 게이트**: 레거시 주차 성공 = 평점 4↑ **AND** `user_weekly_points.points`(=point.check) >= `weeks.check_threshold`(기본 30). enforce 는 `user_weekly_points.checks_migrated=true` 행에만. **이관 파이프라인 의무: 행 기록 시 checks_migrated=true, check 0건이어도 행 기록.**
> 4. 주차 SoT 체인: `user_week_statuses`(uws, 원본) → `user_growth_stats`(파생 캐시, **uws writer 는 recalcUserGrowthStats 필수, 전환주차 제외**) → weekly-cards snapshot (조회 전용 캐시).

표기: ✅ 바로 이관 / 🔄 값 변환 후 이관 / 🧮 신규 계산 필요 / ⛔ 이관 제외 / ❌ 대응 컬럼 없음 / 🆕 신규 스키마 추가 필요 / ❓ pms 컬럼 스키마 미확보(검증 필요)

---

## 1. 매핑 매트릭스

### 1-A. 사용자 — `users` (인적 마스터)

| pms 컬럼 | 의미 | Vraxium 테이블 | Vraxium 컬럼 | 판정 | 주의사항 |
|---|---|---|---|---|---|
| UserId (int PK) | 레거시 사용자 키 | users | legacy_user_id (bigint, NOT NULL) | 🔄 | int→bigint. **테스터 90명의 test_user_markers.legacy_user_id 와 충돌 검사 필수**. 신규 채번 시퀀스(100,000,000+)와 분리 |
| UserId | 〃 | users / user_profiles | id / user_id (uuid 신규 채번) | 🧮 | gen_random_uuid(). users 행이 곧 bridge — 별도 매핑 테이블 불필요 (§3) |
| Name | 이름 | user_profiles | display_name (NOT NULL) | ✅ | 관리자 표시 이름 SoT 이기도 함 (`/api/admin/me`) |
| BirthDay ("220926") | 생년월일 | user_profiles | birth_date (**date 타입**) | 🔄 | "YYMMDD"→ISO date. 세기 분기 규칙 필요(예: ≥30 → 19xx). live 타입이 text 아닌 date 임에 주의 |
| Gender ('남'/'여') | 성별 | user_profiles | gender (text) | ✅ | enum 제약 없음 |
| School | 학교 | user_profiles + user_educations | school_name / (school_name, is_primary) | 🔄 | profiles 단일값 + educations 1:N 양쪽. `schools` 마스터와 매칭은 선택사항 |
| Major | 전공 | user_profiles + user_educations | department_name / major_name_1 | 🔄 | 〃 |
| Address | 주소 | user_profiles | address | ✅ | |
| Contact | 연락처 | user_profiles | contact_phone | ✅ | Vraxium 측 unique 인덱스 없음 — 이관 전 pms 측 중복 검사 |
| mail | 이메일 | user_profiles | contact_email | ✅ | 표시용 |
| mail | 〃 | user_profiles | auth_email | 🔄 | lowercase. Google OAuth 는 **email 병합 금지·(provider+sub) 키** 정책 — auth_email 은 참고 필드일 뿐 인증 키 아님 |
| — | 영문명 | user_profiles | english_name | ❌(역방향) | pms 에 없음. NULL 유지 ("-" 표시) |

### 1-B. 사용자 — `usersinfo` (멤버십/상태)

| pms 컬럼 | 의미 | Vraxium 테이블 | Vraxium 컬럼 | 판정 | 주의사항 |
|---|---|---|---|---|---|
| Team | 현재 팀 | user_memberships | team_name (is_current=true 행) | ✅ | membership resolver 는 team_name 보유 우선 규칙 — 빈 문자열 대신 NULL |
| Part | 현재 파트 | user_memberships | part_name | ✅ | 〃 |
| Level (일반/심화/운영진) | 등급 | user_memberships | membership_level | ✅ | **badge 등급 SoT**. membership_state 와 혼동 금지 |
| State (일반/활동정지/졸업/운영진) | 활동 상태 | user_profiles.status + user_memberships.membership_state | status | 🔄 | enum 변환: 일반→active, 활동정지→suspended, 졸업→graduated. growth_status 별도 (졸업상태는 growth_status 가 프론트 판정) |
| Week (누적주차) | 누적 인정 주차 | user_growth_stats | cumulative_weeks | 🧮 | **직이관 금지 권장** — Vraxium 은 uws 에서 재계산(전환주차 제외, v16). pms Week 값은 검증 기준값으로만 사용 (§7) |
| StartDate | 가입/활동 시작일 | user_profiles | activity_started_at | 🔄 | live 에 존재 (05-22 문서의 "컬럼 없음"은 해소됨). timestamptz 변환 |
| UserRole ('admin') | 운영진 플래그 | admin_users.role + user_profiles.role | role | 🔄 | 운영진만 admin_users 행 생성. user_profiles.role 도 존재 |
| TeamRole ('팀장') | 팀 내 역할 | user_profiles | role | 🔄 | live user_profiles.role 활용 가능. 단 상태 표기 SoT 는 membership_level — **role 단독 "파트장" 표기 금지** 정책 준수 |
| InfoID | identity | — | — | ⛔ | |

### 1-C. 포인트 — `userspoint` (잔액)

| pms 컬럼 | 의미 | Vraxium 테이블 | Vraxium 컬럼 | 판정 | 주의사항 |
|---|---|---|---|---|---|
| Star | 체크(주차활동 체크) 누계 | user_cumulative_points | total_checks | 🔄 | **잔액 직이관은 보조** — 정본은 pointlogs 주차 분해(§1-D). 이관 후 합산 일치 검증(§6) |
| Shield | 방패(가점) 누계 | user_cumulative_points | total_advantages (+ total_raw_advantages) | 🔄 | 표시 정책: 방패=net. raw/net 구분 — pointlogs 부호 분해로 raw 가점·차감 분리 필요 |
| (Shield 음수분/차감) | 감점 | user_cumulative_points | total_penalties | 🧮 | pms 는 signed Shield 단일 — 음수 델타 합 → penalties (번개=−n 표시) |
| PointId | identity | — | — | ⛔ | |

> ⚠️ `user_cumulative_points` 는 **sync 트리거 dead 인 캐시**. 이력서 누적포인트는 `user_weekly_points` 전기간 직접 합산. 따라서 **잔액만 이관하면 화면에 반영되지 않는다** — 주차 분해 이관(§1-D)이 필수 경로.

### 1-D. 포인트 — `pointlogs` (원장, ~67k rows) — 이관의 중심

| pms 컬럼 | 의미 | Vraxium 테이블 | Vraxium 컬럼 | 판정 | 주의사항 |
|---|---|---|---|---|---|
| UserID + log("2026봄 3주차") + Star | 주차별 check 델타 | **user_weekly_points** | (user_id, year, week_number, week_start_date, **points**) | 🧮 | **주차 단위 집계 변환**. log 텍스트 → (season_key, week_number) 파싱 → weeks 행 매칭. v18 계약: **행 기록 시 checks_migrated=true 필수, 0건 주차도 행 기록** |
| 〃 + Shield(+) | 주차별 가점 | user_weekly_points | advantages | 🧮 | 양수 델타 합 |
| 〃 + Shield(−) | 주차별 감점 | user_weekly_points | penalty | 🧮 | 음수 델타 절대값 합 |
| code (report/bonus/manual…) | 이벤트 유형 | — | — | 🆕 | 원장 보존처 없음 → `legacy_point_ledger` 신설 (집계 근거 추적/감사용). 집계만으로 충분하면 ⛔ 선택지 |
| info / etc | 사유/메모 | — | — | 🆕 | 〃 (jsonb) |
| ActivityTime / createtime | 발생/기록 시각 | — | — | 🆕 | 〃 |
| Creater | 기록자 | — | — | 🆕 | 〃 (admin 매핑 불가 시 text 보존) |
| IsDeleted / DeletedTime | 삭제 플래그 | — | — | ⛔(집계 시 제외) | **집계 시 IsDeleted=1 제외**. 원장 신설 시엔 voided_at 으로 보존 |
| IsHide | 숨김 | — | — | ⛔(또는 원장 보존) | 숨김≠삭제 — 집계 포함 여부 pms 운영 룰 확인 필요 ❓ |
| LogNum | identity | — | — | ⛔ | 원장 신설 시 source_log_num 으로 보존 권장 (멱등 키) |

### 1-E. 활동/결산 — `useractivities`

| pms 컬럼 | 의미 | Vraxium 테이블 | Vraxium 컬럼 | 판정 | 주의사항 |
|---|---|---|---|---|---|
| UserId + Season + SeasonWeek | 주차 귀속 | cluster4_line_targets | (week_id, target_user_id) — v17 [통합] 라인 | 🧮 | 레거시 주차는 **신규 라인 만들지 말고 [통합] 라인 1개의 타깃**으로. weeks 행 사전 존재 필요(§7) |
| Star (0~10) | 주차 평점 | cluster4_experience_line_evaluations | rating (smallint) | 🔄 | v17 판정: 4↑=강화 성공 / ≤3=실패. **당시 평점 그대로 보존 — 재산정 금지** |
| Activity (longtext) | 활동 내용 | cluster4_line_submissions | subtitle + growth_point (또는 output_links) | 🔄 | 자유 텍스트 분할. 손실 없는 보존은 growth_point 에 원문 전체 |
| IsActive (tinyint) | 주차 인정 여부 | **user_week_statuses** | status ('success'/'fail') | 🔄 | **uws 가 주차 SoT**. IsActive=1→success, 0→fail. 단 v18 read-time 게이트가 최종 판정 — uws 와 라인 평점·check 의 정합 필요(§7) |
| Reason | 미인정 사유 | user_week_statuses | note | 🔄 | uws.note 활용 가능 |
| UserWeek | 당시 누적주차 | — | — | ⛔(검증용) | 스냅샷 값 — 이관하지 않고 cumulative 재계산 검증 기준으로 사용 |
| UserLevel/Team/Part | **당시** 등급/팀/파트 스냅샷 | — | — | 🆕 | 현재값 재계산 절대 금지(§5). `legacy_week_snapshots` 신설 또는 원장 jsonb 보존 |
| StartDate/EndDate | 주차 기간 | weeks | started_at/ended_at (week_id FK 로 표현) | 🔄 | 직접 컬럼 없음 — weeks 매칭으로 흡수 |
| ActivityId | identity | — | — | ⛔ | 멱등 키로 원장 보존 권장 |

### 1-F. 활동/결산 — `manageractivities` / `managerdatas` / `reportlogs` ❓

| pms 테이블 | 추정 의미 | Vraxium 후보 | 판정 | 주의사항 |
|---|---|---|---|---|
| manageractivities | 운영진 주차 활동 | cluster4 [통합] 라인 (일반과 동일) | ❓→🧮 | **컬럼 스키마 미확보**. 운영진도 v17 정책상 동일 라인 구조 수용 가능. pms 덤프 확보 후 확정 |
| managerdatas | 운영진 결산 데이터 | — | ❓→❌ | 컬럼 미확보. 주차 결산 산출물이면 reportlogs 와 함께 원장 보존 검토 |
| reportlogs | 주차 결산 로그 | — | ❓→🆕 | 컬럼 미확보. pointlogs.code='report' 의 근거 데이터일 가능성 — check 집계 검증에 필요할 수 있어 **이관 제외 전 보존 권장** |

### 1-G. 주차/시즌 — `weekssettings` / `seasondates` 등

| pms 테이블 | 추정 의미 | Vraxium 테이블 | 판정 | 주의사항 |
|---|---|---|---|---|
| seasondates ❓ | 시즌 기간 정의 | seasons + season_definitions | 🔄 | **이중 체계 주의**: seasons(uuid)·season_definitions(season_key text) 모두 채워야 함. pms 과거 시즌이 live 에 없으면 행 추가 (스키마 추가는 아님) |
| weekssettings ❓ | 주차 정의/설정 | weeks | 🔄 | week_number, start_date/end_date, season_key, iso_year/iso_week 정합 필수. **레거시 주차의 weeks 행 존재가 모든 주차 이관의 선행 조건** |
| (check 기준값) | 주차별 체크 기준 | weeks.check_threshold | 🔄 | pms 에 주차별 기준값이 있으면 매핑(없으면 NULL=기본 30). 관리자 UI 존재 |
| seasonchangeusers ❓ | 시즌 전환/변경 신청 | user_season_statuses | ❓→🔄 | (user_id, season_key, status, note, requested_at) 구조가 수용 가능해 보이나 컬럼 미확보 |
| seasonrestlogs ❓ | 시즌 휴식 이력 | user_season_statuses | ❓→🔄 | 〃 (status='rest' 계열) |
| seasonteamdatas ❓ | 시즌별 팀 편성 | — (user_memberships 는 is_current 1행 체계) | ❓→🆕 | 시즌×팀 이력 보존처 없음. `user_season_teams` 신설 또는 user_memberships 비현재 행(is_current=false) 활용 — 후자는 시즌 키 컬럼이 없어 불완전 |

### 1-H. 휴식 — `restdates` / `restlogs` / `restchangelogs`

| pms 컬럼 | 의미 | Vraxium 테이블 | Vraxium 컬럼 | 판정 | 주의사항 |
|---|---|---|---|---|---|
| restdates (UserId, StartDate~EndDate) | 개인 휴식 기간 | user_week_statuses | status='personal_rest' (기간→주차 전개) | 🔄 | 기간을 주차 단위로 전개해 uws 행 생성. **공식 휴식과 혼동 금지** — 공식은 weeks.is_official_rest 단독 SoT, uws 파생 플래그 금지 |
| restdates.info | 사유 | user_week_statuses | note | 🔄 | |
| restlogs | 휴식 신청/처리 이력 | — | — | 🆕 | 이력 보존처 없음. `legacy_rest_history` 신설 또는 ⛔ |
| restchangelogs (OldValue/NewValue, Lightning) | 변경 이력 + 번개 차감 | user_weekly_points.penalty (Lightning 분) | — | 🔄+🆕 | **Lightning 차감분은 penalty 집계에 반영** (포인트 정합의 일부). 변경 이력 자체는 신설 또는 제외 |

### 1-I. 체크리스트 — `newbiechecklists` / `userschecklists`

| pms 테이블 | 의미 | Vraxium | 판정 | 주의사항 |
|---|---|---|---|---|
| newbiechecklists (11 boolean + Star) | 신입 체크리스트 | — | 🆕 또는 ⛔ | 대응 도메인 자체가 없음. Star 부여분은 pointlogs 에 이미 반영되어 있을 것 — **이중 계상 금지** (pointlogs 만 집계) |
| userschecklists (UserId, CheckListId, IsChecked) | 사용자 체크 항목 | — | 🆕 또는 ⛔ | 운영상 더 이상 사용하지 않으면 이관 제외 + 원본 아카이브 권장 |

### 1-J. 제출물 — `trackinglinks` / `essaylinks` / `userscurriculum` / `uploadedfiles` / `projectlist`

| pms 테이블 | 의미 | Vraxium 후보 | 판정 | 주의사항 |
|---|---|---|---|---|
| trackinglinks (UserId, Link, State, IsDone) | 카페 호응 추적 링크 | — | 🆕 또는 ⛔ | autoscrap 호응 시스템을 Vraxium 에서 재가동할 계획이 있을 때만 신설. 없으면 제외 |
| essaylinks (Link, ImageLink, Category) | 졸업 에세이 링크 | user_cluster2 (growth_story 등 5포인트) 부분 흡수 | 🔄(부분)+🆕 | 자동 매핑 불가(수동 분류). 전량 보존은 신설 필요 |
| userscurriculum ❓ | 커리큘럼 진행 | — | ❓→⛔ | 컬럼 미확보. Vraxium 커리큘럼 도메인 부재 |
| uploadedfiles ❓ | 업로드 파일 | (Supabase Storage) | ❓→🔄 | 컬럼 미확보. 파일 실체는 Storage 버킷 이전 + 참조 테이블 검토. cluster3 버킷 생성 전례 참고 |
| projectlist ❓ | 프로젝트 목록 | career_projects | ❓→🔄 | 컬럼 미확보. career_projects(회사/직무/프로젝트) 와 의미 일치 시 변환 이관 후보 |

### 1-K. 졸업/상태 이력 — `graduateusers` / `graduatelogs` / `stopuserlogs` / `snsidchangelogs`

| pms 테이블 | 의미 | Vraxium | 판정 | 주의사항 |
|---|---|---|---|---|
| graduateusers (State + 7 boolean) | 졸업 워크플로우 | user_profiles.status='graduated' + growth_status | 🔄(상태만) | 워크플로우 7-boolean 은 보존처 없음 → 🆕 `legacy_graduation_state` 또는 ⛔. **growth_status 가 프론트 졸업 표시 판정** — 졸업자는 양쪽 모두 설정 |
| graduatelogs ❓ | 졸업 처리 로그 | — | ❓→⛔ | 컬럼 미확보 |
| stopuserlogs (UserId, Info, StopDate) | 활동정지 이력 | user_profiles.status='suspended' (상태만) | 🔄(상태만)+🆕 | 이력은 보존처 없음. user_role_audit 는 role 전용이라 부적합 |
| snsidchangelogs | SNS ID 변경 이력 | — | ⛔ 또는 🆕 | useraccounts 본체(1-L) 결정에 종속 |

### 1-L. 인증/SNS — `members` / `useraccounts`

| pms 테이블 | 의미 | Vraxium | 판정 | 주의사항 |
|---|---|---|---|---|
| members.Email/UserId | 로그인 계정 | applicants(email, provider, linked_user_id) + auth_accounts | 🔄 | **Google OAuth 는 (provider+sub) 키** — 레거시 이메일 계정은 applicants 'approved' 로 만들어 최초 로그인 시 link. 비밀번호 해시는 ⛔ (재설정 플로우 강제, /auth/recovery) |
| members.Role | 운영진 | admin_users | 🔄 | 운영진만 |
| useraccounts (Naver*/Youtube/Insta/Tstory 7종) | SNS ID | — | 🆕 또는 ⛔ | Vraxium 에 SNS 계정 테이블 부재. 카페 크롤러(Phase1)가 향후 필요로 할 수 있어 **`user_social_accounts` 신설 권장** — 운영 결정 필요 |

---

## 2. 분류 요약

### 2-1. ✅ 바로 이관 가능
- users.{Name, Gender, Address, Contact, mail(표시용)} → user_profiles
- usersinfo.{Team, Part, Level} → user_memberships (is_current=true)

### 2-2. 🔄 값 변환 후 이관 가능
- users.UserId → users.legacy_user_id (int→bigint, 충돌 검사)
- users.BirthDay → birth_date (YYMMDD→date, 세기 분기)
- users.School/Major → user_profiles + user_educations (1:N 분리)
- usersinfo.State → status enum / StartDate → activity_started_at
- useractivities.Star → [통합] 라인 evaluations.rating / IsActive → uws.status / Reason → uws.note
- restdates 기간 → uws status='personal_rest' 주차 전개
- restchangelogs.Lightning → user_weekly_points.penalty 반영
- seasondates/weekssettings → seasons+season_definitions / weeks 행 백필
- members → applicants(approved)+admin_users
- graduateusers/stopuserlogs → user_profiles.status (상태값만)

### 2-3. 🧮 신규 계산 필요
- **pointlogs → user_weekly_points 주차 집계** (points=check Σ, advantages=Shield+Σ, penalty=|Shield−|Σ+Lightning; IsDeleted 제외; **checks_migrated=true 의무, 0건 주차도 행 기록**)
- userspoint → user_cumulative_points (주차 집계의 재합산으로 생성 — 직이관 아님)
- useractivities → cluster4 [통합] 라인 타깃 생성 (라인 1개 재사용, 주차×사용자 타깃)
- user_growth_stats.{cumulative_weeks, approved_weeks} — uws 적재 후 recalcUserGrowthStats (전환주차 제외). pms usersinfo.Week/UserWeek 는 검증 기준값
- weekly-cards snapshot 전량 재계산 (이관 마지막 단계, recomputeWeeklyCardsSnapshotsForUsers)

### 2-4. ⛔ 이관 제외
- 모든 identity PK (InfoID, PointId, LogNum, ActivityId, MoreId, AccountNum)
- members.Password 해시 (재설정 플로우 대체)
- pointlogs IsDeleted=1 행 (집계 제외; 원장 신설 시 voided 보존)
- useractivities.UserWeek (검증용으로만)
- (운영 결정 시) userscurriculum, qna/board 류, trackinglinks

### 2-5. ❌ 대응 컬럼 없음 / 🆕 신규 스키마 추가 필요
| 우선순위 | 신설 후보 | 수용 데이터 | 비고 |
|---|---|---|---|
| 권장 | `legacy_point_ledger` | pointlogs 원장 67k (code/info/시각/Creater/voided) | 집계 근거 추적·감사·재검증 키. **집계만 이관하면 원장 분실** |
| 권장 | `legacy_week_snapshots` (또는 ledger jsonb) | useractivities.UserLevel/Team/Part 당시 스냅샷 | §5 — 재계산 불가능 데이터 |
| 결정 필요 | `user_social_accounts` | useraccounts 7종 + snsidchangelogs | 카페 크롤러 연동 계획에 종속 |
| 결정 필요 | `user_season_teams` | seasonteamdatas (시즌×팀 이력) | user_memberships 는 시즌 차원 없음 |
| 낮음 | `legacy_graduation_state` / `legacy_rest_history` / checklist 류 | graduateusers 7-bool, restlogs, checklists | 화면 소비처 없으면 원본 아카이브로 충분 |

---

## 3. UserId 매핑 전략 검토

**결론: `users.legacy_user_id` 단일 전략 적절 — 별도 매핑 테이블 불필요.**

- `users` 가 (id uuid PK, legacy_user_id bigint NOT NULL) 구조라 그 자체가 bridge 테이블. pms UserId(int) 를 그대로 기록하면 양방향 조회 가능.
- UUID 는 `gen_random_uuid()` 신규 채번. 결정적 UUID(예: uuid_v5(namespace, UserId))도 가능하나, 멱등성은 "legacy_user_id 존재 시 skip/update" upsert 로 충분히 확보되므로 필수 아님.
- **선행 검증 3건**:
  1. `legacy_user_id` UNIQUE 제약/인덱스 존재 여부 확인 (OpenAPI 로는 불가 — SQL Editor 확인 필요). 없으면 이관 전 unique index 추가.
  2. **충돌 도메인**: 시드 테스터 90명(`test_user_markers.legacy_user_id`)과 기존 실사용자 122명의 legacy_user_id 점유 현황 조회 → pms UserId 범위와 교집합 검사. 교집합 발견 시: (a) 동일 인물이면 기존 uuid 재사용(프로필 병합), (b) 다른 인물이면 이관 중단 후 정책 결정.
  3. 신규 가입 시퀀스(100,000,000+)와 pms UserId(작은 int) 는 범위가 분리되어 안전.
- **이미 Vraxium 에 존재하는 실사용자(122명)와 pms 사용자의 동일인 매칭**이 실질 난점: 이름+생년월일+연락처 3중 키로 후보 매칭 → 수동 확정 리스트 작성 → 동일인은 기존 uuid 에 레거시 데이터를 귀속 (legacy_user_id 갱신), 신규 인물만 uuid 채번.
- `legacy_crew_import` 스테이징 테이블이 이미 존재 (legacy_user_id, display_name, …, cumulative_weeks) — **1차 랜딩 존으로 재사용** 권장: pms→legacy_crew_import 적재 → 검증 → 본 테이블 전개의 2단 구조.

---

## 4. 사용자 1명 완전 재현 가능성

| 영역 | 재현 수준 | 경로 | 비고 |
|---|---|---|---|
| 현재 프로필 | **~100%** | users + user_profiles (+ user_educations) | english_name/profile_keyword/tagline 은 pms 에 없음 → "-" |
| 현재 팀/파트 | **100%** | user_memberships (is_current) | |
| 과거 시즌별 팀/파트 | **0~부분** | 보존처 없음 (🆕 필요) | seasonteamdatas + useractivities 스냅샷이 원천 |
| 주차 이력 (성공/실패/휴식) | **~95%** | uws + weeks 백필 + v17 [통합] 라인 | 전제: 과거 weeks/seasons 행 백필. 전환주차·공식휴식 규칙은 read-time 자동 |
| 주차 평점/활동 내용 | **~90%** | [통합] 라인 evaluations.rating + submissions | Activity 원문 보존 가능, 구조화(서브타이틀/성장포인트 분리)는 수작업 품질 |
| 포인트 (주차별) | **~100%** | user_weekly_points (pointlogs 집계) | log 텍스트의 주차 파싱 실패율이 변수 — 실패분은 별도 큐 |
| 포인트 (누적) | **100%** | user_weekly_points Σ (= 이력서 SoT) | userspoint 잔액과 대사(§6) |
| 활동(라인 단위 세부) | **부분** | [통합] 1라인으로 합산 표현 | v17 정책상 의도된 단순화 — 라인별 분해는 정책상 하지 않음 |
| 제출물 | **낮음** | essaylinks 일부 수동 흡수 | uploadedfiles 는 Storage 이전 설계 필요 |
| 상태 이력 (정지/졸업/휴식 로그) | **상태값만** | user_profiles.status/growth_status | 시점·사유 이력은 🆕 없이는 소실 |
| 체크리스트/SNS/커리큘럼 | **0%** | 대응 없음 | 운영 결정 대상 |

**종합: "허브/카드 화면에서 보이는 것"(프로필·주차·포인트·평점) 은 거의 완전 재현 가능. "관리 이력"(상태 변경 로그·시즌별 팀·워크플로우) 은 신규 스키마 없이는 상태값 수준으로 축약.**

스냅샷-only 조회 구조는 그대로 유지된다: 이관은 전부 **원장(uws/uwp/라인) 쓰기 → snapshot 일괄 재계산** 순서이며, 일반/demoUserId 경로는 동일 snapshot DTO 를 읽으므로 경로 분기 없음.

---

## 5. 스냅샷(비정규화) 데이터 처리 전략

**원칙: "당시 값"은 이관 시점에 원형 보존하고, 현재값으로의 재계산은 금지.**

| 데이터 | 성격 | 처리 |
|---|---|---|
| useractivities.UserName | 당시 이름 | 현재 display_name 으로 대체 **금지**. 단 이름 변경 사례가 없다면 실익 작음 — 원장 jsonb 보존으로 충분 |
| useractivities.UserTeam/UserPart | **당시** 팀/파트 | 재계산 절대 금지 (시즌마다 변동). `legacy_week_snapshots`(user_id, week_id, team, part, level, name) 신설 또는 legacy_point_ledger.metadata jsonb 에 동봉 |
| useractivities.UserLevel | 당시 등급 | 〃 |
| useractivities.UserWeek | 당시 누적주차 | 이관 제외, 재계산 검증 기준값으로만 |
| pointlogs.log("2026봄 3주차") | 당시 주차 라벨 | 파싱 키로 사용 후 원장에 원문 보존. **period_label 정규표기("{YY} {시즌명} {N}주차")와 형식이 다름** — 변환 테이블 필요 |
| Vraxium weekly-cards snapshot | 파생 캐시 | **보존처가 아님** — 절대 직접 쓰지 않는다. 원장 적재 후 재계산으로만 갱신 |

구분 기준: **Vraxium snapshot(jsonb cards)은 "원장에서 언제든 재계산 가능한 것"만 담는다.** pms 비정규화 스냅샷은 원장이 없으면 재계산 불가능하므로 반드시 별도 원형 보존(신설 테이블 or jsonb) — snapshot 에 넣으면 다음 재계산 때 소실된다.

---

## 6. 포인트 정합성 검증 전략 (userspoint ↔ pointlogs)

**이관 전 (pms 내부 대사)**
1. 사용자×통화별: `Σ pointlogs.Star (IsDeleted=0)` vs `userspoint.Star`, Shield 동일. IsHide 포함/제외 두 버전 산출 → 어느 쪽이 잔액과 일치하는지로 **IsHide 의 집계 의미를 데이터로 역추정** (운영 룰 문서 부재 대비).
2. 불일치 사용자 리스트 → 원인 분류 (로그 유실/수기 잔액 수정/초기 잔액 seed). **pms 초기 잔액 seed 행 존재 여부 확인** — 없으면 (잔액 − Σ로그) 를 "보정 행"으로 원장에 명시 기록.
3. Shield 기본값 5 (UserPoint.cs) — 가입 시 로그 없이 잔액만 5 였다면 전 사용자 +5 systematic offset 으로 나타남. 보정 룰 확정.

**이관 중 (변환 검증)**
4. log 텍스트 → (season_key, week) 파싱 성공률 100% 목표. 실패 행은 이관 보류 큐로 분리 (silent drop 금지).
5. 주차 귀속 후: 사용자별 `Σ user_weekly_points.points` = `Σ pointlogs.Star(유효)` 재확인 (통화별 동일).

**이관 후 (Vraxium 내부 대사)**
6. `user_cumulative_points.total_checks` = `Σ user_weekly_points.points` (per user) — 캐시를 합산으로 생성했으므로 항등이어야 함.
7. 이력서/허브 화면값 (HTTP 검증 스크립트, 기존 verify-*-http 패턴) 과 pms 화면 캡처 대조 — 표시 정책(방패=net, 번개=−n) 반영 후 비교.
8. v18 게이트 영향 리포트: checks_migrated=true 적용 후 주차 판정이 뒤집힌 (user, week) 전수 목록 → §7 리스크 검토.

---

## 7. 주차/시즌 매핑 + approved_weeks ≤ cumulative_weeks 영향도

**매핑 가능성**
- `season` → seasons(uuid) + season_definitions(season_key). **이중 체계 모두 백필** — weeks.season_id 와 weeks.season_key 가 각각 다른 테이블을 참조. 과거 시즌(2026 봄 이전) 행 부재 시 추가가 모든 것의 선행 조건.
- `week` → weeks. (season_key, week_number) + start_date 매칭. iso_year/iso_week 채움. **period_label 정규표기는 weeks.season_key+week_number 에서 파생**되므로 weeks 만 정확하면 자동.
- `current_week` → 별도 컬럼 없음. Vraxium 은 날짜 기반 lazy 판정 — 이관 불필요 (⛔).
- `cumulative_weeks` → **직이관 금지**. uws 적재 → recalcUserGrowthStats 재계산 (v16: 전환주차 제외). pms usersinfo.Week 는 기대값.
- `approved_weeks` → 동일 재계산. 원천은 uws status='success'.

**approved ≤ cumulative 조건 영향도**
1. pms 기대값 자체 검증: `count(useractivities.IsActive=1)` ≤ `usersinfo.Week` 위반 사용자 사전 추출 (수기 Week 관리 시 위반 가능). 위반 시 uws 원장 기준으로 재계산값 채택, pms 값과 차이 리포트.
2. **전환주차 차이**: pms Week 가 전환주차를 포함해 셌다면 Vraxium 재계산값(전환 제외)이 체계적으로 작게 나옴 — "불일치=버그"가 아니라 정책 차이. 매핑 시 pms 주차 중 전환주차 식별 룰 먼저 확정.
3. **v18 게이트로 인한 approved 감소 리스크 (최대 영향)**: check 이관(checks_migrated=true) 시 read-time 판정이 "평점 4↑ AND check≥30" 으로 강화됨. pms 에서 인정(IsActive=1)이었지만 check<30 인 주차는 **fail 로 뒤집힌다**. 실제로 06-05 시드의 실사용자 read-only 감사에서 uws=success 인데 check<기준 인 주차가 이미 다수 검출됨 (`legacy-check-case-seed-20260605.json` realUserAudit). → 이관 전 결정 필요: (a) pms 인정 결과를 존중해 해당 주차 threshold 를 낮춰 기록, (b) check 데이터 자체를 보정, (c) 판정 변경을 수용. **권장: dry-run 1명 단계에서 뒤집힘 전수 리포트 후 정책 확정 — 기본은 (a) 또는 "pms IsActive 우선" (기존 데이터 의미 훼손 금지 원칙).**
4. uws 쓰기 시 recalc 누락은 "화면 간 주차 분기" 회귀 1순위 — 이관 스크립트에 recalcUserGrowthStats 호출을 구조적으로 강제.

---

## 8. Dry Run 계획

**공통 장치**: legacy_crew_import 스테이징 경유 · 결정적 멱등 upsert (소스 PK 기반) · 모든 쓰기 전 test/real 가드 · 단계별 JSON 리포트 (claudedocs) · 각 단계 종료 시 snapshot 재계산 대상 명시적 무효화.

### 단계 1 — 사용자 1명 (pms 데이터가 가장 풍부한 1명, 테스터 마커 부착)
- 적재: users/user_profiles/user_memberships → weeks·seasons 백필 → uws → user_weekly_points(checks_migrated=true) → [통합] 라인 타깃+평점 → recalc → snapshot 재계산
- 검증: ① 포인트 대사 §6-5/6 ② approved/cumulative = pms 기대값(±전환주차 차) ③ v18 뒤집힘 0건 또는 전수 설명 가능 ④ 허브/이력서/카드 화면 HTTP 검증 (snapshot 직독·demoUserId 경로 동일 확인) ⑤ 멱등성: 동일 스크립트 2회 실행 시 diff 0
- **이 단계에서 §7-3 정책(게이트 뒤집힘 처리) 확정**

### 단계 2 — 사용자 5명 (케이스 다양화: 졸업자/정지자/휴식 보유자/포인트 불일치자/운영진 각 1)
- 검증: 상태 enum 변환 전수 · personal_rest 주차 전개 정확성 · admin_users 분기 · 포인트 불일치 보정 룰 동작 · PostgREST 페이지네이션(order+range) 준수

### 단계 3 — 사용자 30명 (랜덤 표본 + 전체 시즌 커버)
- 검증: 집계 성능(스냅샷 재계산 시간) · log 파싱 실패율 측정(목표 <1%, 실패분 보류 큐) · 화면 스팟 체크 10명 · cumulative 분포 vs pms 분포 통계 비교 (평균/최대 동일성)
- 잔여 리스크 측정: 동일인 매칭 오류율 (기존 122명과 교차)

### 단계 4 — 전체 사용자
- 사전: 운영 공지 · `_backup_*` 패턴 백업 테이블 생성 (사례: _backup_cumulative_points_20260528) · 시드 테스터 90명 데이터와의 격리 재확인 (v17 테스터 재분포와 충돌 금지)
- 적재 후 검증: 전 사용자 포인트 항등식 일괄 · approved≤cumulative 전수 0 위반 · version_mismatch 일괄 수렴(ops) · 실사용자 化면 무작위 10명 검수 · 롤백 리허설 (백업 테이블 복원 경로 문서화)
- **롤백 단위**: checks_migrated 플래그가 행 단위이므로 user_weekly_points 는 플래그 false 복귀만으로 게이트 원복 가능 — 부분 롤백 용이

---

## 9. 주요 리스크 (요약)

| # | 리스크 | 심각도 | 완화 |
|---|---|---|---|
| 1 | **v18 check 게이트로 기존 인정 주차가 fail 로 뒤집힘** (실사용자 audit 에서 이미 후보 검출) | 높음 | dry-run 1명에서 전수 리포트 → threshold/우선순위 정책 확정 후 진행 |
| 2 | pms 컬럼 스키마 미확보 테이블 11종 (weekssettings, seasondates, manager*, reportlogs, season*, userscurriculum, uploadedfiles, projectlist, graduatelogs) | 높음 | **MySQL 덤프(SHOW CREATE TABLE) 확보 전까지 해당 매핑은 가설** — 본 분석의 1순위 후속 |
| 3 | pointlogs.log 텍스트 → 주차 파싱 실패 / pms 라벨↔Vraxium 주차 경계 불일치 | 중 | 파싱 사전 + 실패 보류 큐, silent drop 금지 |
| 4 | 잔액↔원장 불일치 (초기 seed/수기 수정/Shield 기본값 5) | 중 | §6 이관 전 대사, 보정 행 명시 기록 |
| 5 | 기존 122명 실사용자와 pms 사용자 동일인 매칭 오류 | 중 | 3중 키 후보 매칭 + 수동 확정, 단계 3에서 측정 |
| 6 | 전환주차 정책 차이로 cumulative 불일치 | 중 | 정책 차이로 분류, 검증식에 전환 제외 반영 |
| 7 | uws 쓰기 후 recalc/snapshot 재계산 누락 → 화면 간 분기 | 중 | 스크립트에 구조적 강제, 단계별 검증 |
| 8 | 시드 테스터 90명(legacy_user_id 점유·v17 재분포)과 충돌 | 중 | 교집합 사전 검사, test_user_markers 가드 |
| 9 | 과거 weeks/seasons 행 부재 (모든 주차 이관의 선행 조건) | 중 | 단계 1 전에 시간 차원 백필 먼저 |
| 10 | 마이그레이션 SQL 수동 적용 운영 (SQL Editor) — 신설 테이블 미적용 상태로 스크립트 실행 | 낮음 | "column does not exist"=미적용 신호 룰 준수, 스크립트에 사전 체크 |
