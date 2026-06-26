"use client";

import { Skeleton } from "@/components/ui/skeleton";
import { TableCell, TableRow } from "@/components/ui/table";
import { useDelayedLoading } from "@/lib/useDelayedLoading";

/**
 * 테이블 로딩용 스켈레톤 행(전역 단일 출처). 빈 테이블 대신 콘텐츠 형태를 미리 보여준다.
 *
 * <TableBody> 내부에 그대로 넣어 사용한다:
 *   <TableBody>
 *     {loading
 *       ? <TableSkeletonRows columns={8} rows={6} />
 *       : rows.map(...)}
 *   </TableBody>
 *
 * `active` 를 넘기면 500ms 미만 지연에서는 스켈레톤도 띄우지 않는다(깜빡임 방지).
 * 넘기지 않으면 항상 렌더(호출부에서 이미 loading 으로 분기하는 경우).
 */
export function TableSkeletonRows({
  columns,
  rows = 6,
  active,
}: {
  columns: number;
  rows?: number;
  active?: boolean;
}) {
  const { visible } = useDelayedLoading(active ?? true);
  if (active !== undefined && !visible) return null;

  return (
    <>
      {Array.from({ length: rows }).map((_, r) => (
        <TableRow key={`sk-${r}`} aria-hidden className="pointer-events-none">
          {Array.from({ length: columns }).map((_, c) => (
            <TableCell key={`sk-${r}-${c}`} className="py-3">
              <Skeleton
                className="mx-auto h-4"
                // 가운데 칸일수록 넓게 — 실제 텍스트처럼 보이도록 약간의 변주.
                style={{ width: c === 0 ? "60%" : c % 3 === 0 ? "50%" : "80%" }}
              />
            </TableCell>
          ))}
        </TableRow>
      ))}
    </>
  );
}
