@echo off
rem lmstudio-zh launcher (Windows). Node probe chain: system node, then LM Studio bundled node.
rem ASCII-only and CRLF on purpose: cmd.exe reads .cmd in the system ANSI codepage, and its
rem parser drops leading characters in LF-only files. Keep .gitattributes in sync.
rem Note: never put a redirection character in a rem line - cmd parses it as a
rem redirect even inside comments (it would create a stray file named after the
rem next token).
rem Delayed expansion is required: %ERRORLEVEL% inside a parenthesized block is expanded
rem at PARSE time (i.e. before node runs), so it would always be the exit code of the
rem previous command. !ERRORLEVEL! is expanded at execution time.
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
