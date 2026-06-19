// pm2 상시 구동 설정 (크롤러 PC) — 부팅 자동 + 크래시 자동재시작.
//   사용:  pm2 start crawler/ecosystem.config.cjs
//          pm2 save && pm2 startup
//   ※ root 의 `npm run crawler`(tsx --env-file=.env.local crawler/server.mjs)를 감싼다 —
//     tsx 인터프리터 경로/플랫폼 차이를 npm 스크립트로 흡수(Windows 미니PC 포함 호환).
//   Windows 서비스로 등록하려면 pm2 대신 NSSM 으로 동일 명령을 등록해도 된다.

// Windows(미니PC)에서는 PM2 가 `npm`(NPM.CMD)을 node 스크립트로 파싱해 깨진다
//   (SyntaxError: Unexpected token ':'). 그래서 Windows 에서는 `npm run crawler` 가
//   실제로 실행하는 명령 — tsx CLI 를 node 로 직접 구동 — 을 그대로 사용한다.
//   Linux(droplet)는 기존 npm 래핑을 유지(블라스트 반경 최소화).
const path = require("path");
const isWin = process.platform === "win32";

module.exports = {
  apps: [
    {
      name: "cafe-crawler",
      script: isWin
        ? path.join(__dirname, "..", "node_modules", "tsx", "dist", "cli.mjs")
        : "npm",
      args: isWin ? "--env-file=.env.local crawler/server.ts" : "run crawler",
      interpreter: isWin ? "node" : undefined,
      cwd: __dirname + "/..",
      autorestart: true,
      max_restarts: 10,
      time: true,
    },
  ],
};
