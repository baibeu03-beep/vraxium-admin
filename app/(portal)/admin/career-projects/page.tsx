import { requireAdminPage } from "@/lib/adminAuth";
import CareerProjectsManager from "@/components/admin/CareerProjectsManager";

// 라인 개설 · 실무 경력 — career_projects 마스터 CRUD + career_project_weeks 스케줄링.
// read 접근은 ADMIN_READ_ROLES (owner/admin/viewer), 쓰기는 owner 만 — 게이트는 API 라우트가 책임.
// 페이지 자체는 admin 누구나 접근 가능. owner 가 아니면 UI 가 자동으로 read-only 가 된다.
export default async function CareerProjectsPage() {
  await requireAdminPage();
  return <CareerProjectsManager />;
}
