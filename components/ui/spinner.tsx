import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

const sizeClass = {
  xs: "h-3 w-3",
  sm: "h-4 w-4",
  md: "h-5 w-5",
  lg: "h-6 w-6",
} as const;

/**
 * 공통 스피너(전역 단일 출처). 단독 사용보다 <LoadingState> 처럼 텍스트와 함께 쓰는 것을 권장.
 * (요구사항: "단순 spinner 하나만 돌리지 말고 텍스트도 함께".)
 */
export function Spinner({
  size = "sm",
  className,
  ...props
}: { size?: keyof typeof sizeClass } & React.ComponentProps<typeof Loader2>) {
  return (
    <Loader2
      role="status"
      aria-label="불러오는 중"
      className={cn("animate-spin text-muted-foreground", sizeClass[size], className)}
      {...props}
    />
  );
}
