import Link from "next/link";
import { cn } from "@/lib/utils";
import AdminHelp from "@/components/admin/AdminHelp";

// 어드민 페이지 공통 상단 헤더 — 모든 어드민 페이지의 상단 구조(제목·설명·액션·탭)를 통일한다.
//   - title       : 페이지 제목(필수). PageTitle 위계 = h1, text-lg(모바일)→text-xl(데스크톱).
//                   섹션 제목(text-base)과의 크기 차를 벌려 위계를 뚜렷하게 한다.
//   - description : 선택적 부제/설명문. 제목 아래 muted 한 줄(있을 때만 렌더).
//   - actions     : 선택적 우측 액션(버튼 등). [도움말] 왼쪽에 배치, 좁은 화면에선 래핑.
//   - tabs        : 선택적 탭 배열. 없으면 제목만 렌더.
//
// 탭 스타일은 기존 글로벌 Header.tsx 의 라인 개설/멤버 탭과 동일한 디자인 토큰을 쓴다
// (active = bg-foreground/text-background, inactive = muted + hover). href 는 호출부가
// org/tab 등 쿼리스트링을 보존해 만들어 넘긴다 — 이 컴포넌트는 표시 전용(라우팅/스코프 무관).
// mode(일반/test)·org 로 분기하지 않는다(순수 프레젠테이션 — 어느 조직/모드에서도 동일).
//
// 탭 렌더 방식:
//   · href 형(기본): <Link href> — 페이지 이동/쿼리스트링 스코프 전환.
//   · onSelect 형: <button onClick> — 라우팅 없이 페이지 내부 상태만 전환(URL 불변).
//     onSelect 가 있으면 button 으로 렌더하며 href 는 무시된다(key 용도로만 optional 사용).
export type AdminPageHeaderTab = {
  label: string;
  href?: string;
  active?: boolean;
  onSelect?: () => void;
};

type AdminPageHeaderProps = {
  title: string;
  description?: string;
  actions?: React.ReactNode;
  tabs?: AdminPageHeaderTab[];
};

export default function AdminPageHeader({
  title,
  description,
  actions,
  tabs,
}: AdminPageHeaderProps) {
  const hasTabs = Array.isArray(tabs) && tabs.length > 0;

  return (
    <div className="flex flex-col gap-3">
      {/* 제목·설명(좌) + [액션][도움말](우) — 좁은 화면에선 자연스럽게 아래로 래핑.
          설명문이 없으면 우측 클러스터를 세로 가운데 정렬(설명 없는 기존 페이지의 룩 유지),
          있으면 위쪽 정렬(제목/버튼 상단 라인 맞춤). */}
      <div
        className={cn(
          "flex flex-wrap justify-between gap-3",
          description ? "items-start" : "items-center",
        )}
      >
        <div className="flex min-w-0 flex-col gap-1">
          <h1 className="text-lg font-semibold tracking-tight text-foreground md:text-xl">
            {title}
          </h1>
          {description ? (
            <p className="text-sm text-muted-foreground">{description}</p>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {actions}
          <AdminHelp />
        </div>
      </div>

      {hasTabs ? (
        <nav
          aria-label="페이지 탭"
          className="flex flex-wrap items-center gap-1"
        >
          {tabs!.map((t) => {
            const cls = cn(
              "rounded-md px-3.5 py-1.5 text-sm font-semibold transition-colors",
              t.active
                ? "bg-foreground text-background"
                : "text-muted-foreground hover:bg-muted hover:text-foreground",
            );
            // onSelect 형 = 라우팅 없이 내부 상태 전환(button). URL 을 바꾸지 않는다.
            if (t.onSelect) {
              return (
                <button
                  key={t.href ?? t.label}
                  type="button"
                  onClick={t.onSelect}
                  aria-current={t.active ? "page" : undefined}
                  className={cls}
                >
                  {t.label}
                </button>
              );
            }
            return (
              <Link
                key={t.href ?? t.label}
                href={t.href ?? "#"}
                aria-current={t.active ? "page" : undefined}
                className={cls}
              >
                {t.label}
              </Link>
            );
          })}
        </nav>
      ) : null}
    </div>
  );
}
