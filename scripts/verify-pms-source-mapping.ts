/**
 * source system → organization_slug 매핑 검증 (read-only).
 *
 *   npx tsx --env-file=.env.local scripts/verify-pms-source-mapping.ts
 *
 * 1) 확정 매핑 3건 + 미등록 소스 fail-closed
 * 2) 복합 identity (B안 2026-06-07): legacyIdentityFor 원본 보존 페어 + offset 방식 deprecated throw
 * 3) 1092 장승완 기대 매핑: org='oranke' · team_name='F&B' · part_name='일반' (PMS 실측 대조)
 * 4) Vraxium cluster4_teams 에 oranke/'F&B' 존재 (membership 안착 가능)
 * 5) 복합키 점유 검증 — (source_system, legacy_user_id) 페어 단위. NULL-source 숫자 겹침은
 *    충돌 아님(정보성): 248~303 28명=olympus 동일인 유지 · 304~309 6명=stub
 */
import { readFileSync } from "fs";
import mysql from "mysql2/promise";
import { createClient } from "@supabase/supabase-js";
import {
  ledgerSourceTable,
  legacyIdentityFor,
  legacyUserIdFor,
  mapUsersinfoTeamPart,
  resolveOrganizationSlug,
} from "@/lib/pmsMigration";

const rawEnv = readFileSync(".env.local", "utf8");
const envGet = (k: string) => rawEnv.match(new RegExp(`^${k}=(.+)$`, "m"))?.[1]?.trim();
const sb = createClient(envGet("NEXT_PUBLIC_SUPABASE_URL")!, envGet("SUPABASE_SERVICE_ROLE_KEY")!);

let pass = 0,
  fail = 0;
const check = (name: string, ok: boolean, detail?: string) => {
  console.log(`  ${ok ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`);
  ok ? pass++ : fail++;
};
const throws = (fn: () => unknown) => {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
};

