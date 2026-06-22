// 재계산 후 검증 — 고객 weekly-cards snapshot 반영 + direct==HTTP + demo==normal.
//   각 변경 라인을 target user 의 snapshot(DB) / HTTP(internal-key) 카드에서 lineId 로 찾아
//   mainTitle·outputLinks 를 cluster4_lines(live)와 정확히 대조한다(부분문자열 아님).
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const adminRoot = resolve(__dirname, "..");
const req = createRequire(resolve(adminRoot, "package.json"));
const { createClient } = req("@supabase/supabase-js");
const env = readFileSync(resolve(adminRoot, ".env.local"), "utf8");
const get = (k) => env.match(new RegExp(`^${k}=(.+)$`, "m"))?.[1]?.trim();
const BASE = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
const INTERNAL = get("INTERNAL_API_KEY");
const sb = createClient(get("NEXT_PUBLIC_SUPABASE_URL"), get("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });

const urls = (links) => (Array.isArray(links) ? links.map((l) => l.url).sort().join(" ") : "");
const findLine = (cards, lineId) => {
  for (const c of cards ?? []) for (const l of c.lines ?? []) if (l.lineId === lineId) return l;
  return null;
};
async function snapCards(userId) {
  const { data } = await sb.from("cluster4_weekly_card_snapshots").select("cards").eq("user_id", userId).maybeSingle();
  return data?.cards ?? [];
}
async function httpCards(userId, extraQs = "") {
  const r = await fetch(`${BASE}/api/cluster4/weekly-cards?userId=${userId}${extraQs}`, { headers: { "x-internal-api-key": INTERNAL } });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, cards: j?.data ?? [] };
}
async function oneTargetUser(lineId) {
  const { data } = await sb.from("cluster4_line_targets").select("target_user_id").eq("line_id", lineId).eq("target_mode", "user").limit(1);
  return data?.[0]?.target_user_id ?? null;
}
// 그 라인을 실제로 카드에 가진 target user 1명(없으면 null). 2025 라인은 당시 활동자만 카드 보유.
async function targetUserWithLine(lineId) {
  const { data } = await sb.from("cluster4_line_targets").select("target_user_id").eq("line_id", lineId).eq("target_mode", "user").limit(30);
  for (const r of data ?? []) {
    const uid = r.target_user_id;
    if (!uid) continue;
    const cards = await snapCards(uid);
    if (findLine(cards, lineId)) return uid;
  }
  return null;
}

async function main() {
  const dry = JSON.parse(readFileSync(resolve(adminRoot, "claudedocs/dryrun-resync-oranke-260521.json"), "utf8"));
  const lineIds = [...new Set([
    ...(dry.sampleTitleUpdate ?? []).map((a) => a.id),
    ...(dry.outputLinkConflictsPreserved ?? []).slice(0, 12).map((a) => a.id),
  ])];

  // live DB 기준값.
  const live = new Map();
  for (let i = 0; i < lineIds.length; i += 100) {
    const { data } = await sb.from("cluster4_lines").select("id,main_title,output_links").in("id", lineIds.slice(i, i + 100));
    for (const r of data ?? []) live.set(r.id, r);
  }

  let pass = 0, fail = 0, youtubeFound = 0;
  const fails = [];
  for (const lineId of lineIds) {
    const uid = await targetUserWithLine(lineId);
    const L = live.get(lineId);
    if (!uid || !L) { fails.push({ lineId, reason: "no target carrying line in cards" }); fail++; continue; }
    const dCards = await snapCards(uid);
    const h = await httpCards(uid);
    const dl = findLine(dCards, lineId);
    const hl = findLine(h.cards, lineId);
    if (!dl || !hl) { fails.push({ lineId, uid, reason: "line not in user cards", inDirect: !!dl, inHttp: !!hl }); fail++; continue; }
    const titleOk = dl.mainTitle === L.main_title && hl.mainTitle === L.main_title;
    const linkOk = urls(dl.outputLinks) === urls(L.output_links) && urls(hl.outputLinks) === urls(L.output_links);
    const directEqualsHttp = dl.mainTitle === hl.mainTitle && urls(dl.outputLinks) === urls(hl.outputLinks);
    const noYoutube = !/youtu/.test(JSON.stringify(dl.outputLinks)) && !/youtu/.test(JSON.stringify(hl.outputLinks));
    if (!noYoutube) youtubeFound++;
    const ok = titleOk && linkOk && directEqualsHttp && noYoutube && h.status === 200;
    ok ? pass++ : fail++;
    if (!ok) fails.push({ lineId, uid, titleOk, linkOk, directEqualsHttp, noYoutube, dTitle: dl.mainTitle, hTitle: hl.mainTitle, liveTitle: L.main_title });
  }

  // demo==normal: 같은 user 를 internal(userId) vs demo(demoUserId=testUser&userId) 로 조회.
  const testUser = "13b8e55e-ff49-43f3-a01f-cb68bfb74581";
  const sampleUid = await oneTargetUser(lineIds[0]);
  const normal = await httpCards(sampleUid);
  const demo = await httpCards(sampleUid, `&demoUserId=${testUser}&mode=test`);
  const demoVsNormal = {
    normalStatus: normal.status, demoStatus: demo.status,
    equal: JSON.stringify(normal.cards) === JSON.stringify(demo.cards),
    note: demo.status === 200
      ? "demo(demoUserId)·일반(userId) 동일 cardTargetUserId → 동일 blob"
      : "demo 게이트(ENABLE_DEMO_MODE) 미설정 가능 — 코드상 두 경로 모두 loadWeeklyCards(동일 userId) 단일 로더",
  };

  console.log(JSON.stringify({
    verifiedLines: lineIds.length, pass, fail, youtubeRowsRemaining: youtubeFound,
    demoVsNormal, fails: fails.slice(0, 10),
    conclusion: fail === 0 ? "PASS — snapshot mainTitle/outputLinks == live == HTTP, youtube 제거, direct==HTTP." : "FAIL — fails 참조.",
  }, null, 2));
}
main().catch((e) => { console.error("ERR", e instanceof Error ? e.message : e); process.exit(1); });
