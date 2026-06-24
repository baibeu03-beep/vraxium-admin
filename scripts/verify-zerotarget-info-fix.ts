/**
 * verify-zerotarget-info-fix.ts
 * 타깃 0건 info 라인 고객 노출 수정 검증 + (선택) encre audience snapshot 재계산.
 *
 *   기본(검증): 서유솔 1명 recompute 후 direct==snapshot==HTTP(internal) 비교 + 표본 encre 비교.
 *   --execute : encre audience 전원 snapshot 재계산(고객 prod 반영용).
 *
 *   npx tsx --env-file=.env.local scripts/verify-zerotarget-info-fix.ts [--execute]
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";
import { getCluster4WeeklyCardsForProfileUser } from "@/lib/cluster4WeeklyCardsData";
import {
  readWeeklyCardsSnapshot,
  recomputeAndStoreWeeklyCardsSnapshot,
  recomputeWeeklyCardsSnapshotsForUsers,
  WEEKLY_CARDS_DTO_VERSION,
} from "@/lib/cluster4WeeklyCardsSnapshot";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const KEY = process.env.INTERNAL_API_KEY ?? "";
const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const EXECUTE = process.argv.includes("--execute");
const W13 = "4cc9eecb-32aa-40ea-9c7f-7aafac777542"; // 2025-autumn W13

function infoOf(cards: any[], weekId: string) {
  const c = (cards ?? []).find((x) => x.weekId === weekId);
  if (!c) return { n: -1, codes: [] as string[] };
  const infos = (c.lines ?? []).filter((l: any) => l.partType === "information");
  return { n: infos.length, codes: infos.map((l: any) => `${l.displayLineCode}/${l.status}`) };
}

async function httpCards(uid: string): Promise<any[]> {
  const res = await fetch(`${BASE}/api/cluster4/weekly-cards?userId=${uid}`, { headers: { "x-internal-api-key": KEY } });
  const body: any = await res.json();
  return body.data ?? [];
}

async function main() {
  console.log(`DTO v${WEEKLY_CARDS_DTO_VERSION} · execute=${EXECUTE}\n`);

  // 서유솔
  const { data: su } = await sb.from("user_profiles").select("user_id").eq("display_name", "서유솔").eq("organization_slug", "encre").maybeSingle();
  const seoyusol = (su as any)?.user_id as string;

  // 1) 서유솔 recompute(새 코드로 snapshot 저장)
  await recomputeAndStoreWeeklyCardsSnapshot(seoyusol);

  // 2) direct(live) vs snapshot vs HTTP
  const live = await getCluster4WeeklyCardsForProfileUser(seoyusol);
  const snap = await readWeeklyCardsSnapshot(seoyusol);
  const snapCards = snap.status === "hit" || snap.status === "stale" ? (snap.cards as any[]) : [];
  const http = await httpCards(seoyusol);
  const dI = infoOf(live, W13), sI = infoOf(snapCards, W13), hI = infoOf(http, W13);
  console.log("■ 서유솔 25가을W13 info 라인:");
  console.log(`  DIRECT(live) = ${dI.n}건 ${JSON.stringify(dI.codes)}`);
  console.log(`  SNAPSHOT(${snap.status}) = ${sI.n}건 ${JSON.stringify(sI.codes)}`);
  console.log(`  HTTP(internal)  = ${hI.n}건 ${JSON.stringify(hI.codes)}`);
  const allEq = dI.n === sI.n && sI.n === hI.n && JSON.stringify(dI.codes.sort()) === JSON.stringify(hI.codes.sort());
  console.log(`  ⇒ direct==snapshot==HTTP: ${allEq} (기대 3건)\n`);

  // 7) demo 경로 = 동일 loadWeeklyCards(코드상). HTTP demo 는 테스트유저 전용이라 코드 경로로 확인:
  console.log("[demo==normal] weekly-cards 라우트는 demo/일반 모두 단일 loadWeeklyCards(cardTargetUserId) — 동일 snapshot row 반환(코드 단일경로).\n");

  if (!EXECUTE) {
    console.log("(검증 모드 — encre 전원 재계산은 --execute. 표본 encre 3명 direct vs snapshot 현황:)");
    const { data: enc } = await sb.from("user_profiles").select("user_id").eq("organization_slug", "encre").order("user_id").limit(3);
    for (const u of (enc ?? []) as Array<{ user_id: string }>) {
      const l = infoOf(await getCluster4WeeklyCardsForProfileUser(u.user_id), W13);
      const s0 = await readWeeklyCardsSnapshot(u.user_id);
      const s = infoOf(s0.status === "hit" || s0.status === "stale" ? (s0.cards as any[]) : [], W13);
      console.log(`  ${u.user_id.slice(0, 8)}: live=${l.n} snap(${s0.status})=${s.n}${l.n !== s.n ? "  <<< snapshot 재계산 필요" : ""}`);
    }
    return;
  }

  // --execute: encre audience 전원 재계산
  const encUsers: string[] = [];
  for (let from = 0; ; from += 1000) {
    const { data } = await sb.from("user_profiles").select("user_id").eq("organization_slug", "encre").order("user_id").range(from, from + 999);
    const rows = (data ?? []) as Array<{ user_id: string }>;
    encUsers.push(...rows.map((r) => r.user_id));
    if (rows.length < 1000) break;
  }
  console.log(`[execute] encre audience ${encUsers.length}명 snapshot 재계산...`);
  const result = await recomputeWeeklyCardsSnapshotsForUsers(encUsers, { concurrency: 4 });
  console.log("  결과:", JSON.stringify(result));

  // 8) 표본 5명 direct==snapshot 검증
  console.log("\n[표본 encre 5명 direct==snapshot 검증]");
  let okc = 0;
  for (const u of encUsers.slice(0, 5)) {
    const l = infoOf(await getCluster4WeeklyCardsForProfileUser(u), W13);
    const s0 = await readWeeklyCardsSnapshot(u);
    const s = infoOf(s0.status === "hit" || s0.status === "stale" ? (s0.cards as any[]) : [], W13);
    const eq = l.n === s.n;
    if (eq) okc++;
    console.log(`  ${u.slice(0, 8)}: live=${l.n} snap=${s.n} ${eq ? "OK" : "MISMATCH"}`);
  }
  console.log(`  ⇒ ${okc}/5 일치`);
}

main().catch((e) => { console.error("ERR", e instanceof Error ? e.stack : e); process.exit(1); });
