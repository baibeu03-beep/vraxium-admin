# Cluster4-card 섹션별 렌더 상태 진단표
_Date: 2026-05-21_
_Scope: 7 섹션의 비주얼 신호 ↔ 데이터 의존성 매핑. 사용자가 화면 관찰 결과를 채워 넣는 체크리스트._

---

## 0. 사전 정리

### 0.1 본 진단표의 사용법

1. weekBundle 패치 적용 후 `/cluster-4-card/<weekId>` (userId 파라미터 없이) 본인 계정으로 진입
2. 각 섹션 §1~§7 의 **"비주얼 신호 매트릭스"** 를 보고 화면 상태를 식별
3. 각 섹션 끝의 **"관찰 결과"** 표에 ✅ 한 줄 표기
4. §8 "종합 관찰 양식" 을 답변으로 알려주시면 §9 의 decision tree 로 정확한 seed scope 가 결정

### 0.2 "정상 / 빈 / 오류" 의 의미 통일

- **정상**: 의도된 데이터가 표시됨 (row 가 있어 사용자가 볼 만한 내용)
- **빈**: row 가 없어 placeholder 또는 더미가 표시됨 (오류 아님 — 신규 작성 가능 상태 또는 master 미개설)
- **오류**: API fetch 실패. 화면상 빈 상태와 구별 어려움 → **DevTools Console 메시지로만 식별 가능** (§10 참조)

### 0.3 코드 분석 기반 모든 섹션의 공통 특성

| 섹션 | "빈 상태" 가 정상인가? | Empty placeholder 패턴 |
|---|---|---|
| reputation | ✅ 정상 (남이 작성해줘야 함) | 4 슬롯 `isEmpty:true` 더미 |
| colleague | ✅ 정상 (본인이 지정 안 함) | 3 슬롯 `isEmpty:true` 더미 |
| weekly review | ✅ 정상 (본인이 미작성) | "아직 작성된 리뷰가 없습니다…" 텍스트 |
| workinfo | ⚠️ master 의존 (`weekly_activities` 없으면 title="-") | 카드는 그려지나 title 등 "-" |
| workability | ⚠️ 동상 | 단일 카드로 collapse 또는 fallback "-" |
| workexp | ⚠️ `activity_records` 의존 (없으면 4칸 모두 void) | `isEmpty:true` void 카드 1~4개 |
| workcar | ⚠️ master 의존 (`career_projects+junction` 없으면 emptyCareerCard 1개) | 빈 카드 1장 fallback |

요약: **reputation / colleague / weekly review** 는 비어 있어도 정상 (smoke test 의 "신규 작성" 대상). **workinfo / workability / workexp / workcar** 는 master 데이터 의존이 강해 운영 환경 상태에 따라 빈 카드만 보일 수 있습니다.

---

## 1. reputation section

### 1.1 비주얼 신호 매트릭스

| 시각 신호 | 상태 진단 | 근거 (코드) |
|---|---|---|
| 4 슬롯 모두에 사람 이름 + 별점 + "#<키워드>" 표시 | **정상 (가득)** | `weeklyReputations.length >= 4`, line 4536-4570 |
| 1~3 슬롯만 채워지고 나머지 "-" / "#-" | **정상 (부분)** | API row 1~3건. line 4593-4615 의 padding |
| 4 슬롯 모두 `name = "-"`, 별점 0, `tagText = "#-"` | **빈** | `weeklyReputations.length === 0`, 더미 3개 + 빈 슬롯 1개 패딩 |
| `count-num` 이 `0/4` 로 표시 (line 6201) | **빈 확정** | filledCount = 0 |
| `count-num` 이 `N/4` (N=1~4) | 정상 (N개 받음) | 동상 |
| 페이지 로딩 후 1~2초 빈 카드 → 사람으로 교체 | API 응답 지연 (정상) | earlyReputationsResult 비동기 |

### 1.2 데이터 의존성

- **테이블**: `weekly_reputations` (target_user_id = 본인, week_card_id = URL 의 weekId)
- **추가 enrichment**: `user_profiles`, `user_educations`, `user_team_parts` (reviewer 정보)
- **API**: `GET /api/weekly-reputations?targetUserId=<self>&weekCardId=<weekId>`

