/**
 * [HTTP 라운드트립] 오픈확인으로 N 을 바꿔도 성공/실패·포인트·uws·snapshot 이 불변임을 실증.
 *   (상태 1: "N 만 변경하고 주차 검수를 다시 하지 않은 상태")
 *
 *   절차(실행 중 dev 서버 대상, config 는 원복):
 *     1) 대상 주차의 현재 config·N·uws(week_start_date)·해당 유저 points·snapshot fingerprint 캡처
 *     2) POST open-confirm 에 "정보 라인 1개 토글" config → N 재계산(변경) 유도
 *     3) 재캡처 → N 변경 확인 + uws/points/snapshot 불변 확인
 *     4) POST open-confirm 으로 원래 config 복원(N 원복)
 *
 *   npx tsx --env-file=.env.local scripts/verify-openconfirm-n-decoupling-http.ts
 */
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

const BASE = process.env.ADMIN_API_BASE_URL?.replace(/\/$/, "") || "http://localhost:3000";
const u = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const a = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const s = process.env.SUPABASE_SERVICE_ROLE_KEY!;

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
  return cap.map((c: any) => `${c.name}=${c.value}`).join("; ");
}

// GET DTO 의 openingConfig → open-confirm POST config 형태(buildConfig 등가).
function dtoToConfig(oc: any) {
  return {
    practicalInfo: Object.fromEntries(oc.lineOpening.practicalInfo.map((l: any) => [l.lineId, l.checked])),
    practicalExperience: Object.fromEntries(oc.lineOpening.practicalExperience.map((t: any) => [t.teamId, Object.fromEntries(t.lines.map((x: any) => [x.type, x.checked]))])),
    practicalCompetency: { checked: oc.practicalCompetency.checked },
    actCheck: {
      info: Object.fromEntries(oc.actCheck.info.map((g: any) => [g.lineGroupId, g.checked])),
      experience: Object.fromEntries(oc.actCheck.experience.map((t: any) => [t.teamId, Object.fromEntries(t.lineGroups.map((g: any) => [g.lineGroupId, g.checked]))])),
      club: Object.fromEntries(oc.actCheck.club.map((g: any) => [g.lineGroupId, g.checked])),
    },
  };
}

async function snapFingerprint() {
  const { count } = await supabaseAdmin.from("cluster4_weekly_card_snapshots").select("*", { count: "exact", head: true });
  const { data } = await supabaseAdmin.from("cluster4_weekly_card_snapshots").select("updated_at").order("updated_at", { ascending: false }).limit(1);
  return { count: count ?? 0, latest: (data?.[0] as any)?.updated_at ?? null };
}

async function uwsFingerprint(weekStart: string) {
  const rows: any[] = [];
  for (let i = 0; ; i += 1000) {
    const { data } = await supabaseAdmin.from("user_week_statuses").select("user_id,status").eq("week_start_date", weekStart).order("user_id").range(i, i + 999);
    if (!data || data.length === 0) break;
    rows.push(...data);
    if (data.length < 1000) break;
  }
  return { n: rows.length, hash: JSON.stringify(rows) };
}

async function pointsFingerprint(userIds: string[], year: number, week: number) {
  const map: Record<string, number> = {};
  for (let i = 0; i < userIds.length; i += 200) {
    const { data } = await supabaseAdmin.from("user_weekly_points").select("user_id,points").eq("year", year).eq("week_number", week).in("user_id", userIds.slice(i, i + 200));
    for (const r of (data ?? []) as any[]) map[r.user_id] = r.points;
  }
  return JSON.stringify(map, Object.keys(map).sort());
}

