/**
 * [실무 역량] 수동 추가 → 개설 종단 재현 (DB + HTTP, 브라우저 없이).
 *   npx tsx --env-file=.env.local scripts/repro-competency-manual-open.ts
 *
 * 단계: 수동추가(POST applications) → 개설(POST opening) → 각 단계 DB/HTTP/snapshot/고객 weekly-cards 캡처 → 정리.
 * 격리: org=oranke, test 유저 1명(test_user_markers), common 마스터 CPBS-NN0001, line_name 고정 → 끝에 삭제(net-zero).
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { getCluster4WeeklyCardsForProfileUser } from "../lib/cluster4WeeklyCardsData";
import { recomputeAndStoreWeeklyCardsSnapshot, readWeeklyCardsSnapshot } from "../lib/cluster4WeeklyCardsSnapshot";

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const IKEY = process.env.INTERNAL_API_KEY!;
const BASE = "http://localhost:3000";
const ADMIN_EMAIL = "vanuatu.golden@gmail.com";
const ORG = "oranke";
const MASTER_CODE = "CPBS-NN0001";
const LINE_NAME = "ZZ-재현-역량라인";
const SUB = "https://repro.example/submission";
const CAFE = "https://repro.example/cafe-common";
const DESC = "재현공통설명";

const sb = createClient(URL, SERVICE);
const J = (o: unknown) => JSON.stringify(o);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function adminCookie(): Promise<string> {
  const brow = createClient(URL, ANON);
  const { data: link } = await sb.auth.admin.generateLink({ type: "magiclink", email: ADMIN_EMAIL });
  const otp = (link as any).properties.email_otp;
  const { data: v } = await brow.auth.verifyOtp({ email: ADMIN_EMAIL, token: otp, type: "magiclink" });
  const cap: Array<{ name: string; value: string }> = [];
  const srv = createServerClient(URL, ANON, {
    cookies: { getAll: () => [], setAll: (items: any) => cap.push(...items) },
  });
  await srv.auth.setSession({
    access_token: (v as any).session.access_token,
    refresh_token: (v as any).session.refresh_token,
  });
  return cap.map((i) => `${i.name}=${i.value}`).join("; ");
}

async function dbApp() {
  const { data } = await sb
    .from("cluster4_competency_applications")
    .select("*")
    .eq("organization_slug", ORG)
    .eq("line_name", LINE_NAME)
    .maybeSingle();
  return data as any;
}

async function cleanup() {
  const a = await dbApp();
  if (a?.opened_line_id) {
    await sb.from("cluster4_line_targets").delete().eq("line_id", a.opened_line_id);
    await sb.from("cluster4_lines").delete().eq("id", a.opened_line_id);
  }
  await sb.from("cluster4_competency_applications").delete().eq("organization_slug", ORG).eq("line_name", LINE_NAME);
}

async function main() {
  const cookie = await adminCookie();
  const H = { cookie, "Content-Type": "application/json" };

  await cleanup();

  // 대상 test 유저 + 마스터
  const { data: tm } = await sb.from("test_user_markers").select("user_id");
  const testIds = (tm ?? []).map((x: any) => x.user_id);
  const { data: prof } = await sb
    .from("user_profiles")
    .select("user_id,display_name,status,growth_status")
    .eq("organization_slug", ORG)
    .in("user_id", testIds)
    .eq("growth_status", "active"); // 성장중단(paused/suspended) 제외 — truncation 축과 분리
  const crew = (prof ?? [])[0] as any;
  console.log(`  (선택 유저 growth_status=${crew?.growth_status} status=${crew?.status} — isStopped 아님 확인)`);
  const { data: master } = await sb
    .from("cluster4_competency_line_masters")
    .select("id,line_code")
    .eq("line_code", MASTER_CODE)
    .maybeSingle();

  // 개설 대상 주차
  const appsRes = await fetch(`${BASE}/api/admin/cluster4/competency/applications?organization=${ORG}`, { headers: { cookie } });
  const appsJson = await appsRes.json();
  const weekId = appsJson?.data?.weekId;
  console.log(`\n=== SETUP === week=${weekId?.slice(0, 8)} crew=${crew?.display_name}(${crew?.user_id?.slice(0, 8)}) master=${(master as any)?.line_code}`);

  // ── STEP 1: 수동 추가 (HTTP POST applications) ──
  console.log("\n=== STEP 1: 수동 추가 ===");
  const addRes = await fetch(`${BASE}/api/admin/cluster4/competency/applications`, {
    method: "POST",
    headers: H,
    body: J({
      organization: ORG,
      target_user_id: crew.user_id,
      week_id: weekId,
      competency_line_master_id: (master as any).id,
      line_code: (master as any).line_code,
      line_name: LINE_NAME,
      submission_link: SUB,
    }),
  });
  const addJson = await addRes.json();
  console.log(`  POST applications: http=${addRes.status} success=${addJson.success} ${addJson.error ?? ""}`);
  const a1 = await dbApp();
  console.log(`  [DB app] approval_checked=${a1?.approval_checked} cafe_checked=${a1?.cafe_checked} resolution=${a1?.resolution} source=${a1?.source}`);
  console.log(`  => 수동 추가 approval_checked 기본값 = ${a1?.approval_checked}  (개설 반영 조건: approval_checked===true)`);

  // ── STEP 2: 개설 (HTTP POST opening) ──
  console.log("\n=== STEP 2: 개설 ===");
  const openRes = await fetch(`${BASE}/api/admin/cluster4/competency/opening`, {
    method: "POST",
    headers: H,
    body: J({ action: "open", organization: ORG, week_id: weekId, output_link_1: CAFE, output_description: DESC }),
  });
  const openJson = await openRes.json();
  const d = openJson?.data ?? {};
  console.log(`  POST opening: http=${openRes.status} success=${openJson.success} ${openJson.error ?? ""}`);
  console.log(`  [개설 응답] linesChanged=${d.linesChanged} linesTotal=${d.linesTotal} openedCrews=${d.openedCrews} openedLines=${d.openedLines} rejectedCrews=${d.rejectedCrews} reflectedLines=${d.reflectedLines} reflectedCrews=${d.reflectedCrews}`);
  const rL = d.reflectedLines ?? (d.openedLines ?? 0) + (d.linesChanged ?? 0);
  const rC = d.reflectedCrews ?? d.openedCrews ?? 0;
  console.log(`  [구 UI 메시지] "개설 완료 — 역량 라인 ${d.linesChanged ?? 0}/${d.linesTotal ?? 0}개 반영"`);
  console.log(`  [신 UI 메시지] "개설 완료 — 역량 라인 ${rL}개 반영${rC ? ` (크루 ${rC}명)` : ""}${d.rejectedCrews ? ` · 반려 ${d.rejectedCrews}명` : ""}"`);

  const a2 = await dbApp();
  console.log(`  [DB app] resolution=${a2?.resolution} opened_line_id=${a2?.opened_line_id?.slice(0, 8) ?? "NULL"} opened_target_id=${a2?.opened_target_id?.slice(0, 8) ?? "NULL"}`);

  let line: any = null, tgts: any[] = [];
  if (a2?.opened_line_id) {
    line = (await sb.from("cluster4_lines").select("id,part_type,line_code,competency_line_master_id,is_active,is_qa_test,output_link_1,output_link_2,submission_closes_at").eq("id", a2.opened_line_id).maybeSingle()).data;
    tgts = (await sb.from("cluster4_line_targets").select("id,week_id,target_user_id").eq("line_id", a2.opened_line_id)).data ?? [];
  }
  console.log(`  [DB cluster4_lines] ${line ? `code=${line.line_code} is_active=${line.is_active} is_qa_test=${line.is_qa_test} link1=${line.output_link_1} link2=${line.output_link_2}` : "MISSING"}`);
  console.log(`  [DB cluster4_line_targets] ${tgts.length}건 ${J(tgts.map((t) => ({ week: t.week_id === weekId ? "W(대상)" : t.week_id?.slice(0, 8), user: t.target_user_id?.slice(0, 8) })))}`);

  // ── 개설 직후 snapshot DB 상태 (HTTP/recompute 트리거 없이 raw 읽기) ──
  const { data: rawSnap } = await sb
    .from("cluster4_weekly_card_snapshots")
    .select("dto_version,is_stale,computed_at,cards")
    .eq("user_id", crew.user_id)
    .maybeSingle();
  let rawAssigned = 0, rawTargetWeekComp = 0;
  if (rawSnap && Array.isArray((rawSnap as any).cards)) {
    for (const c of (rawSnap as any).cards) for (const l of (c.lines ?? [])) {
      if (l.partType === "competency") {
        if (l.lineTargetId) rawAssigned++;
        if (c.weekId === weekId) rawTargetWeekComp++;
      }
    }
  }
  console.log(`  [개설직후 DB snapshot] is_stale=${(rawSnap as any)?.is_stale} computed_at=${(rawSnap as any)?.computed_at?.slice(11, 19)} 배정competency=${rawAssigned} 대상주차competency칸=${rawTargetWeekComp}`);
  console.log(`  => 개설이 snapshot 재계산 실행했나: ${rawAssigned > 0 ? "예(배정 반영됨)" : "아니오(stale/미반영)"}`);

  // snapshot 재계산 후 competency 카드
  let snapComp: any[] = [];
  try {
    const wcRes = await fetch(`${BASE}/api/cluster4/weekly-cards?userId=${crew.user_id}`, { headers: { "x-internal-api-key": IKEY } });
    const wcJson = await wcRes.json();
    const cards = Array.isArray(wcJson?.data) ? wcJson.data : [];
    for (const c of cards) for (const l of (c.lines ?? [])) if (l.partType === "competency") snapComp.push({ week: c.weekId?.slice(0, 8), code: l.lineCode, tgt: l.lineTargetId?.slice(0, 8) ?? null, status: l.status, enh: l.enhancementStatus, reason: l.enhancementReason });
    const assigned = snapComp.filter((c) => c.tgt);
    const mine = snapComp.filter((c) => c.code === MASTER_CODE || c.week === weekId?.slice(0, 8));
    console.log(`  [고객 HTTP weekly-cards] competency 라인 ${snapComp.length}개, 배정(tgt!=null) ${assigned.length}개`);
    console.log(`  [고객 HTTP] 대상 주차/라인 카드: ${J(mine.slice(0, 6))}`);
    const hit = assigned.find((c) => c.week === weekId?.slice(0, 8));
    console.log(`  => 고객앱 반영: ${hit ? `노출 O (lineTargetId 있음, enh=${hit.enh})` : "노출 X (대상 주차 배정 카드 없음)"}`);
  } catch (e: any) {
    console.log(`  [고객 HTTP] 오류: ${e?.message}`);
  }

  // ── 심화 진단: direct 함수 + 강제 재계산 + 대상주차 카드 덤프 ──
  console.log("\n=== 심화 진단 ===");
  const targetWeekShort = weekId?.slice(0, 8);
  // 1) direct 함수 (실시간 계산)
  const direct = await getCluster4WeeklyCardsForProfileUser(crew.user_id);
  const directCard = (direct as any[]).find((c) => c.weekId === weekId);
  const directComp = (directCard?.lines ?? []).filter((l: any) => l.partType === "competency");
  console.log(`  [direct] 대상주차 카드 존재=${!!directCard} weekIds에 대상주차 포함=${(direct as any[]).some((c) => c.weekId === weekId)}`);
  console.log(`  [direct] 대상주차 competency 라인 ${directComp.length}개: ${J(directComp.map((l: any) => ({ code: l.lineCode, tgt: l.lineTargetId?.slice(0, 8) ?? null, status: l.status, enh: l.enhancementStatus, reason: l.enhancementReason })))}`);
  // 2) 강제 재계산 후 snapshot
  await recomputeAndStoreWeeklyCardsSnapshot(crew.user_id);
  const snap = await readWeeklyCardsSnapshot(crew.user_id);
  const snapCards = (snap.status === "hit" || snap.status === "stale") ? (snap.cards as any[]) : [];
  const snapCard = snapCards.find((c) => c.weekId === weekId);
  const snapCompCard = (snapCard?.lines ?? []).filter((l: any) => l.partType === "competency");
  console.log(`  [snapshot 재계산후] status=${snap.status} 대상주차 competency ${snapCompCard.length}개: ${J(snapCompCard.map((l: any) => ({ code: l.lineCode, tgt: l.lineTargetId?.slice(0, 8) ?? null, enh: l.enhancementStatus })))}`);

  // 진단 결론
  console.log("\n=== 진단 ===");
  console.log(`  · approval_checked 기본값: ${a1?.approval_checked} (true면 승인 자동 — 개설 반영 조건 충족)`);
  console.log(`  · 개설 실제 반영: 라인생성=${!!line} 타깃=${tgts.length} → 고객 노출 가능=${!!line && tgts.length > 0}`);
  console.log(`  · 메시지 linesChanged/linesTotal=${d.linesChanged}/${d.linesTotal} vs 실제 openedLines=${d.openedLines} → 메시지 정확=${(d.linesChanged === d.openedLines)}`);

  await cleanup();
  const left = await dbApp();
  console.log(`\n=== CLEANUP === 잔존: ${left ? "남음(주의)" : "없음(net-zero)"}`);
}

main().catch((e) => { console.error("FATAL", e?.stack ?? e); process.exit(1); });
