import { redirect } from "next/navigation";
import { ORGANIZATIONS } from "@/lib/organizations";

// 사이드바 서브메뉴(encre/oranke/phalanx)가 조직 선택 UI를 담당하므로
// /admin/crews 자체는 첫 조직 페이지로 리다이렉트한다.
export default function CrewsIndexPage() {
  redirect(`/admin/crews/${ORGANIZATIONS[0]}`);
}
