import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { QA_HIDE_REAL_USERS } from "@/lib/qaFixedScope";
async function main() {
  console.log("QA_HIDE_REAL_USERS =", QA_HIDE_REAL_USERS);
  console.log("APP_ENV =", process.env.APP_ENV, "| NEXT_PUBLIC_APP_ENV =", process.env.NEXT_PUBLIC_APP_ENV);
  const w = "39aae7a0-216f-4262-8a67-6beef1bccf22";

  // 정규 체크: scope_mode별 status 분포(이 주차).
  const { data: reg } = await supabaseAdmin.from("process_check_statuses").select("scope_mode,status,organization_slug").eq("week_id", w);
  const rmap = new Map<string, number>();
  for (const r of (reg ?? []) as any[]) rmap.set(`${r.scope_mode ?? "null"}/${r.status}`, (rmap.get(`${r.scope_mode ?? "null"}/${r.status}`) ?? 0)+1);
  console.log("\n정규 체크(process_check_statuses) scope_mode/status:");
  for (const [k,v] of [...rmap.entries()].sort()) console.log(`  ${k}: ${v}`);

  // 변동: scope_mode별 status 분포(이 주차, review_request).
  const { data: irr } = await supabaseAdmin.from("process_irregular_acts").select("scope_mode,status,kind,organization_slug").eq("week_id", w);
  const imap = new Map<string, number>();
  for (const r of (irr ?? []) as any[]) imap.set(`${r.scope_mode ?? "null"}/${r.kind}/${r.status}`, (imap.get(`${r.scope_mode ?? "null"}/${r.kind}/${r.status}`) ?? 0)+1);
  console.log("\n변동(process_irregular_acts) scope_mode/kind/status:");
  for (const [k,v] of [...imap.entries()].sort()) console.log(`  ${k}: ${v}`);

  const effMode = (QA_HIDE_REAL_USERS) ? "test" : "operating";
  console.log(`\n▶ 코호트 선택 기준 effMode(QA_HIDE_REAL_USERS||qa ? test) = "${effMode}"`);
  console.log(`▶ 현재 pending 변동은 scope_mode='operating' → effMode='${effMode}' 와 ${effMode==="operating"?"일치(정상 차단)":"불일치(모드혼입·제외 대상)"}`);
}
main().catch(e=>{console.error(e);process.exit(1);});
