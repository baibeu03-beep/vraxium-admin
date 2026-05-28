# User Status SSOT 정리 설계서

**작성일**: 2026-05-28
**작성 범위**: `user_profiles.status` 의미 축소(=계정 활성도), `user_profiles.growth_status` SSOT 확정, Resume Card 컬럼 전환, 휴식 상태 저장/파생 결정, DB CHECK 도입, 단계적 적용 계획
**전제 (사용자 합의)**:
1. `user_profiles.growth_status` 는 성장 라이프사이클(7 enum)의 단일 SSOT 로 격상.
2. `user_profiles.status` 는 `'active' | 'inactive'` 두 값만 갖는 계정 활성도 컬럼으로 의미를 축소.
3. Resume Card 배지는 `status` 에서 `growth_status` 로 재배선 검토.
4. 본 문서는 **설계서** 이며, 코드/SQL 변경 없음.

선행 감사 문서:
- `claudedocs/user-status-domain-technical-mapping-audit-20260528.md` (이중 도메인·자동 전이 부재·휴식 정규화 깨짐 H-1~H-6)
- `claudedocs/source-of-truth-audit-20260528.md`
- `claudedocs/growth-domain-technical-mapping-audit-20260528.md`
- `claudedocs/season-domain-mapping-audit-20260528.md`

---

## 1. `status` → 계정 활성도 전용 영향 파일

### 1-A. 영향 분류 기준

| 분류 | 정의 |
|------|------|
| **유지(keep)** | 이미 `'active' | 'inactive'` 의미로만 동작. 본 리팩토링으로 코드 변경 불필요. |
| **삭제(remove)** | 성장 라이프사이클 미러 의미. growth_status 로 옮겨야 하며 `status` 참조 자체를 제거. |
| **재작성(rewrite)** | 한 호출 안에 두 의미가 섞임. 의도 분리 후 한쪽으로 분기. |

> 분류 원칙: "**계정 비활성화(=로그인 차단/숨김) 의도**" 와 "**성장 상태 라벨링 의도**" 중 어느 쪽인지 호출 컨텍스트로 판정한다.

### 1-B. 영역별 영향

#### `app/` (API 라우트)

| 파일:라인 | 현재 동작 | 분류 | 사유 |
|-----------|-----------|------|------|
| `app/api/admin/applicants/[id]/approve-new/route.ts:73-74` | INSERT 시 `status='active'` + `growth_status='active'` | **keep (`status`)** | applicant 승인 = 계정을 활성화시키는 의도. `status='active'` 는 이미 새 의미와 일치. `growth_status='active'` 도 그대로 유지. |
| `app/api/admin/applicants/[id]/approve-existing/route.ts:18,63` | `applicants.status`만 사용 (`'pending'/'approved'`) | **무관** | `user_profiles.status` 아님. 변경 없음. |
| `app/api/admin/app-users/route.ts:18-28` | `?status=` 쿼리 파라미터 검증에 `isAppUserStatus()` 사용 (현재 6종 enum) | **rewrite** | 필터링 자체는 계정 활성도 필터로 의미가 좁아진다. enum 을 새 2종으로 줄이거나, "Members" 뷰의 성장 필터로 이관. |
| `app/api/admin/crews/route.ts` (전체) | `user_profiles.status` 직접 읽기/쓰기 없음 (라인 130 의 `status` 는 HTTP code) | **무관** | 변경 없음. |
| `app/api/admin/crews/[legacy_user_id]/route.ts` (전체) | 동일하게 HTTP status 만 사용 | **무관** | 변경 없음. |
| `app/api/admin/user-profiles/[user_id]/organization/route.ts:11` | `select` 컬럼 목록에 `status` 포함 (조회 응답용) | **keep** | 컬럼명 자체는 유지되므로 select 는 그대로. (단, 응답 사용자가 성장 의미로 해석 중이라면 별도 검토 필요 — 현재 호출처 확인 시 응답은 organization 갱신 후 반환만 됨) |
| `app/auth/callback/route.ts:104,108` | `applicants.status='pending'` insert | **무관** | `user_profiles.status` 아님. 변경 없음. |

#### `lib/`