async function main() {
  try { const h = await fetch(`${BASE}/api/health`); ck("dev server 응답", h.ok); } catch { console.log("❌ dev server 미기동"); process.exit(2); }
  const h = await cookie();

  // 대상 = N 이 산정된 오픈확인 주차 중 uws 보유 케이스.
  const { data: cfgRows } = await supabaseAdmin.from("cluster4_week_opening_configs").select("week_id,organization_slug,recognition_count_n").not("recognition_count_n", "is", null).limit(20);
  let target: { weekId: string; org: string; weekStart: string; isoY: number; isoW: number } | null = null;
  for (const c of (cfgRows ?? []) as any[]) {
    const { data: wk } = await supabaseAdmin.from("weeks").select("id,start_date,iso_year,iso_week").eq("id", c.week_id).maybeSingle();
    if (!wk) continue;
    const w = wk as any;
    const { count } = await supabaseAdmin.from("user_week_statuses").select("*", { count: "exact", head: true }).eq("week_start_date", w.start_date);
    if ((count ?? 0) > 0) { target = { weekId: w.id, org: c.organization_slug, weekStart: w.start_date, isoY: w.iso_year, isoW: w.iso_week }; break; }
  }
  if (!target) { console.log("❌ 적합한 대상 주차 없음"); process.exit(2); }
  console.log(`대상: week=${target.weekId.slice(0,8)} org=${target.org} start=${target.weekStart} ISO=${target.isoY}-W${target.isoW}`);

  const getDetail = async () => {
    const res = await fetch(`${BASE}/api/admin/team-parts/info/weeks/${target!.weekId}?club=${target!.org}`, { headers: { cookie: h }, cache: "no-store" });
    const j = await res.json();
    if (!res.ok || !j.success) throw new Error(`GET 실패 ${res.status}`);
    return j.data;
  };
  const readN = async () => {
    const { data } = await supabaseAdmin.from("cluster4_week_opening_configs").select("recognition_count_n").eq("week_id", target!.weekId).eq("organization_slug", target!.org).maybeSingle();
    return (data as any)?.recognition_count_n ?? null;
  };
  const postConfig = async (config: any) => {
    const res = await fetch(`${BASE}/api/admin/team-parts/info/weeks/${target!.weekId}/open-confirm?club=${target!.org}`, {
      method: "POST", headers: { cookie: h, "content-type": "application/json" }, body: JSON.stringify({ config }),
    });
    return { ok: res.ok, status: res.status, json: await res.json() };
  };

  // 1) 캡처(before)
  const detail0 = await getDetail();
  const origConfig = dtoToConfig(detail0.openingConfig);
  const uwsUserIds = (async () => {
    const rows: any[] = [];
    for (let i = 0; ; i += 1000) {
      const { data } = await supabaseAdmin.from("user_week_statuses").select("user_id").eq("week_start_date", target!.weekStart).order("user_id").range(i, i + 999);
      if (!data || data.length === 0) break; rows.push(...data); if (data.length < 1000) break;
    }
    return rows.map((r) => r.user_id);
  });
  const userIds = await uwsUserIds();
  const nBefore = await readN();
  const uwsBefore = await uwsFingerprint(target.weekStart);
  const ptsBefore = await pointsFingerprint(userIds, target.isoY, target.isoW);
  const snapBefore = await snapFingerprint();
  console.log(`before: N=${nBefore}  uws=${uwsBefore.n}건  users=${userIds.length}`);

  // 2) 정보 라인 1개 토글 → N 재계산 유도
  const infoLines = detail0.openingConfig.lineOpening.practicalInfo as any[];
  ck("대상 주차에 정보 라인 존재(토글 대상)", infoLines.length > 0, { count: infoLines.length });
  const toggledConfig = JSON.parse(JSON.stringify(origConfig));
  const firstId = infoLines[0].lineId;
  toggledConfig.practicalInfo[firstId] = !toggledConfig.practicalInfo[firstId];
  const r1 = await postConfig(toggledConfig);
  ck("open-confirm(토글) 200", r1.ok, { status: r1.status, err: r1.json?.error });

  // 3) 재캡처(after)
  const nAfter = await readN();
  const uwsAfter = await uwsFingerprint(target.weekStart);
  const ptsAfter = await pointsFingerprint(userIds, target.isoY, target.isoW);
  const snapAfter = await snapFingerprint();
  console.log(`after : N=${nAfter}`);

  ck("N 은 변경됨(오픈확인이 N 재계산·write)", nBefore !== nAfter, { nBefore, nAfter });
  ck("user_week_statuses 불변(성공/실패 SoT)", uwsBefore.hash === uwsAfter.hash, { before: uwsBefore.n, after: uwsAfter.n });
  ck("user_weekly_points 불변(포인트)", ptsBefore === ptsAfter);
  ck("snapshot fingerprint 불변(고객 카드)", JSON.stringify(snapBefore) === JSON.stringify(snapAfter), { snapBefore, snapAfter });

  // 4) 원복
  const r2 = await postConfig(origConfig);
  ck("open-confirm(원복) 200", r2.ok, { status: r2.status });
  const nRestore = await readN();
  ck("N 원복(원래 config 재계산)", nRestore === nBefore, { nBefore, nRestore });

  console.log(`\n${failed === 0 ? "🎉 ALL PASS" : `❌ ${failed} FAILED`}`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(2); });
