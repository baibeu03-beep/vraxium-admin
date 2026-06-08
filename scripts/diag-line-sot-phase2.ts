/**
 * Phase 2A — 통합 라인 SoT 전환 설계용 read-only 조사.
 *   npx tsx --env-file=.env.local scripts/diag-line-sot-phase2.ts
 * 수행 (전부 read-only — DB 쓰기 0건):
 *   1) 허브별 SoT 테이블 데이터 건수
 *   2) line_code / line_name 중복 분석 (테이블 내 + 테이블 간 + line_registrations 교차)
 *   3) direct 함수 결과 vs HTTP API 응답 비교 (registrations · lines/history)
 *   4) snapshot fingerprint 전/후 (read-only 증명 + 재계산 필요 여부)
 * 결과: claudedocs/line-sot-phase2-survey-20260607.json
 */
import { writeFileSync } from "fs";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { listLineRegistrations } from "@/lib/adminLineRegistrationsData";
import { listCluster4OpenedLines } from "@/lib/adminCluster4LinesData";

const baseUrl = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
const adminEmail = process.env.SMOKE_ADMIN_EMAIL ?? "vanuatu.golden@gmail.com";

function ensureEnv(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

const supabaseUrl = ensureEnv("NEXT_PUBLIC_SUPABASE_URL");
const serviceKey = ensureEnv("SUPABASE_SERVICE_ROLE_KEY");
const anonKey = ensureEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY");
const sb = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

const out: Record<string, unknown> = { generatedAt: new Date().toISOString() };

async function count(table: string, filter?: (q: any) => any): Promise<number> {
  let q = sb.from(table).select("*", { count: "exact", head: true });
  if (filter) q = filter(q);
  const { count: c, error } = await q;
  if (error) throw new Error(`${table}: ${error.message}`);
  return c ?? 0;
}

// PostgREST 1000행 cap 대응 — order+range 페이지네이션 전수 수집.
async function fetchAll<T>(table: string, select: string): Promise<T[]> {
  const rows: T[] = [];
  const page = 1000;
  for (let offset = 0; ; offset += page) {
    const { data, error } = await sb
      .from(table)
      .select(select)
      .order("id", { ascending: true })
      .range(offset, offset + page - 1);
    if (error) throw new Error(`${table}: ${error.message}`);
    rows.push(...((data ?? []) as T[]));
    if (!data || data.length < page) break;
  }
  return rows;
}

function dupCounts(values: (string | null)[]): Record<string, number> {
  const m = new Map<string, number>();
  for (const v of values) {
    if (!v) continue;
    m.set(v, (m.get(v) ?? 0) + 1);
  }
  return Object.fromEntries([...m.entries()].filter(([, n]) => n > 1).sort((a, b) => b[1] - a[1]));
}

async function makeAdminCookieHeader() {
  const admin = createClient(supabaseUrl, serviceKey);
  const browser = createClient(supabaseUrl, anonKey);
  const { data: l, error: le } = await admin.auth.admin.generateLink({
    type: "magiclink",
    email: adminEmail,
  });
  if (le || !l?.properties?.email_otp) throw new Error(le?.message ?? "generateLink failed");
  const { data: v, error: ve } = await browser.auth.verifyOtp({
    email: adminEmail,
    token: l.properties.email_otp,
    type: "magiclink",
  });
  if (ve || !v.session) throw new Error(ve?.message ?? "verifyOtp failed");
  const captured: Array<{ name: string; value: string }> = [];
  const server = createServerClient(supabaseUrl, anonKey, {
    cookies: {
      getAll: () => [],
      setAll: (items) => captured.push(...items.map((i) => ({ name: i.name, value: i.value }))),
    },
  });
  await server.auth.setSession({
    access_token: v.session.access_token,
    refresh_token: v.session.refresh_token,
  });
  return captured.map((i) => `${i.name}=${i.value}`).join("; ");
}

async function fingerprint() {
  return {
    snapTotal: await count("cluster4_weekly_card_snapshots"),
    snapStale: await count("cluster4_weekly_card_snapshots", (q) => q.eq("is_stale", true)),
    lines: await count("cluster4_lines"),
    targets: await count("cluster4_line_targets"),
    registrations: await count("line_registrations"),
  };
}

async function main() {
  // ── 1) 데이터 건수 ──
  console.log("=== 1) 데이터 건수 ===");
  const counts = {
    cluster4_experience_line_masters: await count("cluster4_experience_line_masters"),
    cluster4_experience_line_masters_active: await count(
      "cluster4_experience_line_masters",
      (q) => q.eq("is_active", true),
    ),
    cluster4_experience_line_drafts: await count("cluster4_experience_line_drafts"),
    cluster4_competency_line_masters: await count("cluster4_competency_line_masters"),
    cluster4_competency_line_masters_active: await count(
      "cluster4_competency_line_masters",
      (q) => q.eq("is_active", true),
    ),
    career_projects: await count("career_projects"),
    activity_types: await count("activity_types"),
    cluster4_lines_total: await count("cluster4_lines"),
    cluster4_lines_info: await count("cluster4_lines", (q) => q.eq("part_type", "info")),
    cluster4_lines_experience: await count("cluster4_lines", (q) => q.eq("part_type", "experience")),
    cluster4_lines_competency: await count("cluster4_lines", (q) => q.eq("part_type", "competency")),
    cluster4_lines_career: await count("cluster4_lines", (q) => q.eq("part_type", "career")),
    cluster4_line_targets: await count("cluster4_line_targets"),
    cluster4_line_submissions: await count("cluster4_line_submissions"),
    line_registrations: await count("line_registrations"),
    cluster4_weekly_card_snapshots: await count("cluster4_weekly_card_snapshots"),
  };
  console.log(JSON.stringify(counts, null, 1));
  out.counts = counts;

  // ── 2) 중복 분석 ──
  console.log("\n=== 2) line_code / line_name 중복 분석 ===");
  type CodeName = { id: string; line_code: string | null; line_name?: string | null };
  const expMasters = await fetchAll<CodeName & { organization_slug: string }>(
    "cluster4_experience_line_masters",
    "id,line_code,line_name,organization_slug",
  );
  const compMasters = await fetchAll<CodeName & { organization_slug: string }>(
    "cluster4_competency_line_masters",
    "id,line_code,line_name,organization_slug",
  );
  const careers = await fetchAll<CodeName>("career_projects", "id,line_code,line_name");
  const lines = await fetchAll<{ id: string; line_code: string | null; part_type: string }>(
    "cluster4_lines",
    "id,line_code,part_type",
  );
  const regs = await fetchAll<{ id: string; line_code: string; line_name: string; hub: string }>(
    "line_registrations",
    "id,line_code,line_name,hub",
  );

  const dup = {
    // 마스터 내 line_code 중복 (조직 차원 포함/제외)
    expMaster_code_dup: dupCounts(expMasters.map((r) => r.line_code)),
    expMaster_codeOrg_dup: dupCounts(expMasters.map((r) => `${r.line_code}|${r.organization_slug}`)),
    compMaster_code_dup: dupCounts(compMasters.map((r) => r.line_code)),
    compMaster_codeOrg_dup: dupCounts(
      compMasters.map((r) => `${r.line_code}|${r.organization_slug}`),
    ),
    career_code_dup: dupCounts(careers.map((r) => r.line_code)),
    lines_code_dup_top10: Object.fromEntries(
      Object.entries(dupCounts(lines.map((r) => r.line_code))).slice(0, 10),
    ),
    registrations_code_dup: dupCounts(regs.map((r) => r.line_code)),
    // 교차: line_registrations.line_code 가 기존 SoT 와 겹치는지
    reg_codes_in_expMasters: regs.filter((r) => expMasters.some((m) => m.line_code === r.line_code)).map((r) => r.line_code),
    reg_codes_in_compMasters: regs.filter((r) => compMasters.some((m) => m.line_code === r.line_code)).map((r) => r.line_code),
    reg_codes_in_careers: regs.filter((r) => careers.some((m) => m.line_code === r.line_code)).map((r) => r.line_code),
    reg_codes_in_lines: regs.filter((r) => lines.some((m) => m.line_code === r.line_code)).map((r) => r.line_code),
    // line_name 중복
    expMaster_name_dup: dupCounts(expMasters.map((r) => r.line_name ?? null)),
    compMaster_name_dup: dupCounts(compMasters.map((r) => r.line_name ?? null)),
  };
  console.log(JSON.stringify(dup, null, 1));
  out.duplicates = dup;

  // ── 3) direct vs HTTP 비교 ──
  console.log("\n=== 3) direct 함수 vs HTTP API 비교 ===");
  const before = await fingerprint();
  out.fingerprintBefore = before;

  const cookie = await makeAdminCookieHeader();

  // 3-a) line_registrations
  const directRegs = await listLineRegistrations({ limit: 50 });
  const httpRegsRes = await fetch(`${baseUrl}/api/admin/lines/registrations?limit=50`, {
    headers: { Cookie: cookie },
  });
  const httpRegs = (await httpRegsRes.json()) as {
    success: boolean;
    data: { rows: unknown[]; total: number };
  };
  const directRegsJson = JSON.stringify(directRegs.rows);
  const httpRegsJson = JSON.stringify(httpRegs.data.rows);
  const regsMatch = directRegsJson === httpRegsJson && directRegs.total === httpRegs.data.total;
  console.log(
    `  registrations: direct=${directRegs.total}건, http=${httpRegs.data.total}건, 일치=${regsMatch}`,
  );
  out.directVsHttp_registrations = {
    directTotal: directRegs.total,
    httpTotal: httpRegs.data.total,
    rowsIdentical: regsMatch,
  };

  // 3-b) lines/history (라인 정보 화면) — status 는 now 파생이므로 id/코드/이름만 비교.
  // limit 을 줄여가며 direct 호출 — 대형 .in() URL 이 스크립트 런타임(undici)에서 실패할 수 있어
  // 실패 시 limit 5 로 재시도하고, 그래도 실패하면 기록만 남기고 HTTP 비교는 동일 limit 로 진행.
  let directHist: Awaited<ReturnType<typeof listCluster4OpenedLines>> | null = null;
  let histLimit = 20;
  for (const tryLimit of [20, 5]) {
    try {
      directHist = await listCluster4OpenedLines({ limit: tryLimit });
      histLimit = tryLimit;
      break;
    } catch (e) {
      console.log(`  lines/history direct(limit=${tryLimit}) 실패: ${e instanceof Error ? e.message : e}`);
    }
  }
  const httpHistRes = await fetch(
    `${baseUrl}/api/admin/cluster4/lines/history?limit=${histLimit}`,
    { headers: { Cookie: cookie } },
  );
  const httpHist = (await httpHistRes.json()) as {
    success: boolean;
    data: { rows: Array<{ id: string; lineCode: string | null; lineName: string }>; total: number };
  };
  const pick = (r: { id: string; lineCode: string | null; lineName: string }) =>
    ({ id: r.id, lineCode: r.lineCode, lineName: r.lineName });
  if (directHist) {
    const histMatch =
      JSON.stringify(directHist.rows.map(pick)) === JSON.stringify(httpHist.data.rows.map(pick)) &&
      directHist.total === httpHist.data.total;
    console.log(
      `  lines/history(limit=${histLimit}): direct=${directHist.total}건, http=${httpHist.data.total}건, 일치=${histMatch}`,
    );
    out.directVsHttp_history = {
      limit: histLimit,
      directTotal: directHist.total,
      httpTotal: httpHist.data.total,
      rowsIdentical: histMatch,
    };
  } else {
    console.log(
      `  lines/history: direct 호출 스크립트 런타임에서 실패(undici 대형 .in() URL) — HTTP=${httpHist.data.total}건 (서버 런타임 정상)`,
    );
    out.directVsHttp_history = {
      limit: histLimit,
      directTotal: null,
      directError: "script-runtime fetch failed (large .in() URL)",
      httpTotal: httpHist.data.total,
      rowsIdentical: null,
    };
  }
  // 라인 정보(history)에 line_registrations 행이 섞이는지 (격리 확인)
  const regIds = new Set(regs.map((r) => r.id));
  const regCodesInHistory = httpHist.data.rows.filter(
    (r) => regIds.has(r.id) || regs.some((g) => g.line_code === r.lineCode),
  );
  console.log(`  라인 정보(history)에 등록 레지스트리 행 노출: ${regCodesInHistory.length}건 (0 기대)`);
  out.historyContainsRegistrations = regCodesInHistory.length;

  // ── 4) snapshot fingerprint 후 ──
  const after = await fingerprint();
  out.fingerprintAfter = after;
  const fpSame = JSON.stringify(before) === JSON.stringify(after);
  console.log(`\n=== 4) snapshot fingerprint 전후 동일=${fpSame} ===`);
  console.log(" before:", JSON.stringify(before));
  console.log(" after: ", JSON.stringify(after));

  writeFileSync(
    "claudedocs/line-sot-phase2-survey-20260607.json",
    JSON.stringify(out, null, 2),
    "utf8",
  );
  console.log("\nsaved: claudedocs/line-sot-phase2-survey-20260607.json");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
