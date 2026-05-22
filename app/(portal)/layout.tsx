import Sidebar from "@/components/admin/Sidebar";
import Header from "@/components/admin/Header";
import { SidebarProvider } from "@/components/admin/sidebarContext";
import { requireAdminPage } from "@/lib/adminAuth";

export default async function PortalLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  await requireAdminPage();

  return (
    <SidebarProvider>
      <div className="flex flex-1 min-h-screen bg-muted/40">
        <Sidebar />
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
