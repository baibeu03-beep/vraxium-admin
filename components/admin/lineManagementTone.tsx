"use client";

import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

// 라인 개설 화면(/admin/(integrated/)line-opening/*)의 **[라인 관리] 탭 표현 SoT — 스타일 전용**.
//   대상: 실무 정보(주차별 개설 결과) · 실무 역량(집계 카드 + 결과 배지). 실무 경험의 카드형
//     보드(ExperienceLineManageBoard)가 이미 쓰던 "파스텔 배경 + 같은 계열 테두리 + 진한 텍스트"
//     조합을 tone 체계로 뽑아, 세 화면이 같은 시각 언어를 공유하게 한다.
//   2026-07-27: /admin/integrated/processes/check/* 의 배지·안내/오류 배너·요약 칩도 이 tone 표를
//     재사용한다(라인 개설과 동일한 디자인 언어 · 다크 대응 단일 출처). 파일명은 도입 화면 유래.
//
//   ⚠ 이 파일은 **색/타이포만** 담당한다. 상태 판정·상태 문구·데이터 로딩·버튼/액션·DTO 는
//     각 도메인 컴포넌트가 그대로 소유한다(공용 resolver 가 도메인 상태를 판단하지 않는다).
//     호출부가 "자기 상태 → tone" 매핑만 선언하고, 그 tone 의 클래스는 여기 한 곳에서만 정의한다.
//
//   ⚠ mode(operating/test)·org 로 분기하지 않는다 — 모든 조직/모드가 같은 tone 표를 쓴다.
//
// tone 의 의미(도메인 상태명이 아니라 **역할**로 정의):
//   neutral  : 전체·모집단 등 일반 정보          — 슬레이트
//   info     : 진행 중·오픈·신청 등 활성 흐름    — 스카이
//   success  : 개설/이행 완료                    — 에메랄드
//   warning  : 개설 필요·대기 등 조치 필요       — 앰버
//   inactive : 미오픈·비대상                     — 징크
//   danger   : 취소·반려·실패가 실제 존재할 때만 — 레드
export type LineManagementTone =
  | "neutral"
  | "info"
  | "success"
  | "warning"
  | "inactive"
  | "danger";

type ToneStyle = {
  // 요약 통계 박스(배경 + 테두리 + 기본 텍스트).
  box: string;
  // 통계 박스의 라벨 — 숫자보다 한 단계 연하게.
  label: string;
  // 통계 박스의 숫자 — 라벨보다 한 단계 진하게(굵기는 컴포넌트가 고정).
  value: string;
  // 라인 카드(배경 + 테두리) — 통계 박스보다 옅게 깔아 카드가 쌓여도 지저분하지 않게.
  card: string;
  // 상태 배지.
  badge: string;
};

// 라이트: 50/100 배경 + 200/300 테두리 + 700~900 텍스트.
// 다크  : 950/35 (카드는 /20~/25) 배경 + 700/800 테두리 + 100~300 텍스트.
const TONE_STYLES: Record<LineManagementTone, ToneStyle> = {
  neutral: {
    box: "border-slate-200 bg-slate-50 text-slate-700 dark:border-slate-700 dark:bg-slate-900/35 dark:text-slate-200",
    label: "text-slate-600 dark:text-slate-300",
    value: "text-slate-900 dark:text-slate-50",
    card: "border-slate-200 bg-slate-50/50 dark:border-slate-700 dark:bg-slate-900/25",
    badge:
      "border-slate-300 bg-slate-100 text-slate-700 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-200",
  },
  info: {
    box: "border-sky-200 bg-sky-50 text-sky-800 dark:border-sky-800 dark:bg-sky-950/35 dark:text-sky-200",
    label: "text-sky-700 dark:text-sky-300",
    value: "text-sky-900 dark:text-sky-100",
    card: "border-sky-200 bg-sky-50/50 dark:border-sky-800 dark:bg-sky-950/20",
    badge:
      "border-sky-300 bg-sky-100 text-sky-800 dark:border-sky-700 dark:bg-sky-900/60 dark:text-sky-200",
  },
  success: {
    box: "border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950/35 dark:text-emerald-200",
    label: "text-emerald-700 dark:text-emerald-300",
    value: "text-emerald-900 dark:text-emerald-100",
    card: "border-emerald-200 bg-emerald-50/50 dark:border-emerald-800 dark:bg-emerald-950/20",
    badge:
      "border-emerald-300 bg-emerald-100 text-emerald-800 dark:border-emerald-700 dark:bg-emerald-900/60 dark:text-emerald-200",
  },
  warning: {
    box: "border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-800 dark:bg-amber-950/35 dark:text-amber-200",
    label: "text-amber-700 dark:text-amber-300",
    value: "text-amber-900 dark:text-amber-100",
    card: "border-amber-200 bg-amber-50/50 dark:border-amber-800 dark:bg-amber-950/20",
    badge:
      "border-amber-300 bg-amber-100 text-amber-800 dark:border-amber-700 dark:bg-amber-900/60 dark:text-amber-200",
  },
  inactive: {
    // 미오픈은 '꺼진 상태'로 읽혀야 하지만 **읽을 수 없을 만큼 흐리면 안 된다** —
    //   opacity 로 죽이지 않고 중립 배경 + 정상 대비 텍스트로 표현한다.
    box: "border-zinc-200 bg-zinc-100 text-zinc-700 dark:border-zinc-700 dark:bg-zinc-900/50 dark:text-zinc-300",
    label: "text-zinc-600 dark:text-zinc-400",
    value: "text-zinc-800 dark:text-zinc-100",
    card: "border-zinc-300 bg-zinc-100/80 dark:border-zinc-700 dark:bg-zinc-900/50",
    badge:
      "border-zinc-400 bg-zinc-200 text-zinc-700 dark:border-zinc-600 dark:bg-zinc-700 dark:text-zinc-200",
  },
  danger: {
    box: "border-red-200 bg-red-50 text-red-800 dark:border-red-800 dark:bg-red-950/35 dark:text-red-200",
    label: "text-red-700 dark:text-red-300",
    value: "text-red-900 dark:text-red-100",
    card: "border-red-200 bg-red-50/50 dark:border-red-800 dark:bg-red-950/20",
    badge:
      "border-red-300 bg-red-100 text-red-800 dark:border-red-700 dark:bg-red-900/60 dark:text-red-200",
  },
};

