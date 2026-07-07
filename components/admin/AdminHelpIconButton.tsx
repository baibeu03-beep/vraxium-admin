"use client";

import * as React from "react";
import { Search } from "lucide-react";
import AdminHelpModal from "@/components/admin/AdminHelpModal";
import { cn } from "@/lib/utils";

// 어드민 UI 요소(표 헤더/필터/입력창/카드 지표/배지/로그 등) 옆에 붙이는 인라인 도움말 트리거.
//   · 돋보기 아이콘 하나짜리 작은 버튼 — "물음표 + 도움말" 텍스트 버튼(AdminHelp, 페이지 단위)과 구분된다.
//   · 클릭 시 페이지 도움말과 "동일한" 편집/저장 모달(AdminHelpModal, /api/admin/help)을 연다.
//   · 도움말 본문은 코드에 하드코딩하지 않는다 — SoT 는 helpKey 로 저장/조회되는 저장소/API.
//   · helpKey 는 요소마다 고유해야 한다. 예: "admin.teamParts.info.weeks.column.actCheckRate".
//   · org/mode/test 로 갈라지지 않는 공통 키(키 문자열에 org/mode 를 넣지 않는다).
//   · 표 셀 안에서도 행 높이/컬럼 폭이 늘어나지 않도록 인라인(align-middle) + 아주 작은 크기.

type HelpSize = "xs" | "sm";

export type AdminHelpIconButtonProps = {
  /**
   * 요소 단위 도움말 키(고유). 저장/조회 식별자. 예: "admin.members.column.reliabilityRate".
   * "admin." 으로 시작하는 점(.) 네임스페이스.
   */
  helpKey: string;
  /** 선택: 모달 헤더에 표시할 짧은 라벨(어떤 항목인지 식별용, 도움말 본문 아님). */
  title?: string;
  /** 트리거 크기. 기본 xs(표/배지용). 여유 있는 곳은 sm. */
  size?: HelpSize;
  /** 접근성 라벨/툴팁. 기본 "이 항목 도움말". */
  label?: string;
  /** 트리거 배치/여백 조정용. */
  className?: string;
};

const TRIGGER_SIZE: Record<HelpSize, string> = {
  // 인라인에 붙어도 레이아웃이 안 깨지도록 아주 작게. 아이콘도 함께 축소.
  xs: "size-[18px] [&_svg]:size-3",
  sm: "size-[22px] [&_svg]:size-3.5",
};

export default function AdminHelpIconButton({
  helpKey,
  title,
  size = "xs",
  label = "이 항목 도움말",
  className,
}: AdminHelpIconButtonProps) {
  const [open, setOpen] = React.useState(false);

  return (
    <>
      <button
        type="button"
        // 행 클릭(확장 등)과 겹치지 않도록 이벤트 전파 차단.
        onClick={(e) => {
          e.stopPropagation();
          setOpen(true);
        }}
        aria-haspopup="dialog"
        aria-label={label}
        title={label}
        className={cn(
          "inline-flex shrink-0 cursor-help items-center justify-center rounded-full align-middle",
          "text-muted-foreground/70 outline-none transition-colors",
          // hover/focus 시 "설명이 있다"는 느낌 — 배경/색 강조.
          "hover:bg-sky-500/10 hover:text-sky-600 dark:hover:text-sky-400",
          "focus-visible:ring-2 focus-visible:ring-sky-500/50",
          TRIGGER_SIZE[size],
          className,
        )}
      >
        <Search />
      </button>

      <AdminHelpModal
        open={open}
        onClose={() => setOpen(false)}
        storageKey={helpKey}
        title={title ?? "항목 도움말"}
      />
    </>
  );
}
