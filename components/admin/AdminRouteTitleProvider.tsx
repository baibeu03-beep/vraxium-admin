"use client";

// 어드민 전역 헤더 좌측 경로의 "상세 페이지 표시명" 공급 인프라(공통 route-title provider).
//
//   왜: 상세 페이지(회원/주차/크루 등)는 고정 문구("회원 상세")가 아니라 실제 대상의 표시명
//   (이유나 · 26년 여름 시즌 8주차 …)을 헤더에 보여야 한다. 그런데 헤더는 layout 에 있고
//   데이터는 각 페이지가 이미 조회한다 → 페이지가 이미 가진 표시명을 헤더로 "공급"만 하고,
//   헤더용으로 같은 데이터를 다시 조회하지 않는다(중복 요청 금지).
//
//   구조:
//     - <AdminRouteTitleProvider>  : layout 에서 Header + main 을 함께 감싼다(단일 마운트).
//     - <AdminDetailTitle title>   : 상세 페이지가 렌더만 하면 되는 얇은 클라이언트 컴포넌트.
//         · 서버 컴포넌트 페이지도 이미 구한 표시명을 prop 으로 넘겨 그대로 사용(추가 조회 없음).
//         · 로딩 중엔 "불러오는 중" 같은 안전 문구를 넘긴다(UUID/raw pathname 노출 금지).
//     - useAdminRouteTitleForPath(pathname) : Header 가 현재 경로의 상세 표시명을 읽는다.
//
//   mode/org 무관: 표시명은 각 페이지의 상세 DTO(동일 SoT)에서 오므로 mode=test·actAsTestUserId·
//   demoUserId·org 와 무관하게 같은 대상은 같은 표시명. provider 는 pathname 키로만 매칭한다.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { usePathname } from "next/navigation";
import type { AdminBreadcrumbItem } from "@/lib/adminMenuTree";

// 상세 표시명은 "어느 pathname 에 대한 것인지"까지 함께 저장한다 — 페이지 전환 중 이전 페이지의
//   표시명이 새 경로에 잘못 붙는 것을 막는다(헤더는 pathname 이 일치할 때만 사용).
//   items = 브레드크럼 "끝에서부터" 교체할 항목들(1개 이상). 회원 상세=[회원명], 주차 상세=[회원명, 주차명].
//   각 항목은 라벨 + (선택) href — 마지막(현재 페이지) 항목의 href 는 Header 가 무시(링크 안 함).
type RouteTitleEntry = { pathname: string; items: AdminBreadcrumbItem[] };

const EntryContext = createContext<RouteTitleEntry | null>(null);
const SetterContext = createContext<((entry: RouteTitleEntry | null) => void) | null>(null);

export function AdminRouteTitleProvider({ children }: { children: React.ReactNode }) {
  const [entry, setEntry] = useState<RouteTitleEntry | null>(null);
  const setter = useCallback((next: RouteTitleEntry | null) => setEntry(next), []);
  return (
    <SetterContext.Provider value={setter}>
      <EntryContext.Provider value={entry}>{children}</EntryContext.Provider>
    </SetterContext.Provider>
  );
}

/** Header 소비 — 현재 pathname 에 대해 설정된 상세 브레드크럼 항목들(없으면 null). */
export function useAdminRouteTitleForPath(pathname: string): AdminBreadcrumbItem[] | null {
  const entry = useContext(EntryContext);
  return entry && entry.pathname === pathname ? entry.items : null;
}

/**
 * 상세 페이지가 이미 조회한 표시명을 헤더 브레드크럼 끝에 공급한다(렌더만, 화면엔 아무것도 안 그림).
 *   - title: 단일 표시명(이름/주차명). 마지막 1칸만 교체(기존 페이지 하위호환 — 링크 없는 현재 페이지).
 *   - items: 끝에서부터 여러 칸 교체 + 각 칸 href(예: 주차 상세 = [{회원명, href:회원상세}, {주차명}]).
 *   title/items 중 하나만 준다. 로딩 중이면 "불러오는 중" 등 안전 문구(UUID/raw pathname 노출 금지).
 * SetterContext(안정 참조)만 구독하므로 표시명 변경으로 이 컴포넌트가 리렌더 루프에 빠지지 않는다.
 */
export function AdminDetailTitle({
  title,
  items,
}: {
  title?: string | null | undefined;
  items?: AdminBreadcrumbItem[];
}) {
  const setEntry = useContext(SetterContext);
  const pathname = usePathname();

  // title(단일) → items 1칸으로 정규화. items 직접 지정이 우선. 값이 전혀 없으면 null(미설정 —
  //   Header 는 고정 폴백 "회원 상세" 등을 유지. 기존 title=undefined 동작과 동일).
  const normalized = useMemo<AdminBreadcrumbItem[] | null>(() => {
    if (items && items.length > 0) return items;
    const t = title?.trim();
    return t ? [{ label: t }] : null;
  }, [items, title]);

  // 표시명/경로 변경 시 즉시 반영(변경 중 null 로 비우지 않아 로딩→이름 전환에 깜빡임 없음).
  useEffect(() => {
    if (setEntry) setEntry(normalized ? { pathname, items: normalized } : null);
  }, [setEntry, pathname, normalized]);

  // 언마운트(페이지 이탈) 시에만 정리 — 다른 경로로 새는 것 방지.
  useEffect(() => {
    return () => {
      if (setEntry) setEntry(null);
    };
  }, [setEntry]);

  return null;
}
