// 검증: 시즌 참여자 허용목록 보강(신규) == 전수 보강 후 필터(구) 동일성 + listMembersRoster 카운트/속도.
//   npx tsx --env-file=.env.local scripts/verify-roster-allowlist-parity.ts
import { listAdminCrewDtos } from "@/lib/adminCrewData";
import { listMembersRoster } from "@/lib/adminMembersData";
import { operationalSeasonDbKey } from "@/lib/seasonCalendar";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

async function seasonParticipantIds(seasonKey: string): Promise<Set<string>> {
  const ids = new Set<string>();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabaseAdmin
      .from("user_season_statuses")
      .select("user_id")
      .eq("season_key", seasonKey)
      .order("user_id", { ascending: true })
      .range(from, from + 999);
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as Array<{ user_id: string }>;
    for (const r of rows) ids.add(r.user_id);
    if (rows.length < 1000) break;
  }
  return ids;
}

// 비교용 핵심 필드 직렬화(허용목록이 보강 결과를 바꾸지 않았는지 확인).
function key(c: {
  userId: string; displayName: string | null; organizationSlug: string | null;
  teamName: string | null; partName: string | null; membershipLevel: string | null;
  schoolName: string | null; departmentName: string | null; gender: string | null;
  birthDate: string | null; role: string | null;
}): string {
  return JSON.stringify([
    c.userId, c.displayName, c.organizationSlug, c.teamName, c.partName,
    c.membershipLevel, c.schoolName, c.departmentName, c.gender, c.birthDate, c.role,
  ]);
}

async function main() {
  const today = new Date().toISOString().slice(0, 10);
  const opKey = operationalSeasonDbKey(today)!;
  console.log("operationalSeasonKey =", opKey);

  const participants = await seasonParticipantIds(opKey);
  console.log("season participants(all orgs) =", participants.size);

  for (const org of [undefined, "encre", "oranke", "phalanx"] as const) {
    const label = org ?? "ALL";
    // 구: 전수 보강 후 참여자 필터
    const full = await listAdminCrewDtos(org, "operating");
    const oldSet = full.filter((c) => participants.has(c.userId));
    // 신: 참여자 허용목록 보강
    const neu = await listAdminCrewDtos(org, "operating", [...participants]);

    const oldMap = new Map(oldSet.map((c) => [c.userId, key(c)]));
    const newMap = new Map(neu.map((c) => [c.userId, key(c)]));

    let mismatch = 0;
    const onlyOld = [...oldMap.keys()].filter((id) => !newMap.has(id));
    const onlyNew = [...newMap.keys()].filter((id) => !oldMap.has(id));
    for (const [id, k] of oldMap) if (newMap.get(id) !== k) mismatch++;

    const ok = onlyOld.length === 0 && onlyNew.length === 0 && mismatch === 0;
    console.log(
      `  [${label}] old=${oldMap.size} new=${newMap.size} onlyOld=${onlyOld.length} onlyNew=${onlyNew.length} fieldMismatch=${mismatch} → ${ok ? "동일 ✓" : "✗ 검토"}`,
    );
    if (!ok && onlyNew.length) console.log("    onlyNew sample:", onlyNew.slice(0, 5));
    if (!ok && onlyOld.length) console.log("    onlyOld sample:", onlyOld.slice(0, 5));
  }

  // listMembersRoster 카운트 + 속도(신규 경로)
  for (let i = 0; i < 2; i++) {
    const s = Date.now();
    const r = await listMembersRoster({ organization: null, mode: "operating", page: 1, pageSize: 50 });
    console.log(
      `listMembersRoster #${i + 1}: ${Date.now() - s}ms total=${r.total} counts=${JSON.stringify(r.statusCounts)} filtered=${r.filteredTotal} rows=${r.members.length} partial=${JSON.stringify(r.partialFailure)}`,
    );
  }
}

main().then(
  () => process.exit(0),
  (e) => { console.error(e); process.exit(1); },
);
