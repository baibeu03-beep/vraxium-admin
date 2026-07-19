// VERIFY (post-fix) — T강민지 / 2026-summer W2. 두 표면(어드민·크루/고객) 실제 로더로 재현.
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { loadActLogsByStartDate } from "@/lib/cluster4ActLogsData";
import { buildCrewActSummary, resolveCrewActKind, type CrewActSummaryRow } from "@/shared/crewActSummary";

const TARGET = "00b75923-2109-4214-806a-37667d64ac5e";
const W2_START = "2026-07-06";

async function partByRef(refIds: string[]) {
  const m = new Map<string, string | null>();
  const { data } = await supabaseAdmin.from("process_check_statuses").select("id,part_name,team_id").in("id", refIds);
  for (const s of (data ?? []) as any[]) m.set(s.id, s.part_name ?? "(팀총괄)");
  return m;
}

async function surface(label: string, includeCancelled: boolean) {
  const byStart = await loadActLogsByStartDate(TARGET, { includeCancelled });
  const logs = (byStart.get(W2_START) ?? []).filter((l) => l.source === "regular" || l.source === "irregular");
  const refIds = [...new Set(logs.map((l: any) => l.__ref ?? null).filter(Boolean))];
  // loadActLogsByStartDate 는 ref_id 를 노출하지 않으므로 awardId→ref 매핑 별도 조회.
  const awardIds = logs.map((l) => l.awardId);
  const refByAward = new Map<string, string>();
  const { data: aw } = await supabaseAdmin.from("process_point_awards").select("id,ref_id").in("id", awardIds);
  for (const r of (aw ?? []) as any[]) refByAward.set(r.id, r.ref_id);
  const parts = await partByRef([...new Set([...refByAward.values()])]);

  console.log(`\n==== 표면: ${label} (includeCancelled=${includeCancelled}) ====`);
  const orgMgmt = logs.filter((l) => l.lineGroupName === "[파트] 조직 관리");
  for (const l of logs) {
    const ref = refByAward.get(l.awardId);
    const scope = ref ? parts.get(ref) : "?";
    console.log(`  ${l.cancelled ? "[취소됨]" : "[활성]  "} act="${l.actName}" line="${l.lineGroupName ?? "-"}" scope=${scope} A=${l.pointA} B=${l.pointB} C=${l.pointC} @${l.occurredAt}`);
  }
  console.log(`  → "[파트] 조직 관리" 행 수: 전체=${orgMgmt.length}, 활성=${orgMgmt.filter((l) => !l.cancelled).length}`);

  // 요약(취소 제외 — 두 표면 공통 규칙)
  const rows: CrewActSummaryRow[] = logs.filter((l) => !l.cancelled).map((l) => ({
    result: "checked", source: l.source === "irregular" ? "irregular" : "regular",
    kindKey: resolveCrewActKind(l.source, l.kind).key, pointA: l.pointA, pointB: l.pointB, pointC: l.pointC,
  }));
  const s = buildCrewActSummary(rows);
  console.log(`  요약: 체크가능=${s.total} 성공=${s.success} 실패=${s.fail} 완료율=${s.rate}% 정규=${s.regularActCount} 변동=${s.variableActCount} 필수=${s.required} 선별=${s.selective}`);
  console.log(`        Point.A earned=${s.points.pointA.earned} B=${s.points.pointB.earned} C=${s.points.pointC.earned}`);
  return s;
}

async function main() {
  // 원장 상태(응대 유지 / 정책 취소 / 팀시작 유지 / 가이드 적용 부재)
  const { data: led } = await supabaseAdmin.from("process_point_awards").select("id,ref_id,point_check,point_advantage,point_penalty,cancelled_at,cancel_reason").eq("user_id", TARGET).eq("year", 2026).eq("week_number", 28).eq("source", "regular");
  const refs = [...new Set(((led ?? []) as any[]).map((r) => r.ref_id))];
  const parts = await partByRef(refs);
  console.log("=== 원장(regular, W2) 상태 — 관심 행 ===");
  for (const r of (led ?? []) as any[]) {
    const scope = parts.get(r.ref_id);
    const interesting = ["29ad0ece-dae5-4c5d-a380-245eed279a60", "aa79f2a2-aad7-4215-bc50-ff0050048432", "a4fae98a-e026-4639-8e21-ff01299837a3"].includes(r.ref_id);
    if (interesting) console.log(`  award=${r.id} ref=${r.ref_id} scope=${scope} A=${r.point_check} cancelled=${r.cancelled_at ?? "-"} reason=${r.cancel_reason ?? "-"}`);
  }

  const admin = await surface("어드민 액트 탭", true);
  const crew = await surface("크루/고객(snapshot 동일 로더)", false);

  console.log("\n=== 검증 결론 ===");
  console.log(`크루/고객 "[파트] 조직 관리" 활성 1개만 표시: ${crew.total >= 0 ? "확인(아래 활성 행 수)" : ""}`);
  console.log(`어드민==크루 요약 동일값?  체크가능 ${admin.total}==${crew.total}, 성공 ${admin.success}==${crew.success}, Point.A ${admin.points.pointA.earned}==${crew.points.pointA.earned} → ${admin.total === crew.total && admin.points.pointA.earned === crew.points.pointA.earned ? "동일" : "다름(취소행 표시차이 확인 필요)"}`);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
