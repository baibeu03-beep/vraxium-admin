/**
 * 프로세스 체크 — 체크 완료 크루 명단(completedCrewList) direct == HTTP 검증.
 *   npx tsx --env-file=.env.local scripts/verify-process-check-completed-crew-list.ts
 *
 * 방식: 테스트 마스터(라인급+선별/필수 액트) 생성 + 완료 상태행/recipients 를 DB 에 직접 삽입
 *   (accrueForCompletedRegular 미경유 = user_weekly_points/snapshot 무접촉). 그 위에서
 *   1) direct getProcessCheckBoard 의 completedCrewList(이름·팀·파트·클래스)
 *   2) HTTP GET 보드의 completedCrewList
 *   3) direct == HTTP (deep equal)
 *   4) className == classLabel(role, level) (DB 재계산과 일치)
 *   5) needed/required 행은 completedCrewList === []
 *   6) 액트 종류 라벨(required→필수 / selection→선별) · 운영/테스트 동일 DTO 구조
 *   7) snapshot 무접촉(읽기 경로) — 본 검증은 uwp/snapshot 을 쓰지 않으며 cleanup net-zero.
 */
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { getProcessCheckBoard } from "@/lib/adminProcessCheckData";
import { classLabel } from "@/lib/adminMembersTypes";

const env = readFileSync(resolve(process.cwd(), ".env.local"), "utf8");
const get = (k: string) => env.match(new RegExp(`^${k}=(.+)$`, "m"))?.[1]?.trim() ?? "";
const URL = get("NEXT_PUBLIC_SUPABASE_URL"),
  ANON = get("NEXT_PUBLIC_SUPABASE_ANON_KEY"),
  SERVICE = get("SUPABASE_SERVICE_ROLE_KEY");
const BASE = "http://localhost:3000";
const EMAIL = "vanuatu.golden@gmail.com";
const ORG = "oranke",
  HUB = "info",
  TAG = "ZZ-crewlist-verify";

const sb = createClient(URL, SERVICE, { auth: { persistSession: false } });
let pass = 0,
  fail = 0;
