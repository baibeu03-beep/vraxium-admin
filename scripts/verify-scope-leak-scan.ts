// 누수 전수 검증 — 일반 모드에 marker 유저가 1명이라도, test 모드에 non-marker 유저가
// 1명이라도 응답에 섞이는 population API 를 실HTTP 로 찾는다. 페이지네이션/검색/org 변형 포함.
//   사용: npx tsx --env-file=.env.local scripts/verify-scope-leak-scan.ts
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { supabaseAdmin } from "../lib/supabaseAdmin";

const baseUrl = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

// ── admin 세션 쿠키 발급 (verify-admin-mode-p1 패턴 재사용) ──
async function makeAdminCookies() {
  const { data: admins } = await supabaseAdmin
    .from("admin_users")
    .select("email")
    .eq("is_active", true)
    .not("email", "is", null)
    .limit(1);
  const email = (admins?.[0] as { email: string } | undefined)?.email;
  if (!email) throw new Error("No active admin email");
  const admin = createClient(supabaseUrl, serviceKey);
  const anon = createClient(supabaseUrl, anonKey);
  const { data: link } = await admin.auth.admin.generateLink({ type: "magiclink", email });
  if (!link.properties?.email_otp) throw new Error("generateLink failed");
  const { data: verified } = await anon.auth.verifyOtp({
    email,
    token: link.properties.email_otp,
    type: "magiclink",
  });
  if (!verified.session) throw new Error("verifyOtp failed");
  const captured: Array<{ name: string; value: string }> = [];
  const server = createServerClient(supabaseUrl, anonKey, {
    cookies: { getAll: () => [], setAll: (items) => captured.push(...items.map(({ name, value }) => ({ name, value }))) },
  });
  await server.auth.setSession({
    access_token: verified.session.access_token,
    refresh_token: verified.session.refresh_token,
  });
  return captured.map(({ name, value }) => `${name}=${value}`).join("; ");
}

async function fetchAll<T>(table: string, cols: string): Promise<T[]> {
  const out: T[] = [];
  const page = 1000;
  for (let from = 0; ; from += page) {
    const { data, error } = await supabaseAdmin
      .from(table)
      .select(cols)
      .order("user_id", { ascending: true })
      .range(from, from + page - 1);
    if (error) throw new Error(`${table}: ${error.message}`);
    const rows = (data ?? []) as T[];
    out.push(...rows);
    if (rows.length < page) break;
  }
  return out;
}

// ── 응답에서 모든 UUID 를 끌어모으는 범용 추출기 ──
//   라우트별 jsonPath 를 일일이 코딩하지 않고, 응답 트리 전체를 walk 하며 'userId'/'user_id'/
//   'target_user_id'/'targetUserId' 키의 UUID 값을 모은다(과수집 안전 — 누수 판정은 marker 대조).
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ID_KEYS = new Set([
  "userId", "user_id", "targetUserId", "target_user_id", "profileUserId", "profile_user_id",
  "linkedUserId", "linked_user_id",
]);
function collectUserIds(node: unknown, acc: Set<string>) {
  if (node == null) return;
  if (Array.isArray(node)) {
    for (const v of node) collectUserIds(v, acc);
    return;
  }
  if (typeof node === "object") {
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (ID_KEYS.has(k) && typeof v === "string" && UUID_RE.test(v)) acc.add(v);
      else collectUserIds(v, acc);
    }
  }
}

type Variant = { label: string; qs: string };
type Paginate =
  | { kind: "offset"; size: number } // ?limit=size&offset=N
  | { kind: "page"; size: number } // ?page=N&pageSize=size
  | null;
type Spec = {
  name: string;
  path: string; // without query
  modeAware: boolean; // appends mode=test for the test pass
  variants: Variant[]; // operating-side variants (filters/pages/org). test pass reuses same.
  paginate?: Paginate; // if set, runner walks ALL pages and unions ids
};

let cookie = "";
async function getJson(path: string) {
  const res = await fetch(`${baseUrl}${path}`, {
    headers: { Cookie: cookie },
    cache: "no-store",
  });
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    /* non-json */
  }
  return { status: res.status, body };
}

