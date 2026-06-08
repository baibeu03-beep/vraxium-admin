import { requireAdminPage } from "@/lib/adminAuth";
import LineRegistrationInfoManager from "@/components/admin/LineRegistrationInfoManager";

// 라인 정보 — line_registrations 전용 조회 (2026-06-07 개정).
// 4원천 통합 카탈로그(LineCatalogManager)는 대체됨 — 개설 연결(2C)·수정(2E-6) 기능은
// 새 테이블 안에 그대로 유지. snapshot/기존 4허브 SoT 무접촉.
export default async function LineInfoPage() {
  await requireAdminPage();
  return <LineRegistrationInfoManager />;
}
