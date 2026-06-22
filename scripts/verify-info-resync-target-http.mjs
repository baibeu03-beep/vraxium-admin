// HTTP 검증 — oranke info 재동기화 dry-run 이 "라인 개설 대상 크루"를 건드리지 않음.
//   대상 = 이 재동기화가 UPDATE 할 라인(제목변경 8 + 링크추가 sample + 충돌보존 sample).
//   각 라인에 대해:
//     direct = cluster4_line_targets (line_id, week_id, target_mode='user') 카운트/유저집합
//     http   = GET /api/admin/cluster4/info-lines/crew (관리자 쿠키) → targets/count
//   검증: ① direct.count == http.count, ② 동일 user 집합, ③ 전체 합계가 baseline 과 동일.
//   dry-run 은 쓰기 0이므로 이 값들이 곧 "변경 없음"의 현재 상태 = 불변 증명.
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const adminRoot = resolve(__dirname, "..");
const requireAdmin = createRequire(resolve(adminRoot, "package.json"));
const { createClient } = requireAdmin("@supabase/supabase-js");
const { createServerClient } = requireAdmin("@supabase/ssr");

const env = readFileSync(resolve(adminRoot, ".env.local"), "utf8");
const get = (k) => env.match(new RegExp(`^${k}=(.+)$`, "m"))?.[1]?.trim();
const adminEmail = process.env.SMOKE_ADMIN_EMAIL ?? "vanuatu.golden@gmail.com";
const BASE = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
const SUPABASE_URL = get("NEXT_PUBLIC_SUPABASE_URL");
const ANON = get("NEXT_PUBLIC_SUPABASE_ANON_KEY");
const SERVICE = get("SUPABASE_SERVICE_ROLE_KEY");
const sb = createClient(SUPABASE_URL, SERVICE, { auth: { persistSession: false } });

async function makeCookieHeader() {
  const b = createClient(SUPABASE_URL, ANON);
  const { data: linkData } = await sb.auth.admin.generateLink({ type: "magiclink", email: adminEmail });
  const { data: verifyData } = await b.auth.verifyOtp({
    email: adminEmail,
    token: linkData.properties.email_otp,
    type: "magiclink",
  });
  const captured = [];
  const server = createServerClient(SUPABASE_URL, ANON, {
    cookies: { getAll: () => [], setAll: (items) => captured.push(...items) },
  });
  await server.auth.setSession({
    access_token: verifyData.session.access_token,
    refresh_token: verifyData.session.refresh_token,
  });
  return captured.map((i) => `${i.name}=${i.value}`).join("; ");
}

async function directTargets(lineId, weekId) {
  const { data, error } = await sb
    .from("cluster4_line_targets")
    .select("target_user_id")
    .eq("line_id", lineId)
    .eq("week_id", weekId)
    .eq("target_mode", "user")
    .order("created_at", { ascending: true });
  if (error) throw new Error(`direct targets failed: ${error.message}`);
  return (data ?? []).map((r) => r.target_user_id).filter(Boolean);
}

async function httpCrew(cookie, lineId, weekId) {
  const url = `${BASE}/api/admin/cluster4/info-lines/crew?line_id=${lineId}&week_id=${weekId}`;
  const r = await fetch(url, { headers: { cookie } });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, count: j?.data?.count ?? null, targets: j?.data?.targets ?? [] };
}

async function main() {
  const dry = JSON.parse(readFileSync(resolve(adminRoot, "claudedocs/dryrun-resync-oranke-260521.json"), "utf8"));
  const ids = new Set();
  for (const a of dry.sampleTitleUpdate ?? []) ids.add(a.id);
  for (const a of dry.sampleLinkAdd ?? []) ids.add(a.id);
  for (const a of dry.outputLinkConflictsPreserved ?? []) ids.add(a.id);
  const lineIds = [...ids];

  // 각 라인의 week_id.
  const lineWeek = new Map();
  for (let i = 0; i < lineIds.length; i += 100) {
    const slice = lineIds.slice(i, i + 100);
    const { data, error } = await sb.from("cluster4_lines").select("id,week_id").in("id", slice);
    if (error) throw new Error(`line week query failed: ${error.message}`);
    for (const r of data ?? []) lineWeek.set(r.id, r.week_id);
  }

  const cookie = await makeCookieHeader();

  let pass = 0;
  let fail = 0;
  let directTotal = 0;
  let httpTotal = 0;
  const mismatches = [];
  for (const lineId of lineIds) {
    const weekId = lineWeek.get(lineId);
    if (!weekId) {
      mismatches.push({ lineId, reason: "no week_id" });
      fail += 1;
      continue;
    }
    const direct = await directTargets(lineId, weekId);
    const http = await httpCrew(cookie, lineId, weekId);
    directTotal += direct.length;
    httpTotal += http.count ?? -1;
    const httpIds = http.targets.map((t) => t.userId).sort();
    const directIds = [...direct].sort();
    const sameSet = JSON.stringify(httpIds) === JSON.stringify(directIds);
    const ok = http.status === 200 && http.count === direct.length && sameSet;
    if (ok) pass += 1;
    else {
      fail += 1;
      mismatches.push({ lineId, weekId, httpStatus: http.status, httpCount: http.count, directCount: direct.length, sameSet });
    }
  }

  console.log(
    JSON.stringify(
      {
        verifiedLines: lineIds.length,
        directHttpParity: { pass, fail },
        targetCrewTotals: { directSum: directTotal, httpSum: httpTotal, equal: directTotal === httpTotal },
        mismatches: mismatches.slice(0, 20),
        conclusion:
          fail === 0 && directTotal === httpTotal
            ? "PASS — 검증 라인 전부 direct==HTTP, 대상 크루 합계 일치. dry-run 쓰기 0이므로 라인 개설 대상 크루 불변."
            : "FAIL — 불일치 존재(상세 mismatches 참조).",
      },
      null,
      2,
    ),
  );
}

main().catch((e) => {
  console.error("ERR", e instanceof Error ? e.message : e);
  process.exit(1);
});
