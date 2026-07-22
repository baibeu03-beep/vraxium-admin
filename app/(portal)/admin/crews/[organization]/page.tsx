import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft } from "lucide-react";
import MembersList from "@/components/admin/MembersList";
import { isOrganizationSlug, organizationLabelKo } from "@/lib/organizations";

type Props = {
  params: Promise<{ organization: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
};

export default async function CrewOrganizationPage({
  params,
  searchParams,
}: Props) {
  const { organization } = await params;
  const sp = await searchParams;
  if (!isOrganizationSlug(organization)) notFound();

  const devSuffix = sp?.dev === "true" ? "?dev=true" : "";

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Link
          href={`/admin/crews${devSuffix}`}
          className="inline-flex items-center gap-1 hover:text-foreground"
        >
          <ChevronLeft className="h-4 w-4" />
          클럽 선택
        </Link>
        <span>/</span>
        <span className="text-foreground">
          {organizationLabelKo(organization)}
        </span>
      </div>
      {/* /admin/members 와 동일한 UI 를 org 로 고정해 재사용한다.
          · "크루 목록" 탭 = 조직 스코프 목록(클럽 드롭다운 없음, 데이터도 org 필터)
          · "크루 관리" 탭 = 크루 정보(집계/통계) 뷰를 현재 org 로 스코프(MembersList 내부에서 렌더) */}
      <MembersList lockedOrg={organization} />
    </div>
  );
}
