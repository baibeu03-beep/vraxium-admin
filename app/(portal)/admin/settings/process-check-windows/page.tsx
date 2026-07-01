import { requireAdminPage } from "@/lib/adminAuth";
import ProcessCheckWindowsManager from "@/components/admin/ProcessCheckWindowsManager";

export default async function ProcessCheckWindowsPage() {
  await requireAdminPage();
  return <ProcessCheckWindowsManager />;
}