### 1.3 관찰 결과 (사용자 채움)

```
[ ] 정상 (가득 4개)
[ ] 정상 (부분 N개) — N = ___
[ ] 빈 (모두 "-")
[ ] 오류 (Console 에 메시지)
```

---

## 2. colleague section

### 2.1 비주얼 신호 매트릭스

| 시각 신호 | 상태 진단 | 근거 |
|---|---|---|
| 3 슬롯 모두에 사람 카드 + 한 줄 메시지 | **정상 (가득)** | `selectedColleagues.length >= 3`, line 4661-4679 |
| 1~2 슬롯만 채워지고 나머지 "-" | **정상 (부분)** | line 4699-4719 의 padding |
| 3 슬롯 모두 `name = "-"`, message="" | **빈** | `selectedColleagues.length === 0`, 더미 3개 |
| isRestMode (휴식 주차) → 3 슬롯 모두 빈 카드 강제 | **빈 (정상, 휴식 정책)** | line 4640-4658 |

### 2.2 데이터 의존성

- **테이블**: `weekly_colleagues` (user_id = 본인, week_card_id = URL 의 weekId)
- **추가 enrichment**: `user_profiles` (colleague 프로필), `user_educations`, `user_team_parts`
- **API**: `GET /api/weekly-colleagues?userId=<self>&weekCardId=<weekId>`

### 2.3 관찰 결과

```
[ ] 정상 (가득 3개)
[ ] 정상 (부분 N개) — N = ___
[ ] 빈 (모두 "-")
[ ] 휴식 주차 — 강제 빈 카드 (정상)
[ ] 오류 (Console 에 메시지)
```

---

## 3. weekly review

### 3.1 비주얼 신호 매트릭스

| 시각 신호 | 상태 진단 | 근거 |
|---|---|---|
| 박스 본문에 본인 작성 텍스트 + 별점 표시 | **정상** | `weeklyReviewFromDB.content` 존재, line 6035 |
| 박스 본문이 `"아직 작성된 리뷰가 없습니다. 클릭하여 작성해보세요. 😊"` 표시 | **빈** | `weeklyReviewFromDB === null` 또는 content falsy |
| 별점 영역 `0 / 10` | **빈** | line 6037 의 `weeklyReviewFromDB?.rating || 0` |
| 별점 영역 `N / 10` (N=1~10) | **정상** | rating 값 존재 |

### 3.2 데이터 의존성

- **테이블**: `weekly_reviews` (user_id = 본인, week_card_id = URL 의 weekId)
- **API**: `GET /api/weekly-reviews?weekCardId=<weekId>&userId=<self>` — Phase 1 에서 라우트 + 테이블 모두 정상화 완료

### 3.3 관찰 결과

```
[ ] 정상 (본인 작성 텍스트 표시)
[ ] 빈 ("아직 작성된 리뷰가 없습니다…")
[ ] 오류 (Console 에 "[weekly-review] fetch 예외:" 메시지)
```

---

## 4. workinfo section (실무 정보 grid)

### 4.1 비주얼 신호 매트릭스

`workinfo` 는 **카드를 무조건 생성**하고 (`workInfoCards.map`, line 5378-5397) 모두 `isEmpty: false` 입니다. 그러나 내용물은 master / user 데이터 유무에 따라 달라집니다.

| 시각 신호 | 상태 진단 | 근거 |
|---|---|---|
| 카드별 Main Title (예: "지혜의 광장 …") + sub_title 본문 + 이미지 | **정상 (양쪽 다 있음)** | `activity?.title` + `detail?.sub_title` 채워짐 |
| Main Title 만 있고 sub_title 비어 있음 | **빈 (user 데이터만 미작성)** | `weekly_activities` row 있음 + `user_activity_details` row 없음 |
| Main Title 이 "-" (line 5381) | **빈 (master 미개설)** | `weekly_activities.title` row 없음 → "-" fallback |
| 카드 수가 0개 (grid 자체가 빈 영역) | **빈 (master 0)** | `workInfoCardOrder` 또는 weekly_activities 필터 후 0건 |
| 강화 상태 뱃지 "강화 성공" / "강화 실패" / "해당 없음" | 모두 정상 분기 — enhancementStatus 표시 | line 5387 |
| 휴식 모드: 모든 카드 Main Title 강제 "-" + 해당 없음 | 정상 (휴식 정책) | line 5402-5411 |

