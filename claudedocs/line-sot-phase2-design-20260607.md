# 통합 라인 SoT 전환 Phase 2 — 조사·설계안 (2026-06-07)

> Phase 2A read-only 조사 결과 + 2B~2E 전환 로드맵 설계.
> **이번 Phase 에서는 코드/DB 변경 없음** — 조사 스크립트(read-only)와 본 문서만 산출.
> 원시 데이터: `claudedocs/line-sot-phase2-survey-20260607.json` (`scripts/diag-line-sot-phase2.ts`)

---

## 1. 현재 구조 요약

라인 데이터는 3계층:

```
[정의 계층]  허브별 분산 (4갈래 — 단일 SoT 아님)
  경험: cluster4_experience_line_masters (+ 입력→검수→개설 drafts)
  역량: cluster4_competency_line_masters
  경력: career_projects
  정보: (정의 테이블 없음 — activity_types 는 "활동 유형" 축)
[인스턴스 계층]  cluster4_lines 단일 (4허브 공통, part_type 구분)
  └ cluster4_line_targets (배정) └ cluster4_line_submissions (제출)
[신규 레지스트리]  line_registrations (additive, 기존 코드 참조 0건 — 완전 격리)
```

- 고객 노출·snapshot·강화율 분모는 전부 **인스턴스 계층(targets inner-join)** 기준.
- 정의 계층은 어드민 개설 화면의 선택지 + 개설 시 검증/메타 원천.
- `line_registrations` 는 현재 `/admin/lines/register` 페이지와 그 API 만 사용.

## 2. 허브별 SoT 표 (데이터 건수 = 2026-06-07 운영 실측)

| 허브 | 정의 SoT | 건수 | 개설 인스턴스 (cluster4_lines) | 개설 플로우의 기준 SoT |
|---|---|---|---|---|
| 실무 경험 | cluster4_experience_line_masters | **26** (active 26) + drafts **4** | part_type='experience' **225** | POST `experience-lines` 가 master id 존재·is_active 검증 후 라인 생성. drafts/open 도 master FK 필수 |
| 실무 역량 | cluster4_competency_line_masters | **30** (active 30) | part_type='competency' **3** | POST `competency-lines` 가 master 조회 후 라인 생성 |
| 실무 경력 | career_projects | **1** | part_type='career' **1** | POST `career-lines` 가 career_projects 조회 후 라인 생성(career_project_id FK) |
| 실무 정보 | 없음 (activity_types **9** = 유형 축) | — | part_type='info' **135** | POST `info-lines` 가 activity_type + 서버 강제 N-1 주차로 직접 생성 (마스터 무관) |
| 신규 | line_registrations | **13** (전부 검증 더미) | — | 어떤 개설 플로우도 미참조 |

보조: cluster4_line_targets **1,233** · cluster4_line_submissions **1,161** · snapshots **122**(stale 0)

## 3. API 사용처 표

| 구분 | API | 참조 SoT |
|---|---|---|
| 어드민(개설/마스터) | `cluster4/lines`(+[id]/targets/workflow/history), `cluster4/targets/[id]` | cluster4_lines·targets |
| | `cluster4/info-lines` · `experience-lines` · `competency-lines` · `career-lines` | lines + 각 정의 SoT |
| | `cluster4/experience-line-masters`(+[id]) · `experience-drafts`(+review/open) · `experience-workflow-summary` | exp 마스터·drafts |
| | `cluster4/competency-line-masters`(+[id]) | comp 마스터 |
| | `career-projects`(+[id]/weeks/sponsor-meta) · `cluster4/career-line-options` · `career-evaluations` | career_projects |
| | `cluster4/activity-types` | activity_types(+lines 카운트) |
| | `cluster4/recompute-*-snapshots` · `sync/experience-growth` · `crews/.../weekly-growth/sync` · `applicants/[id]/approve-new` | lines/targets (lib 경유) |
| 고객/데모 (admin repo) | `/api/cluster4/weekly-cards` · `weekly-growth` · `lines/detail` · `lines/[lineTargetId]/submission` | 전부 targets inner-join 경유 |
| 고객 repo(../vraxium) **DB 직조** | `/api/activity-details` · `/api/cluster4/lines/detail`·`/submission` | cluster4_line_targets+lines!inner |
| | `/api/career-records` · `/api/cluster-4-ranking` | career_projects |
| 신규 | `/api/admin/lines/registrations` (GET/POST) | line_registrations 단독 |

