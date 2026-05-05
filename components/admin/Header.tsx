"use client";

import { usePathname, useRouter } from "next/navigation";
import { LogOut } from "lucide-react";
import { supabaseClient } from "@/lib/supabaseClient";
import { Button } from "@/components/ui/button";

const TITLES: Record<string, string> = {
  "/admin": "Dashboard",
  "/admin/crews": "Crew Management",
  "/admin/import": "Import",
  "/admin/settings": "Settings",
};

export default function Header() {
  const pathname = usePathname();
  const router = useRouter();
  const title = TITLES[pathname] ?? "Admin";

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
