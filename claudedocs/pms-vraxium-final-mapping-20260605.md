# pms-migration(MySQL) → Vraxium(Supabase) 최종 컬럼 매핑표

> **작성일**: 2026-06-05 (분석/설계 전용 — 데이터 이관 없음)
> **소스 기준 (양쪽 모두 실물 기준, 문서 아님)**
> - pms: 12개 테이블 **CREATE TABLE DDL + 샘플 데이터** (2026-06-05 확보, Oranke DB) + 기존 확보분(users/usersinfo/userspoint/useraccounts/usersmoreinfo/members/pointlogs/useractivities/rest*/graduate*/checklist*/trackinglinks/essaylinks)
> - Vraxium: **2026-06-05 라이브 스키마** (PostgREST OpenAPI 직조회, `claudedocs/live-schema-dump-20260605.json`) + 라이브 weeks/seasons/season_definitions 실데이터 조회
>
> **이번 라이브 교차검증으로 확정된 사실**
> | 항목 | 확인 결과 |
> |---|---|
> | 라이브 weeks 커버리지 | **42행**: 2025-autumn(17) · 2026-winter(9) · 2026-spring(16). 2025-09-01 이전 없음 |
> | 라이브 check_threshold | **전부 NULL** → 판정 시 기본 30 적용 중 |
> | pms confirmStar | 봄 10~13주차 **37** — 라이브 기본값 30과 **불일치 확정** |
> | season_definitions | 2021-spring~2029-autumn 37건 완비 (season_key 체계 준비됨) |
> | seasons(uuid) | **1행만** ("2026년도 봄시즌") — weeks.season_id NOT NULL 이므로 과거 시즌 행 백필 필수 |
> | 주차 번호 정렬 | pms "봄 10주차"=2026-05-04 ↔ 라이브 2026-spring 10번째 주=05-04 **일치** (datebased 매칭 성립) |
> | result_published | 2025-autumn 17/17 · 2026-winter 9/9 · 2026-spring 12/16 확정 완료 |
>
> 표기: ✅ 바로 이관 / 🔄 값 변환 후 이관 / 🧮 신규 계산 필요 / ⛔ 이관 제외 / 🆕 스키마 추가 필요 / 🔍 데이터 프로파일링으로 의미 확정 필요
>
> **[개정 2026-06-05] A1/A2 프로파일링 결과 반영 — 포인트 도메인 확정**
> | # | 확정 사항 |
> |---|---|
> | A1-① | **pointlogs(IsDeleted=0) = 유일한 포인트 원장** (416,307 alive 행). 집계 단일 소스 |
> | A1-② | managerdatas = **승인 큐(스테이징)**. Confirm='확인 완료' 27,708건은 99.98% pointlogs 에 복제됨 (미매칭 6건도 Code 제외 시 100%) → **합산 금지 (이중 계산)** |
> | A1-③ | AgentConfirm 은 게시와 무관한 별도 검수 플래그 — 잔액 계산에서 무시 |
> | A1-④ | **Shield 잔액 = 5 + Σ pointlogs.Shield** (변동 무이력 14명 전원 잔액 5 — 기본값 확정). IsHide 는 잔액과 무관(표시 플래그) |
> | A1-⑤ | 주차 귀속 = **ActivityTime** (createtime 은 입력 시점 — 결산 지연 입력 시 주차 오귀속) + EndDate 00:00 저장 보정(`< EndDate+1day`) |
> | A2-① | 실사용자 99명 중 **83명(84%) 잔액↔원장 드리프트** (Star 최대 ±26) — 원인: Star 삭제 시 잔액 미복원(27명 확정) / "+8 무기록 지급" 코호트(19명) / 수동 조정 |
> | A2-② | **migration adjustment 보정 로그 필요** (잔액=운영상 진실, 원장+보정=잔액 구조) — §5-2 설계 |
> | A2-③ | 비활동(졸업/정지) 1,270명은 드리프트 큼 — 잔액 스냅샷 우선, 원장은 참고용 (범위 정책 미결) |
> | A2-④ | Dry Run 1명 = **UserId 1092 장승완** (모든 보정 분기 보유) + 대조군 1299/완전일치 1명 — §12 설계 |
>
> **[개정 2026-06-05 #2] A3 프로파일링 결과 반영 — 주차 인정/결산 의미 확정**
> | # | 확정 사항 |
> |---|---|
> | A3-① | confirmStar 비교 대상 = **NET Star** (gross 아님) — §5-1 경계 케이스 항목 해소 |
> | A3-② | 주차 인정 기준값 = **weekssettings.confirmStar** → weeks.check_threshold 확정 |
> | A3-③ | seasondates.**PassingScore 는 주차 인정에 불사용** — ⛔ 확정 (§1-1) |
> | A3-④ | pms 결산 Star 집계 = **net_all (삭제 로그 포함)** — alive-only 아님. IsDeleted=0 필터는 잔액(Shield) 도메인에만 유효 |
> | A3-⑤ | 취소 구조 = 삭제 원본(+X, IsDeleted=1) + alive "취소 반영" 역로그(−X) 상쇄 쌍 — **alive만 가져오면 역로그만 남아 이중 차감 왜곡** |
> | A3-⑥ | **신입 14일 보호**: usersinfo.StartDate+14일 이전 ActivityTime 의 음수 Star 는 0 처리 |
> | A3-⑦ | code **'0000' 신입 보충 로그 = 실지급 원장 행** — 제외 금지 |
> | A3-⑧ | usersinfo.Week = 결산 시 COUNT(useractivities WHERE IsActive=1) **절대 재계산** (+1 누적 아님). 현재 불일치 15명 존재 — §11 처리 정책 |
> | A3-⑨ | reportlogs = 감사 로그 (직접 SoT 아님) — 검증 입력 역할 유지 |
> | A3-⑩ | 시즌명 표기 변형/오타 실존 ('가을 시즌'/'가을시즌'/'가을 '/'거울'…) — §2 정규화 사전 필수 |

---

## 1. 최종 컬럼 매핑표

### 1-1. 시간 차원 (이관 전체의 선행 조건)

#### `weekssettings` (76행) — 주차 결산 설정. **Vraxium weeks 의 결산 속성 소스**

| pms 컬럼 | DDL | 의미 | Vraxium | 판정 | 비고 |
|---|---|---|---|---|---|
| Id | int PK (+중복 UNIQUE) | identity | — | ⛔ | 76행 vs AI=114 — 삭제 결번 존재, 무결성 점검 |
| season | varchar(45) "봄" | 시즌명 (연도 없음) | weeks.season_key | 🔄 | StartDate 로 연도 추론 → season_definitions 룩업 ("봄"+2026-05 → `2026-spring`) |
| week | varchar(45) "13" | 시즌 내 주차 번호 (문자열) | weeks.week_number (smallint) | 🔄 | 숫자 파싱, 비숫자 행은 보류 큐 |
| StartDate | datetime | 주차 시작(월) | weeks.start_date + started_at | 🔄 | date 절단 + KST tz 부여. **기존 42행과 겹치면 update, 이전 주차는 insert** |
| EndDate | datetime | 주차 종료(일) | weeks.end_date + ended_at | 🔄 | 〃 |
| **confirmStar** | int (37) | **주차 인정 check 기준값 (A3-② 확정)** | **weeks.check_threshold** | 🔄 | 라이브 전부 NULL(→30)인데 실제 기준은 37 — **주차별 명시 세팅 필수**, 기본값 의존 금지. 비교 대상은 NET Star (A3-①) — v18 게이트 `points >= threshold` 와 의미 일치 (§5-1) |
| IsPublic | tinyint(1) | 결산 공개 여부 | weeks.result_published_at | 🔄 | boolean→timestamptz: 1 → EndDate 익일 00:00(KST) 관례값 또는 이관 시각(정책 결정), 0 → NULL. **publish 는 비가역(409) — 세팅 순서 주의** |

#### `seasondates` (142행) — 시즌 달력/휴식 정의. **weeks 의 달력·휴식 속성 소스**

| pms 컬럼 | DDL | 의미 | Vraxium | 판정 | 비고 |
|---|---|---|---|---|---|
| SeasonName | varchar(50) "봄 시즌" | 시즌명 | weeks.season_key (+seasons/season_definitions 매칭) | 🔄 | "봄 시즌"→spring + 날짜 연도 추론. season_definitions 는 이미 완비라 신규 행 불필요 |
| Week | varchar(50) "봄 시즌 16주차 자율 휴식" | **자유 레이블** | weeks.holiday_name (표기 보존) | 🔄(보존)/⛔(파싱) | **레이블 파싱으로 판정 금지** — 306번 사례: 레이블 "자율 휴식"인데 IsRestWeek=0. 판정은 플래그, 표기는 holiday_name 보존 |
| StartDate/EndDate | date | 주차 기간 | weeks.start_date/end_date | 🔄 | weekssettings 와 **날짜 기준 머지** (충돌 시: 결산 속성=weekssettings 우선, 달력·휴식=seasondates 우선) |
| Comment | varchar(1000) | 메모 | weeks.holiday_name 또는 ⛔ | 🔄 | 휴식 사유성 텍스트만 |
| IsRestWeek | tinyint(1) | 공식 휴식 주차 | **weeks.is_official_rest** | 🔄 | 휴식 판정 SoT 는 weeks.is_official_rest 단독 (uws 파생 플래그 금지 정책과 정합) |
| PassingScore | int | 주차 인정에 **불사용 (A3-③ 확정)** | — | **⛔ 확정** | check_threshold 소스는 confirmStar 단독. payload 보존만 (legacy_event_logs 경유 불필요 — weeks 백필 리포트에 원본 기록) |

#### seasons(uuid) 백필 — pms 테이블 아님, 선행 작업

- weeks.season_id NOT NULL ← seasons 행이 1개뿐. pms 데이터가 걸친 시즌(최소 2021-spring~2026-spring) 만큼 seasons 행 생성 (season_definitions 의 라벨·기간 재사용). 🧮

### 1-2. 활동/결산

#### `manageractivities` (8,048행) — 주차 활동 (현행 세대, 최신=봄13주차 2026-05-25)

> 🔍 **선결 확인**: useractivities 와의 관계 (기간 겹침/세대 교체/대상자 분리) 를 데이터로 확정 후, 동일 변환 파이프라인에 source 구분자만 달리해 투입. 이하 매핑은 useractivities 에도 동일 적용.

| pms 컬럼 | DDL | 의미 | Vraxium | 판정 | 비고 |
|---|---|---|---|---|---|
| ActivityId | int PK | identity | (legacy ledger 의 source_pk) | ⛔/🆕 | 멱등 키로만 |
| UserId | int (FK·인덱스 없음) | 사용자 | users.legacy_user_id → uuid | 🔄 | 고아 행(삭제 사용자) 사전 검출 — FK 부재로 정합 미보장 |
| Activity | longtext | 활동 내용 | cluster4_line_submissions.growth_point(원문)+subtitle(요약) | 🔄 | v17 [통합] 라인 제출물. 원문 무손실 보존 우선 |
| StartDate/EndDate | datetime (DEFAULT NOW) | 주차 기간 | (weeks 매칭 보조키) | ⛔ | week_id 로 흡수. DEFAULT NOW 오염 가능 — Season/SeasonWeek 우선, 날짜는 보조 |
| Star | int 0~10 | 주차 평점 | cluster4_experience_line_evaluations.rating | 🔄 | v17 판정: 4↑=강화 성공. **당시 값 그대로 — 재산정 금지** |
| Season + SeasonWeek | varchar + int | 주차 귀속 | cluster4_line_targets.week_id (+uws 키) | 🧮 | (season명+연도 추론, week int) → weeks 룩업 |
| UserWeek | int | 당시 누적주차 스냅샷 | — | ⛔(검증용) | recalc 결과 대조 기준 |
| IsActive | tinyint(1) | 주차 인정 여부 | user_week_statuses.status ('success'/'fail') | 🔄 | uws=주차 SoT. 🔍 AgentConfirm/IsDone 과의 우선순위 룰 확정 필요 |
| UserLevel/UserPart/UserTeam/UserName | varchar | **당시 스냅샷** | legacy ledger payload (jsonb) | 🆕 | §6 — 현재값 재계산 절대 금지 |
| IsDone / CompletedTime | tinyint/datetime | 처리 워크플로 | — | 🆕(보존)/⛔ | 레거시 통합 라인은 draft 워크플로 미사용 — 원장 보존만 |
| CreateTime | datetime | 기록 시각 | legacy ledger occurred_at | 🆕 | |
| AgentConfirm | varchar '확인 전'/'확인 완료' | 운영진 확인 | — | 🔍→🆕(보존) | **집계 포함 조건 후보** — IsActive 와 조합 분포 확인 후 룰 확정 |

#### `managerdatas` (27,130행) — **승인 큐(스테이징). 집계 금지 확정 (A1)**

> **A1 확정**: Confirm='확인 완료' 27,708건은 pointlogs 에 99.98% 복제 게시됨 (Title→log, Etc→Info, Code→code, ActiveDate→ActivityTime, CreatedDate→createtime[승인 시점, 수십초~수분 후]). **user_weekly_points 집계에 포함 시 27,702건 이중 계산 — 합산 금지.** 역방향: pointlogs alive 416,307건 중 managerdatas 유래 6.7%뿐 (93%는 카페/투표/활동 자동집계).

| pms 컬럼 | DDL | 의미 (A1 확정) | Vraxium | 판정 | 비고 |
|---|---|---|---|---|---|
| (전 행, Confirm='확인 완료') | 27,708건 | pointlogs 게시 완료된 승인 이력 | **legacy_event_logs** (source_table='managerdatas') | 🆕(보존)·**집계 ⛔** | "누가 언제 승인했나" 감사 가치만. pointlogs 행과의 연결 자연 키는 동일사유 동일일 중복 시 모호 — **원본 Id·LogNum 을 각자 legacy_id 로 보존**하는 방식 채택 (A1-③ 권고) |
| (전 행, Confirm='확인 전') | **1,215건 펜딩** | 원장·잔액 미반영 승인 대기 | — | 🔍 운영 결정 | ① 컷오버 전 pms 에서 승인/반려 **소진(권장)** ② legacy_event_logs 에 status='pending' 보존(증발 방지). Vraxium 에 승인 큐 도메인 없음 — 기능화는 별도 과제 |
| Id | int PK (+중복 UNIQUE) | identity | event_logs source_pk | 🆕 | 멱등 키 |
| Title / Etc / Code / Creater | varchar | 사유/메모/코드/발행자 email | event_logs payload | 🆕 | Code 사전은 pointlogs.code 와 공용 |
| Star / Shield | int signed | 증감 (게시 시 pointlogs 복제) | — | **⛔(집계)** | 집계는 pointlogs 단일 소스 (§5-1) |
| UserId | int (인덱스 없음 — NULL/고아 0건 클린 확인) | 대상자 | uuid bridge | 🔄 | |
| UserName / TeamName / UserTeam | varchar | 당시 스냅샷 | event_logs snapshot jsonb | 🆕 | 보존만 하면 의미 차이 무해 |
| Confirm | varchar | **원장 게시 여부 (잔액 직결)** | event_logs payload | 🆕 | 펜딩 분기 키 |
| AgentConfirm | varchar | 게시와 무관한 별도 검수 플래그 | event_logs payload | 🆕·**잔액 계산 무시** | 확인 전+Agent완료 722건 / 반대 3,364건 — 교차 확인됨 |
| CreatedDate / ActiveDate | datetime | 기록(승인)/발효 시각 | event_logs | 🆕 | 주차 귀속은 pointlogs.ActivityTime 기준 — 본 테이블 불사용 |

#### `reportlogs` (13,160행) — 결산 감사 로그 ("누적 주차 변경 5 => 6")

| pms 컬럼 | 의미 | Vraxium | 판정 | 비고 |
|---|---|---|---|---|
| UserId/UserName | 대상자+스냅샷 | legacy ledger | 🆕 | |
| Season + Week(int) | 결산 주차 | (검증 키) | ⛔(직접) | 연도는 Created 로 추론 |
| Log | "누적 주차 변경 {old} => {new}" | — | 🧮(검증 입력) | **이관 안 하지만 검증의 핵심**: ① 사용자별 최종 "=> N" ↔ usersinfo.Week 대조 ② 변경 발생 주차 집합 ↔ uws success 집합 ↔ IsActive 3중 대사 ③ approved≤cumulative 위반 원인 추적 |
| Created | 결산 시각 | legacy ledger occurred_at | 🆕 | |

### 1-3. 시즌 전환/휴식/팀

#### `seasonchangeusers` (1,629행) — 시즌 전환 신청/배치

| pms 컬럼 | 의미 | Vraxium | 판정 | 비고 |
|---|---|---|---|---|
| UserId | 대상자 | user_season_statuses.user_id | 🔄 | |
| Name/Team/Part | 당시 스냅샷 | legacy ledger payload | 🆕 | 재계산 금지 |
| info | 신청 메모 | user_season_statuses.note | 🔄 | |
| IsRest | tinyint nullable (1=시즌 휴식) | user_season_statuses.status | 🔄 | 1→'rest' 계열, 0→활동 지속. **NULL 행 분포 확인** 🔍. status 허용값은 기존 writer 코드 기준으로 맞출 것 |
| CreatedAt/UpdatedDate | 신청 시각 | user_season_statuses.requested_at | 🔄 | **season_key 컬럼이 pms 에 없음** → CreatedAt 으로 "다가오는 시즌" 추론 (02-26~03-01 → 2026-spring). 시즌 경계 ±2주 밖 행은 보류 큐 |

#### `seasonrestlogs` (314행) — 시즌 휴식 등록 이력

| pms 컬럼 | 의미 | Vraxium | 판정 | 비고 |
|---|---|---|---|---|
| UserId | 대상자 | user_season_statuses (보강) + uws 전개 | 🔄 | seasonchangeusers IsRest=1 과 **(user, season) 단위 dedupe** |
| UserName | 스냅샷 (최근 행 NULL) | legacy ledger | 🆕 | NULL 은 결측 그대로 보존 (UserId 로 충분) |
| SeasonInfo | longtext "시즌휴식등록" | note | 🔄 | |
| StartDate | 휴식 시작 | uws 전개 시작 주차 | 🔄 | |
| **EndDate** | datetime — **'0001-01-01' sentinel** | uws 전개 종료 주차 | 🔄 | **§4 sentinel 규칙**: <1900-01-01 → NULL → "해당 시즌 종료일로 캡" 해석 |

#### `seasonteamdatas` (93행, 2025-12-26 1회분) — 시즌 전환 팀 이동

| pms 컬럼 | 의미 | Vraxium | 판정 | 비고 |
|---|---|---|---|---|
| UserId/Name/Contact | 대상자+스냅샷 | legacy ledger | 🆕 | |
| PreTeam / CurrentTeam | 이전/현재 팀 | — (대응 없음) | 🆕(보존) | user_memberships 는 시즌 차원 없음(is_current 단일), area-8 도 현재 fallback 단일 구조 — **시즌×팀 정규 테이블은 화면 소비처가 생길 때 신설**, 지금은 ledger 보존으로 충분 |
| CreatedAt/UpdatedAt | 전환 시각 | ledger occurred_at | 🆕 | 1개 시즌 전환분만 잔존 — 전 시즌 이력 재구성 불가함을 명시 |

### 1-4. 이관 제외 확정 (재평가 결과)

#### `userscurriculum` (4행) / `uploadedfiles` (6행) — §7 재평가

| 판단 근거 | 결론 |
|---|---|
| 2023년 데이터뿐, 이후 미사용. UserId 1(홍길동=테스트 추정)·40 두 명. Text 는 Quill Delta JSON(렌더러 없음), 파일은 DB 에 파일명만(실체 미확인) | **⛔ 이관 제외 확정** — Vraxium 대응 도메인 없음 + 운영 가치 없음. MySQL 덤프 원본 아카이브로 보존. uploadedfiles 실파일은 아카이브 시점에 존재 여부만 기록 |

#### `projectlist` (21행) — 부분 보존

| pms 컬럼 | 의미 | Vraxium | 판정 | 비고 |
|---|---|---|---|---|
| ProjectName/StartDate/EndDate | 실무 프로젝트 참가 기간 | — | 🆕(보존) | career_projects 로의 변환은 **보류** — career 도메인은 운영 커리어 라인(마스터+주차+평가) 체계로 의미가 다름. 컬럼명 유사 매핑 금지 원칙 |
| IsNoPenalty | 페널티 면제 | — | 🧮(검증 입력) | **§5 포인트 대사에서 면제 기간 중 penalty 행 부재를 설명하는 입력** |
| UserId/UserName/UserTeam/UserPart | 대상자+스냅샷 | legacy ledger | 🆕 | 유일하게 FK 보유 — 고아 행 없음 보장 |

#### `graduatelogs` (213행)

| pms 컬럼 | 의미 | Vraxium | 판정 | 비고 |
|---|---|---|---|---|
| UserId + Info('졸업절차시작' 등) + Writer + CreatedAt | 졸업 절차 이력 | legacy ledger | 🆕(보존) | 상태값 자체는 graduateusers→user_profiles.status/growth_status 경로(기존 분석 유지). 🔍 Info 값 종류 분포 확인 |
| UserName/UserTeam/UserPart/UserLevel | 당시 스냅샷 | legacy ledger payload | 🆕 | |

### 1-5. 기존 확보분 매핑 — 이번 DDL 로 갱신된 부분만

| 기존 가설 | 재검증 결과 |
|---|---|
| "weekssettings → weeks 행 백필" | **확정 + 강화**: confirmStar→check_threshold, IsPublic→result_published_at 까지 결산 속성 전체 매핑 가능 |
| "seasondates → seasons+season_definitions 백필" | **수정**: season_definitions 는 라이브에 2021~2029 완비 — 백필 불필요. seasondates 는 **weeks 의 달력·휴식 속성 소스**로 역할 변경. seasons(uuid)만 백필 |
| "manageractivities = 운영진 활동 (추정)" | **수정**: 일반 크루의 현행 주차 활동 테이블 (운영진이 입력/확인하는 구조, 샘플 전원 일반 크루). useractivities 와의 세대 관계만 확인하면 [통합] 라인 파이프라인에 동일 투입 |
| "managerdatas = 운영진 결산 (추정)" | **2차 수정 (A1 확정)**: **승인 큐(스테이징)** — 확인 완료분은 pointlogs 에 복제 게시. 집계 금지, 감사 이력으로만 보존 |
| "reportlogs = pointlogs 근거 (추정)" | **수정**: 누적 주차 결산 감사 로그 — 포인트가 아니라 **cumulative_weeks 검증의 SoT 급 입력** |
| "seasonchangeusers/seasonrestlogs → user_season_statuses" | **확정** (컬럼 단위 매핑 위 표) — 단 season_key 추론·dedupe·sentinel 규칙 필요 |
| "seasonteamdatas → user_season_teams 신설" | **완화**: 93행 1회분뿐 — 정규 테이블 신설 대신 ledger 보존 |
| "userscurriculum/uploadedfiles ⛔ 추정" | **확정 ⛔** (4행+6행, 2023, 테스트성) |
| "projectlist → career_projects 후보" | **기각**: 의미 불일치 — 보존+검증 입력으로 변경 |
| 포인트 잔액 검증: "pointlogs 단일 원장 가정" | **확정 (A1)**: pointlogs(IsDeleted=0, alive 416k) 단일 원장. managerdatas 는 스테이징 — 2원장 가설 기각 |

(users/usersinfo/userspoint/useraccounts/usersmoreinfo/members/restdates/restlogs/restchangelogs/graduateusers/checklists/trackinglinks/essaylinks 매핑은 `pms-vraxium-migration-mapping-20260605.md` §1 과 동일 — 변경 없음)

---

## 2. 주차 표현 체계 정리 (4종 + Vraxium)

| 소스 | 형식 | 예 | 연도 정보 | 정규화 경로 |
|---|---|---|---|---|
| weekssettings.week | varchar 숫자 + season | "봄"+"13" | 없음 (StartDate 로 추론) | **날짜 우선**: StartDate → weeks.start_date 매칭 |
| seasondates.Week | 자유 레이블 | "봄 시즌 16주차 자율 휴식" | 없음 (StartDate 로 추론) | **파싱 금지** — 날짜 매칭 + IsRestWeek 플래그. 레이블은 holiday_name 보존 |
| reportlogs.Week | int + Season | "봄"+13 | 없음 (Created 로 추론) | (season_type, 연도, week_number) → weeks 룩업. Created≈결산 직후 가정은 표본 검증 |
| manageractivities.SeasonWeek | int + Season | "봄"+13 | 없음 (StartDate/CreateTime 보조) | 〃 + '시즌미입력' 기본값 행 보류 큐 |
| userscurriculum.Week | 자유 텍스트 불규칙 ("가을 시즌2주차") | — | — | 이관 제외라 무시 |
| **Vraxium weeks** | (season_key, week_number) + start_date(월)~end_date(일) + iso_year/iso_week | 2026-spring W10 = 05-04 | season_key 에 내장 | **canonical key = start_date** |

**통합 규칙**
1. 날짜를 가진 소스(weekssettings/seasondates/manageractivities.StartDate)는 date-range 매칭이 1순위 — pms·Vraxium 주차 번호 정렬이 2026-spring 에서 일치 확인됐으나, **시즌별 1주차 기준이 다를 수 있어 과거 시즌은 번호 매칭 전 표본 대조**.
2. 날짜 없는 소스(reportlogs, pointlogs.log)는 (season명 정규화 → season_type, 인접 날짜로 연도 추론, week int) → weeks 룩업.
3. **시즌명 정규화 사전 (A3-⑩ 확정 설계)** — 표기 변형·오타가 실존하므로 휴리스틱 파싱 금지, 명시 사전 + fail-closed:
   ```
   정규화 함수: trim → 연속 공백 제거 → '시즌' 접미사 제거 → 사전 룩업
   사전(JSON 데이터 파일, 코드와 분리·이관 산출물로 버전 관리):
     "봄"|"봄시즌"          → spring
     "여름"|"여름시즌"       → summer
     "가을"|"가을시즌"|"가을" → autumn      -- 후행 공백 변형은 trim 단계에서 흡수
     "겨울"|"겨울시즌"|"거울" → winter      -- '거울' = 오타 명시 등재 (자동 유사도 매칭 금지)
     "시즌미입력"|""|NULL    → (보류 큐)
   ```
   - **생성 절차**: 시즌명 보유 전 테이블(pointlogs.log 파싱분, useractivities/manageractivities.Season, reportlogs.Season, weekssettings.season, seasondates.SeasonName, userscurriculum.Season) DISTINCT 전수 → 사전 초안 → 수동 검수 확정 → 사전 밖 값은 **fail-closed 보류 큐** (silent 매핑 금지).
   - 연도 추론은 사전 적용 후: (season_type + 인접 날짜) → season_definitions 룩업. 동일 season_type 이 연 1회이므로 날짜가 시즌 경계 ±2주 밖이면 보류 큐.
   - 오타 등재는 발견 시 사전 갱신 + 파이프라인 재실행 (멱등이므로 안전) — 코드 수정 불필요.
4. 매칭 실패 행은 **silent drop 금지** — 보류 큐 + 건수 리포트.
5. period_label 정규표기("{YY} {시즌명} {N}주차")는 weeks 에서 파생되므로 별도 이관 불필요.

---

## 3. weeks 백필 설계 (시간 차원 선행 작업)

1. seasons(uuid): pms 데이터가 걸친 시즌만큼 행 생성 (season_definitions 라벨·기간 재사용, season_index 시간순).
2. weeks insert: seasondates(142행, 달력·휴식) ⊕ weekssettings(76행, 결산 속성) 를 start_date 로 머지 → 2025-09-01 이전 주차 insert. 기존 42행과 겹치는 구간은 **update (check_threshold·holiday_name 만)**.
3. 속성 우선순위: start/end·is_official_rest·holiday_name ← seasondates / check_threshold·result_published_at ← weekssettings.
4. ⚠️ **기존 2026-spring 16행에 check_threshold=37(confirmStar) 세팅은 판정 변경을 유발** — published 12행의 레거시 [통합] 라인 read-time 판정이 30→37 기준으로 강화됨. **v18 뒤집힘 재감사(37 기준) 후 적용 순서 결정** (§8 체크리스트).
5. iso_year/iso_week 는 start_date 에서 계산, week_index 는 시즌 내 순번.

---

## 4. seasonrestlogs sentinel ('0001-01-01 00:00:00') 처리 방안

**원인**: .NET `DateTime.MinValue` 가 미입력 상태로 저장된 것 (= "휴식 종료일 미정").

**규칙 (제안)**
1. 변환식: `date < '1900-01-01'` → **NULL** (MySQL zero-date '0000-00-00' 도 동일 규칙으로 흡수 — JDBC/드라이버에 따라 NULL 또는 에러로 읽히므로 추출 시 `CAST(... AS CHAR)` 후 판별).
2. NULL EndDate 의 의미 해석: 시즌 휴식이므로 **"해당 시즌 종료일로 캡"** — uws 전개 시 StartDate 가 속한 시즌의 마지막 주차까지 personal_rest/시즌휴식 적용. (무한 휴식으로 해석해 이후 시즌까지 전개하는 것 금지 — usersinfo.State/seasonchangeusers 와 모순 시 보류 큐.)
3. 원본 보존: legacy ledger payload 에 원문 그대로 ("0001-01-01T00:00:00") 기록 — 변환 추적 가능.
4. 리포트: sentinel→NULL 변환 건수, 시즌 캡 적용 건수, 모순(휴식인데 같은 기간 활동 인정 존재) 건수를 dry-run 산출물에 포함.
5. UserName NULL(최근 행)은 결측 그대로 보존 — UserId 가 키이므로 영향 없음.

---

## 5. 포인트 도메인 확정 설계 (A1/A2 반영 — 본 절이 기존 §5 전체를 대체)

### 5-1. user_weekly_points 계산식 — pointlogs 단일 소스 + A3 결산 의미 반영 (최종 확정)

**소스 (통화별 비대칭 — A2 원인①/③ + A3-④⑤ 근거)**
- **Star(points)**: `pointlogs 전 행 — IsDeleted 무관 (net_all)`. pms 결산이 net_all 기준이고, 취소가 [삭제 원본(+X) + alive 역로그(−X)] 쌍 구조라 **alive-only 는 역로그만 남겨 이중 차감 왜곡** (A3-⑤). net_all 에서 쌍은 자연 상쇄, 미복원 삭제(+X)는 pms 판정·잔액과 동일하게 잔존.
- **Shield(advantages/penalty)**: `IsDeleted = 0 (alive-only)`. Shield 삭제는 잔액 정상 복원 구조 (A2 원인③ — alive 합이 잔액과 ±1~3 정합).
- 공통: managerdatas 합산 금지(이중 계산) / IsHide 집계 무관 / AgentConfirm 무시 / **code '0000'(신입 보충 지급) 포함 — 제외 금지 (A3-⑦)**.

**주차 귀속**: `ActivityTime`(발효 시점, createtime 금지) → weeks 날짜 매칭. pms 측 추출 시 `< EndDate + 1 day` 보정(00:00 저장). 시즌명 텍스트는 귀속에 불사용 (§2 정규화 사전은 날짜 부재 소스 전용).

**주차별 집계식 (A3 최종)**
```
points(u,w)     = Σ Star'                      -- net_all (IsDeleted 포함), 부호 포함 NET
                  where Star' = 0  if Star < 0
                                   AND ActivityTime < usersinfo.StartDate + 14일   -- 신입 14일 보호 (A3-⑥)
                        Star' = Star otherwise
advantages(u,w) = Σ max(Shield, 0)             -- alive-only
penalty(u,w)    = Σ max(−Shield, 0)            -- alive-only, Shield 전용
checks_migrated = true                         -- v18 계약: 0건 주차도 행 기록 (points=0)
```
- check 게이트 의미 정합: pms 판정 = `NET Star >= confirmStar` (A3-①②) ↔ Vraxium v18 = `uwp.points >= weeks.check_threshold` — **points 에 NET Star(net_all)를 넣으면 두 식이 동치.** gross/net 경계 케이스 항목은 해소.
- 신입 14일 보호 구현: 집계 레이어에서만 0 처리 — **ledger 에는 원본 음수 그대로 보존** + protected=true 마킹, 0 처리 건수/사용자 리포트. usersinfo.StartDate NULL 사용자는 보호 미적용 + 건수 리포트.
- penalty 에 Star 차감 비포함 이유 (유지): Vraxium 방패 표시 = `Σadvantages − Σpenalty`, 번개 = `−Σpenalty` (adminResumeCardData.ts:248) — Star 차감 혼입 시 방패/번개 표시가 pms Shield 잔액과 어긋남.

**취소쌍(삭제 원본+역로그) 이관 정책 — "쌍 함께 보존" 확정**
- `legacy_point_ledger` 에는 **IsDeleted=1 포함 전 행 적재** (voided_at 로 표시). 함께 제외하는 방식은 기각 — 쌍 식별이 휴리스틱(시각·값 매칭)이라 누락 시 왜곡이 조용히 발생하고, 미복원 삭제(쌍 없는 삭제)와 구분 불가.
- 집계 레이어가 통화별 필터를 적용 (Star=net_all/Shield=alive). **alive 행만 선별 적재 금지** — 역로그 고아화가 구조적으로 차단됨.

**잔액 항등식 (검증 SoT — 통화별 기준 갱신)**
```
userspoint.Star   = Σ uwp.points(주차 행, net_all·14일 보호 적용) + adjustment.points     (컷오버 시점)
userspoint.Shield = Σ uwp.advantages − Σ uwp.penalty + adjustment.(adv−pen)               -- 기본값 5 는 adjustment 포함
```
- net_all 채택의 부수 효과: A2 원인① "삭제 미복원" 드리프트는 **주차 행에 흡수**되어 보정량이 줄어든다 (1092: Star 보정 기대값 +26 → **+8**). 14일 보호로 0 처리된 음수는 잔액에 반영돼 있을 수도/아닐 수도 — 보정이 잔차를 닫으므로 항등식은 항상 성립, 단 보호 적용분은 별도 리포트로 가시화.

### 5-2. migration adjustment 보정 로그 설계 (A2-②)

**원칙**: userspoint 잔액(사용자가 보고 있는 값) = 운영상 진실. 원장 주차 집계 + 보정 1행 = 잔액. 실사용자 99명 중 83명 드리프트(Star 최대 ±26) — 보정 없이는 이관 직후 화면 잔액이 변동한다.

**이중 기록 구조 (상세는 ledger, 합산 반영은 uwp sentinel 행)**

① **상세/감사**: `legacy_point_ledger` 에 entry_type='MIGRATION_ADJUSTMENT' 1행/사용자 — A2 제안 컬럼 전체 수용:
```
star_delta, shield_delta, reason_code('DELETED_NOT_RESTORED'|'UNLOGGED_GRANT_8'|'MANUAL_EDIT'|'UNKNOWN'),
source_balance_star/shield (컷오버 시점 userspoint 스냅샷), source_ledger_star/shield (컷오버 시점 Σpointlogs),
migrated_at, created_by('pms-to-vraxium-migration')
```

② **합산 반영**: `user_weekly_points` 에 **sentinel 주차 1행/사용자**:
```
year=1900, week_number=0, week_start_date='1900-01-01', checks_migrated=false
points     = userspoint.Star   − Σ(이관 주차 행 points)
advantages = max(D, 0)   where D = userspoint.Shield − Σ(이관 주차 행 adv−pen)   -- 기본값 5 자동 포함
penalty    = max(−D, 0)
```

**sentinel 방식이 안전한 근거 — 전 소비처 라이브 코드 검증 (2026-06-05)**

| 소비처 | 조회 방식 | sentinel 행 영향 | 의도 부합 |
|---|---|---|---|
| 이력서 누적 포인트 (adminResumeCardData.ts:251) | user 전 행 무필터 합산 | **포함** | ✅ 잔액 보정 반영 (목적) |
| 멤버 목록 (adminMembersData.ts:145) | user 전 행 합산 | **포함** | ✅ 〃 |
| cluster3 성장/클럽랭크 (cluster3GrowthData:76, ClubRankData:108) | 전 행 합산 | **포함** | ✅ 잔액 기준 랭크 |
| weekly-growth 주차 DTO (cluster4WeeklyGrowthData:479) | `${year}-${week_number}` Map 룩업 | 1900-0 키 미조회 → **제외** | ✅ 주차 화면 비오염 |
| v18 check 게이트 (lineAvailability:1218) | `.in("year", years)` + checks_migrated | 1900 ∉ years → **제외** (+플래그 false 이중 방어) | ✅ 판정 비오염 |
| weekly-cards snapshot | 주차 키 매칭 | **제외** | ✅ snapshot-only 구조 무변경 |
| admin 주차 상태 화면 (adminUserWeeklyStatusData:168) | user 전 행 (year,week 표시) | **노출 가능성** | ⚠️ dry-run 확인 항목 (admin 전용, 기능 무해) |

- DTO·조회 코드 **변경 0건** — snapshot-only 구조, demoUserId/일반 경로 동일성 그대로 유지.
- 보정 행은 checks_migrated=false + uws 행 없음 → 어떤 주차 판정에도 불참.
- ⚠️ 사전 확인 2건: uwp 에 음수값 CHECK 제약 없는지 (음수 드리프트 사용자 −18 등 insert 테스트), (user_id, year, week_number) unique 제약 형태.

**생성 규칙** (A2 제안 수용 + A3 갱신): 델타 ≠ 0 사용자만 / **컷오버 직전 재계산 필수** (오늘 수치는 그 시점에 무효) / 비활동 1,270명은 범위 정책 확정 후 (A2-③: 잔액 스냅샷 우선 — 주차 행 없이 sentinel 1행만으로 잔액 전체를 표현하는 축약형 권장).

**reason_code 분류 — A3(net_all) 반영 갱신**: 주차 집계가 net_all 이므로 "삭제 미복원" 드리프트는 주차 행에 흡수되어 **DELETED_NOT_RESTORED 보정은 원칙적으로 발생하지 않아야 한다** (발생 시 = 집계 버그 신호로 취급). 잔여 분류: 잔여 +8/+6 코호트→UNLOGGED_GRANT, 14일 보호 0 처리분과 일치→NEWBIE_PROTECTION_OFFSET, 그 외→MANUAL_EDIT/UNKNOWN. 분류 불가 잔차가 큰 사용자(>±10)는 개별 명세 후 이관.

**검증식 (이관 후, Vraxium 측)**
```sql
-- ① 잔액 항등: 전 이관 사용자에서 0행이어야 통과
SELECT user_id FROM user_weekly_points
GROUP BY user_id
HAVING SUM(points) <> (이관 시점 userspoint.Star 스냅샷)
    OR SUM(advantages) - SUM(penalty) <> (이관 시점 userspoint.Shield 스냅샷);
-- ② 보정 행이 주차 도메인에 새지 않는지: uws/weeks 에 1900-W0 부재 + 게이트 입력 år 범위 확인
-- ③ ledger 상세 ↔ uwp sentinel 값 일치 (star_delta = sentinel.points 등)
```

### 5-3. 검증 계획 잔여 항목 (A1/A2/A3 이후)

1. IsNoPenalty 교차: projectlist 면제 기간 중 penalty 행 존재 여부 — 면제가 "발행 안 함"인지 "사후 취소"인지.
2. pointlogs Star=0·Shield=0 행 다수(투표 참여 등 행동 로그) — **uwp 집계에는 영향 0** (합산 항등). legacy_point_ledger 적재 시 행동 로그 포함/분리 여부만 결정 (전량 적재 권장 — check 행동의 근거).
3. ~~A3: confirmStar 비교 대상 gross/net + PassingScore~~ → **✅ A3 완료** (NET·confirmStar 단독·PassingScore 불사용).
4. **판정 재현율 검증 (A3 후속)**: 사용자×주차별 `uwp.points >= confirmStar` 계산 결과 ↔ useractivities.IsActive **전수 대조** — 불일치 (user, week) 목록이 곧 "이관 후 판정이 바뀌는 지점" (수동 인정/예외 처리 흔적 포함). B8 재감사와 통합 수행.
5. usersinfo.StartDate NULL/이상치(미래·1900년대) 분포 — 14일 보호 적용 가능성 확인.

---

## 6. 과거 시점 스냅샷(UserName/UserTeam/UserPart/UserLevel) 보존 전략

대상: manageractivities·managerdatas·reportlogs·seasonchangeusers·seasonrestlogs·seasonteamdatas·projectlist·graduatelogs·useractivities (9개 테이블).

**원칙**: 당시 값은 원형 보존, 현재 user_profiles/user_memberships 값으로 대체·재계산 금지. Vraxium weekly-cards snapshot(jsonb)은 **재계산 가능한 파생 캐시**이므로 보존처가 될 수 없음 (재계산 시 소실).

**보존처 (신설 2개로 수렴 — 도메인별 신설 남발 방지)**

```sql
-- ① 포인트/활동 발행 원장 (managerdatas + pointlogs + [manager/user]activities 공통 랜딩)
legacy_point_ledger (
  id uuid PK, source_table text, source_pk bigint,    -- UNIQUE(source_table, source_pk) = 멱등 키
  user_id uuid, legacy_user_id bigint,
  week_id uuid NULL, occurred_at timestamptz,
  code text, reason text, star int, shield int,        -- 원본 부호 그대로
  actor_email text,
  snapshot jsonb,        -- {user_name, user_team, user_part, user_level, ...} 당시 값
  payload jsonb          -- 나머지 원본 컬럼 전체 (sentinel 원문 포함)
)
-- ② 이력성 이벤트 로그 (reportlogs/graduatelogs/seasonrestlogs/seasonchangeusers/seasonteamdatas/stopuserlogs/restlogs)
legacy_event_logs (
  id uuid PK, source_table text, source_pk bigint,     -- UNIQUE 멱등 키
  user_id uuid, legacy_user_id bigint,
  event_type text, occurred_at timestamptz,
  snapshot jsonb, payload jsonb
)
```

- 화면 소비처가 없으므로 정규화하지 않고 jsonb 보존 — 추후 화면 요구가 생기면 그때 전개 (예: 시즌×팀 이력 정규 테이블).
- 두 테이블 모두 **read-only 아카이브** (서비스 코드 미참조) — snapshot-only 조회 구조에 영향 없음.
- 마이그레이션 SQL 은 수동 적용 운영 룰을 따름 (SQL Editor).

---

## 7. 분류 요약 (최종)

- **✅ 바로 이관**: users 인적 필드, usersinfo Team/Part/Level (이전 분석 유지)
- **🔄 값 변환 후 이관**: weekssettings 전 컬럼(시즌·주차·기준값·공개), seasondates(달력·휴식), manageractivities/useractivities → [통합] 라인+uws, seasonchangeusers/seasonrestlogs → user_season_statuses(+sentinel), usersinfo.State/StartDate, members → applicants/admin_users
- **🧮 신규 계산**: **pointlogs(IsDeleted=0) 단일 소스** → user_weekly_points 주차 집계 (§5-1 확정식, **checks_migrated=true 의무·0건도 행 기록**) + **migration adjustment sentinel 행** (§5-2), user_cumulative_points 재합산, user_growth_stats recalc(전환 제외), seasons(uuid)·weeks 백필, snapshot 전량 재계산(마지막). managerdatas 는 집계 ⛔ (승인 큐 — legacy_event_logs 보존, 펜딩 1,215건 운영 결정)
- **⛔ 이관 제외**: 전 identity PK, userscurriculum, uploadedfiles, 비밀번호 해시, UserWeek(검증용), reportlogs(직접 이관 — 검증 입력으로만), seasondates.Week 레이블 파싱
- **🆕 스키마 추가**: `legacy_point_ledger` + `legacy_event_logs` 2개 (§6) — 기존 분석의 user_social_accounts(useraccounts)·user_season_teams 는 각각 "운영 결정 보류"·"ledger 보존으로 대체"

---

## 8. Dry Run 1명 실행 전 선결 조건 (순서대로)

**A. 의미 확정 (pms 프로파일링 쿼리, 코드 작성 전)**
1. ~~pointlogs ↔ managerdatas 중복 관계~~ → **✅ A1 완료** (pointlogs 단일 소스, managerdatas 집계 금지)
2. ~~confirmStar vs PassingScore + 게이트 비교 대상 gross/net~~ → **✅ A3 완료** (confirmStar 단독·NET·net_all·14일 보호·'0000' 포함)
3. manageractivities ↔ useractivities 기간 겹침/세대 관계
4. ~~집계 포함 조건 Confirm/AgentConfirm~~ → **✅ A1 완료** (Confirm=게시 여부, AgentConfirm 무시). 잔여: manageractivities 의 IsActive/IsDone/AgentConfirm 인정 기준 (활동 도메인)
5. Code 사전 (pointlogs.code 기준, '0000'=신입 보충 확정), managerdatas '확인 전' 1,215건 펜딩 처리 (소진 vs 보존), 비활동 1,270명 보정 범위 (A2-③)
5-1. **시즌명 정규화 사전 생성** (§2-3 절차: DISTINCT 전수 → 수동 검수 → JSON 고정) — A3-⑩
5-2. **Week 불일치 15명 3자 중재 명세** (§11) — usersinfo.Week/COUNT/reportlogs 대조표 작성
5-3. usersinfo.StartDate NULL/이상치 분포 (14일 보호 적용성)

**B. Vraxium 측 준비**
6. `legacy_point_ledger`/`legacy_event_logs` 마이그레이션 SQL 작성 + SQL Editor 수동 적용 — adjustment 컬럼(§5-2 ①) 포함
7. seasons(uuid) 백필 + weeks 백필(2025-09 이전) + 기존 42행 check_threshold 세팅 — **단, 적용 전 8번 먼저**
8. **v18 뒤집힘 재감사 (threshold=confirmStar=37 기준)**: uws=success 인데 평점<4 또는 check<37 인 실사용자 주차 전수 리포트 → 정책 확정 (pms 인정 우선 / threshold 조정 / 수용). 기존 06-05 감사는 30 기준이라 무효
9. users.legacy_user_id unique 제약 확인(없으면 추가), 테스터 90명(test_user_markers)·기존 실사용자 122명과 pms UserId 교집합 검사, 동일인 매칭 확정 리스트(이름+생년월일+연락처)
10. **uwp 제약 확인**: 음수값 CHECK 부재 (sentinel 음수 델타), (user_id, year, week_number) unique 형태 — sentinel 행 insert 테스트

**C. 검증 하네스 (이관 코드와 동시 준비)**
11. direct 함수 결과 ↔ HTTP API 응답 이중 검증 스크립트 (기존 verify-*-http 패턴 재사용): weekly-cards snapshot·이력서 stats·포인트 표시(방패=net·번개=−n)
12. demoUserId 경로 = 일반 경로 동일성 확인 (양쪽 다 snapshot 직독임을 전제로 한 응답 diff)
13. 멱등성 테스트: 동일 파이프라인 2회 실행 diff=0 (UNIQUE source_pk + upsert)
14. 롤백 경로: _backup_* 백업 + checks_migrated=false 일괄 복귀 스크립트 + weeks check_threshold 원복 스크립트 + sentinel 행 일괄 삭제 스크립트

**Dry Run 가능 여부 판정: ~~A1·A2·A3~~(완료) — 잔여 게이트 = A5-1(시즌 사전)·B7(weeks 백필)·B8(재감사).** 나머지(A3번 활동 도메인, A5-2~3, B9~10, C)는 dry-run 1명과 병행 가능. **Dry Run 대상 = pms UserId 1092 (장승완) — §12.** (1092 가 Week 불일치 15명에 포함되는지 사전 확인 — 포함 시 §11 명세 선행)

---

## 9. 남은 리스크 (우선순위순)

| # | 리스크 | 심각도 | 비고 |
|---|---|---|---|
| 1 | ~~pointlogs↔managerdatas 이중 계상~~ | ~~높음~~ → **해소 (A1)** | pointlogs 단일 소스 확정. 파이프라인 코드 리뷰에서 managerdatas 합산 부재를 재확인 |
| 2 | **check_threshold 37 vs 30** — 기존 published 주차의 read-time 판정 변경 + 06-05 감사 무효화 | 높음 | B8 재감사 후 weeks update 순서 통제 |
| 3 | **잔액 드리프트 보정의 시점성** — 컷오버 직전 재계산 누락 시 보정값 자체가 무효 (잔액·원장 매일 변동) | 높음 | 보정 산출을 파이프라인 마지막 단계에 내장 (A2 수치 재사용 금지) |
| 4 | ~~check 게이트 gross vs net~~ | ~~중~~ → **해소 (A3-①: NET 확정)** | points=net_all NET 로 동치 재현 — 판정 재현율 전수 검증(§5-3-4)으로 잔여 위험 흡수 |
| 4-1 | **Week 불일치 15명** — 채택값에 따라 화면 주차 변동 | 중 | §11 3자 중재, 복합 케이스는 30명 단계 이후 연기 |
| 4-2 | usersinfo.StartDate 품질 (14일 보호의 입력) — NULL/이상치 시 보호 미적용 | 낮음 | A5-3 분포 확인 + 리포트 |
| 5 | 비활동 1,270명 보정 범위 미결 (드리프트 큼, 일치율 2~3%) | 중 | A2-③ 축약형(잔액 sentinel 1행) 권장, 운영 확정 필요 |
| 6 | managerdatas 펜딩 1,215건 — 이관 시 증발 | 중 | 컷오버 전 소진(권장) 또는 event_logs pending 보존 |
| 7 | 시즌명에 연도 부재 — 과거 시즌 week 룩업 오귀속 | 중 | 날짜 우선 매칭 + 시즌별 표본 대조 |
| 8 | 한글 enum 문자열 오타·변형 / UserId 고아 (pointlogs·managerdatas 는 클린 확인됨) | 중 | DISTINCT 사전 + 잔여 테이블 고아 검출 |
| 9 | IsPublic→result_published_at 비가역 (409) | 중 | 백필 시 publish 마지막 단계로 |
| 10 | 동일인 매칭(기존 122명) 오류 | 중 | 3중 키 + 수동 확정 |
| 11 | sentinel 행의 admin 주차 상태 화면 노출 (adminUserWeeklyStatusData) | 낮음 | dry-run §12-검증 ⑦에서 확인, 필요 시 화면 측 1900 필터 |
| 12 | sentinel/zero-date 추출 드라이버 이슈 · weekssettings 결번(76 vs AI114) | 낮음 | CAST 추출 + §4 규칙 / seasondates 상호 보완 |
| 13 | **Star 삭제 미복원 버그의 재발** — pms 잔여 운영 기간 중 드리프트 계속 증가 | 낮음 | 컷오버 직전 재계산(#3)으로 흡수. Vraxium 측은 원장 단일 구조라 동종 버그 없음 |

---

## 10. 실제 이관 시작 전 체크리스트

- [x] A1: pointlogs↔managerdatas 관계 확정 (단일 소스) — 2026-06-05 완료
- [x] A2: 잔액 드리프트 명세 + 보정 로그 필요성 확정 — 2026-06-05 완료
- [x] A3: NET·confirmStar 단독·net_all·취소쌍·14일 보호·'0000'·Week=COUNT 재계산·시즌명 오타 — 2026-06-05 완료
- [ ] 시즌명 정규화 사전 JSON 생성 (DISTINCT 전수 → 수동 검수 → fail-closed)
- [ ] Week 불일치 15명 3자 중재 명세표 (§11) + 화면 변동 고지 리스트
- [ ] 판정 재현율 전수 검증 스크립트 (uwp.points>=threshold ↔ IsActive) — B8 재감사와 통합
- [ ] legacy_point_ledger / legacy_event_logs DDL 적용 (수동, SQL Editor)
- [~] seasons(uuid)·weeks 백필 — **dry-run 스크립트 작성·실행 완료 (2026-06-05)**: `scripts/backfill-seasons-weeks-dryrun.ts` → `claudedocs/backfill-seasons-weeks-dryrun-20260605.json`. 부분 모드(2026-winter 확정 3만): update 7건(W1~7 threshold 37)·insert 0·충돌 0, seasons insert 1건(2026-winter). 쓰기 0건 fingerprint 실측(`b7-fingerprint-before/after.json` DIFF NONE), direct↔HTTP 일치 실측(`b7-direct-vs-http.json`). **풀 모드는 pms-export 5종 JSON 필요** (스크립트 헤더에 export SQL 명세)
- [ ] ⚠️ **확정 3 ↔ 라이브 충돌 수동 확인**: 라이브 2026-winter W8(02-16)=비휴식·W5(01-26 설연휴)=휴식 vs 확정 "W8=휴식주" — pms 주차 번호가 휴식주를 건너뛰고 셌을 가능성. 번호 재대조 전 2026-winter apply 보류
- [ ] checkGate.required 가 snapshot 에 구워짐을 실측 확인 (required:30 baked) — threshold apply 후 checks_migrated=true 보유 사용자(현재 테스터 90명) snapshot 재계산 필수
- [ ] v18 뒤집힘 재감사 리포트 (37 기준) + 처리 정책 서면 확정
- [ ] legacy_user_id unique 제약 + 교집합/동일인 매칭 확정 리스트
- [ ] 한글 enum 변환 사전 (DISTINCT 전수 기반) 고정
- [ ] 주차 귀속 사전 (시즌명 정규화 + 연도 추론 규칙) + 매칭 실패 보류 큐 구현
- [ ] 검증 하네스: 직접 함수 ↔ HTTP ↔ demoUserId 3중 일치 + 포인트 대사식 자동화
- [ ] 멱등성 2회 실행 diff=0 확인
- [ ] 롤백 리허설 (checks_migrated 복귀·weeks 원복·_backup_*)
- [ ] uws 쓰기 → recalcUserGrowthStats → snapshot 재계산 순서가 파이프라인에 구조적으로 강제되는지 코드 리뷰
- [ ] 보정값 산출이 컷오버 직전 재계산되도록 파이프라인 내장 (A2 수치 하드코딩 금지)
- [ ] uwp 음수/unique 제약 insert 테스트 (sentinel 사전 확인 2건)
- [ ] managerdatas 펜딩 1,215건 처리 방침 확정 (소진 vs pending 보존)
- [ ] Dry Run 1명(=pms 1092, §12) → 5명 → 30명 → 전체 (각 단계 검증 항목은 `pms-vraxium-migration-mapping-20260605.md` §8)

---

## 11. usersinfo.Week ↔ COUNT(useractivities IsActive=1) 불일치 15명 처리 정책 (A3-⑧)

**전제**: pms 결산은 Week 를 +1 누적이 아니라 `COUNT(useractivities WHERE IsActive=1)` 로 **절대 재계산** — 즉 마지막 결산 시점에는 양자가 일치했을 것. 현재 불일치 15명 = **결산 이후 useractivities 변경(행 삭제/IsActive 토글) 또는 usersinfo.Week 수동 수정**의 흔적.

**Vraxium 구조적 제약 (정책의 핵심 근거)**: cumulative_weeks 는 uws 에서 재계산되는 파생 캐시 — usersinfo.Week 값을 강제 세팅해도 **다음 lazy recompute 가 uws 기준으로 덮어쓴다.** 따라서 "화면 주차 보존"은 cumulative 직접 세팅이 아니라 **uws 행 자체가 정합해야** 달성된다.

**3자 중재 정책 (15명 개별 적용)** — usersinfo.Week / COUNT(IsActive=1) / reportlogs 최종 "누적 주차 변경 => N" 대조:

| 케이스 | 판독 | 처리 |
|---|---|---|
| reportlogs 최종 N = COUNT ≠ Week | 결산 후 Week 수동 수정 (의도 불명) | **COUNT(=useractivities) 채택** — uws 는 IsActive 그대로, 화면 변동 발생 → 고지 리스트 등재 + 운영 확인 |
| reportlogs 최종 N = Week ≠ COUNT | 결산 후 useractivities 변경 (활동 행 삭제/토글) | **양쪽 명세 후 운영 판단** — 활동 변경이 정당(취소)이면 COUNT, 오조작이면 useractivities 복원 검토. 임의 uws 보정 행 추가 금지 (의미 훼손) |
| 셋 다 상이 | 복합 변경 | 개별 명세 → 운영 수동 확정 (보류 큐, 이 사용자들은 dry-run 30명 단계 이후로 연기) |

- 어느 경우든 **uws 에는 useractivities 의 사실(IsActive)만 기록** — "Week 를 맞추기 위한 가공 uws 행" 생성은 기존 데이터 의미 훼손이므로 금지.
- 최종 산출물: 15명 × (Week, COUNT, reportlogs N, 채택값, 화면 변동 여부) 명세표 → 이관 승인 문서에 포함.
- 일치 사용자(나머지 전원)는 recalc 결과 = usersinfo.Week 자동 검증 통과가 기대값 (§5-3-4 판정 재현율과 함께 확인).

---

## 12. Dry Run 설계 — pms UserId 1092 (장승완, F&B/일반) + 대조군

**선정 근거 (A2-④)**: Star차액 +26 = 삭제 미복원 +18 + 무기록 지급 +8 (원인 ①+② 복합), Shield차액 −6 (음수 보정 케이스), 삭제된 Shield 로그 −13 보유, 활동 중 사용자 — **보정 로직의 전 분기(삭제 분해·+8 패턴·음수 보정·Shield 기본 5)를 1명으로 검증 가능한 유일 케이스.**

**대조군**: ① pms 1299 (지서연 — Star 완전 일치·Shield만 +7: "부분 보정" 경로) ② 완전 일치 16명 중 1명 ("보정 행 미생성" 경로 — 0건 계약 검증).

### 12-1. 실행 단계 (모두 --dry-run 출력 검토 후 --apply, 멱등 upsert)

| # | 단계 | 쓰기 대상 | 비고 |
|---|---|---|---|
| 0 | 동일인 매칭: '장승완'을 Vraxium user_profiles(122명)에서 이름+생년월일+연락처로 조회 | — | **존재 시 기존 uuid 사용 + users.legacy_user_id=1092 기록 / 부재 시 신규 채번.** 매칭 모호하면 dry-run 중단 |
| 1 | 프로필/멤버십 upsert (users·user_profiles·user_memberships·user_educations) | 4테이블 | 기존 Vraxium 값과 충돌 시 **기존 값 보존 + diff 리포트** (운영 중 사용자 — pms 가 구버전일 수 있음) |
| 2 | pointlogs(UserID=1092) **전 행 — IsDeleted=1 포함** → legacy_point_ledger (voided_at 표시, code '0000' 포함) | ledger | source_pk=LogNum 멱등. **A3-⑤: alive 선별 적재 금지** (취소 역로그 고아화 차단) |
| 3 | §5-1 A3 최종식으로 주차 집계 → user_weekly_points upsert (Star=net_all+**14일 보호**, Shield=alive-only, checks_migrated=true, 0건 주차 포함) | uwp | **겹침 주차(2026 봄 10주차~) 처리**: 기존 행은 이관 전 자동 시드(0~4 스케일·checks_migrated=false)이므로 pms 집계로 덮어씀 — 단 덮어쓰기 전/후 값 diff 리포트 필수. 14일 보호 0 처리 건수 리포트 |
| 4 | 컷오버 시점 잔액 재조회 → 보정 산출 → ledger MIGRATION_ADJUSTMENT 1행 + uwp sentinel(1900-W0) 1행 | ledger+uwp | reason_code 분류 검증 — **A3 기대값: 1092 Star 보정 = +8 (UNLOGGED_GRANT)** (삭제 미복원 +18 은 net_all 주차 행에 흡수됨). DELETED_NOT_RESTORED 가 산출되면 집계 버그 신호 |
| 5 | useractivities/manageractivities → uws upsert(기존 uws 행은 **불변**·신규만 insert, 충돌 diff 리포트) + v17 [통합] 라인 타깃/평점 | uws·c4 3테이블 | uws 보존 원칙 (시드 스크립트와 동일) |
| 6 | recalcUserGrowthStats (전환주차 제외) | user_growth_stats | |
| 7 | weekly-cards snapshot 무효화 + 재계산 (recomputeWeeklyCardsSnapshotsForUsers) | snapshot | **명시적 재계산 — 원장 직접 수정은 자동 무효화 안 됨** |
| 8 | 검증 12-2 전 항목 → JSON 리포트 (claudedocs) | — | |
| 9 | 롤백 리허설: sentinel 삭제 + checks_migrated=false 복귀 + uwp 원복 + snapshot 재계산 → 이관 전 상태 diff=0 확인 | — | dry-run 의 일부로 1회 실제 수행 |

### 12-2. 검증 항목 (요청 10항 매핑)

| # | 항목 | 방법 | 통과 기준 |
|---|---|---|---|
| ① | pointlogs 집계 결과 | pms 측 집계 CSV(A3 식 동일 구현) ↔ Vraxium uwp 주차 행 전수 비교 | 주차별 points(net_all·14일 보호)/advantages/penalty(alive) 완전 일치, 미귀속 로그 0건(또는 보류 큐 설명), '0000' 행 포함 확인 |
| ①′ | **pms 판정 재현율** | 주차별 `uwp.points >= check_threshold(=confirmStar)` ↔ useractivities.IsActive | 전 주차 일치 (불일치 = 수동 인정 흔적 — 명세 후 정책 적용). 취소쌍 존재 주차의 net 상쇄 정확성 포함 |
| ② | adjustment 적용 전/후 잔액 | 적용 전 Σuwp ↔ 적용 후 Σuwp+sentinel | 적용 후 = 컷오버 시점 userspoint(Star, Shield) 스냅샷과 정확 일치 (**1092 A3 기대: Star 보정 +8**·Shield −6) |
| ③ | Shield 기본값 5 반영 | sentinel.advantages−penalty 에 +5 포함 확인 | 방패 표시값 = pms 화면 Shield 잔액 |
| ④ | direct 함수 결과 | adminResumeCardData·loadWeeklyCards·weekly-growth 직접 호출 (tsx 스크립트) | 누적 포인트=잔액, 주차 카드에 1900-W0 부재, check 게이트 입력값 정상 |
| ⑤ | HTTP API 응답 | admin API + front proxy 경로 (internal-key) 호출 | direct 와 동일 DTO |
| ⑥ | direct=HTTP 일치 | ④↔⑤ 응답 deep-diff | diff=0 (snapshot-only 구조 양 경로 동일 전제 확인) |
| ⑦ | snapshot 영향 여부 | 재계산 전 snapshot 과 cards diff + sentinel 누출 검사 | 1900-W0 이 cards/주차 통계에 부재. admin 주차 상태 화면(adminUserWeeklyStatusData) sentinel 노출 여부 기록 → 노출 시 후속 결정 |
| ⑧ | snapshot 재계산 필요 여부 | is_stale/computed_at·dto_version 확인 + 재계산 미수행 상태에서 화면 조회 | 원장 변경 후 미재계산 시 stale 임을 확인(=재계산 단계가 필수임을 실증), 재계산 후 최신 |
| ⑨ | demoUserId 경로 동일성 | demoUserId=1092-uuid 조회 ↔ 일반 경로 조회 응답 diff | DTO 완전 동일 (경로 분리 금지 원칙) |
| ⑩ | 브라우저 실반영 | Playwright (channel chromium, verify-week-check-browser.mts 패턴) — 이력서 카드 누적 포인트·주차 카드·방패/번개 표기 캡처 | 화면값 = pms 잔액 (방패=net·번개=−n), 레거시 주차 카드 정상 렌더 |

**추가 검증 (1092 특화)**: 봄 10~13주차 check 게이트 판정 — uwp.points(check) ↔ weeks.check_threshold(37 세팅 후) ↔ uws=success 정합. reportlogs "누적 주차 변경" 이력 ↔ recalc 후 cumulative_weeks 대조.

### 12-3. 통과 후 진행

대조군 2명(부분 보정·무보정) → 5명(졸업/정지/휴식/운영진/펜딩 보유) → 30명 → 전체. 각 단계에서 §10 체크리스트 미완 항목이 게이트.
