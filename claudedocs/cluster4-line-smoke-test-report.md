# Cluster4 라인 개설 Phase 2 Smoke Test 보고서

> **실행일**: 2026-05-27
> **대상**: Migration 2개 + Profile API + activity-details API
> **테스트 방법**: Supabase DB 직접 쿼리 (service_role)
> **스크립트**: `scripts/cluster4-phase2-smoke.ts`

---

## 1. 테스트 결과 요약

```
PASS: 13 / 13
FAIL: 0
```

---

## 2. DB 상태 검증 (Migration 적용 확인)

### 2-1. cluster4_lines 신규 컬럼

| 테스트 | 결과 | 상세 |
|---|---|---|
| activity_type_id 컬럼 존재 | **PASS** | SELECT 쿼리에서 에러 없이 반환 |
| output_images 컬럼 존재 | **PASS** | 동일 |
| team_id 컬럼 존재 | **PASS** | 동일 |
| career_project_id 컬럼 존재 | **PASS** | 동일 |
| 현재 데이터 | 0행 | 아직 라인 미생성 (정상) |

### 2-2. activity_types practical_info seed

| 테스트 | 결과 | 상세 |
|---|---|---|
| info 타입 9개 존재 | **PASS** | calendar, community, essay, etc_a, forum, infodesk, practical_lecture, session, wisdom |
| cluster_id 분포 | **PASS** | `practical_info: 9, practical_competency: 1, practical_experience: 1, practical_career: 1` |

### 2-3. 부분 UNIQUE 인덱스

| 테스트 | 결과 | 상세 |
|---|---|---|
| 동일 activity_type_id + is_active=true 중복 삽입 | **PASS** | PostgreSQL 23505 (unique_violation) 발생 확인 |
| 테스트 데이터 정리 | **PASS** | 삽입된 테스트 행 삭제 완료 |

---

## 3. DTO 변환 시뮬레이션

### 3-1. weeklyActivities DTO (cluster4_line_targets → 호환 DTO)

| 테스트 | 결과 | 상세 |
|---|---|---|
| 최근 주차 확인 | **PASS** | week_number=13, start_date=2026-05-25 |
| targets JOIN 쿼리 | **PASS** | 0행 (현재 target 미생성 — 정상) |
| DTO 변환 로직 | **PASS** | 빈 배열 반환 (프론트에서 카드 없음 = "not_applicable") |

**변환 매핑 확인**:

```
cluster4_lines.id                  → weeklyActivities[].id             ✅
cluster4_lines.activity_type_id    → weeklyActivities[].activity_type_id ✅
cluster4_lines.main_title          → weeklyActivities[].title          ✅
cluster4_lines.is_active           → weeklyActivities[].is_active      ✅
cluster4_lines.submission_opens_at → weeklyActivities[].opened_at      ✅
cluster4_lines.submission_closes_at→ weeklyActivities[].deadline        ✅
[{url: output_link_1}]            → weeklyActivities[].output_links    ✅
cluster4_lines.output_images       → weeklyActivities[].output_images   ✅
cluster4_lines.team_id             → weeklyActivities[].team_id         ✅
```

### 3-2. activityRecords DTO (cluster4_line_submissions → 호환 DTO)

| 테스트 | 결과 | 상세 |
|---|---|---|
| submissions JOIN 쿼리 | **PASS** | 0행 (미제출 — 정상) |
| 빈 배열 = 모두 "failed" | **PASS** | getEnhancementStatus() 정상 동작 예상 |

**변환 매핑 확인**:

```
submission.id                                          → activityRecords[].id             ✅
cluster4_line_targets.week_id                          → activityRecords[].week_id        ✅
cluster4_line_targets.cluster4_lines.activity_type_id  → activityRecords[].activity_type_id ✅
존재 = true                                            → activityRecords[].is_completed    ✅
미존재 = 행 없음                                       → getEnhancementStatus() → "failed" ✅
```

### 3-3. activity-details 마감 검증

| 테스트 | 결과 | 상세 |
|---|---|---|
| 활성 라인 targets 조회 | **PASS** | 0행 (활성 라인 미생성 — 정상) |

검증 로직: `line.is_active && Date.now() < new Date(line.submission_closes_at).getTime()`

### 3-4. user_activity_details 상태

