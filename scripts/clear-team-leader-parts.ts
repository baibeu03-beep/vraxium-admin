/**
 * 팀장 파트 비우기 마이그레이션 — 정책: 팀장(role=team_leader)은 파트 배정이 없는 것이 정상.
 *   미리보기:  npx tsx --env-file=.env.local scripts/clear-team-leader-parts.ts
 *   실제 적용:  npx tsx --env-file=.env.local scripts/clear-team-leader-parts.ts --apply
 *
 * 동작:
 *   - 대상 = role='team_leader' 전원(운영+테스트). is_current=true user_memberships.part_name 을 NULL 로.
 *   - user_profiles.current_part_name 은 user_memberships 동기화 트리거(sync_user_profile_current_membership)가
 *     자동 반영(SoT=user_memberships). team_name 은 그대로 유지(팀 배정 O).
 *   - 적용 전 전체 백업(claudedocs/clear-team-leader-parts-backup-*.json) — 롤백용.
 *   - 적용 후 영향 user 의 cluster4 weekly-cards snapshot 무효화(invalidateWeeklyCardsForUsers).
 *
 * 안전: part-유니크 인덱스(agent/part_leader)는 team_leader 와 무관 → 충돌 없음. team_name 무변경 →
 *   team-유니크 인덱스 무영향.
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { invalidateWeeklyCardsForUsers } from "@/lib/cluster4WeeklyCardsSnapshot";

const env = readFileSync(resolve(process.cwd(), ".env.local"), "utf8");
const get = (k: string) => env.match(new RegExp(`^${k}=(.+)$`, "m"))?.[1]?.trim() ?? "";
const sb = createClient(get("NEXT_PUBLIC_SUPABASE_URL"), get("SUPABASE_SERVICE_ROLE_KEY"), {
  auth: { persistSession: false },
});
const APPLY = process.argv.includes("--apply");

type Prof = {
  user_id: string;
  display_name: string | null;
  organization_slug: string | null;
  current_team_name: string | null;
  current_part_name: string | null;
};
type Mem = {
  id: string;
  user_id: string;
  team_name: string | null;
  part_name: string | null;
  is_current: boolean | null;
};

async function main() {
  // 대상 팀장 + 멤버십 행.
  const profs =
    ((
      await sb
        .from("user_profiles")
        .select("user_id,display_name,organization_slug,current_team_name,current_part_name")
        .eq("role", "team_leader")
    ).data ?? []) as Prof[];
  const ids = profs.map((p) => p.user_id);
  const mems =
    ((await sb.from("user_memberships").select("id,user_id,team_name,part_name,is_current").in("user_id", ids)).data ??
      []) as Mem[];

  // 비울 대상 = is_current=true 이고 part_name 이 비어있지 않은 행.
  const targets = mems.filter((m) => m.is_current === true && m.part_name != null && m.part_name.trim() !== "");

  console.log(`팀장 ${profs.length}명 / is_current 멤버십 ${mems.filter((m) => m.is_current).length}행`);
  console.log(`파트 비우기 대상 멤버십 행: ${targets.length}\n`);
  for (const p of profs) {
    const m = mems.find((x) => x.user_id === p.user_id && x.is_current);
    const willClear = targets.some((t) => t.user_id === p.user_id);
    console.log(
      `  ${willClear ? "→ CLEAR" : "  skip "} ${p.display_name} (${p.organization_slug}) 팀=${p.current_team_name} 파트(mem)=${m?.part_name ?? "null"} 파트(prof)=${p.current_part_name ?? "null"}`,
    );
  }

  if (!APPLY) {
    console.log(`\n[DRY-RUN] --apply 를 붙이면 실제 적용. (백업+무효화 포함)`);
    process.exit(0);
  }

  // ── 백업 ────────────────────────────────────────────────────────────────
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = resolve(process.cwd(), `claudedocs/clear-team-leader-parts-backup-${stamp}.json`);
  writeFileSync(
    backupPath,
    JSON.stringify({ generatedAt: new Date().toISOString(), profiles: profs, memberships: mems }, null, 2),
    "utf8",
  );
  console.log(`\n백업 저장: ${backupPath}`);

  // ── 적용: user_memberships.part_name = NULL (is_current). 트리거가 profile 동기화. ──
  let cleared = 0;
  for (const t of targets) {
    const { error } = await sb
      .from("user_memberships")
      .update({ part_name: null })
      .eq("id", t.id);
    if (error) {
      console.error(`  ✗ ${t.user_id} 실패: ${error.message}`);
    } else {
      cleared++;
    }
  }
  console.log(`멤버십 part_name NULL 적용: ${cleared}/${targets.length}`);

  // ── 검증: profile.current_part_name 트리거 동기화 확인 ────────────────────
  const after =
    ((
      await sb
        .from("user_profiles")
        .select("user_id,display_name,current_team_name,current_part_name")
        .eq("role", "team_leader")
    ).data ?? []) as Prof[];
  const stillHasPart = after.filter((p) => p.current_part_name != null && p.current_part_name.trim() !== "");
  console.log(`\n검증 — 팀장 ${after.length}명 중 파트 남은 수: ${stillHasPart.length}`);
  for (const p of stillHasPart) console.log(`  ⚠ ${p.display_name} 파트=${p.current_part_name}`);
  const teamLost = after.filter((p) => !p.current_team_name);
  console.log(`검증 — 팀 사라진 팀장: ${teamLost.length}(0 이어야 함)`);

  // ── snapshot 무효화(영향 user = 팀장 전원) ───────────────────────────────
  const inv = await invalidateWeeklyCardsForUsers(ids);
  console.log(`\nsnapshot 무효화: mode=${inv.mode} count=${inv.count}`);

  console.log(`\n완료. 롤백 필요 시 백업 JSON 의 memberships.part_name 으로 복원.`);
  process.exit(stillHasPart.length > 0 || teamLost.length > 0 ? 1 : 0);
}
main().catch((e) => {
  console.error("ERROR:", e?.stack ?? e?.message ?? e);
  process.exit(1);
});
