// 라인 개설 상태창(운영 대시보드) 공용 엔진 — browser-safe 순수 모듈(DB·DOM·fetch 무관).
//
// 실무 정보(`PracticalInfoOpeningSection0`)에 흩어져 있던 "오늘/이번 주 + 지난 주(개설 대상) +
// 개설 현황" 안내 문구를, 허브명만 바꿔 실무 경험/정보/역량 3개 허브가 재사용할 수 있도록
// 단일 message builder 로 일반화한다.
//
// 출력은 "토큰 세그먼트" 배열이다 — 각 토큰은 { text, red } 이고, 컴포넌트는 red=true 토큰만
// 빨강 span 으로 감싸 렌더한다. 강조 규칙(날짜·시즌·주차·팀명·온라인/오프라인·개설/개설 완료)을
// 엔진이 단일 책임으로 보유하므로, 소비 컴포넌트는 표현만 담당한다.
//
// "지난 주" = 개설 대상 주차(금요일 경계 규칙, weeks-options 의 isOpenTarget 과 동일 SoT).
// 별도 Sunday reset 로직은 없다 — 3개 허브가 동일한 openable-week 경계를 쓴다.

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
  targetWeek: StatusWeek | null; // 개설 대상(운영) 주차 — 오늘 기준 금요일 경계 SoT
  extension: StatusExtension;
  teams: StatusTeam[];
};

// ──────────────────────────────────────────────────────────────
// 출력 타입
// ──────────────────────────────────────────────────────────────

export type StatusToken = { text: string; red: boolean };

export type StatusLine = {
  id: string;
  // 카드 톤 — 컴포넌트가 색 테두리/배경 선택에 사용.
  tone: "neutral" | "positive" | "warning";
  tokens: StatusToken[];
};