/**
 * 안내/오류/요약 박스의 배경·테두리·텍스트 className — 기존 박스 골격(rounded-md border px-* py-*)에
 * 색만 얹을 때 사용한다. 라이트/다크 모두 대비가 확보된 유일한 출처.
 *   기존에 화면마다 흩어져 있던 `border-amber-300 bg-amber-50 text-amber-800`(다크 미대응) 같은
 *   1회용 조합을 이 함수로 대체한다 — /admin/integrated/processes/check/* 안내·오류 배너 포함.
 */
export function lineManagementBoxClass(
  tone: LineManagementTone,
  className?: string,
): string {
  return cn(TONE_STYLES[tone].box, className);
}

/** 라인 관리 카드의 배경·테두리 className — 컴포넌트를 못 쓰는 자리(조건부 합성)용. */
export function lineManagementCardClass(
  tone: LineManagementTone,
  className?: string,
): string {
  return cn(TONE_STYLES[tone].card, className);
}

/** 상태 배지의 배경·테두리·텍스트 className — 기존 배지 골격에 색만 얹을 때 사용. */
export function lineManagementBadgeClass(
  tone: LineManagementTone,
  className?: string,
): string {
  return cn(TONE_STYLES[tone].badge, className);
}

/**
 * 요약 통계 박스.
 *   layout="inline"  : 라벨 → 숫자 가로 배치(실무 정보 "전체 라인 3").
 *   layout="stacked" : 숫자 위 / 라벨 아래(실무 역량 집계 카드).
 * 숫자는 항상 라벨보다 진하고 굵다(tabular-nums 로 자릿수 흔들림 방지).
 * help 는 호출부가 자기 helpKey 로 만든 도움말 버튼을 그대로 꽂는 슬롯 — 도움말 문구/키는 불변.
 */
export function LineStatusSummary({
  tone,
  label,
  value,
  help,
  layout = "inline",
  className,
}: {
  tone: LineManagementTone;
  label: string;
  value: ReactNode;
  help?: ReactNode;
  layout?: "inline" | "stacked";
  className?: string;
}) {
  const t = TONE_STYLES[tone];
  if (layout === "stacked") {
    return (
      <div
        className={cn(
          "min-w-[78px] rounded-md border px-4 py-2 text-center",
          t.box,
          className,
        )}
      >
        <p className={cn("text-xl font-bold leading-none tabular-nums", t.value)}>
          {value}
        </p>
        <p
          className={cn(
            "mt-1 inline-flex items-center justify-center gap-1 text-xs font-medium",
            t.label,
          )}
        >
          {label}
          {help}
        </p>
      </div>
    );
  }
  return (
    <div
      className={cn("rounded-md border px-3 py-2 text-base", t.box, className)}
    >
      <span className={cn("inline-flex items-center gap-1 font-medium", t.label)}>
        {label}
        {help}
      </span>{" "}
      <span className={cn("font-bold tabular-nums", t.value)}>{value}</span>
    </div>
  );
}

/** 라인 카드 — 상태별로 '연한 배경 + 같은 계열 테두리'만 달라진다(그림자/애니메이션 없음). */
export function LineResultCard({
  tone,
  className,
  children,
}: {
  tone: LineManagementTone;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        "space-y-2 rounded-md border p-3",
        TONE_STYLES[tone].card,
        className,
      )}
    >
      {children}
    </div>
  );
}

/** 상태 배지 — 파스텔 배경 + 같은 계열 테두리 + 진한 텍스트(흰 글자 솔리드 배지 미사용). */
export function LineStatusBadge({
  tone,
  className,
  children,
}: {
  tone: LineManagementTone;
  className?: string;
  children: ReactNode;
}) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-sm font-semibold",
        TONE_STYLES[tone].badge,
        className,
      )}
    >
      {children}
    </span>
  );
}
