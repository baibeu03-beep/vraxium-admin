/**
 * 진단(read-only): 보류 3명 + 강원대 김준우 신원 확인 (fail-closed 매칭 근거 수집).
 *   npx tsx --env-file=.env.local scripts/diag-held3-identity.ts
 */
import { createClient } from "@supabase/supabase-js";
import mysql from "mysql2/promise";
import { readFileSync } from "fs";
const env = readFileSync(".env.local", "utf8");
const g = (k: string) => env.match(new RegExp(`^${k}=(.+)$`, "m"))?.[1]?.trim();
const sb = createClient(g("NEXT_PUBLIC_SUPABASE_URL")!, g("SUPABASE_SERVICE_ROLE_KEY")!);
const line = (s = "") => console.log(s);
const hr = () => line("─".repeat(74));

async function main() {
  const conn = await mysql.createConnection({ host: g("MYSQL_HOST"), port: Number(g("MYSQL_PORT") ?? 3306), user: g("MYSQL_USER"), password: g("MYSQL_PASSWORD"), dateStrings: true, ssl: { rejectUnauthorized: false } });

  hr(); line("① 강원대 김준우 (DB 9d1d0edd) — 현재 상태 + source"); hr();
  const { data: kjwDb } = await sb.from("user_profiles").select("user_id,organization_slug,growth_status,contact_phone,contact_email,birth_date").eq("organization_slug", "encre").eq("display_name", "김준우");
  for (const p of (kjwDb ?? []) as any[]) {
    const { data: u } = await sb.from("users").select("source_system,legacy_user_id").eq("id", p.user_id).maybeSingle();
    const { data: edu } = await sb.from("user_educations").select("school_name,major_name_1").eq("user_id", p.user_id).limit(1).maybeSingle();
    const { data: ss } = await sb.from("user_season_statuses").select("season_key,status").eq("user_id", p.user_id);
    line(`  ${p.user_id} growth=${p.growth_status} 학교=${(edu as any)?.school_name ?? "-"} src=${(u as any)?.source_system}/${(u as any)?.legacy_user_id} 폰=${p.contact_phone} 생=${p.birth_date}`);
    line(`     season=${((ss ?? []) as any[]).map((s) => s.season_key + ":" + s.status).join(", ")}`);
  }

  hr(); line("② PMS 김준우 전수 (백석대 찾기) — oranke/hrdb/olympus"); hr();
  for (const db of ["oranke", "hrdb", "olympus"]) {
    try {
      const [r] = (await conn.query(`SELECT u.UserId,u.Name,u.School,u.Major,CAST(u.BirthDay AS CHAR) bd,u.Contact,u.mail,i.Team,i.Part,i.State,CAST(i.StartDate AS CHAR) sd FROM ${db}.users u LEFT JOIN ${db}.usersinfo i ON i.UserID=u.UserId WHERE u.Name=?`, ["김준우"])) as any;
      for (const x of r) line(`  [${db}] #${x.UserId} 학교=${x.School} 전공=${x.Major} 생=${x.bd} 폰=${x.Contact} mail=${x.mail} Team=${x.Team}/${x.Part} State=${x.State} start=${x.sd}`);
      if (!r.length) line(`  [${db}] 김준우 없음`);
    } catch (e: any) { line(`  [${db}] 실패 ${e.message}`); }
  }

  hr(); line("③ 이다경 PMS (hrdb #1607 추정) + 전수"); hr();
  for (const db of ["hrdb", "oranke", "olympus"]) {
    try {
      const [r] = (await conn.query(`SELECT u.UserId,u.Name,u.School,u.Major,CAST(u.BirthDay AS CHAR) bd,u.Contact,u.mail,i.Team,i.Part,i.State FROM ${db}.users u LEFT JOIN ${db}.usersinfo i ON i.UserID=u.UserId WHERE u.Name=?`, ["이다경"])) as any;
      for (const x of r) line(`  [${db}] #${x.UserId} 학교=${x.School} 생=${x.bd} 폰=${x.Contact} Team=${x.Team}/${x.Part} State=${x.State}`);
      if (!r.length) line(`  [${db}] 없음`);
    } catch (e: any) { line(`  [${db}] 실패 ${e.message}`); }
  }

  hr(); line("④ 류건영 PMS (oranke #1200 추정) + 전수"); hr();
  for (const db of ["oranke", "hrdb", "olympus"]) {
    try {
      const [r] = (await conn.query(`SELECT u.UserId,u.Name,u.School,u.Major,CAST(u.BirthDay AS CHAR) bd,u.Contact,u.mail,i.Team,i.Part,i.State,i.Level FROM ${db}.users u LEFT JOIN ${db}.usersinfo i ON i.UserID=u.UserId WHERE u.Name=?`, ["류건영"])) as any;
      for (const x of r) line(`  [${db}] #${x.UserId} 학교=${x.School} 생=${x.bd} 폰=${x.Contact} Team=${x.Team}/${x.Part} State=${x.State} Level=${x.Level}`);
      if (!r.length) line(`  [${db}] 없음`);
    } catch (e: any) { line(`  [${db}] 실패 ${e.message}`); }
  }
  await conn.end();

  hr(); line("⑤ Vraxium 중복/페어 점유 확인 (이관 가능 여부)"); hr();
  for (const [name] of [["김준우"], ["이다경"], ["류건영"]] as const) {
    const { data } = await sb.from("user_profiles").select("user_id,organization_slug").eq("display_name", name);
    line(`  ${name} Vraxium: ${(data ?? []).length} ${(data ?? []).map((p: any) => p.organization_slug).join(",")}`);
  }
  hr(); line("DONE");
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