### 4.2 데이터 의존성

- **Master**: `weekly_activities` (week_id = weekId, activity_type_id = info 계열). row 가 없으면 카드 title 이 "-"
- **User**: `user_activity_details` (user_id+week_id+activity_type_id). row 가 없으면 sub_title/output_links/image_urls 비어 있음
- **Enhancement status**: `activity_records` (cluster-4 의 무관 영역. 본 phase 외)
- **API**: `weekBundle.weeklyActivities` (이번 패치) + `profile.activityDetails` + `/api/career-records` (workcar)

### 4.3 관찰 결과

각 info 카드 (9 슬롯: wisdom, essay, infodesk, calendar, forum, session, practical_lecture, community, etc_a) 에 대해 묶어서:

```
[ ] 정상 (전 카드 Main Title 있음 + 본인 sub_title 도 일부 채워짐)
[ ] 빈 (master 일부만 — Main Title 이 "-" 인 카드가 N개) — N = ___
[ ] 빈 (master 다 있음, user sub_title 전부 비어 있음)
[ ] 카드 자체가 0개 (grid 빈 영역)
[ ] 오류 (Console 에 메시지)
```

---

## 5. workability section (실무 역량 단일 카드)

### 5.1 비주얼 신호 매트릭스

workability 는 **단일 카드** 만 표시합니다 (`matchedAbilityCard` 또는 fallback, line 5482-5508).

| 시각 신호 | 상태 진단 | 근거 |
|---|---|---|
| line code (예: "ENT11") + lineName + title + sub_title 표시 | **정상** | `matchedAbilityCard` 존재 (enhancementStatus !== "not_applicable") |
| lineCode/lineName 모두 "-", 상태 "강화 실패" 표시 | **빈 (활동 미적용)** | `matchedAbilityCard = undefined` → fallback `displayedAbilityCard` (isEmpty:true), `abilityVoidFallbackStatus = "failed"` |
| 휴식/온보딩 주차 — lineCode/lineName "-" + "해당 없음" | **빈 (정상, 정책상 강제)** | line 5487 `abilityVoidFallbackStatus = "not_applicable"` |

### 5.2 데이터 의존성

- **Master**: `activity_types` (cluster_id = "practical_competency"), `weekly_activities` (week_id, activity_type_id = competency 계열)
- **Master flag**: `activity_records` 의 `enhancementStatus` 가 not_applicable 이외의 값을 가지는 row가 있어야 매칭 성공
- **User**: `user_activity_details` (해당 activity_type_id)

### 5.3 관찰 결과

```
[ ] 정상 (line code + lineName + 내용 표시)
[ ] 빈 (lineCode/lineName "-" + "강화 실패" — 비휴식 주차)
[ ] 빈 (lineCode/lineName "-" + "해당 없음" — 휴식/온보딩)
[ ] 오류 (Console 에 메시지)
```

---

## 6. workexp section (실무 경험 4슬롯 grid)

### 6.1 비주얼 신호 매트릭스

workexp 는 `adminProcessedExpTypeIds` (= `activity_records` 에 experience type row가 존재하는 종류) 기반으로 카드 생성. 부족하면 void 카드로 4슬롯까지 패딩.

| 시각 신호 | 상태 진단 | 근거 |
|---|---|---|
| 4 슬롯 모두에 line code + title + 별점 표시 | **정상 (가득)** | `adminProcessedExpTypeIds.length >= 4` |
| 1~3 슬롯에 카드 + 나머지 "-" void 카드 | **정상 (부분)** | void 카드 패딩 (line 5611-5630) |
| 4 슬롯 모두 "-" void 카드 | **빈 (activity_records 0)** | `adminProcessedExpTypeIds.length === 0` |
| 별점 영역 "- / 10" | 해당 슬롯 void | line 5624 `ratingCount: "- / 10"` |
| 휴식 주차 — 모든 Main Title 강제 "-", 별점 보존 | 정상 (휴식 정책) | line 5634-5642 |

### 6.2 데이터 의존성

