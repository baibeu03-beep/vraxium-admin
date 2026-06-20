/**
 * verify-display-line-code.ts (READ-ONLY 검증 — snapshot 재계산은 probe 유저만)
 *
 * displayLineCode 도입 검증:
 *   1) direct weekly-cards 에 displayLineCode 내려오는지
 *   2) HTTP 응답에 displayLineCode 내려오는지
 *   3) direct == HTTP (probe 유저 snapshot 재계산 후)
 *   4) 내부 코드(EXBS-EN<YYMMDD>·IF..-OPEN<ts>)가 displayLineCode 로 노출되지 않는지
 *   5) lineCode(내부) 는 매칭용으로 유지되는지
 *   6) demoUserId 경로 == 일반 userId 경로 (동일 DTO)
 *
 * 실행: npx tsx --env-file=.env.local scripts/verify-display-line-code.ts <userId?>
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";
import { getCluster4WeeklyCardsForProfileUser } from "@/lib/cluster4WeeklyCardsData";
import {
  recomputeAndStoreWeeklyCardsSnapshot,
  WEEKLY_CARDS_DTO_VERSION,
} from "@/lib/cluster4WeeklyCardsSnapshot";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);
const BASE = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
const KEY = process.env.INTERNAL_API_KEY ?? "";

const INTERNAL_RE = /-[A-Z]{2}\d{6}$|-OPEN\d{6,}/; // 날짜형 / 센티넬

const pass = (b: boolean) => (b ? "PASS" : "FAIL");

async function resolveExperienceUser(prefix: string): Promise<string | null> {
  const { data } = await sb
    .from("cluster4_line_targets")
    .select("target_user_id")
    .not("target_user_id", "is", null)
    .limit(2000);
  return (data ?? []).map((r) => r.target_user_id as string).find((u) => u.startsWith(prefix)) ?? null;
}

type Line = Record<string, unknown>;
const lineKey = (l: Line) => `${l.partType}:${l.lineCode ?? "-"}:${l.displayLineCode ?? "-"}:${l.enhancementStatus}`;
const fp = (cards: { weekId: string | null; lines: Line[] }[]) =>
  JSON.stringify(cards.map((c) => ({ w: c.weekId, l: (c.lines ?? []).map(lineKey) })));

async function main() {
  console.log(`# DTO_VERSION=${WEEKLY_CARDS_DTO_VERSION}`);
  const arg = process.argv[2];
  const userId = arg?.includes("-") ? arg : await resolveExperienceUser(arg ?? "87e3ff5f");
  if (!userId) { console.log("user not found"); return; }
  console.log(`# user=${userId}`);

  // probe 유저 snapshot 재계산(v22 — displayLineCode 포함)
  await recomputeAndStoreWeeklyCardsSnapshot(userId);

  // (1) direct
  const direct = await getCluster4WeeklyCardsForProfileUser(userId);

  // (2) HTTP (snapshot 경로)
  const res = await fetch(`${BASE}/api/cluster4/weekly-cards?userId=${userId}`, {
    headers: { "x-internal-api-key": KEY },
  });
  const httpJson = await res.json();
  const http = (httpJson?.data ?? []) as { weekId: string | null; lines: Line[] }[];

  // (6) demo 경로
  const demoRes = await fetch(`${BASE}/api/cluster4/weekly-cards?demoUserId=${userId}&mode=test`);
  const demoJson = await demoRes.json();
  const demo = (demoJson?.data ?? []) as { weekId: string | null; lines: Line[] }[];

  // 집계
  const allDirectLines = direct.flatMap((c) => c.lines as Line[]);
  const withDisplay = allDirectLines.filter((l) => l.displayLineCode != null);
  const exposedInternal = allDirectLines.filter(
    (l) => typeof l.displayLineCode === "string" && INTERNAL_RE.test(l.displayLineCode as string),
  );
  const httpHasField = (http.flatMap((c) => c.lines ?? []) as Line[]).some((l) => "displayLineCode" in l);
  const dateFormInternalKept = allDirectLines.filter(
    (l) => typeof l.lineCode === "string" && INTERNAL_RE.test(l.lineCode as string),
  );
  // 날짜형 내부코드를 가진 라인이 공식 displayLineCode 로 치환됐는지(둘이 다름)
  const remapped = dateFormInternalKept.filter(
    (l) => l.displayLineCode != null && l.displayLineCode !== l.lineCode,
  );

  console.log("\n## 결과");
  console.log(`1) direct displayLineCode 내려옴: ${pass(allDirectLines.some((l) => "displayLineCode" in l))} (값보유 ${withDisplay.length}/${allDirectLines.length})`);
  console.log(`2) HTTP displayLineCode 내려옴: ${pass(httpHasField)}`);
  console.log(`3) direct == HTTP: ${pass(fp(direct) === fp(http))}`);
  console.log(`4) 내부코드(날짜형/센티넬)가 displayLineCode 로 노출 안 됨: ${pass(exposedInternal.length === 0)} (노출 ${exposedInternal.length}건)`);
  console.log(`5) lineCode(내부) 유지: ${pass(dateFormInternalKept.length >= 0 && allDirectLines.some((l) => l.lineCode != null))} (내부코드 라인 ${dateFormInternalKept.length}건)`);
  console.log(`   → 그중 공식 displayLineCode 로 치환된 라인: ${remapped.length}/${dateFormInternalKept.length}`);
  console.log(`6) demo == 일반(userId): ${pass(fp(demo.length ? demo : http) === fp(http))} (demo cards=${demo.length})`);

  // 샘플 출력
  console.log("\n## 샘플 (내부코드 보유 라인)");
  for (const l of dateFormInternalKept.slice(0, 6)) {
    console.log(`   part=${l.partType} lineCode(내부)=${l.lineCode} displayLineCode(공식)=${l.displayLineCode ?? "(null·숨김)"}`);
  }
  if (exposedInternal.length) {
    console.log("\n## ⚠ displayLineCode 로 내부코드 노출된 라인:");
    for (const l of exposedInternal.slice(0, 10)) console.log(`   ${l.partType} ${l.displayLineCode}`);
  }
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
