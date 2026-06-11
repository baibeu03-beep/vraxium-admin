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

import { formatBannerPeriod } from "@/lib/practicalInfoSection0Format";

const DAY_NAMES = ["일", "월", "화", "수", "목", "금", "토"] as const;

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
};

export type LineOpeningStatusInput = {
  hubLabel: string; // "실무 경험"
  today: Date;
  currentWeek: StatusWeek | null; // 이번 주 N
  targetWeek: StatusWeek | null; // 지난 주(개설 대상)
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

// "26.07.06(월)" — 스펙 표기(공백 없음). practicalInfoSection0Format.formatToday 와 동일 의미이나
// 상태창 스펙 포맷(공백 제거)에 맞춘 변형.
function fmtTodayCompact(d: Date): string {
  const yy = String(((d.getFullYear() % 100) + 100) % 100).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yy}.${mm}.${dd}(${DAY_NAMES[d.getDay()]})`;
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
      tokens: [t("지난 주(개설 대상) 주차 정보를 확인할 수 없습니다.")],
    };
  }
  const period = periodLabel(targetWeek);
  const head: StatusToken[] = [
    t("지난 주 ["),
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
  const { targetWeek, teams, hubLabel } = input;
  if (!targetWeek) return [];
  const period = periodLabel(targetWeek);

  return teams.map((team) => {
    const head: StatusToken[] = [
      t("지난 주 ["),
      r(period),
      t("] 의 ‘"),
      r(team.teamName),
      t(`’ 의 [${hubLabel}] 허브 산하 라인이 `),
    ];
    if (team.opened) {
      return {
        id: `team-${team.teamId}`,
        tone: "positive",
        tokens: [...head, t("‘"), r("개설 완료"), t("’ 되었습니다.")],
      };
    }
    return {
      id: `team-${team.teamId}`,
      tone: "warning",
      tokens: [...head, t("‘"), r("개설"), t("’ 되어야 합니다.")],
    };
  });
}

// 허브 전체 1문장 개설 상태 — 실무 역량(competency)처럼 팀별 분기가 없는 허브용.
// 블록3(팀별)이 아니라 허브 산하 라인 전체의 개설 여부 1줄만 만든다. 빨강: 시즌·주차·개설/개설 완료.
//   기본:  "지난 주 [{period}] 의 [{hub}] 허브 산하 라인들이 ‘개설’ 되어야 합니다."
//   완료:  "지난 주 [{period}] 의 [{hub}] 허브 산하 라인들이 ‘개설 완료’ 되었습니다."
export function buildHubOpenStatusLine(input: {
  hubLabel: string;
  targetWeek: StatusWeek | null;
  opened: boolean;
}): StatusLine {
  const { hubLabel, targetWeek, opened } = input;
  if (!targetWeek) {
    return {
      id: "hub-open",
      tone: "neutral",
      tokens: [t("지난 주(개설 대상) 주차 정보를 확인할 수 없습니다.")],
    };
  }
  const period = periodLabel(targetWeek);
  const head: StatusToken[] = [
    t("지난 주 ["),
    r(period),
    t(`] 의 [${hubLabel}] 허브 산하 라인들이 `),
  ];
  if (opened) {
    return {
      id: "hub-open",
      tone: "positive",
      tokens: [...head, t("‘"), r("개설 완료"), t("’ 되었습니다.")],
    };
  }
  return {
    id: "hub-open",
    tone: "warning",
    tokens: [...head, t("‘"), r("개설"), t("’ 되어야 합니다.")],
  };
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
