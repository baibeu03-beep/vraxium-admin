export type WeeklyCardResultStatus =
  | "approved"
  | "failed"
  | "personal_rest"
  | "official_rest";

export type WeeklyCardLineDetail = {
  completed: number;
  available: number;
};

export type WeeklyCardLineBreakdown = {
  info: WeeklyCardLineDetail;
  ability: WeeklyCardLineDetail;
  experience: WeeklyCardLineDetail;
  career: WeeklyCardLineDetail;
};

export type WeeklyCardDto = {
  seasonYear: number;
  seasonName: string;
  weekNumber: number;
  startDate: string;
  endDate: string;
  dateRangeDisplay: string;
  resultStatus: WeeklyCardResultStatus;
  resultLabel: string;
  accumulatedApprovedWeeks: number;
  targetWeeks: number;
  activityStatus: string;
  teamLabel: string;
  partLabel: string;
  dangamCount: number;
  injeolmiCount: number;
  eoheungCount: number;
  weeklyReputationCount: number;
  totalFmScore: number;
  linkedCrewCount: number;
  weekImagePath: string;
  weeklyGrowth: {
    completedLines: number;
    availableLines: number;
    rate: number;
  };
  lineBreakdown: WeeklyCardLineBreakdown;
};

const RESULT_LABELS: Record<WeeklyCardResultStatus, string> = {
  approved: "성장(성공)",
  failed: "성장(실패)",
  personal_rest: "휴식(개인)",
  official_rest: "휴식(공식)",
};

function computeGrowthRate(lb: WeeklyCardLineBreakdown): {
  completedLines: number;
  availableLines: number;
  rate: number;
} {
  const completed =
    lb.info.completed +
    lb.ability.completed +
    lb.experience.completed +
    lb.career.completed;
  const available =
    lb.info.available +
    lb.ability.available +
    lb.experience.available +
    lb.career.available;
  const rate = available === 0 ? 0 : Math.ceil((completed / available) * 100);
  return { completedLines: completed, availableLines: available, rate };
}

function formatDateRange(start: string, end: string): string {
  const days = ["일", "월", "화", "수", "목", "금", "토"];
  const s = new Date(start + "T00:00:00");
  const e = new Date(end + "T00:00:00");
  const fmt = (d: Date) => {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    const dow = days[d.getDay()];
    return `${y}. ${m}. ${day} (${dow})`;
  };
  return `${fmt(s)} ~ ${fmt(e)}`;
}

type CardInput = {
  weekNumber: number;
  startDate: string;
  endDate: string;
  resultStatus: WeeklyCardResultStatus;
  accumulatedApprovedWeeks: number;
  dangamCount: number;
  injeolmiCount: number;
  eoheungCount: number;
  weeklyReputationCount: number;
  totalFmScore: number;
  linkedCrewCount: number;
  lineBreakdown: WeeklyCardLineBreakdown;
  activityStatus: string;
};

function card(input: CardInput): WeeklyCardDto {
  const growth = computeGrowthRate(input.lineBreakdown);
  const seasonKey = "2026-spring";
  return {
    seasonYear: 2026,
    seasonName: "봄 시즌",
    weekNumber: input.weekNumber,
    startDate: input.startDate,
    endDate: input.endDate,
    dateRangeDisplay: formatDateRange(input.startDate, input.endDate),
    resultStatus: input.resultStatus,
    resultLabel: RESULT_LABELS[input.resultStatus],
    accumulatedApprovedWeeks: input.accumulatedApprovedWeeks,
    targetWeeks: 30,
    activityStatus: input.activityStatus,
    teamLabel: "미디어",
    partLabel: "웹툰드라마",
    dangamCount: input.dangamCount,
    injeolmiCount: input.injeolmiCount,
    eoheungCount: input.eoheungCount,
    weeklyReputationCount: input.weeklyReputationCount,
    totalFmScore: input.totalFmScore,
    linkedCrewCount: input.linkedCrewCount,
    weekImagePath: `/images/0/cluster4/weekly/${seasonKey}-week${input.weekNumber}.png`,
    weeklyGrowth: growth,
    lineBreakdown: input.lineBreakdown,
  };
}

