# ─────────────────────────────────────────────────────────────────────────────
# 운영 PC 자동 시작 설치 (관리자 권한 1회 실행) — crawler PC 이전용.
#   등록 대상(부팅 자동 · 로그인 불필요):
#     1) cloudflared        → Windows 서비스(토큰 기반, crawler.vraxium.store 터널)
#     2) Vraxium Crawler    → 작업 스케줄러 ONSTART(SYSTEM) · svc-crawler.bat (:8787)
#     3) Vraxium Process Check Worker → 작업 스케줄러 ONSTART(SYSTEM) · svc-worker.bat
#   로그: C:\ProgramData\vraxium\logs\{cloudflared,crawler,worker}.log
#
#   실행:  PowerShell 을 "관리자 권한으로 실행" 후
#     powershell -ExecutionPolicy Bypass -File .\scripts\win\install-worker-pc-autostart.ps1
#
#   토큰: 기본적으로 C:\Users\ynale\.cloudflared\service-token.txt 에서 읽음(-CloudflaredToken 로 override).
#   ⚠ 토큰/시크릿 "값"은 출력하지 않는다(존재 여부만).
# ─────────────────────────────────────────────────────────────────────────────
param(
  [string]$CloudflaredToken = "",
  [string]$Cloudflared = "C:\Users\ynale\AppData\Local\Microsoft\WinGet\Packages\Cloudflare.cloudflared_Microsoft.Winget.Source_8wekyb3d8bbwe\cloudflared.exe",
  [string]$Repo = "",
  [string]$LogDir = "C:\ProgramData\vraxium\logs",
  [switch]$SkipCloudflared
)
$ErrorActionPreference = "Stop"

function Assert-Admin {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  if (-not ([Security.Principal.WindowsPrincipal]$id).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw "관리자 권한이 아닙니다. PowerShell 을 '관리자 권한으로 실행' 후 다시 시도하세요."
  }
}
Assert-Admin

if (-not $Repo) { $Repo = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path }
$crawlerBat = Join-Path $Repo "scripts\win\svc-crawler.bat"
$workerBat  = Join-Path $Repo "scripts\win\svc-worker.bat"
foreach ($f in @($crawlerBat, $workerBat)) { if (-not (Test-Path $f)) { throw "필수 래퍼 없음: $f" } }
if (-not (Test-Path $Cloudflared)) { throw "cloudflared.exe 없음: $Cloudflared" }

# 토큰 해소 (param → 파일). 값은 출력하지 않는다.
$tokenFile = "C:\Users\ynale\.cloudflared\service-token.txt"
if (-not $CloudflaredToken -and (Test-Path $tokenFile)) { $CloudflaredToken = (Get-Content $tokenFile -Raw).Trim() }
if (-not $SkipCloudflared -and [string]::IsNullOrWhiteSpace($CloudflaredToken)) {
  throw "cloudflared 토큰 없음. -CloudflaredToken '<토큰>' 을 주거나 $tokenFile 에 저장하세요."
}
Write-Host "[setup] repo=$Repo"
Write-Host "[setup] logdir=$LogDir  (cloudflared 토큰: 확인됨)"
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
try { Start-Transcript -Path (Join-Path $LogDir "install.log") -Append | Out-Null } catch {}

# ── 1) cloudflared Windows 서비스 ─────────────────────────────────────────────
if (-not $SkipCloudflared) {
Write-Host "[setup] cloudflared 서비스 설치..."
# ⚠ cloudflared/sc.exe 는 정보 로그를 stderr 로 낸다. PS5.1 에서 EAP=Stop + 네이티브 stderr
#    (특히 2>$null 리다이렉션)는 스크립트를 강제 중단시킨다. 네이티브 구간만 Continue 로 격리.
$prevEAP = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
try {
  Get-Process cloudflared -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  if (Get-Service Cloudflared -ErrorAction SilentlyContinue) {
    Write-Host "[setup] 기존 Cloudflared 서비스 제거..."
    & $Cloudflared service uninstall | Out-Host
    # SCM pending-delete 해소 대기(핸들 닫힐 때까지 서비스가 남아있을 수 있음).
    for ($i = 0; $i -lt 40; $i++) { if (-not (Get-Service Cloudflared -ErrorAction SilentlyContinue)) { break }; Start-Sleep -Milliseconds 500 }
  }
  & $Cloudflared service install $CloudflaredToken | Out-Host
  Start-Sleep -Seconds 2

  # 로그 파일 활성화 — ImagePath 에 전역 플래그 삽입(best-effort, 실패해도 서비스는 정상).
  try {
    $reg = 'HKLM:\SYSTEM\CurrentControlSet\Services\Cloudflared'
    $img = (Get-ItemProperty $reg -Name ImagePath).ImagePath
    if ($img -and $img -notmatch '--logfile') {
      $flags = '--no-autoupdate --loglevel info --logfile "{0}\cloudflared.log"' -f $LogDir
      $img2  = [regex]::Replace($img, '\s+tunnel\b', " $flags tunnel", 1)
      Set-ItemProperty $reg -Name ImagePath -Value $img2
      Write-Host "[setup] cloudflared 로그파일 설정: $LogDir\cloudflared.log"
    }
  } catch { Write-Warning "[setup] cloudflared 로그파일 설정 스킵(서비스는 정상): $_" }

  # 서비스 복구(크래시 자동 재시작) + 자동 시작 + 기동.
  & sc.exe failure Cloudflared reset= 86400 actions= restart/5000/restart/5000/restart/5000 | Out-Host
  & sc.exe config Cloudflared start= auto | Out-Host
  Restart-Service Cloudflared -ErrorAction SilentlyContinue
  if ((Get-Service Cloudflared -ErrorAction SilentlyContinue).Status -ne 'Running') { Start-Service Cloudflared -ErrorAction SilentlyContinue }
} finally { $ErrorActionPreference = $prevEAP }
Write-Host "[setup] Cloudflared 서비스 상태: $((Get-Service Cloudflared -ErrorAction SilentlyContinue).Status)"
} else { Write-Host "[setup] -SkipCloudflared: cloudflared 단계 건너뜀 (상태: $((Get-Service Cloudflared -ErrorAction SilentlyContinue).Status))" }

