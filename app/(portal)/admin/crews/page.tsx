import { redirect } from "next/navigation";
import { isOrganizationSlug, ORGANIZATIONS } from "@/lib/organizations";

type Props = {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
};

// /admin/crews?org={slug} 로 진입하면 org 를 path(/admin/crews/{slug})로 정규화한다.
//   · org 가 path 로 고정되어야 조직 크루 화면(MembersList lockedOrg)의 탭/조직 컨텍스트가
//     일관되게 유지된다(사이드바 org 컨텍스트 = path 우선).
//   · org 미지정/무효면 첫 조직으로 폴백. mode/dev 등 나머지 쿼리는 그대로 전달한다.
export default async function CrewsIndexPage({ searchParams }: Props) {
  const sp = await searchParams;
  const orgParam = typeof sp?.org === "string" ? sp.org : undefined;
  const org = orgParam && isOrganizationSlug(orgParam) ? orgParam : ORGANIZATIONS[0];

  const passthrough = new URLSearchParams();
  for (const [key, value] of Object.entries(sp ?? {})) {
    if (key === "org") continue; // org 는 path 로 승격
    if (typeof value === "string") passthrough.set(key, value);
    else if (Array.isArray(value) && value.length > 0) passthrough.set(key, value[0]);
  }
  const qs = passthrough.toString();
  redirect(`/admin/crews/${org}${qs ? `?${qs}` : ""}`);
}
