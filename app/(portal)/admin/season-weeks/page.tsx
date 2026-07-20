import { redirect } from "next/navigation";

type Props = {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
};

// [통합 2026-07-20] 기간 정보(구 /admin/season-weeks)는 기간 등록과 하나의 "기간 관리" 페이지로
//   병합됐다. 독립 페이지는 제거하되, 기존 URL(북마크/직접 접근)은 404 로 방치하지 않고 통합 페이지
//   (/admin/periods/register)로 redirect 한다. 진입 컨텍스트(?org·mode=test 등) 쿼리는 그대로 전달해
//   사이드바 조직 컨텍스트가 끊기지 않게 한다(기간 데이터 자체는 org 무관 전역).
export default async function SeasonWeeksRedirectPage({ searchParams }: Props) {
  const sp = await searchParams;
  const passthrough = new URLSearchParams();
  for (const [key, value] of Object.entries(sp ?? {})) {
    if (typeof value === "string") passthrough.set(key, value);
    else if (Array.isArray(value) && value.length > 0) passthrough.set(key, value[0]);
  }
  const qs = passthrough.toString();
  redirect(`/admin/periods/register${qs ? `?${qs}` : ""}`);
}
