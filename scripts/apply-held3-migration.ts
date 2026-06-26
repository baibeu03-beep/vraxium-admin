/**
 * apply-held3-migration — 보류 3명 단독 이관 + 강원대 김준우 상태 정정.
 *   npx tsx --env-file=.env.local scripts/apply-held3-migration.ts            # PREVIEW (write 0)
 *   npx tsx --env-file=.env.local scripts/apply-held3-migration.ts --apply
 *   npx tsx --env-file=.env.local scripts/apply-held3-migration.ts --rollback <runlog.json>
 *
 * 확정(2026-06-26):
 *   STATUS_FIX: 강원대 김준우(hrdb/1505 = DB 9d1d0edd) user_season_statuses(2026-summer) rest→active (오매칭 정정).
 *   MIGRATE(전체이력 단독이관, 전현성 패턴 재사용):
 *     - 백석대 김준우 hrdb/852 (시즌전체휴식) → 2026-summer rest
 *     - 이다경    hrdb/1607 (세종대·시즌전체휴식, encre) → 2026-summer rest
 *     - 류건영    oranke/1200 (고려대·졸업·심화) → 2026-summer active  ⚠ PMS=졸업(Excel SoT=활동) — 운영 확정 반영
 *   growth_status='active' 고정(전인 플래그 무수정 정책)·status='active'. 과거 시즌 무소급(2026-summer 행만 추가).
 *   insert-only·3중키 강매칭 fail-closed·(source,legacy) 페어 점유 fail-closed.
 */
import { readFileSync, writeFileSync } from "fs";
import { randomUUID } from "crypto";
import { createClient } from "@supabase/supabase-js";
import mysql from "mysql2/promise";
import { ledgerSourceTable, resolveOrganizationSlug, mapUsersinfoTeamPart, type PmsSourceSystem } from "@/lib/pmsMigration";
import { recalcUserGrowthStats } from "@/lib/userGrowthStatsData";
import { recomputeAndStoreWeeklyCardsSnapshot } from "@/lib/cluster4WeeklyCardsSnapshot";
import { isExcludedPmsSeason, normalizePmsSeasonType } from "@/lib/pmsSeasonAttribution";

const SUMMER_KEY = "2026-summer";
const DEFAULT_THRESHOLD = 30, RATING_FAIL_MAX = 3;
const UNIFIED_MASTER_NAME = "[통합] 주차 활동 내역";
const UNIFIED_LINE_MAIN_TITLE = "한 주 동안 클럽에서 진행한 중앙, 팀 활동 내역을 아우르는 통합 기록입니다. (26년 6월 이전)";
const ADMIN_ID = "c28b2409-4118-49fc-a42e-68e18dbd194c";
const CREATED_BY = "held3-migration";

const STATUS_FIX = { label: "강원대 김준우", src: "hrdb" as PmsSourceSystem, uid: 1505, from: "rest", to: "active" };
const TARGETS: Array<{ src: PmsSourceSystem; uid: number; name: string; seasonStatus: string; note: string }> = [
  { src: "hrdb", uid: 852, name: "김준우", seasonStatus: "rest", note: "백석대 김준우 시즌전체휴식" },
  { src: "hrdb", uid: 1607, name: "이다경", seasonStatus: "rest", note: "세종대 이다경 시즌전체휴식(encre)" },
  { src: "oranke", uid: 1200, name: "류건영", seasonStatus: "active", note: "고려대 류건영 — Excel SoT 활동(PMS 졸업)" },
];

