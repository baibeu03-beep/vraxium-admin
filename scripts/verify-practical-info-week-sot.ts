// ===================================================================
// 실무 정보 라인 — 선택 주차 단일 SoT 검증 (direct(lib) == HTTP(API)).
//   실행: dev server(:3000) 가동 후
//     npx tsx --env-file=.env.local scripts/verify-practical-info-week-sot.ts
//   read-only. 인증 = magiclink 세션 쿠키. DB write 없음. snapshot 무접촉.
//
// 핵심 불변식(버그 수정의 데이터 측면):
//   "주차별 개설 결과"에서 고른 weekId 로 라인 목록/개설 결과를 조회하면,
//    반환 라인의 weekId 가 전부 선택 weekId 와 같아야 한다(다른 주차 혼입 0).
//    org(encre/oranke/phalanx)·mode(operating/test) 가 바뀌어도 동일 — week 필터는 공통 로직.
//   direct(lib 함수) 결과 == HTTP(API) 결과(라인 id 집합·주차 동일).
// ===================================================================
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { listCluster4InfoLinesDetailed } from "@/lib/adminCluster4LinesData";
import { getInfoLineResultsForWeek } from "@/lib/adminCluster4InfoLineResults";
import type { OrganizationSlug } from "@/lib/organizations";

const BASE = "http://localhost:3000";
const EMAIL = process.env.SMOKE_ADMIN_EMAIL ?? "vanuatu.golden@gmail.com";

const env = readFileSync(resolve(process.cwd(), ".env.local"), "utf8");
const get = (k: string) =>
  env.match(new RegExp(`^${k}=(.+)$`, "m"))?.[1]?.trim() ?? "";
const URL_ = get("NEXT_PUBLIC_SUPABASE_URL");
const ANON = get("NEXT_PUBLIC_SUPABASE_ANON_KEY");

