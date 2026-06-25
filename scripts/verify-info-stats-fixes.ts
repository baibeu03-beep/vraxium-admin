/**
 * 검증 — [섹션.1] 2종 수정: ① 공식휴식+확정데이터 주차 표시  ② Oldest 활동시작주차 폴백.
 *   direct(loadMembersInfoStats) vs HTTP(/api/admin/members/info-stats) 동일성 + 핵심 행 점검.
 * Usage: npx tsx --env-file=.env.local scripts/verify-info-stats-fixes.ts
 */
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { loadMembersInfoStats } from "@/lib/adminMembersInfoStats";

const BASE = "http://localhost:3000";
const EMAIL = "vanuatu.golden@gmail.com";
const URL_ = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!;

let fail = 0;
const ck = (l: string, ok: boolean, d = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${l}${d ? ` — ${d}` : ""}`);
  if (!ok) fail++;
};

async function cookie(): Promise<string> {
  const sb = createClient(URL_, SERVICE);
  const brow = createClient(URL_, ANON);
  const { data: link } = await sb.auth.admin.generateLink({ type: "magiclink", email: EMAIL });
  const { data: v } = await brow.auth.verifyOtp({ email: EMAIL, token: (link as any).properties.email_otp, type: "magiclink" });
  const cap: any[] = [];
  const srv = createServerClient(URL_, ANON, { cookies: { getAll: () => [], setAll: (i: any[]) => cap.push(...i) } });
  await srv.auth.setSession({ access_token: v!.session!.access_token, refresh_token: v!.session!.refresh_token });
  return cap.map((i) => `${i.name}=${i.value}`).join("; ");
}

const SPRING = ["13주차", "14주차", "15주차", "16주차", "17주차"];
const pick = (w: any) => ({
  name: w.seasonWeekName, status: w.clubStatus, finalized: w.finalized,
  clubbing: w.clubbing, 시즌휴식: w.seasonalRest, 주차휴식: w.weeklyRest,
  a: w.growthSuccess, b: w.growthFail, oldest: w.oldest,
});

async function main() {
  const direct = await loadMembersInfoStats({ organization: "encre", mode: "operating" });

  console.log("══════ ① 2026 봄 13~17주차 (encre, direct) ══════");
  const springRows = direct.weeks.filter((w) => w.seasonWeekName.includes("봄") && SPRING.some((s) => w.seasonWeekName.includes(s)));
  for (const w of springRows) console.log(` ${w.seasonWeekName} →`, JSON.stringify(pick(w)));

  const w14 = springRows.find((w) => w.seasonWeekName.includes("14주차"));
  ck("W14(공식 휴식)이 확정 표시(finalized=true)", !!w14 && w14.finalized === true);
  ck("W14 시즌휴식(공식 휴식) 집계값 > 0", !!w14 && (w14.seasonalRest ?? 0) > 0, w14 ? String(w14.seasonalRest) : "-");
  ck("W14 클럽 상태 = 공식 휴식", !!w14 && w14.clubStatus === "공식 휴식");
  // W15·W16 = 종료된 공식 휴식 주차 + official_rest 확정 카드 → 표시(시즌휴식>0).
  const w15 = springRows.find((w) => w.seasonWeekName.includes("15주차"));
  const w16 = springRows.find((w) => w.seasonWeekName.includes("16주차"));
  ck("W15(종료 공식휴식) 확정 표시 + 시즌휴식>0", !!w15 && w15.finalized === true && (w15.seasonalRest ?? 0) > 0, w15 ? String(w15.seasonalRest) : "-");
  ck("W16(종료 공식휴식) 확정 표시 + 시즌휴식>0", !!w16 && w16.finalized === true && (w16.seasonalRest ?? 0) > 0, w16 ? String(w16.seasonalRest) : "-");
  // W17 = 현재(미종료) 주차 → official_rest 카드가 있어도 "-" (주차 종료 게이트).
  const w17 = springRows.find((w) => w.seasonWeekName.includes("17주차"));
  ck("W17(현재/미종료) = 미확정(-)", !!w17 && w17.finalized === false && w17.clubbing === null);

  console.log("\n══════ ② Oldest 활동시작주차 라벨 ══════");
  const withOldest = direct.weeks.filter((w) => w.finalized && w.oldest);
  const unresolved = withOldest.filter((w) => w.oldest && w.oldest.startWeekLabel == null);
  // 표본 몇 개 출력.
  for (const w of withOldest.slice(0, 3)) console.log(` ${w.seasonWeekName} oldest:`, JSON.stringify(w.oldest));
  ck("확정 주차 Oldest 전부 startWeekLabel 해석됨(null 없음)", unresolved.length === 0,
    unresolved.length ? `미해석 ${unresolved.length}건 (예: ${JSON.stringify(unresolved[0].oldest)})` : "");
  // 황수아(2021-10-10) 폴백 라벨 형식 확인.
  const hwasua = withOldest.map((w) => w.oldest!).find((o) => o.name === "황수아");
  if (hwasua) ck("황수아 활동시작주차 라벨 존재", !!hwasua.startWeekLabel && /^\d{2}-[봄여름가을겨울]+-\d+$/.test(hwasua.startWeekLabel), JSON.stringify(hwasua));

  // ── HTTP 동일성 ──
  console.log("\n══════ ③ direct == HTTP (encre) ══════");
  const ck_ = await cookie();
  const res = await fetch(`${BASE}/api/admin/members/info-stats?organization=encre`, { headers: { cookie: ck_ }, cache: "no-store" as RequestCache });
  const json: any = await res.json();
  ck("HTTP 200", res.ok && json.success === true);
  const strip = (d: any) => { const { generatedAt, ...r } = d; return JSON.stringify(r); };
  ck("direct == HTTP (generatedAt 제외)", strip(direct) === strip(json.data));

  console.log("\n── snapshot 영향/재계산: none(읽기 전용 readSnapshotCards) ──");
  console.log(`\n${fail === 0 ? "✅ PASS" : `❌ FAIL (${fail})`}`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
