// 어드민 실제 HTTP API 교차 검증 — 동일 사용자·조직·시즌·주차의 주차 포인트 A/B/C.
//   Usage: node scripts/_verify-admin-week-abc-http.mjs [adminBase] [frontBase]
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const rq = createRequire(resolve(root, "package.json"));
const { createClient } = rq("@supabase/supabase-js");
const { createServerClient } = rq("@supabase/ssr");
const env = readFileSync(resolve(root, ".env.local"), "utf8");
const get = (k) => env.match(new RegExp(`^${k}=(.+)$`, "m"))?.[1]?.trim();

const ADMIN = process.argv[2] || "http://localhost:3000";
const FRONT = process.argv[3] || "http://localhost:3021";
const URL_ = get("NEXT_PUBLIC_SUPABASE_URL");
const ANON = get("NEXT_PUBLIC_SUPABASE_ANON_KEY");
const SERVICE = get("SUPABASE_SERVICE_ROLE_KEY");
const OWNER_EMAIL = "vanuatu.golden@gmail.com";
const sb = createClient(URL_, SERVICE);
const brow = createClient(URL_, ANON);

// 대상 — Champion/크루 카드 표본과 동일 인물. 필요 시 인자로 교체.
const USER_ID = process.env.WR_USER_ID || "3d968dba-77a4-4382-a5ad-ad5cad7c1c34"; // T이선호
const ORG = process.env.WR_ORG || "oranke";
const SEASON = "2026-summer";
const WEEK_NUMBER = 1;

async function cookieHeader(email) {
  const { data: link, error } = await sb.auth.admin.generateLink({ type: "magiclink", email });
  if (error) throw new Error(`generateLink: ${error.message}`);
  const { data: v, error: e2 } = await brow.auth.verifyOtp({ email, token: link.properties.email_otp, type: "magiclink" });
  if (e2) throw new Error(`verifyOtp: ${e2.message}`);
  const cap = [];
  const srv = createServerClient(URL_, ANON, { cookies: { getAll: () => [], setAll: (i) => cap.push(...i) } });
  await srv.auth.setSession({ access_token: v.session.access_token, refresh_token: v.session.refresh_token });
  return cap.map((i) => `${i.name}=${i.value}`).join("; ");
}

async function main() {
  const { data: w } = await sb.from("weeks").select("id,start_date").eq("season_key", SEASON).eq("week_number", WEEK_NUMBER).maybeSingle();
  const { data: prof } = await sb.from("user_profiles").select("display_name").eq("user_id", USER_ID).maybeSingle();
  const { data: p } = await sb
    .from("user_weekly_points").select("points,advantages,penalty")
    .eq("user_id", USER_ID).eq("week_start_date", w.start_date).maybeSingle();
  const dbA = Number(p?.points ?? 0);
  const dbRaw = Number(p?.advantages ?? 0);
  const dbC = Math.abs(Number(p?.penalty ?? 0));
  const db = { A: dbA, B: dbRaw - dbC, C: dbC };
  console.log(`대상: ${prof?.display_name} (${USER_ID}) · ${ORG} · ${SEASON} W${WEEK_NUMBER} (${w.start_date})`);
  console.log(`DB 원천 user_weekly_points: points=${dbA} advantages=${dbRaw} penalty=${dbC}`);

  // 1) 어드민 HTTP — 회원 상세 주차 결과 표
  const cookie = await cookieHeader(OWNER_EMAIL);
  const ar = await fetch(`${ADMIN}/api/admin/members/${USER_ID}`, { headers: { cookie } });
  const ab = await ar.json().catch(() => null);
  const rows = ab?.data?.weeklyResults ?? [];
  const row = rows.find((r) => String(r.weekName ?? "").includes("여름") && String(r.weekName ?? "").includes(`${WEEK_NUMBER}주차`));
  const admin = row ? { A: row.points.poA, B: row.points.poB, C: row.points.poC } : null;
  console.log(`어드민 HTTP ${ar.status} /api/admin/members/${USER_ID} → ${row ? `${row.weekName} ${JSON.stringify(row.points)}` : "행 없음"}`);

  // 2) 어드민 HTTP — 크루 주차 결과(crewWeekShowcase 경로)도 함께 확인(있으면)
  const ar2 = await fetch(`${ADMIN}/api/admin/crews/${USER_ID}/cluster3/growth`, { headers: { cookie } });
  const ab2 = await ar2.json().catch(() => null);
  console.log(`어드민 HTTP ${ar2.status} cluster3/growth(누적 참고) → ${JSON.stringify(ab2?.data?.point ?? ab2?.point ?? null)}`);

  // 3) weekly-ranking HTTP
  const fr = await fetch(`${FRONT}/api/weekly-league?org=${ORG}`);
  const fb = await fr.json();
  const card = (fb.cards ?? []).find((c) => c.id === w.id);
  const crew = (card?.crewRankShowcase ?? []).find((c) => c.userId === USER_ID);
  const wr = crew ? { A: crew.pointA, B: crew.pointB, C: crew.pointC } : null;
  const champ = (card?.top10Focus ?? []).find((c) => c.name === prof?.display_name);
  console.log(`weekly-ranking HTTP ${fr.status} → ${wr ? JSON.stringify(wr) : "크루 없음"}${champ ? ` · Champion 표시B=${champ.pointB} 정렬B=${champ.pointBRaw}` : ""}`);

  const eq = (x, y) => (x == null || y == null ? "N/A" : x === y ? "✅" : "❌");
  console.log(`\n| 항목 | DB 원천 | 어드민 HTTP | weekly-ranking HTTP | 일치 |`);
  console.log(`|---|---:|---:|---:|---|`);
  for (const k of ["A", "B", "C"]) {
    console.log(`| 포인트 ${k} | ${db[k]} | ${admin ? admin[k] : "-"} | ${wr ? wr[k] : "-"} | ${eq(db[k], admin?.[k])}${eq(db[k], wr?.[k])} |`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
