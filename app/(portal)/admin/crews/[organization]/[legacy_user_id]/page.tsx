import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft } from "lucide-react";
import ResumeCardEditor from "@/components/admin/ResumeCardEditor";
import { isOrganizationSlug, ORGANIZATION_LABEL } from "@/lib/organizations";

type Props = {
  params: Promise<{ organization: string; legacy_user_id: string }>;
};

export default async function CrewResumeCardPage({ params }: Props) {
  const { organization, legacy_user_id } = await params;
  if (!isOrganizationSlug(organization)) notFound();

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Link
          href="/admin/crews"
          className="inline-flex items-center gap-1 hover:text-foreground"
        >
          <ChevronLeft className="h-4 w-4" />
          조직 선택
        </Link>
        <span>/</span>
        <Link
          href={`/admin/crews/${organization}`}
          className="hover:text-foreground"
        >
          {ORGANIZATION_LABEL[organization]}
        </Link>
        <span>/</span>
        <span className="font-mono text-foreground">{legacy_user_id}</span>
      </div>
      <ResumeCardEditor
        organization={organization}
        legacyUserId={legacy_user_id}
      />
    </div>
  );
}
