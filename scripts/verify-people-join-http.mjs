// 이슈4/5 검증 — legacy(/api/weekly-reputations, /api/weekly-colleagues, /api/crews) vs
// snapshot DTO(/api/cluster4/weekly-cards) 인적사항 조인 일치 비교 (demoUserId 모드)
//   node scripts/verify-people-join-http.mjs [base]
const BASE = process.argv[2] || "http://localhost:3001";
const UID = "bf3b4305-751a-49e3-88ad-95a20e5c4dad"; // T윤도현
const W13 = "a2112b50-64d2-42d6-a243-faf9fcdc6ffc";

const j = async (p) => {
  const res = await fetch(`${BASE}${p}`);
  return { status: res.status, json: await res.json().catch(() => null) };
};

// 1) snapshot DTO (weekly-cards)
const dto = await j(`/api/cluster4/weekly-cards/?userId=${UID}&demoUserId=${UID}`);
const w13card = (dto.json?.data ?? []).find((c) => c.weekId === W13);
const dtoRep = (w13card?.weeklyReputations ?? [])[0];
const dtoCols = w13card?.weeklyColleagues ?? [];
console.log("=== DTO(weekly-cards) W13 ===");
console.log("rep.fromProfile:", JSON.stringify({
  name: dtoRep?.fromProfile?.name, team: dtoRep?.fromProfile?.team, part: dtoRep?.fromProfile?.part,
  school: dtoRep?.fromProfile?.school, dept: dtoRep?.fromProfile?.department,
  img: dtoRep?.fromProfile?.profileImageUrl?.slice(-30), tagline: dtoRep?.fromProfile?.profileTagline,
}));
for (const c of dtoCols) console.log("colleague:", JSON.stringify({
  name: c.colleagueProfile?.name, team: c.colleagueProfile?.team, part: c.colleagueProfile?.part,
  school: c.colleagueProfile?.school, dept: c.colleagueProfile?.department,
  img: c.colleagueProfile?.profileImageUrl?.slice(-30), tagline: c.colleagueProfile?.profileTagline,
}));

// 2) legacy weekly-reputations
const rep = await j(`/api/weekly-reputations/?targetUserId=${UID}&weekCardId=${W13}&demoUserId=${UID}`);
console.log("\n=== legacy /api/weekly-reputations ===", rep.status);
for (const r of rep.json?.data ?? []) console.log("reviewer:", JSON.stringify({
  name: r.reviewer?.display_name, team: r.reviewer?.teamName, part: r.reviewer?.partName,
  school: r.reviewer?.university, dept: r.reviewer?.major_first,
  img: r.reviewer?.profile_photo_url?.slice(-30), tagline: r.reviewer?.profileTagline,
}));

// 3) legacy weekly-colleagues
const col = await j(`/api/weekly-colleagues/?userId=${UID}&weekCardId=${W13}&demoUserId=${UID}`);
console.log("\n=== legacy /api/weekly-colleagues ===", col.status);
for (const d of col.json?.data ?? []) console.log("colleague:", JSON.stringify({
  name: d.colleague?.name, team: d.colleague?.team, part: d.colleague?.part,
  school: d.colleague?.university, dept: d.colleague?.major,
  img: d.colleague?.profileImg?.slice(-30), nickname: d.colleague?.nickname,
}));

// 4) /api/crews — 이유나/T이수아 후보 필드 (연계동료 모달 후보 미리보기)
const crews = await j(`/api/crews/?excludeUserId=${UID}`);
console.log("\n=== /api/crews ===", crews.status);
for (const name of ["이유나", "T이수아"]) {
  const row = (crews.json?.data ?? []).find((c) => c.name === name);
  console.log(name, ":", JSON.stringify(row ? {
    team: row.team, part: row.part, school: row.university, dept: row.major,
    nickname: row.nickname, profileTagline: row.profileTagline, level: row.membershipLevel,
    img: row.profileImg?.slice(-30),
  } : null));
}

// 5) 일치 판정 (rep reviewer / colleague 1·2 — DTO vs legacy)
console.log("\n=== 일치 판정 ===");
const eq = (a, b) => (a ?? null) === (b ?? null);
if (dtoRep && rep.json?.data?.[0]) {
  const L = rep.json.data[0].reviewer ?? {};
  const F = dtoRep.fromProfile ?? {};
  console.log("평판 reviewer 일치:", {
    name: eq(F.name, L.display_name), team: eq(F.team, L.teamName), part: eq(F.part, L.partName),
    school: eq(F.school, L.university), dept: eq(F.department, L.major_first),
    img: eq(F.profileImageUrl, L.profile_photo_url), tagline: eq(F.profileTagline, L.profileTagline),
  });
}
for (let i = 0; i < dtoCols.length; i++) {
  const F = dtoCols[i]?.colleagueProfile ?? {};
  const L = (col.json?.data ?? [])[i]?.colleague ?? {};
  console.log(`동료${i + 1} 일치:`, {
    name: eq(F.name, L.name), team: eq(F.team, L.team), part: eq(F.part, L.part),
    school: eq(F.school, L.university), dept: eq(F.department, L.major),
    img: eq(F.profileImageUrl, L.profileImg), tagline: eq(F.profileTagline, L.nickname),
  });
}
