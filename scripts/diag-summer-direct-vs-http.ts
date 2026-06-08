/**
 * direct vs HTTP diff 원인 분석 (read-only) — 키 순서 정규화 후 실질 diff 추출.
 *   npx tsx --env-file=.env.local scripts/diag-summer-direct-vs-http.ts
 */
import { readFileSync } from "fs";
import { getCluster4WeeklyCardsForProfileUser } from "@/lib/cluster4WeeklyCardsData";

const ADMIN = "https://vraxium-admin.vercel.app";
const rawEnv = readFileSync(".env.local", "utf8");
const INTERNAL_KEY = rawEnv.match(/^INTERNAL_API_KEY=(.+)$/m)?.[1]?.trim();
const runLog = JSON.parse(readFileSync("claudedocs/summer-pms-restore-2026-06-07T01-03-07.json", "utf8"));
const uid: string = runLog.testers[0];

// 키 재귀 정렬 정규화
function canon(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canon);
  if (v && typeof v === "object") {
    const o: Record<string, unknown> = {};
    for (const k of Object.keys(v as object).sort()) o[k] = canon((v as Record<string, unknown>)[k]);
    return o;
  }
  return v;
}
// 실질 diff 경로 추출
function diffPaths(a: unknown, b: unknown, path = "", out: string[] = []): string[] {
  if (JSON.stringify(canon(a)) === JSON.stringify(canon(b))) return out;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) { out.push(`${path}.length ${a.length}≠${b.length}`); return out; }
    a.forEach((x, i) => diffPaths(x, b[i], `${path}[${i}]`, out));
    return out;
  }
  if (a && b && typeof a === "object" && typeof b === "object") {
    const keys = new Set([...Object.keys(a as object), ...Object.keys(b as object)]);
    for (const k of keys) diffPaths((a as any)[k], (b as any)[k], path ? `${path}.${k}` : k, out);
    return out;
  }
  out.push(`${path}: ${JSON.stringify(a)} ≠ ${JSON.stringify(b)}`);
  return out;
}

async function main() {
  const direct = await getCluster4WeeklyCardsForProfileUser(uid);
  const res = await fetch(`${ADMIN}/api/cluster4/weekly-cards?userId=${uid}`, {
    headers: { "x-internal-api-key": INTERNAL_KEY! },
  });
  const http = (await res.json()).data ?? [];

  console.log(`테스터 ${uid.slice(0, 8)} — direct ${direct.length}장 / HTTP ${http.length}장`);
  // 1) 키 순서 정규화 후 deep equal
  const canonEqual = JSON.stringify(canon(direct)) === JSON.stringify(canon(http));
  console.log(`키 정렬 정규화 후 deep equal: ${canonEqual ? "✅ 동일 (= 원래 diff 는 jsonb 키 순서 아티팩트)" : "❌ 실질 diff 존재"}`);
  if (!canonEqual) {
    const paths = diffPaths(direct, http).slice(0, 30);
    console.log(`실질 diff 경로 (앞 30):`);
    for (const p of paths) console.log("  " + p);
  }
  // 2) 원시 stringify diff 1장 표본 — 키 순서 차이 시연
  const i = 0;
  if (JSON.stringify(direct[i]) !== JSON.stringify(http[i])) {
    console.log(`\n표본 카드[0] 키 순서: direct=[${Object.keys(direct[i] as object).slice(0, 6).join(",")}…] http=[${Object.keys(http[i] ?? {}).slice(0, 6).join(",")}…]`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