| 파일:라인 | 현재 동작 | 분류 | 사유 / 후속 작업 |
|-----------|-----------|------|----------------|
| `lib/adminAccountsData.ts:87-88` | `PROFILE_SELECT` 에 `status` 없음 — display 용으로 사용 안 함 | **keep (현상유지)** | 변경 없음. |
| `lib/adminAccountsData.ts:431` | `createAccount()` INSERT 시 `status: isActive ? 'active' : 'inactive'` | **keep** | 이미 새 의미와 정확히 일치. 가장 양호한 호출 지점. |
| `lib/adminAccountsData.ts:579` | `updateAccount()` 토글 시 `status = isActive ? 'active' : 'inactive'` | **keep** | 동일. |
| `lib/adminAccountsData.ts:432` | INSERT 시 `growth_status: "active"` | **keep** | 새 SSOT 와 일치. |
| `lib/adminAppUsersTypes.ts:5-12` | `APP_USER_STATUSES = ['active','weekly_rest','seasonal_rest','paused','graduated','suspended']` 6종 | **rewrite (필수)** | 이름은 그대로 두되 enum 의미가 두 개로 분리됨. 새 `APP_USER_STATUSES = ['active','inactive']`(계정 활성도) + 별도 `GROWTH_STATUSES`(성장)로 분리해야 한다. |
| `lib/adminAppUsersData.ts:31-40,81-83` | `select` 에 `status` 포함, `?status=` 필터를 `eq('status', ...)` 로 적용 | **rewrite** | "앱 사용자(가입 사용자) 뷰" 가 어떤 도메인을 필터링하느냐 결정 필요. 권장: 계정 활성도(`active|inactive`) 로 의미 고정 + 별개 화면에서 `growth_status` 필터 제공. |
| `lib/adminMembersData.ts:29-40` (`MEMBER_SELECT`) | `status`, `growth_status` 양 컬럼 SELECT | **keep (양쪽 컬럼)** | 멤버 관리 화면은 두 차원 모두 보여줘야 함. select 유지. |
| `lib/adminMembersData.ts:102-103` | `if (options.status) q.eq('status', options.status)` 필터 | **rewrite** | 필터 값을 새 `['active','inactive']` 두 값으로 강제. UI 의 드롭다운 옵션도 같이 줄여야 한다. |
| `lib/adminMembersData.ts:106-108` | `if (options.growthStatus) q.eq('growth_status', ...)` 필터 | **keep** | 새 SSOT 와 정합. 옵션은 7종으로 유지. |
| `lib/adminMembersData.ts:228-234,253-261` (`MemberPatchInput`) | PATCH 입력에 `status`, `growth_status` 둘 다 받음 | **rewrite** | `status` 입력은 `'active'|'inactive'` 만 허용하도록 validator 추가. growth 는 7종 enum 허용. |
| `lib/adminMembersTypes.ts:40-46` (`MEMBER_PATCH_FIELDS`) | 두 컬럼 모두 patch 대상 | **keep** | 이름 유지. 검증 로직만 `adminMembersData.ts` 에서 강화. |
| `lib/adminResumeCardData.ts:17-27` (`PROFILE_FIELDS`) | `'status'` 가 Resume Card editor 의 writable 필드 | **remove (Resume editor 측 의미)** | Resume 배지를 `growth_status` 로 재배선하면 Resume Card editor 에서 `status` 를 "성장 상태" 의도로 편집할 이유가 사라진다. `status` 편집은 `MemberEditDrawer` (계정 활성도 토글) 에서만 노출하도록 단일화. |
| `lib/cluster1ResumeData.ts:23-46` (`STATUS_MAP` / `resolveResumeStatus`) | `user_profiles.status` → Resume 배지 5종 매핑 (active/graduated/weekly_rest/seasonal_rest/paused/suspended) | **remove (그리고 재작성)** | `status` 가 5 값을 가지지 않게 되므로 STATUS_MAP 자체를 폐기하고 `growth_status` 기반 매핑으로 새로 작성한다. 자세한 매핑은 §2 참조. |
| `lib/cluster1ResumeData.ts:446-450,452,463` | `getCluster1Resume` 가 `status` 만 SELECT 해서 `resolveResumeStatus()` 에 넘김 | **rewrite** | SELECT 를 `growth_status` 로 교체하고 매핑 함수도 교체. |
| `lib/cluster3GrowthData.ts:282,340` | `select` 에 `growth_status` 포함, `status` 는 미사용 | **keep** | 새 SSOT 와 정합. 변경 없음. |
| `lib/cluster3ClubRankData.ts:57,74` | `growth_status` 만 사용. `status` 미사용 | **keep** | 변경 없음. |
| `lib/cluster4WeeklyGrowthData.ts:194,255-266` | `growth_status` 만 사용 | **keep** | 변경 없음. |
| `lib/seasonRestValidation.ts:39,91,136` | `user_season_statuses.status`, `user_week_statuses.status` (테이블 다름) | **무관 (테이블 분리)** | `user_profiles.status` 아님. 단, §3 권장(B안)대로 `growth_status` 동시 갱신 로직을 **추가**해야 한다 (이 함수는 변경 대상이긴 함). |

#### `components/`

| 파일:라인 | 현재 동작 | 분류 | 사유 |
|-----------|-----------|------|------|
| `components/admin/MemberEditDrawer.tsx:264-282` | "상태" Select 가 `APP_USER_STATUSES` 6종 옵션 표시 | **rewrite** | 옵션을 `['active','inactive']` 2종으로 축소. 라벨 "상태" → "계정 활성도" 로 변경 권장. |
| `components/admin/MemberEditDrawer.tsx:285-309` | "성장 상태" Select 가 동일한 `APP_USER_STATUSES` 6종 사용 | **rewrite** | 별도 `GROWTH_STATUSES` 상수 7종 (`active, paused, suspended, seasonal_rest, weekly_rest, graduating, graduated`) 로 분리. |
| `components/admin/MemberEditDrawer.tsx:49-50,68-74,162,172` | `form.status` / `form.growth_status` 양쪽 patch | **keep** | 두 필드는 계속 존재. validator 만 새 enum 으로. |
| `components/admin/MembersList.tsx:65-66,85-86,151-152,198-199,476-485,508-509` | 표 헤더/필터/렌더에 두 컬럼 모두 노출 | **rewrite** | "상태" 컬럼은 `'active'|'inactive'` 배지로 표시 단순화. "성장" 컬럼은 그대로 `growth_status` 라벨 표시 (가능하면 `GROWTH_DISPLAY_LABELS` 활용). |
| `components/admin/MembersList.tsx:77` | `GROWTH_STATUSES = APP_USER_STATUSES` 라는 위험한 별칭 | **rewrite (필수)** | 두 상수를 분리해야 한다. growth 가 잘못 share 되어 `status` enum 축소 시 부작용이 됨. |
| `components/admin/AppUsersList.tsx:41,78,99,294-307,392` | 상태 필터/표시에 `APP_USER_STATUSES` 사용 | **rewrite** | 동일. "앱 사용자" 페이지가 무엇을 보여줄지 결정 후 새 enum 으로 옵션 갱신. |
| `components/admin/ResumeCardEditor.tsx:116-126` (`PROFILE_FIELDS`) | Resume Card editor 의 "Status" select 옵션 = `['active','weekly_rest','seasonal_rest','graduated','suspended']` | **remove** | Resume 배지가 `growth_status` 로 옮겨가면 이 select 는 의미를 잃는다. 옵션 제거 + 필드 자체 제거 권장. (status 편집은 MemberEditDrawer 에서 일원화) |
| `components/admin/ResumeCardEditor.tsx:740-787` (배지 렌더링) | `resume.resumeStatus.*` (DTO 가공치) 사용 — 컴포넌트 자체는 컬럼명 추상화됨 | **keep** | DTO 측에서 `growth_status` 기반으로 채워주면 컴포넌트는 무변경. |
| `components/admin/ResumeCardEditor.tsx:750` (devMode 주석) | `"user_profiles.status → resume badge mapping"` | **rewrite** | 주석 텍스트를 `"user_profiles.growth_status → resume badge mapping"` 로 갱신. |
| `components/admin/ResumeCardEditor.tsx:1131` | 우측 미리보기에서 `form.profile.status` 출력 | **remove** | 메달 텍스트의 원본을 `growth_status` 로 변경 (또는 표시 라벨로). |

#### `db/`