## 4. 프론트 화면 사용처 표

| 화면 | 참조 |
|---|---|
| `/admin/line-opening/practical-info·experience·competency·career` | 각 정의 SoT + lines |
| `/admin/line-opening/line-history` (라인 정보) | cluster4_lines 단독 (브라우저 확인 — 레지스트리 행 노출 **0건**, `browser-line-history-phase2.png`) |
| `/admin/career-projects` | career_projects |
| `/admin/lines/register` | line_registrations 단독 (등록된 라인 목록 화면 반영 확인) |
| 고객 `/cluster-4`·`/cluster-4-1`·이력서·랭킹·활동상세 | targets 경유 — 타깃 0개 row 도달 불가 |

## 5. snapshot 영향 표 (실측)

| 축 | 결과 |
|---|---|
| 생성(buildWeeklyCardsSnapshot) | targets inner-join + 마스터/career 메타 lookup — line_registrations 참조 **0건** |
| 조회(readWeeklyCardsSnapshot) | cluster4_weekly_card_snapshots 단독 |
| 무효화 트리거 | 라인 PATCH·타깃 변경·워크플로만 (insert/조회 무관) |
| demoUserId vs 일반 | 동일 코드 경로(loadWeeklyCards) — demoUserId 는 인증 우회+조회 대상 override only. **차이 없음** |
| fingerprint (조사 전/후) | `{snapTotal:122, snapStale:0, lines:364, targets:1233}` **동일** — 재계산 불필요 |
| direct vs HTTP | registrations: direct 13 = HTTP 13, rows JSON **완전 일치**. lines/history: direct 364 = HTTP 364, rows **일치** (limit=5 비교. limit=20 direct 는 스크립트 런타임 undici 의 대형 `.in()` URL 한계로만 실패 — 운영 서버 런타임 정상) |

## 6. 기존 데이터 → line_registrations 매핑표

| 원천 컬럼 | → line_registrations | 비고 |
|---|---|---|
| **exp_masters** line_code / line_name | line_code / line_name | 그대로 |
| default_main_title | main_title (`fixed`) / NULL→`variable`+'-' | |
| experience_category(영문 5종) | line_type 한글 매핑 | derivation→도출, analysis→분석, evaluation→평가, management→관리, extension→확장 |
| organization_slug | **컬럼 부재** | ★ 신규 컬럼 필요 (2C 선행) |
| team_id / experience_slot_order / source_file_name | **컬럼 부재** | slot_order 는 경험 4넘버 정렬 축 — 컬럼 추가 또는 미러 유지 |
| **comp_masters** line_code / line_name / main_title | line_code / line_name / main_title(`fixed`) | |
| (라인 종류 원리/기술/관점/자원) | **원천 부재** | ★ 30건 수동 분류 필요 (line_name "[실무 Principle.N]" 휴리스틱 보조) |
| organization_slug | **컬럼 부재** | ★ 동일 |
| **career_projects** line_code / line_name | line_code / line_name | line_type='일반' |
| default_main_title | main_title / NULL→variable | |
| company_name / company_logo_url | partner_company / company_logo_url | |
| supervisor_name / position / department | manager_name / manager_position / manager_job | 기존 화면도 department=직무 의미로 사용 |
| supervisor_profile_img (업로드 URL) | manager_profile_key (토큰 6종) | ★ 타입 불일치 — URL 보관용 `manager_profile_img` 컬럼 추가 권장 |
| start/end_date · default_output_* · default_target_user_ids · organization_slug | **컬럼 부재** | 개설 기본값 축 — 2C 설계에서 필요분만 추가 |
| **info (activity_types)** | 이관 대상 아님 | 라인 정의가 아니라 유형 축(9종). info 정의는 신규 등록부터 — `activity_type_id` 연계 컬럼만 추가 검토 |
| (공통) unit_link | '-' 기본 | 원천에 대응 개념 없음 |

**결론: 매핑 가능. 단 organization_slug(전 허브)·comp 라인 종류(수동 30건)·career 프로필 URL 3개 갭은 사전 마이그레이션/분류 작업 필요.**

## 7. 위험 요소

