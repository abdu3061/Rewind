$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_OS -ne 'Windows' -or !$env:RUNNER_TEMP -or !$env:GH_TOKEN) {
  throw 'INSTALLER_ACCEPTANCE_REQUIRES_DISPOSABLE_GITHUB_WINDOWS_RUNNER'
}
if ($env:REWIND_BETA_TAG -notmatch '^v[0-9]+\.[0-9]+\.[0-9]+-beta\.[0-9]+$') { throw 'INVALID_BETA_TAG' }
if ($env:REWIND_UPGRADE_FROM_TAG -and ($env:REWIND_UPGRADE_FROM_TAG -notmatch '^v[0-9]+\.[0-9]+\.[0-9]+-beta\.[0-9]+$' -or $env:REWIND_UPGRADE_FROM_TAG -eq $env:REWIND_BETA_TAG)) { throw 'INVALID_UPGRADE_SOURCE_TAG' }
$repository = $env:GITHUB_REPOSITORY
if ($repository -ne 'abdu3061/Rewind') { throw 'UNEXPECTED_ACCEPTANCE_REPOSITORY' }
$work = Join-Path $env:RUNNER_TEMP ('rewind-installer-synthetic-' + [guid]::NewGuid().ToString('N'))
$installRoot = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Rewind'
$profile = Join-Path ([Environment]::GetFolderPath('ApplicationData')) 'Rewind'
if ((Test-Path -LiteralPath $installRoot) -or (Test-Path -LiteralPath $profile) -or (Get-Process Rewind -ErrorAction SilentlyContinue)) {
  throw 'INSTALLER_ACCEPTANCE_REQUIRES_FRESH_ACCOUNT'
}
New-Item -ItemType Directory -Path $work,$profile -Force | Out-Null
[IO.File]::WriteAllText((Join-Path $profile 'synthetic-fixture.json'), '{"format":1,"synthetic":true}')
[IO.File]::WriteAllText((Join-Path $work 'synthetic-fixture.json'), '{"format":1,"synthetic":true}')
$receipt = [ordered]@{ format=1; synthetic=$true; tag=$env:REWIND_BETA_TAG; target='win32-x64'; steps=@(); success=$false }
function Record-Step([string]$code) {
  $receipt.steps += $code
  Write-Output $code
}
function Wait-Condition([scriptblock]$condition, [string]$failure, [int]$seconds=60) {
  $deadline = [DateTime]::UtcNow.AddSeconds($seconds)
  do {
    if (& $condition) { return }
    Start-Sleep -Milliseconds 500
  } while ([DateTime]::UtcNow -lt $deadline)
  throw $failure
}
function Run-InstallerTool([string]$file, [string[]]$arguments) {
  $launch = @{ FilePath=$file; PassThru=$true; WindowStyle='Hidden' }
  if ($arguments.Count) { $launch.ArgumentList=$arguments } else { $launch.WindowStyle='Normal' }
  $process = Start-Process @launch
  if (!$process.WaitForExit(120000)) { throw 'INSTALLER_TOOL_TIMEOUT' }
  if ($process.ExitCode -ne 0) { throw 'INSTALLER_TOOL_FAILED' }
}
function Close-InstalledDesktop {
  $log = Join-Path $profile 'logs/operations.jsonl'
  Wait-Condition {
    if (!(Test-Path -LiteralPath $log)) { return $false }
    $codes = [IO.File]::ReadAllText($log)
    return ([regex]::Matches($codes, '"code":"DESKTOP_READY"').Count -gt [regex]::Matches($codes, '"code":"DESKTOP_STOPPED"').Count) -and @(Get-Process Rewind -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path.StartsWith($installRoot + '\', [StringComparison]::OrdinalIgnoreCase) -and $_.MainWindowHandle -ne 0 }).Count -eq 1
  } 'INSTALLED_DESKTOP_NOT_READY'
  $desktop = @(Get-Process Rewind -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path.StartsWith($installRoot + '\', [StringComparison]::OrdinalIgnoreCase) -and $_.MainWindowHandle -ne 0 })
  if ($desktop.Count -ne 1 -or !$desktop[0].CloseMainWindow()) { throw 'INSTALLED_DESKTOP_CLOSE_NOT_ACKNOWLEDGED' }
  Wait-Condition { !(Get-Process Rewind -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path.StartsWith($installRoot + '\', [StringComparison]::OrdinalIgnoreCase) }) } 'INSTALLED_DESKTOP_DID_NOT_EXIT' 30
  if (![IO.File]::ReadAllText($log).Contains('DESKTOP_STOPPED')) { throw 'INSTALLED_DESKTOP_SHUTDOWN_NOT_ACKNOWLEDGED' }
}
try {
  $releases = gh api "repos/$repository/releases?per_page=100" | ConvertFrom-Json
  if ($LASTEXITCODE -ne 0) { throw 'BETA_RELEASE_LOOKUP_FAILED' }
  $release = @($releases | Where-Object { $_.tag_name -eq $env:REWIND_BETA_TAG })
  if ($release.Count -ne 1 -or !$release[0].prerelease) { throw 'BETA_RELEASE_NOT_FOUND' }
  $release = $release[0]
  $assets = @($release.assets | Where-Object { $_.name -eq 'Rewind-Setup.exe' -or $_.name -eq 'release-manifest.json' -or $_.name -match '^Rewind-win32-x64-[0-9]+\.[0-9]+\.[0-9]+-beta\.[0-9]+\.zip$' })
  if ($assets.Count -ne 3) { throw 'BETA_INSTALLER_ASSETS_MISSING' }
  foreach ($asset in $assets) {
    if ($asset.state -ne 'uploaded' -or $asset.digest -notmatch '^sha256:[a-f0-9]{64}$') { throw 'BETA_ASSET_NOT_VERIFIED' }
    $destination = Join-Path $work $asset.name
    Invoke-WebRequest -Uri $asset.url -Headers @{ Authorization="Bearer $env:GH_TOKEN"; Accept='application/octet-stream'; 'X-GitHub-Api-Version'='2022-11-28' } -OutFile $destination
    if ((Get-Item -LiteralPath $destination).Length -ne $asset.size -or ('sha256:' + (Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash.ToLowerInvariant()) -ne $asset.digest) { throw 'DOWNLOADED_BETA_HASH_MISMATCH' }
  }
  $manifest = Get-Content (Join-Path $work 'release-manifest.json') -Raw | ConvertFrom-Json
  if ($manifest.version -ne $env:REWIND_BETA_TAG.Substring(1) -or $manifest.build.dirty -or $manifest.build.mode -ne 'release') { throw 'INVALID_BETA_BUILD_PROVENANCE' }
  $receipt.source = $manifest.build.source
  $installer = Join-Path $work 'Rewind-Setup.exe'
  $receipt.installerSha256 = (Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash.ToLowerInvariant()
  $portable = Join-Path $work 'portable'
  $zip = @($assets | Where-Object { $_.name.EndsWith('.zip') })[0]
  Expand-Archive -LiteralPath (Join-Path $work $zip.name) -DestinationPath $portable
  if (!(Test-Path -LiteralPath (Join-Path $portable 'Rewind.exe'))) { throw 'PORTABLE_BETA_LAYOUT_INVALID' }
  Record-Step 'DOWNLOADED_PUBLISHED_BYTES_VERIFIED'
  $previousKeyHash = $null
  if ($env:REWIND_UPGRADE_FROM_TAG) {
    $previousRelease = @($releases | Where-Object { $_.tag_name -eq $env:REWIND_UPGRADE_FROM_TAG })
    if ($previousRelease.Count -ne 1) { throw 'UPGRADE_SOURCE_RELEASE_MISSING' }
    $previousAsset = @($previousRelease[0].assets | Where-Object { $_.name -eq 'Rewind-Setup.exe' })
    if ($previousAsset.Count -ne 1 -or $previousAsset[0].state -ne 'uploaded') { throw 'UPGRADE_SOURCE_INSTALLER_MISSING' }
    $previousAsset = $previousAsset[0]
    $previousInstaller = Join-Path $work 'previous-Rewind-Setup.exe'
    Invoke-WebRequest -Uri $previousAsset.url -Headers @{ Authorization="Bearer $env:GH_TOKEN"; Accept='application/octet-stream'; 'X-GitHub-Api-Version'='2022-11-28' } -OutFile $previousInstaller
    if (('sha256:' + (Get-FileHash -LiteralPath $previousInstaller -Algorithm SHA256).Hash.ToLowerInvariant()) -ne $previousAsset.digest) { throw 'UPGRADE_SOURCE_HASH_MISMATCH' }
    Run-InstallerTool $previousInstaller @('--silent')
    $previousApplication = @(Get-ChildItem -LiteralPath $installRoot -Directory -Filter 'app-*')[0].FullName
    Start-Process -FilePath (Join-Path $previousApplication 'Rewind.exe') -WindowStyle Normal | Out-Null
    Close-InstalledDesktop
    $previousKeyHash = (Get-FileHash -LiteralPath (Join-Path $profile 'secure/history.key') -Algorithm SHA256).Hash
    Record-Step 'PREVIOUS_BETA_SYNTHETIC_ENCRYPTED_PROFILE_CREATED'
  }
  # Exercise the user-visible setup and its automatic first-launch handoff.
  Run-InstallerTool $installer @()
  Wait-Condition { (Test-Path -LiteralPath (Join-Path $installRoot 'Update.exe')) -and @(Get-ChildItem -LiteralPath $installRoot -Directory -Filter 'app-*').Count -eq 1 } 'INSTALLATION_LAYOUT_MISSING'
  $applicationDirectory = @(Get-ChildItem -LiteralPath $installRoot -Directory -Filter 'app-*')[0].FullName
  foreach ($relative in @('Rewind.exe','resources/app.asar','resources/browser/assets.json','resources/notices/inventory.json','resources/release/build.json')) {
    if ((Get-FileHash -LiteralPath (Join-Path $applicationDirectory $relative) -Algorithm SHA256).Hash -ne (Get-FileHash -LiteralPath (Join-Path $portable $relative) -Algorithm SHA256).Hash) { throw 'INSTALLED_PAYLOAD_DIFFERS_FROM_VERIFIED_ARCHIVE' }
  }
  Close-InstalledDesktop
  $history = Join-Path $profile 'secure/history.sqlite'
  $key = Join-Path $profile 'secure/history.key'
  if (!(Test-Path -LiteralPath $history) -or !(Test-Path -LiteralPath $key)) { throw 'INSTALLED_ENCRYPTED_PROFILE_MISSING' }
  $header = [IO.File]::ReadAllBytes($history)
  if ($header.Length -lt 16 -or [Text.Encoding]::ASCII.GetString($header,0,16) -eq "SQLite format 3`0") { throw 'INSTALLED_HISTORY_NOT_ENCRYPTED' }
  $keyHash = (Get-FileHash -LiteralPath $key -Algorithm SHA256).Hash
  if ($previousKeyHash) {
    if ($keyHash -ne $previousKeyHash) { throw 'UPGRADE_REPLACED_PROTECTED_KEY' }
    $receipt.upgradeFrom = $env:REWIND_UPGRADE_FROM_TAG
    Record-Step 'NEWER_VERSION_INSTALL_PRESERVED_ENCRYPTED_PROFILE_AND_KEY'
  }
  $registry = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Rewind'
  if (!(Test-Path -LiteralPath $registry)) { throw 'INSTALLER_UNINSTALL_ENTRY_MISSING' }
  $shortcutRoots = @([Environment]::GetFolderPath('DesktopDirectory'),[Environment]::GetFolderPath('StartMenu'))
  $shortcuts = @($shortcutRoots | ForEach-Object { Get-ChildItem -LiteralPath $_ -Filter 'Rewind.lnk' -File -Recurse -ErrorAction SilentlyContinue })
  if ($shortcuts.Count -lt 2) { throw 'INSTALLER_SHORTCUTS_MISSING' }
  $installedIcon = (Get-ItemProperty -LiteralPath $registry).DisplayIcon
  if (!$installedIcon -or !(Test-Path -LiteralPath $installedIcon)) { throw 'INSTALLED_BRAND_ICON_MISSING' }
  $expectedIcon = Join-Path (Get-Location) 'apps/desktop/assets/rewind.ico'
  if ((Get-FileHash -LiteralPath $installedIcon -Algorithm SHA256).Hash -ne (Get-FileHash -LiteralPath $expectedIcon -Algorithm SHA256).Hash) { throw 'INSTALLED_BRAND_ICON_DIFFERS' }
  if ($previousKeyHash) {
    Record-Step 'UPGRADE_PAYLOAD_STARTUP_ENCRYPTION_AND_CLOSE_PASSED'
  } else {
    Record-Step 'CLEAN_INSTALL_PAYLOAD_STARTUP_ENCRYPTION_AND_CLOSE_PASSED'
  }
  $shortcut = (New-Object -ComObject WScript.Shell).CreateShortcut($shortcuts[0].FullName)
  # Current Squirrel targets the root app launcher; older builds used Update.exe.
  $directShortcut = [string]::Equals($shortcut.TargetPath,(Join-Path $installRoot 'Rewind.exe'),[StringComparison]::OrdinalIgnoreCase) -and [string]::IsNullOrWhiteSpace($shortcut.Arguments)
  $legacyShortcut = [string]::Equals($shortcut.TargetPath,(Join-Path $installRoot 'Update.exe'),[StringComparison]::OrdinalIgnoreCase) -and $shortcut.Arguments -match '^--processStart\s+"?Rewind\.exe"?$'
  if (!$directShortcut -and !$legacyShortcut) { throw 'INSTALLED_SHORTCUT_RESTARTS_SETUP' }
  Start-Process -FilePath $shortcuts[0].FullName -WindowStyle Normal | Out-Null
  Close-InstalledDesktop
  Record-Step 'BRANDED_ICON_AND_NORMAL_SHORTCUT_LAUNCH_PASSED'
  Run-InstallerTool (Join-Path $installRoot 'Update.exe') @('--uninstall','--silent')
  Wait-Condition { !(Test-Path -LiteralPath (Join-Path $applicationDirectory 'Rewind.exe')) -and !(Test-Path -LiteralPath $registry) } 'UNINSTALL_DID_NOT_REMOVE_APPLICATION'
  foreach ($shortcut in $shortcuts) { if (Test-Path -LiteralPath $shortcut.FullName) { throw 'UNINSTALL_SHORTCUT_REMAINS' } }
  if (!(Test-Path -LiteralPath $history) -or (Get-FileHash -LiteralPath $key -Algorithm SHA256).Hash -ne $keyHash) { throw 'UNINSTALL_DID_NOT_PRESERVE_HISTORY' }
  Record-Step 'UNINSTALL_SHORTCUT_REMOVAL_AND_HISTORY_RETENTION_PASSED'
  Run-InstallerTool $installer @('--silent')
  Start-Process -FilePath (Join-Path $applicationDirectory 'Rewind.exe') -WindowStyle Normal | Out-Null
  Close-InstalledDesktop
  if ((Get-FileHash -LiteralPath $key -Algorithm SHA256).Hash -ne $keyHash) { throw 'REINSTALL_REPLACED_PROTECTED_KEY' }
  Record-Step 'REINSTALL_RETAINED_ENCRYPTED_PROFILE_AND_CLOSE_PASSED'
  Run-InstallerTool (Join-Path $installRoot 'Update.exe') @('--uninstall','--silent')
  $receipt.success = $true
} finally {
  New-Item -ItemType Directory -Path 'artifacts' -Force | Out-Null
  [IO.File]::WriteAllText((Join-Path (Get-Location) 'artifacts/windows-installer-acceptance.json'),($receipt | ConvertTo-Json -Depth 6),[Text.UTF8Encoding]::new($false))
}