| 파일:라인 | 분류 | 사유 |
|-----------|------|------|
| `db/migrations/2026-05-22_account_management_step1_schema.sql:25-31` | **유지 (참고용)** | 본 마이그레이션은 `role` CHECK 만 추가. 본 설계서가 추가할 `status_check` 의 위치를 결정할 때 동일 패턴(`DO $$ ... pg_constraint guard`) 을 따른다. |
| `db/migrations/2026-05-22_account_management_step2_backfill_operators.sql:48-65` | **참고 (변경 없음)** | super_admin 백필. `status='active'`, `growth_status='active'` 하드코딩. 새 enum 과 일치하므로 안전. |
| `db/migrations/2026-05-25_cluster3_growth_seed_diversify.sql:130-185` | **무시 (기존 시드)** | `growth_status` 만 set, `status` 미수정. 본 리팩토링에 안전. |
| `db/migrations/2026-05-25_cluster3_growth_indicators.sql:115-131` | **무시** | 주석에만 growth_status 언급. status 컬럼 미터치. |
| `db/migrations/2026-05-25_club_rank_weekly_points.sql:219` | **유지** | `growth_status IN ('graduated','suspended')` 조회만. 새 SSOT 와 정합. |
| `db/migrations/2026-05-25_official_rest_weeks_and_override.sql:103,121,154,172` | **유지** | `growth_status` 만 사용. |
| `db/verify_grade_stats.sql`, `db/verify_cluster3_seed.sql` (전체) | **참고** | 검증 쿼리. `growth_status` 분포 확인용. 본 리팩토링 후에도 그대로 동작. |
| `claudedocs/seed-90users-v2-20260526.sql:275,304,345,382,386,407` | **참고 / 재실행 시 위험** | 시드가 `v_profile_status` 로 `'weekly_rest','graduated'` 등을 `user_profiles.status` 에 직접 저장한다. **새 CHECK 가 들어가면 본 시드가 깨진다**. 시드 재실행 전 본 시드 SQL 을 수정해야 함 (계획 §6 Phase 2). |

#### `scripts/`

| 파일:라인 | 분류 | 사유 |
|-----------|------|------|
| `scripts/check-resume-users.ts:6` | **rewrite (테스트 영향)** | `user_profiles.status` 를 SELECT 해서 시뮬레이션. growth_status 기반으로 교체 필요 (Resume 결과를 검증한다면). |
| `scripts/simulate-resume-dto.ts:8,37-39` | **rewrite** | `p.status === 'active' → running` 같은 simulation. 새 매핑(§2)으로 교체. |
| `scripts/verify-resume-card.ts:23` | **무관** | `growth_status` 만 select. 변경 없음. |
| `scripts/membership-plan-preview.ts:91,107` | **rewrite** | `if (status === 'graduated')` 분기가 있음. growth_status 로 옮김. |
| `scripts/verify-cluster4-full.ts`, `scripts/test-growth-indicators.ts` | **무관** | `growth_status` 기반. |

### 1-C. 가장 위험한 잔존 호출 (요약)

| 위험 | 위치 | 영향 |
|------|------|------|
| 6종 enum 을 그대로 둔 채 `status` 만 2종으로 줄이면 PATCH 가 즉시 깨짐 | `components/admin/MemberEditDrawer.tsx:276` (옵션 출처 = `APP_USER_STATUSES`) → 같은 enum 을 status/growth 둘 다에 쓰는 디자인 결함 | UI 가 `weekly_rest` 같은 값을 status 로 PATCH → DB CHECK 위반 (CHECK 가 들어간 후) 또는 의미 오염 (CHECK 들어가기 전) |
| `MembersList.tsx:77` 의 `GROWTH_STATUSES = APP_USER_STATUSES` 별칭 | 동일 | growth 필터 옵션이 `inactive` 같은 의미 없는 값을 제안하게 됨 — 옵션 분리 필수 |
| Resume 배지가 `status` 가 더 이상 가지지 않을 값(`graduated/paused/...`)을 받으면 모두 `next_challenge` 로 매핑됨 | `cluster1ResumeData.ts:38-41` (`?? next_challenge` fallback) | 코드는 깨지지 않지만 **모든 Resume 배지가 "Next Challenge" 로 잘못 표시**되는 silent regression. Phase 1 에서 매핑 교체가 누락되면 즉시 발생. |

---

## 2. Resume Card → `growth_status` 영향 파일

### 2-A. 관련 파일 전수

| 파일:라인 | 역할 | 필수 변경 |
|-----------|------|----------|
| `lib/cluster1ResumeData.ts:23-35` | `STATUS_MAP` (`user_profiles.status` → ResumeStatusCode) | **삭제 후 신규 GROWTH→Resume 매핑으로 교체** (아래 §2-B 표). |
| `lib/cluster1ResumeData.ts:37-46` | `resolveResumeStatus(profileStatus)` | **시그니처 변경**: `resolveResumeStatus(growthStatus, currentWeekStatus?)`. fallback 정책 결정 필요 (§2-D). |
| `lib/cluster1ResumeData.ts:446-450` | 프로필 fetch — `select("status")` | **`select("growth_status")` 로 교체**. |
| `lib/cluster1ResumeData.ts:452` | `profileStatus = profileRes.data?.status` | **`growthStatus = profileRes.data?.growth_status`** 로 교체. |
| `lib/cluster1ResumeData.ts:463` | `resumeStatus: resolveResumeStatus(profileStatus)` | **인자 교체**. |
| `lib/cluster1ResumeTypes.ts:4-22` | `ResumeStatusCode` / `ResumeStatusLabel` / `ResumeStatus` 타입 | **enum 보강 필요 여부 결정** (§2-C). 현행 5종 + (확장 시) `onboarding/extra_growth/official_rest` 추가 검토. |
| `lib/adminResumeCardData.ts:17-27` (`PROFILE_FIELDS`) | Resume editor 의 writable 컬럼 화이트리스트. `'status'` 포함 | `'status'` **제거**. (status 편집은 MemberEditDrawer 단일화) |
| `components/admin/ResumeCardEditor.tsx:116-126` | "Status" Select 의 옵션 5종 (`active/weekly_rest/seasonal_rest/graduated/suspended`) | **필드 정의 자체 제거** 또는 read-only 표시로 변경. |
| `components/admin/ResumeCardEditor.tsx:740-787` | Resume 배지 렌더링 — `resume.resumeStatus.*` 사용 | DTO 가 동일 모양이면 컴포넌트 무변경. 단 색상 클래스 매핑이 5종 ResumeStatusCode 에 한정되어 있어 enum 확장 시 (§2-C) 색상도 추가해야 한다. |
| `components/admin/ResumeCardEditor.tsx:750` (devMode 주석) | `"user_profiles.status → resume badge mapping"` | 주석 텍스트 갱신. |
| `components/admin/ResumeCardEditor.tsx:1131` | `{fmt(form.profile.status)}` 미리보기 | `form.profile.growth_status` (또는 GROWTH_DISPLAY_LABELS 결과) 출력으로 교체. |
| `scripts/simulate-resume-dto.ts:8,37-39` | `status='active' → running, 그 외 → next_challenge` 시뮬레이션 | growth_status 기반으로 재작성. |
| `scripts/check-resume-users.ts:6` | `user_profiles.status` SELECT | growth_status 로 교체 (혹은 둘 다 fetch 해서 비교). |