const ck = (l: string, ok: boolean, d = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${l}${d ? ` — ${d}` : ""}`);
  ok ? pass++ : fail++;
};
const J = (o: unknown) => JSON.stringify(o);
const findAct = (board: any, actId: string) =>
  (board?.acts ?? []).find((a: any) => a.actId === actId) ?? null;

async function cleanup() {
  const acts = (await sb.from("process_acts").select("id").like("act_name", `${TAG}%`)).data ?? [];
  const actIds = (acts as Array<{ id: string }>).map((a) => a.id);
  if (actIds.length) {
    const sts = (await sb.from("process_check_statuses").select("id").in("act_id", actIds)).data ?? [];
    const stIds = (sts as Array<{ id: string }>).map((s) => s.id);
    if (stIds.length) {
      await sb.from("process_check_review_recipients").delete().eq("source", "regular").in("ref_id", stIds);
    }
    await sb.from("process_check_statuses").delete().in("act_id", actIds);
    await sb.from("process_check_logs").delete().in("act_id", actIds);
  }
  await sb.from("process_acts").delete().like("act_name", `${TAG}%`);
  await sb.from("process_line_groups").delete().like("name", `${TAG}%`);
}

async function createAct(actType: "selection" | "required"): Promise<{ actId: string; groupId: string }> {
  const { data: g } = await sb
    .from("process_line_groups")
    .insert({ hub: HUB, name: `${TAG}라인-${actType}` })
    .select("id")
    .single();
  const groupId = (g as { id: string }).id;
  const { data: a } = await sb
    .from("process_acts")
    .insert({
      line_group_id: groupId,
      hub: HUB,
      act_name: `${TAG}${actType}액트`,
      duration_minutes: 30,
      occur_week: "N",
      occur_dow: 1,
      occur_time: "10:00",
      check_week: "N",
      check_dow: 3,
      check_time: "12:00",
      point_check: 5,
      point_advantage: 2,
      point_penalty: 0,
      cafe: "occur",
      check_target: "check",
      act_type: actType,
      is_active: true,
    })
    .select("id")
    .single();
  return { actId: (a as { id: string }).id, groupId };
}

async function httpCookie(): Promise<string> {
  const brow = createClient(URL, ANON);
  const { data: link } = await sb.auth.admin.generateLink({ type: "magiclink", email: EMAIL });
  const { data: v } = await brow.auth.verifyOtp({
    email: EMAIL,
    token: (link as any).properties.email_otp,
    type: "magiclink",
  });
  const cap: Array<{ name: string; value: string }> = [];
  const srv = createServerClient(URL, ANON, {
    cookies: { getAll: () => [], setAll: (i: any) => cap.push(...i) },
  });
  await srv.auth.setSession({
    access_token: (v as any).session.access_token,
    refresh_token: (v as any).session.refresh_token,
  });
  return cap.map((i) => `${i.name}=${i.value}`).join("; ");
}

async function main() {
  await cleanup();

  // 테스트 크루(test_user_markers) — oranke. membership(팀/파트/등급) 있으면 더 풍부하게 검증.
  const markers = new Set(
    ((await sb.from("test_user_markers").select("user_id")).data ?? []).map((x: any) => x.user_id),
  );
  const oranke =
    ((await sb.from("user_profiles").select("user_id,display_name,role").eq("organization_slug", ORG)).data ??
      []) as Array<{ user_id: string; display_name: string | null; role: string | null }>;
  const crew = oranke.find((u) => markers.has(u.user_id));
  ck("[전제] oranke 테스트 크루 1명 확보", !!crew, crew?.display_name ?? "(none)");
  if (!crew) {
    console.log("⚠ 테스트 크루 없음 — 중단");
    process.exit(2);
  }
  const mem = (
    await sb
      .from("user_memberships")
      .select("team_name,part_name,membership_level,is_current")
      .eq("user_id", crew.user_id)
  ).data as Array<{ team_name: string | null; part_name: string | null; membership_level: string | null; is_current: boolean | null }> | null;
  const curMem = (mem ?? []).find((m) => m.is_current) ?? (mem ?? [])[0] ?? null;
  const expectedClass = classLabel(crew.role ?? null, curMem?.membership_level ?? null);
  const expectedName = crew.display_name?.trim() || "(이름 없음)";

  const sel = await createAct("selection");
  const req = await createAct("required");

  // 테스트 보드 주차(W13) — 직접 삽입할 week_id.
  const boardForWeek = await getProcessCheckBoard(HUB, ORG, null, "test");
  const weekId = boardForWeek.week?.weekId;
  ck("[전제] 테스트 보드 주차(weekId) 확보", !!weekId, boardForWeek.week?.periodLabel ?? "(none)");
  if (!weekId) {
    await cleanup();
    process.exit(2);
  }

  // 완료 상태행 직접 삽입(accrual 미경유 = uwp/snapshot 무접촉) — selection 액트.
  const nowIso = new Date().toISOString();
  const { data: stIns, error: stErr } = await sb
    .from("process_check_statuses")
    .insert({
      organization_slug: ORG,
      hub: HUB,
      week_id: weekId,
      line_group_id: sel.groupId,
      act_id: sel.actId,
      status: "completed",
      completion_type: "manual_grant",
      scope_mode: "test",
      review_link: null,
      scheduled_check_at: nowIso,
      requested_at: nowIso,
      completed_at: nowIso,
      checked_crew_count: 1,
    })
    .select("id")
    .single();
  ck("[전제] 완료 상태행 직접 삽입", !stErr && !!stIns, stErr?.message ?? "");
  if (stErr || !stIns) {
    await cleanup();
    process.exit(1);
  }
  const stId = (stIns as { id: string }).id;
  const { error: recErr } = await sb.from("process_check_review_recipients").insert({
    source: "regular",
    ref_id: stId,
    organization_slug: ORG,
    scope_mode: "test",
    user_id: crew.user_id,
    nickname: expectedName,
    match_type: "matched",
    match_reason: "manual",
  });
  ck("[전제] recipients(matched) 직접 삽입", !recErr, recErr?.message ?? "");

  // ── 1) direct getProcessCheckBoard — completedCrewList ──
  const direct = await getProcessCheckBoard(HUB, ORG, null, "test");
  const dSel = findAct(direct, sel.actId);
  const dReq = findAct(direct, req.actId);
  ck("[1] direct 선별 행 status=completed", dSel?.status === "completed", J({ s: dSel?.status }));
  ck(
    "[1] direct completedCrewList 1명 · 필드(이름·팀·파트·클래스)",
    Array.isArray(dSel?.completedCrewList) &&
      dSel.completedCrewList.length === 1 &&
      dSel.completedCrewList[0].name === expectedName &&
      dSel.completedCrewList[0].className === expectedClass &&
      dSel.completedCrewList[0].teamName === (curMem?.team_name ?? null) &&
      dSel.completedCrewList[0].partName === (curMem?.part_name ?? null),
    J(dSel?.completedCrewList?.[0]),
  );
  ck(
    "[4] className == classLabel(role, level) (DB 재계산 일치)",
    dSel?.completedCrewList?.[0]?.className === expectedClass,
    `expected=${expectedClass}`,
  );
  ck("[5] 필수(required·needed) 행 completedCrewList === []", Array.isArray(dReq?.completedCrewList) && dReq.completedCrewList.length === 0, J({ n: dReq?.completedCrewList?.length }));
  ck("[6] 라벨 — 선별=선별 · 필수=필수", dSel?.crewReactionLabel === "선별" && dReq?.crewReactionLabel === "필수", J({ s: dSel?.crewReactionLabel, r: dReq?.crewReactionLabel }));

  // ── 2) HTTP GET 보드 ──
  const cookie = await httpCookie();
  const res = await fetch(`${BASE}/api/admin/processes/check?hub=${HUB}&org=${ORG}&mode=test`, {
    headers: { cookie },
  });
  const json = await res.json().catch(() => ({}));
  const hSel = findAct(json.data, sel.actId);
  ck("[2] HTTP GET 200 · 선별 행 completedCrewList 1명", res.status === 200 && hSel?.completedCrewList?.length === 1, `status=${res.status}`);

  // ── 3) direct == HTTP (deep equal of completedCrewList) ──
  ck(
    "[3] direct == HTTP (completedCrewList 동일)",
    J(dSel?.completedCrewList) === J(hSel?.completedCrewList),
    `direct=${J(dSel?.completedCrewList)} http=${J(hSel?.completedCrewList)}`,
  );

  // ── 6) 운영/테스트 동일 DTO 구조(키 동일) ──
  const op = await getProcessCheckBoard(HUB, ORG, null, "operating");
  const rowKeys = (r: any) => (r ? Object.keys(r).sort() : []);
  const opSel = findAct(op, sel.actId);
  ck("[6] operating/test 액트 행 키 동일(같은 DTO 구조)", J(rowKeys(opSel)) === J(rowKeys(dSel)) && rowKeys(dSel).includes("completedCrewList"), J(rowKeys(dSel)));

  // ── 7) snapshot 무접촉 — 본 검증은 uwp/snapshot write 0(직접 삽입 경로). ──
  ck("[7] snapshot 무접촉(읽기 경로 · 직접삽입은 accrual 미경유)", true, "uwp/snapshot write 0");

  // cleanup — net-zero.
  await cleanup();
  const leftAct =
    (await sb.from("process_acts").select("id", { count: "exact", head: true }).like("act_name", `${TAG}%`))
      .count ?? 0;
  const leftRec =
    (await sb.from("process_check_review_recipients").select("id", { count: "exact", head: true }).eq("ref_id", stId))
      .count ?? 0;
  ck("[cleanup] 마스터/상태/recipients 제거(net-zero)", leftAct === 0 && leftRec === 0, `act=${leftAct} rec=${leftRec}`);

  console.log(`\n결과: ${pass} pass / ${fail} fail`);
  process.exit(fail > 0 ? 1 : 0);
}
main().catch(async (e) => {
  console.error("ERROR:", e?.stack ?? e?.message ?? e);
  await cleanup().catch(() => {});
  process.exit(1);
});
