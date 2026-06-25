/**
 * 검증 — [섹션.1] 엥크레 탭: 데이터 시작·누적·Po.A/B/C(최고 포인트 TOP3, encre 전용).
 *   ① direct cumulative(데이터 시작/클러빙/엘리트 null/활동중단)
 *   ② Po.A/B/C 구조(내림차순·≤3·points>0) + 크루 ∈ encre 명부 + Po.A 값=해당 크루 snapshot star(타깃 재확인)
 *   ③ 통합 vs 엥크레 범위 차이
 *   ④ direct == HTTP(encre)
 *   ⚠ 백그라운드 converge(snapshot 재계산)로 값이 요동칠 수 있어 타깃 재확인/쿠키는 재시도.
 * Usage: npx tsx --env-file=.env.local scripts/verify-encre-info-stats.ts
 */
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
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
const strip = (d: any) => { const { generatedAt, ...r } = d ?? {}; return JSON.stringify(r); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function cookie(): Promise<string> {
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const sb = createClient(URL_, SERVICE);
      const brow = createClient(URL_, ANON);
      const { data: link } = await sb.auth.admin.generateLink({ type: "magiclink", email: EMAIL });
      const otp = (link as any)?.properties?.email_otp;
      if (!otp) throw new Error("magiclink properties null (transient)");
      const { data: v } = await brow.auth.verifyOtp({ email: EMAIL, token: otp, type: "magiclink" });
      const cap: any[] = [];
      const srv = createServerClient(URL_, ANON, { cookies: { getAll: () => [], setAll: (i: any[]) => cap.push(...i) } });
      await srv.auth.setSession({ access_token: v!.session!.access_token, refresh_token: v!.session!.refresh_token });
      return cap.map((i) => `${i.name}=${i.value}`).join("; ");
    } catch (e) {
      console.log(`  · cookie attempt ${attempt} 실패(${(e as Error).message}) → 재시도`);
      await sleep(3000);
    }
  }
  throw new Error("cookie 생성 4회 실패");
}

// encre 명부 이름 집합 + (이름→user_id) — user_profiles 기준(안정).
async function encreRoster(): Promise<{ names: Set<string>; idByName: Map<string, string> }> {
  const { data } = await supabaseAdmin
    .from("user_profiles")
    .select("user_id, display_name")
    .eq("organization_slug", "encre")
    .not("activity_started_at", "is", null)
    .or("role.is.null,role.neq.super_admin");
  const names = new Set<string>();
  const idByName = new Map<string, string>();
  for (const r of (data ?? []) as any[]) {
    if (r.display_name) { names.add(r.display_name); idByName.set(r.display_name, r.user_id); }
  }
  return { names, idByName };
}

// 특정 크루의 특정 주차 snapshot 카드 points.star (타깃 재확인 — converge 요동 대비 재시도).
async function crewWeekStar(userId: string, weekId: string): Promise<number | null> {
  for (let attempt = 1; attempt <= 5; attempt++) {
    const { data } = await supabaseAdmin
      .from("cluster4_weekly_card_snapshots").select("cards").eq("user_id", userId).maybeSingle();
    const cards = (data as any)?.cards;
    if (Array.isArray(cards)) {
      const c = cards.find((x: any) => x.weekId === weekId);
      if (c && typeof c.points?.star === "number") return c.points.star;
    }
    await sleep(2500); // converge 중이면 잠시 후 재확인
  }
  return null;
}

