// test_user_markers 집합 == "이름(display_name)에 T 포함" 집합 인지 실DB로 증명.
//   사용: tsx --env-file=.env.local scripts/verify-marker-vs-tname.ts
import { supabaseAdmin } from "../lib/supabaseAdmin";

type Profile = { user_id: string; display_name: string | null };

async function fetchAllProfiles(): Promise<Profile[]> {
  // PostgREST 1000행 cap → range 페이지네이션으로 전수 수집.
  const out: Profile[] = [];
  const page = 1000;
  for (let from = 0; ; from += page) {
    const { data, error } = await supabaseAdmin
      .from("user_profiles")
      .select("user_id,display_name")
      .order("user_id", { ascending: true })
      .range(from, from + page - 1);
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as Profile[];
    out.push(...rows);
    if (rows.length < page) break;
  }
  return out;
}

async function fetchMarkerIds(): Promise<string[]> {
  const out: string[] = [];
  const page = 1000;
  for (let from = 0; ; from += page) {
    const { data, error } = await supabaseAdmin
      .from("test_user_markers")
      .select("user_id")
      .order("user_id", { ascending: true })
      .range(from, from + page - 1);
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as { user_id: string }[];
    out.push(...rows.map((r) => r.user_id));
    if (rows.length < page) break;
  }
  return out;
}

function hasUpperT(name: string | null): boolean {
  return (name ?? "").includes("T");
}
function hasAnyT(name: string | null): boolean {
  return (name ?? "").toLowerCase().includes("t");
}

async function main() {
  const [profiles, markerIds] = await Promise.all([
    fetchAllProfiles(),
    fetchMarkerIds(),
  ]);

  const nameById = new Map<string, string | null>();
  for (const p of profiles) nameById.set(p.user_id, p.display_name);

  const markerSet = new Set(markerIds);

  // 두 가지 해석으로 동시에 비교: (a) 대문자 'T' 정확 포함, (b) 대소문자 무시 't' 포함(레거시 ILIKE %T%).
  for (const mode of ["uppercase-T", "case-insensitive-t"] as const) {
    const test = mode === "uppercase-T" ? hasUpperT : hasAnyT;
    const tNameIds = new Set(
      profiles.filter((p) => test(p.display_name)).map((p) => p.user_id),
    );

    const markersWithoutT = markerIds.filter((id) => !test(nameById.get(id) ?? null));
    const tNamesNotMarked = Array.from(tNameIds).filter((id) => !markerSet.has(id));

    const same = markersWithoutT.length === 0 && tNamesNotMarked.length === 0;

    console.log("\n==================================================");
    console.log(`[해석=${mode}]  markers=${markerIds.length}  T이름=${tNameIds.size}`);
    console.log(
      `RESULT: ${same ? "동일(diff=0)" : "동일하지 않음"}  ` +
        `| marker인데_T없음=${markersWithoutT.length}  | T이름인데_marker없음=${tNamesNotMarked.length}`,
    );

    if (markersWithoutT.length > 0) {
      console.log(`\n  ▼ test_user_markers 등록 but 이름에 T 없음 (${markersWithoutT.length}):`);
      for (const id of markersWithoutT) {
        console.log(`    ${id}  ::  "${nameById.get(id) ?? "(이름없음/프로필없음)"}"`);
      }
    }
    if (tNamesNotMarked.length > 0) {
      console.log(`\n  ▼ 이름에 T 포함 but test_user_markers 미등록 (${tNamesNotMarked.length}):`);
      for (const id of tNamesNotMarked) {
        console.log(`    ${id}  ::  "${nameById.get(id) ?? ""}"`);
      }
    }
  }

  // 마커인데 user_profiles 자체가 없는 경우(이름 조회 불가) 별도 표기.
  const markersNoProfile = markerIds.filter((id) => !nameById.has(id));
  if (markersNoProfile.length > 0) {
    console.log(`\n  ⚠ marker이지만 user_profiles 행 없음 (${markersNoProfile.length}):`);
    for (const id of markersNoProfile) console.log(`    ${id}`);
  }
  console.log(`\n총 user_profiles=${profiles.length}, 총 markers=${markerIds.length}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
