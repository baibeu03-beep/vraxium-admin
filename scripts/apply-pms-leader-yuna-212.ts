/** 팔랑크스 IT 팀장 이유나(올림푸스/PMS UserId=212, 성균관대 컴퓨터교육과) 1명 신원 이관 + 연결 교체.
 *
 *  범위(사용자 승인): 현재 반기(2026-H1) 1명만. 신원 테이블만 이관(활동/포인트 미이관 → 랭킹 무영향).
 *   생성: users(olympus,212) · user_profiles(role=team_leader) · user_memberships · user_educations
 *   교체: cluster4_team_halves phalanx/2026-H1/IT 의 leader_user_id 를 신규 212 로 (동명이인 55 오연결 정정)
 *
 *  멱등: olympus:212 브리지 있으면 insert 생략(연결만 보장). 3중키 충돌 시 abort(중복 생성 방지).
 *  DRY-RUN 기본. 적용 = --apply. 롤백로그: claudedocs/apply-pms-leader-yuna-212.json
 *  재사용: lib/pmsMigration(legacyIdentityFor·resolveAccountStatusFromPmsState·mapUsersinfoTeamPart).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import mysql from "mysql2/promise";
import { createClient } from "@supabase/supabase-js";
import {
  legacyIdentityFor,
  resolveAccountStatusFromPmsState,
  mapUsersinfoTeamPart,
  resolveOrganizationSlug,
} from "@/lib/pmsMigration";

const APPLY = process.argv.includes("--apply");
const SRC = "olympus" as const;
const UID = 212;
const ORG = resolveOrganizationSlug(SRC); // phalanx
const HALF = "2026-H1";
const TEAM = "IT";

const env = readFileSync(".env.local", "utf8");
const G = (k: string) => env.match(new RegExp(`^${k}=(.+)$`, "m"))?.[1]?.trim();
const sb = createClient(G("NEXT_PUBLIC_SUPABASE_URL")!, G("SUPABASE_SERVICE_ROLE_KEY")!);

function birthIsoFrom6(bd: string | null): string | null {
  const s = String(bd ?? "");
  if (s.length !== 6) return null;
  const yy = Number(s.slice(0, 2));
  return `${yy <= 26 ? "20" : "19"}${s.slice(0, 2)}-${s.slice(2, 4)}-${s.slice(4, 6)}`;
}
const digits = (s: any) => String(s ?? "").replace(/\D/g, "");

async function main() {
  // ── PMS 212 로드 ──
  const conn = await mysql.createConnection({
    host: G("MYSQL_HOST"), port: Number(G("MYSQL_PORT") ?? 3306),
    user: G("MYSQL_USER"), password: G("MYSQL_PASSWORD"), dateStrings: true,
    ssl: { rejectUnauthorized: false },
  });
  const q = async (s: string) => (await conn.query(s))[0] as any[];
  const pms = (await q(`SELECT UserId,Name,CAST(BirthDay AS CHAR) BirthDay,Gender,School,Major,Address,Contact,mail FROM ${SRC}.users WHERE UserId=${UID}`))[0];
  const info = (await q(`SELECT UserID,Team,Part,Level,State,UserRole,TeamRole,CAST(StartDate AS CHAR) StartDate,Week FROM ${SRC}.usersinfo WHERE UserID=${UID} ORDER BY Week DESC LIMIT 1`))[0];
  await conn.end();
  if (!pms || !info) throw new Error(`PMS ${SRC}.${UID} 데이터 없음`);

  const ident = legacyIdentityFor(SRC, UID); // {sourceSystem, legacyUserId} + 가드
  const acct = resolveAccountStatusFromPmsState(info.State); // 운영진 → active/active
  const tp = mapUsersinfoTeamPart(info); // Team/Part 패스스루
  const birthIso = birthIsoFrom6(pms.BirthDay);
  const isLeader = info.TeamRole === "팀장";

  console.log("=== 이관 대상 PMS ===");
  console.log(JSON.stringify({ pms, info, ORG, birthIso, acct, isLeader }, null, 2));

  // ── 멱등/안전 가드 ──
  // 1) 이미 브리지(olympus:212)?
  const { data: bridged } = await sb.from("users")
    .select("id").eq("source_system", SRC).eq("legacy_user_id", UID).maybeSingle();
  let userId: string | null = (bridged as any)?.id ?? null;
  const alreadyMigrated = !!userId;

  // 2) 3중키 충돌(같은 org·생년6·연락처4 다른 행) — 있으면 중복생성 위험 → abort.
  if (!alreadyMigrated) {
    const b6 = digits(pms.BirthDay).slice(-6);
    const c4 = digits(pms.Contact).slice(-4);
    const { data: phx } = await sb.from("user_profiles")
      .select("user_id,display_name,birth_date,contact_phone,school_name")
      .eq("organization_slug", ORG).eq("display_name", String(pms.Name).trim());
    const collide = (phx ?? []).find((p: any) =>
      digits(p.birth_date).slice(-6) === b6 && (!c4 || digits(p.contact_phone).slice(-4) === c4));
    if (collide) {
      throw new Error(`3중키 충돌: 이미 동일 인물로 보이는 행 존재 user_id=${(collide as any).user_id} — 수동 확인 필요(중복생성 차단)`);
    }
    console.log("\n3중키 충돌 없음 → 신규 INSERT 예정 (동명이인 55=숙명여대 와 생년/연락처 상이, 별개 인물 확인)");
  } else {
    console.log(`\n이미 이관됨(olympus:212 → ${userId}) — INSERT 생략, 연결만 보장(멱등).`);
  }

  // ── 대상 팀 행(phalanx/2026-H1/IT) ──
  const { data: thRow } = await sb.from("cluster4_team_halves")
    .select("id,leader_user_id,leader_name,team_name")
    .eq("organization_slug", ORG).eq("half_key", HALF).eq("team_name", TEAM).eq("is_active", true).maybeSingle();
  if (!thRow) throw new Error(`팀 행 없음: ${ORG}/${HALF}/${TEAM}`);
  console.log(`\n=== 연결 교체 대상 팀행 ${ (thRow as any).id} (현재 leader_user_id=${(thRow as any).leader_user_id}) → 신규 212 ===`);

  const newUuid = userId ?? randomUUID();
  const plan = {
    users: alreadyMigrated ? "(존재)" : { id: newUuid, legacy_user_id: ident.legacyUserId, source_system: ident.sourceSystem },
    user_profiles: alreadyMigrated ? "(존재 가능)" : {
      user_id: newUuid, display_name: String(pms.Name).trim(), birth_date: birthIso, gender: pms.Gender ?? null,
      contact_phone: pms.Contact ?? null, contact_email: pms.mail ?? null, organization_slug: ORG,
      school_name: pms.School ?? null, current_team_name: tp.teamName, current_part_name: tp.partName,
      // role=null: 팔랑크스 IT team_leader 슬롯은 이미 박지민(olympus 298)이 점유(uniq_team_leader_per_team).
      //   슬롯 재배정은 별도 사용자 결정 → 여기선 신원만 이관(연결·학교/전공 표시 목적). 클래스는 "정규".
      role: null, status: acct.status, growth_status: acct.growthStatus,
      activity_started_at: String(info.StartDate ?? "").slice(0, 10) || null,
    },
    user_memberships: alreadyMigrated ? "(존재 가능)" : {
      user_id: newUuid, team_name: tp.teamName, part_name: tp.partName,
      membership_level: info.Level ?? null, membership_state: "active", is_current: true,
    },
    user_educations: alreadyMigrated ? "(존재 가능)" : {
      user_id: newUuid, school_name: pms.School, major_name_1: pms.Major ?? null,
    },
    relink: { team_half_id: (thRow as any).id, leader_user_id: newUuid, leader_name: "이유나" },
  };
  console.log("\n=== PLAN ===");
  console.log(JSON.stringify(plan, null, 2));

  if (!APPLY) {
    console.log("\n(DRY-RUN) 쓰기 없음. 적용 = --apply");
    return;
  }

  console.log("\n=== APPLY ===");
  const rollback: any = { src: SRC, uid: UID, userId: newUuid, inserted: { users: false, profile: false, membership: false, education: false }, relink: null };

  if (!alreadyMigrated) {
    { const { error } = await sb.from("users").insert({ id: newUuid, legacy_user_id: ident.legacyUserId, source_system: ident.sourceSystem }); if (error) throw new Error(`users: ${error.message}`); rollback.inserted.users = true; }
    { const { error } = await sb.from("user_profiles").insert(plan.user_profiles as any); if (error) throw new Error(`user_profiles: ${error.message}`); rollback.inserted.profile = true; }
    { const mid = randomUUID(); const { error } = await sb.from("user_memberships").insert({ id: mid, ...(plan.user_memberships as any) }); if (error) throw new Error(`user_memberships: ${error.message}`); rollback.inserted.membership = mid; }
    { const eid = randomUUID(); const { error } = await sb.from("user_educations").insert({ id: eid, ...(plan.user_educations as any) }); if (error) throw new Error(`user_educations: ${error.message}`); rollback.inserted.education = eid; }
    console.log(`신원 INSERT 완료: ${newUuid}`);
  }

  // 연결 교체(동명이인 55 → 212).
  const priorLeader = (thRow as any).leader_user_id ?? null;
  { const { error } = await sb.from("cluster4_team_halves")
      .update({ leader_user_id: newUuid, leader_name: "이유나", leader_crew_code: null })
      .eq("id", (thRow as any).id);
    if (error) throw new Error(`relink: ${error.message}`); }
  rollback.relink = { team_half_id: (thRow as any).id, priorLeader };
  console.log(`연결 교체 완료: 팀행 ${(thRow as any).id} leader_user_id ${priorLeader} → ${newUuid}`);

  writeFileSync("claudedocs/apply-pms-leader-yuna-212.json", JSON.stringify(rollback, null, 2));
  console.log("롤백 로그: claudedocs/apply-pms-leader-yuna-212.json");
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
