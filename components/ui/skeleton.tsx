import { cn } from "@/lib/utils";

/**
 * 공통 스켈레톤 블록(전역 단일 출처). 빈 화면 대신 콘텐츠 형태를 미리 보여줘
 * "멈춘 것"처럼 보이지 않게 한다. animate-pulse 는 prefers-reduced-motion 에서 자동 정지(globals.css).
 */
export function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      aria-hidden
      className={cn("animate-pulse rounded-md bg-muted/70", className)}
      {...props}
    />
  );
}
