/**
 * 라인급(체크)↔라인(개설) 분리 검증 (dev server 필요).
 *   §9  프로세스 등록 신규 라인급 → 액트 체크 자동 노출(코드 상수 수정 없이)
 *   §15 독립성: actCheck(7) 변경 → 라인개설(8) 통계 불변 / 라인개설(8) 변경 → 액트체크(7) 통계 불변
 *   §16 일반/mode=test 파리티(정보·클럽·역량 액트 체크 = 동일)
 *   npx tsx --env-file=.env.local scripts/verify-act-line-split.ts
 */
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { loadSeasonWeeks } from "@/lib/adminSeasonWeeksData";
import { loadTeamPartsInfoActCheckManagement } from "@/lib/adminTeamPartsInfoActCheckData";
import { loadTeamPartsInfoLineOpeningManagement } from "@/lib/adminTeamPartsInfoLineOpeningData";
import { loadTeamPartsInfoWeekDetail } from "@/lib/adminTeamPartsInfoWeekDetailData";

const BASE = "http://localhost:3000";
const u = process.env.NEXT_PUBLIC_SUPABASE_URL!, a = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, s = process.env.SUPABASE_SERVICE_ROLE_KEY!;
let failed = 0;
const ck = (n: string, ok: boolean, d?: unknown) => { console.log(`${ok ? "✅" : "❌"} ${n}${d !== undefined ? " :: " + JSON.stringify(d) : ""}`); if (!ok) failed++; };
async function cookie(): Promise<string> {
  const { data: adm } = await supabaseAdmin.from("admin_users").select("email").eq("is_active", true).not("email", "is", null).limit(1);
  const email = (adm?.[0] as any)?.email;
  const A = createClient(u, s), N = createClient(u, a);
  const { data: l } = await A.auth.admin.generateLink({ type: "magiclink", email });
  const { data: v } = await N.auth.verifyOtp({ email, token: (l as any).properties.email_otp, type: "magiclink" });
  const cap: any[] = [];
  const sv = createServerClient(u, a, { cookies: { getAll: () => [], setAll: (it) => cap.push(...it.map(({ name, value }: any) => ({ name, value }))) } });
  await sv.auth.setSession({ access_token: (v as any).session.access_token, refresh_token: (v as any).session.refresh_token });
  return cap.map((c) => `${c.name}=${c.value}`).join("; ");
}
const openConfirm = (cookie: string, weekId: string, org: string, config: unknown) =>
  fetch(`${BASE}/api/admin/team-parts/info/weeks/${weekId}/open-confirm?club=${org}`, {
    method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ config }),
  });

