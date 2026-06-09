import { requireAdminPage } from "@/lib/adminAuth";
import LineOpeningWindowsManager from "@/components/admin/LineOpeningWindowsManager";

export default async function LineOpeningWindowsPage() {
  await requireAdminPage();
  return <LineOpeningWindowsManager />;
}
