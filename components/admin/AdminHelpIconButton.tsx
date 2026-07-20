"use client";

import * as React from "react";
import { Search } from "lucide-react";
import AdminHelpModal from "@/components/admin/AdminHelpModal";
import { Tooltip } from "@/components/ui/tooltip";
import {
  fetchHelpMeta,
  hasHelpContent,
  peekHelpMeta,
  subscribeHelpMeta,
  type HelpMeta,
} from "@/lib/adminHelpEmphasis";
import { cn } from "@/lib/utils";

// 어드민 UI 요소(표 헤더/필터/입력창/카드 지표/배지/로그 등) 옆에 붙이는 인라인 도움말 트리거.
//   · 돋보기 아이콘 하나짜리 작은 버튼 — "물음표 + 도움말" 텍스트 버튼(AdminHelp, 페이지 단위)과 구분된다.
//   · 클릭 시 페이지 도움말과 "동일한" 편집/저장 모달(AdminHelpModal, /api/admin/help)을 연다.
//   · 도움말 본문은 코드에 하드코딩하지 않는다 — SoT 는 helpKey 로 저장/조회되는 저장소/API.
//   · helpKey 는 요소마다 고유해야 한다. 의미가 같은 위치끼리는 공통 키를 공유한다.
//   · org/mode/test 로 갈라지지 않는 공통 키(키 문자열에 org/mode 를 넣지 않는다).
//   · 표 셀 안에서도 행 높이/컬럼 폭이 늘어나지 않도록 인라인(align-middle) + 아주 작은 크기.
//
// hover 툴팁: 저장된 도움말 내용이 있으면 앞부분 미리보기(정리+말줄임표), 없으면 fallback 라벨.
//   · 화면 툴팁은 네이티브 title 이 아니라 공용 Tooltip(React state 렌더)으로 표시한다 —
//     네이티브 title 은 "표시 중" 속성 변경을 반영하지 못해, hover 시점 lazy 조회 결과가 안 보였다.
//   · Tooltip 은 열려 있는 동안 content 가 갱신되면 즉시 반영 → hover 중 조회가 도착해도 실제 본문으로 바뀐다.
//   · 조회는 도움말 모달과 "같은" GET /api/admin/help(같은 DTO: data.content) — org/mode/test 로 갈라지지 않는다.
//   · 페이지 mount 마다 모든 아이콘이 일제히 조회(N+1)하지 않도록, hover/focus 시점에 lazy 로 1회만 조회하고
//     helpKey 단위 모듈 캐시로 재사용한다(같은 키를 쓰는 여러 위치·재렌더·네비게이션에서도 재조회 없음).
//   · aria-label 은 접근성용으로 "이 항목 도움말"(기능 라벨)로 고정 — 미리보기로 바꾸지 않는다.

type HelpSize = "xs" | "sm";

export type AdminHelpIconButtonProps = {
  /**
   * 요소 단위 도움말 키(고유). 저장/조회 식별자. 예: "admin.lineOpening.field.mainTitle".
   * "admin." 으로 시작하는 점(.) 네임스페이스. 의미가 같은 위치는 같은 키를 공유(내용도 공유).
   */
  helpKey: string;
  /** 선택: 모달 헤더에 표시할 짧은 라벨(어떤 항목인지 식별용, 도움말 본문 아님). */
  title?: string;
  /** 트리거 크기. 기본 xs(표/배지용). 여유 있는 곳은 sm. */
  size?: HelpSize;
  /** 접근성 라벨 + 도움말 내용이 없을 때 툴팁 fallback. 기본 "이 항목 도움말". */
  label?: string;
  /**
   * 어두운/진한 배경(bg-emerald-600, bg-blue-600, bg-slate-700 …) 위에 놓일 때 true.
   *   · 기본 회색(text-muted-foreground/70)은 진한 배경과 대비가 낮아 아이콘이 파묻힌다.
   *   · true 면 흰색 계열로 렌더 + hover/focus 대비도 흰색 기준으로 전환한다.
   *   · 색만 바뀌고 hover 배경/focus ring/모달 호출/접근성 동작은 동일하게 유지된다.
   *   · org/mode/test 로 갈라지지 않는다 — 배경 밝기만으로 부모가 결정해 전달한다.
   */
  onDark?: boolean;
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
  onDark = false,
  className,
}: AdminHelpIconButtonProps) {
  const [open, setOpen] = React.useState(false);
  const [meta, setMeta] = React.useState<HelpMeta | undefined>(() => peekHelpMeta(helpKey));

  React.useEffect(() => {
    let alive = true;
    const applyMeta = (next: HelpMeta) => {
      if (!alive) return;
      setMeta(next);
    };
    const unsubscribe = subscribeHelpMeta(helpKey, applyMeta);
    void fetchHelpMeta(helpKey).then(applyMeta);
    return () => {
      alive = false;
      unsubscribe();
    };
  }, [helpKey]);

  const hasContent = hasHelpContent(meta?.content);
  const tooltip = hasContent ? "도움말이 등록되어 있습니다" : label;
  const ariaLabel = hasContent ? `${label}, 도움말이 등록되어 있습니다` : label;

  return (
    <>
      <Tooltip content={tooltip}>
        <button
          type="button"
          // 행 클릭(확장 등)과 겹치지 않도록 이벤트 전파 차단.
          onClick={(e) => {
            e.stopPropagation();
            setOpen(true);
          }}
          aria-haspopup="dialog"
          data-admin-help-trigger="key"
          data-help-key={helpKey}
          // 접근성 라벨은 "기능"을 설명(고정). 미리보기는 시각 Tooltip 이 담당.
          aria-label={ariaLabel}
          className={cn(
            "relative inline-flex shrink-0 cursor-help items-center justify-center rounded-full align-middle",
            "outline-none transition-colors",
            onDark
              ? // 진한 배경: 흰색 아이콘 + 흰색 기준 hover/focus 대비(라이트/다크 무관 — 배경이 이미 진함).
                [
                  "text-white/90",
                  "hover:bg-white/20 hover:text-white",
                  "focus-visible:ring-2 focus-visible:ring-white/70",
                ]
              : // 밝은 배경: 기존 회색 아이콘 + sky 강조(라이트/다크 대응) — 변경 없음.
                [
                  "text-muted-foreground/70",
                  "hover:bg-sky-500/10 hover:text-sky-600 dark:hover:text-sky-400",
                  "focus-visible:ring-2 focus-visible:ring-sky-500/50",
                ],
            TRIGGER_SIZE[size],
            hasContent && "admin-help-has-content",
            hasContent && "admin-help-nudge",
            className,
          )}
        >
          <Search />
          {hasContent && (
            <span
              aria-hidden
              data-admin-help-indicator="content"
              className="pointer-events-none absolute -top-0.5 -right-0.5 inline-flex size-2 rounded-full bg-primary ring-1 ring-background"
            />
          )}
        </button>
      </Tooltip>

      <AdminHelpModal
        open={open}
        onClose={() => setOpen(false)}
        storageKey={helpKey}
        title={title ?? "항목 도움말"}
      />
    </>
  );
}