async function main() {
  console.log("══ ① 확정 매핑 + fail-closed ══");
  check("hrdb → encre", resolveOrganizationSlug("hrdb") === "encre");
  check("oranke → oranke", resolveOrganizationSlug("oranke") === "oranke");
  check("olympus → phalanx", resolveOrganizationSlug("olympus") === "phalanx");
  check("미등록 소스 throw (fail-closed)", throws(() => resolveOrganizationSlug("unknown-src")));

  console.log("══ ② 복합 identity (2026-06-07 B안 composite key) ══");
  check("ledger source_table 프리픽스", ledgerSourceTable("oranke", "pointlogs") === "oranke.pointlogs");
  const id1092 = legacyIdentityFor("oranke", 1092);
  check(
    "oranke 1092 → (oranke, 1092) — 원본 보존",
    id1092.sourceSystem === "oranke" && id1092.legacyUserId === 1092,
  );
  const idH = legacyIdentityFor("hrdb", 248);
  const idO = legacyIdentityFor("olympus", 248);
  check(
    "같은 숫자 248 — (hrdb,248)·(olympus,248) 페어로 구분 (offset 가산 없음)",
    idH.sourceSystem === "hrdb" && idH.legacyUserId === 248 &&
      idO.sourceSystem === "olympus" && idO.legacyUserId === 248,
  );
  check("hrdb 소스 max 1712 → 1712 원본 보존", legacyIdentityFor("hrdb", 1712).legacyUserId === 1712);
  check("olympus 소스 max 303 → 303 원본 보존", legacyIdentityFor("olympus", 303).legacyUserId === 303);
  check("synthetic 범위(≥1억) pmsUserId throw", throws(() => legacyIdentityFor("oranke", 100_000_000)));
  check(
    "음수/0/비정수 pmsUserId throw",
    throws(() => legacyIdentityFor("hrdb", -1)) &&
      throws(() => legacyIdentityFor("hrdb", 0)) &&
      throws(() => legacyIdentityFor("hrdb", 1.5)),
  );
  check(
    "legacyUserIdFor(offset 방식) = deprecated throw",
    throws(() => legacyUserIdFor("oranke", 1092)),
  );

  console.log("══ ③ 1092 기대 매핑 (PMS 실측) ══");
  const conn = await mysql.createConnection({
    host: envGet("MYSQL_HOST"),
    port: Number(envGet("MYSQL_PORT") ?? 3306),
    user: envGet("MYSQL_USER"),
    password: envGet("MYSQL_PASSWORD"),
    database: envGet("MYSQL_DATABASE"),
    dateStrings: true,
    ssl: { rejectUnauthorized: false },
  });
  const [[info]] = (await conn.query(
    "SELECT Team, Part, Level, State FROM usersinfo WHERE UserID = 1092",
  )) as [Array<{ Team: string | null; Part: string | null; Level: string | null; State: string | null }>, unknown];
  const tp = mapUsersinfoTeamPart(info);
  check(
    "1092: org='oranke' · team_name='F&B' · part_name='일반'",
    resolveOrganizationSlug("oranke") === "oranke" && tp.teamName === "F&B" && tp.partName === "일반",
    `실측 Team='${info.Team}' Part='${info.Part}' Level='${info.Level}' State='${info.State}'`,
  );
  check("매핑 결과에 org 필드 없음 (Team→org 파생 타입 차단)", !("organizationSlug" in tp));

  console.log("══ ④ Vraxium 팀 사전 안착 ══");
  const { data: team } = await sb
    .from("cluster4_teams")
    .select("team_name,organization_slug,is_active")
    .eq("organization_slug", "oranke")
    .eq("team_name", "F&B");
  check("cluster4_teams oranke/'F&B' 존재·active", !!team?.length && team[0].is_active === true);

  console.log("══ ⑤ 복합키 점유 — (source_system, legacy_user_id) 단위 ══");
  // B안 (2026-06-07): 충돌 = "같은 (source_system, legacy_user_id) 페어 점유"만.
  // NULL-source 행과의 숫자 겹침은 충돌이 아니다 (uq_users_source_legacy 범위 밖) — 정보성.
  for (const src of ["oranke", "hrdb", "olympus"] as const) {
    const [[r]] = (await conn.query(
      `SELECT MIN(UserId) AS lo, MAX(UserId) AS hi, COUNT(*) AS n FROM ${src}.users`,
    )) as [Array<{ lo: number; hi: number; n: number }>, unknown];
    // 이관 전: 그 소스로 기록된 행 자체가 0 이어야 함 (= 페어 점유 0)
    const { count: sourcedCount, error: srcErr } = await sb
      .from("users")
      .select("id", { count: "exact", head: true })
      .eq("source_system", src);
    check(
      `${src}: (${src}, UserId ${r.lo}~${r.hi}) 페어 점유 0 — 이관 전 기대`,
      !srcErr && (sourcedCount ?? 0) === 0,
      srcErr ? srcErr.message : `소스 ${r.n}명 · source_system='${src}' 행 ${sourcedCount}건`,
    );
  }
  // 정보성: NULL-source 행의 숫자 겹침 분해 (비차단 — 복합키 체계의 핵심 개선점)
  {
    const { data: nullSourceRows } = await sb
      .from("users")
      .select("id,legacy_user_id,source_system")
      .is("source_system", null)
      .not("legacy_user_id", "is", null)
      .order("legacy_user_id", { ascending: true })
      .range(0, 1999);
    const rows = (nullSourceRows ?? []) as Array<{ id: string; legacy_user_id: number }>;
    const bridge = rows.filter((u) => u.legacy_user_id >= 248 && u.legacy_user_id <= 309);
    const olympusSame = bridge.filter((u) => u.legacy_user_id <= 303); // 28명 olympus 동일인 (census 06-07)
    const stubs = bridge.filter((u) => u.legacy_user_id >= 304); // 6명 stub (PMS 비존재)
    check(
      "NULL-source 248~309 = 34 (28 olympus 동일인 유지 + 6 stub) — 비차단 정보성",
      bridge.length === 34 && olympusSame.length === 28 && stubs.length === 6,
      `bridge=${bridge.length} olympus동일인=${olympusSame.length} stub=${stubs.length} — olympus 이관 시 3중 키 매칭으로 source_system='olympus' 최초 기록 계약`,
    );
    const { data: markers } = await sb.from("test_user_markers").select("user_id").limit(1000);
    const markerSet = new Set(((markers ?? []) as Array<{ user_id: string }>).map((m) => m.user_id));
    const testers = rows.filter((u) => markerSet.has(u.id));
    check(
      "테스터 합성 id — 전원 NULL-source (uq_users_legacy_no_source 보호)",
      testers.every((t) => t.legacy_user_id >= 900031 || t.legacy_user_id >= 100_000_000),
      `테스터 legacy 보유 ${testers.length}명`,
    );
  }

  await conn.end();
  console.log(`\n결과: ✅ ${pass} / ❌ ${fail}`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
