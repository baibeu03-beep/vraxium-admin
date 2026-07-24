// 라인 개설 상태창(운영 대시보드) 공용 엔진 — browser-safe 순수 모듈(DB·DOM·fetch 무관).
//
// 실무 정보(`PracticalInfoOpeningSection0`)에 흩어져 있던 "오늘/이번 주 + 개설 대상 주차 +
// 개설 현황" 안내 문구를, 허브명만 바꿔 실무 경험/정보/역량 3개 허브가 재사용할 수 있도록
// 단일 message builder 로 일반화한다.
//
// 출력은 "토큰 세그먼트" 배열이다 — 각 토큰은 { text, kind } 이고, 컴포넌트는 kind(역할)에 따라
// 강조 스타일을 입혀 렌더한다(공통 statusTokenClass). 강조 규칙(날짜·주차=rose / 팀·라인=blue /
// 개설 완료·크루 기입=green / 개설 필요=amber / 해당 기간 아님=gray)을 엔진이 단일 책임으로 보유하므로,
// 소비 컴포넌트는 표현만 담당한다(역할별 공통 토큰 — 페이지마다 개별 스타일 금지).
//
// ⚠ 상태창은 "개설 대상 주차"(금요일 경계 규칙, weeks-options 의 isOpenTarget 과 동일 SoT)만 서술한다.
//   금요일 경계상 개설 대상 주차는 월~목엔 직전 주(N-1), 금~일엔 현재 주(N)다. 화면 문구는 프로젝트
//   관용대로 "지난 주"로 표기한다(금~일엔 이번 주와 같은 주차로 보이는 것은 금요일 경계 규칙에 따른 정상 동작).
//   '선택한 주차' 서술은 이 엔진이 생성하지 않는다(상태창은 개설 대상 주차만 표시).

import { formatClubDate } from "@/lib/clubDate";
import { formatBannerPeriod } from "@/lib/practicalInfoSection0Format";

// ──────────────────────────────────────────────────────────────
// 입력 타입 (서버 상태 API 응답을 그대로 받는다)
// ──────────────────────────────────────────────────────────────

export type StatusWeek = {
  year: number;
  seasonName: string; // "여름 시즌"
  weekNumber: number;
  startDate: string; // YYYY-MM-DD
  endDate: string; // YYYY-MM-DD
  isOfficialRest?: boolean;
};

export type StatusExtension = {
  kind: "none" | "online" | "offline";
  // 확장 기간 내 대상 주차의 위치/총수. 미상이면 null (표기 생략).
  index: number | null;
  total: number | null;
};

export type StatusTeam = {
  teamId: string;
  teamName: string;
  opened: boolean;
  // 이 주차·팀이 라인 개설 기간인가(SoT = cluster4_week_opening_configs). 명시적으로 false 면
  //   "개설되어야 합니다"(warning) 대신 "개설 기간이 아닙니다 (미오픈)"(neutral)로 표기한다.
  //   undefined(미지정)면 기존 동작 유지 — info/competency 등 이 필드를 채우지 않는 허브는 무영향(opt-in).
  isOpeningPeriod?: boolean;
};

export type LineOpeningStatusInput = {
  hubLabel: string; // "실무 경험"
  today: Date;
  currentWeek: StatusWeek | null; // 이번 주 N
  targetWeek: StatusWeek | null; // 개설 대상 주차 — 오늘 기준 금요일 경계 SoT
  extension: StatusExtension;
  teams: StatusTeam[];
};

// ──────────────────────────────────────────────────────────────
// 출력 타입
// ──────────────────────────────────────────────────────────────

// 토큰 역할(강조 스타일 SoT) — 색은 컴포넌트(statusTokenClass)가 역할별로 매핑한다.
//   plain=강조 없음 · date=날짜/주차(rose) · team=팀/라인명(blue) · openDone=개설 완료(green) ·
//   openNeed=개설 필요(amber) · crewOk=크루 기입 가능(green) · periodNone=해당 기간 아님/휴식/미오픈(gray) ·
//   accent=온라인/오프라인 등 보조 강조(indigo).
export type StatusTokenKind =
  | "plain"
  | "date"
  | "team"
  | "openDone"
  | "openNeed"
  | "crewOk"
  | "periodNone"
  | "accent";

export type StatusToken = { text: string; kind: StatusTokenKind };

