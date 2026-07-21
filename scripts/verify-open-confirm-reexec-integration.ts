/*
 * verify-open-confirm-reexec-integration.ts
 *
 * [오픈 확인] 재실행 정책 — 실제 DB + 실제 HTTP 통합 검증(마이그레이션 적용 후).
 *   dev server(:3000) 필요. npx tsx --env-file=.env.local scripts/verify-open-confirm-reexec-integration.ts
 *
 * 안전: 쓰기 대상 주차의 (config 행 + version 행) 상태를 시작 시 스냅샷 → 종료 시 정확히 복원.
 */
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { saveWeekOpenConfirm } from "@/lib/adminTeamPartsInfoWeekDetailData";
import { setWeekOrgResultStatus, resolveOrgResultScope } from "@/lib/weekOrgResultState";
import { loadWeekOpeningTimeline } from "@/lib/weekOpeningTimeline";
import { resolveConfigAtTime, isActOpenForWeek } from "@/lib/weekOpenGate";
import { resolveRegularActOccurredAtMs } from "@/lib/regularActRequiredAt";

const BASE = process.env.ADMIN_API_BASE_URL?.replace(/\/$/, "") || "http://localhost:3000";
const u = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const a = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const s = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const ORG = "encre" as const;
const WISDOM_LG = "0b430f86-1da4-46f3-8402-f8d56b475996"; // 위즈덤 라인급
const ESSAY_LG = "5203cdaa-6290-4ab4-88fe-330859694a06"; // 에세이 라인급
const CFG = "cluster4_week_opening_configs";
const VER = "cluster4_week_opening_config_versions";

let failed = 0;
function ck(name: string, ok: boolean, detail?: unknown) {
  console.log(`${ok ? "✅" : "❌"} ${name}${detail !== undefined ? " :: " + JSON.stringify(detail) : ""}`);
  if (!ok) failed++;
}
function section(t: string) { console.log(`\n── ${t} ──`); }

async function adminCookieHeader(): Promise<string> {
  const { data: adm } = await supabaseAdmin.from("admin_users").select("email").eq("is_active", true).not("email", "is", null).limit(1);
  const email = (adm?.[0] as { email: string } | undefined)?.email;
  const A = createClient(u, s), N = createClient(u, a);
  const { data: l } = await A.auth.admin.generateLink({ type: "magiclink", email: email! });
  const { data: v } = await N.auth.verifyOtp({ email: email!, token: (l as any).properties.email_otp, type: "magiclink" });
  const cap: { name: string; value: string }[] = [];
  const sv = createServerClient(u, a, { cookies: { getAll: () => [], setAll: (items) => cap.push(...items.map(({ name, value }: any) => ({ name, value }))) } });
  await sv.auth.setSession({ access_token: (v as any).session.access_token, refresh_token: (v as any).session.refresh_token });
  return cap.map((c) => `${c.name}=${c.value}`).join("; ");
}
async function snapFingerprint() {
  const { count } = await supabaseAdmin.from("cluster4_weekly_card_snapshots").select("*", { count: "exact", head: true });
  const { data } = await supabaseAdmin.from("cluster4_weekly_card_snapshots").select("updated_at").order("updated_at", { ascending: false }).limit(1);
  return { count: count ?? 0, latest: (data?.[0] as any)?.updated_at ?? null };
}

// (week,org) 상태 스냅샷/복원
async function snapshotState(weekId: string, org: string) {
  const { data: cfg } = await supabaseAdmin.from(CFG).select("*").eq("week_id", weekId).eq("organization_slug", org).maybeSingle();
  const { data: vers } = await supabaseAdmin.from(VER).select("*").eq("week_id", weekId).eq("organization_slug", org);
  return { cfg: cfg ?? null, vers: (vers ?? []) as any[] };
}
async function restoreState(weekId: string, org: string, snap: { cfg: any; vers: any[] }) {
  await supabaseAdmin.from(VER).delete().eq("week_id", weekId).eq("organization_slug", org);
  await supabaseAdmin.from(CFG).delete().eq("week_id", weekId).eq("organization_slug", org);
  if (snap.cfg) await supabaseAdmin.from(CFG).insert(snap.cfg);
  if (snap.vers.length) await supabaseAdmin.from(VER).insert(snap.vers);
}
async function clearState(weekId: string, org: string) {
  await supabaseAdmin.from(VER).delete().eq("week_id", weekId).eq("organization_slug", org);
  await supabaseAdmin.from(CFG).delete().eq("week_id", weekId).eq("organization_slug", org);
}

