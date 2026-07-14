"use client";

import * as React from "react";
import { Search } from "lucide-react";
import AdminHelpModal from "@/components/admin/AdminHelpModal";
import { Tooltip } from "@/components/ui/tooltip";
import { resolveHelpTooltip } from "@/lib/helpTooltip";
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

// helpKey → 저장된 도움말 원문 캐시(모듈 스코프, 세션 지속).
//   · 값이 undefined = 아직 미조회, string = 조회 완료(빈 문자열 포함).
//   · in-flight Promise 를 함께 저장해 동시 hover/공유 키 중복 요청을 dedup 한다.
const helpContentCache = new Map<string, string>();
const helpContentInflight = new Map<string, Promise<string>>();

async function fetchHelpContent(helpKey: string): Promise<string> {
  const cached = helpContentCache.get(helpKey);
  if (cached !== undefined) return cached;

  const existing = helpContentInflight.get(helpKey);
  if (existing) return existing;

  const p = (async () => {
    try {
      const res = await fetch(`/api/admin/help?path=${encodeURIComponent(helpKey)}`, {
        cache: "no-store",
      });
      const json = await res.json();
      // DTO: { success, data: { pagePath, content, canEdit } } — 본문 필드는 data.content.
      const content =
        res.ok && json?.success && typeof json.data?.content === "string" ? json.data.content : "";
      helpContentCache.set(helpKey, content);
      return content;
    } catch {
      // 조회 실패는 조용히 fallback 라벨로 — 툴팁이 기능을 막지 않는다. (캐시엔 남기지 않아 재시도 허용)
      return "";
    } finally {
      helpContentInflight.delete(helpKey);
    }
  })();
  helpContentInflight.set(helpKey, p);
  return p;
}

// 편집/저장 후 최신 내용을 다시 보이도록 캐시를 무효화(같은 키를 쓰는 모든 위치에 반영).
export function invalidateHelpContentCache(helpKey: string) {
  helpContentCache.delete(helpKey);
  helpContentInflight.delete(helpKey);
}

export default function AdminHelpIconButton({
  helpKey,
  title,
  size = "xs",
  label = "이 항목 도움말",
  onDark = false,
  className,
}: AdminHelpIconButtonProps) {
  const [open, setOpen] = React.useState(false);
  // 저장된 도움말 원문(미조회=undefined). 툴팁 미리보기 계산에만 쓰인다.
  const [helpContent, setHelpContent] = React.useState<string | undefined>(() =>
    helpContentCache.get(helpKey),
  );
  const aliveRef = React.useRef(true);
  React.useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  // hover/focus(Tooltip open) 시 lazy 조회 — 모듈 캐시 재사용, 언마운트 후 setState 방지.
  const primeTooltip = React.useCallback(() => {
    const cached = helpContentCache.get(helpKey);
    if (cached !== undefined) {
      setHelpContent(cached);
      return;
    }
    void fetchHelpContent(helpKey).then((c) => {
      if (aliveRef.current) setHelpContent(c);
    });
  }, [helpKey]);

  // 저장(모달 편집) 후 닫히면 캐시가 stale 일 수 있으니, 닫힐 때 무효화하고 다음 hover 에 재조회.
  const handleClose = React.useCallback(() => {
    setOpen(false);
    invalidateHelpContentCache(helpKey);
    setHelpContent(undefined);
  }, [helpKey]);

  const tooltip = resolveHelpTooltip(helpContent, label);

  return (
    <>
      <Tooltip content={tooltip} onOpen={primeTooltip}>
        <button
          type="button"
          // 행 클릭(확장 등)과 겹치지 않도록 이벤트 전파 차단.
          onClick={(e) => {
            e.stopPropagation();
            setOpen(true);
          }}
          aria-haspopup="dialog"
          // 접근성 라벨은 "기능"을 설명(고정). 미리보기는 시각 Tooltip 이 담당.
          aria-label={label}
          className={cn(
            "inline-flex shrink-0 cursor-help items-center justify-center rounded-full align-middle",
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
            className,
          )}
        >
          <Search />
        </button>
      </Tooltip>

      <AdminHelpModal
        open={open}
        onClose={handleClose}
        storageKey={helpKey}
        title={title ?? "항목 도움말"}
      />
    </>
  );
}
