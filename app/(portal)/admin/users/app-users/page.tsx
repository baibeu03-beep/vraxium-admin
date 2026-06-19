import AppUsersList from "@/components/admin/AppUsersList";
import { parseScopeMode } from "@/lib/userScopeShared";

export default async function AppUsersPage({
  searchParams,
}: {
  searchParams: Promise<{ mode?: string | string[] }>;
}) {
  const params = await searchParams;
  const rawMode = Array.isArray(params.mode) ? params.mode[0] : params.mode;
  return <AppUsersList mode={parseScopeMode(rawMode)} />;
}