export type LineOpeningStatus = {
  block1: StatusLine; // 오늘 + 이번 주
  block2: StatusLine; // 확장 라인(대상 주차)
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

const t = (text: string): StatusToken => ({ text, red: false });
const r = (text: string): StatusToken => ({ text, red: true });

// 대상 주차 호칭 — 개설 대상 주차(금요일 경계 SoT = getOpenableWeekStartMs)와 현재 주차 N 의
// 관계로 결정한다. 같은 주차(금~일: 대상=N)면 "이번 주", 다른 주차면 "지난 주".
//   ⚠ 금요일 경계에서 대상 주차는 항상 N(같음) 또는 N-1(직전) 둘 중 하나뿐이다. 따라서 "다른 주차"
//     = 반드시 N-1 = 실제 지난 주이며, "지난 주"는 단순 라벨 치환이 아니라 서버가 getOpenableWeekStartMs
//     로 실제 조회해 넘긴 N-1 주차(block1 의 이번 주 N 과 다른 값)를 가리킨다. 동일 주차 판정은
//     startDate(YYYY-MM-DD). (금~일은 대상=N=이번 주라 "지난 주"로 부르지 않는다 — 오표기 방지.)
function targetWeekPrefix(
  current: StatusWeek | null,
  target: StatusWeek,
): string {
  if (current && current.startDate === target.startDate) return "이번 주";
  return "지난 주";
}

// 개설 상태 꼬리 문구 — 허브/팀 공용. head 가 "… 라인이 "/"… 라인들이 " 로 끝난 뒤 이어진다.
//   opened               → "‘개설’ 되어, ‘크루 기입이 가능’합니다."  (positive)
//   미개설·휴식 주차      → "개설 대상이 아닙니다 (공식 휴식 주차)."  (neutral — 액션 요구 안 함)
//   미개설·개설 기간 아님 → "개설 대상이 아닙니다 (미오픈)."     (neutral — 개설 필요 안내 금지)
//   미개설·정규 주차      → "‘개설’ 되어야 합니다."          (warning)
//   ⚠ isOpeningPeriod 는 opt-in — 명시적으로 false 일 때만 '미오픈'으로 표기하고, undefined(미지정) 허브는
//     기존 동작(휴식 아니면 '개설 되어야 합니다')을 유지한다.
function openStateTail(
  opened: boolean,
  isOfficialRest: boolean | undefined,
  isOpeningPeriod?: boolean,
): { tone: StatusLine["tone"]; tokens: StatusToken[] } {
  if (opened) {
    // 개설 완료 → 크루 기입 단계. 핵심 상태('개설'·'크루 기입이 가능')만 red 강조(§6).
    return {
      tone: "positive",
      tokens: [t("‘"), r("개설"), t("’ 되어, "), r("크루 기입이 가능"), t("합니다.")],
    };
  }
  if (isOfficialRest) {
    return {
      tone: "neutral",
      tokens: [t("개설 대상이 아닙니다 ("), r("공식 휴식 주차"), t(").")],
    };
  }
  if (isOpeningPeriod === false) {
    return {
      tone: "neutral",
      tokens: [t("개설 대상이 아닙니다 ("), r("미오픈"), t(").")],
    };
  }
  return { tone: "warning", tokens: [t("‘"), r("개설"), t("’ 되어야 합니다.")] };
}

// ──────────────────────────────────────────────────────────────
// 블록 빌더
// ──────────────────────────────────────────────────────────────

// 블록1 — 오늘 + 이번 주(N). 빨강: 날짜·시즌·주차.
function buildBlock1(input: LineOpeningStatusInput): StatusLine {
  const tokens: StatusToken[] = [
    t("오늘은 "),
    r(fmtTodayCompact(input.today)),
  ];
  if (input.currentWeek) {
    tokens.push(
      t(" 이며, 이번 주는 ["),
      r(periodLabel(input.currentWeek)),
      t("] 입니다. (월 ~ 일)"),
    );
  } else {
    tokens.push(t(" 이며, 이번 주 정보를 확인할 수 없습니다."));
  }
  return { id: "block1", tone: "neutral", tokens };
}

// 블록2 — 확장 라인(대상 주차 기준). 빨강: 시즌·주차·온라인/오프라인.
function buildBlock2(input: LineOpeningStatusInput): StatusLine {
  const { targetWeek, extension, hubLabel } = input;
  if (!targetWeek) {
    return {
      id: "block2",
      tone: "neutral",
      tokens: [t("개설 대상 주차 정보를 확인할 수 없습니다.")],
    };
  }
  const period = periodLabel(targetWeek);
  const prefix = targetWeekPrefix(input.currentWeek, targetWeek);
  const head: StatusToken[] = [
    t(`${prefix} [`),
    r(period),
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
  const tail: StatusToken[] = [t("<확장> 류 라인 중 ‘"), r(kindLabel), t("’ 해당 기간입니다.")];
  if (extension.index != null && extension.total != null) {
    tail.push(t(` (${extension.index}/${extension.total})`));
  }
  return { id: "block2", tone: "positive", tokens: [...head, ...tail] };
}

// 블록3 — 팀별 개설 현황. 팀마다 1줄. 빨강: 시즌·주차·팀명·개설/개설 완료.
function buildBlock3(input: LineOpeningStatusInput): StatusLine[] {
  const { targetWeek, teams } = input;
  if (!targetWeek) return [];
  const period = periodLabel(targetWeek);
  const prefix = targetWeekPrefix(input.currentWeek, targetWeek);

  return teams.map((team) => {
    // "지난 주 [26년, 여름 시즌, 3주차] 의 위즈덤 라인이 …" — 팀명이 곧 라인 주체(허브명 생략,
    //   화면이 이미 해당 허브 탭이라 문맥 중복). red: 주차·팀명.
    const head: StatusToken[] = [
      t(`${prefix} [`),
      r(period),
      t("] 의 "),
      r(team.teamName),
      t(" 라인이 "),
    ];
    const tail = openStateTail(
      team.opened,
      targetWeek.isOfficialRest,
      team.isOpeningPeriod,
    );
    return {
      id: `team-${team.teamId}`,
      tone: tail.tone,
      tokens: [...head, ...tail.tokens],
    };
  });
}

// 허브 전체 1문장 개설 상태 — 실무 역량(competency)처럼 팀별 분기가 없는 허브용.
// 블록3(팀별)이 아니라 허브 산하 라인 전체의 개설 여부 1줄만 만든다. 빨강: 시즌·주차·개설/개설 완료.
//   완료:  "{prefix} [{period}] 의 [{hub}] 허브 산하 라인들이 ‘개설 완료’ 되었습니다."
//   미개설(정규):  "… 라인들이 ‘개설’ 되어야 합니다."
//   미개설(휴식):  "… 라인들이 개설 대상이 아닙니다 (공식 휴식 주차)."
//   prefix = 대상 주차==현재 주차면 "이번 주", 아니면 "개설 대상 주차" (targetWeekPrefix).
export function buildHubOpenStatusLine(input: {
  hubLabel: string;
  currentWeek: StatusWeek | null;
  targetWeek: StatusWeek | null;
  opened: boolean;
}): StatusLine {
  const { hubLabel, currentWeek, targetWeek, opened } = input;
  if (!targetWeek) {
    return {
      id: "hub-open",
      tone: "neutral",
      tokens: [t("개설 대상 주차 정보를 확인할 수 없습니다.")],
    };
  }
  const period = periodLabel(targetWeek);
  const prefix = targetWeekPrefix(currentWeek, targetWeek);
  const head: StatusToken[] = [
    t(`${prefix} [`),
    r(period),
    t(`] 의 [${hubLabel}] 허브 산하 라인들이 `),
  ];
  const tail = openStateTail(opened, targetWeek.isOfficialRest);
  return { id: "hub-open", tone: tail.tone, tokens: [...head, ...tail.tokens] };
}

// ──────────────────────────────────────────────────────────────
// Public entry
// ──────────────────────────────────────────────────────────────

export function buildLineOpeningStatus(
  input: LineOpeningStatusInput,
): LineOpeningStatus {
  return {
    block1: buildBlock1(input),
    block2: buildBlock2(input),
    block3: buildBlock3(input),
  };
}
