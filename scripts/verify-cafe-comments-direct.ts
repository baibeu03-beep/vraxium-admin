// direct function 검증: collectCafeCommentNicknames 를 직접 호출해 결과 출력.
// 사용법: npx tsx --env-file=.env.local scripts/verify-cafe-comments-direct.ts <게시글URL>
// (계정 정보는 출력하지 않는다 — 결과 카운트/닉네임만 출력)
import { collectCafeCommentNicknames } from "../lib/naverCafeComments";

async function main() {
  const url = process.argv[2];
  if (!url) {
    console.error("게시글 URL 인자가 필요합니다.");
    process.exit(1);
  }

  const result = await collectCafeCommentNicknames(url);
  if (!result.ok) {
    console.log(JSON.stringify({ ok: false, error: result.error, message: result.message }));
    process.exit(1);
  }
  const { data } = result;
  console.log(
    JSON.stringify(
      {
        ok: true,
        totalComments: data.totalComments,
        uniqueNicknames: data.uniqueNicknames,
        nicknameCounts: data.nicknameCounts,
      },
      null,
      2,
    ),
  );
}

main();