### 2-B. 신규 매핑 (권장)

`growth_status` (7종) → `ResumeStatusCode` (5종) 매핑은 다음을 따른다. 우선순위는 현행 `resolveDisplayKey()` 가 사용하는 것과 동일하게 두어 Resume/Cluster3 사이의 라벨 불일치를 제거한다.

| growth_status | ResumeStatusCode | ResumeStatusLabel | isBadgeDimmed |
|---------------|------------------|-------------------|---------------|
| `graduated`     | `complete`        | "Complete"         | false |
| `active`        | `running`         | "Running"          | true |
| `weekly_rest`   | `on_rest`         | "On Rest"          | true |
| `seasonal_rest` | `recharging`      | "Recharging"       | true |
| `paused`        | `next_challenge`  | "Next Challenge"   | true |
| `suspended`     | `next_challenge`  | "Next Challenge"   | true |
| `graduating`    | `next_challenge`  | "Next Challenge"   | true |
| `null` / 그 외  | `next_challenge`  | "Next Challenge"   | true |

> Resume Card 가 5종 enum 을 유지하는 한, `graduating` 은 별도 슬롯 없이 `next_challenge` 로 흡수된다. UX 가 졸업 진행 단계를 따로 표현하길 원한다면 §2-C 참조.

### 2-C. 한쪽 enum 에만 있는 라벨 (gap analysis)

| 라벨 | growth_status (7종) | ResumeStatusCode (5종) | 처리 권장 |
|------|---------------------|-----------------------|----------|
| `graduating` | ✅ 존재 | ❌ 없음 | `next_challenge` 로 흡수 (현행 호환) **or** Resume enum 에 `graduating` 추가 (UX 결정 필요) |
| `onboarding` | ❌ 없음 (파생) | ❌ 없음 | Resume 가 표시 필요하면 `running` + dim 으로 흡수. 별도 슬롯은 권장하지 않음. |
| `extra_growth` | ❌ 없음 (파생) | ❌ 없음 | 동일. `running` + (dimmed=false) 변형 검토. |
| `official_rest` | ❌ 없음 (현재 주차 파생) | ❌ 없음 | Resume 가 현 주차 휴식 표시까지 필요하면 `recharging` 으로 흡수. |
| `on_rest` (ResumeStatusCode) | `weekly_rest` 매칭 | ✅ 있음 | 매핑 명확. |
| `recharging` (ResumeStatusCode) | `seasonal_rest` 매칭 | ✅ 있음 | 매핑 명확. |
| `complete` (ResumeStatusCode) | `graduated` 매칭 | ✅ 있음 | 매핑 명확. |
| `running` (ResumeStatusCode) | `active` 매칭 | ✅ 있음 | 매핑 명확. |
| `next_challenge` (ResumeStatusCode) | `paused`/`suspended`/`graduating`/null 흡수 | ✅ 있음 | 부정확하지만 호환 |

**기본 권장**: ResumeStatusCode 는 5종 유지. `graduating` 은 `next_challenge` 흡수. 향후 UX 가 명시적으로 "졸업 진행 중" 배지를 요청하면 enum 확장.

### 2-D. fallback / 현재 주차 통합 정책

`resolveResumeStatus()` 가 `growth_status` 외에 `currentWeekStatus` 도 받을지 결정해야 한다.

| 방안 | 장점 | 단점 |
|------|------|------|
| **방안 A: growth_status 단독** | 구현 단순. select 한 줄. | 현재 주차가 `official_rest` 인데 `growth_status='active'` 인 사용자의 Resume 배지는 `Running` 으로 표시됨 (cluster3 라벨과 불일치). |
| **방안 B: growth_status + 현재 주차 결합** | Cluster3 의 `resolveDisplayKey()` 와 같은 우선순위 → 화면 간 라벨 일치. | 추가 쿼리 1개 (현 주차 조회). |

**권장**: 방안 B. 이미 `cluster1ResumeData.ts:160-163` 에서 동일 사용자에 대해 user_week_statuses 를 한 번 fetch 하고 있으므로 거기서 현재 주차를 함께 식별하면 추가 비용은 없다 (filter only).

---

## 3. `seasonal_rest` / `weekly_rest` — 저장 vs 파생 결정

### 3-A. 비교 표

