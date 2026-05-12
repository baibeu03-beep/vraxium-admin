"use client";

import { usePathname, useRouter } from "next/navigation";
import { LogOut } from "lucide-react";
import { supabaseClient } from "@/lib/supabaseClient";
import { Button } from "@/components/ui/button";
import { ORGANIZATION_LABEL, isOrganizationSlug } from "@/lib/organizations";

const TITLES: Record<string, string> = {
  "/admin": "대시보드",
  "/admin/applicants": "Applicants",
  "/admin/crews": "조직 관리",
  "/admin/import": "가져오기",
  "/admin/settings": "설정",
};

function resolveTitle(pathname: string): string {
  const direct = TITLES[pathname];
  if (direct) return direct;
  const orgMatch = pathname.match(/^\/admin\/crews\/([^/]+)$/);
  if (orgMatch) {
    const slug = orgMatch[1];
    if (isOrganizationSlug(slug)) {
      return `조직 관리 · ${ORGANIZATION_LABEL[slug]}`;
    }
  }
  return "Admin";
}

export default function Header() {
  const pathname = usePathname();
  const router = useRouter();
  const title = resolveTitle(pathname);

  const handleLogout = async () => {
    await supabaseClient.auth.signOut();
    router.push("/login");
    router.refresh();
  };

  return (
    <header className="flex h-14 items-center justify-between border-b border-border bg-background px-6">
      <h1 className="text-base font-semibold text-foreground">{title}</h1>
      <Button variant="ghost" size="sm" onClick={handleLogout}>
        <LogOut className="h-4 w-4" />
        로그아웃
      </Button>
    </header>
  );
}