const APPLY = process.argv.includes("--apply");
const rbIdx = process.argv.indexOf("--rollback");
const ROLLBACK_FILE = rbIdx >= 0 ? process.argv[rbIdx + 1] : null;
const MODE = ROLLBACK_FILE ? "rollback" : APPLY ? "apply" : "preview";
const STAMP = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const OUT = `claudedocs/held3-migration-${MODE}-${STAMP}.json`;
const rawEnv = readFileSync(".env.local", "utf8");
const envGet = (k: string) => rawEnv.match(new RegExp(`^${k}=(.+)$`, "m"))?.[1]?.trim();
const sb = createClient(envGet("NEXT_PUBLIC_SUPABASE_URL")!, envGet("SUPABASE_SERVICE_ROLE_KEY")!);
const line = (s = "") => console.log(s);
const normPhone = (s: unknown) => { const d = String(s ?? "").replace(/\D/g, ""); return d.length >= 8 ? d.slice(-8) : ""; };
const normEmail = (s: unknown) => String(s ?? "").trim().toLowerCase();
const addDays = (iso: string, d: number) => { const t = new Date(`${iso}T00:00:00Z`); t.setUTCDate(t.getUTCDate() + d); return t.toISOString().slice(0, 10); };
function parseBirthIso(bd: unknown): string | null { const s = String(bd ?? "").replace(/\D/g, ""); if (s.length === 8) return `${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)}`; if (s.length === 6) { const yy = Number(s.slice(0,2)); return `${yy<=26?"20":"19"}${s.slice(0,2)}-${s.slice(2,4)}-${s.slice(4,6)}`; } return null; }
const weekOpensAtIso = (d: string) => new Date(Date.UTC(+d.slice(0,4),+d.slice(5,7)-1,+d.slice(8,10)) - 9*3_600_000).toISOString();
const weekClosesAtIso = (d: string) => new Date(Date.UTC(+d.slice(0,4),+d.slice(5,7)-1,+d.slice(8,10)) + 7*86_400_000 - 9*3_600_000 - 1000).toISOString();
type LiveWeek = { id: string; season_key: string; week_number: number; start_date: string; end_date: string; iso_year: number|null; iso_week: number|null; check_threshold: number|null };
async function fetchAllSb<T>(t: string, sel: string, ord: string, filt?: (q: any) => any): Promise<T[]> { const out: T[] = []; for (let f=0;;f+=1000){ let q:any=sb.from(t).select(sel).order(ord,{ascending:true}).range(f,f+999); if(filt)q=filt(q); const {data,error}=await q; if(error)throw new Error(`${t}: ${error.message}`); out.push(...((data??[]) as T[])); if((data??[]).length<1000)break;} return out; }

async function rollback(file: string) {
  const log = JSON.parse(readFileSync(file, "utf8"));
  const issues: string[] = [];
  const del = async (table: string, ids: string[]) => { for (let i=0;i<(ids??[]).length;i+=100){ const {error}=await sb.from(table).delete().in("id",ids.slice(i,i+100)); if(error)issues.push(`${table}: ${error.message}`);} };
  for (const u of [...(log.applied ?? [])].reverse()) {
    await del("user_season_statuses", u.inserted?.seasonStatusIds ?? []);
    await del("cluster4_experience_line_evaluations", u.inserted?.evaluationIds ?? []);
    await del("cluster4_line_submissions", u.inserted?.submissionIds ?? []);
    await del("cluster4_line_targets", u.inserted?.targetIds ?? []);
    await del("user_week_statuses", u.inserted?.uwsIds ?? []);
    await del("user_weekly_points", u.inserted?.uwpIds ?? []);
    await del("legacy_point_ledger", u.inserted?.ledgerIds ?? []);
    await del("user_educations", u.inserted?.educationIds ?? []);
    await del("user_memberships", u.inserted?.membershipIds ?? []);
    for (const t of ["cluster4_weekly_card_snapshots","cluster4_roster_card_stats","user_growth_stats"]) { const {error}=await sb.from(t).delete().eq("user_id",u.uuid); if(error)issues.push(`${t}: ${error.message}`); }
    { const {error}=await sb.from("user_profiles").delete().eq("user_id",u.uuid); if(error)issues.push(`user_profiles: ${error.message}`); }
    { const {error}=await sb.from("users").delete().eq("id",u.uuid); if(error)issues.push(`users: ${error.message}`); }
  }
  for (const l of log.insertedLines ?? []) { const {error}=await sb.from("cluster4_lines").delete().eq("id",l.id).eq("source_file_name",CREATED_BY); if(error)issues.push(`line ${l.id}: ${error.message}`); }
  // STATUS_FIX 원복: active→rest
  if (log.statusFix?.userId && log.statusFix?.done) { const {error}=await sb.from("user_season_statuses").update({status:log.statusFix.from}).eq("user_id",log.statusFix.userId).eq("season_key",SUMMER_KEY).eq("status",log.statusFix.to); if(error)issues.push(`statusFix revert: ${error.message}`); }
  writeFileSync(OUT, JSON.stringify({ mode:"rollback", source:file, issues }, null, 1));
  line(issues.length ? issues.join("\n") : "rollback 완료 (이슈 0)");
  process.exit(issues.length ? 1 : 0);
}