// 전 페이지 순회하며 모든 UUID 를 union. {status, ids, pages, total} 반환.
//   total 은 roster 처럼 body.data.total/ filteredTotal 가 있으면 노출(coverage 확인용).
async function collectAllPages(
  pathWithBaseQs: string,
  paginate: Paginate,
): Promise<{ status: number; ids: Set<string>; pages: number; total: number | null }> {
  const ids = new Set<string>();
  const join = pathWithBaseQs.includes("?") ? "&" : "?";
  if (!paginate) {
    const { status, body } = await getJson(pathWithBaseQs);
    collectUserIds(body, ids);
    const total = pickTotal(body);
    return { status, ids, pages: 1, total };
  }
  let pages = 0;
  let total: number | null = null;
  let lastStatus = 0;
  const guard = 200; // 최대 200페이지 안전장치
  for (let n = 0; n < guard; n++) {
    const qs =
      paginate.kind === "offset"
        ? `${join}limit=${paginate.size}&offset=${n * paginate.size}`
        : `${join}page=${n + 1}&pageSize=${paginate.size}`;
    const { status, body } = await getJson(`${pathWithBaseQs}${qs}`);
    lastStatus = status;
    if (status !== 200) break;
    const before = ids.size;
    const pageIds = new Set<string>();
    collectUserIds(body, pageIds);
    pageIds.forEach((id) => ids.add(id));
    pages++;
    total = pickTotal(body) ?? total;
    // 이 페이지 행 수가 size 미만이면 마지막 페이지.
    const rowCount = pageRowCount(body);
    if (rowCount == null) {
      // 행 수를 못 읽으면 union 증가 여부로 종료 판단(중복 페이지 방지).
      if (ids.size === before) break;
    } else if (rowCount < paginate.size) {
      break;
    }
  }
  return { status: lastStatus, ids, pages, total };
}

function pickTotal(body: unknown): number | null {
  const d = (body as { data?: unknown })?.data as Record<string, unknown> | undefined;
  if (d && typeof d === "object") {
    for (const k of ["filteredTotal", "total", "count"]) {
      const v = d[k];
      if (typeof v === "number") return v;
    }
  }
  return null;
}
function pageRowCount(body: unknown): number | null {
  const d = (body as { data?: unknown })?.data;
  if (Array.isArray(d)) return d.length;
  if (d && typeof d === "object") {
    for (const k of ["members", "rows", "items", "users", "crews"]) {
      const v = (d as Record<string, unknown>)[k];
      if (Array.isArray(v)) return v.length;
    }
  }
  return null;
}

