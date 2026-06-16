// pm2 상시 구동 설정 (크롤러 PC) — 부팅 자동 + 크래시 자동재시작.
//   사용:  pm2 start crawler/ecosystem.config.cjs
//          pm2 save && pm2 startup
//   ※ root 의 `npm run crawler`(tsx --env-file=.env.local crawler/server.mjs)를 감싼다 —
//     tsx 인터프리터 경로/플랫폼 차이를 npm 스크립트로 흡수(Windows 미니PC 포함 호환).
//   Windows 서비스로 등록하려면 pm2 대신 NSSM 으로 동일 명령을 등록해도 된다.

module.exports = {
  apps: [
    {
      name: "cafe-crawler",
      script: "npm",
      args: "run crawler",
      cwd: __dirname + "/..",
      autorestart: true,
      max_restarts: 10,
      time: true,
    },
  ],
};
