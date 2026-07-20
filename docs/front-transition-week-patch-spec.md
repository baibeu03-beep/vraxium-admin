# 고객 프론트(vraxium) 전환 주차 재귀속 대응 — 점검 항목 & 패치 스펙

> 대상 레포: `C:\Users\vanua\OneDrive\Desktop\vraxium` (admin 과 **동일 Supabase DB 공유, 별도 레포**)
> 이 문서는 admin 레포에서 진행한 "전환 주차 = 다음 시즌 0주차" 재귀속에 맞춰 프론트가
> 동일 정책을 따르도록 하는 점검/패치 스펙이다. **숫자 `0주차` UI 는 새로 만들지 않는다.**

## 0. 무엇이 바뀌었나 (공유 DB)

DB SQL 적용 즉시 프론트가 읽는 값이 바뀐다:

| 컬럼 | 전(prev-season) | 후(next-season) |
|---|---|---|
| `weeks.season_key` (전환 주차) | 이전 시즌 (`2026-spring`) | **다음 시즌** (`2026-summer`) |
| `weeks.week_number` (전환 주차) | 17 / 9 | **0** |
| `user_week_statuses.season_key` (전환 주 4개) | 이전 시즌 | **다음 시즌** |

`season_definitions` / `seasons` 의 공식 경계(1주차 시작)는 **불변**(봄 종료 06-21, 여름 1주차 06-29).
전환 주차는 그 사이 gap 에 위치한 다음 시즌의 0주차다.

**핵심 원칙 (표시 정책 — 어드민 vs 크루 분리)**:
- **DTO 는 분기하지 않는다.** `seasonKey`/`seasonId`/`weekNumber=0` 은 어드민·크루·`mode=test`·
  `actAsTestUserId`·`demoUserId`·일반 사용자 경로 **모두 동일**. 전환 판정도 공통 `isTransitionWeek()`.
- **표시 문자열만 컨텍스트별 formatter 로 분리**:
  - 어드민(관리자 화면) = 실제 값 그대로. `2026년 여름 시즌 0주차` 노출 OK(전환 여부는 활동/상태 배지로 구분).
  - **크루/사용자(이 front 레포) = 전환 주차면 `"전환 주차"`**(또는 `"시즌 전환 중"`, 방향 필요 시
    `"봄 → 여름 시즌 전환"`). **`0주차`·`여름 시즌 0주차`·`[26년, 여름 시즌, 0주차]` 노출 전면 금지.**

즉 **front 레포는 항상 크루 formatter** 를 쓴다:

```ts
// admin 레포 lib/seasonCalendar.ts 의 formatCrewWeekLabel 미러(공통 isTransitionWeek 사용)
function formatCrewWeekLabel(week) {
  if (isTransitionWeek(week)) return "전환 주차"; // 숫자 0주차 노출 금지
  return `${year}년 ${seasonKo} 시즌 ${week.weekNumber}주차`;
}
```

일반 시즌명·주차번호 조합 로직은 전환 주차에서 실행하지 않는다. **숫자 `0주차` UI 는 front 에 신설하지 않는다.**

## 1. 근본 원인 — 전환 판정 2메커니즘이 모두 깨진다

프론트는 전환 주차를 두 방식으로 감지하는데, 재귀속 후 **둘 다 false 가 된다**:

- **(A) `season_type.includes("break")`** — 전환주차 season_key 가 다음 시즌으로 바뀌면 join 된
  `season_definitions.season_type` 가 `"summer"` 등 일반 시즌이 되어 `"break"` 미포함 → false.
- **(B) `isTransitionWeek(season, weekNumber)`** (`lib/cluster4-transition-week.ts:79-89`) —
  `(spring|fall && ===17)` / `(summer|winter && ===9)` 만 true. 재귀속 후 `season=여름(next), week=0` → false.

→ 조치 없으면 전환 주차가 "다음 시즌의 일반 0주차"로 렌더/집계된다(= 금지 상태).

## 2. 필수 패치 — 우선순위 순

### 2-1. 전환 판정 함수 (최우선, 단일 근원)
`lib/cluster4-transition-week.ts:79-89` `isTransitionWeek(season, weekNumber)`
- **추가**: `weekNumber === 0` 이면 true (재귀속 새 인코딩). 마이그레이션 과도기 대비 기존 `17/9`
  분기도 유지(둘 다 true 처리 = back-compat).
- `isOfficialRestWeek`(`:93-98`)가 이 함수에 위임하므로 함께 정상화된다.
- `getTransitionSeasonSpan`/`nextBaseSeason`(`:27-48`): 저장 season_key 가 이미 **다음 시즌**이므로
  "from=현재→to=다음"으로 문자열을 만들면 한 시즌 밀린다. 입력을 "저장 season_key = to(도착),
  from = 이전 시즌"으로 재해석하거나, week 객체를 그대로 넘겨 라벨만 `"전환 주차"`로 고정.

### 2-2. 서버 DTO의 `isBreak` 게이팅 (season_type "break" 의존 → week_number=0 병행 판정)
아래 라우트들은 `season_type.includes("break")` 로 전환을 판정한다. **week_number===0(또는 위 공통
함수) 판정을 OR 로 추가**해야 전환 분기(`"시즌 전환"` 등)가 유지된다:
- `app/(host)/api/profile/route.ts:1261 / :1267 / :1274 / :1283` — `currentSeasonInfo.isTransition`
  의 정본. 여기가 false 면 클라이언트 전환 배너가 전부 죽는다. **최우선.**
