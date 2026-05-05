"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  Users,
  Upload,
  Settings as SettingsIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";

const MENU = [
  { label: "Dashboard", href: "/admin", icon: LayoutDashboard },
  { label: "Crew Management", href: "/admin/crews", icon: Users },
  { label: "Import", href: "/admin/import", icon: Upload },
  { label: "Settings", href: "/admin/settings", icon: SettingsIcon },
];

export default function Sidebar() {
  const pathname = usePathname();

  return (
    <aside className="w-60 shrink-0 border-r border-sidebar-border bg-sidebar">
      <div className="flex h-14 items-center border-b border-sidebar-border px-6">
        <span className="text-base font-semibold tracking-tight text-sidebar-foreground">
          Vraxium Admin
        </span>
      </div>
      <nav className="flex flex-col gap-1 p-3">
        {MENU.map(({ label, href, icon: Icon }) => {
          const active =
            href === "/admin"
              ? pathname === "/admin"
              : pathname === href || pathname.startsWith(href + "/");
          return (
            <Link
              key={href}
              href={href}
              className={cn(
                "flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                active
                  ? "bg-sidebar-primary text-sidebar-primary-foreground"
                  : "text-sidebar-foreground/80 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
              )}
            >
              <Icon className="h-4 w-4" />
              {label}
            </Link>
          );
        })}
      </nav>
    </aside>
  );
}
