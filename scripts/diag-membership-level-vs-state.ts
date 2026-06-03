/**
 * READ-ONLY 진단: user_memberships.membership_level vs membership_state 실제 값 분포 +
 * user_profiles.role / profile_tagline / profile_keyword / vision 채움 현황.
 * badge-status / profileTagline DTO source 결정용 근거 수집. 쓰기 없음.
 *   npx tsx --env-file=.env.local scripts/diag-membership-level-vs-state.ts
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { supabaseAdmin } from "@/lib/supabaseAdmin";

function dist(rows: any[], key: string) {
  const m = new Map<string, number>();
  for (const r of rows) {
    const v = r[key];
    const k = v === null || v === undefined ? "<null>" : v === "" ? "<empty>" : String(v);
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}

async function main() {
  const { data: mem, error: memErr } = await supabaseAdmin
    .from("user_memberships")
    .select("user_id,membership_level,membership_state,is_current");
  if (memErr) throw memErr;
  console.log(`\n=== user_memberships: ${mem?.length ?? 0} rows ===`);
  console.log("membership_level 분포:", JSON.stringify(dist(mem ?? [], "membership_level")));
  console.log("membership_state 분포:", JSON.stringify(dist(mem ?? [], "membership_state")));

  const { data: prof, error: profErr } = await supabaseAdmin
    .from("user_profiles")
    .select("user_id,role,profile_tagline,profile_keyword,vision");
  if (profErr) throw profErr;
  const rows = prof ?? [];
  console.log(`\n=== user_profiles: ${rows.length} rows ===`);
  console.log("role 분포:", JSON.stringify(dist(rows, "role")));
  const cnt = (k: string) => rows.filter((r: any) => r[k] != null && String(r[k]).trim() !== "").length;
  console.log(`profile_tagline 값보유: ${cnt("profile_tagline")}/${rows.length}`);
  console.log(`profile_keyword 값보유: ${cnt("profile_keyword")}/${rows.length}`);
  console.log(`vision 값보유: ${cnt("vision")}/${rows.length}`);

  // 샘플 5명: 4개 필드 동시 표본
  console.log("\n=== 표본 8명 (role / level / state / tagline / keyword / vision) ===");
  const memByUser = new Map<string, any>();
  for (const m of mem ?? []) if (!memByUser.has(m.user_id) || m.is_current) memByUser.set(m.user_id, m);
  for (const p of rows.slice(0, 8) as any[]) {
    const m = memByUser.get(p.user_id) ?? {};
    console.log(
      `  ${p.user_id.slice(0, 8)} role=${JSON.stringify(p.role)} level=${JSON.stringify(m.membership_level)} state=${JSON.stringify(m.membership_state)} tag=${JSON.stringify(p.profile_tagline)} kw=${JSON.stringify(p.profile_keyword)} vis=${JSON.stringify(p.vision)}`,
    );
  }
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
