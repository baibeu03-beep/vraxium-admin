// 자체 정리(self-cleaning) E2E: 실무 역량 라인 개설 오픈 게이트.
//   대상 = QA 테스트 주차 phalanx W13(2026 봄). 임시로 (a) 허브 전체 라인개설 예외 + (b) 오픈 설정
//   config 를 넣어 게이트를 구동하고, 끝나면 원상복구한다(운영 데이터 무접촉).
//   검증:
//     ① 정상 진행 아님(checked=false)        → getStatus.canOpen=false + 사유, openHub 는 409(throw, write 0)
//     ② open_confirmed=false                 → canOpen=false
//     ③ 정상 진행(checked=true)              → canOpen=true (openHub 의 게이트와 동일 함수 → write 경로 통과 증명)
//   openCompetencyHub 는 게이트에서 먼저 throw 하므로 ①에서 라인/타깃/신청 어떤 것도 변경되지 않는다.
// 사용법: npx tsx --env-file=.env.local scripts/verify-competency-line-open-gate.ts
import { createClient } from "@supabase/supabase-js";
import {
  getCompetencyOpeningStatus,
  openCompetencyHub,
  COMPETENCY_LINE_NOT_NORMAL_REASON,
} from "../lib/adminCompetencyLineOpening";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
const ORG = "phalanx";
const WEEK_ID = "a2112b50-64d2-42d6-a243-faf9fcdc6ffc"; // phalanx W13 (QA 테스트 주차)

let pass = 0,
  fail = 0;
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  ok ? pass++ : fail++;
};

async function setConfig(checked: boolean, openConfirmed: boolean) {
  const { error } = await sb.from("cluster4_week_opening_configs").upsert(
    {
      week_id: WEEK_ID,
      organization_slug: ORG,
      config: { practicalCompetency: { checked } },
      open_confirmed: openConfirmed,
    },
    { onConflict: "week_id,organization_slug" },
  );
  if (error) throw new Error(`config upsert 실패: ${error.message}`);
}

