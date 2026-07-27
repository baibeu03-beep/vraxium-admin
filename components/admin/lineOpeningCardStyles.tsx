import { cn } from "@/lib/utils";

// 어드민 "업무 카드" 표현 SoT — **스타일 전용**. 최초 도입 화면이 라인 개설이라 파일명이 lineOpening* 이지만,
// 적용 범위는 라인 개설에 국한되지 않는다(같은 디자인 언어를 쓰는 화면은 이 파일 하나만 재사용한다).
//   ① /admin/integrated/line-opening/*      — 상태창·로그창 + '라인 개설' 카드(실무 정보/경험/역량 3화면)
//   ② /admin/integrated/processes/check/*   — 상태창1·로그창·상태창2·파트 구분·액트 목록·변동 액트(2026-07-27 추가)
//   대상: 상단 상태창·로그창 + 하단 '라인 개설' 카드 전체(실무 정보/경험/역량 3화면 공통).
//   기존 문제: 카드가 ring-1 외곽선만 가져서 카드 간 경계가 약하고, 헤더와 본문이 한 덩어리로 읽혔다.
//   변경: [라인 관리] 탭의 팀 카드(ExperienceLineManageBoard.TeamCard)와 동일한 디자인 언어를 공용화한다.
//     ① 좌측 4px accent border  ② 헤더 영역의 은은한 배경 틴트  ③ 외곽선(ring) 존재감 강화 + shadow-sm
//     ④ 제목 앞 accent 도트     ⑤ 헤더/본문의 자연스러운 색 분리
//   ⚠ 레이아웃·크기·배치·내용·기능/데이터 흐름은 건드리지 않는다(클래스만 추가).
//   ⚠ 이 파일을 import 하는 컴포넌트만 영향을 받는다 — 공용 components/ui/card 는 수정하지 않으므로
//     다른 어드민 화면의 Card 는 그대로다.
//
// tone = 카드의 역할/상태. 라이트·다크 모두 가독성 확보(50/70·950/25 쌍은 팀 카드와 동일 규격).
//   status  : 상태창(모니터링)              — 스카이
//   log     : 로그창(기록)                  — 중립(muted/슬레이트)
//   action  : 라인 개설(실행/입력) 기본     — 인디고(statusTokenClass("accent") 와 동일 계열)
//   need    : 개설 필요(아직 미개설)        — 앰버(개설 필요 배지와 동일 계열)
//   done    : 개설 완료                     — 에메랄드(개설 완료 배지와 동일 계열)
//   muted   : 미오픈/개설 불가              — 중립 회색
export type LineOpeningCardTone =
  | "status"
  | "log"
  | "action"
  | "need"
  | "done"
  | "muted";

type ToneStyle = {
  // 카드 좌측 accent border 색.
  border: string;
  // 헤더 배경 틴트.
  header: string;
  // 제목 앞 도트 색.
  dot: string;
};

const TONE_STYLES: Record<LineOpeningCardTone, ToneStyle> = {
  status: {
    border: "border-l-sky-500 dark:border-l-sky-400",
    header: "bg-sky-50/70 dark:bg-sky-950/25",
    dot: "bg-sky-500 dark:bg-sky-400",
  },
  log: {
    border: "border-l-slate-400 dark:border-l-slate-500",
    header: "bg-muted/60 dark:bg-muted/40",
    dot: "bg-slate-400 dark:bg-slate-500",
  },
  action: {
    border: "border-l-indigo-500 dark:border-l-indigo-400",
    header: "bg-indigo-50/70 dark:bg-indigo-950/25",
    dot: "bg-indigo-500 dark:bg-indigo-400",
  },
  need: {
    border: "border-l-amber-500 dark:border-l-amber-400",
    header: "bg-amber-50/70 dark:bg-amber-950/25",
    dot: "bg-amber-500 dark:bg-amber-400",
  },
  done: {
    border: "border-l-emerald-500 dark:border-l-emerald-400",
    header: "bg-emerald-50/70 dark:bg-emerald-950/25",
    dot: "bg-emerald-500 dark:bg-emerald-400",
  },
  muted: {
    border: "border-l-muted-foreground/40",
    header: "bg-muted/50",
    dot: "bg-muted-foreground/50",
  },
};

// 카드 공통 골격 — 좌측 accent + 외곽선 강화 + 얕은 그림자(라이트에서 카드 독립감, 다크는 ring 이 담당).
//   overflow 는 지정하지 않는다 — 드롭다운이 뚫고 나와야 하는 카드(overflow-visible)를 깨지 않기 위함.
const CARD_BASE =
  "border-l-4 shadow-sm ring-foreground/15 dark:ring-foreground/20";