| 기준 | A안: 저장 (`growth_status` 에 명시적으로 set) | B안: 파생 (`user_season_statuses`/`user_week_statuses` 에서 매번 계산) |
|------|---------------------------------------------|----------------------------------------------------------------|
| Source of Truth | `user_profiles.growth_status` 가 항상 정답 | `user_season_statuses.status='rest'` (시즌) / `user_week_statuses.status='personal_rest'` (주간 현재) 가 정답. `growth_status` 는 두 휴식 값을 **저장하지 않음** |
| 정합성 위험 | **HIGH** — 두 곳에 같은 의미가 저장되어 동기화가 누락되면 즉시 모순 (현재 audit FINDING H-3 의 핵심) | **LOW** — 한 곳에만 저장 |
| 조회 비용 | 단순 (`select growth_status`) | 시즌 휴식: `user_season_statuses` LEFT JOIN 1회 추가. 주간 휴식: `user_week_statuses` 의 현 주차 row LEFT JOIN 1회 추가. 이미 cluster3/4 는 두 join 을 수행 중. |
| 쓰기 복잡도 | `seasonRestValidation.requestSeasonRest()` 가 **3 테이블 동시 갱신** (season + week + profile.growth_status). admin override 도 3중 동기화. | `seasonRestValidation` 은 현재 그대로 (season + week 만). profile.growth_status 는 휴식 동안 `active` 유지 — 별개 의미. |
| Admin 오버라이드 ergonomics | MemberEditDrawer 에서 `growth_status='seasonal_rest'` 만 바꿔도 시즌 행이 같이 생성되지 않으면 정합 깨짐. trigger 가 필수. | MemberEditDrawer 에서 휴식을 직접 부여하려면 시즌/주차 행을 만들어야 함 → 별도 모달 필요. 단, 의미상 자연스럽다 ("어드민이 휴식을 부여한다는 건 시즌 휴식 row 를 만든다는 것"). |
| 실패 모드 — A안 선택 시 | (a) `seasonRestValidation` 이 growth_status 갱신을 누락하면 시즌 행은 rest 인데 라벨은 active. 현재 코드가 정확히 이 상태 (`lib/seasonRestValidation.ts:56-67` 은 profile 미터치). (b) trigger 가 정확하지 않으면 양쪽이 다른 값을 가짐. (c) 시즌 종료 시 자동 정리되지 않음 — 휴식 종료 후 growth_status 가 active 로 자동 복귀하지 않으면 사용자가 영구 휴식자로 보임. | — |
| 실패 모드 — B안 선택 시 | — | (a) 모든 Resume / Cluster3 / MembersList / AppUsers 코드가 **현재 주차** 와 **현재 시즌** 을 알아야 라벨링 가능. (b) MembersList 의 "상태별 필터" 가 단순 `eq('growth_status', ...)` 로 안 되고 join 필요 → 인덱싱/성능 검토. (c) 어드민이 "휴식 부여" 행위를 할 때 user_season_statuses INSERT/UPSERT API 가 필요. (d) `graduating` 같은 다른 enum 의 우선순위가 휴식보다 높은가 결정 (현재 resolveDisplayKey 는 graduating > seasonal_rest > weekly_rest). |

### 3-B. 권장: **B안 (파생)**

이유:

1. 본 감사에서 가장 큰 손상은 "두 곳에 저장된 같은 의미가 일치하지 않는다"는 정합성 깨짐(H-3). A안은 **정답 컬럼이 두 개**가 되어 이 위험을 영구화한다.
2. `user_season_statuses` 와 `user_week_statuses` 는 이미 DB CHECK 가 있고 (`'rest'`, `'personal_rest'`), 시즌 휴식 신청의 정상 경로 (`requestSeasonRest`) 가 이 두 테이블만 갱신하고 있어 **이미 사실상 B안** 으로 동작 중이다. 현재 모순은 `growth_status` 가 휴식값을 가질 수 있다는 정의 자체에서 발생.
3. `seasonal_rest` 가 시즌 행 1개 = N주차 라는 시간 범위를 가지는 반면 `growth_status` 는 사용자에 단일 값. 의미적으로도 휴식은 row 시계열(시즌/주차)에 더 잘 맞다.
4. `growth_status` 가 휴식값을 가지지 않게 되면 enum 이 5종 (`active, paused, suspended, graduating, graduated`) 으로 줄어들어 CHECK 제약이 깔끔해진다 — §4 참조.

**적용 후 `growth_status` 의미 좁히기**: `growth_status` 는 라이프사이클(시작/유보/중단/졸업절차/완료) 에만 사용. "이번 시즌/주차에 쉬고 있다" 는 휴식 시계열로 표현.

**적용 후 `resolveDisplayKey()` 동작**: 거의 무변경. 현재 함수가 이미 `seasonal_rest`/`weekly_rest` (DB값) 우선 + `official_rest` (파생) 후순 으로 분리 처리하고 있다 (`cluster3GrowthData.ts:121-126`). B안 적용 시 DB값 분기 두 줄을 제거하고, `user_season_statuses` 의 현 시즌 rest 행 존재 → `seasonal_rest` 라벨, `user_week_statuses` 의 현 주차 personal_rest → `weekly_rest` 라벨, 로 재구성한다. 이 변경은 한 함수 내부의 case 재배치이며 **소비처 시그니처에는 영향 없음** (이미 라벨은 `displayKey` 로 추상화됨).

### 3-C. 감사 결론(H-3)과의 연결

본 권장은 audit `user-status-domain-technical-mapping-audit-20260528.md` 의 **H-3 (`seasonal_rest`/`weekly_rest` 런타임 쓰기 코드 부재)** 를 다음과 같이 해석한다:

> "런타임 쓰기 코드가 없는 것이 버그가 아니라, **`growth_status` 가 휴식값을 가지지 말아야 한다**는 신호다."

`seasonRestValidation.requestSeasonRest()` (lib/seasonRestValidation.ts:56-67) 은 **이미 올바르게 동작** 중이다 — `user_season_statuses` 와 `user_week_statuses` 만 갱신. growth_status 를 추가로 set 하는 게 아니라, **`growth_status` 에서 두 휴식값을 영구히 제거** 하는 것이 진짜 정리 방향이다.

---

## 4. DB CHECK 제약 후보

### 4-A. `user_profiles.status`

- **허용 값**: `'active', 'inactive'`
- **NULL 허용 여부**: 권장 **NULL 비허용** (DEFAULT 'active'). 현 schema 는 NULL 허용일 가능성이 높으므로 backfill 필요.
- **잠재적 위반 행**: audit 1-C 표 에 따르면 시드/이관 데이터에서 `user_profiles.status` 에 `'weekly_rest'`, `'seasonal_rest'`, `'paused'`, `'graduated'`, `'suspended'` 가 들어가 있다 (예: `claudedocs/seed-90users-v2-20260526.sql:345,382,386,407` 의 `v_profile_status`). **이런 행은 CHECK 추가 전에 모두 `'active'` 로 backfill** 해야 한다 (계정이 비활성화된 상태가 아닌 한).
- **권장 제약 (의사 코드)**:
  ```
  CHECK (status IN ('active', 'inactive'))
  -- 이름: user_profiles_status_check
  -- 패턴: 2026-05-22_account_management_step1_schema.sql:25-31 의 DO $$ 가드와 동일
  ```

### 4-B. `user_profiles.growth_status`

