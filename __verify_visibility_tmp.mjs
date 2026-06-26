import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const SNAP = "cluster4_weekly_card_snapshots";

// (3) base 240 lines identical to backup?
const base = JSON.parse(readFileSync("./claudedocs/rollback-info-v2-phalanx-PX-base240-backup.json","utf8"));
const baseLineIds = new Set(base.insertedLineIds);
const { data: liveBase } = await sb.from("cluster4_lines").select("id,is_active,line_code,main_title")
  .in("id", [...baseLineIds]);
console.log("(3) base240: backup ids =", baseLineIds.size, "| still present =", liveBase.length,
  "| all active =", liveBase.every(l=>l.is_active), "| none are forum =", liveBase.every(l=>!String(l.line_code||"").startsWith("info-PX-forum-")));

// (4) EC/OK/common excel_import info lines — show counts (sanity; we wrote none of these)
for (const tok of ["EC","OK"]) {
  const { data } = await sb.from("cluster4_lines").select("id",{count:"exact",head:true}).like("line_code",`info-${tok}-%`).eq("source_type","excel_import");
}
const { count: ecCount } = await sb.from("cluster4_lines").select("id",{count:"exact",head:true}).like("line_code","info-EC-%");
const { count: okCount } = await sb.from("cluster4_lines").select("id",{count:"exact",head:true}).like("line_code","info-OK-%");
const { count: commonCount } = await sb.from("cluster4_lines").select("id",{count:"exact",head:true}).eq("part_type","info").is("line_code",null);
console.log("(4) other-org info line counts (unchanged by construction): EC="+ecCount, "OK="+okCount, "common(null)="+commonCount);

// forum lines + their targets
const { data: forumLines } = await sb.from("cluster4_lines").select("id,line_code,week_id,main_title").like("line_code","info-PX-forum-%");
const flById = new Map(forumLines.map(l=>[l.id,l]));
const { data: tgts } = await sb.from("cluster4_line_targets").select("line_id,week_id,target_user_id,target_mode").in("line_id", forumLines.map(l=>l.id));
console.log("forum lines:", forumLines.length, "| targets:", tgts.length, "| all target_mode=user:", tgts.every(t=>t.target_mode==="user"));

// pick a test line (smallest with >=1 target in 2025) + a target user + a NON-target phalanx user (same week)
const sample = forumLines.find(l=>l.line_code==="info-PX-forum-2025w46") || forumLines[0];
const sampleTargets = tgts.filter(t=>t.line_id===sample.id);
const targetUid = sampleTargets[0].target_user_id;
console.log("\nsample line:", sample.line_code, "week:", sample.week_id, "title:", sample.main_title.slice(0,30), "| targets:", sampleTargets.length);

// a non-target phalanx user
const { data: profs } = await sb.from("user_profiles").select("user_id,display_name").eq("organization_slug","phalanx");
const targetSet = new Set(tgts.map(t=>t.target_user_id));
const nonTarget = profs.find(p=>!targetSet.has(p.user_id));
console.log("targetUid:", targetUid, "| nonTargetUid:", nonTarget.user_id);

// (7/8) direct snapshot: does the forum main_title appear in the target's cards but not the non-target's?
async function snapHasTitle(uid, title){
  const { data } = await sb.from(SNAP).select("cards,is_stale,dto_version").eq("user_id", uid).maybeSingle();
  if (!data) return { row:false };
  const txt = JSON.stringify(data.cards);
  return { row:true, is_stale:data.is_stale, dto:data.dto_version, hasTitle: txt.includes(title), hasLineId: txt.includes(sample.id) };
}
const t = await snapHasTitle(targetUid, sample.main_title);
const n = await snapHasTitle(nonTarget.user_id, sample.main_title);
console.log("\n(7) TARGET user snapshot:", JSON.stringify(t));
console.log("(8) NON-TARGET user snapshot:", JSON.stringify(n));