- `app/(host)/api/cluster4/weekly-growth/route.ts:49-65` (`isBreak = rawType.includes("break")`)
- `app/(host)/api/cluster-4-ranking/route.ts:64` (`isBreak = sType.includes('break')`)
- `lib/weekly-league.ts:535` (`isBreak = sType.includes("break")`)

### 2-3. season_key 집계/필터 — 전환 주차가 다음 시즌 일반 주차로 섞이지 않게 제외
`.eq/.in("season_key", …)` 로 시즌 집계할 때 `week_number=0`(전환) 행을 제외:
- `app/(host)/api/cluster-4-ranking/route.ts:194` (`w.season_key === selectedSeasonKey` 필터)
- `app/(host)/api/cluster4/weekly-growth/route.ts:76 / 375-391 / 510-524`
  (헤더 주석 line 32 "전환주차 자동 제외" 가정이 **더는 성립 안 함** → 명시 제외 필요)
- `lib/weekly-league.ts:564` (`.filter(w => !isTransitionWeek(...))` — 판정 고치면 자동 복구)
- `lib/weekly-league.ts:334 / 751-754`, `app/(host)/api/career-records/route.ts:226-227`

### 2-4. 숫자 `${weekNumber}주차` 렌더 가드 → `TRANSITION_WEEK_LABEL`
전환 주차가 도달하면 `0주차`가 찍히는 지점. (판정 고치면 대부분 상위에서 걸러지지만 방어적으로)
- `components/cluster-4-card/Cluster4CardContent.tsx:12604 / 13170 / 13677 / 6409-6412 / 6353`
- `lib/cluster4-types.ts:113 formatSeasonWeekTitle`, `:131-151 resolveSeasonWeekText`
  (현재 `n>0` 조건이라 0은 `"-"` 로 나옴 — `"전환 주차"` 로 교체)
- `components/cluster-4-1/Cluster41Content.tsx:944 / 995`,
  `components/cluster-4/Cluster4Content.tsx:3330 / 3357`
- `app/(host)/api/cluster-4-ranking/route.ts:81`, `lib/weekly-league.ts:548`

### 2-5. `lib/seasonCalendar.ts` (프론트 사본) 재동기화
프론트 사본 헤더는 아직 "전환 주차는 직전 시즌에 귀속"(구 모델). admin `lib/seasonCalendar.ts`
SoT 와 재동기화:
- admin 은 **순수 캘린더 boundary 를 바꾸지 않았다**(전환은 여전히 날짜로 판별). 대신
  `isTransitionWeek(week)` 공통 함수 + `TRANSITION_WEEK_LABEL` + `getPrevSeason` 추가.
- 프론트도 동일하게 `isTransitionWeek`/라벨 추가만 하면 되고, `getSeasonForDate` 등 boundary
  계산은 건드리지 않는다.
- `app/(host)/api/crews/route.ts:465`(`operationalSeasonDbKey(today)`) vs `:251`
  (`.eq("season_key", …)` on `user_season_statuses`): 운영 키(날짜 기반)와 DB season_key 가
  전환 주 동안 어긋나지 않는지 확인. `operationalSeasonDbKey` 는 이미 전환→다음 시즌을 반환하므로
  재귀속된 DB 와 방향 일치(정상).

### 2-6. 숫자 게이트 재검토
- `lib/confirmed-success-weeks.ts:36` (`if (isTransitionWeek(...)) continue;`) — 판정 고치면 정상.
- `components/cluster-4-card/Cluster4CardContent.tsx:1755` (`week_number >= 9` 스프링 게이트) —
  `week_number=0` 에서 뒤집히므로 재확인.

### (조건부) Career-Resume 트윈
`Career-Resume/…` 하위에 동일 버그 사본 존재(빌드 대상일 때만 패치):
`Career-Resume/components/cluster-4-1/Cluster41Content.tsx:795/828/1215`,
`Career-Resume/components/cluster-4/Cluster4Content.tsx:2992/3019/1420/1600`,
`Career-Resume/lib/cluster4-weekly-growth-service.ts:246`.

## 3. 검증 (프론트)
- 시나리오: 전환 주(예 2026-06-22~28) 로그인/조회 시 카드·랭킹·리그·이력서에서 `0주차`/`여름 0주차`/
  `봄 17주차` 미노출, `전환 주차`/`시즌 전환 중` 노출.
- 직전 주(06-21)=봄 마지막 정규 주차 정상, 다음 시즌 1주차(06-29~)=여름 1주차 정상.
- 시즌별 집계(랭킹/성장/리그)에 전환 주차 points/dates 가 다음 시즌으로 합산되지 않음.
- 배포 순서: **DB SQL 적용 → 프론트 패치 배포**. 프론트 미배포 상태로 DB 만 바뀌면 전환 주 동안
  프론트가 전환 주차를 여름 0주차로 표기(1주 한정 리스크). 전환 주가 아닌 시점(예 현재)에는 영향 없음.

## 4. 배포 정책 주의
프론트 레포 배포/푸시는 별도 계정·정책(`baibeu03-beep/vraxium`) 소관. 본 문서는 스펙 제공용이며
admin 세션에서 프론트를 푸시하지 않는다.
