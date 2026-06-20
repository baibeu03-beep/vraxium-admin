/** READ-ONLY: role=team_leader/ambassador 사용자의 membership_level + 관리(5) 슬롯 게이트 판정 확인.
 *  목적: 팀장이 '일반'으로 내려와 관리 슬롯이 잠기는지(게이트 fail-closed) 실데이터로 검증.
 *  run: tsx --env-file=.env.local scripts/diag-team-leader-management-gate.ts
 */
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { isManagementSlotOpenForLevel, fetchManagementSlotOpen } from "@/lib/lineAvailability";
import { memberStatusLabel, classLabel } from "@/lib/adminMembersTypes";

// 관리 게이트(fetchManagementSlotOpen)와 동일한 행 선택 규칙으로 membership_level 픽.
type MemRow = { membership_level: string | null; team_name: string | null; is_current: boolean | null; updated_at: string | null };
function pickLevel(rows: MemRow[] | null | undefined): string | null {
  const list = rows ?? [];
  if (list.length === 0) return null;
  const rank = (r: MemRow) => {
    const cur = Boolean(r.is_current);
    const team = typeof r.team_name === "string" && r.team_name.trim() !== "";
    if (cur && team) return 0;
    if (team) return 1;
    if (cur) return 2;
    return 3;
  };
  const best = list.slice().sort((a, b) => {
    const d = rank(a) - rank(b);
    if (d !== 0) return d;
    return (b.updated_at ?? "").localeCompare(a.updated_at ?? "");
  })[0];
  return best?.membership_level ?? null;
}

async function main() {
  // 1) role=team_leader / ambassador / admin / super_admin 사용자 수집
  const { data: profs, error } = await supabaseAdmin
    .from("user_profiles")
    .select("user_id, display_name, role, current_team_name, current_part_name, organization_slug")
    .in("role", ["team_leader", "ambassador", "admin", "super_admin"]);
  if (error) {
    console.error("profiles error:", error.message);
    process.exit(1);
  }
  const rows = profs ?? [];
  console.log(`운영진 역할 프로필 수: ${rows.length}`);

  let lockedCount = 0;
  const lockedSamples: any[] = [];

  for (const p of rows) {
    const { data: mems } = await supabaseAdmin
      .from("user_memberships")
      .select("membership_level, membership_state, is_current, team_name, part_name, updated_at")
      .eq("user_id", p.user_id);

    const level = pickLevel(mems as MemRow[] | null);

    // 현재(버그) 게이트: membership_level 만 본다
    const gateNowLevelOnly = isManagementSlotOpenForLevel(level);
    const gateNowAsync = await fetchManagementSlotOpen(p.user_id);

    // 올바른 판정(role 병합): classLabel/memberStatusLabel 기준
    const cls = classLabel(p.role ?? null, level);
    const shouldOpen = cls.startsWith("심화") || cls.startsWith("운영진");

    const locked = !gateNowAsync && shouldOpen;
    if (locked) {
      lockedCount++;
      if (lockedSamples.length < 12) {
        lockedSamples.push({
          user_id: p.user_id,
          name: p.display_name,
          org: p.organization_slug,
          role: p.role,
          membership_level: level,
          statusLabel: memberStatusLabel(p.role ?? null, level),
          classLabel: cls,
          gate_level_only: gateNowLevelOnly,
          gate_async: gateNowAsync,
          should_open: shouldOpen,
        });
      }
    }
  }

  console.log(`\n=== 잘못 잠긴(should_open=true 인데 gate=false) 운영진: ${lockedCount}명 ===`);
  console.log(JSON.stringify(lockedSamples, null, 2));

  // 등급 분포 요약
  const dist: Record<string, number> = {};
  for (const p of rows) {
    const { data: mems } = await supabaseAdmin
      .from("user_memberships")
      .select("membership_level, team_name, is_current, updated_at")
      .eq("user_id", p.user_id);
    const lv = pickLevel(mems as MemRow[] | null) ?? "(null)";
    const key = `${p.role} | ${lv}`;
    dist[key] = (dist[key] ?? 0) + 1;
  }
  console.log("\n=== role | membership_level 분포 ===");
  console.log(JSON.stringify(dist, null, 2));
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
