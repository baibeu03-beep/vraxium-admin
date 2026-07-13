import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft } from "lucide-react";
import AdminHelp from "@/components/admin/AdminHelp";
import { AdminDetailTitle } from "@/components/admin/AdminRouteTitleProvider";
import ResumeCardEditor from "@/components/admin/ResumeCardEditor";
import { getMemberDisplayName } from "@/lib/adminCrewData";
import { isOrganizationSlug, ORGANIZATION_LABEL } from "@/lib/organizations";

type Props = {
  params: Promise<{ organization: string; legacy_user_id: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
};

export default async function CrewResumeCardPage({
  params,
  searchParams,
}: Props) {
  const { organization, legacy_user_id } = await params;
  const sp = await searchParams;
  if (!isOrganizationSlug(organization)) notFound();

  const devMode = sp?.dev === "true";
  const devSuffix = devMode ? "?dev=true" : "";
  const memberName = await getMemberDisplayName(legacy_user_id);
  const crumbLabel = memberName ?? (devMode ? legacy_user_id : "이름 미등록");

  return (
    <div className="flex flex-col gap-4">
      {/* 전역 헤더 경로에 실제 회원 표시명 공급(이미 조회한 memberName 재사용, 중복 조회 없음). */}
      <AdminDetailTitle title={memberName ?? undefined} />
      <div className="flex justify-end">
        <AdminHelp />
      </div>
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Link
          href={`/admin/crews${devSuffix}`}
          className="inline-flex items-center gap-1 hover:text-foreground"
        >
          <ChevronLeft className="h-4 w-4" />
          클럽 선택
        </Link>
        <span>/</span>
        <Link
          href={`/admin/crews/${organization}${devSuffix}`}
          className="hover:text-foreground"
        >
          {ORGANIZATION_LABEL[organization]}
        </Link>
        <span>/</span>
        <span className="text-foreground">{crumbLabel}</span>
        {devMode && memberName && (
          <span
            className="font-mono text-[11px] text-muted-foreground"
            title={legacy_user_id}
          >
            ({legacy_user_id})
          </span>
        )}
      </div>

      <div className="flex items-center gap-2 text-xs">
        <span className="rounded-md border bg-foreground px-2 py-1 text-background">
          Cluster1
        </span>
        <Link
          href={`/admin/crews/${organization}/${legacy_user_id}/cluster2${devSuffix}`}
          className="rounded-md border px-2 py-1 hover:bg-muted"
        >
          Cluster 2
        </Link>
        <Link
          href={`/admin/crews/${organization}/${legacy_user_id}/cluster3${devSuffix}`}
          className="rounded-md border px-2 py-1 hover:bg-muted"
        >
          Cluster 3
        </Link>
      </div>

      <ResumeCardEditor
        organization={organization}
        legacyUserId={legacy_user_id}
        memberDisplayName={memberName}
      />
    </div>
  );
}
