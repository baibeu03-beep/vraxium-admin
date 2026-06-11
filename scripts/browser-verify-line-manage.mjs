// 브라우저 검증 — 실무 경험 [라인 관리] 탭 팀 요약 보드 (:3000, 어드민 세션 쿠키 주입).
//   /admin/line-opening/practical-experience?org=oranke  (기본 tab = 라인 관리)
//   팀 요약 보드: 전체 요약(팀 수/개설 완료/개설 필요) + 팀 카드(상태 배지·파트 칸·라인별 강화 결과·확장 게이트).
//   표시 전용(read-only). screenshot → claudedocs/browser-line-manage.png
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const adminRoot = resolve(__dirname, "..");
const frontRoot = resolve(adminRoot, "..", "vraxium");
const { chromium } = createRequire(resolve(frontRoot, "package.json"))("playwright");
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
const ORG = "oranke";

async function makeAdminCookies() {
  const admin = createClient(SUPABASE_URL, SERVICE);
  const browser = createClient(SUPABASE_URL, ANON);
  const { data: linkData } = await admin.auth.admin.generateLink({ type: "magiclink", email: adminEmail });
  const { data: verifyData } = await browser.auth.verifyOtp({
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
  return captured.map((i) => ({
    name: i.name, value: i.value, domain: "localhost", path: "/", httpOnly: false, secure: false, sameSite: "Lax",
  }));
}

let pass = 0, fail = 0;
const check = (label, ok, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  ok ? pass++ : fail++;
};

const browser = await chromium.launch({ channel: "chromium", headless: true });
const context = await browser.newContext({ viewport: { width: 1500, height: 2200 } });
await context.addCookies(await makeAdminCookies());
const page = await context.newPage();

// line-manage 조회 카운터(주차 변경 시 재조회 검증) — 마지막 요청의 week_id 추적.
let lineManageGets = 0;
let lastWeekIdParam = null;
page.on("request", (req) => {
  const u = req.url();
  if (u.includes("/experience/line-manage")) {
    lineManageGets++;
    try {
      lastWeekIdParam = new URL(u).searchParams.get("week_id");
    } catch {
      /* ignore */
    }
  }
});

try {
  await page.goto(`${BASE}/admin/line-opening/practical-experience?org=${ORG}`, { waitUntil: "domcontentloaded" });
  // 보드 렌더 대기(라인 문장형 + 인원 요약).
  await page.waitForFunction("document.body.innerText.includes('<도출>') && /전체\\s*\\d+명/.test(document.body.innerText)", undefined, { timeout: 60000 });
  // 데이터 로드 완료(불러오는 중… 사라짐) 대기.
  await page.waitForFunction("!document.body.innerText.includes('불러오는 중')", undefined, { timeout: 30000 });
  const body = await page.evaluate("document.body.innerText");

  // [req4] 제목 변경.
  check("[req4] 제목 '[실무 경험] Hub'", body.includes("[실무 경험] Hub"));
  check("[req4] 기존 제목 '실무 경험 워크플로우' 미노출", !body.includes("실무 경험 워크플로우"));
  // [req3-삭제] 삭제 요청 문구가 화면에서 사라졌는지.
  check("[req3-삭제] '팀 요약 보드' 미노출", !body.includes("팀 요약 보드"));
  check("[req3-삭제] '현재 상황' 미노출", !body.includes("현재 상황"));
  check("[req3-삭제] '개설 대상 주차 ~ (표시 전용)' 미노출",
    !body.includes("개설 대상 주차") && !body.includes("(표시 전용)"));
  // [req-유지] 주차/요약 행 — "NN년, ○○ 시즌, N주차" 형태 + 팀 수/개설 완료/개설 필요.
  check("[req-유지] 선택 주차 라벨 'NN년, ○○ 시즌, N주차' 형태",
    /\d{2}년,\s*.+시즌,\s*\d+주차/.test(body), (body.match(/\d{2}년,[^\n]*주차/) ?? [""])[0]);
  check("[req-유지] 요약 카운트(팀 수/개설 완료/개설 필요)",
    body.includes("팀 수") && body.includes("개설 완료") && body.includes("개설 필요"));
  // [req1] 라인별 결과 문장형.
  check("[req1] 라인별 결과 문장형('<도출> : 전체 N명 중 강화 성공: …')",
    /<도출>\s*:\s*전체\s*\d+명\s*중\s*강화 성공:/.test(body),
    (body.match(/<도출>[^\n]*/) ?? [""])[0]);
  check("[req1] 문장형 지표(강화 성공:/미이행:/평점 미비:)",
    body.includes("강화 성공:") && body.includes("미이행:") && body.includes("평점 미비:"));
  check("[req1] 5 카테고리 라인(<도출>/<분석>/<견문>/<관리>/<확장>)",
    ["<도출>", "<분석>", "<견문>", "<관리>", "<확장>"].every((h) => body.includes(h)));
  check("[req1] 확장 기간 아님 → '해당 기간 아님' 표시", body.includes("해당 기간 아님"));
  // [req2] 팀 인원 요약(전체/활동/휴식/중단/일반/파트장/에이전트).
  check("[req2] 팀 인원 요약 — 전체 N명 + 상태/등급 분류",
    /전체\s*\d+명/.test(body) &&
    ["활동", "휴식", "중단", "일반", "파트장", "에이전트"].every((k) => body.includes(k)),
    (body.match(/전체\s*\d+명/) ?? [""])[0]);
  // 보드와 함께 기존 내부 탭(라인 등록/입력 관리/검수 관리/최종 개설)도 공존(라인 관리 화면 유지).
  check("[UI] 기존 내부 탭 공존(라인 등록/입력 관리/검수 관리/최종 개설)",
    ["라인 등록", "입력 관리", "검수 관리", "최종 개설"].every((t) => body.includes(t)));

  // [팀장] 각 팀 카드에 팀장 표시(이름+학적, 없으면 "팀장 정보 없음") — 헤더 우측.
  const leaderInfo = await page.evaluate(() => {
    const spans = [...document.querySelectorAll("span")].filter((s) => {
      const t = (s.textContent || "").trim();
      return t.startsWith("팀장:") || t === "팀장 정보 없음";
    });
    // 팀명(CardTitle) 좌표와 비교해 같은 헤더 행 우측인지(같은 줄이면 top 근접 + 더 오른쪽).
    let alignedRight = 0;
    const badges = [...document.querySelectorAll("span")].filter(
      (s) => (s.textContent || "").trim() === "개설 필요" || (s.textContent || "").trim() === "개설 완료",
    );
    for (const lead of spans) {
      const lr = lead.getBoundingClientRect();
      // 같은 카드 내 상태 배지보다 오른쪽이면 우측 정렬로 간주(같은 줄 또는 두 번째 줄 우측).
      const card = lead.closest("div");
      void card;
      for (const b of badges) {
        const br = b.getBoundingClientRect();
        if (Math.abs(br.top - lr.top) < 80 && lr.right >= br.right) {
          alignedRight++;
          break;
        }
      }
    }
    return { count: spans.length, sample: spans[0]?.textContent?.trim() ?? "", alignedRight };
  });
  check("[팀장] 각 팀 카드에 팀장 표시(이름+학적 또는 '팀장 정보 없음')",
    leaderInfo.count >= 5, `표시=${leaderInfo.count} 예='${leaderInfo.sample}'`);
  check("[팀장] 팀장 표시가 헤더 우측 영역(상태 배지 우측)",
    leaderInfo.alignedRight >= 5, `우측정렬=${leaderInfo.alignedRight}/${leaderInfo.count}`);

  // [req1] 팀명 + 개설 상태가 같은 행(같은 top 좌표) — 팀 카드 헤더 첫 줄.
  const headerRow = await page.evaluate(() => {
    const badges = [...document.querySelectorAll("span")].filter((s) => {
      const t = (s.textContent || "").trim();
      return t === "개설 필요" || t === "개설 완료";
    });
    let checked = 0, good = 0;
    for (const b of badges) {
      const prev = b.previousElementSibling; // CardTitle(팀명)
      if (!prev) continue; // 요약 카운트 badge 등은 형제 title 없음 → 스킵
      checked++;
      const a = prev.getBoundingClientRect();
      const c = b.getBoundingClientRect();
      if (Math.abs(a.top - c.top) < 24) good++;
    }
    return { checked, good };
  });
  check("[req1] 팀명+개설 상태 같은 행(team 카드 헤더)",
    headerRow.checked > 0 && headerRow.good === headerRow.checked,
    `team cards=${headerRow.checked} aligned=${headerRow.good}`);

  // [req-dropdown] 주차 드롭다운 존재 + 옵션 다수 + 선택 변경 시 재조회.
  const weekSelect = page.getByLabel("주차 선택");
  await weekSelect.waitFor({ timeout: 15000 });
  const optionValues = await weekSelect.evaluate((el) =>
    [...el.options].map((o) => ({ value: o.value, text: o.textContent.trim() })),
  );
  check("[req-dropdown] 주차 드롭다운 렌더 + 옵션 다수", optionValues.length >= 2, `옵션=${optionValues.length}`);
  check("[req-dropdown] 옵션 라벨 'NN년, ○○ 시즌, N주차' 형태",
    optionValues.every((o) => /\d{2}년,\s*.+시즌,\s*\d+주차/.test(o.text)),
    optionValues.map((o) => o.text).join(" | "));

  const beforeVal = await weekSelect.inputValue();
  const beforeCounts = (await page.evaluate("document.body.innerText")).match(/팀 수\s*\d+[\s\S]*?개설 필요\s*\d+/)?.[0] ?? "";
  const beforeGets = lineManageGets;
  // 현재 선택과 다른 옵션으로 변경.
  const target = optionValues.find((o) => o.value !== beforeVal);
  check("[req-dropdown] 다른 주차 옵션 존재", !!target, target?.text ?? "");
  if (target) {
    await weekSelect.selectOption(target.value);
    // 재조회(week_id 반영) 대기 — line-manage 요청 카운터 증가까지.
    await page.waitForTimeout(1500);
    check("[req-dropdown] 주차 변경 → line-manage 재조회 발생", lineManageGets > beforeGets, `before=${beforeGets} after=${lineManageGets}`);
    check("[req-dropdown] 재조회 요청에 선택 week_id 반영", lastWeekIdParam === target.value, `week_id=${lastWeekIdParam}`);
    const afterVal = await weekSelect.inputValue();
    check("[req-dropdown] 드롭다운 선택값 갱신", afterVal === target.value);
    // 보드가 갱신된 주차 라벨로 다시 렌더(설명/카드 유지).
    const afterBody = await page.evaluate("document.body.innerText");
    check("[req-dropdown] 갱신 후 보드 정상 렌더(팀 수 + 라인 문장형 + 인원 요약)",
      afterBody.includes("팀 수") && /<도출>\s*:\s*전체/.test(afterBody) && /전체\s*\d+명/.test(afterBody));
    void beforeCounts;
  }

  await page.screenshot({ path: resolve(adminRoot, "claudedocs", "browser-line-manage.png"), fullPage: true });
  console.log("  screenshot → claudedocs/browser-line-manage.png");
} catch (e) {
  console.error("browser error:", e?.stack ?? e?.message ?? e);
  fail++;
  try { await page.screenshot({ path: resolve(adminRoot, "claudedocs", "browser-line-manage-error.png"), fullPage: true }); } catch {}
} finally {
  await browser.close();
}

console.log(`\n결과: ${pass} pass / ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
