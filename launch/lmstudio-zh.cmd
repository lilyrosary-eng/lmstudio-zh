@echo off
rem lmstudio-zh launcher (Windows). Node probe chain: system node -> LM Studio bundled node.
rem ASCII-only on purpose: cmd.exe reads .cmd in the system ANSI codepage, which is
rem unknown on the target machine. All user-facing messages live in cli.mjs (UTF-8).
rem Delayed expansion is required: %ERRORLEVEL% inside a parenthesized block is
rem expanded at PARSE time (i.e. before node runs) — it would always be the exit
rem code of `where node`. !ERRORLEVEL! is expanded at execution time.
setlocal EnableDelayedExpansion
set "SCRIPT_DIR=%~dp0.."
where node >nul 2>nul
if %ERRORLEVEL%==0 (
  node "%SCRIPT_DIR%\bin\lmstudio-zh.mjs" %*
  exit /b !ERRORLEVEL!
)
set "FALLBACK=%USERPROFILE%\.lmstudio\.internal\utils\node.exe"
if exist "%FALLBACK%" (
  "%FALLBACK%" "%SCRIPT_DIR%\bin\lmstudio-zh.mjs" %*
  exit /b !ERRORLEVEL!
)
echo [lmstudio-zh] Node.js not found. Install Node.js 18+ or make sure LM Studio is installed.
exit /b 1
