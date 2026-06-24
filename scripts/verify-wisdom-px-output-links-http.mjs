// HTTP 검증 — 26봄 PX 위즈덤 info 라인 output_link 교체.
//   direct(DB cluster4_lines) vs HTTP(GET /api/admin/cluster4/info-lines?week_id=&organization=phalanx, 관리자 쿠키).
//   admin info-lines GET 은 live read(snapshot 무관) → 라인 메타(outputLinks) 즉시 반영 확인.
//   추가로 cluster4_weekly_card_snapshots(snapshot) 에 NEW url 반영 / OLD url 0 을 직접 확인(snapshot-only 소비처).
//
// 사전: 서버(localhost:3000) 가 떠 있어야 한다.
// 실행: node scripts/verify-wisdom-px-output-links-http.mjs
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

const LINES = [
  { week: 1, lineId: "9ded1835-6987-41cd-b588-6672bf65c0e4", weekId: "d3aa89d8-35f6-42b3-bb12-a1d65b6b0e91", oldUrl: "https://www.youtube.com/watch?v=oS23Z3iAvp8", newUrl: "https://cafe.naver.com/phalanx/8440" },
  { week: 2, lineId: "c315b4a6-497e-498a-b6ed-f1d267cce6a2", weekId: "31672f8c-e58c-4d92-9939-197237d7fbcf", oldUrl: "https://www.youtube.com/watch?v=XD98WZG8dRU", newUrl: "https://cafe.naver.com/phalanx/8530" },
  { week: 3, lineId: "cd5c3e8c-7920-4c1e-8bfd-508043509889", weekId: "c6800fe1-8200-4b10-9c97-7515b6a805ca", oldUrl: "https://www.youtube.com/watch?v=Sh002SyAm3c", newUrl: "https://cafe.naver.com/phalanx/8615" },
  { week: 4, lineId: "61579d75-e7fa-4090-ac8f-0225acac518d", weekId: "5eca4fe4-77ff-46bc-9e53-8772a078b651", oldUrl: "https://www.youtube.com/watch?v=to-VGHAxdaY", newUrl: "https://cafe.naver.com/phalanx/8716" },
  { week: 5, lineId: "b1046d2c-3c1a-4730-ab23-547d925e04af", weekId: "20a7ebcb-85ea-4a98-83fa-a920d010038a", oldUrl: "https://www.youtube.com/watch?v=4wUzCawJmMI", newUrl: "https://cafe.naver.com/phalanx/8808" },
  { week: 9, lineId: "dc7ccffc-6d44-429b-8268-b4b601b6fb78", weekId: "b531c234-e860-499a-992c-b74d2c1d5349", oldUrl: "https://www.youtube.com/watch?v=KRjskY2HDrg", newUrl: "https://cafe.naver.com/phalanx/8941" },
  { week: 10, lineId: "fd7f9c1b-f8ef-4d8a-a3a6-b1b40e00b124", weekId: "6cc59d70-3aa6-4823-8854-5b82691d1a84", oldUrl: "https://www.youtube.com/watch?v=g-12S5dFldY", newUrl: "https://cafe.naver.com/phalanx/9014" },
  { week: 11, lineId: "b1eb989e-b853-4c5d-87a4-80c01ae91171", weekId: "67e07106-564e-4dab-b180-8f11c909973a", oldUrl: "https://www.youtube.com/watch?v=L3E-4X0x54E", newUrl: "https://cafe.naver.com/phalanx/9106" },
  { week: 12, lineId: "967d5278-bb45-4f29-b1da-9c36812c6d0c", weekId: "00000000-0000-0000-0000-202605210002", oldUrl: "https://www.youtube.com/watch?v=nhmEbI0ujek", newUrl: "https://cafe.naver.com/phalanx/9208" },
  { week: 13, lineId: "a4e60985-6148-40a9-a2a5-e8f9af9bd537", weekId: "a2112b50-64d2-42d6-a243-faf9fcdc6ffc", oldUrl: "https://www.youtube.com/watch?v=Q1wxAVEqKJE", newUrl: "https://cafe.naver.com/phalanx/9288" },
];

let pass = 0, fail = 0;
const check = (label, ok, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  ok ? pass++ : fail++;
};

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