- **Master flag**: `activity_records` (user_id, week_id, activity_type_id = experience 계열) 가 존재해야 그 type의 카드 생성. 즉 admin/시스템 처리가 선행되어야 카드 노출
- **별점**: `points.activity_id, points` (라우트의 activityPoints)
- **User**: `user_activity_details` (sub_title/images/links)
- **API**: `weekBundle.weeklyActivities` + `profile.activityRecords` + `profile.activityPoints`

### 6.3 관찰 결과

```
[ ] 정상 (4 슬롯 가득)
[ ] 정상 (N개 채워짐, 나머지 void) — N = ___
[ ] 빈 (4 슬롯 모두 void "-")
[ ] 휴식 주차 — title "-" + 별점 보존 (정상)
[ ] 오류 (Console 에 메시지)
```

---

## 7. workcar section (실무 경력 카드)

### 7.1 비주얼 신호 매트릭스

| 시각 신호 | 상태 진단 | 근거 |
|---|---|---|
| 회사명 + 프로젝트명 + 등급 + 감독자 카드 N개 표시 | **정상** | `careerRecords.length > 0` → `sortedWorkCareerCards` 사용 |
| 빈 카드 1장 (code="", badge="", title="", supervisor 모두 "") | **빈 (master 0)** | line 5807 `[emptyCareerCard(1)]` fallback |
| 카드는 있는데 grade 빈 / supervisor 정보 "-" | **부분 (admin 미확정)** | `career_records.grade` null, supervisor null — `career_projects.supervisor_*` fallback |

### 7.2 데이터 의존성

- **Master 1**: `career_projects` (회사/프로젝트/감독자)
- **Master 2**: `career_project_weeks` (project_id, week_id = weekId, **is_active = true**). 이 junction 의 active row 가 카드 노출 결정
- **User**: `career_records` (user_id, week_id, project_id) — 본인의 grade/enhancement_status 저장
- **API**: `GET /api/career-records?week_id=<weekId>&user_id=<self>`

### 7.3 관찰 결과

```
[ ] 정상 (회사/프로젝트 카드 N개) — N = ___
[ ] 빈 (단일 빈 카드만 표시)
[ ] 부분 (카드 N개 있지만 grade/supervisor 비어 있음) — N = ___
[ ] 오류 (Console 에 메시지)
```

---

## 8. 종합 관찰 양식 (사용자가 한 번에 답변)

다음 양식 그대로 채워서 알려주시면 됩니다. 보기를 줄에 ✅ 만 표시하거나 짧게 작성:

```
시즌 / 주차 정보 (페이지 상단):    [ ] 정상   [ ] 빈   [ ] 오류

1. reputation:    [ ] 정상(N=__)   [ ] 빈    [ ] 오류
2. colleague:     [ ] 정상(N=__)   [ ] 빈    [ ] 휴식강제   [ ] 오류
3. weekly review: [ ] 정상         [ ] 빈    [ ] 오류
4. workinfo:      [ ] 정상         [ ] 빈(master일부 N=__)  [ ] 빈(user전무)  [ ] 카드0개  [ ] 오류
5. workability:   [ ] 정상         [ ] 빈(강화실패)  [ ] 빈(해당없음)  [ ] 오류
6. workexp:       [ ] 정상(N=__)   [ ] 빈(void4개)  [ ] 휴식  [ ] 오류
7. workcar:       [ ] 정상(N=__)   [ ] 빈(단일)  [ ] 부분(N=__)  [ ] 오류

Console 에 떨어진 [Error / Failed] 메시지가 있다면 그대로 copy-paste:
(여기 그대로 붙여넣기)
```

---

## 9. Decision tree — 관찰 결과 → 필요 seed scope

본 단계에서는 **schema 변경/migration 금지**. 즉 master 테이블이 비어 있어 카드가 안 보이는 경우라도 master 에는 직접 row INSERT 하지 않습니다. 그러나 일부 user-specific row는 본인 계정에서 직접 작성 가능하고, 그 외에는 별도 PR 로 master 등록 필요.

