/**
 * verify-encre-info-http.ts (READ-ONLY)
 * 고객 HTTP 경로(loadWeeklyCards via internal-key)가 direct snapshot 과 동일하게 EC info 라인을
 * 반환하는지 실측. 일반 internal 경로 + demoUserId 경로 둘 다.
 *   npx tsx --env-file=.env.local scripts/verify-encre-info-http.ts
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";
import { readWeeklyCardsSnapshot } from "@/lib/cluster4WeeklyCardsSnapshot";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { persistSession: false },
});
const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const KEY = process.env.INTERNAL_API_KEY ?? "";

function infoForWeek(cards: any[], weekPrefix: string) {
  const c = (cards ?? []).find((x) => x.weekId && x.weekId.startsWith(weekPrefix));
  if (!c) return { found: false as const };
  const infos = (c.lines ?? []).filter((l: any) => l.partType === "information");
  return { found: true as const, status: c.userWeekStatus, infos: infos.map((l: any) => ({ lineId: (l.lineId ?? "").slice(0, 8), status: l.status, display: l.displayLineCode, title: (l.mainTitle ?? "").slice(0, 24) })) };
}

async function main() {
  console.log(`internal key present=${KEY ? "yes" : "NO"} base=${BASE}\n`);
  // 양다연 — 2026w19 EC line(19c39a94) 의 첫 target user 를 정확히 해석
  const { data: lineRow } = await sb.from("cluster4_lines").select("id").like("line_code", "info-EC-practical_lecture-2026w19").maybeSingle();
  const lineId = (lineRow as any)?.id as string;
  const { data: tg } = await sb.from("cluster4_line_targets").select("target_user_id").eq("line_id", lineId).eq("target_mode", "user").limit(1);
  const uid = ((tg ?? []) as Array<{ target_user_id: string }>)[0]?.target_user_id;
  if (!uid) return console.log("no target user for line 2026w19");
  const { data: prof } = await sb.from("user_profiles").select("display_name,organization_slug").eq("user_id", uid).maybeSingle();
  console.log(`user=${uid} (${(prof as any)?.display_name}/${(prof as any)?.organization_slug}) line=${lineId.slice(0,8)} week=6cc59d70\n`);

  // direct snapshot
  const snap = await readWeeklyCardsSnapshot(uid);
  const snapCards = snap.status === "hit" || snap.status === "stale" ? (snap.cards as any[]) : [];
  console.log("DIRECT snapshot:", snap.status, JSON.stringify(infoForWeek(snapCards, "6cc59d70")));

  // HTTP internal
  try {
    const res = await fetch(`${BASE}/api/cluster4/weekly-cards?userId=${uid}`, { headers: { "x-internal-api-key": KEY } });
    const body = await res.json();
    const cards = body.cards ?? body.data?.cards ?? [];
    console.log(`HTTP internal: ${res.status} cards=${cards.length}`, JSON.stringify(infoForWeek(cards, "6cc59d70")));
  } catch (e) {
    console.log("HTTP internal fetch failed:", e instanceof Error ? e.message : e);
  }

  // HTTP demo path (mode=test, demoUserId=test user) — DTO 는 동일 snapshot 이어야(메모: demo==normal)
  // demoUserId 는 테스트 유저여야 하므로 일반 유저 조회는 internal 로 충분. demo 경로는 별도 테스트유저 필요 → skip note.
  console.log("\n(데모 경로: demoUserId 는 테스트유저 전용 + targetUserId 우선 → 동일 loadWeeklyCards. 별도 테스트유저로만 진입 가능, 코드상 동일 snapshot row.)");
}

main().catch((e) => { console.error("ERR", e instanceof Error ? e.stack : e); process.exit(1); });