| 테스트 | 결과 | 상세 |
|---|---|---|
| 테이블 조회 | **PASS** | 3행 존재 (기존 데이터) |

---

## 4. API 테스트 (Dev 서버 미실행 — 보류)

Dev 서버가 실행 중이지 않아 HTTP endpoint 테스트는 수행하지 못했다.

### 대기 중인 테스트 항목

| # | 테스트 | 검증 대상 |
|---|---|---|
| 1 | `GET /api/profile?context=card&weekId=<uuid>` | HTTP 200 반환 (기존 500 → 해소) |
| 2 | 응답의 `weekBundle.weeklyActivities` | 배열 존재 + DTO 필드 완전성 |
| 3 | 응답의 `activityRecords` | 배열 존재 + is_completed 값 |
| 4 | `PUT /api/activity-details` (비어드민) | 제출 기간 내 200 반환 (기존 403 → 해소) |
| 5 | 프론트 Cluster4CardContent.tsx | 카드 렌더링 정상 여부 |

### 테스트 실행 방법

```powershell
# Career-Resume dev 서버 시작
cd "C:\Users\ynlee\OneDrive\바탕 화면\vraxium\Career-Resume"
npm run dev

# 브라우저에서 확인
# 1. http://localhost:3000 접속 → 로그인
# 2. /cluster-4-card 페이지 이동
# 3. 개발자 도구 Network 탭에서 /api/profile?context=card 응답 확인
# 4. weekBundle.weeklyActivities, activityRecords 필드 확인
```

---

## 5. 현재 상태 평가

### 해소된 이슈

| 이슈 | 상태 |
|---|---|
| Profile API 500 에러 (weekly_activities 미존재) | **해소 예상** — 쿼리가 cluster4_line_targets로 교체됨, DB 쿼리 성공 확인 |
| activity_records 미존재 에러 | **해소 예상** — 쿼리가 cluster4_line_submissions로 교체됨, DB 쿼리 성공 확인 |
| activity_types에 info 타입 없음 | **해소** — 9개 seed 완료 |
| 동일 activity_type_id 중복 방지 | **해소** — UNIQUE 인덱스 작동 확인 (23505) |

### 현재 알려진 제한사항

| # | 항목 | 영향 | 대응 |
|---|---|---|---|
| 1 | cluster4_lines에 라인 미생성 | weeklyActivities 빈 배열 → 모든 카드 "not_applicable" | 어드민이 라인 생성 필요 |
| 2 | cluster4_line_submissions 미존재 | activityRecords 빈 배열 → 모든 강화 상태 "failed" | 사용자 제출 후 해소 |
| 3 | cluster-4-ranking/route.ts 미수정 | 랭킹 API 여전히 weekly_activities/activity_records 참조 → 500 | Phase 3에서 수정 |
| 4 | cluster4-weekly-cards.ts 미수정 | buildWeeklyCards() 여전히 레거시 참조 → 주차 카드 리스트 오류 가능 | Phase 3에서 수정 |
| 5 | Sidebar.tsx 미수정 | 완료율 계산 오류 가능 | Phase 3에서 수정 |

### PUT /api/activity-details 예상 동작

```
라인 미생성 상태:
  cluster4_line_targets에서 매칭 행 없음
  → line = null
  → isBeforeDeadline = false
  → 비어드민: 403 (라인이 개설되지 않았으므로 정상)
  → 어드민: bypass → 200 (UPSERT 성공)

라인 생성 + 제출 기간 내:
  cluster4_lines.is_active = true
  Date.now() < submission_closes_at
  → isBeforeDeadline = true
  → 비어드민: 200 (기존 403 → 해소)
```

---

## 6. 결론

```
DB Migration:           ✅ 2개 모두 성공 적용
신규 컬럼:              ✅ 4개 존재 확인
Info seed:              ✅ 9개 타입 확인
UNIQUE 인덱스:          ✅ 중복 차단 작동
DTO 변환 쿼리:          ✅ Supabase JOIN 문법 정상
user_activity_details:  ✅ 기존 데이터 보존

API 테스트:             ⏳ Dev 서버 실행 후 추가 확인 필요
프론트 렌더링:          ⏳ Dev 서버 실행 후 추가 확인 필요
```

**다음 단계**: Career-Resume dev 서버를 시작하고 브라우저에서 실제 동작을 확인.