# ── 2·3) crawler / worker 작업 스케줄러 ONSTART ───────────────────────────────
$trigger  = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
  -MultipleInstances IgnoreNew -StartWhenAvailable

function Remove-TaskIfExists([string]$Name) {
  if (Get-ScheduledTask -TaskName $Name -ErrorAction SilentlyContinue) {
    Stop-ScheduledTask -TaskName $Name -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $Name -Confirm:$false
  }
}

# 이전 설치/포그라운드가 남긴 좀비 정리: svc-*.bat 을 도는 cmd, 그 지연용 PING, :8787 점유 프로세스.
Remove-TaskIfExists "Vraxium Crawler"
Remove-TaskIfExists "Vraxium Process Check Worker"
Get-CimInstance Win32_Process -Filter "Name='cmd.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -match 'svc-crawler\.bat|svc-worker\.bat' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Get-Process PING -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
$p8787 = (Get-NetTCPConnection -LocalPort 8787 -State Listen -ErrorAction SilentlyContinue).OwningProcess
if ($p8787) { Stop-Process -Id $p8787 -Force -ErrorAction SilentlyContinue; Start-Sleep -Seconds 1 }

# crawler·worker 공통: 세션 시드 사용자(ynale)로 '로그온 시' 인터랙티브 실행(비밀번호 불요).
#   crawler 는 DPAPI 쿠키 복호화 때문에 필수. worker 도 동일 계정/트리거로 통일(요청).
$me = "$env:USERDOMAIN\$env:USERNAME"
$logonTrigger  = New-ScheduledTaskTrigger -AtLogOn -User $me
$userPrincipal = New-ScheduledTaskPrincipal -UserId $me -LogonType Interactive -RunLevel Highest

$workerAction = New-ScheduledTaskAction -Execute "cmd.exe" -Argument "/c `"$workerBat`"" -WorkingDirectory $Repo
Register-ScheduledTask -TaskName "Vraxium Process Check Worker" -Action $workerAction -Trigger $logonTrigger -Principal $userPrincipal -Settings $settings | Out-Null
Write-Host "[setup] 작업 등록: Vraxium Process Check Worker ($me, 로그온 시 실행)"

# crawler: .naver-profile 쿠키가 DPAPI(프로필 생성 사용자)로 암호화 → SYSTEM/S4U 는 복호화 불가(session=expired).
#   이 PC 는 PIN/Hello 로그인이라 계정 비밀번호 미보유 → '로그온 무관 실행'(비밀번호 저장) 불가.
#   차선: 'ynale 로그온 시' 인터랙티브 실행(비밀번호 불요, DPAPI 정상). 부팅 후 PIN 1회 로그인하면 자동 기동.
#   ($me / $logonTrigger / $userPrincipal 는 worker 섹션에서 정의됨 — 동일 계정/트리거 재사용)
$crawlerAction = New-ScheduledTaskAction -Execute "cmd.exe" -Argument "/c `"$crawlerBat`"" -WorkingDirectory $Repo
try {
  Register-ScheduledTask -TaskName "Vraxium Crawler" -Action $crawlerAction -Trigger $logonTrigger -Principal $userPrincipal -Settings $settings -ErrorAction Stop | Out-Null
  Write-Host "[setup] 작업 등록: Vraxium Crawler ($me, 로그온 시 실행)"
} catch {
  Write-Warning "[setup] Vraxium Crawler 등록 실패: $($_.Exception.Message)"
}

# 지금 즉시 시작(부팅 전 검증용).
Start-ScheduledTask -TaskName "Vraxium Crawler" -ErrorAction SilentlyContinue
Start-ScheduledTask -TaskName "Vraxium Process Check Worker" -ErrorAction SilentlyContinue
Start-Sleep -Seconds 12

# ── 요약 ──────────────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "== 설치 완료 요약 =="
Write-Host ("  Cloudflared 서비스 : {0}" -f (Get-Service Cloudflared).Status)
foreach ($n in @("Vraxium Crawler","Vraxium Process Check Worker")) {
  $t = Get-ScheduledTask -TaskName $n -ErrorAction SilentlyContinue
  $i = Get-ScheduledTaskInfo -TaskName $n -ErrorAction SilentlyContinue
  Write-Host ("  작업 {0} : State={1} LastRun={2} LastResult={3}" -f $n, $t.State, $i.LastRunTime, $i.LastTaskResult)
}
$l = Get-NetTCPConnection -LocalPort 8787 -State Listen -ErrorAction SilentlyContinue
Write-Host ("  :8787 listen : {0}" -f ([bool]$l))
Write-Host "  로그: $LogDir\{cloudflared,crawler,worker}.log"
Write-Host ""
Write-Host "다음: crawler.vraxium.store/health 200 확인 후 PC 재부팅 → 자동 실행 재검증."
