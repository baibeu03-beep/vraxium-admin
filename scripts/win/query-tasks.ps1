$ErrorActionPreference="SilentlyContinue"
$o=@("=== tasks @ "+(Get-Date -Format o)+" ===")
foreach($n in @("Vraxium Crawler","Vraxium Process Check Worker")){
  $t=Get-ScheduledTask -TaskName $n; $i=Get-ScheduledTaskInfo -TaskName $n
  $trg=(($t.Triggers|ForEach-Object{$_.CimClass.CimClassName}) -join ",")
  $o+="[$n] State="+$t.State+" Trigger="+$trg+" RunAs="+$t.Principal.UserId+" Logon="+$t.Principal.LogonType+" Run="+$t.Settings.RestartCount+" LastRun="+$i.LastRunTime+" Result=0x"+("{0:X}" -f $i.LastTaskResult)
}
$o | Set-Content -Path "C:\ProgramData\vraxium\logs\tasks.log" -Encoding UTF8
