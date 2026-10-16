@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if not errorlevel 1 (
  node tools\demo-server.mjs
) else (
  if exist "%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe" (
    "%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe" tools\demo-server.mjs
  ) else (
    echo 未找到 Node.js。请安装 Node.js 后重新运行；安装扩展本身不需要 Node.js。
  )
)
pause
