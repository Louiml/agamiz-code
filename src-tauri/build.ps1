$ErrorActionPreference = 'Continue'
$log = 'D:\AgamizCode\ide-repo\src-tauri\rebuild.log'

function Log($msg) {
    $line = "[{0}] {1}" -f (Get-Date -Format 'HH:mm:ss'), $msg
    $line | Out-File $log -Append -Encoding utf8
}

Log '>>> SCRIPT START'

Set-Location 'D:\AgamizCode\ide-repo\src-tauri'
Log '=== DEBUG cargo build ==='
cargo build 2>&1 | ForEach-Object { Log $_ }
Log '=== DEBUG build finished, exit stored above ==='

Set-Location 'D:\AgamizCode\ide-repo'
Log '=== RELEASE npm run tauri build ==='
npm run tauri build 2>&1 | ForEach-Object { Log $_ }
Log '=== RELEASE build finished ==='

Log '>>> SCRIPT DONE'