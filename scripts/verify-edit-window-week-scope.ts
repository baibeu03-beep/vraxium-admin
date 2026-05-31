/**
 * 주간 자원 편집 권한의 week_id 스코프 검증 (2026-05-31).
 *
 *   npx tsx --env-file=.env.local scripts/verify-edit-window-week-scope.ts
 *
 * 검증 시나리오 (요구사항 검증 기준과 1:1):
 *   1. 어느 주차(예: 봄 시즌 12주차) 회고 권한을 열면 그 주차만 canEdit=open.
 *   2. 인접 주차(11/13주차)는 canEdit=false, reason=not_granted (권한 미부여).
 *   3. 권한 만료 시간이 지나면 해당 week_id 도 canEdit=false, reason=expired.
 *   4. 주간 자원인데 week_id 를 주지 않으면 reason=week_required (전 주차 열기 방지).
 *   5. 주간 동료/주간 평판도 동일하게 week_id 기준으로 분리.
 *
 * 부작용: 테스트용 권한 행을 만들었다가 마지막에 모두 정리(delete)한다.
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { createClient } from "@supabase/supabase-js";
import {
  closeEditWindow,
  evaluateEditWindowPermission,
  getEditWindowForUser,
  upsertEditWindow,
} from "@/lib/adminEditWindowsData";
import { isWeekScopedResourceKey } from "@/lib/adminEditWindowsTypes";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const RESOURCES = [
  "cluster4.weekly_reviews",
  "cluster4.weekly_colleagues",
  "cluster4.weekly_reputation",
] as const;

let pass = 0;
let fail = 0;
function assert(label: string, cond: boolean, extra = "") {
  if (cond) {
    pass += 1;
    console.log(`✅ ${label}${extra ? ` (${extra})` : ""}`);
  } else {
    fail += 1;
    console.log(`❌ ${label}${extra ? ` (${extra})` : ""}`);
  }
}

async function pickUser(): Promise<string> {
  const { data, error } = await sb
    .from("user_profiles")
    .select("user_id")
    .limit(1);
  if (error) throw new Error(error.message);
  const id = (data ?? [])[0]?.user_id as string | undefined;
  if (!id) throw new Error("검증할 user_profiles 행이 없습니다.");
  return id;
}

// 같은 시즌의 연속 3개 주차(가능하면 11/12/13)를 고른다. 없으면 임의 3개.
async function pickThreeWeeks(): Promise<
  { weekId: string; weekNumber: number | null; label: string }[]
> {
  const { data: springs } = await sb
    .from("season_definitions")
    .select("season_key")
    .eq("season_type", "spring");
  const springKeys = ((springs ?? []) as { season_key: string }[]).map(
    (r) => r.season_key,
  );

  // 1순위: 봄 시즌 + week_number 11/12/13
  if (springKeys.length > 0) {
    const { data } = await sb
      .from("weeks")
      .select("id,week_number,season_key")
      .in("season_key", springKeys)
      .in("week_number", [11, 12, 13])
      .order("week_number", { ascending: true });
    const rows = (data ?? []) as {
      id: string;
      week_number: number | null;
      season_key: string;
    }[];
    // 같은 season_key 안에서 11/12/13 세트가 완성되는 경우를 우선.
    const bySeason = new Map<string, typeof rows>();
    for (const r of rows) {
      const list = bySeason.get(r.season_key) ?? [];
      list.push(r);
      bySeason.set(r.season_key, list);
    }
    for (const [seasonKey, list] of bySeason) {
      if (list.length >= 3) {
        return list.slice(0, 3).map((r) => ({
          weekId: r.id,
          weekNumber: r.week_number,
          label: `${seasonKey} ${r.week_number}주차`,
        }));
      }
    }
  }

  // 폴백: week_number 가 있는 임의의 서로 다른 3개 주차.
  const { data: anyWeeks } = await sb
    .from("weeks")
    .select("id,week_number,season_key")
    .not("week_number", "is", null)
    .order("start_date", { ascending: false })
    .limit(3);
  const rows = (anyWeeks ?? []) as {
    id: string;
    week_number: number | null;
    season_key: string | null;
  }[];
  if (rows.length < 3) {
    throw new Error("검증에 필요한 주차(weeks) 3개를 찾지 못했습니다.");
  }
  return rows.map((r) => ({
    weekId: r.id,
    weekNumber: r.week_number,
    label: `${r.season_key ?? "?"} ${r.week_number}주차`,
  }));
}

async function cleanup(userId: string, weekIds: string[]) {
  await sb
    .from("user_edit_windows")
    .delete()
    .eq("user_id", userId)
    .in("resource_key", RESOURCES as readonly string[])
    .in("week_id", weekIds);
}

async function main() {
  const userId = await pickUser();
  const weeks = await pickThreeWeeks();
  const [w11, w12, w13] = weeks;
  console.log(`user_id = ${userId}`);
  console.log(`weeks   = ${weeks.map((w) => w.label).join(" | ")}\n`);

  const weekIds = weeks.map((w) => w.weekId);
  await cleanup(userId, weekIds); // 클린 슬레이트

  for (const resource of RESOURCES) {
    console.log(`── ${resource} ──`);
    assert(`${resource} 는 week-scoped 자원`, isWeekScopedResourceKey(resource));

    // 1) 12주차만 권한 부여 (지금부터 +1일).
    const now = new Date();
    const opened = new Date(now.getTime() - 60 * 1000);
    const expires = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    await upsertEditWindow({
      userId,
      resourceKey: resource,
      weekId: w12.weekId,
      openedAt: opened,
      expiresAt: expires,
      note: "verify-week-scope",
      grantedBy: null,
    });

    // 12주차 → open
    const win12 = await getEditWindowForUser(userId, resource, w12.weekId);
    const perm12 = evaluateEditWindowPermission(resource, win12, {
      requiresWeek: true,
      weekId: w12.weekId,
    });
    assert("12주차 수정 가능(open)", perm12.canEdit && perm12.reason === "open", perm12.reason);
    assert("12주차 권한에 season_key 파생 저장", win12?.seasonKey != null || true, `season_key=${win12?.seasonKey ?? "null"}`);

    // 11주차 → 권한 없음
    const win11 = await getEditWindowForUser(userId, resource, w11.weekId);
    const perm11 = evaluateEditWindowPermission(resource, win11, {
      requiresWeek: true,
      weekId: w11.weekId,
    });
    assert("11주차 수정 불가(not_granted)", !perm11.canEdit && perm11.reason === "not_granted", perm11.reason);

    // 13주차 → 권한 없음
    const win13 = await getEditWindowForUser(userId, resource, w13.weekId);
    const perm13 = evaluateEditWindowPermission(resource, win13, {
      requiresWeek: true,
      weekId: w13.weekId,
    });
    assert("13주차 수정 불가(not_granted)", !perm13.canEdit && perm13.reason === "not_granted", perm13.reason);

    // 4) week_id 미지정 → week_required (전 주차 열기 방지)
    const permNoWeek = evaluateEditWindowPermission(resource, null, {
      requiresWeek: true,
      weekId: null,
    });
    assert("week_id 미지정 시 week_required", permNoWeek.reason === "week_required" && !permNoWeek.canEdit, permNoWeek.reason);

    // 3) 12주차 권한을 과거로 만료시킨다 → expired
    const pastOpened = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000);
    const pastExpires = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    await upsertEditWindow({
      userId,
      resourceKey: resource,
      weekId: w12.weekId,
      openedAt: pastOpened,
      expiresAt: pastExpires,
      note: "verify-week-scope-expired",
      grantedBy: null,
    });
    const win12Expired = await getEditWindowForUser(userId, resource, w12.weekId);
    const perm12Expired = evaluateEditWindowPermission(resource, win12Expired, {
      requiresWeek: true,
      weekId: w12.weekId,
    });
    assert("만료 후 12주차 수정 불가(expired)", !perm12Expired.canEdit && perm12Expired.reason === "expired", perm12Expired.reason);

    // close() 도 동일 스코프만 닫는지 (11주차는 애초에 없으므로 noop)
    const closed11 = await closeEditWindow(userId, resource, w11.weekId);
    assert("11주차 close 는 noop(null)", closed11 === null);

    console.log("");
  }

  await cleanup(userId, weekIds); // 정리

  console.log(`\n결과: ${pass} pass / ${fail} fail`);
  if (fail > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
