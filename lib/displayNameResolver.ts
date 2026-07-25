import { supabaseAdmin } from "@/lib/supabaseAdmin";
import {
  resolvePersonDisplayNames,
  type PersonDisplayNames,
} from "@/lib/koreanRomanization";

export type DisplayName = string | null;

export function displayNameFromProfile(
  profile: { display_name?: string | null } | null | undefined,
): DisplayName {
  return profile?.display_name ?? null;
}

export async function resolveDisplayName(userId: string): Promise<DisplayName> {
  const { data, error } = await supabaseAdmin
    .from("user_profiles")
    .select("display_name")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) {
    throw new Error(`user_profiles.display_name load failed: ${error.message}`);
  }
  return displayNameFromProfile(data);
}

export async function resolveDisplayNames(
  userIds: readonly string[],
): Promise<Map<string, DisplayName>> {
  const ids = [...new Set(userIds.filter(Boolean))];
  const result = new Map<string, DisplayName>();
  for (const id of ids) result.set(id, null);
  for (let i = 0; i < ids.length; i += 300) {
    const { data, error } = await supabaseAdmin
      .from("user_profiles")
      .select("user_id,display_name")
      .in("user_id", ids.slice(i, i + 300));
    if (error) {
      throw new Error(
        `user_profiles.display_name batch load failed: ${error.message}`,
      );
    }
    for (const row of data ?? []) {
      result.set(row.user_id, displayNameFromProfile(row));
    }
  }
  return result;
}

export async function resolvePersonNames(
  userId: string,
): Promise<PersonDisplayNames> {
  const [{ isTestUser }, displayName] = await Promise.all([
    import("@/lib/testUsers"),
    resolveDisplayName(userId),
  ]);
  return resolvePersonDisplayNames(displayName, {
    isTestUser: await isTestUser(userId),
  });
}

export async function resolvePersonNamesBatch(
  userIds: readonly string[],
): Promise<Map<string, PersonDisplayNames>> {
  const [{ fetchTestUserMarkerIds }, displayNames] = await Promise.all([
    import("@/lib/testUsers"),
    resolveDisplayNames(userIds),
  ]);
  const testUserIds = await fetchTestUserMarkerIds();
  return new Map(
    [...displayNames].map(([userId, displayName]) => [
      userId,
      resolvePersonDisplayNames(displayName, {
        isTestUser: testUserIds.has(userId),
      }),
    ]),
  );
}
