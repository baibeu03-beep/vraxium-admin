import { Skeleton } from "@/components/ui/skeleton";
import { LOADING_TEXT } from "@/components/ui/loading-state";
import { Spinner } from "@/components/ui/spinner";

/**
 * 어드민 전체 라우트 전환 폴백(단일 출처).
 *
 * Next App Router 가 서버 컴포넌트 페이지를 준비하는 동안 본문을 빈 화면으로 두지 않고
 * 이 스켈레톤을 즉시 보여준다 → "먹통/빈 화면"처럼 보이지 않는다(요구사항 3·4).
 * 페이지마다 따로 만들지 않고 이 한 파일이 모든 /admin/* 하위에 적용된다.
 */
export default function AdminLoading() {
  return (
    <div className="space-y-6" aria-busy>
      {/* 페이지 헤더 자리 */}
      <div className="space-y-2">
        <Skeleton className="h-7 w-56" />
        <Skeleton className="h-4 w-80" />
      </div>

      {/* 상태 안내(텍스트 + 스피너) */}
      <div
        role="status"
        aria-live="polite"
        className="flex items-center gap-2 text-sm text-muted-foreground"
      >
        <Spinner size="sm" />
        {LOADING_TEXT.body}
      </div>

      {/* 표/콘텐츠 자리 — 스켈레톤 행 */}
      <div className="space-y-3 rounded-lg border border-border p-4">
        <Skeleton className="h-9 w-full" />
        {Array.from({ length: 8 }).map((_, i) => (
          <Skeleton key={i} className="h-7 w-full" />
        ))}
      </div>
    </div>
  );
}
