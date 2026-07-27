# 어드민 데이터 흐름 인덱스 — 요약

조사일 2026-07-26 · 대상 커밋 `e0cdd70` (main) · 코드 정적 추적만 수행(HTTP 검증 없음)

관련 파일: [`admin-pages.csv`](./admin-pages.csv) · [`admin-data-lineage.csv`](./admin-data-lineage.csv)

---

## 1. 규모

| 항목 | 수 |
| --- | --- |
| 조사한 페이지 파일(`page.tsx`) | 75 |
| ├ 어드민 페이지 경로 | 71 |
| │ ├ 실기능 페이지 | **49** |
| │ ├ re-export 별칭(`/admin/integrated/*`) | 8 |
| │ └ redirect 스텁 · 빈 화면(도움말만) | 14 |
| └ 비어드민(`/`, `/login`, `/forgot-password`, `/reset-password`) | 4 |
| 저장 기능이 있는 페이지 | **42** (어드민 실기능 40 + 비밀번호 재설정 2) |
| 조회 전용 페이지 | **9** (어드민 실기능 중) + 14 (데이터 없는 스텁·빈 화면) |
| API 라우트 파일 | 209 (`/api/admin` 188 · 그 외 `/api` 19 · `app/auth/*` 2) |
| 확인된 데이터 항목 | **197** |
| 확인된 저장 원천(DB 테이블) | **110** (코드에서 발견된 테이블 111개 중) |
| 어드민 내부 소비 관계 | **99** (`consumer_type=admin-page`) |
| 외부 제공 API | **15** (크루 앱 소비) |
| snapshot·cache 가 개입하는 경로 | **50** |
| 신뢰도 HIGH / MEDIUM / LOW | 147 / 34 / **16** |

`role` 분포 — 기준정보 생성·관리 12 · 운영 인스턴스 생성 4 · 관계·배정 5 · 상태 전이 15 · 결과·실적 입력 5 · 조회·검증 24 · 집계·파생 1 · 복합 역할 9

---

## 2. 외부 제공 API (크루 앱 → 어드민 레포)

15개 모두 `/api/admin` 접두사 없이 운영된다. 인증은 두 갈래다.

**`x-internal-api-key` 서버-서버 전용(세션 경로 없음)**
`/api/cluster1/resume` · `/api/cluster3/growth-status-batch` · `/api/cluster4/weekly-cards-projection` · `/api/cluster4/weekly-line-enhancement`

**internal-key + Supabase 세션 2경로**
`/api/cluster3/club-rank` · `/api/cluster3/stats-cards` · `/api/cluster4/weekly-cards`

**세션 전용**
`/api/cluster4/lines/detail` · `/api/cluster4/lines/[lineTargetId]/submission` · `/api/cluster4/weekly-growth` · `/api/edit-windows/permission` · `/api/review-link` · `/api/weekly-reputations` · `/api/reputation-keywords` · `/api/members/find` · `/api/schools/search`

역방향 흐름(크루가 쓰고 어드민이 읽음)이 2개 있다 — `POST /api/cluster4/lines/[lineTargetId]/submission` → `cluster4_line_submissions`, `PUT /api/review-link` → `user_review_links`.

---

## 3. snapshot · cache 사용 경로

| 저장소 | 쓰기 경로 | 읽기 소비처 | 성격 |
| --- | --- | --- | --- |
| `cluster4_weekly_card_snapshots` | `lib/cluster4WeeklyCardsSnapshot.ts` (유일) | 6곳 | 크루 앱 주차 카드의 **1차 읽기 원천**. `dto_version=48`, `hit/stale/miss/error` 4분기 |
| `cluster4_roster_card_stats` | 위 lib 의 `writeRosterCardStats` 부산물 | `adminMembersData` · `cluster3GrowthData` | 로스터 slim 캐시 (fat cards 회피) |
| `user_growth_stats` | `lib/userGrowthStatsData.ts` (유일, **수동 트리거만**) | 4곳 | 성장 통계 캐시 |
| `user_grade_stats` | `lib/cluster3ClubRankData.ts` | **없음 (R:0)** | 품계 캐시 — 어디서도 읽지 않음 |
| `clubRankComputationCache` (프로세스 메모리) | 계산 성공 시 | `cluster3ClubRankData` | TTL 30s · 전역 1개 · single-flight · stale-while-error 없음 |
| `cluster4_week_finalize_run_*` | `lib/crewWeekPublish.ts` | 공표 화면 | 공표 시점 결과 고정(복제 성격) |