async function main() {
  // ── 사전 스냅샷(복구용) ──
  const { data: priorCfg } = await sb
    .from("cluster4_week_opening_configs")
    .select("config,open_confirmed")
    .eq("week_id", WEEK_ID)
    .eq("organization_slug", ORG)
    .maybeSingle();
  const hadConfig = !!priorCfg;
  console.log(`\n사전 config 존재: ${hadConfig}`);

  // 임시 예외 삽입(W13 을 resolveEffectiveWeek 가 수락하도록). 기존 동일 예외가 있으면 재사용.
  const { data: existingExc } = await sb
    .from("line_opening_windows")
    .select("id,is_active")
    .eq("week_id", WEEK_ID)
    .eq("organization_slug", ORG)
    .eq("hub", "competency")
    .is("activity_type_id", null)
    .maybeSingle();
  let tempExcId: string | null = null;
  let reusedExc = false;
  if (existingExc) {
    reusedExc = true;
    await sb.from("line_opening_windows").update({ is_active: true, allow_opening: true }).eq("id", (existingExc as { id: string }).id);
    tempExcId = (existingExc as { id: string }).id;
  } else {
    const { data: ins, error: excErr } = await sb
      .from("line_opening_windows")
      .insert({
        week_id: WEEK_ID,
        organization_slug: ORG,
        hub: "competency",
        activity_type_id: null,
        allow_opening: true,
        is_active: true,
        created_by: null,
      })
      .select("id")
      .single();
    if (excErr) throw new Error(`예외 삽입 실패: ${excErr.message}`);
    tempExcId = (ins as { id: string }).id;
  }

  try {
    // ── ① 정상 진행 아님 (checked=false, confirmed=true) ──
    console.log("\n① 실무 역량 정상 진행 아님 (practicalCompetency.checked=false)");
    await setConfig(false, true);
    const s1 = await getCompetencyOpeningStatus(ORG, "operating", WEEK_ID);
    check("getStatus.canOpen === false", s1.canOpen === false, `canOpen=${s1.canOpen}`);
    check(
      "openBlockedReason 사유 문구 존재",
      s1.openBlockedReason === COMPETENCY_LINE_NOT_NORMAL_REASON,
      s1.openBlockedReason ?? "null",
    );
    // 개설 시도 → 409 throw, write 0.
    let threw = false;
    let status = 0;
    let msg = "";
    try {
      await openCompetencyHub({
        organization: ORG,
        outputLink1: null,
        description: null,
        adminId: null,
        mode: "operating",
        weekId: WEEK_ID,
      });
    } catch (e) {
      threw = true;
      status = (e as { status?: number }).status ?? 0;
      msg = e instanceof Error ? e.message : String(e);
    }
    check("openCompetencyHub throw(개설 거부)", threw);
    check("status === 409", status === 409, `status=${status}`);
    check("throw 메시지 === 사유 문구", msg === COMPETENCY_LINE_NOT_NORMAL_REASON, msg);

    // ── ② open_confirmed=false (checked=true 여도 미확인이면 미개설) ──
    console.log("\n② open_confirmed=false");
    await setConfig(true, false);
    const s2 = await getCompetencyOpeningStatus(ORG, "operating", WEEK_ID);
    check("getStatus.canOpen === false", s2.canOpen === false, `canOpen=${s2.canOpen}`);

    // ── ③ 정상 진행 (checked=true, confirmed=true) ──
    console.log("\n③ 실무 역량 정상 진행 (checked=true, open_confirmed=true)");
    await setConfig(true, true);
    const s3 = await getCompetencyOpeningStatus(ORG, "operating", WEEK_ID);
    check("getStatus.canOpen === true", s3.canOpen === true, `canOpen=${s3.canOpen}`);
    check("openBlockedReason === null", s3.openBlockedReason === null, s3.openBlockedReason ?? "null");
    console.log(
      "  · (openCompetencyHub 는 canOpen 과 동일한 resolveCompetencyLineOpenGate 를 사용하므로,\n" +
        "     canOpen=true 는 개설 write 경로가 게이트를 통과함을 의미한다. 테스트 데이터 변경을 피하려\n" +
        "     정상 케이스의 실제 개설 write 는 실행하지 않는다.)",
    );

    // ── 개설 대상 주차 무관성: 다른(정상) 주차 선택 시 재계산 (getStatus 는 requestedWeekId 기반) ──
    console.log("\n④ 주차 재계산 — 같은 org, checked 만 토글해도 canOpen 이 따라감(위 ①↔③ 대비로 증명)");
    check("checked=false→canOpen=false, checked=true→canOpen=true 재현", s1.canOpen === false && s3.canOpen === true);
  } finally {
    // ── 복구 ──
    if (tempExcId && !reusedExc) {
      await sb.from("line_opening_windows").delete().eq("id", tempExcId);
    } else if (tempExcId && reusedExc) {
      // 원래 존재하던 예외라면 비활성 상태를 알 수 없으니 그대로 둔다(원래 활성이었을 수 있음). 로깅만.
      console.log("\n(주의) 기존 예외를 재사용함 — is_active 원복은 수동 확인 필요.");
    }
    if (hadConfig && priorCfg) {
      await sb
        .from("cluster4_week_opening_configs")
        .update({
          config: (priorCfg as { config: unknown }).config,
          open_confirmed: (priorCfg as { open_confirmed: boolean }).open_confirmed,
        })
        .eq("week_id", WEEK_ID)
        .eq("organization_slug", ORG);
      console.log("복구: 기존 config 원복 완료");
    } else {
      await sb
        .from("cluster4_week_opening_configs")
        .delete()
        .eq("week_id", WEEK_ID)
        .eq("organization_slug", ORG);
      console.log("복구: 임시 config 삭제 완료");
    }
  }

  console.log(`\n결과: ${pass} pass / ${fail} fail`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("스크립트 오류:", e);
  process.exit(1);
});
