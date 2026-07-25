"use client";

import AdminOrganizationTabs from "@/components/admin/AdminOrganizationTabs";
import { useSearchParams } from "next/navigation";
import { readOrgParam } from "@/lib/adminOrgContext";

export default function IntegratedAdminSection({
  children,
  helpKey,
}: {
  children: React.ReactNode;
  helpKey: string;
}) {
  const searchParams = useSearchParams();
  const selectedOrg = readOrgParam(searchParams);

  return (
    <div className="flex w-full min-w-0 flex-col gap-5">
      <AdminOrganizationTabs helpKey={helpKey} />
      {selectedOrg ? (
        // A scope switch must discard every previous organization's local UI/cache state.
        <div key={selectedOrg} data-integrated-scoped-content data-org={selectedOrg}>
          {children}
        </div>
      ) : (
        <div aria-hidden className="min-h-1" data-integrated-empty-content />
      )}
    </div>
  );
}