export type StatusLine = {
  id: string;
  // 카드 톤 — 컴포넌트가 bullet(●) 색 선택에 사용(색만이 아니라 점 아이콘 색+문구로 상태 구분).
  tone: "neutral" | "positive" | "warning";
  tokens: StatusToken[];
};

export type LineOpeningStatus = {
  block1: StatusLine; // 오늘 + 이번 주
  block2: StatusLine; // 확장 라인(개설 대상 주차)
  block3: StatusLine[]; // 팀별 개설 현황 (org 팀마다 1줄)
};

// ──────────────────────────────────────────────────────────────
// 포맷 헬퍼
// ──────────────────────────────────────────────────────────────

// "26 - 07 - 06 (월)" — 오늘 날짜. 클럽 일정 공통 표기(formatClubDate SoT).
function fmtTodayCompact(d: Date): string {
  return formatClubDate(d);
}

// "26년, 여름 시즌, 2주차" — 기존 SoT 포맷 재사용.
function periodLabel(w: StatusWeek): string {
  return formatBannerPeriod({
    year: w.year,
    seasonName: w.seasonName,
    weekNumber: w.weekNumber,
  });
}

// 역할별 토큰 생성기 — 문장 빌더가 의미(역할)만 지정하고 색은 컴포넌트에 위임한다.
const tok = (text: string, kind: StatusTokenKind): StatusToken => ({ text, kind });
const t = (text: string): StatusToken => tok(text, "plain");
const date = (text: string): StatusToken => tok(text, "date");
const team = (text: string): StatusToken => tok(text, "team");

// 개설 대상 주차 호칭(SoT) — 화면 문구는 프로젝트 관용대로 "지난 주"로 유지한다.
//   (실제 대상 = 개설 대상 주차 = 금요일 경계상 월~목 N-1·금~일 N. 금~일엔 이번 주와 같은 주차로 표시되는 것은
//    금요일 경계 규칙에 따른 정상 동작이라 판정 로직은 변경하지 않는다.)
const TARGET_WEEK_PREFIX = "지난 주";

// 개설 상태 꼬리 문구 — 허브/팀 공용. head 가 "… 라인이 " 로 끝난 뒤 이어진다.
//   opened               → "‘개설’ 되어, ‘크루 기입이 가능’합니다."  (positive)
//   미개설·휴식 주차      → "개설 대상이 아닙니다 (공식 휴식 주차)."  (neutral)
//   미개설·개설 기간 아님 → "개설 대상이 아닙니다 (미오픈)."     (neutral)
//   미개설·정규 주차      → "‘개설’ 되어야 합니다."          (warning)
function openStateTail(
  opened: boolean,
  isOfficialRest: boolean | undefined,
  isOpeningPeriod?: boolean,
): { tone: StatusLine["tone"]; tokens: StatusToken[] } {
  if (opened) {
    // 개설 완료 → 크루 기입 단계. '개설'(완료)·'크루 기입이 가능'은 초록 강조(bullet 도 positive).
    return {
      tone: "positive",
      tokens: [t("‘"), tok("개설", "openDone"), t("’ 되어, "), tok("크루 기입이 가능", "crewOk"), t("합니다.")],
    };
  }
  if (isOfficialRest) {
    return {
      tone: "neutral",
      tokens: [t("개설 대상이 아닙니다 ("), tok("공식 휴식 주차", "periodNone"), t(").")],
    };
  }
  if (isOpeningPeriod === false) {
    return {
      tone: "neutral",
      tokens: [t("개설 대상이 아닙니다 ("), tok("미오픈", "periodNone"), t(").")],
    };
  }
  // 개설 필요 → 주황/앰버 강조(bullet 도 warning).
  return { tone: "warning", tokens: [t("‘"), tok("개설", "openNeed"), t("’ 되어야 합니다.")] };
}

// ──────────────────────────────────────────────────────────────
// 블록 빌더
// ──────────────────────────────────────────────────────────────

// 블록1 — 오늘 + 이번 주(N). 강조: 날짜·주차(rose).
function buildBlock1(input: LineOpeningStatusInput): StatusLine {
  const tokens: StatusToken[] = [t("오늘은 "), date(fmtTodayCompact(input.today))];
  if (input.currentWeek) {
    tokens.push(
      t(" 이며, 이번 주는 ["),
      date(periodLabel(input.currentWeek)),
      t("] 입니다. (월 ~ 일)"),
    );
  } else {
    tokens.push(t(" 이며, 이번 주 정보를 확인할 수 없습니다."));
  }
  return { id: "block1", tone: "neutral", tokens };
}

