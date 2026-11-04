@echo off
setlocal
cd /d "%~dp0.."
set "RUSTUP_HOME=%~dp0..\..\..\..\.toolchains\rustup"
set "CARGO_HOME=%~dp0..\..\..\..\.toolchains\cargo"
set "PATH=%CARGO_HOME%\bin;%PATH%"
set "pnpm_config_pm_on_fail=ignore"
set "NEXT_TELEMETRY_DISABLED=1"
set "NEXT_PUBLIC_IELTS_TRIAL=1"
set "CARGO_NET_OFFLINE=true"
set "CARGO_BUILD_JOBS=2"
set "CARGO_PROFILE_RELEASE_CODEGEN_UNITS=8"
call "D:\VisualStudio2022\VisualStudio2022\Community\VC\Auxiliary\Build\vcvars64.bat" 10.0.26100.0 -vcvars_ver=14.44
if errorlevel 1 exit /b %errorlevel%
for /f "delims=" %%V in ('node -p "require('./src-tauri/tauri.ielts.conf.json').version"') do set "NEXT_PUBLIC_APP_VERSION=%%V"
for /f "delims=" %%N in ('node -p "require('./src-tauri/tauri.ielts.conf.json').productName"') do set "NEXT_PUBLIC_APP_NAME=%%N"
if /i "%~1"=="restore" goto restore
call pnpm.cmd exec tauri build --ci --no-bundle --features ielts-trial --config src-tauri/tauri.ielts.conf.json -- --locked
exit /b %errorlevel%
:restore
for /f "delims=" %%N in ('node -p "require('./src-tauri/tauri.ielts-restore.conf.json').productName"') do set "NEXT_PUBLIC_APP_NAME=%%N"
call pnpm.cmd exec tauri build --ci --no-bundle --features ielts-trial --config src-tauri/tauri.ielts.conf.json --config src-tauri/tauri.ielts-restore.conf.json -- --locked
exit /b %errorlevel%
