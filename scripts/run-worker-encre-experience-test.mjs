// 실제 worker 실행 — encre/experience/test/W13 고착행(c1702443)을 진짜 크롤+매칭으로 완료시킨다.
//   1) findDueItems(read-only)로 worker 대상에 잡히는지 확인
//   2) runOnce(orgs=['encre'],modes=['test'],onlyIds=[ID], 실제 크롤) — 그 행만 처리(타 실데이터 보호)
//   3) DB 컬럼 검증(status/scope_mode/attempt/last_attempt/last_error/checked_crew_count)
//   전제: dev 서버 + .naver-profile(로컬 네이버 세션).
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const __d = dirname(fileURLToPath(import.meta.url));
const r = createRequire(resolve(__d, "..", "package.json"));
const { createClient } = r("@supabase/supabase-js");
const env = readFileSync(resolve(__d, "..", ".env.local"), "utf8");
const get = (k) => env.match(new RegExp(`^${k}=(.+)$`, "m"))?.[1]?.trim();
const URL = get("NEXT_PUBLIC_SUPABASE_URL"), SERVICE = get("SUPABASE_SERVICE_ROLE_KEY");
const sb = createClient(URL, SERVICE, { auth: { persistSession: false } });
const ID = "c1702443-eff8-42be-b599-2315c311e2fe";
const BASE = "http://localhost:3000";

const { findDueItems, runOnce, defaultCrawlAndMatch, ensureAdminCookie } = await import("./process-check-worker.mjs");

let pass = 0, fail = 0;
const ck = (l, ok, d = "") => { console.log(`  ${ok ? "✓" : "✗"} ${l}${d ? ` — ${d}` : ""}`); ok ? pass++ : fail++; };

// 1) 대상 포착(read-only).
const nowIso = new Date().toISOString();
const due = await findDueItems(sb, nowIso);
const mine = due.find((d) => d.id === ID);
ck("[1] findDueItems 에 고착행 포착(pending·과거·링크)", !!mine, mine ? `source=${mine.source} scope_mode=${mine.scope_mode}` : "미포착");
ck("[1] scope_mode='test' (worker test 스코프 대상)", mine?.scope_mode === "test", `scope_mode=${mine?.scope_mode}`);

// 2) 실제 크롤 주입 + 그 행만 처리.
console.log("  → 실제 크롤 시작(네이버 카페 — 수십 초 소요):", new Date().toISOString());
const cookie = await ensureAdminCookie();
const crawl = (org, mode, url) => defaultCrawlAndMatch(BASE, cookie, org, mode, url);
const res = await runOnce({ sb, now: Date.now(), orgs: ["encre"], modes: ["test"], onlyIds: [ID], crawlAndMatch: crawl, accrue: null, log: (m) => console.log(`    ${m}`) });
ck("[2] runOnce 처리 성공 1건", res.succeeded === 1 && res.failed === 0, JSON.stringify(res));

// 3) DB 검증.
const { data: row } = await sb.from("process_check_statuses")
  .select("status,scope_mode,attempt_count,last_attempt_at,last_error,checked_crew_count").eq("id", ID).single();
console.log("  DB row:", JSON.stringify(row));
ck("[3] status='completed'", row?.status === "completed");
ck("[3] checked_crew_count >= 0 (0명도 완료)", typeof row?.checked_crew_count === "number" && row.checked_crew_count >= 0, `cc=${row?.checked_crew_count}`);
ck("[3] last_error = null", !row?.last_error, row?.last_error ?? "null");
ck("[3] attempt_count > 0", (row?.attempt_count ?? 0) > 0, `attempt=${row?.attempt_count}`);
ck("[3] last_attempt_at not null", !!row?.last_attempt_at, row?.last_attempt_at ?? "null");
ck("[3] scope_mode='test' 유지", row?.scope_mode === "test");

// recipients(매칭/미매칭) 분포.
const recs = (await sb.from("process_check_review_recipients").select("match_type").eq("source", "regular").eq("ref_id", ID)).data ?? [];
const matched = recs.filter((x) => x.match_type === "matched").length;
const review = recs.filter((x) => x.match_type === "review").length;
ck("[4] recipients 저장 — matched + review", recs.length > 0, `matched=${matched} review=${review}`);

console.log(`\n결과: ${pass} pass / ${fail} fail`);
process.exit(fail ? 1 : 0);
