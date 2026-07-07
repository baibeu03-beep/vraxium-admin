/**
 * [실무 역량] 라인 삭제 시 고아 미생성(소스 예방) 검증.
 *   npx tsx --env-file=.env.local scripts/verify-competency-delete-no-orphan.ts
 *
 * 시나리오: 신청 삽입 → openApprovedApplications(라인 생성) → deleteCluster4Line(일반 라인 삭제)
 *   → cluster4_competency_applications 가 pending 으로 복원되고 opened_line_id=null (고아 아님) 확인.
 *   대조: 수정 전이면 resolution 이 opened 로 남아 고아가 됨.
 * 격리: oranke active 테스트 유저, line_name 고정, 끝에 정리.
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";
import { openApprovedApplications } from "../lib/adminCompetencyApplications";
import { deleteCluster4Line } from "../lib/adminCluster4LinesData";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
const ORG = "oranke";
const MASTER_CODE = "CPBS-NN0001";
const LINE_NAME = "ZZ-삭제고아-역량라인";
const J = (o: unknown) => JSON.stringify(o);

async function cleanup() {
  const { data: apps } = await sb.from("cluster4_competency_applications").select("id,opened_line_id").eq("organization_slug", ORG).eq("line_name", LINE_NAME);
  for (const a of (apps ?? []) as any[]) {
    if (a.opened_line_id) {
      await sb.from("cluster4_line_targets").delete().eq("line_id", a.opened_line_id);
      await sb.from("cluster4_lines").delete().eq("id", a.opened_line_id);
    }
  }
  await sb.from("cluster4_competency_applications").delete().eq("organization_slug", ORG).eq("line_name", LINE_NAME);
}

async function main() {
  await cleanup();
  const { data: tm } = await sb.from("test_user_markers").select("user_id");
  const ids = (tm ?? []).map((x: any) => x.user_id);
  const { data: prof } = await sb.from("user_profiles").select("user_id,display_name").eq("organization_slug", ORG).eq("growth_status", "active").in("user_id", ids).limit(1);
  const crew = (prof ?? [])[0] as any;
  const { data: master } = await sb.from("cluster4_competency_line_masters").select("id,line_code").eq("line_code", MASTER_CODE).maybeSingle();
  const weekId = (await sb.from("weeks").select("id").eq("iso_year", 2026).eq("iso_week", 19).maybeSingle()).data?.id
    ?? (await sb.from("weeks").select("id").order("start_date", { ascending: false }).limit(1)).data?.[0]?.id;

  // 신청 삽입(승인) → 개설
  await sb.from("cluster4_competency_applications").insert({
    organization_slug: ORG, week_id: weekId, target_user_id: crew.user_id,
    competency_line_master_id: (master as any).id, line_code: (master as any).line_code,
    line_name: LINE_NAME, source: "manual", approval_checked: true, created_by: null,
  });
  const r = await openApprovedApplications({ org: ORG as any, weekId, outputLink1: null, description: null, adminId: null, mode: "operating" });
  const lineId = r.openedLineIds[0];
  const before = (await sb.from("cluster4_competency_applications").select("resolution,opened_line_id").eq("organization_slug", ORG).eq("line_name", LINE_NAME).maybeSingle()).data as any;
  console.log(`개설 후: resolution=${before?.resolution} opened_line_id=${before?.opened_line_id?.slice(0, 8)} (라인=${lineId?.slice(0, 8)})`);

  // 일반 라인 관리 삭제
  await deleteCluster4Line(lineId!, "operating");
  const after = (await sb.from("cluster4_competency_applications").select("resolution,opened_line_id,opened_target_id").eq("organization_slug", ORG).eq("line_name", LINE_NAME).maybeSingle()).data as any;
  const lineGone = ((await sb.from("cluster4_lines").select("id").eq("id", lineId!)).data ?? []).length === 0;
  console.log(`라인 삭제 후: 라인삭제=${lineGone} app.resolution=${after?.resolution} app.opened_line_id=${after?.opened_line_id ?? "null"} app.opened_target_id=${after?.opened_target_id ?? "null"}`);

  const noOrphan = after?.resolution === "pending" && !after?.opened_line_id;
  console.log(`\n=> 소스 예방 검증: 라인 삭제 시 신청 pending 복원(고아 아님) = ${noOrphan ? "PASS ✅" : "FAIL ❌"}`);

  await cleanup();
  const left = ((await sb.from("cluster4_competency_applications").select("id").eq("organization_slug", ORG).eq("line_name", LINE_NAME)).data ?? []).length;
  console.log(`정리 잔존=${left}건`);
}
main().catch((e) => { console.error("FATAL", e?.stack ?? e); process.exit(1); });