// ──────────────────────────────────────────────────────────────
// 2026 봄 시즌 1~13주차 (최신순, 내림차순)
//
// 누적 필드 계산표 (시간순)
// ─────────────────────────────────────────────────────────────
// W  status          acc  inj  fm   rep  notes
// 1  approved         1    1    2   2
// 2  approved         2    2    5   3
// 3  failed           2    2    6   1    초반 실패
// 4  approved         3    3    6   0
// 5  approved         4    3    8   2
// 6  approved         5    4    10  2
// 7  approved         6    5    14  4
// 8  personal_rest    6    5    14  0    개인 휴식
// 9  approved         7    7    17  3
// 10 official_rest    7    7    17  0    공식 휴식
// 11 failed           7    8    19  2    중후반 실패
// 12 approved         8    8    23  4
// 13 approved         9    9    26  3
// ──────────────────────────────────────────────────────────────
export const DUMMY_WEEKLY_CARDS: WeeklyCardDto[] = [
  // ── 13주차 ──
  card({
    weekNumber: 13,
    startDate: "2026-05-25",
    endDate: "2026-05-31",
    resultStatus: "approved",
    accumulatedApprovedWeeks: 9,
    dangamCount: 3,
    injeolmiCount: 9,
    eoheungCount: 0,
    weeklyReputationCount: 3,
    totalFmScore: 26,
    linkedCrewCount: 3,
    lineBreakdown: {
      info: { completed: 6, available: 7 },
      ability: { completed: 1, available: 1 },
      experience: { completed: 2, available: 2 },
      career: { completed: 1, available: 2 },
    },
    activityStatus: "심화(에이전트)",
  }),
  // ── 12주차 ──
  card({
    weekNumber: 12,
    startDate: "2026-05-18",
    endDate: "2026-05-24",
    resultStatus: "approved",
    accumulatedApprovedWeeks: 8,
    dangamCount: 3,
    injeolmiCount: 8,
    eoheungCount: 0,
    weeklyReputationCount: 4,
    totalFmScore: 23,
    linkedCrewCount: 2,
    lineBreakdown: {
      info: { completed: 5, available: 7 },
      ability: { completed: 1, available: 1 },
      experience: { completed: 2, available: 2 },
      career: { completed: 2, available: 2 },
    },
    activityStatus: "심화(에이전트)",
  }),
  // ── 11주차 ──
  card({
    weekNumber: 11,
    startDate: "2026-05-11",
    endDate: "2026-05-17",
    resultStatus: "failed",
    accumulatedApprovedWeeks: 7,
    dangamCount: 1,
    injeolmiCount: 8,
    eoheungCount: -1,
    weeklyReputationCount: 2,
    totalFmScore: 19,
    linkedCrewCount: 1,
    lineBreakdown: {
      info: { completed: 3, available: 7 },
      ability: { completed: 0, available: 1 },
      experience: { completed: 1, available: 2 },
      career: { completed: 0, available: 2 },
    },
    activityStatus: "심화(에이전트)",
  }),
  // ── 10주차 ──
  card({
    weekNumber: 10,
    startDate: "2026-05-04",
    endDate: "2026-05-10",
    resultStatus: "official_rest",
    accumulatedApprovedWeeks: 7,
    dangamCount: 0,
    injeolmiCount: 7,
    eoheungCount: 0,
    weeklyReputationCount: 0,
    totalFmScore: 17,
    linkedCrewCount: 0,
    lineBreakdown: {
      info: { completed: 0, available: 0 },
      ability: { completed: 0, available: 0 },
      experience: { completed: 0, available: 0 },
      career: { completed: 0, available: 0 },
    },
    activityStatus: "심화(에이전트)",
  }),
  // ── 9주차 ──
  card({
    weekNumber: 9,
    startDate: "2026-04-27",
    endDate: "2026-05-03",
    resultStatus: "approved",
    accumulatedApprovedWeeks: 7,
    dangamCount: 2,
    injeolmiCount: 7,
    eoheungCount: 0,
    weeklyReputationCount: 3,
    totalFmScore: 17,
    linkedCrewCount: 3,
    lineBreakdown: {
      info: { completed: 7, available: 7 },
      ability: { completed: 1, available: 1 },
      experience: { completed: 2, available: 2 },
      career: { completed: 2, available: 2 },
    },
    activityStatus: "심화(에이전트)",
  }),
  // ── 8주차 ──
  card({
    weekNumber: 8,
    startDate: "2026-04-20",
    endDate: "2026-04-26",
    resultStatus: "personal_rest",
    accumulatedApprovedWeeks: 6,
    dangamCount: 0,
    injeolmiCount: 5,
    eoheungCount: 0,
    weeklyReputationCount: 0,
    totalFmScore: 14,
    linkedCrewCount: 0,
    lineBreakdown: {
      info: { completed: 0, available: 0 },
      ability: { completed: 0, available: 0 },
      experience: { completed: 0, available: 0 },
      career: { completed: 0, available: 0 },
    },
    activityStatus: "심화(에이전트)",
  }),
  // ── 7주차 ──
  card({
    weekNumber: 7,
    startDate: "2026-04-13",
    endDate: "2026-04-19",
    resultStatus: "approved",
    accumulatedApprovedWeeks: 6,
    dangamCount: 3,
    injeolmiCount: 5,
    eoheungCount: 0,
    weeklyReputationCount: 4,
    totalFmScore: 14,
    linkedCrewCount: 2,
    lineBreakdown: {
      info: { completed: 6, available: 7 },
      ability: { completed: 1, available: 1 },
      experience: { completed: 1, available: 2 },
      career: { completed: 1, available: 2 },
    },
    activityStatus: "심화(에이전트)",
  }),
  // ── 6주차 ──
  card({
    weekNumber: 6,
    startDate: "2026-04-06",
    endDate: "2026-04-12",
    resultStatus: "approved",
    accumulatedApprovedWeeks: 5,
    dangamCount: 2,
    injeolmiCount: 4,
    eoheungCount: 0,
    weeklyReputationCount: 2,
    totalFmScore: 10,
    linkedCrewCount: 2,
    lineBreakdown: {
      info: { completed: 5, available: 7 },
      ability: { completed: 1, available: 1 },
      experience: { completed: 2, available: 2 },
      career: { completed: 1, available: 2 },
    },
    activityStatus: "일반",
  }),
  // ── 5주차 ──
  card({
    weekNumber: 5,
    startDate: "2026-03-30",
    endDate: "2026-04-05",
    resultStatus: "approved",
    accumulatedApprovedWeeks: 4,
    dangamCount: 1,
    injeolmiCount: 3,
    eoheungCount: 0,
    weeklyReputationCount: 2,
    totalFmScore: 8,
    linkedCrewCount: 3,
    lineBreakdown: {
      info: { completed: 6, available: 7 },
      ability: { completed: 1, available: 1 },
      experience: { completed: 1, available: 2 },
      career: { completed: 2, available: 2 },
    },
    activityStatus: "일반",
  }),
  // ── 4주차 ──
  card({
    weekNumber: 4,
    startDate: "2026-03-23",
    endDate: "2026-03-29",
    resultStatus: "approved",
    accumulatedApprovedWeeks: 3,
    dangamCount: 2,
    injeolmiCount: 3,
    eoheungCount: 0,
    weeklyReputationCount: 0,
    totalFmScore: 6,
    linkedCrewCount: 2,
    lineBreakdown: {
      info: { completed: 5, available: 7 },
      ability: { completed: 1, available: 1 },
      experience: { completed: 2, available: 2 },
      career: { completed: 1, available: 2 },
    },
    activityStatus: "일반",
  }),
  // ── 3주차 ──
  card({
    weekNumber: 3,
    startDate: "2026-03-16",
    endDate: "2026-03-22",
    resultStatus: "failed",
    accumulatedApprovedWeeks: 2,
    dangamCount: 0,
    injeolmiCount: 2,
    eoheungCount: -1,
    weeklyReputationCount: 1,
    totalFmScore: 6,
    linkedCrewCount: 1,
    lineBreakdown: {
      info: { completed: 2, available: 7 },
      ability: { completed: 0, available: 1 },
      experience: { completed: 0, available: 2 },
      career: { completed: 0, available: 2 },
    },
    activityStatus: "일반",
  }),
  // ── 2주차 ──
  card({
    weekNumber: 2,
    startDate: "2026-03-09",
    endDate: "2026-03-15",
    resultStatus: "approved",
    accumulatedApprovedWeeks: 2,
    dangamCount: 1,
    injeolmiCount: 2,
    eoheungCount: 0,
    weeklyReputationCount: 3,
    totalFmScore: 5,
    linkedCrewCount: 2,
    lineBreakdown: {
      info: { completed: 5, available: 7 },
      ability: { completed: 1, available: 1 },
      experience: { completed: 1, available: 2 },
      career: { completed: 1, available: 2 },
    },
    activityStatus: "일반",
  }),
  // ── 1주차 ──
  card({
    weekNumber: 1,
    startDate: "2026-03-02",
    endDate: "2026-03-08",
    resultStatus: "approved",
    accumulatedApprovedWeeks: 1,
    dangamCount: 2,
    injeolmiCount: 1,
    eoheungCount: 0,
    weeklyReputationCount: 2,
    totalFmScore: 2,
    linkedCrewCount: 1,
    lineBreakdown: {
      info: { completed: 4, available: 7 },
      ability: { completed: 1, available: 1 },
      experience: { completed: 1, available: 2 },
      career: { completed: 1, available: 2 },
    },
    activityStatus: "일반",
  }),
];

export const SEASON_OPTIONS = [
  { value: "all", label: "전체" },
  { value: "2026_spring", label: "2026 봄 시즌" },
  { value: "2025_winter", label: "2025 겨울 시즌" },
] as const;

export const RESULT_OPTIONS = [
  { value: "all", label: "전체" },
  { value: "approved", label: "성장(성공)" },
  { value: "failed", label: "성장(실패)" },
  { value: "personal_rest", label: "휴식(개인)" },
  { value: "official_rest", label: "휴식(공식)" },
] as const;
