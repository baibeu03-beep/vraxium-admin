import { requireAdminPage } from "@/lib/adminAuth";
import PracticalInfoManager from "@/components/admin/PracticalInfoManager";

export default async function PracticalInfoPage() {
  await requireAdminPage();
  return <PracticalInfoManager />;
}
