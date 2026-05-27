import { requireAdminPage } from "@/lib/adminAuth";
import PracticalExperienceManager from "@/components/admin/PracticalExperienceManager";

export default async function PracticalExperiencePage() {
  await requireAdminPage();
  return <PracticalExperienceManager />;
}