// 헤더 공통 골격 — 틴트 배경 + 본문과의 경계선 1줄.
//   ⚠ border-b 를 붙이면 CardHeader 의 `[.border-b]:pb-4` 규칙이 살아나 하단 여백이 pb-4 로 통일된다
//     (호출부의 pb-2/pb-3 보다 우선). 카드 간 헤더 높이가 같아지는 의도된 동작이다.
const CARD_HEADER_BASE = "border-b border-foreground/10";

/** 라인 개설 화면 카드의 className — `<Card className={lineOpeningCardClass(tone)}>` */
export function lineOpeningCardClass(
  tone: LineOpeningCardTone,
  className?: string,
): string {
  return cn(CARD_BASE, TONE_STYLES[tone].border, className);
}

/** 라인 개설 화면 카드 헤더의 className — `<CardHeader className={lineOpeningCardHeaderClass(tone, "pb-3")}>` */
export function lineOpeningCardHeaderClass(
  tone: LineOpeningCardTone,
  className?: string,
): string {
  return cn(CARD_HEADER_BASE, TONE_STYLES[tone].header, className);
}

// CardHeader(제목)가 없는 카드용 — CardContent 의 첫 줄(탭 바 등)을 헤더 밴드처럼 보이게 한다.
//   Card 상단 padding(py-6 / md:py-7 = 24/28px) + CardContent 의 pt-6(24px) = 48/52px 를 음수 마진으로
//   상쇄해 틴트를 카드 상단까지 채우고, 같은 값을 padding 으로 되돌려 **요소 위치는 그대로** 유지한다.
//   좌우도 CardContent 의 px-4 를 상쇄해 카드 폭 전체를 채운다(레이아웃 좌표 불변).
const CARD_HEADER_BAND_BASE = "-mx-4 -mt-12 px-4 pt-12 md:-mt-13 md:pt-13";

/**
 * 제목이 없는 라인 개설 카드의 헤더 밴드 className.
 *   `<CardContent className="space-y-4 pt-6">` 의 **첫 자식**(이미 border-b 를 가진 탭 바 등)에 붙인다.
 */
export function lineOpeningCardHeaderBandClass(
  tone: LineOpeningCardTone,
  className?: string,
): string {
  return cn(CARD_HEADER_BAND_BASE, TONE_STYLES[tone].header, className);
}

// CardHeader 도 없고 CardContent 가 **자체 top padding 도 없는** 카드용(예: 프로세스 체크 액트 목록).
//   상쇄해야 하는 값은 Card 의 py-6 / md:py-7(24/28px) 뿐이다 — CardContent 의 pt-6 을 함께 상쇄하는
//   lineOpeningCardHeaderBandClass(-mt-12/-mt-13)를 쓰면 밴드가 카드 위로 삐져나온다.
//   좌우도 CardContent 의 px-4 를 상쇄해 카드 폭 전체를 채운다(레이아웃 좌표 불변).
const CARD_TOP_BAND_BASE = "-mx-4 -mt-6 px-4 pt-6 md:-mt-7 md:pt-7";

/**
 * CardContent 가 pt 를 갖지 않는 카드의 상단 밴드 className.
 *   `<CardContent>` 의 **첫 자식**(요약 칩 줄 등)에 붙인다. 하단 경계선은 호출부가 border-b 로 지정.
 */
export function lineOpeningCardTopBandClass(
  tone: LineOpeningCardTone,
  className?: string,
): string {
  return cn(CARD_TOP_BAND_BASE, TONE_STYLES[tone].header, className);
}

/** 제목 앞 accent 도트 — 팀 카드와 동일 규격(size-2.5). 표시 전용(aria-hidden). */
export function LineOpeningCardDot({ tone }: { tone: LineOpeningCardTone }) {
  return (
    <span
      aria-hidden="true"
      className={cn("size-2.5 shrink-0 rounded-full", TONE_STYLES[tone].dot)}
    />
  );
}

/**
 * "N개 중 M개 완료" 형태의 진행형 업무 카드 → 카드 tone.
 *   대상 0건=중립(빈 상태) / 전부 완료=에메랄드 / 남아 있음=앰버.
 *   ⚠ 완료 여부 판정은 호출부(도메인)가 소유한다 — 여기서는 그 결과를 색으로만 바꾼다.
 */
export function completionCardTone({
  total,
  allCompleted,
}: {
  total: number;
  allCompleted: boolean;
}): LineOpeningCardTone {
  if (total <= 0) return "muted";
  return allCompleted ? "done" : "need";
}

/** 개설 상태 → 카드 tone. 개설 완료=에메랄드 / 개설 가능(미개설)=앰버 / 미오픈·불가=중립. */
export function lineOpeningStateTone({
  opened,
  canOpen,
}: {
  opened: boolean;
  canOpen: boolean;
}): LineOpeningCardTone {
  if (opened) return "done";
  return canOpen ? "need" : "muted";
}
