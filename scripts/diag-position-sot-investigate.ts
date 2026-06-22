/**
 * READ-ONLY 조사: 시즌별 포지션(직책)의 실제 SoT 가 어디에 있는지 전수 탐색.
 *   npx tsx --env-file=.env.local scripts/diag-position-sot-investigate.ts
 *
 * 목적:
 *   1) user_memberships 구조/행수 — season_key·week 단위 이력이 있는가?
 *   2) role/position 이력 테이블 존재 여부 (user_role_history / user_team_parts / pms 등)
 *   3) 운영진/심화 사용자 샘플의 멤버십 행 패턴
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

async function probeTable(name: string, cols = "*") {
  const { data, error, count } = await sb
    .from(name)
    .select(cols, { count: "exact" })
    .limit(3);
  if (error) {
    console.log(`  ✗ ${name}: ${error.message}`);
    return null;
  }
  console.log(`  ✓ ${name}: count=${count}`);
  if (data && data.length) {
    console.log(`    cols: ${Object.keys(data[0]).join(", ")}`);
    for (const r of data) console.log(`    row: ${JSON.stringify(r)}`);
  }
  return data;
}

async function main() {
  console.log("──── (1) 후보 이력 테이블 존재 여부 ────");
  for (const t of [
    "user_memberships",
    "user_role_history",
    "user_team_parts",
    "user_season_histories",
    "user_seasons",
    "user_role_seasons",
    "membership_history",
    "user_grade_stats",
  ]) {
    await probeTable(t);
  }

  console.log("\n──── (2) user_memberships 전체 컬럼 + season 연관 ────");
  const { data: mcols } = await sb.from("user_memberships").select("*").limit(1);
  if (mcols?.length) console.log("  컬럼:", Object.keys(mcols[0]).join(", "));

  console.log("\n──── (3) 멤버십 행 수 분포 (유저당 몇 행?) ────");
  const { data: allM } = await sb
    .from("user_memberships")
    .select("user_id, membership_level, membership_state, is_current, team_name, part_name, created_at, updated_at")
    .limit(5000);
  const byUser = new Map<string, number>();
  for (const m of (allM ?? []) as any[]) {
    byUser.set(m.user_id, (byUser.get(m.user_id) ?? 0) + 1);
  }
  const dist = new Map<number, number>();
  for (const c of byUser.values()) dist.set(c, (dist.get(c) ?? 0) + 1);
  console.log("  유저당 멤버십 행수 분포:", JSON.stringify([...dist.entries()].sort()));
  console.log("  총 유저(멤버십 보유):", byUser.size, " / 총 행:", (allM ?? []).length);

  // 멤버십 level 값 분포
  const levelDist = new Map<string, number>();
  for (const m of (allM ?? []) as any[]) {
    const k = String(m.membership_level ?? "(null)");
    levelDist.set(k, (levelDist.get(k) ?? 0) + 1);
  }
  console.log("  membership_level 분포:", JSON.stringify([...levelDist.entries()]));

  console.log("\n──── (4) 여러 멤버십 행을 가진 유저 샘플 ────");
  const multi = [...byUser.entries()].filter(([, c]) => c > 1).slice(0, 5);
  for (const [uid] of multi) {
    const rows = (allM ?? []).filter((m: any) => m.user_id === uid);
    const { data: p } = await sb.from("user_profiles").select("display_name, role, organization_slug").eq("user_id", uid).maybeSingle();
    console.log(`  ${(p as any)?.display_name} (${uid}) role=${(p as any)?.role}`);
    for (const r of rows as any[]) {
      console.log(`    level=${r.membership_level} state=${r.membership_state} cur=${r.is_current} team=${r.team_name} part=${r.part_name} created=${r.created_at}`);
    }
  }

  console.log("\n──── (5) profile.role 값 분포 ────");
  const { data: roles } = await sb.from("user_profiles").select("role").limit(5000);
  const roleDist = new Map<string, number>();
  for (const r of (roles ?? []) as any[]) {
    const k = String(r.role ?? "(null)");
    roleDist.set(k, (roleDist.get(k) ?? 0) + 1);
  }
  console.log("  role 분포:", JSON.stringify([...roleDist.entries()]));
}

main().catch((e) => { console.error(e); process.exit(1); });
