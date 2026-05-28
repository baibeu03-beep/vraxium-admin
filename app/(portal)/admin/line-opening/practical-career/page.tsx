import { requireAdminPage } from "@/lib/adminAuth";
import PracticalCareerManager from "@/components/admin/PracticalCareerManager";

export default async function PracticalCareerPage() {
  await requireAdminPage();
  return <PracticalCareerManager />;
}
