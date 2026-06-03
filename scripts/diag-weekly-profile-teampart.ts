/**
 * 위클리 평판 fromProfile.team/part null 원인 진단 + pickBestMembership 현행/수정 비교.
 *   npx tsx --env-file=.env.local scripts/diag-weekly-profile-teampart.ts ["이유나" 또는 userId]
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { supabaseAdmin } from "@/lib/supabaseAdmin";

type Mem = {
  team_name: string | null;
  part_name: string | null;
  membership_state: string | null;
  is_current: boolean | null;
  updated_at: string | null;
};

// 현행 로직 (cluster4WeeklyPeopleData.pickBestMembership 그대로)
function pickCurrent(rows: Mem[]): Mem | undefined {
  return [...rows].sort((a, b) => {
    const currentDelta = Number(Boolean(b.is_current)) - Number(Boolean(a.is_current));
    if (currentDelta !== 0) return currentDelta;
    return (b.updated_at ?? "").localeCompare(a.updated_at ?? "");
  })[0];
}

// 수정안: is_current → team/part 값 보유 → updated_at 최신
function pickFixed(rows: Mem[]): Mem | undefined {
  const hasTP = (m: Mem) => Boolean(m.team_name) || Boolean(m.part_name);
  return [...rows].sort((a, b) => {
    const cur = Number(Boolean(b.is_current)) - Number(Boolean(a.is_current));
    if (cur !== 0) return cur;
    const tp = Number(hasTP(b)) - Number(hasTP(a));
    if (tp !== 0) return tp;
    return (b.updated_at ?? "").localeCompare(a.updated_at ?? "");
  })[0];
}

async function resolveUsers(arg: string | null) {
  if (arg && /^[0-9a-f-]{32,}$/i.test(arg)) {
    const { data } = await supabaseAdmin
      .from("user_profiles")
      .select("user_id,display_name")
      .eq("user_id", arg);
    return (data ?? []).map((r: any) => ({ user_id: r.user_id, name: r.display_name }));
  }
  const { data } = await supabaseAdmin
    .from("user_profiles")
    .select("user_id,display_name")
    .ilike("display_name", `%${arg || "이유나"}%`)
    .limit(10);
  return (data ?? []).map((r: any) => ({ user_id: r.user_id, name: r.display_name }));
}

async function main() {
  const users = await resolveUsers(process.argv[2] || null);
  if (!users.length) return console.log("❌ 사용자 없음");

  for (const u of users) {
    console.log(`\n================ ${u.name} (${u.user_id}) ================`);
    const { data: mem } = await supabaseAdmin
      .from("user_memberships")
      .select("team_name,part_name,membership_state,is_current,updated_at")
      .eq("user_id", u.user_id);
    console.log(`[user_memberships] ${mem?.length ?? 0} rows`);
    console.log(JSON.stringify(mem, null, 2));

    const cur = pickCurrent((mem ?? []) as Mem[]);
    const fix = pickFixed((mem ?? []) as Mem[]);
    console.log(`현행 pick → team=${cur?.team_name ?? null} part=${cur?.part_name ?? null}`);
    console.log(`수정 pick → team=${fix?.team_name ?? null} part=${fix?.part_name ?? null}`);
  }
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
