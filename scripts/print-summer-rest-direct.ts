/** direct getSeasonParticipations(2026-summer, rest) 결과를 JSON 으로 출력(검증 비교용). */
import { getSeasonParticipations } from "@/lib/adminSeasonParticipationsData";
async function main() {
  const dto = await getSeasonParticipations({ seasonKey: "2026-summer", status: "rest", organizationSlug: null, search: null });
  const perOrg: Record<string, number> = {};
  for (const r of dto.rows) perOrg[r.organization_slug ?? "(null)"] = (perOrg[r.organization_slug ?? "(null)"] ?? 0) + 1;
  const names = dto.rows.map((r) => ({ name: r.user_name, org: r.organization_slug, user_id: r.user_id })).sort((a, b) => String(a.user_id).localeCompare(String(b.user_id)));
  process.stdout.write(JSON.stringify({ count: dto.rows.length, rest_count: dto.summary.rest_count, perOrg, names }));
}
main().catch((e) => { console.error(e); process.exit(1); });
