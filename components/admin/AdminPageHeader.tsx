import Link from "next/link";
import { cn } from "@/lib/utils";
import AdminHelp from "@/components/admin/AdminHelp";

// 어드민 페이지 공통 상단 헤더 — 모든 어드민 페이지의 상단 구조(제목·탭)를 통일한다.
//   - title : 페이지/섹션 제목 (필수). 페이지 헤더는 H1만 표시한다(서브타이틀 없음).
//   - tabs  : 선택적 탭 배열. 없으면 제목만 렌더.
//
// 탭 스타일은 기존 글로벌 Header.tsx 의 라인 개설/멤버 탭과 동일한 디자인 토큰을 쓴다
// (active = bg-foreground/text-background, inactive = muted + hover). href 는 호출부가
// org/tab 등 쿼리스트링을 보존해 만들어 넘긴다 — 이 컴포넌트는 표시 전용(라우팅/스코프 무관).
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
  tabs?: AdminPageHeaderTab[];
};

export default function AdminPageHeader({
  title,
  tabs,
}: AdminPageHeaderProps) {
  const hasTabs = Array.isArray(tabs) && tabs.length > 0;

  return (
    <div className="flex flex-col gap-3">
      {/* 제목(좌) + [도움말](우) — 좁은 화면에선 자연스럽게 아래로 래핑. */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-lg font-semibold tracking-tight text-foreground">
          {title}
        </h1>
        <AdminHelp className="ml-auto" />
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
