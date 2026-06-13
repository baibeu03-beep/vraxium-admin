import Sidebar from "@/components/admin/Sidebar";
import Header from "@/components/admin/Header";
import { SidebarProvider } from "@/components/admin/sidebarContext";
import TestModeToggle from "@/components/admin/TestModeToggle";
import { requireAdminPage } from "@/lib/adminAuth";
import { loadAdminDisplayName } from "@/lib/adminMe";

export default async function PortalLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const admin = await requireAdminPage();
  // 헤더 우측 관리자 정보 표시용(이름 SoT = user_profiles.display_name).
  const adminDisplayName = await loadAdminDisplayName(admin.userId);

  return (
    <SidebarProvider>
      <div className="flex flex-1 min-h-screen bg-muted/40">
        <Sidebar />
        {/* min-w-0 lets this flex child shrink below intrinsic content width so
            wide tables scroll inside their own container instead of pushing the
            whole page (header + sidebar) horizontally. */}
        <div className="flex flex-1 flex-col min-w-0">
          <Header
            adminDisplayName={adminDisplayName}
            adminEmail={admin.email}
          />
          <main className="flex-1 min-w-0 p-6">{children}</main>
        </div>
      </div>
      {/* 운영/테스트 모드 토글(표시 전용·admin 경로 한정, 자체 Suspense). */}
      <TestModeToggle />
    </SidebarProvider>
  );
}