// 블록2 — 확장 라인(개설 대상 주차 기준). 강조: 주차(rose)·온라인/오프라인(accent).
function buildBlock2(input: LineOpeningStatusInput): StatusLine {
  const { targetWeek, extension, hubLabel } = input;
  if (!targetWeek) {
    return {
      id: "block2",
      tone: "neutral",
      tokens: [t("개설 대상 주차 정보를 확인할 수 없습니다.")],
    };
  }
  const head: StatusToken[] = [
    t(`${TARGET_WEEK_PREFIX} [`),
    date(periodLabel(targetWeek)),
    t(`] 는 [${hubLabel}] 허브(각 세부 팀) 산하 `),
  ];

  if (extension.kind === "none") {
    return {
      id: "block2",
      tone: "neutral",
      tokens: [...head, t("<확장> 류 라인 해당 기간이 아닙니다.")],
    };
  }

  const kindLabel = extension.kind === "online" ? "온라인" : "오프라인";
  const tail: StatusToken[] = [t("<확장> 류 라인 중 ‘"), tok(kindLabel, "accent"), t("’ 해당 기간입니다.")];
  if (extension.index != null && extension.total != null) {
    tail.push(t(` (${extension.index}/${extension.total})`));
  }
  return { id: "block2", tone: "positive", tokens: [...head, ...tail] };
}

// 블록3 — 팀별 개설 현황. 팀마다 1줄. 강조: 주차(rose)·팀명(blue)·개설 상태(green/amber/gray).
function buildBlock3(input: LineOpeningStatusInput): StatusLine[] {
  const { targetWeek, teams } = input;
  if (!targetWeek) return [];
  const period = periodLabel(targetWeek);

  return teams.map((tm) => {
    // "개설 대상 주차 [26년, 여름 시즌, 3주차] 의 위즈덤 라인이 …" — 팀명이 곧 라인 주체(허브명 생략,
    //   화면이 이미 해당 허브 탭이라 문맥 중복). 강조: 주차(rose)·팀명(blue).
    const head: StatusToken[] = [
      t(`${TARGET_WEEK_PREFIX} [`),
      date(period),
      t("] 의 "),
      team(tm.teamName),
      t(" 라인이 "),
    ];
    const tail = openStateTail(tm.opened, targetWeek.isOfficialRest, tm.isOpeningPeriod);
    return { id: `team-${tm.teamId}`, tone: tail.tone, tokens: [...head, ...tail.tokens] };
  });
}

// 허브 전체 1문장 개설 상태 — 실무 역량(competency)처럼 팀별 분기가 없는 허브용.
//   완료:  "개설 대상 주차 [{period}] 의 [{hub}] 허브 산하 라인들이 ‘개설’ 되어, 크루 기입이 가능합니다."
//   미개설(정규):  "… 라인들이 ‘개설’ 되어야 합니다."
//   미개설(휴식):  "… 라인들이 개설 대상이 아닙니다 (공식 휴식 주차)."
export function buildHubOpenStatusLine(input: {
  hubLabel: string;
  currentWeek: StatusWeek | null;
  targetWeek: StatusWeek | null;
  opened: boolean;
}): StatusLine {
  const { hubLabel, targetWeek, opened } = input;
  if (!targetWeek) {
    return {
      id: "hub-open",
      tone: "neutral",
      tokens: [t("개설 대상 주차 정보를 확인할 수 없습니다.")],
    };
  }
  const head: StatusToken[] = [
    t(`${TARGET_WEEK_PREFIX} [`),
    date(periodLabel(targetWeek)),
    t(`] 의 [${hubLabel}] 허브 산하 라인들이 `),
  ];
  const tail = openStateTail(opened, targetWeek.isOfficialRest);
  return { id: "hub-open", tone: tail.tone, tokens: [...head, ...tail.tokens] };
}

// ──────────────────────────────────────────────────────────────
// Public entry
// ──────────────────────────────────────────────────────────────

export function buildLineOpeningStatus(input: LineOpeningStatusInput): LineOpeningStatus {
  return {
    block1: buildBlock1(input),
    block2: buildBlock2(input),
    block3: buildBlock3(input),
  };
}