**cron 부재가 구조적 제약이다.** `vercel.json` 에는 `regions:["icn1"]` 만 있고 `crons` 항목이 없다(Hobby). snapshot 재계산은 `POST /api/admin/cluster4/recompute-*`, `/api/admin/qa/run-now/snapshot-batch`, lazy 재계산, `CRON_SECRET` 외부 트리거에 의존한다. `run-due-checks` · `run-due-closes` · `run-due-week-actions` 3개 배치도 동일하다.

---

## 4. 원천이 둘 이상인 데이터

| 데이터 | 원천 | 결합 규칙 |
| --- | --- | --- |
| 주차 포인트 | `user_weekly_points.legacy_*` (기준층) + `process_point_awards` (활성 award 기여층) | `composeWeeklyPointTotals` — award 취소 시 기준값 복귀. **2026-07-26 마이그레이션 선행 필수**, 미적용 시 별도 폴백 |
| 주차 포인트 쓰기 | `processPointAccrual` · `pmsPointlogsSync` (writer 2개) | 원장 합 전량 재계산(증분 금지) |
| 주차 검수·공표 상태 | `weeks.result_published_at`/`result_reviewed_at` (전역) + `cluster4_week_opening_configs` (조직 확정·검수) + `cluster4_week_org_result_states` (조직×scope status) | 조직 행 없으면 `source='legacy'` 폴백 — 이때 시각 필드 전부 null |
| 팀·파트·클래스 | `user_position_histories` (UPH) + `cluster4_team_week_position_overrides` | `effective = override ?? UPH`. snapshot v48 에 baking |
| 휴식 | `vacation_requests`(SoT) + `user_week_statuses.status='personal_rest'`(레거시 union) + `official_rest_periods`(조직) + `crew_personal_rest_periods`(writer 미확인) | `getUwsStatus` 에서 union. `approvedRestWeeks` 는 `vacation_requests` 만 읽음 |
| 품계 표시 3종 | `user_weekly_points` 실시간 계산 (캐시 `user_grade_stats` 미참조) | `avgPercentile`·`rankGradeNumber`·`rankGradeLabel` 을 **한 응답에서 함께** 파생(2026-07-26 수정) |
| 자기소개 | `user_introductions` — writer 2개 (`adminCluster2Data` · `adminResumeCardData`) | 두 화면이 같은 테이블을 각각 upsert |
| 이력서 카드 설정 | `user_resume_card_settings` > `organization_resume_card_settings` > `site_resume_card_settings` | 3계층 폴백 |

---

## 5. 페이지마다 별도 계산하는 데이터

- **snapshot `cards` 재파싱** — `adminMembersInfoStats`(정보 통계) · `cluster3GrowthData`(성장 상태) · `adminCluster4LinesData`(라인 org 전수 감사) · `adminWeeklyCardFinalizationData`(확정 대조) 가 같은 jsonb 를 각자 해석한다. `adminMembersInfoStats` 는 `stale`/`version_mismatch` 도 사용하고 `rpc:members_info_stats_card_rows` 를 병행한다.
- **로스터 통계** — `cluster4_roster_card_stats` 우선, miss 시 snapshot cards 파싱 폴백(두 경로가 같은 값을 다르게 도출할 수 있음).
- **라인 개수 집계** — `/admin/line-opening/line-history` 는 요약 재사용이 아니라 raw 라인 카운트를 자체 집계하고 허브별 그룹 표로 성형한다.
- **주차 결과 완료 판정** — `crewWeeklyResultProjection`(완료 = org published 만, 시간은 집계창만) vs `weekOrgResultState`(status 3값) vs `weeks.result_published_at`.
- **인정 개수 임계값** — `weeks.check_threshold` 와 `org_week_thresholds` 가 별개 축으로 존재한다(후자는 R:1, writer 없음).

---

## 6. 테스트 모드가 별도 로직을 타는 경로

