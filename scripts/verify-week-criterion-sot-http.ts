/**
 * [주차 기준값 SoT 파리티 · 실 HTTP]
 *   같은 주차 × 같은 조직에서 아래 세 화면이 **같은 기준값**을 내는지 실제 API 로 검증한다.
 *     (1) /admin/team-parts/info/weeks/*          "이번 주 활동 인정 개수"
 *          → GET /api/admin/team-parts/info/weeks/{weekId}?club={org}[&mode=test]
 *            .data.managedWeek.weekRecognitionCount
 *     (2) /admin/team-parts/info/crew-week-results/*  "주차 성장 성공 별 기준"
 *          → GET .../crew-week-results/{org}/{weekId}?action=preview[&mode=test]  .data.preview.criterionPointA
 *          → GET .../crew-week-results?organization={org}[&mode=test]             .data.cells[].criterionPointA
 *     (3) 크루 페이지 동일 기준값
 *          → GET /api/admin/crews/{legacyUserId}/cluster4/weekly-growth
 *            .data.weeks[].experienceVerdict.checkGate.required
 *   권위 원천 = cluster4_week_opening_configs.recognition_count_n[week, org] (오픈 확인 시점 latch).
 *   recognition-preview(POST) 는 "지금 오픈 확인하면 확정될 값" = 기준값이 아니므로 대조만 하고
 *   불일치를 실패로 세지 않는다(보조 안내 전용임을 회귀 검증).
 *
 *   dev server(:3000) 필요.
 *   run: node_modules/.bin/tsx --env-file=.env.local scripts/verify-week-criterion-sot-http.ts
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- 검증 스크립트: 외부 API 응답을 그대로 훑는다. */
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { ORGANIZATIONS, type OrganizationSlug } from "@/lib/organizations";

const BASE = process.env.BASE ?? "http://localhost:3000";
const u = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const a = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const s = process.env.SUPABASE_SERVICE_ROLE_KEY!;

let failed = 0;
const ck = (n: string, ok: boolean, d?: unknown) => {
  console.log(`${ok ? "✅" : "❌"} ${n}${d !== undefined ? " :: " + JSON.stringify(d) : ""}`);
  if (!ok) failed++;
};

async function cookieHeader(): Promise<string> {
  const { data: adm } = await supabaseAdmin
    .from("admin_users")
    .select("email")
    .eq("is_active", true)
    .not("email", "is", null)
    .limit(1);
  const email = (adm?.[0] as { email: string } | undefined)?.email;
  if (!email) throw new Error("활성 관리자 계정을 찾지 못했습니다.");
  const A = createClient(u, s);
  const N = createClient(u, a);
  const { data: l } = await A.auth.admin.generateLink({ type: "magiclink", email });
  const { data: v } = await N.auth.verifyOtp({
    email,
    token: (l as any).properties.email_otp,
    type: "magiclink",
  });
  const cap: Array<{ name: string; value: string }> = [];
  const sv = createServerClient(u, a, {
    cookies: { getAll: () => [], setAll: (it: any[]) => cap.push(...it.map(({ name, value }) => ({ name, value }))) },
  });
  await sv.auth.setSession({
    access_token: (v as any).session.access_token,
    refresh_token: (v as any).session.refresh_token,
  });
  console.log(`admin = ${email}`);
  return cap.map((c) => `${c.name}=${c.value}`).join("; ");
}

type Fetched = { status: number; json: any };
async function get(path: string, cookie: string): Promise<Fetched> {
  const r = await fetch(`${BASE}${path}`, { headers: { cookie }, cache: "no-store" });
  let json: any = null;
  try {
    json = await r.json();
  } catch {
    /* non-json */
  }
  return { status: r.status, json };
}
async function post(path: string, cookie: string, body: unknown): Promise<Fetched> {
  const r = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  let json: any = null;
  try {
    json = await r.json();
  } catch {
    /* non-json */
  }
  return { status: r.status, json };
}