async function main() {
  const h = await fetch(`${BASE}/api/health`).catch(() => null);
  if (!h?.ok) { console.log("❌ dev server 미기동"); process.exit(2); }
  const cookieStr = await cookie();
  const { rows } = await loadSeasonWeeks();
  const weekId = (rows.find((r) => !r.is_official_rest && r.week_start_date) ?? rows[0]).week_id;
  const org = "encre";
  const load = (mode: "operating" | "test") => loadTeamPartsInfoActCheckManagement({ weekId, organization: org, mode });
  const loadLine = () => loadTeamPartsInfoLineOpeningManagement({ weekId, organization: org, mode: "operating" });
  const detail = () => loadTeamPartsInfoWeekDetail({ weekId, organization: org, mode: "operating" });

  const snapBefore = await supabaseAdmin.from("cluster4_weekly_card_snapshots").select("*", { count: "exact", head: true });

  const d0 = await detail();
  const infoLg = d0.openingConfig.actCheck.info[0]?.lineGroupId;
  const infoLine = d0.openingConfig.lineOpening.practicalInfo[0]?.lineId;
  console.log(`   week=${weekId.slice(0, 8)} org=${org} infoLg=${infoLg?.slice(0, 8)} infoLine=${infoLine}`);

  // ── §15 독립성 A: actCheck(7) 변경 → 라인개설(8) 통계 불변 ──
  await openConfirm(cookieStr, weekId, org, { practicalInfo: { [infoLine!]: true }, practicalExperience: {}, practicalCompetency: { checked: true }, actCheck: { info: { [infoLg!]: true }, experience: {}, club: {} } });
  const lineA = await loadLine();
  await openConfirm(cookieStr, weekId, org, { practicalInfo: { [infoLine!]: true }, practicalExperience: {}, practicalCompetency: { checked: true }, actCheck: { info: { [infoLg!]: false }, experience: {}, club: {} } });
  const lineB = await loadLine();
  ck("§15 actCheck 변경 → 라인개설 통계 불변", JSON.stringify(lineA.summary) === JSON.stringify(lineB.summary) && JSON.stringify(lineA.practicalInfo.summary) === JSON.stringify(lineB.practicalInfo.summary), { A: lineA.practicalInfo.summary, B: lineB.practicalInfo.summary });
  const actAfterLineToggle_before = await load("operating");

  // ── §15 독립성 B: 라인개설(8) 변경 → 액트체크(7) 통계 불변 ──
  await openConfirm(cookieStr, weekId, org, { practicalInfo: { [infoLine!]: false }, practicalExperience: {}, practicalCompetency: { checked: true }, actCheck: { info: { [infoLg!]: false }, experience: {}, club: {} } });
  const actAfterLineToggle_after = await load("operating");
  ck("§15 라인개설 변경 → 액트체크 정보 통계 불변", JSON.stringify(actAfterLineToggle_before.practicalInfo.summary) === JSON.stringify(actAfterLineToggle_after.practicalInfo.summary), { before: actAfterLineToggle_before.practicalInfo.summary, after: actAfterLineToggle_after.practicalInfo.summary });

  // ── §16 일반/test 파리티(정보·클럽·역량 액트 체크 = 동일) ──
  const op = await load("operating"), te = await load("test");
  ck("§16 정보 액트체크 operating==test", JSON.stringify(op.practicalInfo) === JSON.stringify(te.practicalInfo));
  ck("§16 클럽 액트체크 operating==test", JSON.stringify(op.clubOverall) === JSON.stringify(te.clubOverall));
  ck("§16 역량 액트체크 operating==test", JSON.stringify(op.practicalCompetency) === JSON.stringify(te.practicalCompetency));

  // cleanup config.
  await supabaseAdmin.from("cluster4_week_opening_configs").delete().eq("week_id", weekId).eq("organization_slug", org);

  // ── §9 프로세스 등록 신규 라인급 → 액트 체크 자동 노출(코드 상수 수정 없이) ──
  const NEW_LG = "0c1f0000-0000-4000-8000-0000000000ff";
  await supabaseAdmin.from("process_line_groups").delete().eq("id", NEW_LG);
  const { error: lgErr } = await supabaseAdmin.from("process_line_groups").insert({ id: NEW_LG, hub: "info", name: "[검증] 자동노출 라인급", sort_order: 99, is_active: true });
  ck("§9 신규 info 라인급 등록", !lgErr, lgErr?.message);
  const dAfter = await detail();
  ck("§9 신규 라인급 → detail actCheck.info 자동 노출", dAfter.openingConfig.actCheck.info.some((g) => g.lineGroupId === NEW_LG));
  const acAfter = await load("operating");
  ck("§9 신규 라인급 → act-check practicalInfo 자동 노출", acAfter.practicalInfo.lines.some((l) => l.lineId === NEW_LG));
  // HTTP 반영도 확인.
  const httpAc = await (await fetch(`${BASE}/api/admin/team-parts/info/weeks/${weekId}/act-check-management?club=${org}`, { headers: { cookie: cookieStr } })).json();
  ck("§9 HTTP 에도 신규 라인급 노출", httpAc.data?.practicalInfo?.lines?.some((l: any) => l.lineId === NEW_LG));
  // cleanup.
  await supabaseAdmin.from("process_line_groups").delete().eq("id", NEW_LG);

  const snapAfter = await supabaseAdmin.from("cluster4_weekly_card_snapshots").select("*", { count: "exact", head: true });
  ck("snapshot 무변경(count)", (snapBefore.count ?? 0) === (snapAfter.count ?? 0), { before: snapBefore.count, after: snapAfter.count });

  console.log(failed === 0 ? "\n✅ ALL PASS" : `\n❌ ${failed} FAIL`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
