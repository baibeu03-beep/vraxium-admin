// 임시 브리지: cloudflared 터널을 pm2로 상시 구동 (관리자 Windows 서비스 설치 전까지).
//   Windows 서비스로 등록하면 이 pm2 앱(cf-tunnel)은 제거한다(중복 커넥터 방지).
//   pm2 start crawler/tunnel.config.cjs
module.exports = {
  apps: [
    {
      name: "cf-tunnel",
      script: "C:\\Program Files (x86)\\cloudflared\\cloudflared.exe",
      args: ["tunnel", "run", "cafe-crawler"],
      interpreter: "none",
      autorestart: true,
      max_restarts: 20,
      time: true,
    },
  ],
};
