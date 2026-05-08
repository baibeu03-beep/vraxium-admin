import { redirect } from "next/navigation";
import LoginForm from "@/components/admin/LoginForm";
import { getSupabaseServerClient } from "@/lib/supabaseServer";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

export default async function LoginPage() {
  const supabase = await getSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (user) {
    const { data: adminUser } = await supabaseAdmin
      .from("admin_users")
      .select("id,is_active")
      .eq("id", user.id)
      .eq("is_active", true)
      .maybeSingle();

    if (adminUser) {
      redirect("/admin");
    }
  }

  return <LoginForm />;
}
