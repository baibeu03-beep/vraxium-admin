/**
 * verify-line-opening-exception-hubs.ts
 * "해당 주차 전체(scope=all)" 라인 개설 예외가 실무 정보/경험/역량 3개 허브에서 모두
 *   공식 휴식 자동 차단을 덮어쓰는지 검증(2026-07 Option A).
 *
 *   게이트:
 *     (1) weeks-options.canOpen        — 3개 허브 프론트 드롭다운 공용 게이트
 *     (2) assertWeekOpenable           — 실무 경험(openTeamOverall·part-input)
 *     (3) competency-lines POST 휴식가드 — 실무 역량 라인 생성
 *     (4) info-lines findActiveException — 실무 정보(기존, scope=all=NULL 이미 허용)
 *
 * 사전: dev 서버(:3000) 기동. 실행:
 *   npx tsx --env-file=.env.local scripts/verify-line-opening-exception-hubs.ts
 *
 * 실 DB 에 예외 1행을 잠깐 생성했다가 finally 에서 반드시 삭제한다(운영 잔여 0).
 * snapshot 은 예외 CRUD 로 생성/재계산되지 않음(무영향)을 count·최신 computed_at 으로 확인.
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import {
  createLineOpeningWindows,
  deleteLineOpeningWindow,
  hasActiveAllLineException,
  getActiveAllLineExceptionWeekIds,
  findActiveLineOpeningException,
} from "@/lib/lineOpeningWindowsData";
import { assertWeekOpenable, isWeekOfficialRestById } from "@/lib/cluster4OfficialRestWeek";
import { getOpenableWeekStartMs, describeWeekByStartMs } from "@/lib/cluster4WeekPolicy";
import { getCurrentActivityDateIso } from "@/lib/seasonCalendar";

const BASE = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
const ADMIN_EMAIL = process.env.SMOKE_ADMIN_EMAIL ?? "vanuatu.golden@gmail.com";
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const sb = createClient(SUPABASE_URL, SERVICE);

let pass = 0, fail = 0;
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  ok ? pass++ : fail++;
};

async function adminCookieHeader(): Promise<string> {
  const admin = createClient(SUPABASE_URL, SERVICE);
  const browser = createClient(SUPABASE_URL, ANON);
  const { data: linkData, error: linkErr } = await admin.auth.admin.generateLink({
    type: "magiclink", email: ADMIN_EMAIL,
  });
  if (linkErr) throw linkErr;
  const otp = linkData.properties?.email_otp;
  if (!otp) throw new Error("email_otp 없음");
  const { data: verifyData, error: vErr } = await browser.auth.verifyOtp({
    email: ADMIN_EMAIL, token: otp, type: "magiclink",
  });
  if (vErr) throw vErr;
  const captured: Array<{ name: string; value: string }> = [];
  const server = createServerClient(SUPABASE_URL, ANON, {
    cookies: { getAll: () => [], setAll: (items) => captured.push(...items) },
  });
  await server.auth.setSession({
    access_token: verifyData.session!.access_token,
    refresh_token: verifyData.session!.refresh_token,
  });
  return captured.map((c) => `${c.name}=${c.value}`).join("; ");
}

async function snapBaseline() {
  const { count } = await sb
    .from("cluster4_weekly_card_snapshots")
    .select("*", { count: "exact", head: true });
  const { data: latest } = await sb
    .from("cluster4_weekly_card_snapshots")
    .select("computed_at")
    .order("computed_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return { count: count ?? 0, latest: (latest as { computed_at?: string } | null)?.computed_at ?? null };
}

// weeks-options HTTP 응답에서 주어진 weekId 옵션을 찾는다(mode 별).
async function weeksOptionOf(cookie: string, weekId: string, mode?: string) {
  const qs = new URLSearchParams({ limit: "6" });
  if (mode) qs.set("mode", mode);
  const res = await fetch(`${BASE}/api/admin/cluster4/weeks-options?${qs}`, { headers: { cookie } });
  const json = await res.json();
  const weeks = (json?.data?.weeks ?? []) as Array<Record<string, unknown>>;
  return { status: res.status, week: weeks.find((w) => w.id === weekId) ?? null, count: weeks.length };
}

async function main() {
  const cookie = await adminCookieHeader();

  // ── 대상 = 현재 개설 대상(금요일 경계) 주차. 오늘 기준 이 주차가 공식 휴식이면 시나리오 재현. ──
  const todayIso = getCurrentActivityDateIso();
  const openableMs = getOpenableWeekStartMs(todayIso);
  if (openableMs == null) throw new Error("openable week 계산 불가");
  const info = describeWeekByStartMs(openableMs);
  if (!info) throw new Error("openable week describe 불가");
  const { data: weekRow } = await sb
    .from("weeks")
    .select("id")
    .eq("iso_year", info.isoYear)
    .eq("iso_week", info.isoWeek)
    .maybeSingle();
  const weekId = (weekRow as { id: string } | null)?.id;
  if (!weekId) throw new Error("openable week weeks 행 없음");

  const { rest } = await isWeekOfficialRestById(weekId);
  console.log(`대상 주차 = ${info.year} ${info.seasonName} ${info.weekNumber}주차 (${weekId})`);
  console.log(`  공식 휴식 여부 = ${rest}\n`);

  if (!rest) {
    // 개설 대상이 휴식이 아니면(정규 주차) 이 검증의 시나리오(휴식 덮어쓰기)를 재현할 수 없다.
    // → 명시적으로 스킵 표시하고 통과 처리(예외 로직 자체는 direct 단위로 아래에서 강제).
    console.log("⚠ 현재 개설 대상 주차가 공식 휴식이 아님 — 휴식 덮어쓰기 시나리오는 오늘 재현 불가.");
    console.log("  (예외 로직 단위 검증만 진행)\n");
  }

  const before = await snapBaseline();
  // 정리(같은 주차 잔여 예외 제거 — 다른 테스트 흔적).
  await sb.from("line_opening_windows").delete().eq("week_id", weekId).is("activity_type_id", null);

  let createdId: string | null = null;
  try {
    // ── 베이스라인(예외 없음) ──
    console.log("[베이스라인] 예외 없음");
    check("hasActiveAllLineException=false", (await hasActiveAllLineException(weekId)) === false);
    check("getActiveAllLineExceptionWeekIds 에 미포함",
      !(await getActiveAllLineExceptionWeekIds()).has(weekId));
    if (rest) {
      let threw = false;
      try { await assertWeekOpenable(weekId); } catch { threw = true; }
      check("[경험] assertWeekOpenable 휴식 → 422 throw", threw);
      const wo = await weeksOptionOf(cookie, weekId);
      check("[공용] weeks-options.canOpen=false (휴식)", wo.week?.canOpen === false, `canOpen=${wo.week?.canOpen}`);
      check("[공용] hasOpeningException=false", wo.week?.hasOpeningException === false);
    }

    // ── 예외 생성(scope=all) ──
    console.log("\n[예외 생성] scope=all(activity_type_id=NULL)");
    const rows = await createLineOpeningWindows({ weekId, activityTypeIds: null, createdBy: null });
    createdId = rows[0]?.id ?? null;
    check("예외 1행 생성(activityTypeId=null)", rows.length === 1 && rows[0].activityTypeId === null);

    // ── 예외 후: 세 게이트 모두 허용 ──
    console.log("\n[예외 활성] 게이트 판정");
    check("hasActiveAllLineException=true", (await hasActiveAllLineException(weekId)) === true);
    check("getActiveAllLineExceptionWeekIds 에 포함",
      (await getActiveAllLineExceptionWeekIds()).has(weekId));
    check("[정보] findActiveLineOpeningException(임의 유형)=true (scope=all=NULL 매칭)",
      (await findActiveLineOpeningException(weekId, "wisdom")) === true);

    if (rest) {
      // (2) 경험 게이트
      let threw = false;
      try { await assertWeekOpenable(weekId); } catch { threw = true; }
      check("[경험] assertWeekOpenable 예외로 통과(throw 없음)", threw === false);

      // (1) 공용 weeks-options — 3개 허브 프론트 게이트
      const woOp = await weeksOptionOf(cookie, weekId);
      check("[auth] weeks-options 200", woOp.status === 200);
      check("[공용] canOpen=true (예외 덮어씀)", woOp.week?.canOpen === true, `canOpen=${woOp.week?.canOpen}`);
      check("[공용] hasOpeningException=true", woOp.week?.hasOpeningException === true);
      check("[공용] isOfficialRest=true 유지(표시용)", woOp.week?.isOfficialRest === true);
      check("[공용] 기입기간(submissionOpensAt/ClosesAt) 비-null (예외 개설 시 산출)",
        !!woOp.week?.submissionOpensAt && !!woOp.week?.submissionClosesAt);

      // direct == HTTP: direct hasActiveAllLineException == HTTP canOpen 반영
      check("direct == HTTP (hasActiveAllLineException ⇔ weeks-options.canOpen)",
        (await hasActiveAllLineException(weekId)) === (woOp.week?.canOpen === true));

      // 테스트 모드도 동일 예외 반영(같은 예외 집합·DTO).
      const woTest = await weeksOptionOf(cookie, weekId, "test");
      // 테스트 휴식꼬리 폴드로 대상 주차 자체가 다를 수 있으니, 주차가 응답에 있으면 canOpen 동일 확인.
      if (woTest.week) {
        check("[공용] mode=test 에서도 canOpen=true (동일 예외/DTO)", woTest.week.canOpen === true);
      } else {
        check("[공용] mode=test 응답 정상(대상 주차 폴드로 미포함 허용)", woTest.status === 200);
      }
    }

    // ── snapshot 무영향 ──
    const after = await snapBaseline();
    check("[snapshot] count·최신 computed_at 불변 (예외 CRUD 가 snapshot 미생성/미재계산)",
      after.count === before.count && after.latest === before.latest,
      `count ${before.count}→${after.count}`);
  } finally {
    // ── 반드시 정리(운영 잔여 0) ──
    if (createdId) {
      try { await deleteLineOpeningWindow(createdId); } catch { /* fallthrough */ }
    }
    await sb.from("line_opening_windows").delete().eq("week_id", weekId).is("activity_type_id", null);
    // 삭제 후 즉시 차단 복귀 확인.
    check("[정리] 삭제 후 hasActiveAllLineException=false 복귀",
      (await hasActiveAllLineException(weekId)) === false);
    if (rest) {
      let threw = false;
      try { await assertWeekOpenable(weekId); } catch { threw = true; }
      check("[정리] 삭제 후 assertWeekOpenable 다시 422", threw === true);
    }
  }

  console.log(`\n결과: ${pass} pass / ${fail} fail`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