| 스위치 | 개입 지점 | 성격 |
| --- | --- | --- |
| `mode=test` | API 라우트 **46개** (`lib/userScope.ts` `resolveUserScope` / `parseScopeMode`) | 대상 선택만 바뀌고 확정 이후 판정은 동일 — 다만 `resolveOrgResultScope` 는 검수 상태 저장 scope 자체를 `test` 로 분기 |
| `actAsTestUserId` | 라우트 6개 + lib 16개 (`experienceImpersonation`) | 로그 actor 컨텍스트와 개설 게이트에 실제로 영향 |
| `demoUserId` | 라우트 16개 | 데모/일반 DTO 분기, 데모는 종업 정보 스킵 |
| `QA_HIDE_REAL_USERS` | `lib/qaFixedScope.ts` | 참이면 운영 화면 모집단이 테스터로 치환되고 검수 scope 가 `test` 로 강제 |
| `is_qa_test` | `cluster4_lines` 컬럼 | 테스트 라인 표시 플래그 |
| 주차 예외 | `cluster4TestWeekPolicy` (2026-spring W13) | 적립 era 경계의 테스트 전용 예외 |

적립 era 경계는 운영 정책 불변이다 — `operating` 은 `weeks.start_date >= 2026-summer W1` 만, `test` 는 여기에 W13 예외를 더한다. 그 외 주차(레거시·PMS)는 원장 미생성.

---

## 7. 조사 불가 · 신뢰도 LOW 항목 (16)

| 데이터 | 사유 |
| --- | --- |
| `user_cumulative_points` | `pmsPointlogsSync` 가 upsert 하나 이 레포에 읽기 소비처 0 — 크루 앱/프론트 계약 추정, 검증 불가 |
| `crew_personal_rest_periods` | 읽기 4곳, writer 없음 — 원천 미확인 |
| `weekly_league_*` 3종, `cluster4_weekly_ranking_exceptions`, `org_week_thresholds`, `operator_markers`, `official_rest_weeks`, `user_club_rank_frozen` | 읽기 전용, 어드민에 쓰기 경로 없음 — 생성 주체 미확인 |
| `user_week_grade_histories`, `user_activity_details`, `qa_weeks_state`, `career_records` | 쓰기·읽기 각 1곳이나 트리거 페이지 미확정 |
| `legacy_crew_import` | `/admin/import` 는 빈 화면 — 스크립트 경유 추정 |
| `cafe-comments` 저장 테이블 | 외부 크롤러 서비스 연동, 테이블 미확인 |

이 밖에 `writer_page=UNKNOWN` 인 항목이 17개 있다(테이블은 확정, 쓰기 화면 미확정).

---

## 8. 우선 검증이 필요한 고위험 경로 TOP 10

1. **주차 포인트 2계층 × writer 2개** — `user_weekly_points` = `legacy_*` 기준층 + 활성 award. `2026-07-26_uwp_legacy_baseline_columns.sql` 이 배포보다 먼저 적용돼야 하고, 미적용 시 폴백 경로를 탄다. 07-25 에 award 재계산이 레거시 포인트를 지운 회귀 전례가 있다. 소비처는 품계·랭킹·카드 전부.
2. **snapshot 신선도** — 크루 앱 주차 카드의 1차 원천이 `cluster4_weekly_card_snapshots` 인데 `vercel.json` 에 cron 이 없다. `is_stale`·`version_mismatch` 도 빈 화면 방지를 위해 **그대로 크루에게 노출**되므로, 재계산 트리거가 끊기면 옛 카드가 무기한 표시된다.
3. **주차 검수·공표 상태 3중 저장** — 전역(`weeks`) / 조직 확정(`cluster4_week_opening_configs`) / 조직×scope status(`cluster4_week_org_result_states`). 조직 행이 없을 때 `legacy` 폴백으로 status 를 추정하며 시각은 전부 null 이 된다. 세 저장소의 불일치가 "완료 표시 vs 미공표" 로 직결된다.
4. **`user_growth_stats` 캐시 stale** — 쓰기는 `/admin/operation-health-check` 수동 트리거 1곳뿐인데, 이력서 카드·주차 상태·경험 팀 총괄·정합 점검 4곳이 이 값을 읽는다. 자동 재계산 훅이 없다.
5. **`user_grade_stats` 죽은 캐시** — 쓰기 1곳 / 읽기 0곳. 품계는 요청마다 전 모집단 `user_weekly_points` 를 다시 랭킹한다. 완충은 TTL 30s 프로세스 메모리 캐시뿐이고, Vercel 다중 인스턴스라 전역 정합을 보장하지 않는다(설계상 best-effort로 명시).
6. **직책·클래스 override 적용 순서** — `effective = override ?? UPH` 가 카드·snapshot·매트릭스·이력서에 모두 걸려 있고 값이 snapshot v48 에 baking 된다. UPH 만 읽는 소비처가 있으면 조용히 갈라진다.
7. **휴식 승인의 원장 부수효과** — 휴식 승인/일괄승인이 `process_check_review_recipients` 와 `process_irregular_acts` 를 **삭제**한다. 즉 휴식 처리가 포인트 원장 입력을 바꾸는데, 이 연쇄가 화면에는 드러나지 않는다.
8. **`process_point_awards` 직접 삭제 4경로** — `adminCrewWeekLineSave` · `adminCompetencyLineSelect` · `adminExperienceLineSelect` · `processPointAccrual`. 앞 3곳은 삭제 후 `recomputeWeeklyPointsForUsers` 를 호출해 수렴하지만, 삭제가 `try/catch` best-effort 로 감싸여 있어 삭제 실패가 조용히 넘어가면 재계산이 그 기여분을 되살린다.
9. **읽기 경로의 쓰기 부수효과** — `lineMasterDriftGuard` 가 `GET /api/admin/lines/registrations` 처리 중 `line_registrations` 를 update 한다. `weekRecognitionResolve` 도 인정 미리보기(POST) 에서 `cluster4_week_opening_configs` 를 쓴다. 조회로 보이는 호출이 상태를 바꾼다.
10. **중복 URL 쌍** — `/admin/lines/register` ≡ `/admin/lines/info`, `/admin/processes/register` ≡ `/admin/processes/info`, `/admin/club-progress/weekly[/weekId]` ≡ `/admin/team-parts/info/weeks[/weekId]` 가 같은 컴포넌트를 마운트하고, `/admin/integrated/*` 8개는 re-export 별칭이다. 한쪽만 고치면 다른 URL 에서 옛 동작이 남는다.

