import { requireAdminPage } from "@/lib/adminAuth";
import LineRegistrationManager from "@/components/admin/LineRegistrationManager";

// 라인 등록 — 신규 라인을 line_registrations 레지스트리에 저장 (additive Phase).
// 기존 4허브 SoT/개설 기능/snapshot 경로와 분리.
export default async function LineRegisterPage() {
  await requireAdminPage();
  return <LineRegistrationManager />;
}
