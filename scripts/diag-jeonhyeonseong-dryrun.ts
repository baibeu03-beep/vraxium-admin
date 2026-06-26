/**
 * 진단 전용(read-only): 전현성 단독 이관 dry-run 보고 데이터 수집.
 *   npx tsx --env-file=.env.local scripts/diag-jeonhyeonseong-dryrun.ts
 */
import { createClient } from "@supabase/supabase-js";
import mysql from "mysql2/promise";
import { readFileSync } from "fs";

const rawEnv = readFileSync(".env.local", "utf8");
const envGet = (k: string) => rawEnv.match(new RegExp(`^${k}=(.+)$`, "m"))?.[1]?.trim();
const sb = createClient(envGet("NEXT_PUBLIC_SUPABASE_URL")!, envGet("SUPABASE_SERVICE_ROLE_KEY")!);
const line = (s = "") => console.log(s);
const hr = () => line("─".repeat(72));
const normPhone = (s: unknown) => String(s ?? "").replace(/\D/g, "").slice(-8);
const normEmail = (s: unknown) => String(s ?? "").trim().toLowerCase();

async function main() {
  const conn = await mysql.createConnection({
    host: envGet("MYSQL_HOST"), port: Number(envGet("MYSQL_PORT") ?? 3306),
    user: envGet("MYSQL_USER"), password: envGet("MYSQL_PASSWORD"), dateStrings: true, ssl: { rejectUnauthorized: false },
  });

  hr(); line("1. PMS 원천 — 전현성 (oranke.users / usersinfo / userspoint)"); hr();
  const [[u]] = (await conn.query(
    `SELECT UserId, Name, CAST(BirthDay AS CHAR) AS BirthDay, Gender, School, Major, Address, Contact, mail FROM oranke.users WHERE Name=?`, ["전현성"])) as any;
  if (!u) { line("  PMS oranke.users 에 전현성 없음"); await conn.end(); return; }
  const [[info]] = (await conn.query(
    `SELECT Team, Part, Week, Level, State, CAST(StartDate AS CHAR) AS StartDate FROM oranke.usersinfo WHERE UserID=?`, [u.UserId])) as any;
  const [[bal]] = (await conn.query(`SELECT Star, Shield FROM oranke.userspoint WHERE UserID=?`, [u.UserId])) as any;
  line(`  UserId=${u.UserId}  Name=${u.Name}`);
  line(`  생년월일=${u.BirthDay ?? "-"}  성별=${u.Gender ?? "-"}`);
  line(`  학교=${u.School ?? "-"}  전공=${u.Major ?? "-"}`);
  line(`  연락처=${u.Contact ?? "-"}  메일=${u.mail ?? "-"}`);
  line(`  주소=${u.Address ?? "-"}`);
  line(`  [usersinfo] Team=${info?.Team ?? "-"} Part=${info?.Part ?? "-"} Level=${info?.Level ?? "-"} State=${info?.State ?? "-"} StartDate=${info?.StartDate ?? "-"} Week=${info?.Week ?? "-"}`);
  line(`  [userspoint] Star=${bal?.Star ?? "-"} Shield=${bal?.Shield ?? "-"}`);

  // pointlogs / activities 건수(이관 시 복원 대상 규모)
  const [[pl]] = (await conn.query(`SELECT COUNT(*) n FROM oranke.pointlogs WHERE UserID=?`, [u.UserId])) as any;
  const [[ua]] = (await conn.query(`SELECT COUNT(*) n FROM oranke.useractivities WHERE UserId=?`, [u.UserId])) as any;
  const [[ma]] = (await conn.query(`SELECT COUNT(*) n FROM oranke.manageractivities WHERE UserId=?`, [u.UserId])) as any;
  line(`  활동 이력: pointlogs=${pl?.n ?? 0} useractivities=${ua?.n ?? 0} manageractivities=${ma?.n ?? 0}`);
  await conn.end();

  hr(); line("2. Vraxium 재검색 — 동일인 존재 여부 (이름/생년월일/연락처/메일)"); hr();
  const birthIso = (() => { const s = String(u.BirthDay ?? "").replace(/\D/g, ""); if (s.length === 8) return `${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)}`; if (s.length === 6) { const yy = Number(s.slice(0,2)); return `${yy<=26?"20":"19"}${s.slice(0,2)}-${s.slice(2,4)}-${s.slice(4,6)}`;} return null; })();
  const pmsPhone = normPhone(u.Contact), pmsEmail = normEmail(u.mail);
  line(`  매칭키: birth=${birthIso ?? "-"} phone8=${pmsPhone || "-"} email=${pmsEmail || "-"}`);
  const { data: byName } = await sb.from("user_profiles").select("user_id,display_name,organization_slug,birth_date,contact_phone,contact_email,status").eq("display_name", "전현성");
  line(`  display_name='전현성': ${(byName ?? []).length}건`);
  for (const p of (byName ?? []) as any[]) line(`    - ${p.organization_slug} ${p.user_id} birth=${p.birth_date} phone=${p.contact_phone} status=${p.status}`);
  let strong = 0;
  if (birthIso) { const { data } = await sb.from("user_profiles").select("user_id,display_name").eq("birth_date", birthIso); for (const p of (data ?? []) as any[]) { line(`  birth_date=${birthIso} 일치: ${p.display_name} ${p.user_id}`); strong++; } }
  if (pmsPhone) { const { data } = await sb.from("user_profiles").select("user_id,display_name,contact_phone").ilike("contact_phone", `%${pmsPhone.slice(-8)}%`); for (const p of (data ?? []) as any[]) if (normPhone(p.contact_phone) === pmsPhone) { line(`  contact_phone 끝8 일치: ${p.display_name} ${p.user_id}`); strong++; } }
  if (pmsEmail) { const { data } = await sb.from("user_profiles").select("user_id,display_name,contact_email").eq("contact_email", u.mail); for (const p of (data ?? []) as any[]) { line(`  email 일치: ${p.display_name} ${p.user_id}`); strong++; } }
  line(`  → 강매칭(생년월일/연락처/메일) 합계: ${strong}건 ${strong === 0 ? "(동일인 없음 → 신규 생성 필요)" : "(기존 인물 존재 → 이관 금지·연결 검토)"}`);

  // (source,legacy) 페어 점유 확인
  const { data: pair } = await sb.from("users").select("id").eq("source_system", "oranke").eq("legacy_user_id", u.UserId);
  line(`  (source=oranke, legacy_user_id=${u.UserId}) 점유: ${(pair ?? []).length}건`);

  hr(); line("DONE");
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