- **허용 값 (B안 — §3 권장)**: `'active', 'paused', 'suspended', 'graduating', 'graduated'` (5종)
- **허용 값 (A안, 만약 휴식을 저장한다면)**: 위 5종 + `'seasonal_rest', 'weekly_rest'` (총 7종)
- **NULL 허용 여부**: 권장 **NULL 허용 유지** (신규 가입자/이관 직후 상태 미확정 케이스). DEFAULT 'active' 권장.
- **잠재적 위반 행**: 현재 시드/이관에서 7종을 모두 사용 중. B안 채택 시 `seasonal_rest`/`weekly_rest` 행은 모두 `'active'` 로 backfill + 동일 시점에 `user_season_statuses.status='rest'` 또는 `user_week_statuses.status='personal_rest'` 행 생성 보장 필요.
- **권장 제약 (의사 코드, B안)**:
  ```
  CHECK (growth_status IS NULL OR growth_status IN (
    'active', 'paused', 'suspended', 'graduating', 'graduated'
  ))
  -- 이름: user_profiles_growth_status_check
  ```

### 4-C. `user_season_statuses.status`

- 현행: `CHECK (status IN ('success', 'rest'))` — 이미 존재 (`db/migrations/2026-05-25_season_definitions_and_user_seasons.sql:100-101`).
- **변경 불필요**. 본 설계가 추가로 보강해야 한다면, `requested_at` 비-null when status='rest' 같은 보조 제약은 추후 검토.

### 4-D. `user_week_statuses.status`

- 현행: `CHECK (status IN ('success','fail','personal_rest','official_rest'))` — 이미 존재 (`db/migrations/2026-05-25_cluster3_growth_indicators.sql:39-40`).
- **변경 불필요**.

### 4-E. CHECK 위반 행 식별 쿼리 (참고용 — 마이그레이션 전 dry-run 권장)

마이그레이션 적용 전에 SQL Editor 에서 다음 형태의 read-only 쿼리로 위반 행 수를 미리 측정해야 한다 (본 문서는 SQL 미작성 — 의사 표현):

- `SELECT user_id, status FROM user_profiles WHERE status NOT IN ('active','inactive')`
- `SELECT user_id, growth_status FROM user_profiles WHERE growth_status IS NOT NULL AND growth_status NOT IN ('active','paused','suspended','graduating','graduated')`
- 시즌/주차 두 테이블은 CHECK 가 이미 enforced 이므로 위반 행은 없음.

---

## 5. 마이그레이션 필요성

### 5-A. 코드만 변경 (마이그레이션 불필요)

| 항목 | 이유 |
|------|------|
| `lib/cluster1ResumeData.ts` 의 `STATUS_MAP` → `growth_status` 매핑 교체 | 컬럼 추가/변경 없음. SELECT 컬럼만 바꿈. |
| `MemberEditDrawer.tsx` / `MembersList.tsx` 의 enum 옵션 분리 | UI 상수 분리. |
| `adminAppUsersTypes.ts` 의 `APP_USER_STATUSES` 재정의 (2종) | 상수 정의 변경. |
| `seasonRestValidation` 코드 — 현재 그대로 유지 (B안 채택 시) | 변경 없음. |
| `resolveDisplayKey()` 의 휴식값 case 제거 + season/week 파생 분기로 재배치 | 함수 내부 변경. |
| `ResumeCardEditor` Status select 옵션 제거 | UI 변경. |

### 5-B. 마이그레이션 필요

| # | 마이그레이션 | 목적 | 데이터 영향 |
|---|--------------|------|-----------|
| **M1** | `user_profiles.status` 백필 — `'active'/'inactive'` 외 값을 모두 `'active'` 로 정규화 | CHECK 추가 사전 준비 | UPDATE 다수. 비파괴(다만 의미는 잃음 — 손실되는 의미는 이미 growth_status 에서 표현 가능하므로 정보 손실 없음). 단, "graduated 라는 status 값을 운영자가 명시적으로 set 했다" 같은 의도 정보가 사라지지 않도록 backfill 동시에 동일 사용자의 `growth_status` 도 함께 set 되어 있는지 검증 쿼리를 같이 실행. |
| **M2** | `user_profiles.growth_status` 백필 — B안 채택 시 `'seasonal_rest'/'weekly_rest'` 값을 `'active'` 로 변경 + 해당 사용자에 `user_season_statuses.status='rest'` 또는 `user_week_statuses.status='personal_rest'` 가 존재하는지 보장 (없으면 row 생성) | growth_status 의미 축소 사전 준비 | UPDATE + 조건부 INSERT. **의미 보존 필수** — 검증 쿼리 selected 카운트 = 변경 후 양 테이블 카운트 일치 확인. |
| **M3** | `user_profiles.status` CHECK 추가: `CHECK (status IN ('active','inactive'))` | 외부 직접 쓰기 방지 | constraint 추가만. 단, M1 완료 후에만 실행 가능 (선후관계). |
| **M4** | `user_profiles.growth_status` CHECK 추가: `CHECK (growth_status IS NULL OR growth_status IN ('active','paused','suspended','graduating','graduated'))` | 동일 | constraint 추가. M2 완료 후 실행. |
| **M5** (선택) | `user_profiles.status` DEFAULT 추가: `DEFAULT 'active'` + NOT NULL 강제 | 미래 INSERT 시 누락 방지 | DEFAULT 와 NOT NULL 추가. NULL row 가 있으면 backfill 후 진행. |
| **M6** (선택) | `seed-90users-v2-20260526.sql` 의 `v_profile_status` 라인들 수정 (재실행 시 깨지지 않도록) | 시드 SQL 정합화 | 코드(SQL 파일)만 수정. 운영 DB 무영향. |

### 5-C. 컬럼 rename 여부

`user_profiles.status` → `account_status` 로 rename 하는 안도 검토 가능하나 **권장하지 않음**:

- 외부 API (`/api/admin/app-users?status=...`, `/api/admin/members` 등) 가 다수 의존.
- DTO 키 `status` 가 광범위. 마이그레이션 + 클라이언트 호환 윈도우가 필요.
- 의미 축소만으로 충분 (CHECK + 문서화). rename 은 별도 항목으로 분리.

### 5-D. 새 컬럼 추가 여부

**불필요**. 본 설계의 모든 의미 정리는 기존 컬럼 (status, growth_status, user_season_statuses, user_week_statuses) 의 책임 재분배로 해결된다.

---

## 6. 단계적 적용 순서 (Phased Application Order)

각 단계의 4 요소: **사전 조건**, **종료 조건**, **단계 완료 후 안전해지는 것**, **단계 중 관측 위험**.

### Phase 0 — 감사 확정 / Freeze

