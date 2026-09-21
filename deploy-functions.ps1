# 部署 LINE 提醒的 Cloud Function。
# 專案放在 Google Drive 同步資料夾，npm install 會失敗（EBADF）且 node_modules 不該被同步，
# 所以先複製到本機暫存目錄，在那裡安裝套件並部署。
$ErrorActionPreference = 'Stop'
$src = $PSScriptRoot
$tmp = Join-Path $env:TEMP '43note-fn'
if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }
New-Item -ItemType Directory $tmp | Out-Null
Copy-Item (Join-Path $src 'functions') (Join-Path $tmp 'functions') -Recurse
Copy-Item (Join-Path $src 'firebase.json'), (Join-Path $src '.firebaserc') $tmp
Push-Location (Join-Path $tmp 'functions'); npm install --no-audit --no-fund; Pop-Location
Push-Location $tmp; firebase deploy --only functions; Pop-Location
