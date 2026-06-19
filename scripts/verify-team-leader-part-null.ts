/**
 * 팀장 part=null 정책 검증.
 *   npx tsx --env-file=.env.local scripts/verify-team-leader-part-null.ts
 *
 * 실제 DB 에서 (1) 일반 크루+파트 (2) 파트장+파트 (3) 팀장 을 찾아 다음을 검증한다.
 *   - 일반/파트장: 실데이터 무변경. direct(getCrewDetailDto) == HTTP, 표시(팀/파트/클래스) 정상.
 *   - 팀장: 운영 팀장은 모두 파트가 배정돼 있으므로(현 데이터) 테스트 팀장 1명의 current_part_name 을
 *     임시로 null 로 만든 창(window) 안에서 정책을 검증하고 즉시 원복(net-zero)한다.
 *       · 크루 상세(/admin/members/[id]) : 팀 표시 · 파트 null · 클래스 "운영진(팀장)" · HTTP 200 · direct==HTTP
 *       · 멤버 목록(/admin/members)       : currentPartName null · currentTeamName 표시 · statusLabel "팀장" · direct==HTTP
 *       · 체크 크루 명단(process check)   : 완료 명단 행 teamName 표시(폴백) · partName null · className "운영진(팀장)" · direct==HTTP
 *     → part=null 이 validation error / 필수값 누락 / 미배정 경고 / 조회 실패 중 어느 곳에서도 문제를 일으키지 않음을 확인.
 *   - snapshot: 검증 대상 user 의 cluster4_weekly_cards_snapshot(is_stale/computed_at/dto_version) 읽기 전후 무변경
 *     (읽기 경로 = snapshot 무접촉 · 재계산 불필요).
 *
 * 부수효과: 체크 명단 검증을 위해 process_acts/line_groups/statuses/recipients 를 직접 삽입(accrual 미경유 =
 *   user_weekly_points/snapshot 무접촉)했다가 net-zero 로 정리한다.
 */
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { getCrewDetailDto } from "@/lib/adminCrewDetailData";
import { listMembers } from "@/lib/adminMembersData";
import { getProcessCheckBoard } from "@/lib/adminProcessCheckData";

const env = readFileSync(resolve(process.cwd(), ".env.local"), "utf8");
const get = (k: string) => env.match(new RegExp(`^${k}=(.+)$`, "m"))?.[1]?.trim() ?? "";
const URL = get("NEXT_PUBLIC_SUPABASE_URL"),
  ANON = get("NEXT_PUBLIC_SUPABASE_ANON_KEY"),
  SERVICE = get("SUPABASE_SERVICE_ROLE_KEY");
const BASE = "http://localhost:3000";
const EMAIL = "vanuatu.golden@gmail.com";
const TAG = "ZZ-tl-partnull-verify";

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

type Prof = {
  user_id: string;
  display_name: string | null;
  role: string | null;
  organization_slug: string | null;
  current_team_name: string | null;
  current_part_name: string | null;
};
type Mem = {
  user_id: string;
  team_name: string | null;
  part_name: string | null;
  membership_level: string | null;
  is_current: boolean | null;
};

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

async function pcCleanup() {
  const acts = (await sb.from("process_acts").select("id").like("act_name", `${TAG}%`)).data ?? [];
  const actIds = (acts as Array<{ id: string }>).map((a) => a.id);
  if (actIds.length) {
    const sts = (await sb.from("process_check_statuses").select("id").in("act_id", actIds)).data ?? [];
    const stIds = (sts as Array<{ id: string }>).map((s) => s.id);
    if (stIds.length)
      await sb.from("process_check_review_recipients").delete().eq("source", "regular").in("ref_id", stIds);
    await sb.from("process_check_statuses").delete().in("act_id", actIds);
    await sb.from("process_check_logs").delete().in("act_id", actIds);
  }
  await sb.from("process_acts").delete().like("act_name", `${TAG}%`);
  await sb.from("process_line_groups").delete().like("name", `${TAG}%`);
}

