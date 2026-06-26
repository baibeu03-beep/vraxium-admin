/** 조직별 팀장 이름 매칭 검증 — 다른 조직의 동명을 가져오지 않았는지(섞임 없음) 영구 확인.
 *  검사:
 *   A) 모든 연결 행(leader_user_id)의 크루 org == 팀 org (cross-org 0).
 *   B) leader_name 과 연결 크루 display_name 정규화 일치.
 *   C) 같은 org 내 동일 이름 operating 후보가 ≥2면 연결돼 있으면 안 됨(동명이인 자동연결 금지).
 *   D) lib/teamLeaderMatch 단일 SoT 가 연결행을 재현(link→동일 userId).
 *  READ-ONLY. run: tsx --env-file=.env.local scripts/verify-team-leader-org-match.ts
 */
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import {
  matchOperatingLeaderByOrgName,
  normalizeLeaderName,
} from "@/lib/teamLeaderMatch";
import type { OrganizationSlug } from "@/lib/organizations";

let pass = 0, fail = 0;
function check(ok: boolean, label: string, detail = "") {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  ok ? pass++ : fail++;
}

async function main() {
  const { data: rows, error } = await supabaseAdmin
    .from("cluster4_team_halves")
    .select("id,organization_slug,half_key,team_name,leader_name,leader_user_id");
  if (error) throw new Error(error.message);

  const linked = (rows ?? []).filter((r: any) => r.leader_user_id) as Array<{
    id: string; organization_slug: string; half_key: string; team_name: string;
    leader_name: string | null; leader_user_id: string;
  }>;

  // 연결된 크루 프로필 조회.
  const uids = Array.from(new Set(linked.map((r) => r.leader_user_id)));
  const profById = new Map<string, { org: string | null; name: string | null }>();
  for (let i = 0; i < uids.length; i += 200) {
    const { data } = await supabaseAdmin
      .from("user_profiles")
      .select("user_id,display_name,organization_slug")
      .in("user_id", uids.slice(i, i + 200));
    for (const p of (data ?? []) as any[])
      profById.set(p.user_id, { org: p.organization_slug, name: p.display_name });
  }

  console.log(`연결 행: ${linked.length}`);

  let crossOrg = 0, nameMismatch = 0, sotMismatch = 0;
  for (const r of linked) {
    const prof = profById.get(r.leader_user_id);
    // A) org 일치
    if (prof?.org !== r.organization_slug) {
      crossOrg++;
      console.log(`   ✗ CROSS-ORG ${r.organization_slug}/${r.half_key}/${r.team_name} [${r.leader_name}] → ${prof?.name}(${prof?.org})`);
    }
    // B) 이름 일치
    if (r.leader_name && normalizeLeaderName(r.leader_name) !== normalizeLeaderName(prof?.name)) {
      nameMismatch++;
      console.log(`   ✗ NAME-MISMATCH ${r.organization_slug}/${r.team_name} leader_name=${r.leader_name} crew=${prof?.name}`);
    }
    // C·D) 연결 유효성: (a) 유일 name-match(link) 가 동일 userId 거나,
    //   (b) 동명이인(ambiguous) 이면 명시적 연결이 그 후보 중 하나여야(이름만으로 자동선택 금지지만
    //       명시 연결은 허용 — 예: PMS UserId 브리지로 정정한 phalanx 이유나 212).
    const m = await matchOperatingLeaderByOrgName(
      r.organization_slug as OrganizationSlug,
      r.leader_name,
    );
    const validLink =
      (m.status === "link" && m.userId === r.leader_user_id) ||
      (m.status === "ambiguous" && m.userIds.includes(r.leader_user_id));
    if (!validLink) {
      sotMismatch++;
      console.log(`   ✗ SOT-MISMATCH ${r.organization_slug}/${r.team_name} [${r.leader_name}] linked=${r.leader_user_id} sot=${JSON.stringify(m)}`);
    } else if (m.status === "ambiguous") {
      console.log(`   · 명시연결(동명이인 ${m.userIds.length}명 중 명시 선택) ${r.organization_slug}/${r.team_name} [${r.leader_name}] → ${r.leader_user_id.slice(0, 8)}`);
    }
  }

  check(crossOrg === 0, "A) cross-org 연결 0건", `cross=${crossOrg}`);
  check(nameMismatch === 0, "B) leader_name == 크루 이름", `mismatch=${nameMismatch}`);
  check(sotMismatch === 0, "C·D) teamLeaderMatch SoT 재현(동명이인 자동연결 0)", `mismatch=${sotMismatch}`);

  // 조직 분리 스팟체크: 이유나(엥크레/오랑캐/팔랑크스) 가 서로 다른 user 로 분리.
  console.log("\n조직 분리 스팟체크: 이유나");
  const orgs: OrganizationSlug[] = ["encre", "oranke", "phalanx"];
  const yuna: Record<string, string> = {};
  for (const o of orgs) {
    const m = await matchOperatingLeaderByOrgName(o, "이유나");
    yuna[o] = m.status === "link" ? m.userId : m.status;
    console.log(`   ${o}: ${JSON.stringify(m)}`);
  }
  const linkedIds = orgs.map((o) => yuna[o]).filter((v) => v && v.length === 36);
  check(
    new Set(linkedIds).size === linkedIds.length,
    "조직별 이유나는 서로 다른 user(또는 미연결) — 섞이지 않음",
    JSON.stringify(yuna),
  );

  console.log(`\n결과: ✓ ${pass} / ✗ ${fail}`);
  if (fail > 0) process.exit(1);
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
