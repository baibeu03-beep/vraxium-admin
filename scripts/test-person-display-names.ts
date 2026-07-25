import assert from "node:assert/strict";
import {
  romanizeKoreanPersonName,
  resolvePersonDisplayNames,
} from "@/lib/koreanRomanization";

const examples: Record<string, string> = {
  김민서: "Kim Minseo",
  이준호: "Lee Junho",
  박서연: "Park Seoyeon",
  최윤서: "Choi Yunseo",
  정유진: "Jeong Yujin",
  남궁민: "Namgung Min",
  황보라: "Hwangbo Ra",
};

for (const [korean, english] of Object.entries(examples)) {
  assert.equal(romanizeKoreanPersonName(korean), english);
}

for (const invalid of [
  null,
  undefined,
  "",
  " ",
  "김",
  "123",
  "Kim",
  "김민서1",
  "T김민서",
  "김 민서",
]) {
  assert.equal(romanizeKoreanPersonName(invalid), "");
}

assert.deepEqual(resolvePersonDisplayNames("김민서"), {
  displayName: "김민서",
  englishName: "Kim Minseo",
});
assert.deepEqual(resolvePersonDisplayNames("T박유진", { isTestUser: true }), {
  displayName: "T박유진",
  englishName: "Park Yujin",
});
assert.deepEqual(resolvePersonDisplayNames("T김민서", { isTestUser: true }), {
  displayName: "T김민서",
  englishName: "Kim Minseo",
});
assert.deepEqual(resolvePersonDisplayNames("T남궁민", { isTestUser: true }), {
  displayName: "T남궁민",
  englishName: "Namgung Min",
});
assert.deepEqual(resolvePersonDisplayNames("T김민서"), {
  displayName: "T김민서",
  englishName: "",
});
assert.deepEqual(resolvePersonDisplayNames(null), {
  displayName: null,
  englishName: "",
});
assert.notEqual(
  resolvePersonDisplayNames("김민서").englishName,
  resolvePersonDisplayNames("김민수").englishName,
);

console.log("person display-name tests passed");
