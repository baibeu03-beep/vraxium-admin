import { chromium, type Page, type BrowserContext } from "playwright-core";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

// /admin/line-opening/practical-competency — "[실무 역량] Hub" 제목 + 붙어있던 도움말(돋보기) 제거 검증.
//   실제 HTTP(라이브 서버 + 브라우저 렌더) 기준으로, mode/org 분기 없이 동일하게 사라졌는지 확인한다.
//   확인:
//     1) 제목 텍스트가 어떤 노드에도 없음 + title="[실무 역량] Hub" 도움말 버튼 없음
//     2) 보드 본체(현재 상황 / 주차 드롭다운 / 집계 카드)는 그대로 렌더 — 과잉 삭제 아님
//     3) 보드 첫 요소 위에 남은 상단 여백 없음(제거된 h1 자리가 빈 공간으로 남지 않음)
//     4) 위 1~3 이 일반/mode=test/actAsTestUserId/demoUserId × 여러 org 에서 동일

const baseUrl = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

const PATH = "/admin/line-opening/practical-competency";
const TITLE = "[실무 역량] Hub";
const ORGS = (process.env.LO_ORGS ?? "phalanx,olympus,encre").split(",");

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function makeAdminCookies() {
  const { data: admins, error: adminError } = await supabaseAdmin
    .from("admin_users")
    .select("email")
    .eq("is_active", true)
    .not("email", "is", null)
    .limit(1);
  if (adminError) throw adminError;
  const email = (admins?.[0] as { email: string } | undefined)?.email;
  assert(email, "No active admin email");

  const admin = createClient(supabaseUrl, serviceKey);
  const anon = createClient(supabaseUrl, anonKey);
  const { data: link, error: linkError } = await admin.auth.admin.generateLink({
    type: "magiclink",
    email,
  });
  assert(
    link.properties?.email_otp && !linkError,
    linkError?.message ?? "generateLink failed",
  );
  const { data: verified, error: verifyError } = await anon.auth.verifyOtp({
    email,
    token: link.properties.email_otp,
    type: "magiclink",
  });
  assert(
    verified.session && !verifyError,
    verifyError?.message ?? "verifyOtp failed",
  );
  const captured: Array<{ name: string; value: string }> = [];
  const server = createServerClient(supabaseUrl, anonKey, {
    cookies: {
      getAll: () => [],
      setAll: (items) =>
        captured.push(...items.map(({ name, value }) => ({ name, value }))),
    },
  });
  await server.auth.setSession({
    access_token: verified.session.access_token,
    refresh_token: verified.session.refresh_token,
  });
  return captured.map(({ name, value }) => ({
    name,
    value,
    domain: "localhost",
    path: "/",
    httpOnly: false,
    secure: false,
    sameSite: "Lax" as const,
  }));
}

// 임의의 테스트 유저 id — actAsTestUserId / demoUserId 변형 URL 용.
async function pickTestUserId(): Promise<string | null> {
  const { data } = await supabaseAdmin
    .from("test_user_markers")
    .select("user_id")
    .limit(1);
  return (data?.[0] as { user_id: string } | undefined)?.user_id ?? null;
}

type Variant = { key: string; url: string; label: string };

type Probe = {
  titleNodes: number;
  helpButtons: number;
  totalHelpButtons: number;
  htmlHits: number;
  hasSituation: boolean;
  hasWeekPicker: boolean;
  boardTopGap: number | null;
};

async function probe(page: Page): Promise<Probe> {
  return page.evaluate((title) => {
    // 1) 제목 텍스트를 가진 노드(어떤 태그든) — 자식 텍스트 직접 보유한 것만 카운트.
    const all = Array.from(document.querySelectorAll("body *"));
    // 제목 텍스트를 "직접" 보유한 노드 = 제목 요소 자신(조상은 textContent 로 물려받으므로 제외).
    const ownsTitle = all.filter((el) => {
      const own = Array.from(el.childNodes)
        .filter((n) => n.nodeType === Node.TEXT_NODE)
        .map((n) => n.textContent ?? "")
        .join("");
      return own.includes(title);
    });
    const titleNodes = ownsTitle.length;

    // 2) 제목에 붙어있던 도움말(돋보기) 버튼.
    //    AdminHelpIconButton 의 `title` prop 은 모달 헤더용이라 DOM 속성으로 나오지 않는다 —
    //    버튼 식별은 aria-label("이 항목 도움말") 로 하고, "제목에 붙은 것"은 제목 노드의
    //    자손인지로 판정한다. (title 속성으로 찾으면 항상 0 = 무의미한 통과)
    const HELP_SEL = 'button[aria-label="이 항목 도움말"]';
    const totalHelpButtons = document.querySelectorAll(HELP_SEL).length;
    const helpButtons = ownsTitle.reduce(
      (sum, el) => sum + el.querySelectorAll(HELP_SEL).length,
      0,
    );

    // 3) 직렬화된 DOM 전체에서의 문자열 잔존(스크립트 페이로드 제외한 렌더 결과).
    const htmlHits = (document.body.innerHTML.match(/\[실무 역량\] Hub/g) ?? [])
      .length;

    // 4) 보드 본체가 살아있는지 — 과잉 삭제 감지.
    const text = document.body.innerText ?? "";
    const hasSituation = text.includes("오늘") || text.includes("개설 이행");
    const hasWeekPicker =
      document.querySelector('button[aria-label="주차 선택"]') != null;

    // 5) 제거된 h1 자리에 상단 여백이 남지 않았는지 —
    //    보드 첫 자식의 top 이 보드 컨테이너 top 과 (경계 오차 내) 일치해야 한다.
    let boardTopGap: number | null = null;
    const picker = document.querySelector('button[aria-label="주차 선택"]');
    const board = picker?.closest("div.space-y-4");
    const first = board?.firstElementChild;
    if (board && first) {
      boardTopGap =
        first.getBoundingClientRect().top - board.getBoundingClientRect().top;
    }

    return {
      titleNodes,
      helpButtons,
      totalHelpButtons,
      htmlHits,
      hasSituation,
      hasWeekPicker,
      boardTopGap,
    };
  }, TITLE);
}

