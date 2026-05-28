import { requireAdminPage } from "@/lib/adminAuth";
import PracticalCompetencyManager from "@/components/admin/PracticalCompetencyManager";

export default async function PracticalCompetencyPage() {
  await requireAdminPage();
  return <PracticalCompetencyManager />;
}