async function main() {
  if (ROLLBACK_FILE) return rollback(ROLLBACK_FILE);
  const conn = await mysql.createConnection({ host: envGet("MYSQL_HOST"), port: Number(envGet("MYSQL_PORT")??3306), user: envGet("MYSQL_USER"), password: envGet("MYSQL_PASSWORD"), dateStrings: true, ssl: { rejectUnauthorized: false } });

  const weeks = await fetchAllSb<LiveWeek>("weeks","id,season_key,week_number,start_date,end_date,iso_year,iso_week,check_threshold","start_date");
  const weekByRange = (d: string) => weeks.find((w) => d >= w.start_date && d <= w.end_date) ?? null;
  if (!weeks.some((w) => w.season_key === SUMMER_KEY)) throw new Error(`weeks 에 ${SUMMER_KEY} 부재`);
  const { data: master } = await sb.from("cluster4_experience_line_masters").select("id,line_code").eq("line_name",UNIFIED_MASTER_NAME).maybeSingle();
  if (!master) throw new Error("[통합] 마스터 부재");
  const { data: unifiedReg } = await sb.from("line_registrations").select("line_code").eq("bridged_master_id",(master as any).id).maybeSingle();
  const UNIFIED_CODE: string | null = (unifiedReg as any)?.line_code ?? (master as any).line_code ?? null;
  if (!UNIFIED_CODE) throw new Error("[통합] 코드 부재");
  const unifiedLines = await fetchAllSb<{id:string;week_id:string|null}>("cluster4_lines","id,week_id","id",(q)=>q.eq("experience_line_master_id",(master as any).id).eq("is_active",true));
  const lineByWeekId = new Map<string,string>(); for(const l of unifiedLines) if(l.week_id) lineByWeekId.set(l.week_id,l.id);
  const orgThr = new Map<string, Map<string,number>>();
  for (const org of ["oranke","encre","phalanx"]) { const m=new Map<string,number>(); for(const r of await fetchAllSb<{week_id:string;check_threshold:number}>("org_week_thresholds","week_id,check_threshold","week_id",(q)=>q.eq("organization_slug",org))) m.set(r.week_id,r.check_threshold); orgThr.set(org,m); }

  async function computePlan(t: typeof TARGETS[number]) {
    const org = resolveOrganizationSlug(t.src);
    const thrOf = (w: LiveWeek) => orgThr.get(org)!.get(w.id) ?? (w.check_threshold!=null && w.check_threshold>=0 ? w.check_threshold : DEFAULT_THRESHOLD);
    const [[pms]] = (await conn.query(`SELECT UserId,Name,CAST(BirthDay AS CHAR) AS BirthDay,Gender,School,Major,Address,Contact,mail FROM ${t.src}.users WHERE UserId=?`,[t.uid])) as any;
    if (!pms) throw new Error(`${t.src}/${t.uid} PMS users 부재`);
    if (String(pms.Name) !== t.name) throw new Error(`이름 가드: PMS='${pms.Name}' 기대='${t.name}'`);
    const [[info]] = (await conn.query(`SELECT Team,Part,Week,Level,State,CAST(StartDate AS CHAR) AS StartDate FROM ${t.src}.usersinfo WHERE UserID=?`,[t.uid])) as any;
    const [[bal]] = (await conn.query(`SELECT Star,Shield FROM ${t.src}.userspoint WHERE UserID=?`,[t.uid])) as any;
    const birthIso = parseBirthIso(pms.BirthDay);
    const { data: nm } = await sb.from("user_profiles").select("user_id,birth_date,contact_phone,contact_email").eq("display_name",String(pms.Name));
    const pPhone=normPhone(pms.Contact), pMail=normEmail(pms.mail);
    const strong=(nm??[]).filter((c:any)=>(birthIso!=null&&c.birth_date===birthIso)||(pPhone!==""&&normPhone(c.contact_phone)===pPhone)||(pMail!==""&&normEmail(c.contact_email)===pMail));
    if (strong.length>=1) throw new Error(`${t.name} 강매칭 ${strong.length}건(${strong.map((s:any)=>s.user_id).join(",")}) — fail-closed`);
    const { data: pair } = await sb.from("users").select("id").eq("source_system",t.src).eq("legacy_user_id",t.uid);
    if ((pair??[]).length>0) throw new Error(`${t.name} (source,legacy) 페어 점유 — 차단`);
    const uuid = randomUUID();
    const CORR=`CASE WHEN YEAR(ActivityTime) BETWEEN 20 AND 99 THEN DATE(ActivityTime + INTERVAL 2000 YEAR) WHEN YEAR(ActivityTime)=1 THEN DATE(createtime) ELSE DATE(ActivityTime) END`;
    const [plogs] = (await conn.query(`SELECT LogNum,code,log,Info,Star,Shield,IsDeleted,CAST(ActivityTime AS CHAR) AS ActivityTime,CAST(createtime AS CHAR) AS createtime,CAST(${CORR} AS CHAR) AS corrected FROM ${t.src}.pointlogs WHERE UserID=? ORDER BY LogNum`,[t.uid])) as any;
    const startIso=String(info?.StartDate??"").slice(0,10);
    const protectUntil = startIso>="2020-01-01" ? addDays(startIso,14) : "0000-00-00";
    type Agg={points:number;adv:number;pen:number}; const agg=new Map<string,Agg>(); let unattributed=0;
    for (const r of plogs){ const w=weekByRange(String(r.corrected)); if(!w){ if((r.Star??0)!==0||(r.Shield??0)!==0)unattributed++; continue;} let a=agg.get(w.id); if(!a){a={points:0,adv:0,pen:0};agg.set(w.id,a);} let star=Number(r.Star??0); if(star<0&&String(r.corrected)<protectUntil)star=0; a.points+=star; const sh=Number(r.Shield??0); if(r.IsDeleted===0){if(sh>0)a.adv+=sh; else if(sh<0)a.pen+=-sh;} }
    type WP={week:LiveWeek;recognized:boolean;rating:number|null;subtitle:string|null}; const wp=new Map<string,WP>();
    for (const tbl of ["useractivities","manageractivities"]){ const [rows]=(await conn.query(`SELECT ActivityId,Season,SeasonWeek,Star,IsActive,Activity,CAST(StartDate AS CHAR) AS StartDate,CAST(EndDate AS CHAR) AS EndDate FROM ${t.src}.${tbl} WHERE UserId=?`,[t.uid])) as any; for(const r of rows){ if(isExcludedPmsSeason(r.Season))continue; const type=normalizePmsSeasonType(r.Season); const cands=type?weeks.filter((w)=>w.season_key.endsWith(`-${type}`)&&w.week_number===r.SeasonWeek):[]; const dates=[r.StartDate,r.EndDate].filter(Boolean).map((d:string)=>String(d).slice(0,10)); let w:LiveWeek|null=null; for(const c of cands){const lo=addDays(c.start_date,-60),hi=addDays(c.end_date,180); if(dates.some((d:string)=>d>=lo&&d<=hi)){w=c;break;}} if(!w&&dates.length)w=weekByRange(dates[0])??(dates[1]?weekByRange(dates[1]):null); if(!w)continue; let v=wp.get(w.id); if(!v){v={week:w,recognized:false,rating:null,subtitle:null};wp.set(w.id,v);} if(r.IsActive===1)v.recognized=true; if(r.Star!=null){const cl=Math.max(0,Math.min(10,Number(r.Star))); if(v.rating==null||cl>v.rating)v.rating=cl;} const tx=String(r.Activity??"").trim(); if(tx&&(!v.subtitle||tx.length>v.subtitle.length))v.subtitle=tx; } }
    let flips=0; const uwsPlans:Array<{week:LiveWeek;status:string}>=[]; const expPlans:Array<{week:LiveWeek;subtitle:string|null;rating:number|null}>=[]; const flipW=new Set<string>(); const ensureWeeks:LiveWeek[]=[]; let summerConflict=0;
    for (const [,v] of wp){ const a=agg.get(v.week.id)??{points:0,adv:0,pen:0}; const status=v.recognized?"success":"fail"; if(v.recognized){const ok=v.rating==null||v.rating>RATING_FAIL_MAX; if(!(ok&&a.points>=thrOf(v.week))){flips++;flipW.add(v.week.id);}} if(v.week.season_key===SUMMER_KEY)summerConflict++; uwsPlans.push({week:v.week,status}); expPlans.push({week:v.week,subtitle:v.subtitle,rating:v.rating}); if(!lineByWeekId.has(v.week.id))ensureWeeks.push(v.week); }
    const uwpPlans:Array<{week:LiveWeek;agg:Agg;cm:boolean}>=[]; for(const [wid,a] of agg){const w=weeks.find((x)=>x.id===wid)!; uwpPlans.push({week:w,agg:a,cm:!flipW.has(wid)});}
    const sumP=[...agg.values()].reduce((s,a)=>s+a.points,0), sumA=[...agg.values()].reduce((s,a)=>s+a.adv,0), sumPen=[...agg.values()].reduce((s,a)=>s+a.pen,0);
    const sentinel={points:Number(bal?.Star??0)-sumP, advantages:Math.max(Number(bal?.Shield??0)-(sumA-sumPen),0), penalty:Math.max(-(Number(bal?.Shield??0)-(sumA-sumPen)),0)};
    const tp=mapUsersinfoTeamPart(info??{Team:null,Part:null});
    const sb_:Record<string,number>={}; for(const p of uwsPlans)sb_[p.week.season_key]=(sb_[p.week.season_key]??0)+1;
    return { t, pms, info, bal, org, uuid, birthIso, startIso, tp, plogs, agg, uwpPlans, uwsPlans, expPlans, flips, unattributed, ensureWeeks, summerConflict, sentinel, seasonBreakdown: sb_ };
  }

  // STATUS_FIX 대상 user_id
  const { data: fixUser } = await sb.from("users").select("id").eq("source_system",STATUS_FIX.src).eq("legacy_user_id",STATUS_FIX.uid).maybeSingle();
  const fixUserId = (fixUser as any)?.id ?? null;
  let fixCurrent: string | null = null;
  if (fixUserId) { const { data } = await sb.from("user_season_statuses").select("status").eq("user_id",fixUserId).eq("season_key",SUMMER_KEY).maybeSingle(); fixCurrent=(data as any)?.status ?? null; }

  const plans: any[] = []; const failed: any[] = [];
  for (const t of TARGETS) { try { plans.push(await computePlan(t)); } catch(e){ failed.push({ name:t.name, error: e instanceof Error?e.message:String(e) }); line(`⚠ plan 실패 ${t.name}: ${e instanceof Error?e.message:e}`);} }
  await conn.end();

  // 예상 최종 카운트
  const cur = { active:0, rest:0, stopped:0 };
  for (let f=0;;f+=1000){ const {data}=await sb.from("user_season_statuses").select("status").eq("season_key",SUMMER_KEY).order("user_id").range(f,f+999); for(const r of (data??[]) as any[]) (cur as any)[r.status]=((cur as any)[r.status]??0)+1; if((data??[]).length<1000)break; }
  const after = { ...cur };
  if (fixUserId && fixCurrent===STATUS_FIX.from) { (after as any)[STATUS_FIX.from]--; (after as any)[STATUS_FIX.to]++; }
  for (const p of plans) (after as any)[p.t.seasonStatus] = ((after as any)[p.t.seasonStatus]??0)+1;

  line("═".repeat(72));
  line(`MODE=${MODE}`);
  line(`STATUS_FIX: ${STATUS_FIX.label} user=${fixUserId?.slice(0,8)} 현재=${fixCurrent} → ${STATUS_FIX.to} ${fixUserId&&fixCurrent===STATUS_FIX.from?"(적용예정)":"(조건불일치·skip)"}`);
  line(`MIGRATE plan: ${plans.length}/${TARGETS.length} (실패 ${failed.length})`);
  for (const p of plans) line(`  ✔ ${p.t.src}/${p.t.uid} ${p.pms.Name} 학교=${p.pms.School} → season=${p.t.seasonStatus} | uws ${p.uwsPlans.length}·uwp ${p.uwpPlans.length+1}·ledger ${p.plogs.length+1}·exp ${p.expPlans.length}·flips ${p.flips}·잔액 ${p.bal?.Star}/${p.bal?.Shield}·시즌 ${JSON.stringify(p.seasonBreakdown)}${p.summerConflict?` ⚠summerConflict ${p.summerConflict}`:""}`);
  for (const f of failed) line(`  ✖ ${f.name}: ${f.error}`);
  line(`예상 최종: 현재 ${JSON.stringify(cur)}(total ${cur.active+cur.rest+cur.stopped}) → ${JSON.stringify(after)}(total ${after.active+after.rest+after.stopped})`);

  const report: any = { mode:MODE, statusFix:{...STATUS_FIX,userId:fixUserId,current:fixCurrent}, plans: plans.map((p)=>({src:p.t.src,uid:p.t.uid,name:p.pms.Name,school:p.pms.School,uuid:p.uuid,seasonStatus:p.t.seasonStatus,counts:{uws:p.uwsPlans.length,uwp:p.uwpPlans.length+1,ledger:p.plogs.length+1,exp:p.expPlans.length,flips:p.flips},seasonBreakdown:p.seasonBreakdown,summerConflict:p.summerConflict,bal:p.bal})), failed, expectAfter: after };
  if (!APPLY) { writeFileSync(OUT, JSON.stringify(report,null,1)); line(`\n→ ${OUT}\nPREVIEW — write 0.`); return; }
  if (failed.length) { line("⛔ plan 실패 존재 — 중단"); process.exit(1); }

  // ════ APPLY ════
  const insertedLines:any[]=[]; const appliedLog:any[]=[];
  report.statusFix.done=false;
  const flushLog=()=>writeFileSync(OUT,JSON.stringify({...report,insertedLines,applied:appliedLog},null,1));
  // STATUS_FIX
  if (fixUserId && fixCurrent===STATUS_FIX.from) {
    const { data, error } = await sb.from("user_season_statuses").update({status:STATUS_FIX.to}).eq("user_id",fixUserId).eq("season_key",SUMMER_KEY).eq("status",STATUS_FIX.from).select("id");
    if (error || (data??[]).length!==1) { line(`✖ STATUS_FIX 실패: ${error?.message ?? `갱신 ${data?.length}행`}`); flushLog(); process.exit(1); }
    report.statusFix.done=true; line(`✔ STATUS_FIX: ${STATUS_FIX.label} rest→active`);
  }
  flushLog();

  for (const p of plans) {
    const u:any={ uuid:p.uuid, inserted:{ profileIds:[],membershipIds:[],educationIds:[],ledgerIds:[],uwpIds:[],uwsIds:[],targetIds:[],submissionIds:[],evaluationIds:[],seasonStatusIds:[] } };
    // [통합] 라인 ensure
    for (const w of [...new Map(p.ensureWeeks.map((w:LiveWeek)=>[w.id,w])).values()].sort((a:any,b:any)=>a.start_date.localeCompare(b.start_date)) as LiveWeek[]) {
      if (lineByWeekId.has(w.id)) continue;
      const { data, error } = await sb.from("cluster4_lines").insert({ part_type:"experience", main_title:UNIFIED_LINE_MAIN_TITLE, experience_line_master_id:(master as any).id, line_code:UNIFIED_CODE, week_id:w.id, submission_opens_at:weekOpensAtIso(w.start_date), submission_closes_at:weekClosesAtIso(w.start_date), is_active:true, source_file_name:CREATED_BY, created_by:ADMIN_ID, updated_by:ADMIN_ID }).select("id").single();
      if (error||!data){ line(`라인 ensure 실패: ${error?.message}`); flushLog(); process.exit(1); }
      lineByWeekId.set(w.id,(data as any).id); insertedLines.push({id:(data as any).id,week_id:w.id}); flushLog();
    }
    try {
      const now=new Date().toISOString();
      { const {error}=await sb.from("users").insert({id:p.uuid,legacy_user_id:p.t.uid,source_system:p.t.src}); if(error)throw new Error(`users: ${error.message}`); }
      { const {error:pe}=await sb.from("user_profiles").insert({user_id:p.uuid,display_name:p.pms.Name,birth_date:p.birthIso,gender:p.pms.Gender??null,contact_phone:p.pms.Contact??null,contact_email:p.pms.mail??null,organization_slug:p.org,school_name:p.pms.School??null,current_team_name:p.tp.teamName,current_part_name:p.tp.partName,status:"active",growth_status:"active",activity_started_at:p.startIso||null}); if(pe)throw new Error(`profile: ${pe.message}`); u.inserted.profileIds.push(p.uuid);
        const mid=randomUUID(); const {error:me}=await sb.from("user_memberships").insert({id:mid,user_id:p.uuid,team_name:p.tp.teamName,part_name:p.tp.partName,membership_level:p.info?.Level??null,membership_state:"active",is_current:true}); if(me)throw new Error(`membership: ${me.message}`); u.inserted.membershipIds.push(mid);
        if(p.pms.School){const eid=randomUUID(); const {error:ee}=await sb.from("user_educations").insert({id:eid,user_id:p.uuid,school_name:p.pms.School,major_name_1:p.pms.Major??null}); if(ee)throw new Error(`edu: ${ee.message}`); u.inserted.educationIds.push(eid);} }
      const ledgerRows=p.plogs.map((r:any)=>({id:randomUUID(),source_table:ledgerSourceTable(p.t.src,"pointlogs"),source_pk:r.LogNum,user_id:p.uuid,legacy_user_id:p.t.uid,week_id:weekByRange(String(r.corrected))?.id??null,occurred_at:`${String(r.corrected)}T00:00:00Z`,code:String(r.code??""),reason:String(r.log??""),star:Number(r.Star??0),shield:Number(r.Shield??0),entry_type:r.IsDeleted===1?"POINTLOG_VOIDED":"POINTLOG",snapshot:r,payload:{Info:r.Info??null,IsDeleted:r.IsDeleted},migrated_at:now,created_by:CREATED_BY}));
      ledgerRows.push({id:randomUUID(),source_table:ledgerSourceTable(p.t.src,"pointlogs"),source_pk:-p.t.uid,user_id:p.uuid,legacy_user_id:p.t.uid,week_id:null,occurred_at:now,code:"ADJ",reason:"MIGRATION_ADJUSTMENT",star:p.sentinel.points,shield:p.sentinel.advantages-p.sentinel.penalty,entry_type:"MIGRATION_ADJUSTMENT",snapshot:p.bal,payload:{sums:true},migrated_at:now,created_by:CREATED_BY} as any);
      for(let i=0;i<ledgerRows.length;i+=200){const {data,error}=await sb.from("legacy_point_ledger").upsert(ledgerRows.slice(i,i+200),{onConflict:"source_table,source_pk",ignoreDuplicates:true}).select("id"); if(error)throw new Error(`ledger: ${error.message}`); u.inserted.ledgerIds.push(...((data??[]) as any[]).map((r)=>r.id));}
      for(const r of p.uwpPlans){const id=randomUUID(); const {error}=await sb.from("user_weekly_points").insert({id,user_id:p.uuid,year:r.week.iso_year??Number(r.week.start_date.slice(0,4)),week_number:r.week.iso_week??r.week.week_number,week_start_date:r.week.start_date,points:r.agg.points,advantages:r.agg.adv,penalty:r.agg.pen,checks_migrated:r.cm}); if(error)throw new Error(`uwp: ${error.message}`); u.inserted.uwpIds.push(id);}
      { const id=randomUUID(); const {error}=await sb.from("user_weekly_points").insert({id,user_id:p.uuid,year:1900,week_number:1,week_start_date:"1900-01-01",points:p.sentinel.points,advantages:p.sentinel.advantages,penalty:p.sentinel.penalty,checks_migrated:false}); if(error)throw new Error(`sentinel: ${error.message}`); u.inserted.uwpIds.push(id); }
      for(const r of p.uwsPlans){const id=randomUUID(); const {error}=await sb.from("user_week_statuses").insert({id,user_id:p.uuid,year:r.week.iso_year??Number(r.week.start_date.slice(0,4)),week_number:r.week.iso_week??r.week.week_number,week_start_date:r.week.start_date,status:r.status,season_key:r.week.season_key}); if(error)throw new Error(`uws: ${error.message}`); u.inserted.uwsIds.push(id);}
      for(const r of p.expPlans){const lineId=lineByWeekId.get(r.week.id); if(!lineId)throw new Error(`[통합] 라인부재 ${r.week.start_date}`); const tid=randomUUID(); const {error:te}=await sb.from("cluster4_line_targets").insert({id:tid,line_id:lineId,week_id:r.week.id,target_mode:"user",target_user_id:p.uuid,target_rule:{}}); if(te)throw new Error(`target: ${te.message}`); u.inserted.targetIds.push(tid); const sid=randomUUID(); const {error:se}=await sb.from("cluster4_line_submissions").insert({id:sid,line_target_id:tid,user_id:p.uuid,subtitle:r.subtitle??"주차 활동 내역(PMS 이관)",submitted_at:`${r.week.end_date}T22:59:59Z`,output_links:[],output_images:[],growth_point:null}); if(se)throw new Error(`submission: ${se.message}`); u.inserted.submissionIds.push(sid); if(r.rating!=null){const eid=randomUUID(); const {error:ee}=await sb.from("cluster4_experience_line_evaluations").insert({id:eid,line_target_id:tid,user_id:p.uuid,rating:r.rating,evaluated_at:`${r.week.end_date}T23:00:00Z`}); if(ee)throw new Error(`eval: ${ee.message}`); u.inserted.evaluationIds.push(eid);}}
      { const id=randomUUID(); const {error}=await sb.from("user_season_statuses").insert({id,user_id:p.uuid,season_key:SUMMER_KEY,status:p.t.seasonStatus,note:`2026 여름 ${p.t.seasonStatus} — 단독이관 ${p.t.note}`}); if(error)throw new Error(`season_status: ${error.message}`); u.inserted.seasonStatusIds.push(id); }
      await recalcUserGrowthStats(p.uuid); await recomputeAndStoreWeeklyCardsSnapshot(p.uuid);
      u.ok=true; appliedLog.push(u); flushLog(); line(`✔ ${p.t.src}/${p.t.uid} ${p.pms.Name} 이관완료 (season=${p.t.seasonStatus}) uuid=${p.uuid.slice(0,8)}`);
    } catch(e){ u.ok=false; u.error=e instanceof Error?e.message:String(e); appliedLog.push(u); flushLog(); line(`✖ ${p.pms.Name} 실패: ${u.error} — rollback: --rollback ${OUT}`); process.exit(1); }
  }
  flushLog(); line(`\napply 완료 — STATUS_FIX ${report.statusFix.done?1:0} + 이관 ${appliedLog.filter((x)=>x.ok).length}. rollback: --rollback ${OUT}`);
}
main().catch((e)=>{console.error(e);process.exit(1);});
