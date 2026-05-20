import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft } from "lucide-react";
import CrewManager from "@/components/admin/CrewManager";
import { isOrganizationSlug, ORGANIZATION_LABEL } from "@/lib/organizations";

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
          조직 선택
        </Link>
        <span>/</span>
        <span className="text-foreground">
          {ORGANIZATION_LABEL[organization]}
        </span>
      </div>
      <CrewManager organization={organization} />
    </div>
  );
}