async function httpLines(cookie, weekId) {
  const url = `${BASE}/api/admin/cluster4/info-lines?week_id=${weekId}&organization=phalanx`;
  const r = await fetch(url, { headers: { cookie, Connection: "close" } });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, rows: j?.data?.rows ?? [] };
}

async function main() {
  console.log("=== verify-wisdom-px-output-links-http ===\n");
  const cookie = await makeCookieHeader();

  // ── (1) direct DB outputLinks ─────────────────────────────────────────
  const ids = LINES.map((l) => l.lineId);
  const { data: dbRows } = await sb
    .from("cluster4_lines")
    .select("id,line_code,output_link_1,output_links")
    .in("id", ids);
  const dbById = new Map((dbRows ?? []).map((r) => [r.id, r]));

  console.log("── direct DB vs HTTP(admin info-lines GET, phalanx) ──");
  for (const l of LINES) {
    const db = dbById.get(l.lineId);
    const dbUrl = Array.isArray(db?.output_links) ? db.output_links[0]?.url : null;

    const { status, rows } = await httpLines(cookie, l.weekId);
    const httpRow = rows.find((row) => (row.lineCode ?? "").includes("PX-wisdom"));
    const httpUrl = Array.isArray(httpRow?.outputLinks) ? httpRow.outputLinks[0]?.url : null;
    const httpLabel = Array.isArray(httpRow?.outputLinks) ? httpRow.outputLinks[0]?.label : null;

    check(
      `W${l.week} HTTP 200 + line 존재`,
      status === 200 && !!httpRow,
      `status=${status} lineCode=${httpRow?.lineCode ?? "(none)"}`,
    );
    check(`W${l.week} direct DB url == NEW`, dbUrl === l.newUrl, `db=${dbUrl}`);
    check(`W${l.week} HTTP url == NEW`, httpUrl === l.newUrl, `http=${httpUrl}`);
    check(`W${l.week} direct == HTTP`, dbUrl === httpUrl, `db=${dbUrl} http=${httpUrl}`);
    check(`W${l.week} label 보존(카페 공표글 링크)`, httpLabel === "카페 공표글 링크", `label=${httpLabel}`);
    check(`W${l.week} OLD url 미노출`, httpUrl !== l.oldUrl && dbUrl !== l.oldUrl, "");
    // 불변 보장: line_code / week_id / main_title 그대로
    check(`W${l.week} line_code 불변`, (httpRow?.lineCode ?? null) === (db?.line_code ?? null), `${httpRow?.lineCode}`);
    check(`W${l.week} HTTP weekId 일치`, (httpRow?.weekId ?? null) === l.weekId, `${httpRow?.weekId}`);
  }

  // ── (2) snapshot(snapshot-only 소비처) NEW 반영 / OLD 0 ────────────────
  console.log("\n── snapshot(cluster4_weekly_card_snapshots) NEW 반영 / OLD 잔존 ──");
  // ⚠ fat cards jsonb 전수 select 는 statement timeout/row-cap 으로 빈 결과를 줄 수 있어
  //   user_id 페이지네이션(.range, order) 으로 끊어 cards 를 청크 조회한다.
  const oldSet = LINES.map((l) => l.oldUrl);
  const newSet = LINES.map((l) => l.newUrl);
  let oldHit = 0, newHit = 0, scanned = 0;
  const PAGE = 50;
  for (let offset = 0; ; offset += PAGE) {
    const { data: page, error } = await sb
      .from("cluster4_weekly_card_snapshots")
      .select("user_id,cards")
      .order("user_id", { ascending: true })
      .range(offset, offset + PAGE - 1);
    if (error) { console.error("snapshot page error:", error.message); break; }
    if (!page || page.length === 0) break;
    for (const r of page) {
      scanned++;
      const t = JSON.stringify(r.cards ?? null);
      if (oldSet.some((u) => t.includes(u))) oldHit++;
      if (newSet.some((u) => t.includes(u))) newHit++;
    }
    if (page.length < PAGE) break;
  }
  console.log(`  스캔된 snapshot 행: ${scanned}`);
  check("snapshot 전체에 OLD(유튜브) url 잔존 0", oldHit === 0, `oldHit=${oldHit}`);
  check("snapshot 에 NEW(카페) url 반영 > 0", newHit > 0, `newHit=${newHit}`);

  console.log(`\n=== ${fail === 0 ? "ALL PASS" : `${fail} FAIL`} (pass=${pass} fail=${fail}) ===`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
