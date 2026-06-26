/**
 * 진단 전용(read-only): '전현성'(oranke 기대) 재확인 — 미이관/오타/타org/표기명 구분.
 *   npx tsx --env-file=.env.local scripts/diag-jeonhyeonseong.ts
 */
import { createClient } from "@supabase/supabase-js";
import mysql from "mysql2/promise";
import { readFileSync } from "fs";

const rawEnv = readFileSync(".env.local", "utf8");
const envGet = (k: string) => rawEnv.match(new RegExp(`^${k}=(.+)$`, "m"))?.[1]?.trim();
const sb = createClient(envGet("NEXT_PUBLIC_SUPABASE_URL")!, envGet("SUPABASE_SERVICE_ROLE_KEY")!);
const line = (s = "") => console.log(s);
const hr = () => line("─".repeat(70));

async function main() {
  hr(); line("Supabase user_profiles 탐색"); hr();
  // 정확/부분 일치
  for (const [label, q] of [
    ["display_name = '전현성'", sb.from("user_profiles").select("user_id,display_name,organization_slug,status,growth_status").eq("display_name", "전현성")],
    ["display_name ilike '%전현성%'", sb.from("user_profiles").select("user_id,display_name,organization_slug,status").ilike("display_name", "%전현성%")],
    ["display_name ilike '전현%'", sb.from("user_profiles").select("user_id,display_name,organization_slug,status").ilike("display_name", "전현%")],
    ["display_name ilike '%현성'", sb.from("user_profiles").select("user_id,display_name,organization_slug,status").ilike("display_name", "%현성")],
  ] as const) {
    const { data } = await q;
    line(`  [${label}] ${(data ?? []).length}건`);
    for (const p of (data ?? []) as any[]) line(`    - ${p.display_name} (${p.organization_slug}) ${p.user_id} status=${p.status}${p.growth_status ? ` growth=${p.growth_status}` : ""}`);
  }

  hr(); line("legacy_pms_restuser_archive 탐색 (이관 대기/스킵 포함)"); hr();
  const { data: arch } = await sb.from("legacy_pms_restuser_archive")
    .select("id,name,organization_slug,source_system,legacy_user_id,promotion_status,promoted_user_id").ilike("name", "%전현성%");
  line(`  archive name ilike '%전현성%': ${(arch ?? []).length}건`);
  for (const a of (arch ?? []) as any[]) line(`    - ${a.name} ${a.organization_slug} src=${a.source_system}/${a.legacy_user_id} status=${a.promotion_status} promoted=${a.promoted_user_id ?? "-"}`);

  hr(); line("PMS MySQL 원본(oranke/hrdb/olympus) users.Name 탐색"); hr();
  try {
    const conn = await mysql.createConnection({
      host: envGet("MYSQL_HOST"), port: Number(envGet("MYSQL_PORT") ?? 3306),
      user: envGet("MYSQL_USER"), password: envGet("MYSQL_PASSWORD"),
      dateStrings: true, ssl: { rejectUnauthorized: false },
    });
    for (const db of ["oranke", "hrdb", "olympus"]) {
      try {
        const [rows] = (await conn.query(
          `SELECT u.UserId, u.Name, i.Team, i.Part, i.State FROM ${db}.users u
           LEFT JOIN ${db}.usersinfo i ON i.UserID=u.UserId
           WHERE u.Name LIKE ? OR u.Name LIKE ?`, ["%전현성%", "%현성%"])) as any;
        line(`  [${db}] '전현성'/'현성' 포함: ${(rows as any[]).length}건`);
        for (const r of rows as any[]) line(`    - ${r.Name} UserId=${r.UserId} Team=${r.Team ?? "-"} Part=${r.Part ?? "-"} State=${r.State ?? "-"}`);
      } catch (e: any) {
        line(`  [${db}] 조회 실패: ${e.message}`);
      }
    }
    await conn.end();
  } catch (e: any) {
    line(`  MySQL 연결 실패: ${e.message}`);
  }
  hr(); line("DONE");
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
