/**
 * 카페 댓글 검수 — 두 통합 진입 경로 브라우저 종단 검증(구형 경로 404 · 강제 이동 없음 · statusId 동일성).
 *
 *   A) /admin/integrated/processes/check/{hub} — [즉시 검수] 클릭
 *      · POST body 의 statusId 가 목록 GET DTO 의 checkStatusId 와 동일한가(클라 조합/대체 없음)
 *      · 응답 status='completed'(= statusId 조회 실패 not_found 아님)
 *      · 완료 후 현재 integrated pathname 유지(구형 경로로 강제 이동 없음)
 *   B) /admin/integrated/line-opening/practical-info — [개설 대상 크루 수정] → 카페 링크 [검수] 클릭
 *      · 공용 CafeCrewPicker → POST /api/admin/cluster4/cafe-line-crew 왕복(화면별 복제 로직 없음)
 *      · 수집 후 현재 integrated pathname 유지. 저장하지 않고 닫는다(데이터 무변경).
 *   공통) 두 화면 전 구간에서 /admin/line-opening · /admin/processes 구형 bare 경로 요청(_rsc 포함) 0건 ·
 *         문서(RSC) 4xx/5xx 0건.
 *
 *   ORG 2곳(encre·oranke) × 모드 2종(operating·mode=test) 교차.
 *   쓰기는 "이번 주 가동 체크대상 액트에 pending 상태행 1건" 시드뿐이며 종료 시 전부 삭제(무흔적).
 *   ⚠ 즉시 검수는 크롤 결과와 무관하게 항상 완료 처리되는 기존 정책 그대로 — 이 스크립트는 정책을 바꾸지 않는다.
 *
 *   npx tsx --env-file=.env.local scripts/verify-cafe-review-two-entrypoints-browser.ts
 */
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";

const __dirname = dirname(fileURLToPath(import.meta.url));
const adminRoot = resolve(__dirname, "..");
const frontRoot = resolve(adminRoot, "..", "vraxium");
const { chromium } = createRequire(resolve(frontRoot, "package.json"))("playwright");

const env = readFileSync(resolve(adminRoot, ".env.local"), "utf8");
const g = (k: string) => env.match(new RegExp(`^${k}=(.+)$`, "m"))?.[1]?.trim();
const adminEmail = process.env.SMOKE_ADMIN_EMAIL ?? "vanuatu.golden@gmail.com";
const BASE = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
const SUPABASE_URL = g("NEXT_PUBLIC_SUPABASE_URL")!;
const ANON = g("NEXT_PUBLIC_SUPABASE_ANON_KEY")!;
const admin = createClient(SUPABASE_URL, g("SUPABASE_SERVICE_ROLE_KEY")!);

const ORGS = ["encre", "oranke"] as const;
const MODES = ["operating", "test"] as const;
const HUBS = ["club", "info"] as const; // 비팀 허브(섹션.0 표에 즉시 검수 노출)
const CAFE_URL = "https://cafe.naver.com/zz-verify-browser/1";
// 구형(라우트 없음) bare 경로 — 어떤 화면에서도 요청되면 안 된다(_rsc 프리페치 포함).
const LEGACY_BARE = /^\/admin\/(line-opening|processes)\/?$/;