async function main() {
  cookie = await makeAdminCookies();
  const markers = await fetchAll<{ user_id: string }>("test_user_markers", "user_id");
  const markerSet = new Set(markers.map((m) => m.user_id));
  const profiles = await fetchAll<{ user_id: string; display_name: string | null }>(
    "user_profiles",
    "user_id,display_name",
  );
  const nameById = new Map(profiles.map((p) => [p.user_id, p.display_name]));
  console.log(`markers=${markerSet.size} profiles=${profiles.length} base=${baseUrl}\n`);

  // ── population 엔드포인트 카탈로그 (catalog agent 결과로 보강) ──
  const ORGS = ["", "encre", "oranke", "phalanx"];
  const orgVar = (param: string) => ORGS.filter(Boolean).map((o) => ({ label: `org=${o}`, qs: `${param}=${o}` }));
  const specs: Spec[] = [
    { name: "cluster4/users", path: "/api/admin/cluster4/users", modeAware: true, variants: [{ label: "base", qs: "" }] },
    {
      name: "crews",
      path: "/api/admin/crews",
      modeAware: true,
      variants: [{ label: "base", qs: "" }, ...orgVar("organization")],
    },
    {
      name: "cluster4/crews",
      path: "/api/admin/cluster4/crews",
      modeAware: true,
      variants: [{ label: "base", qs: "" }, { label: "q=T", qs: "q=T" }, ...orgVar("organization")],
    },
    {
      name: "members",
      path: "/api/admin/members",
      modeAware: true,
      paginate: { kind: "offset", size: 100 },
      variants: [{ label: "base", qs: "" }, { label: "q=T", qs: "q=T" }, ...orgVar("organization")],
    },
    {
      name: "members/roster",
      path: "/api/admin/members/roster",
      modeAware: true,
      paginate: { kind: "page", size: 50 },
      variants: [{ label: "base", qs: "" }, { label: "search=T", qs: "search=T" }, ...orgVar("organization")],
    },
    {
      name: "app-users",
      path: "/api/admin/app-users",
      modeAware: true,
      variants: [{ label: "base", qs: "" }, { label: "query=T", qs: "query=T" }],
    },
    {
      name: "user-profiles/search",
      path: "/api/admin/user-profiles/search",
      modeAware: true,
      variants: [{ label: "q=T", qs: "q=T" }, { label: "q=이", qs: "q=%EC%9D%B4" }],
    },
    {
      name: "applicants",
      path: "/api/admin/applicants",
      modeAware: true,
      variants: [{ label: "base", qs: "" }],
    },
    {
      name: "week-recognitions(operating-hardcoded)",
      path: "/api/admin/week-recognitions",
      modeAware: false,
      variants: [{ label: "base", qs: "" }, { label: "search=T", qs: "search=T" }, ...orgVar("organization_slug")],
    },
    // ── 크루 검색/보드 (org+mode 스코프) ──
    {
      name: "competency/applications",
      path: "/api/admin/cluster4/competency/applications",
      modeAware: true,
      variants: [...orgVar("organization"), ...orgVar("org")],
    },
    {
      name: "cafe-line-crew",
      path: "/api/admin/cluster4/cafe-line-crew",
      modeAware: true,
      variants: [{ label: "search=T", qs: "q=T&organization=oranke" }, { label: "search=T-en", qs: "q=T&organization=encre" }],
    },
    {
      name: "info-lines/crew",
      path: "/api/admin/cluster4/info-lines/crew",
      modeAware: true,
      variants: [{ label: "oranke", qs: "organization=oranke" }, { label: "encre", qs: "organization=encre" }],
    },
    {
      name: "experience/team-overall",
      path: "/api/admin/cluster4/experience/team-overall",
      modeAware: true,
      variants: [...orgVar("organization")],
    },
    // ── 2026-06-30 누수 전수조사로 보강된 endpoint (이전엔 unscoped·미카탈로그였음) ──
    {
      name: "season-participations",
      path: "/api/admin/season-participations",
      modeAware: true,
      variants: [{ label: "base", qs: "" }, { label: "search=T", qs: "search=T" }, ...orgVar("organization_slug")],
    },
    {
      name: "edit-windows",
      path: "/api/admin/edit-windows",
      modeAware: true,
      paginate: { kind: "offset", size: 50 },
      variants: [{ label: "base", qs: "" }, { label: "q=T", qs: "q=T" }],
    },
    {
      name: "user-profiles(base)",
      path: "/api/admin/user-profiles",
      modeAware: true,
      variants: [{ label: "query=T", qs: "query=T" }, { label: "query=이", qs: "query=%EC%9D%B4" }],
    },
    // 라인 대상자(개설 대상 크루) 목록 — rows[].targets[].targetUserId. 4허브 라인개설 화면의
    //   "개설 대상 크루"가 실제 부르는 endpoint. (2026-06-30 누수: 백엔드는 scope 하나 프론트 mode 미전파였음.)
    {
      name: "cluster4/lines(targets)",
      path: "/api/admin/cluster4/lines",
      modeAware: true,
      variants: [
        { label: "partType=career org=encre", qs: "partType=career&detailed=1&limit=500&organization=encre" },
        { label: "partType=competency org=encre", qs: "partType=competency&detailed=1&limit=500&organization=encre" },
        { label: "partType=experience org=encre", qs: "partType=experience&detailed=1&limit=500&organization=encre" },
      ],
    },
  ];

  let leakCount = 0;
  for (const spec of specs) {
    // operating pass — marker 누수 검사 (전 페이지 union)
    for (const v of spec.variants) {
      const q = v.qs ? `?${v.qs}` : "";
      const { status, ids, pages, total } = await collectAllPages(`${spec.path}${q}`, spec.paginate ?? null);
      if (status !== 200) {
        console.log(`  -- ${spec.name} [${v.label}] operating status=${status} (skip)`);
        continue;
      }
      const leaked = Array.from(ids).filter((id) => markerSet.has(id));
      const tNames = Array.from(ids).filter((id) => (nameById.get(id) ?? "").toLowerCase().includes("t"));
      const ok = leaked.length === 0;
      if (!ok) leakCount++;
      const cover = total != null ? ` cover=${ids.size}/${total}` : "";
      console.log(
        `${ok ? "OK  " : "LEAK"} ${spec.name} [operating ${v.label}] ids=${ids.size} pages=${pages}${cover} markerLeak=${leaked.length} (Tname=${tNames.length})`,
      );
      if (!ok) leaked.forEach((id) => console.log(`       ↳ ${id} "${nameById.get(id) ?? ""}"`));
    }
    // test pass — non-marker 누수 검사 (전 페이지 union)
    if (spec.modeAware) {
      for (const v of spec.variants) {
        const base = v.qs ? `?${v.qs}&mode=test` : "?mode=test";
        const { status, ids, pages } = await collectAllPages(`${spec.path}${base}`, spec.paginate ?? null);
        if (status !== 200) {
          console.log(`  -- ${spec.name} [${v.label}] test status=${status} (skip)`);
          continue;
        }
        const leaked = Array.from(ids).filter((id) => !markerSet.has(id));
        const ok = leaked.length === 0;
        if (!ok) leakCount++;
        console.log(
          `${ok ? "OK  " : "LEAK"} ${spec.name} [test ${v.label}] ids=${ids.size} pages=${pages} nonMarkerLeak=${leaked.length}`,
        );
        if (!ok) leaked.forEach((id) => console.log(`       ↳ ${id} "${nameById.get(id) ?? ""}"`));
      }
    }
  }

  console.log(`\n==== leak scan complete: ${leakCount} leak(s) ====`);
  if (leakCount > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