async function main() {
  const en = await loadMembersInfoStats({ organization: "encre", mode: "operating" });
  const all = await loadMembersInfoStats({ organization: "all", mode: "operating" });

  // ① 누적
  console.log("══════ ① 엥크레 역대 누적 ══════");
  console.log("   데이터 시작     :", en.cumulative.dataStartWeekLabel);
  console.log("   누적 클러빙     :", en.cumulative.cumulativeClubbing);
  console.log("   누적 엘리트     :", en.cumulative.cumulativeElite, "(기획 미정 → null)");
  console.log("   누적 활동 중단  :", en.cumulative.cumulativeSuspended);
  ck("데이터 시작 주차 존재(문자열)", typeof en.cumulative.dataStartWeekLabel === "string" && en.cumulative.dataStartWeekLabel!.length > 0);
  ck("누적 엘리트 = null", en.cumulative.cumulativeElite === null);
  ck("누적 클러빙 > 0", en.cumulative.cumulativeClubbing > 0);

  // ② Po.A/B/C — 구조 + encre 명부 + Po.A 값 타깃 재확인
  console.log("\n══════ ② Po.A/B/C ══════");
  const { names, idByName } = await encreRoster();
  const samples = en.weeks.filter((w) => w.finalized && w.weeklyTopPoints && w.weeklyTopPoints.length > 0).slice(0, 2);
  ck("Po 보유 확정 주차 표본 ≥1", samples.length >= 1);
  for (const w of samples) {
    const top = w.weeklyTopPoints!;
    console.log(`   [${w.seasonWeekName}] ${top.map((t, i) => `Po.${["A", "B", "C"][i]}=${t.name} ${t.points}P`).join(" / ")}`);
    ck(`  ${w.seasonWeekName} 내림차순`, top.every((t, i) => i === 0 || top[i - 1].points >= t.points));
    ck(`  ${w.seasonWeekName} ≤3개·points>0`, top.length <= 3 && top.every((t) => t.points > 0));
    ck(`  ${w.seasonWeekName} 모든 Po 크루 ∈ encre 명부`, top.every((t) => names.has(t.name)), top.map((t) => t.name).join(","));
  }
  // Po.A 값 = 해당 크루 snapshot star (타깃 재확인, 가장 최신 표본)
  if (samples.length > 0) {
    const w = samples[0];
    const a = w.weeklyTopPoints![0];
    const uid = idByName.get(a.name);
    if (uid) {
      const star = await crewWeekStar(uid, w.weekId);
      ck(`  [${w.seasonWeekName}] Po.A(${a.name}) 값 ${a.points}P = 본인 snapshot star`, star === a.points, `star=${star}`);
    }
  }

  // null 경로 — 포인트 데이터 없는 확정 주차는 null(공식 휴식이라도 포인트 있으면 표시됨이 정상).
  const nullWeek = en.weeks.find((w) => w.finalized && w.weeklyTopPoints === null);
  if (nullWeek) ck(`포인트 없는 확정 주차 Po=null (예: ${nullWeek.seasonWeekName})`, true);
  else console.log("  · (포인트 없는 확정 주차 표본 없음 — 모든 확정 주차에 포인트 보유)");
  // 미확정(현재/미검수) 주차 = null
  const pendWeek = en.weeks.find((w) => !w.finalized);
  if (pendWeek) ck("미확정 주차 Po = null", pendWeek.weeklyTopPoints === null);

  // ③ 통합 vs 엥크레
  console.log("\n══════ ③ 통합 vs 엥크레 범위 차이 ══════");
  ck("엥크레 누적 클러빙 < 통합", en.cumulative.cumulativeClubbing < all.cumulative.cumulativeClubbing,
    `${en.cumulative.cumulativeClubbing} < ${all.cumulative.cumulativeClubbing}`);
  ck("통합 클럽수=3 · 엥크레 클럽수=1", all.cumulative.clubCount === 3 && en.cumulative.clubCount === 1);

  // ④ direct == HTTP (encre) — converge settle 가정, 1회. (전체 동치는 verify-members-info-stats)
  console.log("\n══════ ④ direct == HTTP(encre) ══════");
  const ck_ = await cookie();
  const res = await fetch(`${BASE}/api/admin/members/info-stats?organization=encre`, { headers: { cookie: ck_ }, cache: "no-store" as RequestCache });
  const json: any = await res.json();
  ck("HTTP 200", res.ok && json.success === true);
  // cumulative 는 user_profiles 기반(결정적) — 항상 일치해야.
  ck("cumulative direct == HTTP", strip(en.cumulative) === strip(json.data?.cumulative),
    strip(en.cumulative) === strip(json.data?.cumulative) ? "" : `${strip(en.cumulative)} vs ${strip(json.data?.cumulative)}`);
  ck("weeks 길이 direct == HTTP", en.weeks.length === (json.data?.weeks?.length ?? -1));

  console.log("\n── snapshot 영향/재계산: none(읽기 전용 readSnapshotCards·user_profiles/weeks read) ──");
  console.log(`\n${fail === 0 ? "✅ PASS" : `❌ FAIL (${fail})`}`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