let pass = 0;
let fail = 0;
const skips: string[] = [];
const ck = (l: string, ok: boolean, d = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${l}${d ? ` — ${d}` : ""}`);
  ok ? pass++ : fail++;
};
const skip = (l: string, why: string) => {
  console.log(`  ⊘ ${l} — SKIP: ${why}`);
  skips.push(`${l} (${why})`);
};

async function makeAdminCookies() {
  const anon = createClient(SUPABASE_URL, ANON);
  const { data: link } = await admin.auth.admin.generateLink({ type: "magiclink", email: adminEmail });
  const { data: v } = await anon.auth.verifyOtp({
    email: adminEmail,
    token: (link as any).properties.email_otp,
    type: "magiclink",
  });
  const cap: any[] = [];
  const srv = createServerClient(SUPABASE_URL, ANON, {
    cookies: { getAll: () => [], setAll: (i: any[]) => cap.push(...i) },
  });
  await srv.auth.setSession({
    access_token: (v as any).session.access_token,
    refresh_token: (v as any).session.refresh_token,
  });
  return cap.map((i) => ({
    name: i.name, value: i.value, domain: "localhost", path: "/",
    httpOnly: false, secure: false, sameSite: "Lax" as const,
  }));
}

const seededStatusIds: string[] = [];
let preLogIds = new Set<string>();

async function main() {
  const { data: pre } = await admin.from("process_check_logs").select("id");
  preLogIds = new Set(((pre ?? []) as any[]).map((l) => l.id));

  const browser = await chromium.launch({ channel: "chromium", headless: true });
  const context = await browser.newContext({ viewport: { width: 1600, height: 1400 } });
  await context.addCookies(await makeAdminCookies());
  const page = await context.newPage();

  const legacyHits: string[] = [];
  const docErrors: string[] = [];
  page.on("request", (r) => {
    const u = new URL(r.url());
    if (u.origin === BASE && LEGACY_BARE.test(u.pathname)) legacyHits.push(`${r.method()} ${u.pathname}${u.search}`);
  });
  page.on("response", (r) => {
    if (r.status() >= 400 && r.request().resourceType() === "document") docErrors.push(`${r.status()} ${r.url()}`);
  });

  try {
    for (const org of ORGS) {
      for (const mode of MODES) {
        const modeQs = mode === "test" ? "&mode=test" : "";
        const label = `${org}/${mode}`;

        // ══ A) 프로세스 체크 진입 — 즉시 검수 ══════════════════════════════
        let done = false;
        for (const hub of HUBS) {
          if (done) break;
          const checkPath = `/admin/integrated/processes/check/${hub}?org=${org}${modeQs}`;
          await page.goto(`${BASE}${checkPath}`, { waitUntil: "domcontentloaded" });
          const board = await page.evaluate(
            async (qs) => (await fetch(`/api/admin/processes/check?${qs}`, { cache: "no-store" })).json(),
            `hub=${hub}&org=${org}${modeQs}`,
          );
          const weekId = board?.data?.selectedWeekId ?? board?.data?.week?.weekId ?? null;
          const acts: any[] = board?.data?.acts ?? [];
          // 즉시 검수 버튼은 "이번 주 가동(isOpenThisWeek) + 체크대상 + pending" 행에만 노출된다.
          const target = acts.find((a) => a.isOpenThisWeek && a.isCheckTarget && a.status === "needed" && a.lineGroupId);
          if (!weekId || !target) continue;

          const ins = await admin.from("process_check_statuses").insert({
            organization_slug: org, hub, week_id: weekId, act_id: target.actId,
            line_group_id: target.lineGroupId, status: "pending", scope_mode: mode,
            review_link: CAFE_URL,
            scheduled_check_at: new Date(Date.now() + 2 * 86_400_000).toISOString(), attempt_count: 0,
          }).select("id").maybeSingle();
          if (ins.error || !ins.data) continue;
          const statusId = (ins.data as any).id as string;
          seededStatusIds.push(statusId);

          await page.reload({ waitUntil: "domcontentloaded" });
          const dtoIds: string[] = await page.evaluate(
            async (qs) => {
              const j = await (await fetch(`/api/admin/processes/check?${qs}`, { cache: "no-store" })).json();
              return (j?.data?.acts ?? []).map((a: any) => a.checkStatusId).filter(Boolean);
            },
            `hub=${hub}&org=${org}${modeQs}`,
          );
          ck(
            `[A ${label}/${hub}] 목록 GET DTO 가 그 statusId 를 제공`,
            dtoIds.includes(statusId),
            `GET /api/admin/processes/check?hub=${hub}&org=${org}${modeQs} 200 · statusId=${statusId}`,
          );

          const row = page.locator("tr", { hasText: target.actName }).first();
          await row.waitFor({ state: "visible", timeout: 30_000 });
          const btn = row.getByRole("button", { name: "즉시 검수" });
          await btn.waitFor({ state: "visible", timeout: 20_000 });
          const pathBefore = new URL(page.url()).pathname;
          await btn.click();
          await page.getByText("이 항목을 지금 바로 검수하시겠습니까?").waitFor({ state: "visible", timeout: 15_000 });
          const respP = page
            .waitForResponse((r) => r.url().includes("/api/admin/qa/run-now/process-check-row"), { timeout: 180_000 })
            .catch(() => null);
          await page.getByRole("alertdialog").getByRole("button", { name: "즉시 검수" }).click();
          const resp = await respP;
          const postBodyId = resp ? (JSON.parse(resp.request().postData() ?? "{}").statusId ?? null) : null;
          const postJson = resp ? await resp.json().catch(() => null) : null;
          await page.waitForTimeout(2500);
          const pathAfter = new URL(page.url()).pathname;

          ck(
            `[A ${label}/${hub}] POST 가 GET DTO 의 동일 statusId 를 그대로 전달(클라 조합 없음)`,
            postBodyId === statusId,
            `POST /api/admin/qa/run-now/process-check-row ${resp?.status()} · body.statusId=${postBodyId}`,
          );
          ck(
            `[A ${label}/${hub}] 즉시 검수 성공 — status=completed(statusId 조회 실패 not_found 아님)`,
            postJson?.data?.status === "completed",
            `status=${postJson?.data?.status} crawlOutcome=${postJson?.data?.code}`,
          );
          const { data: afterRow } = await admin
            .from("process_check_statuses")
            .select("status,scope_mode,organization_slug")
            .eq("id", statusId).maybeSingle();
          ck(
            `[A ${label}/${hub}] 검수 결과 저장 + 스코프 불변(org/mode)`,
            (afterRow as any)?.status === "completed" &&
              ((afterRow as any)?.scope_mode ?? "operating") === mode &&
              (afterRow as any)?.organization_slug === org,
            `db=${JSON.stringify(afterRow)}`,
          );
          ck(
            `[A ${label}/${hub}] 완료 후 현재 integrated pathname 유지(RSC 재요청 경로 동일)`,
            pathBefore === pathAfter && pathAfter === `/admin/integrated/processes/check/${hub}`,
            `${pathBefore} → ${pathAfter}`,
          );
          done = true;
        }
        if (!done) skip(`[A ${label}] 즉시 검수 클릭`, "이번 주 가동+체크대상 액트 없음(미오픈 주차)");

        // ══ B) 라인 개설 진입 — 개설 대상 크루 수정 → 카페 링크 검수 ═══════
        const openPath = `/admin/integrated/line-opening/practical-info?org=${org}${modeQs}`;
        await page.goto(`${BASE}${openPath}`, { waitUntil: "domcontentloaded" });
        await page.waitForTimeout(6000);
        const editBtn = page.getByRole("button", { name: "개설 대상 크루 수정" }).first();
        if ((await editBtn.count()) === 0) {
          skip(`[B ${label}] 카페 댓글 수집 클릭`, "수정 허용 주차의 개설된 라인 없음");
          continue;
        }
        const pathBefore = new URL(page.url()).pathname;
        await editBtn.click();
        const urlInput = page.locator('input[aria-label="카페 게시물 링크"]').last();
        await urlInput.waitFor({ state: "visible", timeout: 20_000 });
        ck(`[B ${label}] 공용 CafeCrewPicker 카페 링크 입력 활성(모달 경로)`, await urlInput.isEnabled());
        await urlInput.fill(CAFE_URL);
        const respP = page
          .waitForResponse(
            (r) => r.url().includes("/api/admin/cluster4/cafe-line-crew") && r.request().method() === "POST",
            { timeout: 180_000 },
          )
          .catch(() => null);
        await page.getByRole("button", { name: /^(검수|댓글 다시 수집)$/ }).last().click();
        const resp = await respP;
        await page.waitForTimeout(2000);
        const pathAfter = new URL(page.url()).pathname;
        const respUrl = resp ? new URL(resp.url()) : null;
        ck(
          `[B ${label}] 댓글 수집이 공통 cafe-line-crew POST 로 수렴(화면 전용 복제 없음)`,
          Boolean(resp),
          respUrl ? `POST ${respUrl.pathname}${respUrl.search} ${resp!.status()}` : "no-response",
        );
        ck(
          `[B ${label}] 요청 스코프에 org(+mode) 동일 반영`,
          Boolean(respUrl) &&
            respUrl!.searchParams.get("organization") === org &&
            (mode === "test" ? respUrl!.searchParams.get("mode") === "test" : respUrl!.searchParams.get("mode") === null),
          respUrl ? respUrl.search : "",
        );
        ck(
          `[B ${label}] 수집 후 현재 integrated pathname 유지(강제 이동 없음)`,
          pathBefore === pathAfter && pathAfter === "/admin/integrated/line-opening/practical-info",
          `${pathBefore} → ${pathAfter}`,
        );
        // 저장하지 않고 닫는다(데이터 무변경).
        await page.keyboard.press("Escape").catch(() => {});
        await page.waitForTimeout(500);
      }
    }

    ck(
      "두 진입 경로 전 구간에서 구형 bare 경로(/admin/line-opening · /admin/processes) 요청 0건",
      legacyHits.length === 0,
      legacyHits.length ? legacyHits.join(" · ") : "none",
    );
    ck("문서(RSC 포함) 4xx/5xx 응답 0건", docErrors.length === 0, docErrors.length ? docErrors.join(" · ") : "none");
  } catch (e: any) {
    console.error("browser error:", e?.stack ?? e?.message ?? e);
    fail++;
  } finally {
    for (const id of seededStatusIds) {
      await admin.from("process_check_review_recipients").delete().eq("ref_id", id);
      await admin.from("process_point_awards").delete().eq("ref_id", id);
      await admin.from("process_check_statuses").delete().eq("id", id);
    }
    const { data: post } = await admin.from("process_check_logs").select("id");
    const newIds = ((post ?? []) as any[]).map((l) => l.id).filter((id) => !preLogIds.has(id));
    if (newIds.length) await admin.from("process_check_logs").delete().in("id", newIds);
    console.log(`  [cleanup] status=${seededStatusIds.length} log=${newIds.length} 삭제(무흔적)`);
    await browser.close();
  }

  if (skips.length) console.log(`\n  SKIP ${skips.length}건: ${skips.join(" · ")}`);
  console.log(`\n결과: ${pass} pass / ${fail} fail`);
  process.exit(fail > 0 ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