async function main() {
  await pcCleanup();

  // ── 표본 수집 ──────────────────────────────────────────────────────────
  const profs =
    ((
      await sb
        .from("user_profiles")
        .select("user_id,display_name,role,organization_slug,current_team_name,current_part_name")
    ).data ?? []) as Prof[];
  const ids = profs.map((p) => p.user_id);
  const mems: Mem[] = [];
  for (let i = 0; i < ids.length; i += 500) {
    const { data } = await sb
      .from("user_memberships")
      .select("user_id,team_name,part_name,membership_level,is_current")
      .in("user_id", ids.slice(i, i + 500));
    mems.push(...((data ?? []) as Mem[]));
  }
  const curMem = new Map<string, Mem>();
  for (const m of mems) {
    const ex = curMem.get(m.user_id);
    if (!ex || (m.is_current && !ex.is_current)) curMem.set(m.user_id, m);
  }
  const markers = new Set(
    ((await sb.from("test_user_markers").select("user_id")).data ?? []).map((x: any) => x.user_id),
  );
  const hasPart = (s: string | null | undefined) => !!s && s.trim() !== "" && s.trim() !== "일반";

  // 일반 크루: membership_level=일반 · 파트 O (실데이터 무변경)
  const regular =
    profs.find((p) => {
      const m = curMem.get(p.user_id);
      return (p.role === "crew" || p.role === null) && m?.membership_level === "일반" && hasPart(m?.part_name);
    }) ?? null;
  // 파트장: membership_level=심화(파트장) · 파트 O (role 은 null 일 수 있음 — 등급 SoT) (실데이터 무변경)
  const partLeader =
    profs.find((p) => {
      const m = curMem.get(p.user_id);
      return m?.membership_level === "심화(파트장)" && hasPart(m?.part_name);
    }) ?? null;
  // 테스트 팀장: role=team_leader · test_user_markers · 팀 O (current_part_name 은 임시 null 처리 후 원복)
  const testTL =
    profs.find(
      (p) => p.role === "team_leader" && markers.has(p.user_id) && !!p.current_team_name,
    ) ?? null;

  ck("[전제] 일반 크루(파트 O) 1명", !!regular, regular ? `${regular.display_name}/파트=${curMem.get(regular.user_id)?.part_name}` : "없음");
  ck("[전제] 파트장(파트 O) 1명", !!partLeader, partLeader ? `${partLeader.display_name}/파트=${curMem.get(partLeader.user_id)?.part_name}` : "없음");
  ck("[전제] 테스트 팀장 1명", !!testTL, testTL ? `${testTL.display_name}/${testTL.organization_slug}/팀=${testTL.current_team_name}/파트(원본)=${testTL.current_part_name}` : "없음");

  const adminId = profs.find((p) => p.role === "super_admin" || p.role === "admin")?.user_id ?? null;
  const cookie = await httpCookie();

  // ── PART A: 일반/파트장 — 실데이터 direct == HTTP ──────────────────────
  for (const s of [
    { tag: "일반", p: regular, expectClass: "정규" },
    { tag: "파트장", p: partLeader, expectClass: "심화(파트장)" },
  ].filter((x) => x.p) as Array<{ tag: string; p: Prof; expectClass: string }>) {
    const uid = s.p.user_id;
    console.log(`\n── [${s.tag}] ${s.p.display_name} ──`);
    const direct = await getCrewDetailDto(uid, { generatedBy: adminId ?? undefined }).catch((e: any) => {
      ck(`[1] direct getCrewDetailDto`, false, e?.message);
      return null;
    });
    const r = await fetch(`${BASE}/api/admin/members/${uid}`, { headers: { cookie } });
    const j = await r.json().catch(() => ({}));
    ck(`[2] HTTP 크루상세 200`, r.status === 200 && j?.success, `status=${r.status}`);
    if (direct && j?.data) {
      ck(`[3] direct == HTTP (team/part/class)`, direct.teamName === j.data.teamName && direct.partName === j.data.partName && direct.classLabel === j.data.classLabel, `d=${J({ t: direct.teamName, p: direct.partName, c: direct.classLabel })}`);
      ck(`[6] ${s.tag} 파트 표시 O · 클래스 "${s.expectClass}"`, hasPart(direct.partName) && direct.classLabel === s.expectClass, J({ p: direct.partName, c: direct.classLabel }));
    }
  }

  // ── PART B: 테스트 팀장 — part=null 창에서 정책 검증 후 원복 ────────────
  if (!testTL) {
    console.log("\n⚠ 테스트 팀장 없음 — 팀장 검증 생략");
  } else {
    const uid = testTL.user_id;
    const org = testTL.organization_slug!;
    // 원복용 원본을 DB 에서 직접 재조회(메모리 맵 신뢰 금지). user_memberships↔user_profiles 동기화
    // 트리거가 있으므로 membership 을 먼저 복원한 뒤 profile 을 명시 복원한다.
    const origProfilePart =
      (((await sb.from("user_profiles").select("current_part_name").eq("user_id", uid)).data ?? [])[0] as any)?.current_part_name ?? null;
    const origMemPart =
      (((await sb.from("user_memberships").select("part_name").eq("user_id", uid).eq("is_current", true)).data ?? [])[0] as any)?.part_name ?? null;
    const snapBefore =
      ((await sb.from("cluster4_weekly_cards_snapshot").select("user_id,is_stale,computed_at,dto_version").eq("user_id", uid)).data ?? []) as any[];

    console.log(`\n── [팀장] ${testTL.display_name} (part 임시 null 창) ──`);
    try {
      // 임시: 팀장 정상 상태(파트 없음) 재현 — profile.current_part_name + membership.part_name(is_current) 둘 다 null.
      await sb.from("user_profiles").update({ current_part_name: null }).eq("user_id", uid);
      await sb.from("user_memberships").update({ part_name: null }).eq("user_id", uid).eq("is_current", true);

      // (B1) 크루 상세 direct == HTTP
      const detail = await getCrewDetailDto(uid, { generatedBy: adminId ?? undefined });
      const r1 = await fetch(`${BASE}/api/admin/members/${uid}`, { headers: { cookie } });
      const j1 = await r1.json().catch(() => ({}));
      ck("[2/4] 팀장 크루상세 HTTP 200(조회 실패 아님)", r1.status === 200 && j1?.success, `status=${r1.status} err=${j1?.error ?? ""}`);
      ck("[4] 팀장 크루상세 partName === null", detail.partName === null, J(detail.partName));
      ck("[4] 팀장 크루상세 teamName 표시(팀 배정 O)", !!detail.teamName, J(detail.teamName));
      ck("[4] 팀장 크루상세 classLabel === '운영진(팀장)'", detail.classLabel === "운영진(팀장)", J(detail.classLabel));
      ck("[3] 팀장 크루상세 direct == HTTP", detail.teamName === j1.data?.teamName && detail.partName === j1.data?.partName && detail.classLabel === j1.data?.classLabel, `http=${J({ t: j1.data?.teamName, p: j1.data?.partName, c: j1.data?.classLabel })}`);

      // (B2) 멤버 목록 direct == HTTP (mode=test)
      const lp = { query: testTL.display_name, organization: org, status: null, growthStatus: null, authEmailPresence: null, contactEmailPresence: null, sortBy: null, sortDir: null, limit: 500, offset: 0, mode: "test" as const };
      const dList = await listMembers(lp as any);
      const dRow = dList.members.find((m) => m.userId === uid) ?? null;
      const qs = new URLSearchParams({ q: testTL.display_name ?? "", organization: org, limit: "500", mode: "test" });
      const r2 = await fetch(`${BASE}/api/admin/members?${qs}`, { headers: { cookie } });
      const j2 = await r2.json().catch(() => ({}));
      const hRow = (j2?.data?.members ?? []).find((m: any) => m.userId === uid) ?? null;
      ck("[2] 멤버목록 HTTP 200", r2.status === 200 && j2?.success, `status=${r2.status}`);
      ck("[1/4] 목록 팀장 currentPartName === null", !!dRow && dRow.currentPartName === null, J(dRow?.currentPartName));
      ck("[6] 목록 팀장 currentTeamName 표시 · statusLabel '팀장'", !!dRow && !!dRow.currentTeamName && dRow.statusLabel === "팀장", J({ t: dRow?.currentTeamName, s: dRow?.statusLabel }));
      ck("[3] 목록 팀장 direct == HTTP", !!dRow && !!hRow && dRow.currentTeamName === hRow.currentTeamName && dRow.currentPartName === hRow.currentPartName && dRow.statusLabel === hRow.statusLabel, `d=${J({ t: dRow?.currentTeamName, p: dRow?.currentPartName, s: dRow?.statusLabel })} h=${J({ t: hRow?.currentTeamName, p: hRow?.currentPartName, s: hRow?.statusLabel })}`);

      // (B3) 체크 크루 명단 — 완료 상태행+recipient 직접 삽입 → 보드 completedCrewList
      const HUB = "info";
      const boardForWeek = await getProcessCheckBoard(HUB, org, null, "test");
      const weekId = boardForWeek.week?.weekId;
      ck("[전제] 테스트 보드 주차 확보", !!weekId, boardForWeek.week?.periodLabel ?? "");
      if (weekId) {
        const { data: g } = await sb.from("process_line_groups").insert({ hub: HUB, name: `${TAG}라인` }).select("id").single();
        const groupId = (g as { id: string }).id;
        const { data: a } = await sb
          .from("process_acts")
          .insert({ line_group_id: groupId, hub: HUB, act_name: `${TAG}액트`, duration_minutes: 30, occur_week: "N", occur_dow: 1, occur_time: "10:00", check_week: "N", check_dow: 3, check_time: "12:00", point_check: 5, point_advantage: 2, point_penalty: 0, cafe: "occur", check_target: "check", act_type: "selection", is_active: true })
          .select("id")
          .single();
        const actId = (a as { id: string }).id;
        const nowIso = new Date().toISOString();
        const { data: stIns } = await sb
          .from("process_check_statuses")
          .insert({ organization_slug: org, hub: HUB, week_id: weekId, line_group_id: groupId, act_id: actId, status: "completed", completion_type: "manual_grant", scope_mode: "test", review_link: null, scheduled_check_at: nowIso, requested_at: nowIso, completed_at: nowIso, checked_crew_count: 1 })
          .select("id")
          .single();
        const stId = (stIns as { id: string }).id;
        await sb.from("process_check_review_recipients").insert({ source: "regular", ref_id: stId, organization_slug: org, scope_mode: "test", user_id: uid, nickname: testTL.display_name, match_type: "matched", match_reason: "manual" });

        const dBoard = await getProcessCheckBoard(HUB, org, null, "test");
        const dEntry = findAct(dBoard, actId)?.completedCrewList?.[0] ?? null;
        const rb = await fetch(`${BASE}/api/admin/processes/check?hub=${HUB}&org=${org}&mode=test`, { headers: { cookie } });
        const jb = await rb.json().catch(() => ({}));
        const hEntry = findAct(jb.data, actId)?.completedCrewList?.[0] ?? null;
        ck("[5][2] 체크명단 HTTP 200 · 완료 명단 1명", rb.status === 200 && !!hEntry, `status=${rb.status}`);
        ck("[5][4] 체크명단 팀장 teamName 표시(폴백)", !!dEntry && !!dEntry.teamName && dEntry.teamName === testTL.current_team_name, J(dEntry?.teamName));
        ck("[5][4] 체크명단 팀장 partName === null", !!dEntry && dEntry.partName === null, J(dEntry?.partName));
        ck("[5][4] 체크명단 팀장 className === '운영진(팀장)'", !!dEntry && dEntry.className === "운영진(팀장)", J(dEntry?.className));
        ck("[5][3] 체크명단 direct == HTTP", J(dEntry) === J(hEntry), `d=${J(dEntry)} h=${J(hEntry)}`);
      }
    } finally {
      await pcCleanup();
      // 원복(net-zero) — 동기화 트리거 대비: membership 먼저, profile 명시 복원.
      await sb.from("user_memberships").update({ part_name: origMemPart }).eq("user_id", uid).eq("is_current", true);
      await sb.from("user_profiles").update({ current_part_name: origProfilePart }).eq("user_id", uid);
    }

    // (B4) snapshot 무접촉
    const snapAfter =
      ((await sb.from("cluster4_weekly_cards_snapshot").select("user_id,is_stale,computed_at,dto_version").eq("user_id", uid)).data ?? []) as any[];
    ck("[5] snapshot 무접촉(팀장 읽기 전후 동일 · 재계산 불필요)", J(snapBefore) === J(snapAfter), `before=${snapBefore.length} after=${snapAfter.length}`);

    // 원복 확인 — profile + membership 둘 다 원본 일치.
    const rProf = ((await sb.from("user_profiles").select("current_part_name").eq("user_id", uid)).data ?? [])[0] as any;
    const rMem = ((await sb.from("user_memberships").select("part_name").eq("user_id", uid).eq("is_current", true)).data ?? [])[0] as any;
    ck(
      "[cleanup] part 원복(net-zero · profile+membership)",
      (rProf?.current_part_name ?? null) === origProfilePart && (rMem?.part_name ?? null) === origMemPart,
      J({ prof: rProf?.current_part_name, mem: rMem?.part_name, origProf: origProfilePart, origMem: origMemPart }),
    );
  }

  console.log(`\n결과: ${pass} pass / ${fail} fail`);
  process.exit(fail > 0 ? 1 : 0);
}
main().catch(async (e) => {
  console.error("ERROR:", e?.stack ?? e?.message ?? e);
  await pcCleanup().catch(() => {});
  process.exit(1);
});