- **사전 조건**: 본 설계서 확정. 사용자가 §3 권장(B안: 휴식 파생) 채택 확정.
- **작업**: (a) 본 설계서를 팀 공유. (b) `seasonRestValidation` 이외에 `user_profiles.status` / `user_profiles.growth_status` 를 쓰는 새 코드 추가를 일시 freeze. (c) 마이그레이션 사전 검증 쿼리(§4-E) 결과 캡처 + 위반 행 카운트 기록.
- **종료 조건**: 위반 행 보고서 작성, freeze 공지.
- **안전해지는 것**: 본 설계와 무관한 새 회귀 코드 유입 차단.
- **관측 위험**: 없음 (관측만).

### Phase 1 — Read-path: Resume 가 `growth_status` 를 읽도록 전환

- **사전 조건**: Phase 0 완료. 위반 행 backfill 미실행 상태여도 가능 (`growth_status` 는 모든 사용자에 이미 채워져 있음).
- **작업**:
  1. `lib/cluster1ResumeData.ts:446-450` SELECT 를 `growth_status` 로 교체.
  2. `STATUS_MAP` 폐기, `resolveResumeStatus(growthStatus)` 신규 매핑 적용 (§2-B 표).
  3. 선택: 방안 B (현 주차 통합) 적용. 기존 `weekRes` 데이터를 재활용해 추가 쿼리 없이 currentWeekStatus 도출.
  4. `components/admin/ResumeCardEditor.tsx:750` devMode 주석 갱신, `:1131` 미리보기 출력 변경.
  5. `scripts/simulate-resume-dto.ts` / `check-resume-users.ts` 갱신.
- **종료 조건**: Resume API 의 모든 사용자 응답에 대해 새 매핑이 적용됨. 회귀 테스트: 동일 사용자에 대해 Phase 1 전후 Resume 응답을 비교한 결과, `growth_status='active'` 사용자는 동일 결과를 받음 (status 가 이미 active 였으므로).
- **안전해지는 것**: Resume 화면이 Cluster3 와 동일 컬럼을 보게 됨 → 화면 간 라벨 모순 H-1 해소.
- **관측 위험**: `status` 가 `'graduated'` 같은 비정상 값을 가진 사용자(현 시드)는 Resume 가 더 이상 `complete` 로 표시되지 않을 수 있음 (대신 `growth_status` 의 값에 따라 매핑). 이는 **버그가 아니라 정합화** 이지만, 운영자에게 사전 공지 필요.

### Phase 2 — Write-path 일원화 + UI enum 분리

- **사전 조건**: Phase 1 완료.
- **작업**:
  1. `lib/adminAppUsersTypes.ts` 의 `APP_USER_STATUSES` 를 `['active','inactive']` 로 축소. 새 `GROWTH_STATUSES = ['active','paused','suspended','graduating','graduated']` 신설 (B안 enum).
  2. `components/admin/MemberEditDrawer.tsx:276,303` 옵션 분리 (status = 2종, growth_status = 5종).
  3. `components/admin/MembersList.tsx:77` 의 `GROWTH_STATUSES = APP_USER_STATUSES` 별칭 제거 → 신규 상수 import.
  4. `components/admin/AppUsersList.tsx` 의 필터 옵션을 2종 enum 으로 축소.
  5. `lib/adminMembersData.ts` 의 PATCH validator 강화 (status 입력 → 2종만 허용, growth_status → 5종만 허용).
  6. `components/admin/ResumeCardEditor.tsx:116-126` 의 PROFILE_FIELDS 에서 `status` 항목 제거.
  7. `lib/adminResumeCardData.ts:17-27` 의 `PROFILE_FIELDS` 에서 `'status'` 제거.
  8. `resolveDisplayKey()` (`lib/cluster3GrowthData.ts:109-130`) 에서 `seasonal_rest`/`weekly_rest` DB값 분기 제거 + season/week 파생 분기로 재배치. (B안 적용)
  9. `seed-90users-v2-20260526.sql` 의 `v_profile_status` 사용 라인을 모두 `'active'` 로 수정 (M6).
- **종료 조건**: 어떤 UI/스크립트도 `user_profiles.status` 로 5종 성장 라벨을 write 하지 않음. 모든 새 PATCH 가 새 enum 만 허용.
- **안전해지는 것**: 외부에서 새로운 위반 행이 생성되지 않음 → CHECK 도입 안전.
- **관측 위험**: 운영자가 기존 워크플로우 ("MemberEditDrawer 에서 status=graduated 선택")로 동작하려 시도 시 UI 옵션이 사라져 혼란 가능. 운영자 가이드 동시 배포 필요.

### Phase 3 — Backfill: 기존 위반 행 정리

- **사전 조건**: Phase 2 완료 (새 위반이 더 이상 들어오지 않음).
- **작업**:
  1. **M1**: `UPDATE user_profiles SET status='active' WHERE status NOT IN ('active','inactive');` — 단, `growth_status` 가 `'graduated'/'suspended'` 인 사용자가 동시에 `status='inactive'` 였는지 사전 검증 (그 경우는 의미가 다름).
  2. **M2 (B안)**: `growth_status` 가 `'seasonal_rest'/'weekly_rest'` 인 사용자에 대해:
     - `user_season_statuses` 의 현 시즌에 `status='rest'` 행이 있는지 확인. 없으면 INSERT (`requested_at = NOW()`, `note = 'backfill from growth_status'`).
     - `growth_status='weekly_rest'` 인 사용자에 대해 현재 주차의 `user_week_statuses.status='personal_rest'` 행이 있는지 확인. 없으면 INSERT/UPDATE.
     - 마지막에 `growth_status='active'` 로 UPDATE.
     - 각 단계 변경 수를 카운트하여 손실 없음 검증.
  3. 검증 쿼리 재실행 — 위반 행 0 확인.
- **종료 조건**: §4-E 의 모든 검증 쿼리가 0행 반환.
- **안전해지는 것**: DB 가 CHECK 를 받을 수 있는 상태.
- **관측 위험**: M2 의 row 생성이 누락되면 Phase 1 에서 적용한 새 Resume 매핑(현재 주차 파생)이 잘못된 라벨을 표시할 수 있음. 따라서 M2 는 **Phase 1 의 "현재 주차 통합" 옵션 사용 여부 결정 후** 진행해야 한다.

### Phase 4 — CHECK 제약 적용

