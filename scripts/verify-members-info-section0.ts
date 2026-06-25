/**
 * 멤버 관리 > 크루 정보 [섹션.0] 상단 현재 정보 검증.
 *   1) direct: loadSeasonWeeks() + resolveMembersInfoSection0()
 *   2) HTTP:   GET /api/admin/season-weeks (admin 세션 쿠키) + 동일 resolver
 *   3) direct == HTTP 일치
 *   4/5) snapshot 무관(시즌/주차 메타 — user_weekly_points/snapshot 미접촉)
 *
 * Usage: npx tsx --env-file=.env.local scripts/verify-members-info-section0.ts
 * 사전조건: admin dev :3000.
 */
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { loadSeasonWeeks } from "@/lib/adminSeasonWeeksData";
import {
  resolveMembersInfoSection0,
  type SeasonWeekInfoRow,
} from "@/lib/adminMembersInfoSection0";

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

async function adminCookieHeader(): Promise<string> {
  const sb = createClient(URL_, SERVICE);
  const brow = createClient(URL_, ANON);
  const { data: link } = await sb.auth.admin.generateLink({
    type: "magiclink",
    email: EMAIL,
  });
  const otp = (link as any)?.properties?.email_otp;
  const { data: v } = await brow.auth.verifyOtp({
    email: EMAIL,
    token: otp,
    type: "magiclink",
  });
  const cap: { name: string; value: string }[] = [];
  const srv = createServerClient(URL_, ANON, {
    cookies: { getAll: () => [], setAll: (items: any[]) => cap.push(...items) },
  });
  await srv.auth.setSession({
    access_token: v!.session!.access_token,
    refresh_token: v!.session!.refresh_token,
  });
  return cap.map((i) => `${i.name}=${i.value}`).join("; ");
}

function fmt(s: ReturnType<typeof resolveMembersInfoSection0>) {
  return JSON.stringify(s);
}

async function main() {
  const now = new Date();

  // 1) direct
  const directData = await loadSeasonWeeks();
  const directSection0 = resolveMembersInfoSection0(
    directData.rows as SeasonWeekInfoRow[],
    now,
  );
  console.log("── 1) direct (loadSeasonWeeks + resolver):");
  console.log("   오늘 날짜      :", directSection0.todayLabel);
  console.log("   시즌/주차      :", directSection0.seasonWeekName);
  console.log("   기간(월~일)    :", directSection0.periodRange);
  console.log("   이번 주 상태   :", `[${directSection0.weekStatus}]`);
  console.log("   현재 주차 found:", directSection0.found);

  // 2) HTTP
  const cookie = await adminCookieHeader();
  const res = await fetch(`${BASE}/api/admin/season-weeks`, {
    headers: { cookie },
    cache: "no-store" as RequestCache,
  });
  const json: any = await res.json();
  ck("HTTP 200 + success", res.ok && json?.success === true, `status ${res.status}`);
  const httpRows = (json?.data?.rows ?? []) as SeasonWeekInfoRow[];
  const httpSection0 = resolveMembersInfoSection0(httpRows, now);
  console.log("\n── 2) HTTP (/api/admin/season-weeks + resolver):");
  console.log("   오늘 날짜      :", httpSection0.todayLabel);
  console.log("   시즌/주차      :", httpSection0.seasonWeekName);
  console.log("   기간(월~일)    :", httpSection0.periodRange);
  console.log("   이번 주 상태   :", `[${httpSection0.weekStatus}]`);

  // 현재 주차 행의 원천 플래그(전환 주차 → [공식 휴식] 확인용)
  const cur = httpRows.find((r) => r.is_current_week === true) ?? null;
  if (cur) {
    console.log(
      "   (현재 주차 플래그) is_official_rest =",
      cur.is_official_rest,
      "· is_transition =",
      cur.is_transition,
    );
  }

  // 3) direct == HTTP
  console.log("\n── 3) direct == HTTP:");
  ck(
    "섹션.0 표기값 일치",
    fmt(directSection0) === fmt(httpSection0),
    fmt(directSection0) === fmt(httpSection0) ? "" : `direct=${fmt(directSection0)} http=${fmt(httpSection0)}`,
  );
  ck("rows 길이 일치", directData.rows.length === httpRows.length, `${directData.rows.length} vs ${httpRows.length}`);

  // 상태 표기는 2종만 노출됨을 단언
  ck(
    "상태 표기 [공식 활동]/[공식 휴식] 중 하나",
    httpSection0.weekStatus === "공식 활동" || httpSection0.weekStatus === "공식 휴식",
    `[${httpSection0.weekStatus}]`,
  );

  // 전환 주차면 반드시 [공식 휴식]
  if (cur?.is_transition === true) {
    ck("전환 주차 → [공식 휴식]", httpSection0.weekStatus === "공식 휴식");
  }

  console.log("\n── 4/5) snapshot 영향/재계산:");
  console.log(
    "   none — 본 기능은 season_definitions/weeks/official_rest_periods 만 read.",
  );
  console.log(
    "   user_weekly_points·weekly_cards snapshot 미접촉 → 재계산 불필요.",
  );

  console.log(`\n${fail === 0 ? "✅ PASS" : `❌ FAIL (${fail})`}`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