| 관찰 결과 | seed 가능 여부 | 권장 행동 |
|---|---|---|
| §1 reputation = 빈 | ✅ user-specific (다른 crew 계정 필요) | 다른 crew 4명을 본인 page 에 평판 작성하도록 요청. 또는 admin이 다른 crew 명의로 INSERT seed (옵션 D8 결정) |
| §2 colleague = 빈 (비휴식) | ✅ user-specific | UI 에서 직접 crew picker 로 1~3명 선택 + 메시지 작성 → 정상 |
| §3 weekly review = 빈 | ✅ user-specific | UI 에서 직접 modal 열고 rating + content 작성 → 정상 |
| §4 workinfo = 카드 0개 / Main Title "-" 다수 | ❌ master 의존 (weekly_activities) | 사용자 결정 필요: master seed 별도 PR 또는 카드 0인 채로 smoke test 진행 |
| §4 workinfo = Main Title 정상 + user sub_title 비어있음 | ✅ user-specific | UI 에서 modal 열고 sub_title/output_links/image 작성 → 정상 |
| §5 workability = "강화 실패" 단일 빈 카드 | ❌ master 의존 (activity_records + weekly_activities) | smoke test 영향 적음. 별도 PR |
| §6 workexp = 4 슬롯 모두 void | ❌ master 의존 (activity_records) | 동상 |
| §7 workcar = 빈 단일 카드 | ❌ master 의존 (career_projects + junction) | 동상 |

이 단계에서 **반드시 seed 가 필요한 항목** 후보:
- **(필수가 될 수도)** §1 reputation — 본인이 받은 평판이 0건이면 reputation 카드 UI 가 빈 상태로만 보임. smoke test 의 "조회/수정" 시나리오 검증을 위해 1~2건 seed가 도움
- **(선택)** §2-3 colleague / weekly review — UI 에서 직접 작성하면 되니 seed 불필요
- **(보류)** §4-7 master 의존 부분 — schema 변경/master row 추가는 별도 의사결정

### 9.1 최소 seed 후보 (Decision tree 결과에 따라 §9 의 사용자 입력 후 확정)

만약 §1 = 빈, §2 = 빈, §3 = 빈 이고 §4-7 = 빈/일부 master 의존 이면:
- **단 1건만 seed 필요**: §1 reputation 1~2 row (반드시 reviewer_id ≠ target_user_id 의 다른 crew)
- 나머지는 UI 클릭으로 본인 계정에서 작성 → 자연스러운 smoke test

이 시점에 master 의존 (§4-7) 은 본 phase scope 외이므로 "빈 상태" 그대로 두고, Phase 1 smoke test 의 핵심 (1.1~5.2) 만 수행해도 무방합니다.

---

## 10. Console 메시지 진단 가이드

각 섹션이 "오류 상태" 인지 식별하려면 DevTools Console (F12 → Console 탭) 의 메시지를 확인:

| 메시지 | 의미 |
|---|---|
| `주차 데이터 로드 오류: Error: Week not found` | weekBundle 미스매치 (Phase 0 의 backend gap). 패치 이후 사라져야 함 |
| `주차 데이터 로드 오류: ...` (그 외 error) | profile API 또는 weekBundle 쿼리 중 일부 실패 — 메시지 사진 또는 copy-paste 공유 부탁 |
| `Failed to fetch profile` | profile API 응답 .ok = false 또는 data.id 없음 |
| `[weekly-review] fetch 예외:` | weekly_reviews GET 실패 |
| `Error fetching career records:` | career-records API 실패 |
| `Error fetching activity details:` | activity-details API 실패 |
| `연계 동료 조회 오류:` | weekly_colleagues GET 실패 (운영 DB 에 테이블 존재 확인됨이므로 잘 안 나옴) |
| `주차 평판 조회 오류:` | weekly_reputations GET 실패 |

위 메시지 중 어느 것이 떨어졌는지 알려주시면 오류 ↔ 빈 상태 구분이 됩니다.

---

## 11. 본 단계 변경 사항 요약

| 분류 | 내역 |
|---|---|
| 수정한 코드 파일 | **0** |
| Migration | **0** |
| Supabase 변경 | **0** |
| Front 변경 | **0** |
| 신규 문서 | 본 보고서 1건 (`claudedocs/cluster4-card-render-state-diagnostic-20260521.md`) |

다음 단계는 사용자 §8 양식 답변을 받은 뒤 §9 decision tree 로 seed scope 확정.
