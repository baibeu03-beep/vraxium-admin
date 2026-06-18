// 변동 액트 — direct function 검증 (데이터레이어 직접 호출) + direct==HTTP 대조.
//   run: npx tsx --env-file=.env.local scripts/verify-process-check-irregular-direct.ts
//   전제: dev 서버(:3000) + 2026-06-15_process_irregular_acts.sql 적용.
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import {
  createIrregularAct,
  createManualGrant,
  getIrregularBoard,
  completeIrregularAct,
  deleteIrregularAct,
} from "@/lib/adminProcessIrregularData";

const BASE = "http://localhost:3000";
const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const EMAIL = "vanuatu.golden@gmail.com";
const ORG = "oranke";
const TAG = "ZZ-irr-direct";
const DAY = 86_400_000;

let pass = 0, fail = 0;
const ck = (l: string, ok: boolean, d = "") => { console.log(`  ${ok ? "✓" : "✗"} ${l}${d ? ` — ${d}` : ""}`); ok ? pass++ : fail++; };

async function cleanup() {
  const rows = (await supabaseAdmin.from("process_irregular_acts").select("id").like("act_name", `${TAG}%`)).data as { id: string }[] | null;
  if (rows?.length) await supabaseAdmin.from("process_check_review_recipients").delete().in("ref_id", rows.map((r) => r.id));
  await supabaseAdmin.from("process_irregular_acts").delete().like("act_name", `${TAG}%`);
}

