/**
 * user_profiles.english_name compatibility backfill.
 * Dry-run is the default; pass --apply to write after creating a JSON backup.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { romanizeKoreanPersonName } from "@/lib/koreanRomanization";

const APPLY = process.argv.includes("--apply");
const env = process.env as Record<string, string>;
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const validKoreanName = /^[가-힣]{2,5}$/;

async function fetchAll<T>(table: string, select: string): Promise<T[]> {
  const out: T[] = [];
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await sb.from(table).select(select).order("user_id").range(offset, offset + 999);
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...((data ?? []) as T[]));
    if ((data ?? []).length < 1000) return out;
  }
}

type Profile = { user_id: string; display_name: string | null; english_name: string | null };
type Change = { user_id: string; display_name: string; before: string | null; after: string };

async function main() {
  const profiles = await fetchAll<Profile>("user_profiles", "user_id,display_name,english_name");
  const excluded = profiles.filter((p) => !p.display_name?.trim() || !validKoreanName.test(p.display_name.trim()));
  const changes: Change[] = [];
  for (const p of profiles) {
    const displayName = p.display_name?.trim() ?? "";
    if (!validKoreanName.test(displayName)) continue;
    const generated = romanizeKoreanPersonName(displayName);
    if (generated && generated !== (p.english_name?.trim() ?? "")) {
      changes.push({ user_id: p.user_id, display_name: displayName, before: p.english_name, after: generated });
    }
  }
  const different = changes.filter((c) => (c.before?.trim() ?? "") !== c.after);
  console.log(JSON.stringify({
    mode: APPLY ? "apply" : "dry-run",
    totalProfiles: profiles.length,
    changeTargets: changes.length,
    excludedInvalidOrEmptyDisplayName: excluded.length,
    currentDifferentExamples: different.slice(0, 20),
  }, null, 2));
  if (!APPLY) return;

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = `backups/english-name-backfill-${stamp}.json`;
  mkdirSync("backups", { recursive: true });
  writeFileSync(backupPath, JSON.stringify({ createdAt: new Date().toISOString(), rows: changes }, null, 2), "utf8");
  let updated = 0;
  for (const row of changes) {
    const { error } = await sb.from("user_profiles").update({ english_name: row.after }).eq("user_id", row.user_id);
    if (error) throw new Error(`${row.user_id}: ${error.message}`);
    updated++;
  }
  console.log(JSON.stringify({ updated, backupPath }, null, 2));
}

main().catch((error) => { console.error(error); process.exit(1); });
