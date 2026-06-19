import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { excludeSuperAdmins } from "@/lib/superAdmins";
import { resolveUserScope, type ScopeMode } from "@/lib/userScope";

type UserProfileRow = {
  user_id: string;
  display_name: string | null;
  profile_photo_url: string | null;
  organization_slug: string | null;
};

export async function listCluster4Users(options?: {
  organization?: string | null;
  mode?: ScopeMode;
}) {
  let query = supabaseAdmin
    .from("user_profiles")
    .select("user_id,display_name,profile_photo_url,organization_slug")
    .order("display_name", { ascending: true });

  query = excludeSuperAdmins(query);

  if (options?.organization) {
    query = query.eq("organization_slug", options.organization);
  }

  const { data, error } = await query;
  if (error) throw error;

  const scope = await resolveUserScope(options?.mode ?? "operating", null);
  return scope
    .filter((data ?? []) as UserProfileRow[], (row) => row.user_id)
    .map((row) => ({
      userId: row.user_id,
      displayName: row.display_name ?? "(이름 없음)",
      profileImg: row.profile_photo_url,
      organization: row.organization_slug,
    }));
}
