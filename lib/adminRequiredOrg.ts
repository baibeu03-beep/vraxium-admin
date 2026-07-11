import { notFound, redirect } from "next/navigation";
import {
  ORGANIZATIONS,
  isOrganizationSlug,
  type OrganizationSlug,
} from "@/lib/organizations";

type PageSearchParams = Record<string, string | string[] | undefined>;

// 조직 단위 관리자 화면은 통합 모드로 렌더하지 않는다. 누락은 명시적 기본 조직으로
// 교정하고, 잘못된 값은 임의 조직 데이터로 대체하지 않는다.
export function requirePageOrganization(
  pathname: string,
  searchParams: PageSearchParams,
): OrganizationSlug {
  const raw = searchParams.org;
  const org = Array.isArray(raw) ? raw[0] : raw;

  if (org === undefined || org.trim() === "") {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(searchParams)) {
      if (value === undefined || key === "org") continue;
      for (const item of Array.isArray(value) ? value : [value]) {
        params.append(key, item);
      }
    }
    params.set("org", ORGANIZATIONS[0]);
    redirect(`${pathname}?${params.toString()}`);
  }

  if (!isOrganizationSlug(org)) notFound();
  return org;
}