async function visit(page: Page, v: Variant): Promise<Probe> {
  console.log(`\n── ${v.label}  [${v.url}]`);
  const res = await page.goto(`${baseUrl}${v.url}`, {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });
  const status = res?.status() ?? 0;
  console.log(`  HTTP ${status}`);
  assert(status === 200, `${v.key}: HTTP ${status} (200 아님)`);

  // Next dev 최초 컴파일 + 클라이언트 데이터 로드 흡수 — 보드 안정 요소 등장까지 대기.
  await page
    .waitForFunction(
      () =>
        document.querySelector('button[aria-label="주차 선택"]') != null ||
        document.querySelectorAll('button[aria-label="이 항목 도움말"]').length >
          0,
      { timeout: 30_000 },
    )
    .catch(() => console.log("  (보드 안정 요소 미등장 — 로딩 지연/빈 데이터)"));
  await page.waitForTimeout(1200);

  const p = await probe(page);
  console.log(
    `  제목 노드=${p.titleNodes} · 제목에 붙은 도움말=${p.helpButtons} · 페이지 전체 도움말=${p.totalHelpButtons} · innerHTML 잔존=${p.htmlHits}`,
  );
  console.log(
    `  보드 생존: 현재상황=${p.hasSituation} 주차드롭다운=${p.hasWeekPicker} · 보드 상단 여백=${
      p.boardTopGap === null ? "n/a" : `${p.boardTopGap.toFixed(1)}px`
    }`,
  );

  assert(p.titleNodes === 0, `${v.key}: "${TITLE}" 제목 노드 ${p.titleNodes}개 잔존`);
  assert(p.helpButtons === 0, `${v.key}: 제목 도움말 버튼 ${p.helpButtons}개 잔존`);
  assert(p.htmlHits === 0, `${v.key}: innerHTML 에 "${TITLE}" ${p.htmlHits}회 잔존`);
  if (p.boardTopGap !== null) {
    assert(
      Math.abs(p.boardTopGap) <= 1,
      `${v.key}: 보드 상단에 여백 ${p.boardTopGap}px 잔존(제거된 제목 자리)`,
    );
  }
  console.log("  PASS");
  return p;
}

async function main() {
  const testUserId = await pickTestUserId();
  const browser = await chromium.launch({ headless: true });
  const context: BrowserContext = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  });
  await context.addCookies(await makeAdminCookies());
  const page = await context.newPage();

  const variants: Variant[] = [];
  for (const org of ORGS) {
    variants.push({
      key: `${org}-normal`,
      url: `${PATH}?org=${org}`,
      label: `${org} · 일반`,
    });
    variants.push({
      key: `${org}-test`,
      url: `${PATH}?org=${org}&mode=test`,
      label: `${org} · mode=test`,
    });
  }
  // org 미지정(비 org-scoped) 경로 — 보드 자체가 렌더되지 않지만 제목도 없어야 한다.
  variants.push({ key: "no-org", url: PATH, label: "org 미지정 · 일반" });
  variants.push({
    key: "no-org-test",
    url: `${PATH}?mode=test`,
    label: "org 미지정 · mode=test",
  });
  if (testUserId) {
    variants.push({
      key: "act-as",
      url: `${PATH}?org=${ORGS[0]}&actAsTestUserId=${testUserId}`,
      label: `${ORGS[0]} · actAsTestUserId`,
    });
    variants.push({
      key: "demo",
      url: `${PATH}?org=${ORGS[0]}&demoUserId=${testUserId}`,
      label: `${ORGS[0]} · demoUserId`,
    });
  } else {
    console.log("  (test_user_markers 비어있음 — actAsTestUserId/demoUserId 변형 스킵)");
  }

  let fail = 0;
  const boardSeen: string[] = [];
  try {
    for (const v of variants) {
      try {
        const p = await visit(page, v);
        if (p.hasWeekPicker) boardSeen.push(v.key);
      } catch (e) {
        fail++;
        console.log(`  FAIL ${v.key}: ${(e as Error).message}`);
      }
    }
  } finally {
    await browser.close();
  }

  console.log(`\n══ 요약 ══`);
  console.log(`변형 ${variants.length}개 · 실패 ${fail}개`);
  console.log(
    `보드 실렌더 확인된 변형(과잉 삭제 아님 근거): ${
      boardSeen.length ? boardSeen.join(", ") : "없음 ⚠"
    }`,
  );
  assert(
    boardSeen.length > 0,
    "어떤 변형에서도 보드가 렌더되지 않음 — 제목 부재가 '화면 자체 미렌더' 때문일 수 있어 검증 무효",
  );
  if (fail > 0) process.exit(1);
  console.log("ALL PASS — 제목/도움말 제거, 보드 본체·여백 정상");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
