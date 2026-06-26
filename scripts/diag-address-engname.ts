/**
 * READ-ONLY 진단: 거주지(address) / 영문명(english_name) 누락 원인 규명.
 *   npx tsx --env-file=.env.local scripts/diag-address-engname.ts
 *
 * 1) Vraxium user_profiles: source_system 별 address/english_name 채움률
 * 2) eng_name 레거시 컬럼 실재 여부
 * 3) PMS MySQL: 이관된 legacy_user_id 들의 users.Address 보유율 (백필 가능성)
 * write 0.
 */
import { createClient } from "@supabase/supabase-js";
import mysql from "mysql2/promise";

const env = process.env as Record<string, string>;
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { persistSession: false },
});

async function fetchAll<T>(table: string, select: string, orderCol: string): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from(table).select(select).order(orderCol, { ascending: true }).range(from, from + 999);
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...((data ?? []) as T[]));
    if ((data ?? []).length < 1000) break;
  }
  return out;
}

const blank = (v: unknown) => v == null || String(v).trim() === "" || String(v).trim() === "-";

async function main() {
  // ── 0) eng_name 컬럼 실재 여부 ──
  const engCol = await sb.from("user_profiles").select("user_id, eng_name").limit(1);
  console.log("\n[0] eng_name 컬럼 존재?:", engCol.error ? `NO (${engCol.error.message})` : "YES");

  // ── 1) users(브리지) + user_profiles 조인 ──
  type U = { id: string; legacy_user_id: number | null; source_system: string | null };
  const users = await fetchAll<U>("users", "id,legacy_user_id,source_system", "id");
  const usersById = new Map(users.map((u) => [u.id, u]));

  type P = { user_id: string; display_name: string | null; address: string | null; english_name: string | null; organization_slug: string | null };
  const profiles = await fetchAll<P>("user_profiles", "user_id,display_name,address,english_name,organization_slug", "user_id");

  // source_system 별 집계
  const bySrc = new Map<string, { total: number; addrFilled: number; engFilled: number }>();
  const addrSamples: string[] = [];
  for (const p of profiles) {
    const src = usersById.get(p.user_id)?.source_system ?? "(no users row / native)";
    let g = bySrc.get(src);
    if (!g) { g = { total: 0, addrFilled: 0, engFilled: 0 }; bySrc.set(src, g); }
    g.total++;
    if (!blank(p.address)) { g.addrFilled++; if (addrSamples.length < 8) addrSamples.push(`${p.display_name}: "${p.address}"`); }
    if (!blank(p.english_name)) g.engFilled++;
  }

  console.log("\n[1] user_profiles — source_system 별 채움률");
  console.log("    source_system            total  addrFilled  engFilled");
  for (const [src, g] of [...bySrc.entries()].sort((a, b) => b[1].total - a[1].total)) {
    console.log(`    ${src.padEnd(24)} ${String(g.total).padStart(5)}  ${String(g.addrFilled).padStart(10)}  ${String(g.engFilled).padStart(9)}`);
  }
  console.log("\n    address 비어있지 않은 샘플:");
  for (const s of addrSamples) console.log("      ", s);
  console.log(`    (총 프로필 ${profiles.length}, address 채움 ${profiles.filter((p) => !blank(p.address)).length}, english_name 채움 ${profiles.filter((p) => !blank(p.english_name)).length})`);

  // ── 2) PMS MySQL — 이관된 legacy_user_id 들의 Address 보유율 ──
  const conn = await mysql.createConnection({
    host: env.MYSQL_HOST, port: Number(env.MYSQL_PORT ?? 3306),
    user: env.MYSQL_USER, password: env.MYSQL_PASSWORD,
    dateStrings: true, ssl: { rejectUnauthorized: false },
  });

  // PMS users 테이블 스키마: Address / 영문명 컬럼 실재 확인
  console.log("\n[2] PMS users 테이블 컬럼 (Address / 영문 관련):");
  for (const src of ["oranke", "hrdb", "olympus"]) {
    try {
      const [cols] = (await conn.query(`SHOW COLUMNS FROM ${src}.users`)) as [Array<{ Field: string }>, unknown];
      const names = cols.map((c) => c.Field);
      const addrCols = names.filter((n) => /addr|거주|주소/i.test(n));
      const engCols = names.filter((n) => /eng|영문|english/i.test(n));
      console.log(`    ${src}.users: addr=[${addrCols.join(",")}] eng=[${engCols.join(",")}] (전체 ${names.length}컬럼)`);
    } catch (e) {
      console.log(`    ${src}.users: ERR ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // 이관된 사용자별로 PMS Address 보유 여부 점검
  console.log("\n[3] 이관 사용자 PMS Address 보유율 (source_system 별):");
  const migrated = users.filter((u) => u.source_system && u.legacy_user_id != null);
  const srcGroups = new Map<string, number[]>();
  for (const u of migrated) {
    const arr = srcGroups.get(u.source_system!) ?? [];
    arr.push(u.legacy_user_id!);
    srcGroups.set(u.source_system!, arr);
  }
  for (const [src, ids] of srcGroups) {
    try {
      const [rows] = (await conn.query(
        `SELECT UserId, Address FROM ${src}.users WHERE UserId IN (${ids.join(",")})`,
      )) as [Array<{ UserId: number; Address: string | null }>, unknown];
      const withAddr = rows.filter((r) => !blank(r.Address));
      console.log(`    ${src}: 이관 ${ids.length}명 / PMS행 ${rows.length} / Address 보유 ${withAddr.length}`);
      for (const r of withAddr.slice(0, 5)) console.log(`        UserId=${r.UserId} Address="${r.Address}"`);
    } catch (e) {
      console.log(`    ${src}: ERR ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  await conn.end();
  console.log("\n진단 완료 (write 0).");
}

main().catch((e) => { console.error(e); process.exit(1); });
