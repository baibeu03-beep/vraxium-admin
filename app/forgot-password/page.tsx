import { Suspense } from "react";
import ForgotPasswordForm from "@/components/admin/ForgotPasswordForm";

// 비밀번호 재설정 메일 요청 화면 (로그인 전 공개 페이지).
export default function ForgotPasswordPage() {
  return (
    <Suspense>
      <ForgotPasswordForm />
    </Suspense>
  );
}
