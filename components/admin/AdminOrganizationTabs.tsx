"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import AdminHelpIconButton from "@/components/admin/AdminHelpIconButton";
import {
  ORGANIZATIONS,
  orgTabClassName,
  organizationLabelKo,
  type OrganizationSlug,
} from "@/lib/organizations";
import { readOrgParam } from "@/lib/adminOrgContext";

type OrganizationTab = "integrated" | OrganizationSlug;

const tabs: OrganizationTab[] = ["integrated", ...ORGANIZATIONS];

export default function AdminOrganizationTabs({
  helpKey,
}: {
  helpKey: string;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const selected: OrganizationTab = readOrgParam(searchParams) ?? "integrated";

  const select = (tab: OrganizationTab) => {
    const params = new URLSearchParams(searchParams.toString());
    if (tab === "integrated") params.delete("org");
    else params.set("org", tab);

    // A page number belongs to the previous organization result set.
    params.delete("page");
    const query = params.toString();
    router.push(query ? `${pathname}?${query}` : pathname, { scroll: false });
  };

  return (
    <div
      className="flex flex-wrap items-center gap-x-8 gap-y-3"
      data-admin-organization-tabs
    >
      <span className="inline-flex items-center gap-1 text-sm font-semibold">
        <span>클럽</span>
        <AdminHelpIconButton helpKey={helpKey} title="클럽 선택" />
      </span>
      <div className="flex flex-wrap gap-1" role="tablist" aria-label="클럽 선택">
        {tabs.map((tab) => {
          const active = selected === tab;
          return (
            <button
              key={tab}
              type="button"
              role="tab"
              aria-selected={active}
              data-club-tab={tab}
              onClick={() => select(tab)}
              className={orgTabClassName(active)}
            >
              {tab === "integrated" ? "통합" : organizationLabelKo(tab)}
            </button>
          );
        })}
      </div>
    </div>
  );
}