- **사전 조건**: Phase 3 의 검증 쿼리 0건 확인.
- **작업**: **M3** (`user_profiles.status` CHECK), **M4** (`growth_status` CHECK) 적용. `DO $$ pg_constraint guard $$` 패턴 사용 (idempotent).
- **종료 조건**: `pg_constraint` 에 두 제약 등록 확인.
- **안전해지는 것**: 외부 도구/SQL Editor 에서 임의 문자열 write 차단.
- **관측 위험**: 시드 SQL 이 옛 값을 다시 INSERT 하려 하면 CHECK 위반으로 시드 실패. M6 (시드 SQL 수정) 가 Phase 2 에 이미 끝나야 함.

### Phase 5 — (선택) Default / NOT NULL 강화

- **사전 조건**: Phase 4 완료. 운영 안정화 기간 (예: 2주).
- **작업**: **M5** — `user_profiles.status DEFAULT 'active' NOT NULL`. `growth_status` 는 NULL 허용 유지 권장 (가입 직후 등).
- **종료 조건**: 신규 INSERT 시 status 누락 케이스에서도 'active' 로 채워짐 확인.
- **안전해지는 것**: API 코드의 status 누락 가능성 차단.
- **관측 위험**: NULL 사용자가 잔존하면 NOT NULL 추가가 실패 — 사전 점검 필요.

---

## 7. 롤백 계획

| Phase | 롤백 가능성 | 방법 | No-return point |
|-------|-----------|------|----------------|
| Phase 0 | 완전 가역 (관측만) | freeze 해제 | 없음 |
| Phase 1 | **가역 (코드 revert)** | git revert. DB 무변경. | 없음 |
| Phase 2 | **가역 (코드 revert)** | git revert. UI 옵션이 다시 6종으로 돌아옴. DB 무변경. | 없음. 단, 이미 새 enum 으로 PATCH 된 사용자(예: status='inactive')는 기존 의미로 자동 복귀하지 않음 — 의미 손실 없으므로 OK. |
| Phase 3 (M1, M2) | **준-비가역** | (a) M1 의 `status='graduated' → 'active'` 변경은 동일 사용자의 `growth_status` 가 이미 `'graduated'` 여야 의미 손실 없음. growth_status 정합 없는 사용자가 있었다면 **롤백 불가** (어떤 값이 원래였는지 추적 불가). 따라서 M1 실행 전 반드시 `SELECT user_id, status, growth_status FROM user_profiles WHERE status NOT IN ('active','inactive')` 결과를 별도 백업 테이블/CSV 로 저장. (b) M2 의 휴식 row 생성은 `note='backfill from growth_status'` 로 식별 가능 → DELETE 가능. growth_status='active' 되돌리기도 가능. | M1 완료 + 백업 미보관 시. |
| Phase 4 (M3, M4) | **가역** | `ALTER TABLE ... DROP CONSTRAINT user_profiles_status_check` (역방향 마이그레이션 작성). 데이터 미변경. | 없음. |
| Phase 5 (M5) | **부분 가역** | DEFAULT/NOT NULL DROP 가능. 단, 그 사이에 NULL 의도로 INSERT 한 행은 모두 'active' 가 되어 의도 추적 불가. | DEFAULT 적용 후 신규 INSERT 가 'active' 로 채워지면 원래 값 추적 불가. |

### 핵심 No-return 지점

**Phase 3 의 M1 실행 시각**. 이 시점 이전의 `user_profiles.status` 원본 값 분포가 사라진다. 따라서:

1. **M1 실행 전 백업 필수** — `CREATE TABLE _backup_user_profiles_status_20260528 AS SELECT user_id, status, growth_status FROM user_profiles WHERE status NOT IN ('active','inactive')` 등 명시적 백업.
2. **M2 도 동일 패턴** — `_backup_user_profiles_growth_status_20260528` 백업 후 진행.
3. 백업 테이블은 Phase 4 완료 후 운영 안정화 기간(2주) 이상 보관, `_backup_*` prefix 로 `source-of-truth-audit-20260528.md:728` 의 deprecated 정책에 맞게 명명.

---

## 부록 A. 본 설계가 해소하는 audit 결함

| audit ID | 결함 | 본 설계의 해결 단계 |
|----------|------|-------------------|
| H-1 | `user_profiles.status` 이중 용도 → 화면 간 라벨 모순 | Phase 1 (Resume read-path 전환) + Phase 2 (write-path 단일화) |
| H-2 | growth_status / status 간 자동 동기화 부재 | Phase 2 (이 둘이 다른 의미를 가지므로 동기화 자체가 불필요) + Phase 4 (CHECK 로 의미 영역 분리 강제) |
| H-3 | seasonal_rest / weekly_rest 런타임 쓰기 코드 부재 | §3 B안: 의도된 부재. growth_status 에서 두 값 제거 + 휴식은 시즌/주차 row 로만 표현. Phase 3 (M2) 가 기존 위반 정리. |
| H-4 | graduating → graduated 자동 전이 부재 | **본 설계 범위 외**. 별도 워크플로우 설계가 필요하나, 본 설계로 `growth_status` 가 단일 SSOT 가 되면 미래 자동화의 진입점이 명확해짐. |
| H-5 | 자동 강등(suspended) 룰 부재 | 동일. 별도 정책 + 구현 필요. |
| H-6 | growth_status CHECK 부재 | Phase 4 (M4) |
| (audit 6) | `personal_rest` vs `weekly_rest` 명명 불일치 | B안 적용 시 `weekly_rest` 라벨이 `growth_status` 에서 제거됨 → 명명 불일치 자연 해소. UI 라벨은 `GROWTH_DISPLAY_LABELS.weekly_rest` 를 `user_week_statuses.status='personal_rest'` 파생 키로 유지 (cluster3GrowthTypes.ts:36). |

## 부록 B. 본 설계가 다루지 않는 항목

- 졸업 자동 워크플로우 (`graduating` ↔ `graduated` 전이) — 별도 설계 필요.
- 자동 강등 ("2주 fail → suspended" 등 정책) — 정책 자체 미정.
- `user_club_rank_frozen` 자동 unfreeze (audit M-3) — 별도 트리거 설계.
- `official_rest_weeks` ↔ `weeks.is_official_rest` 단일화 — `source-of-truth-audit-20260528.md` Phase 3 에서 다룸.
- `approved_weeks`/`cumulative_weeks` 트리거 — `source-of-truth-audit-20260528.md` Phase 1 에서 다룸. (본 설계의 Phase 3 M2 가 이 트리거가 있으면 더 안전하므로, 가능하면 본 Phase 3 전에 그쪽 트리거를 먼저 적용 권장.)
