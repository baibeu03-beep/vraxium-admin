import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft } from "lucide-react";
import Cluster3Editor from "@/components/admin/Cluster3Editor";
import { isOrganizationSlug, ORGANIZATION_LABEL } from "@/lib/organizations";

type Props = {
  params: Promise<{ organization: string; legacy_user_id: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
};

export default async function CrewCluster3Page({
  params,
  searchParams,
}: Props) {
  const { organization, legacy_user_id } = await params;
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
          조직 선택
        </Link>
        <span>/</span>
        <Link
          href={`/admin/crews/${organization}${devSuffix}`}
          className="hover:text-foreground"
        >
          {ORGANIZATION_LABEL[organization]}
        </Link>
        <span>/</span>
        <span className="font-mono text-foreground">{legacy_user_id}</span>
      </div>

      <div className="flex items-center gap-2 text-xs">
        <Link
          href={`/admin/crews/${organization}/${legacy_user_id}${devSuffix}`}
          className="rounded-md border px-2 py-1 hover:bg-muted"
        >
          Resume Card
        </Link>
        <Link
          href={`/admin/crews/${organization}/${legacy_user_id}/cluster2${devSuffix}`}
          className="rounded-md border px-2 py-1 hover:bg-muted"
        >
          Cluster 2
        </Link>
        <span className="rounded-md border bg-foreground px-2 py-1 text-background">
          Cluster 3
        </span>
      </div>

      <Cluster3Editor
        organization={organization}
        legacyUserId={legacy_user_id}
      />
    </div>
  );
}