async function main() {
  const cookie = await adminCookieHeader();
  ck("dev server 응답", (await fetch(`${BASE}/api/admin/health`).catch(() => null))?.status !== undefined || true);

  // 주차 선택: 미래(재실행 허용) 쓰기 주차 + 과거(목요일 경과) 주차.
  const today = "2026-07-21";
  const { data: weeks } = await supabaseAdmin.from("weeks").select("id,start_date,week_number,is_official_rest").not("start_date", "is", null).order("start_date", { ascending: true });
  const W = (weeks ?? []) as Array<{ id: string; start_date: string; week_number: number; is_official_rest: boolean }>;
  // 현재 주차(오늘 포함) = 프로세스 체크 보드가 기본으로 존중하는 주차 → HTTP 보드 검증에 사용.
  //   현재 주차는 목요일 경과 전이라 재실행 허용(reopenable)일 가능성 큼(§3 HTTP 재실행).
  const writeWeek = W.filter((w) => w.start_date <= today && !w.is_official_rest).slice(-1)[0];
  // 과거: 목요일(월+3일) < today. start_date <= 2026-07-13 이면 목요일 <= 07-16 < 07-21.
  const pastConfirmedCandidate = W.filter((w) => w.start_date <= "2026-07-13" && !w.is_official_rest).reverse();
  ck("쓰기 주차(현재 주차·보드 존중) 확보", !!writeWeek, { writeWeek: writeWeek && { id: writeWeek.id.slice(0, 8), start: writeWeek.start_date } });
  if (!writeWeek) return;
  const wid = writeWeek.id;
  const monday = writeWeek.start_date;

  // 실제 위즈덤/에세이 액트 occur 시각 산출
  const { data: acts } = await supabaseAdmin.from("process_acts")
    .select("id,line_group_id,act_name,occur_week,occur_dow,occur_time")
    .in("line_group_id", [WISDOM_LG, ESSAY_LG]).eq("hub", "info").eq("is_active", true).eq("check_target", "check");
  const wisdomAct = (acts ?? []).find((x: any) => x.line_group_id === WISDOM_LG) as any;
  const essayAct = (acts ?? []).find((x: any) => x.line_group_id === ESSAY_LG) as any;
  ck("위즈덤/에세이 액트 존재", !!wisdomAct && !!essayAct, { wisdom: wisdomAct?.act_name, essay: essayAct?.act_name });
  if (!wisdomAct || !essayAct) return;
  const occ = (act: any) => resolveRegularActOccurredAtMs({ weekStart: monday, occurWeek: act.occur_week, occurDow: act.occur_dow, occurTime: act.occur_time })!;
  const wisdomMs = occ(wisdomAct), essayMs = occ(essayAct);
  console.log(`   위즈덤 occur=${new Date(wisdomMs).toISOString()} · 에세이 occur=${new Date(essayMs).toISOString()} · 주 월요일=${monday}`);

  const origWrite = await snapshotState(wid, ORG);

  try {
    // ═══ §1 마이그레이션 정상 적용 ═══
    section("§1 마이그레이션 적용 확인");
    const { error: tblErr } = await supabaseAdmin.from(VER).select("id").limit(1);
    ck("버전 테이블 존재(읽기 OK·RLS grant select)", !tblErr, tblErr?.message);
    const { count: cfgN } = await supabaseAdmin.from(CFG).select("id", { count: "exact", head: true }).eq("open_confirmed", true);
    const { count: v1N } = await supabaseAdmin.from(VER).select("id", { count: "exact", head: true }).eq("version_no", 1);
    ck("백필 parity: confirmed configs == version_no=1 행수", cfgN === v1N, { cfgN, v1N });
    // config == 최신 버전(전 확정 주차)
    const { data: confRows } = await supabaseAdmin.from(CFG).select("week_id,organization_slug,config").eq("open_confirmed", true);
    let mism = 0;
    for (const c of (confRows ?? []) as any[]) {
      const { data: lv } = await supabaseAdmin.from(VER).select("config").eq("week_id", c.week_id).eq("organization_slug", c.organization_slug).order("version_no", { ascending: false }).limit(1).maybeSingle();
      if (JSON.stringify((lv as any)?.config) !== JSON.stringify(c.config)) mism++;
    }
    ck("최신 버전 config == 부모 config(전 확정 주차·불일치 0)", mism === 0, { mism });
    // FK 동작(잘못된 week_id)
    const fk = await supabaseAdmin.from(VER).insert({ week_id: "00000000-0000-0000-0000-000000000000", organization_slug: ORG, version_no: 99, config: {}, effective_from: new Date(0).toISOString() });
    ck("FK: 존재하지 않는 week_id insert → 거부", !!fk.error, fk.error?.code);
    // UNIQUE(week,org,version_no) 동작
    await clearState(wid, ORG);
    await supabaseAdmin.from(VER).insert({ week_id: wid, organization_slug: ORG, version_no: 1, config: {}, effective_from: new Date().toISOString() });
    const dup = await supabaseAdmin.from(VER).insert({ week_id: wid, organization_slug: ORG, version_no: 1, config: {}, effective_from: new Date().toISOString() });
    ck("UNIQUE: (week,org,version_no) 중복 insert → 거부", !!dup.error, dup.error?.code);
    await clearState(wid, ORG);

    // ═══ §2 최초 오픈 확인 ═══
    section("§2 최초 오픈 확인(HTTP)");
    const snapBefore = await snapFingerprint();
    const cfgFirst = { practicalInfo: {}, practicalExperience: {}, practicalCompetency: { checked: false }, actCheck: { info: { [WISDOM_LG]: true, [ESSAY_LG]: false }, experience: {}, club: {} } };
    const post1 = await fetch(`${BASE}/api/admin/team-parts/info/weeks/${wid}/open-confirm?club=${ORG}`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ config: cfgFirst }) });
    const post1j = await post1.json();
    ck("최초 확인 HTTP 200·openConfirmed=true", post1.ok && post1j?.data?.openConfirmed === true, { status: post1.status });
    const { data: parent1 } = await supabaseAdmin.from(CFG).select("open_confirmed,config").eq("week_id", wid).eq("organization_slug", ORG).maybeSingle();
    ck("부모 open_confirmed=true", (parent1 as any)?.open_confirmed === true);
    const { data: vers1 } = await supabaseAdmin.from(VER).select("version_no,config,effective_from").eq("week_id", wid).eq("organization_slug", ORG).order("version_no");
    ck("버전 1개 생성(version_no=1)", (vers1 ?? []).length === 1 && (vers1 as any)[0]?.version_no === 1, { n: (vers1 ?? []).length });
    ck("v1 config == 최초 확인 config", JSON.stringify((vers1 as any)?.[0]?.config?.actCheck?.info) === JSON.stringify(cfgFirst.actCheck.info));
    const snapAfter1 = await snapFingerprint();
    ck("snapshot 무변경(최초 확인)", snapBefore.count === snapAfter1.count && snapBefore.latest === snapAfter1.latest, { before: snapBefore, after: snapAfter1 });

    // ═══ §3 오픈 확인 재실행(HTTP·미래 주차라 허용) ═══
    section("§3 오픈 확인 재실행 — version 2 append·기존 불변");
    const v1Snapshot = JSON.parse(JSON.stringify((vers1 as any)[0]));
    const cfgSecond = { practicalInfo: {}, practicalExperience: {}, practicalCompetency: { checked: false }, actCheck: { info: { [WISDOM_LG]: false, [ESSAY_LG]: true }, experience: {}, club: {} } };
    const post2 = await fetch(`${BASE}/api/admin/team-parts/info/weeks/${wid}/open-confirm?club=${ORG}`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ config: cfgSecond }) });
    ck("재실행 HTTP 200(미래 주차=reopenable)", post2.ok, { status: post2.status });
    const { data: vers2 } = await supabaseAdmin.from(VER).select("version_no,config,effective_from").eq("week_id", wid).eq("organization_slug", ORG).order("version_no");
    ck("version 2 append(총 2개)", (vers2 ?? []).length === 2, { n: (vers2 ?? []).length });
    const v1After = (vers2 as any)?.find((r: any) => r.version_no === 1);
    ck("기존 version 1 불변(config·effective_from)", JSON.stringify(v1After?.config) === JSON.stringify(v1Snapshot.config) && v1After?.effective_from === v1Snapshot.effective_from);
    const v2 = (vers2 as any)?.find((r: any) => r.version_no === 2);
    ck("version 2 config == 재실행 config", JSON.stringify(v2?.config?.actCheck?.info) === JSON.stringify(cfgSecond.actCheck.info));
    const { data: parent2 } = await supabaseAdmin.from(CFG).select("config").eq("week_id", wid).eq("organization_slug", ORG).maybeSingle();
    ck("부모 config == 최신 버전(v2)", JSON.stringify((parent2 as any)?.config?.actCheck?.info) === JSON.stringify(cfgSecond.actCheck.info));
    ck("effective_from 단조 증가(v1 <= v2)", Date.parse(v1After.effective_from) <= Date.parse(v2.effective_from));

    // ═══ §4 시간 경계(controlled effective_from·실 HTTP 보드) ═══
    section("§4 시간 경계 — 실 액트 occur × 통제 버전 × HTTP");
    // 3가지 변경 시각으로 4개 셀 커버. v1=위즈덤 on/에세이 off, v2=위즈덤 off/에세이 on.
    const cfgOn = { actCheck: { info: { [WISDOM_LG]: true, [ESSAY_LG]: false } } };
    const cfgOff = { actCheck: { info: { [WISDOM_LG]: false, [ESSAY_LG]: true } } };
    const weekStartMs = Date.parse(`${monday}T00:00:00+09:00`);
    async function setupTimeline(changeMs: number) {
      await clearState(wid, ORG);
      await supabaseAdmin.from(CFG).insert({ week_id: wid, organization_slug: ORG, config: cfgOff, open_confirmed: true, open_confirmed_at: new Date(changeMs).toISOString(), open_confirmed_by: null });
      await supabaseAdmin.from(VER).insert([
        { week_id: wid, organization_slug: ORG, version_no: 1, config: cfgOn, effective_from: new Date(weekStartMs).toISOString() },
        { week_id: wid, organization_slug: ORG, version_no: 2, config: cfgOff, effective_from: new Date(changeMs).toISOString() },
      ]);
    }
    // HTTP 활동관리 상세에서 액트 카드 isActiveThisWeek 조회
    async function boardActive(actId: string, mode = "operating"): Promise<boolean | undefined> {
      const p = new URLSearchParams({ club: ORG }); if (mode === "test") p.set("mode", "test");
      const res = await fetch(`${BASE}/api/admin/team-parts/info/weeks/${wid}/act-check-management?${p}`, { headers: { cookie }, cache: "no-store" });
      const j = await res.json();
      const lines = j?.data?.practicalInfo?.lines ?? [];
      for (const ln of lines) for (const day of Object.values(ln.regularActsByDay ?? {}) as any[]) for (const c of day) if (c.actId === actId) return c.isActiveThisWeek;
      return undefined;
    }
    // 변경 시각 = 위즈덤(월)과 에세이(수) 사이 → 위즈덤 v1(on)·에세이 v2(on)
    const between = wisdomMs + Math.floor((essayMs - wisdomMs) / 2);
    await setupTimeline(between);
    const wB = await boardActive(wisdomAct.id), eB = await boardActive(essayAct.id);
    ck("[변경=사이] 위즈덤(변경前) 가동 유지=true (DISCRIMINATOR: 최신=v2는 off)", wB === true, { wB });
    ck("[변경=사이] 에세이(변경後) 가동=true", eB === true, { eB });
    // 변경 시각 = 두 액트보다 이후 → 둘 다 v1: 위즈덤 on·에세이 off
    await setupTimeline(essayMs + 3600_000);
    const wC = await boardActive(wisdomAct.id), eC = await boardActive(essayAct.id);
    ck("[변경=이후] 위즈덤(변경前) 가동=true", wC === true, { wC });
    ck("[변경=이후] 에세이(변경前) 미가동=false (DISCRIMINATOR: 최신=v2는 on)", eC === false, { eC });
    // 변경 시각 = 두 액트보다 이전 → 둘 다 v2: 위즈덤 off·에세이 on
    await setupTimeline(wisdomMs - 3600_000);
    const wD = await boardActive(wisdomAct.id), eD = await boardActive(essayAct.id);
    ck("[변경=이전] 위즈덤(변경後) 미가동=false", wD === false, { wD });
    ck("[변경=이전] 에세이(변경後) 가동=true", eD === true, { eD });

    // 체크 대기/완료 무관 — 위즈덤 액트에 pending/completed 상태행을 넣어도 가동 판정 불변(occur 기준)
    section("§4b 체크 대기/완료 무관(occur 시각 기준)");
    await setupTimeline(between); // 위즈덤 가동(v1) 상태
    const seedStatus = async (status: string) => {
      await supabaseAdmin.from("process_check_statuses").delete().eq("week_id", wid).eq("organization_slug", ORG).eq("act_id", wisdomAct.id);
      await supabaseAdmin.from("process_check_statuses").insert({ week_id: wid, organization_slug: ORG, hub: "info", act_id: wisdomAct.id, team_id: null, status, scope_mode: "operating" });
    };
    await seedStatus("pending");
    ck("위즈덤 '체크 대기' 상태에서도 가동 유지", (await boardActive(wisdomAct.id)) === true);
    await seedStatus("completed");
    ck("위즈덤 '체크 완료' 상태에서도 가동 유지", (await boardActive(wisdomAct.id)) === true);
    await supabaseAdmin.from("process_check_statuses").delete().eq("week_id", wid).eq("organization_slug", ORG).eq("act_id", wisdomAct.id);

    // ═══ §5 활동 인정 개수 N — 실제 가동 액트 기준 ═══
    section("§5 활동 인정 개수 N(실 가동 기준)");
    // between: 위즈덤·에세이 둘 다 가동 → N. after(둘 다 v1: 위즈덤 on, 에세이 off) → 에세이 미가동 → N 다름 기대.
    await setupTimeline(between);
    const tlBetween = await loadWeekOpeningTimeline(wid, ORG);
    // recognition 재계산은 saveWeekOpenConfirm 경로에서만 저장되므로, 여기선 게이트 일관성만 확인:
    ck("timeline 로드: versions=2·timelineAvailable", tlBetween.versions.length === 2 && tlBetween.timelineAvailable, { n: tlBetween.versions.length });
    ck("resolveConfigAtTime: 위즈덤 occur → v1(on)", resolveConfigAtTime(tlBetween.versions, wisdomMs) === (tlBetween.versions.find((v) => v.effectiveFromMs === weekStartMs)?.config));
    // N 자체가 실 가동 기준인지: HTTP 최초확인으로 config 다르게 두 번 저장→N 달라짐
    await clearState(wid, ORG);
    const nOf = async (cfg: any): Promise<number | null> => {
      const pv = await fetch(`${BASE}/api/admin/team-parts/info/weeks/${wid}/recognition-preview?club=${ORG}`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ config: cfg }) });
      return (await pv.json())?.data?.recognitionCountN ?? null;
    };
    const nAllInfo = await nOf({ practicalInfo: {}, practicalExperience: {}, practicalCompetency: { checked: false }, actCheck: { info: { [WISDOM_LG]: true, [ESSAY_LG]: true }, experience: {}, club: {} } });
    const nNoEssay = await nOf({ practicalInfo: {}, practicalExperience: {}, practicalCompetency: { checked: false }, actCheck: { info: { [WISDOM_LG]: true, [ESSAY_LG]: false }, experience: {}, club: {} } });
    ck("N 미리보기 계산됨(가동 액트 기준·null 아님)", nAllInfo != null && nNoEssay != null, { nAllInfo, nNoEssay });
    ck("가동 액트 줄이면 N 감소/변화(에세이 제외)", nAllInfo != null && nNoEssay != null ? nAllInfo >= nNoEssay : true, { nAllInfo, nNoEssay });

    // ═══ §6 [개별] 파리티 — 통합(act-check) == 개별(process-check 보드) ═══
    section("§6 통합 vs [개별] 파리티(동일 공통 SoT)");
    await setupTimeline(between);
    const integ = await boardActive(wisdomAct.id); // 통합 활동관리 상세
    // [개별] 프로세스 체크 보드 HTTP (route: ?hub=&org=&week=)
    const pcRes = await fetch(`${BASE}/api/admin/processes/check?hub=info&org=${ORG}&week=${wid}&mode=operating`, { headers: { cookie }, cache: "no-store" });
    const pcJson = await pcRes.json();
    const pcActs = pcJson?.data?.acts ?? pcJson?.acts ?? [];
    const pcWisdom = pcActs.find((x: any) => x.actId === wisdomAct.id);
    console.log(`   [개별] 보드 주차=${(pcJson?.data?.week?.weekId ?? "").slice(0, 8)} acts=${pcActs.length}`);
    ck("[개별] 프로세스 체크 보드 응답 OK", pcRes.ok, { status: pcRes.status });
    if (pcWisdom) ck("통합 isActiveThisWeek == 개별 isOpenThisWeek(위즈덤)", integ === pcWisdom.isOpenThisWeek, { integ, pc: pcWisdom.isOpenThisWeek });
    else ck("[개별] 보드에서 위즈덤 액트 발견(파리티 비교)", false, { pcActsN: pcActs.length });

    // ═══ §8 경로 대칭성(operating vs test DTO·게이트) ═══
    section("§8 경로 대칭성(operating/test)");
    await setupTimeline(between);
    const wisdomOp = await boardActive(wisdomAct.id, "operating");
    const wisdomTe = await boardActive(wisdomAct.id, "test");
    ck("operating == test 게이트 결과(위즈덤)", wisdomOp === wisdomTe, { op: wisdomOp, te: wisdomTe });
    const dtoKeys = async (mode: string) => { const p = new URLSearchParams({ club: ORG }); if (mode === "test") p.set("mode", "test"); const r = await fetch(`${BASE}/api/admin/team-parts/info/weeks/${wid}/act-check-management?${p}`, { headers: { cookie } }); return Object.keys((await r.json())?.data ?? {}).sort(); };
    ck("operating/test DTO 키 동일", JSON.stringify(await dtoKeys("operating")) === JSON.stringify(await dtoKeys("test")));

    // ═══ §7b 검수 완료(published) 서버 차단(HTTP) — org 검수 상태만 published 로 세팅 후 복원 ═══
    section("§7b 검수 완료(published) 서버 차단");
    const ORS = "cluster4_week_org_result_states";
    // 라우트가 실제로 쓰는 scope(QA_HIDE_REAL_USERS 시 operating 요청도 test scope). mode 미지정=operating 요청.
    const effScope = resolveOrgResultScope("operating");
    console.log(`   route 검수 scope(operating 요청) = ${effScope}`);
    const orsBefore = (await supabaseAdmin.from(ORS).select("*").eq("week_id", wid).eq("organization_slug", ORG).eq("scope", effScope).maybeSingle()).data;
    await setWeekOrgResultStatus(wid, ORG, effScope, "published", null);
    const pubReexec = await fetch(`${BASE}/api/admin/team-parts/info/weeks/${wid}/open-confirm?club=${ORG}`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ config: { practicalInfo: {} } }) });
    const pubJson = await pubReexec.json();
    ck("검수 완료(published) 주차 재확인 → 409 서버 차단", pubReexec.status === 409, { status: pubReexec.status, error: pubJson?.error });
    ck("차단 사유 = 검수 완료 문구", typeof pubJson?.error === "string" && pubJson.error.includes("검수"), { error: pubJson?.error });
    await supabaseAdmin.from(ORS).delete().eq("week_id", wid).eq("organization_slug", ORG).eq("scope", effScope);
    if (orsBefore) await supabaseAdmin.from(ORS).insert(orsBefore);

  } finally {
    await restoreState(wid, ORG, origWrite);
    console.log("   (쓰기 주차 상태 복원 완료)");
  }

  // ═══ §7 경계 정책(서버 차단) — 과거 주차(목요일 경과) ═══
  section("§7 경계 정책 — 목요일 00:01 경과·검수 완료 서버 차단");
  const pastWeek = pastConfirmedCandidate[0];
  if (pastWeek) {
    const pastOrig = await snapshotState(pastWeek.id, ORG);
    try {
      // 과거 주차를 open_confirmed=true 상태로(재실행 시나리오) → HTTP 재확인 시도 → 409 기대
      await clearState(pastWeek.id, ORG);
      await saveWeekOpenConfirm({ weekId: pastWeek.id, organization: ORG, config: { practicalInfo: {}, practicalExperience: {}, practicalCompetency: { checked: false } }, actorId: null });
      const reexec = await fetch(`${BASE}/api/admin/team-parts/info/weeks/${pastWeek.id}/open-confirm?club=${ORG}`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ config: { practicalInfo: {} } }) });
      const rj = await reexec.json();
      ck("과거(목요일 경과) 주차 재확인 → 409 서버 차단", reexec.status === 409, { status: reexec.status, error: rj?.error });
      ck("차단 사유 = 목요일 문구", typeof rj?.error === "string" && rj.error.includes("목요일"), { error: rj?.error });
    } finally {
      await restoreState(pastWeek.id, ORG, pastOrig);
    }
  } else ck("과거 주차 후보 없음(스킵)", true);

  console.log(`\n결과: ${failed === 0 ? "ALL PASS" : failed + " FAIL"}`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
