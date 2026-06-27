"use client";

import { AlertTriangle, Hourglass } from "lucide-react";
import { useLoadingBannerActive } from "@/components/admin/loadingBannerContext";
import { useDelayedLoading } from "@/lib/useDelayedLoading";
import { cn } from "@/lib/utils";

// 배너 문구(전역 단일 출처). 페이지마다 다르게 적지 않는다.
const BANNER_TEXT = {
  title: "데이터를 불러오는 중입니다.",
  body: "잠시만 기다려주세요.",
  slowTitle: "응답이 지연되고 있습니다.",
  slowBody: "네트워크 상태를 확인해주세요.",
} as const;

/**
 * 전역 로딩 배너(단일 출처) — 사이드바/헤더 바로 아래, 콘텐츠 영역 최상단에 고정 위치로
 * 표시된다. 화면의 주요 데이터를 (재)조회하는 동안 항상 같은 자리·같은 디자인으로 노출.
 *
 * 동작(요구사항):
 *  - 표시 조건: 최초 진입 API 대기·검색·필터·페이지네이션·새로고침·정렬·재조회 등
 *    어떤 컴포넌트든 useReportLoading 으로 보고한 loading 이 1건 이상일 때.
 *  - 500ms 미만 응답에는 뜨지 않는다(깜빡임 방지, useDelayedLoading).
 *  - 성공/실패로 loading 이 끝나면 즉시 사라진다(영구 잔존 없음).
 *  - 10초 이상 지연되면 "응답이 지연되고 있습니다" 안내로 자동 전환.
 *  - Fade In/Out + 높이 접힘으로 자연스럽게 등장/소멸(상단 Progress Bar 와 별개 위치).
 */
export default function GlobalLoadingBanner() {
  const active = useLoadingBannerActive();
  const { visible, slow } = useDelayedLoading(active);

  return (
    <div
      role="status"
      aria-live="polite"
      aria-hidden={!visible}
      // grid-rows 0fr↔1fr + opacity 로 높이/투명도를 함께 전환 → 자연스러운 fade in/out.
      className={cn(
        "grid overflow-hidden transition-all duration-300 ease-out motion-reduce:transition-none",
        visible ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0",
      )}
    >
      <div className="min-h-0 overflow-hidden">
        <div
          className={cn(
            "flex items-center gap-3 border-b bg-muted/50 px-4 py-2 sm:px-6",
            slow && "bg-tone-warn-bg",
          )}
        >
          {slow ? (
            <AlertTriangle className="h-5 w-5 shrink-0 text-tone-warn" />
          ) : (
            // 회전하는 모래시계 아이콘.
            <Hourglass className="h-5 w-5 shrink-0 animate-spin text-muted-foreground motion-reduce:animate-none" />
          )}
          <div className="min-w-0 leading-tight">
            <p
              className={cn(
                "text-sm font-medium",
                slow ? "text-tone-warn" : "text-foreground",
              )}
            >
              {slow ? BANNER_TEXT.slowTitle : BANNER_TEXT.title}
            </p>
            <p className="text-xs text-muted-foreground">
              {slow ? BANNER_TEXT.slowBody : BANNER_TEXT.body}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
