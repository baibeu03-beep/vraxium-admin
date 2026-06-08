// SoT 정리(2026-06-05) 검증 — front weekly-growth 축소 / profile-summary 게이트 / 계약 보존.
//   node scripts/verify-sot-fix-20260605.mjs
// 전제: 로컬 admin(:3000)·front(:3001) dev 서버 기동, 둘 다 운영 Supabase 사용.
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const env = readFileSync(resolve(__dirname, "..", ".env.local"), "utf8");
const get = (k) => env.match(new RegExp(`^${k}=(.+)$`, "m"))?.[1]?.trim();
const sb = createClient(get("NEXT_PUBLIC_SUPABASE_URL"), get("SUPABASE_SERVICE_ROLE_KEY"));

const LOCAL_FRONT = "http://localhost:3001";
const PROD_FRONT = "https://vraxium.vercel.app";
const USERS = {
  tester: "e4dcb97e-a515-4ec5-a91e-32ca4e629dae",
  real: "247021bc-374b-48f4-8d49-b181d149ee33",
};

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "✅" : "❌"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

async function j(url) {
  const res = await fetch(url);
  let body = null;
  try {
    body = await res.json();
  } catch {}
  return { status: res.status, body };
}

// 전환주 판정 (front lib 와 동일 규칙)
function isTransition(seasonType, weekNumber) {
  const s = String(seasonType || "").toLowerCase();
  const base = s.includes("spring") ? "spring" : s.includes("summer") ? "summer"
    : s.includes("autumn") || s.includes("fall") ? "fall" : s.includes("winter") ? "winter" : null;
  if (!base || weekNumber == null) return false;
  if ((base === "spring" || base === "fall") && weekNumber === 17) return true;
  if ((base === "summer" || base === "winter") && weekNumber === 9) return true;
  return false;
}

// direct 정본: 시즌(uuid)별 확정 성공 주차 수 — confirmed-success-weeks 규칙 + 온보딩 폴리필.
async function directConfirmedBySeason(userId) {
  const [{ data: uws }, { data: weeks }, { data: prof }] = await Promise.all([
    sb.from("user_week_statuses").select("week_start_date,status").eq("user_id", userId),
    sb.from("weeks").select("id,start_date,season_id,week_number,result_published_at,season_definitions(season_type)"),
    sb.from("user_profiles").select("onboarding_week_id").eq("user_id", userId).maybeSingle(),
  ]);
  const byStart = new Map((weeks ?? []).map((w) => [w.start_date, w]));
  const map = new Map();
  for (const r of uws ?? []) {
    if (r.status !== "success") continue;
    const w = byStart.get(r.week_start_date);
    if (!w || !w.result_published_at || !w.season_id) continue;
    const st = String(w.season_definitions?.season_type ?? "");
    if (st.includes("break")) continue;
    if (isTransition(st, w.week_number)) continue;
    map.set(w.season_id, (map.get(w.season_id) ?? 0) + 1);
  }
  // 온보딩 폴리필 — uws 에 해당 주차 success 없으면 +1
  const ow = (weeks ?? []).find((w) => w.id === prof?.onboarding_week_id);
  if (ow?.season_id) {
    const counted = (uws ?? []).some((r) => r.status === "success" && r.week_start_date === ow.start_date);
    if (!counted) map.set(ow.season_id, (map.get(ow.season_id) ?? 0) + 1);
  }
  return map;
}

for (const [kind, uid] of Object.entries(USERS)) {
  console.log(`\n===== ${kind} ${uid} =====`);

  // ── T-A: front weekly-growth — 폐기 필드 부재 + 시즌요약 동등성(로컬 vs 운영) ──
  const [localWG, prodWG] = await Promise.all([
    j(`${LOCAL_FRONT}/api/cluster4/weekly-growth?userId=${uid}`),
    j(`${PROD_FRONT}/api/cluster4/weekly-growth?userId=${uid}`),
  ]);
  check(`[T-A ${kind}] local weekly-growth 200`, localWG.status === 200, `status=${localWG.status}`);
  const localKeys = Object.keys(localWG.body ?? {}).sort();
  check(
    `[T-A ${kind}] 폐기 필드 부재 (응답 키 = data 만)`,
    JSON.stringify(localKeys) === JSON.stringify(["data"]),
    `keys=${localKeys.join(",")}`,
  );
  for (const f of ["seasonSummary", "seasonPointSummary"]) {
    const a = JSON.stringify(localWG.body?.data?.[f] ?? null);
    const b = JSON.stringify(prodWG.body?.data?.[f] ?? null);
    check(`[T-A ${kind}] data.${f} 로컬==운영`, a === b, a === b ? "" : `local=${a} prod=${b}`);
  }
  const lss = localWG.body?.data?.seasonSummaries ?? [];
  const pss = prodWG.body?.data?.seasonSummaries ?? [];
  check(
    `[T-A ${kind}] data.seasonSummaries 로컬==운영`,
    JSON.stringify(lss) === JSON.stringify(pss),
    `local=${lss.length}건 prod=${pss.length}건`,
  );

  // ── T-B: profile/summary — 계약 보존 + 시즌별 approved_weeks = direct 정본 ──
  const [localSum, prodSum] = await Promise.all([
    j(`${LOCAL_FRONT}/api/profile/summary?userId=${uid}`),
    j(`${PROD_FRONT}/api/profile/summary?userId=${uid}`),
  ]);
  check(`[T-B ${kind}] local summary 200`, localSum.status === 200, `status=${localSum.status}`);
  const prodKeys = Object.keys(prodSum.body ?? {}).sort().join(",");
  const localSumKeys = Object.keys(localSum.body ?? {}).sort().join(",");
  check(`[T-B ${kind}] 응답 계약(top-level 키) 동일`, prodKeys === localSumKeys, `local=${localSumKeys} prod=${prodKeys}`);

  const expected = await directConfirmedBySeason(uid);
  let mismatch = 0;
  for (const sh of localSum.body?.seasonHistories ?? []) {
    const sid = sh.seasons?.id;
    const want = expected.get(sid) ?? 0;
    const got = sh.approved_weeks ?? 0;
    const prodRow = (prodSum.body?.seasonHistories ?? []).find((p) => p.seasons?.id === sid);
    console.log(
      `  [${kind}] ${sh.seasons?.year} ${sh.seasons?.name}: approved local=${got} direct정본=${want} prod(수정전)=${prodRow?.approved_weeks ?? "-"} | total local=${sh.total_weeks} prod=${prodRow?.total_weeks ?? "-"}`,
    );
    if (got !== want) mismatch++;
  }
  check(`[T-B ${kind}] approved_weeks == direct 정본(전 시즌)`, mismatch === 0, `mismatch=${mismatch}`);
  console.log(
    `  [${kind}] reliabilityRate local=${localSum.body?.reliabilityRate} prod(수정전)=${prodSum.body?.reliabilityRate}`,
  );
}

console.log(failures ? `\n❌ ${failures} failure(s)` : "\n✅ all checks passed");
process.exit(failures ? 1 : 0);
