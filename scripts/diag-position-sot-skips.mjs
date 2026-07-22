/**
 * verify-position-resolver-sot 의 SKIP 항목을 **근거와 함께 분류**하기 위한 읽기 전용 진단.
 *   각 화면의 실제 응답에서 (a) 대상 유저 행이 있는지 (b) 어떤 필드를 내려주는지 (c) 모집단/파라미터
 *   조건 때문에 빠지는지를 찍는다. 아무 것도 쓰지 않는다(PATCH/DELETE 없음).
 *
 * Usage: node scripts/diag-position-sot-skips.mjs [userId]
 */
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const adminRoot = resolve(__dirname, "..");
const rq = createRequire(resolve(adminRoot, "package.json"));
const { createClient } = rq("@supabase/supabase-js");
const { createServerClient } = rq("@supabase/ssr");

const env = readFileSync(resolve(adminRoot, ".env.local"), "utf8");
const get = (k) => env.match(new RegExp(`^${k}=(.+)$`, "m"))?.[1]?.trim();
const ADMIN = process.env.ADMIN_BASE ?? "http://localhost:3000";
const URL_ = get("NEXT_PUBLIC_SUPABASE_URL");
const ANON = get("NEXT_PUBLIC_SUPABASE_ANON_KEY");
const sb = createClient(URL_, get("SUPABASE_SERVICE_ROLE_KEY"));
const brow = createClient(URL_, ANON);

const UID = process.argv[2] ?? "e1a17a4a-05b5-443e-a95d-db20ec2ad9af";
const ORG = "encre";
const MODE = "test";

async function cookieHeader() {
  const { data: admins } = await sb
    .from("admin_users").select("email").eq("is_active", true).not("email", "is", null).limit(1);
  const email = admins[0].email;
  const { data: link } = await sb.auth.admin.generateLink({ type: "magiclink", email });
  const { data: v } = await brow.auth.verifyOtp({ email, token: link.properties.email_otp, type: "magiclink" });
  const cap = [];
  const srv = createServerClient(URL_, ANON, { cookies: { getAll: () => [], setAll: (i) => cap.push(...i) } });
  await srv.auth.setSession({ access_token: v.session.access_token, refresh_token: v.session.refresh_token });
  return cap.map((i) => `${i.name}=${i.value}`).join("; ");
}

// 응답 트리에서 userId 를 가진 노드를 찾고, 그 노드의 키 목록을 돌려준다.
function findRow(node, userId, depth = 0) {
  if (!node || depth > 8) return null;
  if (Array.isArray(node)) {
    for (const it of node) { const h = findRow(it, userId, depth + 1); if (h) return h; }
    return null;
  }
  if (typeof node !== "object") return null;
  if (node.userId === userId || node.user_id === userId) return node;
  for (const v of Object.values(node)) { const h = findRow(v, userId, depth + 1); if (h) return h; }
  return null;
}
// 응답 안의 모든 userId 개수(= 이 화면이 사람 행을 내려주기는 하는가).
function countUserRows(node, acc = new Set(), depth = 0) {
  if (!node || depth > 8) return acc;
  if (Array.isArray(node)) { for (const it of node) countUserRows(it, acc, depth + 1); return acc; }
  if (typeof node !== "object") return acc;
  const id = node.userId ?? node.user_id;
  if (typeof id === "string") acc.add(id);
  for (const v of Object.values(node)) countUserRows(v, acc, depth + 1);
  return acc;
}

const main = async () => {
  const cookie = await cookieHeader();
  const call = (path) =>
    fetch(`${ADMIN}${path}`, { headers: { cookie }, signal: AbortSignal.timeout(60000) })
      .then(async (r) => ({ status: r.status, j: await r.json().catch(() => null) }))
      .catch((e) => ({ status: 0, j: null, err: String(e) }));

  const { data: th } = await sb
    .from("cluster4_team_halves")
    .select("id,team_name").eq("organization_slug", ORG).eq("is_active", true).eq("is_qa_test", true)
    .order("display_order").limit(1);
  const team = th[0];
  const ws = await call(
    `/api/admin/team-parts/info/team-detail/week-summary?organization=${ORG}&teamHalfId=${team.id}&mode=${MODE}`,
  );
  const week = ws.j?.data?.week;
  const weekId = week?.id ?? week?.weekId;
  const TEAM_Q = encodeURIComponent(team.team_name);
  const { data: wkRow } = await sb.from("weeks").select("season_key").eq("id", weekId).maybeSingle();
  const SEASON_KEY = wkRow?.season_key ?? "";

  // 대상자의 현재 파트(경험 파트 입력이 part 파라미터를 요구하므로 실제 파트를 넣어야 한다).
  const meRow = findRow(ws.j?.data, UID);
  const myPart = meRow?.rawPart ?? null;
  console.log(`대상 ${UID} team=${team.team_name} week=${week?.label}(${week?.weekStartDate}) part=${myPart}`);
  console.log("");

  const screens = [
    ["라인 개설 대상자(크루)", `/api/admin/cluster4/crews?organization=${ORG}&mode=${MODE}`],
    ["휴식 관리 목록", `/api/admin/rest-management/list?organization=${ORG}&season_key=${SEASON_KEY}`],
    ["프로세스 체크", `/api/admin/processes/check?org=${ORG}&mode=${MODE}&hub=info`],
    ["액트 체크 관리", `/api/admin/team-parts/info/weeks/${weekId}/act-check-management?club=${ORG}&mode=${MODE}`],
    ["경험 파트 입력(part 지정)", `/api/admin/cluster4/experience/part-input?organization=${ORG}&teamName=${TEAM_Q}&part=${encodeURIComponent(myPart ?? "")}&mode=${MODE}`],
    ["경험 라인 관리", `/api/admin/cluster4/experience/line-manage?organization=${ORG}&mode=${MODE}`],
    ["팀 상세 [A]", `/api/admin/team-parts/info/team-detail?organization=${ORG}&teamHalfId=${team.id}&mode=${MODE}`],
    ["팀 내역 요약", `/api/admin/team-parts/info/summary?organization=${ORG}&mode=${MODE}`],
  ];

  for (const [label, path] of screens) {
    const r = await call(path);
    const rows = countUserRows(r.j?.data ?? r.j);
    const hit = findRow(r.j?.data ?? r.j, UID);
    console.log(`■ ${label}`);
    console.log(`   status=${r.status} 사람행=${rows.size} 대상포함=${hit ? "Y" : "N"}`);
    if (hit) console.log(`   대상 행 키: ${Object.keys(hit).join(",")}`);
    else if (rows.size > 0) console.log(`   포함된 userId 예: ${[...rows].slice(0, 3).join(", ")}`);
    else {
      const top = r.j?.data;
      const keys = Array.isArray(top) ? `array(${top.length})` : Object.keys(top ?? {}).join(",");
      console.log(`   data 최상위 키: ${keys}`);
    }
    if (r.err) console.log(`   err=${r.err}`);
    console.log("");
  }
};

main().catch((e) => { console.error(e); process.exit(1); });
