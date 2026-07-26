// 실제 HTTP 검증 — 회원 상세(/api/admin/members/{id}) 주차 결과 표의 주차별 A/B/C 를
//   weeks.is_official_rest 와 대조한다. "활동 주차 0 · 공식 휴식 주차만 값" 현상 재현 확인.
//   Usage: node scripts/_verify-week-points-http.mjs [label]
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
const label = process.argv[2] || "head";

const sb = createClient(URL_, SERVICE);
const brow = createClient(URL_, ANON);

async function cookieHeader(email) {
  const { data: link, error } = await sb.auth.admin.generateLink({ type: "magiclink", email });
  if (error) throw new Error(`generateLink: ${error.message}`);
  const { data: v, error: e2 } = await brow.auth.verifyOtp({
    email, token: link.properties.email_otp, type: "magiclink",
  });
  if (e2) throw new Error(`verifyOtp: ${e2.message}`);
  const cap = [];
  const srv = createServerClient(URL_, ANON, { cookies: { getAll: () => [], setAll: (i) => cap.push(...i) } });
  await srv.auth.setSession({ access_token: v.session.access_token, refresh_token: v.session.refresh_token });
  return cap.map((i) => `${i.name}=${i.value}`).join("; ");
}

const USERS = [
  { id: "ef4938c2-5dfe-4500-a0bc-0d953c6f7314", name: "서유솔", note: "소실 8404" },
  { id: "8cc1ae06-3110-4e34-918c-2a92674725a1", name: "최서윤", note: "소실 2747" },
  { id: "13fb675f-3943-4be8-89c5-0739024dd5b2", name: "김도연", note: "소실 2331" },
  { id: "8eeb75ba-47c9-49fd-971b-ba3188b90ce4", name: "윤채영", note: "소실 101(PMS 레거시)" },
  { id: "76a42307-f3b2-4c08-92ab-f339a20b7d38", name: "T윤서진", note: "소실 0(테스트 계정)" },
];

async function main() {
  const cookie = await cookieHeader(OWNER_EMAIL);
  // weeks.is_official_rest 대조표
  const { data: weeks } = await sb.from("weeks").select("start_date,season_key,week_number,is_official_rest").range(0, 999);
  const restByStart = new Map((weeks ?? []).map((w) => [w.start_date, w.is_official_rest]));

  const out = { label, base: BASE, users: {} };
  for (const u of USERS) {
    const res = await fetch(`${BASE}/api/admin/members/${u.id}`, { headers: { cookie } });
    const body = await res.json().catch(() => null);
    const d = body?.data ?? body ?? {};
    const weekly = d.weeklyResults ?? [];
    const season = d.seasonResults ?? [];
    const club = d.clubSummary ?? null;
    console.log(`\n=== ${u.name} (${u.note}) HTTP ${res.status} · 주차행 ${weekly.length} ===`);
    console.log(`  누적(clubSummary): ${JSON.stringify(club)}`);
    let restNz = 0, actNz = 0, restRows = 0, actRows = 0;
    for (const r of weekly) {
      const rest = restByStart.get(r.weekStartDate ?? "") ?? null;
      const p = r.points ?? {};
      const nz = (p.poA ?? 0) !== 0 || (p.poB ?? 0) !== 0 || (p.poC ?? 0) !== 0;
      if (rest === true) { restRows++; if (nz) restNz++; }
      else if (rest === false) { actRows++; if (nz) actNz++; }
    }
    // weekStartDate 가 DTO 에 없으면 weekName 으로 표기
    for (const r of weekly) {
      const p = r.points ?? {};
      console.log(
        `   ${(r.weekName ?? "").padEnd(26)} ${String(r.growthResultLabel ?? "").padEnd(9)} ` +
          `A=${String(p.poA ?? 0).padStart(4)} B=${String(p.poB ?? 0).padStart(4)} C=${String(p.poC ?? 0).padStart(3)}`,
      );
    }
    console.log(`  시즌 결과: ${season.map((s) => `${s.seasonName ?? s.seasonKey}=${s.points?.poA ?? "?"}/${s.points?.poB ?? "?"}/${s.points?.poC ?? "?"}`).join("  ")}`);
    out.users[u.id] = { name: u.name, status: res.status, club, weekly, season };
  }
  writeFileSync(resolve(__dirname, `_week-points-${label}.json`), JSON.stringify(out, null, 1), "utf8");
  console.log(`\nsaved → scripts/_week-points-${label}.json`);
}

main().catch((e) => { console.error(e); process.exit(1); });
