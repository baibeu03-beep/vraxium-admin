import { redirect } from "next/navigation";

// "사용자 관리" 메뉴는 항상 첫 하위 메뉴(가입된 사용자)로 진입한다.
export default function UsersIndexPage() {
  redirect("/admin/users/app-users");
}