1. **org 차원 부재 (최대 리스크)** — exp/comp 마스터의 `organization_slug` 는 강화율 분모A org 판정(`collectLineOrgAudience`)과 weekly-cards Step1/2 노출 필터의 SoT. registrations 에 org 가 없는 채로 개설 플로우를 전환하면 **fail-closed → 라인 비노출/분모 누락**. 2C 전에 org 컬럼 추가 필수.
2. **EXBS-\* 코드의 3-org 복제 모델** — exp 마스터는 (line_code, organization_slug) 복합 식별(EXBS-EL0001~4 가 org 3곳에 각 1행, 실측 code 중복 ×3·code+org 중복 0). registrations 는 line_code 단독 unique 미강제 — 이관 시 복합키 채택 필요.
3. **comp 라인 종류 원천 부재** — 수동 분류 30건 (자동화 불가, 운영 확인 필요).
4. **career 프로필 타입 불일치** — 업로드 URL vs placeholder 토큰.
5. **exp drafts 워크플로 결합** — drafts.experience_line_master_id NOT NULL FK. 2C 에서 registrations 참조로 바꾸려면 drafts 스키마 변경 필요 → 2C 는 "registrations → 마스터 find-or-create" 브리지 방식으로 FK 보존 권장.
6. **snapshot 메타 lookup 결합** — weekly-cards 가 line 의 master FK(experience/competency_line_master_id·career_project_id)로 메타·org 를 읽음. 개설 시 FK 기록을 끊으면 안 됨(2E 전까지 유지).
7. **line-history 의 lineName=main_title 재사용** — 2B 통합 조회에서 registrations.line_name 과 의미 충돌(변동 라인 '-' 표시 문제). 통합 DTO 에 source·lineName 분리 필드 필요.
8. **검증 더미 13건** — 이관 전 정리 필수 (`검증 *`/`UL검증 *`/`브라우저 *` 패턴).
9. **PostgREST 대형 `.in()`/1000행 cap** — 이관·통합 조회 스크립트는 order+range 페이지네이션 필수 (이번 조사에서 스크립트 런타임 실패 재현).
10. 조사 중 line_registrations 건수 변동(11→13) — 운영자가 등록 페이지 사용 중인 것으로 추정. 이관 시점 스냅 고정 필요.

## 8. 추천 전환 로드맵

| Phase | 내용 | DB 변경 | 기존 경로 영향 | snapshot |
|---|---|---|---|---|
| **2A (완료)** | read-only 조사 — 본 문서 + survey JSON | 없음 | 없음 | 무영향 (fingerprint 동일 실측) |
| **2B** | 통합 조회: 신규 read-only `GET /api/admin/lines/catalog` (4허브 정의 SoT ∪ line_registrations, `source: master\|registration` 태그·code+org dedup) + `/admin/lines/info`(라인 정보 신규 화면 또는 기존 화면 탭) | 없음 | 없음 — 신규 GET/화면만 추가, 기존 API 무수정 | 무영향 |
| **2C** | 개설 플로우 참조 시작 — 허브별 개설 드롭다운에 등록분 노출. 선택 시 **registrations → 해당 허브 마스터 find-or-create 브리지** 후 기존 개설 플로우 그대로 (FK·org 판정·drafts 경로 전부 보존) | registrations 에 `organization_slug`(+필요 시 team/slot/activity_type) 컬럼 append 1회 | 기존 마스터 직접 등록 경로는 병행 유지 | 무영향 (인스턴스 생성 경로 불변) |
| **2D** | 데이터 이관 — exp 26·comp 30·career 1 → registrations 백필 (dry-run→apply, (line_code, org) 멱등 키, comp 종류 수동 분류표 선행, 더미 13건 정리 선행). info 는 이관 없음(정의 부재) | 백필 insert only | 기존 마스터는 그대로(읽기 병행) | 무영향 |
| **2E** | 마스터 deprecated — 개설 플로우·org 판정(collectLineOrgAudience)·weekly-cards 메타 lookup 을 registrations 기준으로 교체, 마스터는 read-mirror→쓰기 차단→정리. **이 단계만 snapshot 경로 코드를 건드림** | 마스터 deprecated COMMENT→(안정기 후) 정리 | 전환 본체 — 등가성 검증(direct vs HTTP·판정 diff 0) 필수 | org 판정 결과가 전건 동일하면 재계산 불필요, diff 발생 시 `recompute-snapshots` 1회 |

각 Phase 는 독립 배포·롤백 가능. 2B/2C 는 additive 라 실패 시 신규 경로 제거만으로 복귀, 2D 는 백필 로그 보존, 2E 만 등가성 게이트 필요.
