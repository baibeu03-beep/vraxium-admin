/** 장승완 3개 이슈 수정 검증 (read-only). */
import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";
import { getCluster4WeeklyCardsForProfileUser } from "@/lib/cluster4WeeklyCardsData";
import { getCluster1Resume } from "@/lib/cluster1ResumeData";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
const UUID = "14f5c826-b2cf-4a88-abda-7168f3be907d";
const LEGACY = UUID; // getAdminCrewDtoByLegacyUserId 는 user_id(UUID) 로 조회

async function main() {
  // 이슈1 — submission growth_point NULL
  const { data: subs } = await sb.from("cluster4_line_submissions").select("growth_point,subtitle").eq("user_id", UUID).range(0, 999);
  const gpNonNull = (subs ?? []).filter((s: any) => s.growth_point != null).length;
  const subtitleNonNull = (subs ?? []).filter((s: any) => s.subtitle != null).length;
  console.log(`이슈1 growth_point: 제출 ${(subs ?? []).length}행 · growth_point 비NULL ${gpNonNull}(기대 0) · subtitle 비NULL ${subtitleNonNull}(보존)`);

  // 이슈3 — growth_status
  const { data: p } = await sb.from("user_profiles").select("status,growth_status").eq("user_id", UUID).maybeSingle();
  console.log(`이슈3 최종상태: status=${(p as any).status} growth_status=${(p as any).growth_status} (기대 active/suspended)`);

  // 이슈2 — 시즌 progressStatus (direct)
  const resume = await getCluster1Resume(LEGACY);
  console.log("이슈2 시즌 이력 (direct):");
  for (const r of (resume as any).seasonRecords ?? []) {
    console.log(`  ${r.seasonName} | ${r.progressStatus} | 인정 ${r.approvedWeeks ?? "?"}/${r.totalWeeks ?? "?"}`);
  }

  // 카드 정상 렌더(깨짐 없음) 확인
  const cards = await getCluster4WeeklyCardsForProfileUser(UUID);
  console.log(`카드 ${(cards as any[]).length}장 정상 빌드 (growth_point NULL 무관)`);
}
main().catch((e) => { console.error(e); process.exit(1); });
