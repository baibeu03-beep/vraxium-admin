// 읽기 전용 조사 — 고객 카드(라이브 생성 vs 저장 snapshot)에 타 조직 라인이 섞이는지 재현.
// 사용법: npx tsx --env-file=.env.local scripts/investigate-line-org-leak.ts
import { createClient } from "@supabase/supabase-js";
import { parseLineCodeOrg, type LineOrgScope } from "../lib/cluster4LineOrg";
import { getCluster4WeeklyCardsForProfileUser } from "../lib/cluster4WeeklyCardsData";
import { readWeeklyCardsSnapshot } from "../lib/cluster4WeeklyCardsSnapshot";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

type Card = { weekId?: string; periodLabel?: string; lines?: Array<{ lineCode?: string | null; mainTitle?: string | null; partType?: string }> };

// userOrg 와 라인 org 가 어긋나는(특정 타org) 라인만 추출.
function crossOrgLines(cards: Card[], userOrg: LineOrgScope | null): Array<{ week?: string; code?: string | null; org: LineOrgScope | null; title?: string | null }> {
  const out: Array<{ week?: string; code?: string | null; org: LineOrgScope | null; title?: string | null }> = [];
  for (const c of cards ?? []) {
    for (const ln of c.lines ?? []) {
      const org = parseLineCodeOrg(ln.lineCode);
      // 특정 타 org(common/null/본인org 제외)면 누수 후보. (null=토큰판정불가는 master org 폴백이라 별도.)
      if (org && org !== "common" && org !== userOrg) {
        out.push({ week: c.weekId, code: ln.lineCode, org, title: ln.mainTitle });
      }
    }
  }
  return out;
}

async function pickUsers(org: string, n: number): Promise<Array<{ id: string; name: string | null }>> {
  const { data } = await supabase
    .from("user_profiles")
    .select("user_id,display_name")
    .eq("organization_slug", org)
    .limit(n);
  return ((data ?? []) as Array<{ user_id: string; display_name: string | null }>).map((r) => ({ id: r.user_id, name: r.display_name }));
}

async function main() {
  const orgs = ["encre", "oranke", "phalanx", "olympus"];
  for (const org of orgs) {
    const users = await pickUsers(org, 3);
    console.log(`\n######## org=${org} (표본 ${users.length}명) ########`);
    for (const u of users) {
      let live: Card[] = [];
      try {
        live = (await getCluster4WeeklyCardsForProfileUser(u.id)) as unknown as Card[];
      } catch (e) {
        console.log(`  [${u.name ?? u.id}] live 생성 실패: ${(e as Error).message}`);
        continue;
      }
      const snap = await readWeeklyCardsSnapshot(u.id).catch(() => null);
      const stored = (snap?.cards ?? null) as Card[] | null;

      const liveCross = crossOrgLines(live, org as LineOrgScope);
      const storedCross = stored ? crossOrgLines(stored, org as LineOrgScope) : [];
      const liveCount = live.reduce((a, c) => a + (c.lines?.length ?? 0), 0);
      const storedCount = (stored ?? []).reduce((a, c) => a + (c.lines?.length ?? 0), 0);
      const diverged = stored != null && (liveCount !== storedCount);

      const flags: string[] = [];
      if (liveCross.length) flags.push(`LIVE 타org ${liveCross.length}`);
      if (storedCross.length) flags.push(`SNAPSHOT 타org ${storedCross.length}`);
      if (diverged) flags.push(`라인수 div live=${liveCount}/snap=${storedCount}`);
      console.log(`  [${u.name ?? u.id}] ${flags.length ? flags.join(" · ") : "정상"}`);
      if (liveCross.length) console.dir(liveCross.slice(0, 6), { depth: null });
      if (storedCross.length) console.dir(storedCross.slice(0, 6), { depth: null });
    }
  }
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
