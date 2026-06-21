// ===================================================================
// 라인 개설 주차 필터/연도 표시 검증 — direct(lib) vs HTTP(API) 동일성.
//   실행: dev server(:3000) 가동 후
//         npx tsx --env-file=.env.local scripts/verify-line-opening-week-filter.ts
//   read-only. 인증 = magiclink 세션 쿠키. DB write 없음.
//
// 검증:
//   1) direct(lib) 결과   — 원본 weeks 행에 weekName/isValidLineOpeningWeek 적용
//   2) HTTP API 결과       — GET /api/admin/season-weeks rows 에 동일 컴포넌트 로직 적용
//   3) direct == HTTP
//   4~6) org=oranke/encre/phalanx 에서 동일(주차 필터는 org 무관)
//   7) practical-experience 가 쓰는 weeks-options 도 bad 주차 없음·연도 정상
//   8) 24-12-30~25-01-05 → "25년 겨울시즌 1주차"
//   9) 0주차 필터 제거
//   10) 겨울 9주차(전환) 필터 제거
//   11) 봄/가을 17주차(전환) 필터 제거
// ===================================================================
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import {
  computeOpenNeed,
  isValidLineOpeningWeek,
  weekName,
  weekRange,
  type SeasonWeekRow,
} from "@/lib/practicalInfoSeasonWeeks";

const BASE = "http://localhost:3000";
const EMAIL = "vanuatu.golden@gmail.com";

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

// PracticalInfoWeekResults.options 와 동일한 드롭다운 옵션 계산.
function dropdownOptions(rows: SeasonWeekRow[]): SeasonWeekRow[] {
  const need = computeOpenNeed(rows, new Date()).need;
  const cutoff = need?.week_start_date ?? null;
  return rows
    .filter(
      (w) =>
        w.week_id != null &&
        w.week_start_date != null &&
        isValidLineOpeningWeek(w) &&
        (cutoff == null || w.week_start_date <= cutoff),
    )
    .sort((a, b) =>
      (b.week_start_date ?? "").localeCompare(a.week_start_date ?? ""),
    );
}

const SEASON_TYPE_LABEL: Record<string, string> = {
  spring: "봄 시즌",
  summer: "여름 시즌",
  autumn: "가을 시즌",
  winter: "겨울 시즌",
};