async function main() {
  const probe = await supabaseAdmin.from("process_irregular_acts").select("id").limit(1);
  if (probe.error) { console.log(`⚠ 마이그레이션 미적용(${probe.error.code}) — 적용 후 재실행`); process.exit(2); }

  // 운영진(applicant) admin id.
  const admin = (await supabaseAdmin.from("admin_users").select("id").eq("is_active", true).limit(1).maybeSingle()).data as { id: string } | null;
  if (!admin) { console.log("⚠ active admin 없음"); process.exit(2); }

  // 대상 후보(oranke): 운영 1 + 테스트 1.
  const markers = new Set(((await supabaseAdmin.from("test_user_markers").select("user_id")).data ?? []).map((x: { user_id: string }) => x.user_id));
  const oranke = ((await supabaseAdmin.from("user_profiles").select("user_id").eq("organization_slug", ORG)).data ?? []) as { user_id: string }[];
  const opTarget = oranke.find((u) => !markers.has(u.user_id));
  const teTarget = oranke.find((u) => markers.has(u.user_id));
  ck("[전제] 운영/테스트 대상 + admin 존재", !!opTarget && !!teTarget && !!admin);
  if (!opTarget || !teTarget) { console.log("⚠ 대상 부족"); await cleanup(); process.exit(2); }

  await cleanup();

  // ── 1. direct: 수동 부여(operating·복수 크루) → completed · cafeLabel=미발생 · recipients ──
  const mg = await createManualGrant({
    organization: ORG, mode: "operating", adminId: admin.id,
    actName: `${TAG} 수동`, targetUserIds: [opTarget.user_id],
    durationMinutes: 20, reason: "사유", pointA: 4, pointB: 1, pointC: 1, crewReaction: "partial", pointMode: "ab",
  });
  ck("[direct] 수동부여 → status=completed · cafeLabel=미발생 · 크루1명", mg.status === "completed" && mg.cafeLabel === "미발생" && !!mg.completedAt && mg.matchedCount === 1 && mg.targetUserId === null);

  // ── 2. direct: 검수 신청(operating) → pending · cafeLabel=발생 ──
  const rr = await createIrregularAct({
    organization: ORG, mode: "operating", adminId: admin.id,
    kind: "review_request", actName: `${TAG} 검수`, targetUserId: null,
    pointA: 2, pointB: 1, pointC: 0, crewReaction: "partial", pointMode: "ab",
    reviewLink: "https://cafe.naver.com/irr/d", scheduledCheckAt: new Date(Date.now() + DAY).toISOString(),
  });
  ck("[direct] 검수신청 → status=pending · cafeLabel=발생 · target null", rr.status === "pending" && rr.cafeLabel === "발생" && rr.targetUserId === null);

  // ── 3. direct: getIrregularBoard(operating) — 요약 + 행 노출 ──
  const board = await getIrregularBoard(ORG, "operating");
  ck("[direct] 보드 요약 검수≥1·수동≥1·완료≥1·대기≥1", board.summary.reviewRequest >= 1 && board.summary.manualGrant >= 1 && board.summary.completed >= 1 && board.summary.pending >= 1, JSON.stringify(board.summary));
  ck("[direct] 보드에 생성 행 노출", board.acts.some((a) => a.id === mg.id) && board.acts.some((a) => a.id === rr.id));

  // ── 4. direct: 스코프 가드 — operating 에서 테스트 대상 → throw 422 ──
  let guard422 = false;
  try {
    await createManualGrant({ organization: ORG, mode: "operating", adminId: admin.id, actName: `${TAG} 가드`, targetUserIds: [teTarget.user_id], crewReaction: "partial", pointMode: "ab" });
  } catch (e) { guard422 = (e as { status?: number })?.status === 422; }
  ck("[direct] operating+테스트크루 → 422 throw(write 0)", guard422);

  // ── 5. direct: test 모드 보드는 operating 행 미노출 ──
  const teBoard = await getIrregularBoard(ORG, "test");
  ck("[direct] test 보드에 operating 행 없음", !teBoard.acts.some((a) => a.id === mg.id) && !teBoard.acts.some((a) => a.id === rr.id));

  // ── 6. direct == HTTP — 같은 입력의 HTTP GET 보드와 대조 ──
  const sbBrow = createClient(URL, ANON);
  // generateLink 는 service-role 필요(admin API) — supabaseAdmin 사용. verifyOtp 는 anon 클라이언트.
  const { data: link } = await supabaseAdmin.auth.admin.generateLink({ type: "magiclink", email: EMAIL }).catch(() => ({ data: null as never }));
  let httpOk = false, httpMatch = false;
  if (link?.properties?.email_otp) {
    const { data: v } = await sbBrow.auth.verifyOtp({ email: EMAIL, token: link.properties.email_otp, type: "magiclink" });
    const cap: { name: string; value: string }[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const srv = createServerClient(URL, ANON, { cookies: { getAll: () => [], setAll: (i: any) => cap.push(...i) } } as any);
    await srv.auth.setSession({ access_token: v!.session!.access_token, refresh_token: v!.session!.refresh_token });
    const cookie = cap.map((i) => `${i.name}=${i.value}`).join("; ");
    const res = await fetch(`${BASE}/api/admin/processes/check/irregular?org=${ORG}`, { headers: { cookie } });
    const json = await res.json().catch(() => ({}));
    httpOk = res.ok && json.success;
    const httpRow = (json.data?.acts ?? []).find((a: { id: string }) => a.id === rr.id);
    const dirRow = board.acts.find((a) => a.id === rr.id);
    httpMatch = !!httpRow && !!dirRow &&
      httpRow.status === dirRow.status &&
      httpRow.cafeLabel === dirRow.cafeLabel &&
      httpRow.pointA === dirRow.pointA &&
      httpRow.reviewLink === dirRow.reviewLink &&
      httpRow.targetUserId === dirRow.targetUserId;
  }
  ck("[HTTP] GET 200(authed)", httpOk);
  ck("[direct==HTTP] 동일 행 status/cafe/point/link/target 일치", httpMatch);

  // ── 7. direct: 완료/삭제 ──
  const done = await completeIrregularAct(rr.id, ORG, "operating");
  ck("[direct] complete → completed", done.status === "completed");
  await deleteIrregularAct(mg.id, ORG, "operating");
  const gone = (await supabaseAdmin.from("process_irregular_acts").select("id").eq("id", mg.id).maybeSingle()).data;
  ck("[direct] delete → 행 제거", !gone);
}

main()
  .catch((e) => { console.error("ERROR:", e?.stack ?? e?.message ?? e); fail++; })
  .finally(async () => { await cleanup(); console.log("(cleanup — net-zero)"); console.log(`\n결과: ${pass} pass / ${fail} fail`); process.exit(fail > 0 ? 1 : 0); });