async function main() {
  const cookie = await cookieHeader();

  // ── 대상: recognition_count_n 이 확정된 (주차 × 조직) 전부 ───────────────────
  const { data: cfgRows } = await supabaseAdmin
    .from("cluster4_week_opening_configs")
    .select("week_id, organization_slug, recognition_count_n, config")
    .eq("open_confirmed", true)
    .not("recognition_count_n", "is", null);
  const targets = ((cfgRows ?? []) as Array<any>).filter((r) =>
    (ORGANIZATIONS as readonly string[]).includes(r.organization_slug),
  );
  const { data: wkRows } = await supabaseAdmin
    .from("weeks")
    .select("id, season_key, week_number")
    .in("id", [...new Set(targets.map((t) => t.week_id))]);
  const weekLabel = new Map(
    ((wkRows ?? []) as Array<any>).map((w) => [w.id, `${w.season_key} W${w.week_number}`]),
  );
  console.log(`\n대상 (주차×조직) = ${targets.length}건\n`);

  // 조직별 크루 후보(크루 페이지 대조용) — /api/admin/crews/{profileUserId} 는 UUID(user_profiles.user_id).
  //   후보 = 대상 주차에 실제 uws 행이 있는 크루(카드가 생성되는 코호트).
  const { data: wkAll } = await supabaseAdmin
    .from("weeks")
    .select("id, start_date")
    .in("id", [...new Set(targets.map((t) => t.week_id))]);
  const startDates = [
    ...new Set(((wkAll ?? []) as Array<any>).map((w) => w.start_date).filter(Boolean)),
  ];
  const { data: uwsRows } = await supabaseAdmin
    .from("user_week_statuses")
    .select("user_id")
    .in("week_start_date", startDates)
    .limit(400);
  const cohort = [...new Set(((uwsRows ?? []) as Array<any>).map((r) => r.user_id))];
  const crewsByOrg = new Map<string, string[]>();
  if (cohort.length > 0) {
    const { data: profs } = await supabaseAdmin
      .from("user_profiles")
      .select("user_id, organization_slug")
      .in("user_id", cohort.slice(0, 300));
    for (const p of (profs ?? []) as Array<any>) {
      const list = crewsByOrg.get(p.organization_slug) ?? [];
      if (list.length < 4) crewsByOrg.set(p.organization_slug, [...list, p.user_id]);
    }
  }

  const rows: Array<Record<string, unknown>> = [];

  for (const t of targets) {
    const org = t.organization_slug as OrganizationSlug;
    const weekId = t.week_id as string;
    const authoritative = t.recognition_count_n as number;
    const label = `${org} ${weekLabel.get(weekId) ?? weekId}`;
    console.log(`\n──── ${label} · DB recognition_count_n = ${authoritative}`);

    for (const mode of ["operating", "test"] as const) {
      const q = mode === "test" ? "&mode=test" : "";
      const qOnly = mode === "test" ? "?mode=test" : "";

      // (1) weeks 화면 API
      const wd = await get(`/api/admin/team-parts/info/weeks/${weekId}?club=${org}${q}`, cookie);
      const weeksVal = wd.json?.data?.managedWeek?.weekRecognitionCount ?? null;
      ck(`[${label}][${mode}] weeks API 200`, wd.status === 200, { status: wd.status });
      ck(
        `[${label}][${mode}] weeks.managedWeek.weekRecognitionCount == DB`,
        weeksVal === authoritative,
        { got: weeksVal, db: authoritative },
      );
      ck(
        `[${label}][${mode}] weeks API weekId/org 일치`,
        wd.json?.data?.managedWeek?.weekId === weekId || wd.json?.data?.managedWeek?.id === weekId,
        {
          weekId: wd.json?.data?.managedWeek?.weekId ?? wd.json?.data?.managedWeek?.id ?? null,
          expect: weekId,
        },
      );

      // (2a) crew-week-results 상세(예비) API
      const cd = await get(
        `/api/admin/team-parts/info/crew-week-results/${org}/${weekId}?action=preview${q}`,
        cookie,
      );
      const previewVal = cd.json?.data?.preview?.criterionPointA ?? null;
      ck(`[${label}][${mode}] crew-week-results preview 200`, cd.status === 200, { status: cd.status });
      ck(
        `[${label}][${mode}] preview.criterionPointA == DB`,
        previewVal === authoritative,
        { got: previewVal, db: authoritative },
      );

      // (2b) crew-week-results 목록(투영) API — 조직별 경로
      const cl = await get(
        `/api/admin/team-parts/info/crew-week-results?organization=${org}${q}&pageSize=60`,
        cookie,
      );
      const cell = (cl.json?.data?.cells ?? []).find(
        (c: any) => c.weekId === weekId && c.organizationSlug === org,
      );
      ck(`[${label}][${mode}] crew-week-results 목록 200`, cl.status === 200, { status: cl.status });
      ck(
        `[${label}][${mode}] cells[].criterionPointA == DB`,
        (cell?.criterionPointA ?? null) === authoritative,
        { got: cell?.criterionPointA ?? null, db: authoritative, snapshot: cell?.publishedRunId != null },
      );

      // (2c) 통합(조직 미지정) 경로 — 같은 셀이 나와야 한다.
      const ci = await get(`/api/admin/team-parts/info/crew-week-results?pageSize=60${qOnly ? "&mode=test" : ""}`, cookie);
      const iCell = (ci.json?.data?.cells ?? []).find(
        (c: any) => c.weekId === weekId && c.organizationSlug === org,
      );
      ck(
        `[${label}][${mode}] 통합 경로 cells[].criterionPointA == 조직별 경로`,
        (iCell?.criterionPointA ?? null) === (cell?.criterionPointA ?? null),
        { integrated: iCell?.criterionPointA ?? null, perOrg: cell?.criterionPointA ?? null },
      );

      // (참고) recognition-preview = "지금 오픈 확인하면 확정될 값"(기준값 아님)
      const rp = await post(
        `/api/admin/team-parts/info/weeks/${weekId}/recognition-preview?club=${org}${q}`,
        cookie,
        { config: t.config ?? {} },
      );
      const rpVal = rp.json?.data?.recognitionCountN ?? null;

      rows.push({
        org,
        week: weekLabel.get(weekId) ?? weekId,
        mode,
        db: authoritative,
        weeksApi: weeksVal,
        crewWeekPreview: previewVal,
        crewWeekCell: cell?.criterionPointA ?? null,
        integratedCell: iCell?.criterionPointA ?? null,
        snapshotUsed: cell?.publishedRunId != null,
        recognitionPreview_참고: rpVal,
      });
    }

  }

  // ── (3) 크루 페이지 — checkGate.required (= fetchWeekRecognitionRequiredByOrg → 같은 컬럼) ─────
  //   checkGate 는 조건이 맞는 크루 카드에만 실린다. 조직당 소수 크루를 **1회씩만** 호출해(dev 서버
  //   포화 방지) 관측된 (주차→required) 를 모아 DB latch 와 대조한다.
  console.log("\n════ 크루 페이지 기준값 대조 ════");
  const dbByOrgWeek = new Map<string, number>();
  for (const t of targets) dbByOrgWeek.set(`${t.organization_slug}|${t.week_id}`, t.recognition_count_n);
  for (const org of ORGANIZATIONS) {
    let observedAny = false;
    for (const crewId of crewsByOrg.get(org) ?? []) {
      const cg = await get(`/api/admin/crews/${crewId}/cluster4/weekly-growth`, cookie);
      if (cg.status !== 200) {
        console.log(`   ⚠ ${org}/${crewId} weekly-growth status=${cg.status}`);
        continue;
      }
      const weeksArr: any[] = cg.json?.data?.weeklyCards ?? [];
      for (const w of weeksArr) {
        const req = w?.experienceGrowth?.checkGate?.required ?? null;
        if (req == null) continue;
        const key = `${org}|${w.weekId}`;
        if (!dbByOrgWeek.has(key)) continue; // 대상 주차만
        ck(
          `[${org} ${weekLabel.get(w.weekId) ?? w.weekId}] 크루 checkGate.required == DB latch`,
          req === dbByOrgWeek.get(key),
          { got: req, db: dbByOrgWeek.get(key), crew: crewId, earned: w?.experienceGrowth?.checkGate?.earned ?? null },
        );
        observedAny = true;
      }
      if (observedAny) break;
    }
    if (!observedAny) {
      console.log(`   ℹ ${org}: 표본 크루에서 대상 주차 checkGate 관측 없음(그 주차에 기준 게이트 미적용).`);
    }
  }

  // ── 일반 모드 vs 테스트 모드 응답 동일 여부 ─────────────────────────────────
  console.log("\n════ 모드 비교표 ════");
  console.table(rows);
  const byKey = new Map<string, Record<string, unknown>[]>();
  for (const r of rows) {
    const k = `${r.org}|${r.week}`;
    byKey.set(k, [...(byKey.get(k) ?? []), r]);
  }
  for (const [k, pair] of byKey) {
    if (pair.length !== 2) continue;
    const [op, te] = pair;
    const same =
      op.weeksApi === te.weeksApi &&
      op.crewWeekPreview === te.crewWeekPreview &&
      op.crewWeekCell === te.crewWeekCell &&
      op.integratedCell === te.integratedCell;
    ck(`[${k}] 일반 == mode=test (기준값 전 경로)`, same, { operating: op, test: te });
  }

  console.log(`\n${failed === 0 ? "ALL PASS" : `${failed} FAILED`}`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
