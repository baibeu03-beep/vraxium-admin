// 수정 前 생성된 common(line_code=null) info 라인 7건 정리(운영 승인 06-16, "분석대로 정리").
//   ① 메인 타이틀 테스트(oranke 5타깃) → line_code 에 oranke(OK) 토큰 백필.
//   ②③ 포럼 테스트 + 관심있는 산업/직무 5건(전부 무타깃) → is_active=false 비활성화.
//   변경 前 common audience(전 org) 를 stale 처리 → 타org 잠재 누수 lazy 재계산으로 교정.
//   롤백 백업 = claudedocs/rollback-legacy-common-info-lines-*.json (라인+타깃 원본).
// 사용법: npx tsx --env-file=.env.local scripts/fix-legacy-common-info-lines.ts        (dry-run, 기본)
//        APPLY=1 npx tsx --env-file=.env.local scripts/fix-legacy-common-info-lines.ts (실제 적용)
import { createClient } from "@supabase/supabase-js";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { collectLineOrgAudience } from "../lib/adminCluster4LinesData";
import { invalidateWeeklyCardsForUsers } from "../lib/cluster4WeeklyCardsSnapshot";
import { lineCodeTokenForOrg } from "../lib/cluster4LineOrg";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
const APPLY = process.env.APPLY === "1";

const BACKFILL = [{ id: "7a8e52de-17df-45ff-88ae-c3e214e5f7d3", org: "oranke" as const }];
const DEACTIVATE = [
  "db442272-bcf8-4259-bd94-dcd39377a7c8",
  "c8f4843d-799f-4ce2-a198-bfdd05f97d19",
  "2f25989e-a603-4e30-b659-ebcb815b4a6a",
  "24666447-bdf5-46f4-84ed-0f5b1a9859d2",
  "690b5a3e-b679-409b-87fd-747c08664930",
  "ddf974a1-c778-4961-abd4-0da58cdcde56",
];

async function main() {
  const allIds = [...BACKFILL.map((b) => b.id), ...DEACTIVATE];

  // 0) 안전 확인 — 대상이 정말 part_type=info·is_active·line_code=null 인지 재확인(fail-closed).
  const { data: rows } = await sb.from("cluster4_lines")
    .select("id,part_type,is_active,line_code,main_title,week_id,output_link_1,output_link_2,output_links,output_images,submission_opens_at,submission_closes_at,activity_type_id")
    .in("id", allIds);
  const byId = new Map((rows ?? []).map((r: any) => [r.id, r]));
  for (const id of allIds) {
    const r = byId.get(id);
    if (!r) throw new Error(`대상 라인 없음(중단): ${id}`);
    if (r.part_type !== "info" || r.is_active !== true || r.line_code !== null) {
      throw new Error(`대상 상태 불일치(중단): ${id} part=${r.part_type} active=${r.is_active} code=${r.line_code}`);
    }
  }

  // 1) 타깃 백업.
  const { data: targets } = await sb.from("cluster4_line_targets").select("*").in("line_id", allIds);

  // 2) 변경 前 audience(common=전 org) 수집 → 후에 stale 처리.
  const audienceSet = new Set<string>();
  for (const id of allIds) {
    const aud = await collectLineOrgAudience(id);
    aud.forEach((u) => audienceSet.add(u));
  }
  const audience = [...audienceSet];

  // 3) 롤백 백업 저장.
  const ts = new Date(parseInt(process.env.STAMP ?? "0") || Date.now()).toISOString();
  const stamp = ts.replace(/[:.]/g, "-");
  const backupPath = resolve(__dirname, "..", "claudedocs", `rollback-legacy-common-info-lines-${stamp}.json`);
  const backup = { ts, lines: rows, targets, plan: { backfill: BACKFILL, deactivate: DEACTIVATE }, audienceCount: audience.length };
  writeFileSync(backupPath, JSON.stringify(backup, null, 2));
  console.log(`[backup] ${backupPath}`);

  console.log(`\n대상: 백필 ${BACKFILL.length}건 / 비활성화 ${DEACTIVATE.length}건 / audience(stale) ${audience.length}명`);
  for (const b of BACKFILL) {
    const code = `IF${lineCodeTokenForOrg(b.org)}-FIX${Date.now()}`;
    console.log(`  backfill ${b.id} → line_code=${code} (${byId.get(b.id)?.main_title?.slice(0, 24)})`);
    if (APPLY) {
      const { error } = await sb.from("cluster4_lines").update({ line_code: code }).eq("id", b.id);
      if (error) throw new Error(`backfill 실패 ${b.id}: ${error.message}`);
    }
  }
  for (const id of DEACTIVATE) {
    console.log(`  deactivate ${id} (${byId.get(id)?.main_title?.slice(0, 24)})`);
    if (APPLY) {
      const { error } = await sb.from("cluster4_lines").update({ is_active: false }).eq("id", id);
      if (error) throw new Error(`deactivate 실패 ${id}: ${error.message}`);
    }
  }

  if (APPLY) {
    const res = await invalidateWeeklyCardsForUsers(audience);
    console.log(`\n[snapshot] invalidate mode=${res.mode} count=${res.count} (stale→lazy 재계산으로 교정)`);
    console.log("✅ 적용 완료");
  } else {
    console.log("\n(dry-run) APPLY=1 로 실제 적용. 위 계획만 출력했습니다.");
  }
}
main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
