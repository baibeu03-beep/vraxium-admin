// 진단(READ-ONLY) — 테스트 유저 팀/파트/역할 현재 배정 현황.
//   npx tsx --env-file=.env.local scripts/diag-test-users-assignment.ts
// DB write 없음. test_user_markers ⨝ user_profiles(role/org) ⨝ user_memberships(현재행) 만 조회.

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { memberStatusLabel } from "@/lib/adminMembersTypes";

type Row = {
  userId: string;
  name: string;
  org: string;
  team: string;
  part: string;
  role: string | null;
  level: string | null;
  state: string | null;
  label: string; // memberStatusLabel
  bucket: "team_leader" | "part_leader" | "agent" | "crew" | "기타";
};

const ORG_ORDER = ["oranke", "encre", "phalanx"];

function roleBucket(role: string | null, label: string): Row["bucket"] {
  if (role === "team_leader" || label === "팀장") return "team_leader";
  if (label === "심화(파트장)") return "part_leader";
  if (label === "심화(에이전트)") return "agent";
  if (label === "일반" || label === "크루") return "crew";
  return "기타";
}

async function main() {
  // 1) test markers.
  const { data: markers } = await supabaseAdmin
    .from("test_user_markers")
    .select("user_id");
  const ids = ((markers ?? []) as Array<{ user_id: string }>).map((m) => m.user_id);
  console.log(`test_user_markers 총 ${ids.length}명\n`);

  // 2) profiles.
  const { data: profs } = await supabaseAdmin
    .from("user_profiles")
    .select("user_id,display_name,role,organization_slug")
    .in("user_id", ids);
  const profById = new Map(
    ((profs ?? []) as Array<{
      user_id: string;
      display_name: string | null;
      role: string | null;
      organization_slug: string | null;
    }>).map((p) => [p.user_id, p]),
  );

  // 3) memberships (현재행 우선).
  const { data: mems } = await supabaseAdmin
    .from("user_memberships")
    .select("user_id,team_name,part_name,membership_level,membership_state,is_current,updated_at")
    .in("user_id", ids);
  type Mem = {
    user_id: string;
    team_name: string | null;
    part_name: string | null;
    membership_level: string | null;
    membership_state: string | null;
    is_current: boolean | null;
    updated_at: string | null;
  };
  const memByUser = new Map<string, Mem>();
  for (const m of (mems ?? []) as Mem[]) {
    const e = memByUser.get(m.user_id);
    if (
      !e ||
      (m.is_current && !e.is_current) ||
      (m.is_current === e.is_current && (m.updated_at ?? "") > (e.updated_at ?? ""))
    )
      memByUser.set(m.user_id, m);
  }

  const rows: Row[] = [];
  for (const id of ids) {
    const p = profById.get(id);
    const m = memByUser.get(id);
    const label = memberStatusLabel(p?.role ?? null, m?.membership_level ?? null);
    rows.push({
      userId: id,
      name: (p?.display_name ?? "").trim() || id,
      org: p?.organization_slug ?? "(없음)",
      team: (m?.team_name ?? "").trim() || "(미배정)",
      part: (m?.part_name ?? "").trim() || "(미배정)",
      role: p?.role ?? null,
      level: m?.membership_level ?? null,
      state: m?.membership_state ?? null,
      label,
      bucket: roleBucket(p?.role ?? null, label),
    });
  }

  const orgs = [
    ...ORG_ORDER.filter((o) => rows.some((r) => r.org === o)),
    ...[...new Set(rows.map((r) => r.org))].filter((o) => !ORG_ORDER.includes(o)).sort(),
  ];

  // ── 트리: org → team → part → user ──
  console.log("═══════════════════════════════════════");
  console.log("  배정 트리 (org → 팀 → 파트 → 유저)");
  console.log("═══════════════════════════════════════\n");
  for (const org of orgs) {
    console.log(org);
    const orgRows = rows.filter((r) => r.org === org);
    const teams = [...new Set(orgRows.map((r) => r.team))].sort((a, b) =>
      a.localeCompare(b, "ko"),
    );
    for (const team of teams) {
      const teamRows = orgRows.filter((r) => r.team === team);
      console.log(`- ${team} (${teamRows.length}명)`);
      const parts = [...new Set(teamRows.map((r) => r.part))].sort((a, b) =>
        a.localeCompare(b, "ko"),
      );
      for (const part of parts) {
        const partRows = teamRows.filter((r) => r.part === part);
        console.log(`  - ${part} (${partRows.length}명)`);
        for (const r of partRows.sort((a, b) => a.name.localeCompare(b.name, "ko"))) {
          const tag =
            r.bucket === "team_leader"
              ? " [팀장]"
              : r.bucket === "part_leader"
                ? " [파트장]"
                : r.bucket === "agent"
                  ? " [에이전트]"
                  : r.bucket === "기타"
                    ? ` [${r.label}]`
                    : "";
          console.log(`    - ${r.name}${tag}`);
        }
      }
    }
    console.log("");
  }

  // ── 1. 팀별 인원 수 ──
  console.log("═══════════════════════════════════════");
  console.log("  1. 팀별 인원 수");
  console.log("═══════════════════════════════════════");
  for (const org of orgs) {
    const orgRows = rows.filter((r) => r.org === org);
    console.log(`\n[${org}] 소계 ${orgRows.length}명`);
    const teams = [...new Set(orgRows.map((r) => r.team))].sort((a, b) => a.localeCompare(b, "ko"));
    for (const team of teams) {
      console.log(`  ${team.padEnd(16)} ${orgRows.filter((r) => r.team === team).length}명`);
    }
  }

  // ── 2. 파트별 인원 수 ──
  console.log("\n═══════════════════════════════════════");
  console.log("  2. 파트별 인원 수 (org · 팀 · 파트)");
  console.log("═══════════════════════════════════════");
  for (const org of orgs) {
    const orgRows = rows.filter((r) => r.org === org);
    const teams = [...new Set(orgRows.map((r) => r.team))].sort((a, b) => a.localeCompare(b, "ko"));
    console.log(`\n[${org}]`);
    for (const team of teams) {
      const teamRows = orgRows.filter((r) => r.team === team);
      const parts = [...new Set(teamRows.map((r) => r.part))].sort((a, b) => a.localeCompare(b, "ko"));
      for (const part of parts) {
        console.log(
          `  ${team} / ${part.padEnd(12)} ${teamRows.filter((r) => r.part === part).length}명`,
        );
      }
    }
  }

  // ── 3~6. 역할별 목록 ──
  const printBucket = (title: string, bucket: Row["bucket"]) => {
    console.log("\n═══════════════════════════════════════");
    console.log(`  ${title}`);
    console.log("═══════════════════════════════════════");
    const list = rows
      .filter((r) => r.bucket === bucket)
      .sort(
        (a, b) =>
          orgs.indexOf(a.org) - orgs.indexOf(b.org) ||
          a.team.localeCompare(b.team, "ko") ||
          a.part.localeCompare(b.part, "ko") ||
          a.name.localeCompare(b.name, "ko"),
      );
    console.log(`총 ${list.length}명`);
    for (const r of list) {
      console.log(`  ${r.org.padEnd(8)} ${r.team.padEnd(14)} ${r.part.padEnd(12)} ${r.name}`);
    }
  };
  printBucket("3. team_leader 목록", "team_leader");
  printBucket("4. part_leader 목록", "part_leader");
  printBucket("5. agent 목록", "agent");
  printBucket("6. crew 목록", "crew");

  // 기타(등급 미상/미배정) 가 있으면 별도 표기.
  const others = rows.filter((r) => r.bucket === "기타");
  if (others.length > 0) {
    console.log("\n— 기타(등급 미상/역할 외) —");
    for (const r of others)
      console.log(`  ${r.org} ${r.team} ${r.part} ${r.name} (role=${r.role} level=${r.level} label=${r.label})`);
  }

  // 합계 요약.
  console.log("\n── 합계 ──");
  const tl = rows.filter((r) => r.bucket === "team_leader").length;
  const pl = rows.filter((r) => r.bucket === "part_leader").length;
  const ag = rows.filter((r) => r.bucket === "agent").length;
  const cr = rows.filter((r) => r.bucket === "crew").length;
  console.log(
    `team_leader ${tl} · part_leader ${pl} · agent ${ag} · crew ${cr} · 기타 ${others.length} = ${rows.length}`,
  );
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
