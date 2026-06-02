/**
 * READ-ONLY 진단: 4허브 카드의 lineName / main_title 매핑 붕괴 추적.
 *   cluster4_lines.main_title (= 고객 DTO mainTitle) 와
 *   master.line_name / master.(default_)main_title 의 의도된 분리값을 한 줄로 비교.
 * 마지막으로 실제 스냅샷(cluster4_weekly_card_snapshots)에서 고객이 받는 mainTitle 도 대조.
 *   npx tsx --env-file=.env.local scripts/diag-cluster4-linename-maintitle.ts
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const j = (v: unknown) => (v == null ? "∅" : JSON.stringify(v));

async function main() {
  // 1) cluster4_lines 원본 (고객 DTO mainTitle 의 단일 source)
  const { data: lines } = await sb
    .from("cluster4_lines")
    .select(
      "id,part_type,line_code,main_title,competency_line_master_id,experience_line_master_id,career_project_id,is_active",
    )
    .in("part_type", ["experience", "competency", "career"])
    .eq("is_active", true)
    .limit(400);

  const rows = lines ?? [];
  // 마스터 조회 (line_name 의 원천)
  const expIds = rows.map((r: any) => r.experience_line_master_id).filter(Boolean);
  const compIds = rows.map((r: any) => r.competency_line_master_id).filter(Boolean);
  const carIds = rows.map((r: any) => r.career_project_id).filter(Boolean);

  const [exp, comp, car] = await Promise.all([
    expIds.length
      ? sb.from("cluster4_experience_line_masters").select("id,line_name,default_main_title,line_code").in("id", expIds)
      : Promise.resolve({ data: [] as any[] }),
    compIds.length
      ? sb.from("cluster4_competency_line_masters").select("id,line_name,main_title,line_code").in("id", compIds)
      : Promise.resolve({ data: [] as any[] }),
    carIds.length
      ? sb.from("career_projects").select("id,line_name,default_main_title,line_code").in("id", carIds)
      : Promise.resolve({ data: [] as any[] }),
  ]);

  const expM = new Map((exp.data ?? []).map((m: any) => [m.id, m]));
  const compM = new Map((comp.data ?? []).map((m: any) => [m.id, m]));
  const carM = new Map((car.data ?? []).map((m: any) => [m.id, m]));

  console.log("=== cluster4_lines vs master (lineName / mainTitle 분리값) ===\n");
  let collapsed = 0;
  let printed = 0;
  for (const r of rows as any[]) {
    let masterLineName: string | null = null;
    let masterMainTitle: string | null = null;
    if (r.part_type === "experience") {
      const m = expM.get(r.experience_line_master_id);
      masterLineName = m?.line_name ?? null;
      masterMainTitle = m?.default_main_title ?? null;
    } else if (r.part_type === "competency") {
      const m = compM.get(r.competency_line_master_id);
      masterLineName = m?.line_name ?? null;
      masterMainTitle = m?.main_title ?? null;
    } else if (r.part_type === "career") {
      const m = carM.get(r.career_project_id);
      masterLineName = m?.line_name ?? null;
      masterMainTitle = m?.default_main_title ?? null;
    }
    // line.main_title 가 master.line_name 과 같으면 = "라인명이 mainTitle 자리에 들어감" 신호
    const dbMain = r.main_title ?? null;
    const collapsedHere =
      masterLineName != null && dbMain != null && masterLineName.trim() === dbMain.trim();
    const masterTitleMissing = masterMainTitle == null || masterMainTitle.trim() === "";
    if (collapsedHere) collapsed++;
    // 의미 있는 표본만 일부 출력
    if (printed < 18 && (collapsedHere || masterTitleMissing || masterMainTitle !== dbMain)) {
      printed++;
      console.log(
        `[${r.part_type}] line=${r.line_code ?? "∅"}\n` +
          `   cluster4_lines.main_title (→DTO.mainTitle): ${j(dbMain)}\n` +
          `   master.line_name        (의도: 라인명)     : ${j(masterLineName)}\n` +
          `   master.main_title       (의도: Main Title) : ${j(masterMainTitle)}` +
          `${masterTitleMissing ? "  ⚠ master mainTitle 비어있음→ writer가 line_name을 main_title에 기입" : ""}` +
          `${collapsedHere ? "\n   ⚠ COLLAPSE: line.main_title == master.line_name (라인명==메인타이틀)" : ""}\n`,
      );
    }
  }
  console.log(
    `\n표본 ${rows.length}행 중 main_title==line_name(붕괴) = ${collapsed}행 / ` +
      `(고객 DTO는 lineName 필드 자체가 없음 — mainTitle 단일)\n`,
  );

  // 2) 실제 고객 수신 snapshot 의 mainTitle (최종 API 응답 대조)
  const { data: snaps } = await sb
    .from("cluster4_weekly_card_snapshots")
    .select("user_id,cards")
    .limit(1);
  const snap = (snaps ?? [])[0] as any;
  if (snap) {
    console.log(`=== 최종 API(snapshot) 대조 — user ${snap.user_id} ===`);
    const cards = Array.isArray(snap.cards) ? snap.cards : [];
    let shown = 0;
    for (const c of cards) {
      for (const l of c.lines ?? []) {
        if (["experience", "competency", "career"].includes(l.partType) && shown < 10) {
          shown++;
          console.log(
            `   [${l.partType}] lineCode=${j(l.lineCode)}  DTO.mainTitle=${j(l.mainTitle)}  (lineName 필드 존재? ${"lineName" in l})`,
          );
        }
      }
    }
  } else {
    console.log("snapshot 없음");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
