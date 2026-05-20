"use client";

import { useSearchParams } from "next/navigation";
import { useMemo } from "react";

// Admin UI dev-mode toggle.
//   ?dev=true → 개발자용 DB/API/source/debug 문구 노출
//   그 외     → 운영자 친화 UI (기본)
//
// 보안 권한이 아니라 표시 토글이다. 실제 데이터 접근 권한은 admin auth/role 로 보호된다.

export function useAdminDevMode(): boolean {
  const searchParams = useSearchParams();
  return searchParams?.get("dev") === "true";
}

// 같은 페이지 내 탭/링크 이동 시 ?dev=true 를 그대로 유지하기 위한 헬퍼.
//   const withDev = useWithDevQuery();
//   <Link href={withDev(`/admin/crews/${org}/${id}/cluster2`)} />
export function useWithDevQuery(): (href: string) => string {
  const devMode = useAdminDevMode();
  return useMemo(() => {
    return (href: string) => appendDevQuery(href, devMode);
  }, [devMode]);
}

export function appendDevQuery(href: string, devMode: boolean): string {
  if (!devMode) return href;
  // hash 분리 후 dev=true 합치고 다시 붙임.
  const [pathAndQuery, hash] = href.split("#");
  const [path, query] = pathAndQuery.split("?");
  const params = new URLSearchParams(query ?? "");
  if (params.get("dev") !== "true") params.set("dev", "true");
  const qs = params.toString();
  return `${path}${qs ? `?${qs}` : ""}${hash ? `#${hash}` : ""}`;
}

// 토글 헬퍼 — 현재 URL 의 dev 쿼리를 enabled 값으로 set/unset.
// 다른 query (q, org, sort 등) 와 hash 는 그대로 유지.
export function toggleDevQuery(href: string, enabled: boolean): string {
  const [pathAndQuery, hash] = href.split("#");
  const [path, query] = pathAndQuery.split("?");
  const params = new URLSearchParams(query ?? "");
  if (enabled) {
    params.set("dev", "true");
  } else {
    params.delete("dev");
  }
  const qs = params.toString();
  return `${path}${qs ? `?${qs}` : ""}${hash ? `#${hash}` : ""}`;
}