### 추가 관찰(TOP 10 밖)

- 대량 조회에 `.in()` URL 길이 절벽과 PostgREST 1000행 cap 이 걸려 있어, snapshot 배치 읽기는 청크 50으로 낮춰져 있다. 실패 청크는 `status:"error"` 로 fail-soft 되며 무거운 실시간 폴백으로 빠지지 않는다 — 즉 **일부 사용자만 조용히 빈 값**이 될 수 있다.
- 쓰기 전용 감사 테이블 5개(`user_role_audit` · `role_permissions_audit` · `week_auto_action_log` · `qa_action_log` · `crew_code_log`)는 조회 화면이 없어 사고 후 추적이 SQL 직접 조회에 의존한다.
- `user_memberships` 는 읽기 22곳인데 쓰기가 `adminResumeCardData` 1곳뿐이다 — 등급/상태 변경이 이력서 카드 화면 경로에만 있다.

---

## 9. 조사 방법과 한계

**방법** — (1) `page.tsx` → import 그래프(components·lib) 전이 순회로 `/api/*` 참조와 HTTP 메서드 추출, (2) `route.ts` → 직접 `.from()`/`.rpc()` + depth-1 lib 의 테이블·연산 추출, (3) 테이블 역인덱스(reader/writer)로 다중 원천·다중 소비 후보 산출, (4) 후보를 소스 주석·구현으로 개별 확인.

**한계**
1. **정적 추적만** — 실제 HTTP 호출·DB 상태를 검증하지 않았다. 런타임 조건 분기(권한·org·주차 경계)로 실제로는 타지 않는 경로가 포함될 수 있다.
2. **컬럼 단위 정확도가 균일하지 않다** — `select("a,b,c")` 로 컬럼이 명시된 곳은 확정했으나, `select("*")` 이나 타입 경유 접근은 `source_column=UNKNOWN` 으로 남겼다. 테이블 111개 중 컬럼까지 확정한 것은 일부다.
3. **DB 함수 본문과 스키마는 미확인** — `rpc:apply_week_open_confirm`, `rpc:sync_cumulative_points_for_user`, `rpc:members_info_stats_card_rows` 의 내부 로직, 트리거·제약·RLS 는 레포 밖이라 판정에서 제외했다.
4. 크루 앱(별도 repo)의 소비 방식은 이 레포의 라우트 주석에 적힌 계약을 근거로 했고, 반대편 코드로 교차 확인하지 않았다.
5. depth-1 lib 테이블 귀속은 상한(그 lib 이 다루는 테이블 전체)이며, 특정 핸들러가 실제로 만지는 부분집합보다 넓을 수 있다.
