/**
 * 변동(비정규) 액트 "즉시 검수" — 메커니즘 검증(source='irregular').
 *   미래 예약 review_request 항목을 시드해:
 *     [A] 기본 sweep(시각 게이트 유지)은 미처리 → 자동 스케줄 불변
 *     [B] ignoreSchedule 우회 + 주입 매칭 → status='completed'(체크 완료)
 *     [source] runProcessCheckRowNow(source='irregular')가 올바른 테이블에서 판정
 *   무흔적 cleanup.
 *
 *   npx tsx --env-file=.env.local scripts/verify-irregular-immediate-review.ts
 */
import { createClient } from "@supabase/supabase-js";
import { runDueProcessCheckSweep, findDueProcessCheckItems } from "@/lib/processCheckDueSweep";
import { runProcessCheckRowNow } from "@/lib/qaRunNow";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
let pass = 0, fail = 0;
const ck = (l: string, ok: boolean, d = "") => { console.log(`${ok ? "✅" : "❌"} ${l}${d ? ` — ${d}` : ""}`); ok ? pass++ : fail++; };
const T = "process_irregular_acts";
const RECIP = "process_check_review_recipients";

async function statusOf(id: string) {
  const { data } = await sb.from(T).select("status").eq("id", id).maybeSingle();
  return (data as { status: string } | null)?.status ?? null;
}

async function main() {
  const { data: markers } = await sb.from("test_user_markers").select("user_id");
  const ids = (markers ?? []).map((r) => r.user_id);
  const { data: prof } = await sb.from("user_profiles").select("user_id,organization_slug").in("user_id", ids).eq("organization_slug", "encre").limit(1).maybeSingle();
  const crew = prof as { user_id: string; organization_slug: string } | null;
  const { data: week } = await sb.from("weeks").select("id").order("start_date", { ascending: false }).limit(1).maybeSingle();
  if (!crew || !(week as any)?.id) { console.log("⚠ 전제 부족 — skip"); process.exit(0); }
  const future = new Date(Date.now() + 2 * 86_400_000).toISOString();

  const seedRow = (linkSuffix: string) => ({
    organization_slug: "encre", week_id: (week as any).id, kind: "review_request", act_name: "[QA] 즉시검수 픽스처",
    applicant_admin_id: "c28b2409-4118-49fc-a42e-68e18dbd194c", applicant_admin_name: "QA", crew_reaction: "all",
    point_a: 0, point_b: 0, point_c: 0, review_link: `https://cafe.naver.com/${linkSuffix}`, scheduled_check_at: future,
    status: "pending", scope_mode: "test", attempt_count: 0,
  });

  let id: string | null = null, id2: string | null = null;
  try {
    const ins = await sb.from(T).insert(seedRow("qa-irr")).select("id").maybeSingle();
    if (ins.error || !ins.data) { console.log(`⚠ 시드 실패(${ins.error?.message}) — skip`); process.exit(0); }
    id = (ins.data as { id: string }).id;
    const ins2 = await sb.from(T).insert(seedRow("qa-irr-2")).select("id").maybeSingle();
    id2 = (ins2.data as { id: string } | null)?.id ?? null;
    ck("[seed] 미래예약 변동 review_request 시드", Boolean(id && id2));

    // [A] 자동 스케줄 불변 — 시각 게이트 유지 findDue 는 미래 항목 미포함.
    const due = await findDueProcessCheckItems(new Date().toISOString());
    ck("[A] 기본 findDue 에 미래 변동항목 미포함(자동 스케줄 불변)", !due.some((d) => d.id === id));
    const auto = await runDueProcessCheckSweep({ scope: "qa", onlyIds: [id!], accrue: null });
    ck("[A] 자동 sweep 미처리(status pending)", auto.succeeded === 0 && (await statusOf(id!)) === "pending");

    // [B] 우회 + 주입 매칭 → 체크 완료.
    const forced = await runDueProcessCheckSweep({
      scope: "qa", onlyIds: [id!], ignoreSchedule: true, ignoreRetryGate: true, accrue: null,
      crawlAndMatch: async () => ({ matched: [{ userId: crew!.user_id, nickname: "qa" }], review: [] }),
    });
    ck("[B] 우회 실행 → 체크 완료(시각 전이라도)", forced.succeeded === 1 && (await statusOf(id!)) === "completed");

    // [source] 래퍼가 올바른 테이블에서 판정 + 즉시 검수 = 항상 체크 완료(테스트 행).
    //   id(이미 완료) → 멱등(ok=true·완료 유지). id2(대기·크롤 못 읽음) → 그래도 완료(핵심 신동작).
    const asIrr = await runProcessCheckRowNow({ statusId: id!, source: "irregular", actor: "verify" });
    ck("[source] source='irregular' 이미 완료 → 멱등(완료 유지)", asIrr.ok === true && (await statusOf(id!)) === "completed", `${asIrr.code}/${await statusOf(id!)}`);
    const asIrr2 = await runProcessCheckRowNow({ statusId: id2!, source: "irregular", actor: "verify" });
    ck("[source] 인증 못 찾아도 체크 완료(pending→completed)", asIrr2.ok === true && (await statusOf(id2!)) === "completed", `${asIrr2.code}/${await statusOf(id2!)}`);
    ck("[source] code 는 3종 중 하나", ["confirmed", "no_match", "not_found"].includes(asIrr2.code), asIrr2.code);
    // 오테이블(regular) 로 조회 → 정규 테이블에 없음 → 처리 실패(not_found).
    const asReg = await runProcessCheckRowNow({ statusId: id!, source: "regular", actor: "verify" });
    ck("[source] source='regular'(오테이블) → not_found(실패)", asReg.ok === false && asReg.code === "not_found", asReg.code);
  } finally {
    const seeded = [id, id2].filter((x): x is string => Boolean(x));
    if (seeded.length) { await sb.from(RECIP).delete().in("ref_id", seeded); await sb.from(T).delete().in("id", seeded); }
    const { count } = await sb.from(T).select("id", { count: "exact", head: true }).in("id", seeded.length ? seeded : ["00000000-0000-0000-0000-000000000000"]);
    ck("[cleanup] 시드 삭제(무흔적)", (count ?? 0) === 0);
  }
  console.log(`\n${pass} pass / ${fail} fail`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
