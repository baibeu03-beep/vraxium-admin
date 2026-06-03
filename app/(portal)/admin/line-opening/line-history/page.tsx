import { requireAdminPage } from "@/lib/adminAuth";
import LineHistoryManager from "@/components/admin/LineHistoryManager";

export default async function LineHistoryPage() {
  await requireAdminPage();
  return <LineHistoryManager />;
}