async function main() {
  const cookie = await buildCookie();

  // ── DIRECT: 원본 weeks + season_definitions → SeasonWeekRow ──
  const { data: seasonDefs } = await supabaseAdmin
    .from("season_definitions")
    .select("season_key,season_label,season_type");
  const labelByKey = new Map<string, string | null>();
  for (const s of (seasonDefs ?? []) as Array<{
    season_key: string;
    season_label: string | null;
    season_type: string | null;
  }>) {
    labelByKey.set(
      s.season_key,
      s.season_label ??
        (s.season_type ? SEASON_TYPE_LABEL[s.season_type] : null) ??
        s.season_key,
    );
  }
  const { data: weekData } = await supabaseAdmin
    .from("weeks")
    .select("id,season_key,week_number,start_date,end_date")
    .order("start_date", { ascending: true });
  const directRows: SeasonWeekRow[] = ((weekData ?? []) as Array<{
    id: string;
    season_key: string | null;
    week_number: number | null;
    start_date: string | null;
    end_date: string | null;
  }>).map((w) => ({
    week_id: w.id,
    season_key: w.season_key,
    season_name: w.season_key ? labelByKey.get(w.season_key) ?? null : null,
    week_number: w.week_number,
    week_start_date: w.start_date,
    week_end_date: w.end_date,
  }));
  const directOpts = dropdownOptions(directRows);
  const directLabels = directOpts.map((w) => `${weekName(w)} (${weekRange(w)})`);

  // ── HTTP: GET /api/admin/season-weeks ──
  const res = await fetch(`${BASE}/api/admin/season-weeks`, {
    headers: { cookie },
  });
  const json = await res.json();
  ck("HTTP season-weeks success", json?.success === true, `status=${res.status}`);
  const httpRows = (json?.data?.rows ?? []) as SeasonWeekRow[];
  const httpOpts = dropdownOptions(httpRows);
  const httpLabels = httpOpts.map((w) => `${weekName(w)} (${weekRange(w)})`);

  // 3) direct == HTTP
  ck(
    "3) direct 옵션 == HTTP 옵션 (라벨 동일)",
    JSON.stringify(directLabels) === JSON.stringify(httpLabels),
    `direct=${directLabels.length} http=${httpLabels.length}`,
  );

  // 4~6) org 별 동일 (season-weeks 는 org 무관 — 응답 동일해야)
  for (const org of ["oranke", "encre", "phalanx"]) {
    const r = await fetch(
      `${BASE}/api/admin/season-weeks?org=${org}`,
      { headers: { cookie } },
    );
    const j = await r.json();
    const rows = (j?.data?.rows ?? []) as SeasonWeekRow[];
    const labels = dropdownOptions(rows).map(
      (w) => `${weekName(w)} (${weekRange(w)})`,
    );
    ck(
      `${org === "oranke" ? "4" : org === "encre" ? "5" : "6"}) org=${org} 필터 동일`,
      JSON.stringify(labels) === JSON.stringify(httpLabels),
    );
  }

  // 9) 0주차 제거
  ck(
    "9) 0주차 옵션에 없음",
    httpOpts.every((w) => (w.week_number ?? 0) >= 1),
    `raw 0주차=${httpRows.filter((w) => w.week_number === 0).length}건`,
  );
  // 10) 겨울 9주차 제거 (전환)
  ck(
    "10) 겨울 9주차(전환) 옵션에 없음",
    !httpOpts.some(
      (w) => (w.season_key ?? "").includes("winter") && w.week_number === 9,
    ),
    `raw 겨울W9=${httpRows.filter((w) => (w.season_key ?? "").includes("winter") && w.week_number === 9).length}건`,
  );
  // 11) 봄/가을 17주차 제거 (전환)
  ck(
    "11) 봄/가을 17주차(전환) 옵션에 없음",
    !httpOpts.some(
      (w) =>
        ((w.season_key ?? "").includes("spring") ||
          (w.season_key ?? "").includes("autumn")) &&
        (w.week_number ?? 0) >= 17,
    ),
    `raw 봄/가을W17=${httpRows.filter((w) => ((w.season_key ?? "").includes("spring") || (w.season_key ?? "").includes("autumn")) && (w.week_number ?? 0) >= 17).length}건`,
  );

  // 8) 24-12-30~25-01-05 → "25년 겨울시즌 1주차"
  const winterW1 = httpRows.find(
    (w) => w.week_start_date === "2024-12-30",
  );
  const winterLabel = winterW1 ? weekName(winterW1) : "(행 없음)";
  ck(
    "8) 24-12-30~25-01-05 → '25년 …겨울시즌 1주차'",
    Boolean(winterW1) &&
      winterLabel.startsWith("25년") &&
      winterLabel.includes("겨울") &&
      winterLabel.includes("1주차"),
    winterLabel,
  );

  // 7) practical-experience 가 쓰는 weeks-options — bad 주차 없음·연도 정상
  const wo = await fetch(
    `${BASE}/api/admin/cluster4/weeks-options?limit=6`,
    { headers: { cookie } },
  );
  const woJson = await wo.json();
  const woWeeks = (woJson?.data?.weeks ?? []) as Array<{
    label: string;
    weekNumber: number;
    seasonName: string;
    year: number;
    startDate: string;
    endDate: string;
  }>;
  ck("7) weeks-options success", woJson?.success === true);
  ck(
    "7) weeks-options 에 0주차 없음",
    woWeeks.every((w) => w.weekNumber >= 1),
  );
  console.log(
    "    weeks-options 라벨:",
    woWeeks.map((w) => w.label).join(" | ") || "(없음)",
  );

  console.log("\n드롭다운 옵션(최신순, 상위 8):");
  for (const l of httpLabels.slice(0, 8)) console.log("   -", l);
  console.log(`\n총 옵션 ${httpLabels.length}개`);

  console.log(fail === 0 ? "\n✅ ALL PASS" : `\n❌ ${fail} FAIL`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
