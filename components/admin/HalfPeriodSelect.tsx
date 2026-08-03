"use client";

import { useCallback, useMemo } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type { ReadonlyURLSearchParams } from "next/navigation";
import { getCurrentActivityDateIso } from "@/lib/seasonCalendar";
import { HALF_PERIODS, halfKeyForDate, halfLabelKo, normalizeHalfKeyParam } from "@/lib/teamHalf";
import { buildAdminContextHref } from "@/lib/adminOrgContext";
import AdminHelpIconButton from "@/components/admin/AdminHelpIconButton";

// ── "해당 시기" 반기 선택 공용 컴포넌트 (2026-07-31) ──────────────────────────────
//   /admin/team-parts/info/* 전체(상위 목록·클럽 상세·팀 상세)가 이 컴포넌트 하나를 공유한다.
//   URL 의 `?period=` 가 유일한 상태 — 로컬 state 를 두지 않는다(뒤로가기·새로고침·직접 URL 접속이
//   전부 같은 값을 복원한다). period 미지정/무효 시 접속 시점 기준 현재 반기로 안전 보정한다
//   (lib/teamHalf.ts 의 normalizeHalfKeyParam — 400 없음).
//   기존 mode/org/actAsTestUserId/demoUserId 와 동일하게 lib/adminOrgContext.ts 의
//   ADMIN_CONTEXT_PARAMS 에 등록돼 있어, 클럽 상세·팀 상세로 이동해도 선택 반기가 유지된다.

export function readPeriodParam(
  searchParams: URLSearchParams | ReadonlyURLSearchParams | null | undefined,
): string {
  const today = getCurrentActivityDateIso();
  const fallback = halfKeyForDate(today);
  return normalizeHalfKeyParam(searchParams?.get("period") ?? null, fallback);
}

export default function HalfPeriodSelect() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const value = useMemo(() => readPeriodParam(searchParams), [searchParams]);
  // 옵션 목록에 "(현재)" 표시용 — 접속 시점 기준 현재 반기(2026-08-03 확정).
  const currentHalfKey = useMemo(() => halfKeyForDate(getCurrentActivityDateIso()), []);

  const onChange = useCallback(
    (next: string) => {
      const href = buildAdminContextHref({
        targetPath: `${pathname}?period=${next}`,
        pathname,
        searchParams,
      });
      router.replace(href, { scroll: false });
    },
    [pathname, router, searchParams],
  );

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2 text-sm font-semibold">
      <span className="inline-flex items-center gap-1 whitespace-nowrap">
        <span>● 해당 시기</span>
        <AdminHelpIconButton helpKey="admin.teamParts.info.filter.half" title="해당 시기" />
      </span>
      <select
        id="team-parts-period-select"
        data-half-period-select
        className="whitespace-nowrap rounded-md border border-input bg-background px-3 py-2 text-sm"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        {HALF_PERIODS.map((p) => (
          <option key={p} value={p}>
            {halfLabelKo(p)}
            {p === currentHalfKey ? " (현재)" : ""}
          </option>
        ))}
      </select>
    </div>
  );
}
