// EXECUTE 후 검증 — main_title/output_links 반영 + 대상 크루 불변 + cafe-only.
//   direct(DB) vs HTTP(GET /api/admin/cluster4/info-lines?week_id=&organization=oranke, 관리자 쿠키).
//   대상 = 변경된 라인(제목 8 + 링크덮어쓰기 28 + 링크신규 sample). admin info-lines GET 은 live read(snapshot 무관).
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const adminRoot = resolve(__dirname, "..");
const requireAdmin = createRequire(resolve(adminRoot, "package.json"));
const { createClient } = requireAdmin("@supabase/supabase-js");
const { createServerClient } = requireAdmin("@supabase/ssr");

const env = readFileSync(resolve(adminRoot, ".env.local"), "utf8");
const get = (k) => env.match(new RegExp(`^${k}=(.+)$`, "m"))?.[1]?.trim();
const adminEmail = process.env.SMOKE_ADMIN_EMAIL ?? "vanuatu.golden@gmail.com";
const BASE = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
const SUPABASE_URL = get("NEXT_PUBLIC_SUPABASE_URL");
const ANON = get("NEXT_PUBLIC_SUPABASE_ANON_KEY");
const SERVICE = get("SUPABASE_SERVICE_ROLE_KEY");
const sb = createClient(SUPABASE_URL, SERVICE, { auth: { persistSession: false } });

async function makeCookieHeader() {
  const b = createClient(SUPABASE_URL, ANON);
  const { data: linkData } = await sb.auth.admin.generateLink({ type: "magiclink", email: adminEmail });
  const { data: verifyData } = await b.auth.verifyOtp({
    email: adminEmail, token: linkData.properties.email_otp, type: "magiclink",
  });
  const captured = [];
  const server = createServerClient(SUPABASE_URL, ANON, {
    cookies: { getAll: () => [], setAll: (items) => captured.push(...items) },
  });
  await server.auth.setSession({
    access_token: verifyData.session.access_token,
    refresh_token: verifyData.session.refresh_token,
  });
  return captured.map((i) => `${i.name}=${i.value}`).join("; ");
}

const urlsOf = (links) => (Array.isArray(links) ? links.map((l) => l.url).sort().join(" ") : "");
const labelsOf = (links) => (Array.isArray(links) ? links.map((l) => l.label) : []);

async function httpLines(cookie, weekId) {
  const url = `${BASE}/api/admin/cluster4/info-lines?week_id=${weekId}&organization=oranke`;
  const r = await fetch(url, { headers: { cookie } });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, rows: j?.data?.rows ?? [] };
}

async function main() {
  // 변경 대상 라인 id 수집.
  const dry = JSON.parse(readFileSync(resolve(adminRoot, "claudedocs/dryrun-resync-oranke-260521.json"), "utf8"));
  const titleIds = (dry.sampleTitleUpdate ?? []).map((a) => a.id);
  const conflictIds = (dry.outputLinkConflictsPreserved ?? []).map((a) => a.id); // 덮어쓰기 28
  const linkAddIds = (dry.sampleLinkAdd ?? []).map((a) => a.id);
  const allIds = [...new Set([...titleIds, ...conflictIds, ...linkAddIds])];

  // direct DB 현재 상태.
  const direct = new Map();
  for (let i = 0; i < allIds.length; i += 100) {
    const slice = allIds.slice(i, i + 100);
    const { data, error } = await sb
      .from("cluster4_lines")
      .select("id,week_id,main_title,output_links,output_link_1,output_link_2")
      .in("id", slice);
    if (error) throw new Error(error.message);
    for (const r of data ?? []) direct.set(r.id, r);
  }

  const cookie = await makeCookieHeader();
  const weekIds = [...new Set([...direct.values()].map((r) => r.week_id))];
  const httpById = new Map();
  for (const weekId of weekIds) {
    const { rows } = await httpLines(cookie, weekId);
    for (const row of rows) httpById.set(row.id, row);
  }

  let contentPass = 0, contentFail = 0;
  let cafeOnlyPass = 0, cafeOnlyFail = 0;
  let labelPass = 0, labelFail = 0;
  const fails = [];
  for (const id of allIds) {
    const d = direct.get(id);
    const h = httpById.get(id);
    if (!d || !h) { contentFail++; fails.push({ id, reason: "missing direct/http" }); continue; }
    // direct==HTTP: main_title + output_links url집합 일치.
    const titleMatch = (d.main_title ?? "") === (h.mainTitle ?? "");
    const urlMatch = urlsOf(d.output_links) === urlsOf(h.outputLinks);
    if (titleMatch && urlMatch) contentPass++;
    else { contentFail++; fails.push({ id, titleMatch, urlMatch, directTitle: d.main_title, httpTitle: h.mainTitle }); }
  }
  // 28 덮어쓰기 행: cafe-only(youtube 없음) + label "카페 공표글 링크".
  for (const id of conflictIds) {
    const d = direct.get(id);
    if (!d) { cafeOnlyFail++; continue; }
    const urls = (d.output_links ?? []).map((l) => l.url);
    const hasYoutube = urls.some((u) => /youtu/.test(u));
    const cafeOnly = urls.length === 1 && /cafe\.naver\.com/.test(urls[0]) && !hasYoutube;
    if (cafeOnly) cafeOnlyPass++; else { cafeOnlyFail++; fails.push({ id, reason: "not cafe-only", urls }); }
    const labels = (d.output_links ?? []).map((l) => l.label);
    if (labels.length > 0 && labels.every((l) => l === "카페 공표글 링크")) labelPass++;
    else { labelFail++; fails.push({ id, reason: "label not unified", labels }); }
  }

  console.log(JSON.stringify({
    verifiedLines: allIds.length,
    overwriteRows: conflictIds.length,
    directEqualsHttp: { pass: contentPass, fail: contentFail },
    cafeOnly_on_overwriteRows: { pass: cafeOnlyPass, fail: cafeOnlyFail },
    labelUnified_on_overwriteRows: { pass: labelPass, fail: labelFail },
    failSample: fails.slice(0, 15),
    sampleAfter: conflictIds.slice(0, 3).map((id) => ({ id, output_links: direct.get(id)?.output_links })),
    conclusion: (contentFail === 0 && cafeOnlyFail === 0 && labelFail === 0)
      ? "PASS — direct==HTTP, 28행 cafe-only, label 통일. (admin live read)"
      : "FAIL — 상세 failSample 참조.",
  }, null, 2));
}

main().catch((e) => { console.error("ERR", e instanceof Error ? e.message : e); process.exit(1); });
