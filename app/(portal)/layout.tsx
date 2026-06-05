import Sidebar from "@/components/admin/Sidebar";
import Header from "@/components/admin/Header";
import { SidebarProvider } from "@/components/admin/sidebarContext";
import { requireAdminPage } from "@/lib/adminAuth";
import { loadAdminDisplayName } from "@/lib/adminMe";

export default async function PortalLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const admin = await requireAdminPage();
  // 사이드바 하단 관리자 정보 표시용(이름 SoT = user_profiles.display_name).
  const adminDisplayName = await loadAdminDisplayName(admin.userId);

  return (
    <SidebarProvider>
      <div className="flex flex-1 min-h-screen bg-muted/40">
        <Sidebar
          adminDisplayName={adminDisplayName}
          adminEmail={admin.email}
        />
        {/* min-w-0 lets this flex child shrink below intrinsic content width so
            wide tables scroll inside their own container instead of pushing the
            whole page (header + sidebar) horizontally. */}
        <div className="flex flex-1 flex-col min-w-0">
          <Header />
          <main className="flex-1 min-w-0 p-6">{children}</main>
        </div>
      </div>
    </SidebarProvider>
  );
}
