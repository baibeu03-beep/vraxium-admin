// 실사용자 주차별 A/B/C HTTP 검증 (mode/organization 조합 자동 탐색).
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const __dirname = dirname(fileURLToPath(import.meta.url));
const adminRoot = resolve(__dirname, "..");
const rq = createRequire(resolve(adminRoot, "package.json"));
const { createClient } = rq("@supabase/supabase-js");
const { createServerClient } = rq("@supabase/ssr");
const env = readFileSync(resolve(adminRoot, ".env.local"), "utf8");
const get = (k) => env.match(new RegExp(`^${k}=(.+)$`, "m"))?.[1]?.trim();

const BASE = process.env.VERIFY_BASE || "http://localhost:3012";
const URL_ = get("NEXT_PUBLIC_SUPABASE_URL");
const ANON = get("NEXT_PUBLIC_SUPABASE_ANON_KEY");
const SERVICE = get("SUPABASE_SERVICE_ROLE_KEY");
const OWNER_EMAIL = "vanuatu.golden@gmail.com";

const sb = createClient(URL_, SERVICE);
const brow = createClient(URL_, ANON);

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

const USERS = [
  { id: "ef4938c2-5dfe-4500-a0bc-0d953c6f7314", name: "서유솔", org: "encre" },
  { id: "8cc1ae06-3110-4e34-918c-2a92674725a1", name: "최서윤", org: "oranke" },
  { id: "8eeb75ba-47c9-49fd-971b-ba3188b90ce4", name: "윤채영", org: "encre" },
];
const VARIANTS = (u) => [
  "",
  "?mode=operating",
  `?organization=${u.org}`,
  `?mode=operating&organization=${u.org}`,
];

async function main() {
  const cookie = await cookieHeader(OWNER_EMAIL);
  const { data: weeks } = await sb.from("weeks").select("start_date,is_official_rest").range(0, 999);
  const restByStart = new Map((weeks ?? []).map((w) => [w.start_date, w.is_official_rest]));
  const out = {};

  for (const u of USERS) {
    let picked = null;
    for (const q of VARIANTS(u)) {
      const res = await fetch(`${BASE}/api/admin/members/${u.id}${q}`, { headers: { cookie } });
      const body = await res.json().catch(() => null);
      console.log(`  probe ${u.name}${q || "(no query)"} → ${res.status} ${res.ok ? "" : (body?.error ?? "")}`);
      if (res.ok) { picked = { q, body }; break; }
    }
    if (!picked) { console.log(`  ${u.name}: 접근 불가 — 건너뜀`); continue; }
    const d = picked.body?.data ?? {};
    const weekly = d.weeklyResults ?? [];
    console.log(`\n=== ${u.name} (${picked.q || "no query"}) 주차행 ${weekly.length} ===`);
    console.log(`  누적: ${JSON.stringify(d.clubSummary)}`);
    let restRows = 0, restNz = 0, actRows = 0, actNz = 0;
    for (const r of weekly) {
      const p = r.points ?? {};
      const nz = (p.poA ?? 0) !== 0 || (p.poB ?? 0) !== 0 || (p.poC ?? 0) !== 0;
      const isRest = String(r.growthResultLabel ?? "").includes("공식 휴식");
      if (isRest) { restRows++; if (nz) restNz++; } else { actRows++; if (nz) actNz++; }
      console.log(
        `   ${(r.weekName ?? "").padEnd(26)} ${String(r.growthResultLabel ?? "").padEnd(9)} ` +
          `A=${String(p.poA ?? 0).padStart(4)} B=${String(p.poB ?? 0).padStart(4)} C=${String(p.poC ?? 0).padStart(3)}`,
      );
    }
    console.log(`  → 공식휴식 행 ${restRows}중 값있음 ${restNz} · 그 외 행 ${actRows}중 값있음 ${actNz}`);
    out[u.name] = { query: picked.q, clubSummary: d.clubSummary, weekly };
  }
  writeFileSync(resolve(__dirname, "_week-points-real.json"), JSON.stringify(out, null, 1), "utf8");
  console.log("\nsaved → scripts/_week-points-real.json");
}

main().catch((e) => { console.error(e); process.exit(1); });
