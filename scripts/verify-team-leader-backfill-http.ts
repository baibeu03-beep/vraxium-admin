/**
 * 팀장 백필 검증 — direct == HTTP, 매칭=클래스/품계 표시, 무매칭=이름만, 이름없음="-".
 *
 * 사전조건: leader_name 컬럼 마이그레이션 적용 + 백필 --apply 완료 + admin dev :3000.
 * Usage: npx tsx --env-file=.env.local scripts/verify-team-leader-backfill-http.ts
 * READ-ONLY(쓰기 없음).
 */
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { listHalfTeams } from "@/lib/adminTeamHalvesData";

const adminBase = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
const adminEmail = process.env.SMOKE_ADMIN_EMAIL ?? "vanuatu.golden@gmail.com";

function ensureEnv(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

async function makeAdminCookieHeader(): Promise<string> {
  const supabaseUrl = ensureEnv("NEXT_PUBLIC_SUPABASE_URL");
  const anonKey = ensureEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY");
  const admin = createClient(supabaseUrl, ensureEnv("SUPABASE_SERVICE_ROLE_KEY"));
  const browser = createClient(supabaseUrl, anonKey);
  const { data: linkData, error: linkError } = await admin.auth.admin.generateLink({
    type: "magiclink",
    email: adminEmail,
  });
  if (linkError || !linkData?.properties?.email_otp)
    throw new Error(linkError?.message ?? "generateLink failed");
  const { data: verifyData, error: verifyError } = await browser.auth.verifyOtp({
    email: adminEmail,
    token: linkData.properties.email_otp,
    type: "magiclink",
  });
  if (verifyError || !verifyData.session)
    throw new Error(verifyError?.message ?? "verifyOtp failed");
  const captured: Array<{ name: string; value: string }> = [];
  const server = createServerClient(supabaseUrl, anonKey, {
    cookies: {
      getAll: () => [],
      setAll: (items) =>
        void captured.push(...items.map((i) => ({ name: i.name, value: i.value }))),
    },
  });
  const { error } = await server.auth.setSession({
    access_token: verifyData.session.access_token,
    refresh_token: verifyData.session.refresh_token,
  });
  if (error) throw new Error(error.message);
  return captured.map((c) => `${c.name}=${c.value}`).join("; ");
}

let pass = 0, fail = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  ok ? pass++ : fail++;
}

const LEADER_FIELDS = [
  "leaderName", "leaderBirth6", "leaderGender", "leaderSchool", "leaderMajor",
  "leaderResidence", "leaderClassLabel", "leaderGradeLabel", "leaderUserId", "leaderCrewCode",
] as const;

async function main() {
  const cookie = await makeAdminCookieHeader();
  const httpGet = async (org: string, half: string) => {
    const params = new URLSearchParams({ organization: org, half });
    const r = await fetch(`${adminBase}/api/admin/team-parts/info?${params}`, {
      headers: { cookie },
      cache: "no-store",
    });
    const j = await r.json();
    if (!r.ok || !j.success) throw new Error(`GET ${org}/${half}: ${r.status} ${j?.error}`);
    return j.data as any;
  };

  const orgs = ["encre", "oranke", "phalanx"] as const;
  const half = "2026-H1";

  console.log(`=== direct == HTTP (전 org, ${half}) ===`);
  const directByOrg: Record<string, any[]> = {};
  for (const org of orgs) {
    const direct = await listHalfTeams(org, half);
    const http = await httpGet(org, half);
    directByOrg[org] = direct;
    const httpTeams = http.teams as any[];
    // 팀 순서/이름 동일.
    const sameOrder =
      JSON.stringify(direct.map((t) => t.teamName)) ===
      JSON.stringify(httpTeams.map((t) => t.teamName));
    check(`[${org}] 팀 목록 순서 direct==HTTP`, sameOrder);
    // 팀장 전 필드 동일.
    let allSame = true;
    for (const dt of direct) {
      const ht = httpTeams.find((t) => t.teamName === dt.teamName);
      if (!ht) { allSame = false; break; }
      for (const f of LEADER_FIELDS) {
        if (JSON.stringify((dt as any)[f]) !== JSON.stringify(ht[f])) {
          allSame = false;
          console.log(`     ✗ ${org}/${dt.teamName}.${f}: direct=${JSON.stringify((dt as any)[f])} http=${JSON.stringify(ht[f])}`);
        }
      }
    }
    check(`[${org}] 팀장 전 필드 direct==HTTP`, allSame);
  }

  console.log("\n=== 매칭(자동연결) 팀장: 이름+클래스+품계 표시 ===");
  const find = (org: string, team: string) =>
    (directByOrg[org] ?? []).find((t) => t.teamName === team);

  const linkedCases: Array<[string, string, string]> = [
    ["encre", "A&R", "이유진"],
    ["encre", "프로듀싱", "노서정"],
    ["oranke", "콘텐츠", "전성은"],
    ["phalanx", "IT", "이유나"],
  ];
  for (const [org, team, name] of linkedCases) {
    const t = find(org, team);
    if (!t) { check(`[${org}/${team}] 행 존재`, false); continue; }
    check(
      `[${org}/${team}] 이름=${name} · 클래스/품계 채움`,
      t.leaderName === name && t.leaderUserId != null &&
        t.leaderClassLabel != null,
      `name=${t.leaderName} class=${t.leaderClassLabel} grade=${t.leaderGradeLabel} gender=${t.leaderGender} birth6=${t.leaderBirth6}`,
    );
  }

  console.log('\n=== 무매칭 팀장: 이름만, 나머지(클래스/품계 포함) null → UI "-" ===');
  const nameOnly = find("encre", "갤러리"); // 김지희 — DB 무매칭
  if (nameOnly) {
    check(
      "[encre/갤러리] 이름=김지희 · 부가정보 전부 null",
      nameOnly.leaderName === "김지희" &&
        nameOnly.leaderUserId == null &&
        nameOnly.leaderGender == null &&
        nameOnly.leaderClassLabel == null &&
        nameOnly.leaderGradeLabel == null &&
        nameOnly.leaderBirth6 == null,
      `name=${nameOnly.leaderName} class=${nameOnly.leaderClassLabel} grade=${nameOnly.leaderGradeLabel} gender=${nameOnly.leaderGender}`,
    );
  } else check("[encre/갤러리] 행 존재", false);

  console.log('\n=== 이름 없음(팔랑크스): leaderName=null → UI 전체 "-" ===');
  for (const team of ["브랜딩", "서비스"]) {
    const t = find("phalanx", team);
    if (!t) { check(`[phalanx/${team}] 행 존재`, false); continue; }
    check(
      `[phalanx/${team}] leaderName=null(이름 "-")`,
      t.leaderName == null && t.leaderUserId == null && t.leaderClassLabel == null,
      `name=${JSON.stringify(t.leaderName)}`,
    );
  }

  console.log(`\n결과: ✓ ${pass} / ✗ ${fail}`);
  if (fail > 0) process.exit(1);
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