let fail = 0;
const ck = (label: string, ok: boolean, d = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${d ? ` — ${d}` : ""}`);
  if (!ok) fail += 1;
};

async function buildCookie(): Promise<string> {
  const brow = createClient(URL_, ANON);
  const { data: link, error } = await supabaseAdmin.auth.admin.generateLink({
    type: "magiclink",
    email: EMAIL,
  });
  if (error) throw new Error(error.message);
  const otp = (link as { properties?: { email_otp?: string } }).properties
    ?.email_otp;
  const { data: v, error: vErr } = await brow.auth.verifyOtp({
    email: EMAIL,
    token: otp!,
    type: "magiclink",
  });
  if (vErr || !v.session) throw new Error(vErr?.message ?? "세션 생성 실패");
  const cap: { name: string; value: string }[] = [];
  const srv = createServerClient(URL_, ANON, {
    cookies: { getAll: () => [], setAll: (items) => cap.push(...items) },
  });
  await srv.auth.setSession({
    access_token: v.session.access_token,
    refresh_token: v.session.refresh_token,
  });
  return cap.map((i) => `${i.name}=${i.value}`).join("; ");
}

type WeekRow = {
  id: string;
  season_key: string | null;
  week_number: number | null;
  start_date: string | null;
  end_date: string | null;
};

async function main() {
  const cookie = await buildCookie();

  // ── 2026 봄 주차 행 — W13/W16 weekId 확보(검증 대상 주차) ──
  const { data: weekData, error: weekErr } = await supabaseAdmin
    .from("weeks")
    .select("id,season_key,week_number,start_date,end_date")
    .eq("season_key", "2026-spring")
    .order("week_number", { ascending: true });
  if (weekErr) throw new Error(weekErr.message);
  const springWeeks = (weekData ?? []) as WeekRow[];
  const byNum = (n: number) => springWeeks.find((w) => w.week_number === n) ?? null;
  const w13 = byNum(13);
  const w16 = byNum(16);
  console.log(
    "2026-spring weeks:",
    springWeeks.map((w) => `W${w.week_number}=${w.id.slice(0, 8)}`).join(" "),
  );
  ck("2026-spring W16 행 존재", Boolean(w16), w16 ? `${w16.id} (${w16.start_date}~${w16.end_date})` : "없음");
  ck("2026-spring W13 행 존재", Boolean(w13), w13 ? w13.id : "없음");
  if (!w16) {
    console.log("\n❌ W16 행이 없어 검증 중단");
    process.exit(1);
  }

  // weeks-options 기본값(parent default) — operating/test 의 isOpenTarget.
  for (const mode of ["operating", "test"] as const) {
    const r = await fetch(
      `${BASE}/api/admin/cluster4/weeks-options?limit=3${mode === "test" ? "&mode=test" : ""}`,
      { headers: { cookie } },
    );
    const j = await r.json();
    const weeks = (j?.data?.weeks ?? []) as Array<{
      id: string;
      label: string;
      isOpenTarget: boolean;
    }>;
    const target = weeks.find((w) => w.isOpenTarget) ?? null;
    console.log(
      `  weeks-options[mode=${mode}] isOpenTarget(=기본 선택 주차) = ${target?.label ?? "(없음)"} ${target?.id?.slice(0, 8) ?? ""}`,
    );
  }

  // ── 검증 매트릭스: org × mode × (W16, W13) ──
  const combos: Array<{ org: OrganizationSlug; mode: "operating" | "test" }> = [
    { org: "encre", mode: "test" },
    { org: "encre", mode: "operating" },
    { org: "oranke", mode: "test" },
    { org: "phalanx", mode: "test" },
  ];
  const targetWeeks = [w16, w13].filter(Boolean) as WeekRow[];

  for (const { org, mode } of combos) {
    for (const wk of targetWeeks) {
      const tag = `${org}/${mode} W${wk.week_number}`;

      // HTTP — info-line-results (주차별 개설 결과 카드가 쓰는 엔드포인트)
      const resR = await fetch(
        `${BASE}/api/admin/cluster4/info-line-results?week_id=${wk.id}&organization=${org}`,
        { headers: { cookie } },
      );
      const resJ = await resR.json();
      const httpResults = resJ?.success ? resJ.data : null;
      ck(`${tag}: HTTP info-line-results success`, Boolean(httpResults), `status=${resR.status}`);
      // 응답 weekId 가 선택 주차와 동일.
      ck(
        `${tag}: HTTP 결과 weekId == 선택 weekId`,
        httpResults?.weekId === wk.id,
        `resp=${httpResults?.weekId?.slice(0, 8)} sel=${wk.id.slice(0, 8)}`,
      );

      // HTTP — info-lines (아래 "라인 목록" 표가 쓰는 엔드포인트)
      const linesR = await fetch(
        `${BASE}/api/admin/cluster4/info-lines?week_id=${wk.id}&organization=${org}`,
        { headers: { cookie } },
      );
      const linesJ = await linesR.json();
      const httpRows = (linesJ?.success ? linesJ.data.rows : []) as Array<{
        id: string;
        weekId: string | null;
      }>;
      const httpBadWeek = httpRows.filter((l) => l.weekId !== wk.id);
      ck(
        `${tag}: HTTP info-lines 전부 선택 주차 (혼입 0)`,
        httpBadWeek.length === 0,
        `rows=${httpRows.length} bad=${httpBadWeek.length}`,
      );

      // DIRECT — 동일 파라미터로 lib 함수 직접 호출
      const directResults = await getInfoLineResultsForWeek({
        weekId: wk.id,
        organization: org,
      });
      const directLines = await listCluster4InfoLinesDetailed({
        weekId: wk.id,
        organization: org,
      });
      const directBadWeek = directLines.rows.filter((l) => l.weekId !== wk.id);
      ck(
        `${tag}: DIRECT info-lines 전부 선택 주차 (혼입 0)`,
        directBadWeek.length === 0,
        `rows=${directLines.rows.length} bad=${directBadWeek.length}`,
      );

      // direct == HTTP — 라인 id 집합 동일 + 결과 weekId 동일
      const httpIds = httpRows.map((l) => l.id).sort();
      const directIds = directLines.rows.map((l) => l.id).sort();
      ck(
        `${tag}: direct == HTTP (info-lines id 집합)`,
        JSON.stringify(httpIds) === JSON.stringify(directIds),
        `http=${httpIds.length} direct=${directIds.length}`,
      );
      ck(
        `${tag}: direct == HTTP (results weekId)`,
        directResults.weekId === httpResults?.weekId &&
          directResults.weekId === wk.id,
      );
    }
  }

  console.log(fail === 0 ? "\n✅ ALL PASS" : `\n❌ ${fail} FAIL`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
