// 소수 대표 사용자 선검증 (대량 write 전 필수 게이트).
//   각 대표를 수정된 코드로 recompute(→fresh 현재버전) 후, HTTP(snapshot-only 응답)와
//   direct(실시간 계산)를 canonical 비교한다. 하나라도 불일치면 전체 수렴 진행 금지.
//   실행: dev server(:3000) 필요. npx tsx --env-file=.env.local scripts/verify-converge-reps-http.ts
import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";
import { getCluster4WeeklyCardsForProfileUser } from "@/lib/cluster4WeeklyCardsData";
import {
  WEEKLY_CARDS_DTO_VERSION,
  recomputeAndStoreWeeklyCardsSnapshot,
  readWeeklyCardsSnapshot,
} from "@/lib/cluster4WeeklyCardsSnapshot";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
const BASE = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
const KEY = process.env.INTERNAL_API_KEY ?? "";
const LATEST = WEEKLY_CARDS_DTO_VERSION;

function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(o).sort()) out[k] = canonical(o[k]);
    return out;
  }
  return v;
}
const canon = (v: unknown) => JSON.stringify(canonical(v));

async function httpRead(userId: string) {
  const res = await fetch(`${BASE}/api/cluster4/weekly-cards?userId=${userId}`, {
    headers: { "x-internal-api-key": KEY },
  });
  const body = (await res.json().catch(() => ({}))) as { data?: unknown[] };
  return { status: res.status, data: Array.isArray(body.data) ? body.data : [] };
}

async function main() {
  if (!KEY) throw new Error("INTERNAL_API_KEY 미설정");
  console.log(`대표 선검증 | LATEST=v${LATEST} | BASE=${BASE}\n`);

  const { data: markers } = await sb.from("test_user_markers").select("user_id");
  const testSet = new Set((markers ?? []).map((m: any) => m.user_id));

  // 대표: v21(미수렴) 실사용자 4 + 이미 v24 실사용자 2 + 테스트 2 — 다양한 card_count
  const grab = async (ver: number, isTest: boolean, n: number) => {
    const { data } = await sb
      .from("cluster4_weekly_card_snapshots")
      .select("user_id,card_count,dto_version")
      .eq("dto_version", ver)
      .gte("card_count", 3)
      .order("card_count", { ascending: false })
      .range(0, 400);
    const rows = ((data ?? []) as any[]).filter((r) => (isTest ? testSet.has(r.user_id) : !testSet.has(r.user_id)));
    const step = Math.max(1, Math.floor(rows.length / n));
    const out: any[] = [];
    for (let i = 0; i < rows.length && out.length < n; i += step) out.push(rows[i]);
    return out;
  };
  const reps = [
    ...(await grab(21, false, 4)),
    ...(await grab(LATEST, false, 2)),
    ...(await grab(21, true, 1)),
    ...(await grab(LATEST, true, 1)),
  ];
  const uniq = Array.from(new Map(reps.map((r) => [r.user_id, r])).values());
  console.log(`대표 ${uniq.length}명 선정 (저장버전/카드수): ${uniq.map((r) => `v${r.dto_version}/${r.card_count}`).join(", ")}\n`);

  // 워밍업(라우트 컴파일)
  await httpRead(uniq[0].user_id).catch(() => {});

  let allOk = true;
  for (const r of uniq) {
    const tag = testSet.has(r.user_id) ? "test" : "real";
    // 1) 수정된 코드로 recompute → fresh LATEST
    await recomputeAndStoreWeeklyCardsSnapshot(r.user_id);
    const snap = await readWeeklyCardsSnapshot(r.user_id);
    // 2) HTTP(snapshot) vs direct
    const http = await httpRead(r.user_id);
    const direct = await getCluster4WeeklyCardsForProfileUser(r.user_id);
    const eq = canon(direct) === canon(http.data);
    const snapOk = snap.status === "hit";
    if (!eq || !snapOk || http.status !== 200) allOk = false;
    console.log(
      `  ${eq && snapOk ? "OK ✅" : "FAIL ❌"} ${r.user_id} (${tag}, 저장v${r.dto_version}) | snap=${snap.status} httpStatus=${http.status} direct=${direct.length} http=${http.data.length} eq=${eq}`,
    );
  }

  console.log(`\n게이트: ${allOk ? "통과 ✅ — 전체 수렴 진행 가능" : "실패 ❌ — 전체 수렴 중단(원인 조사 필요)"}`);
  if (!allOk) process.exit(2);
}
main().catch((e) => { console.error("fatal", e); process.exit(1); });
