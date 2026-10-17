@echo off
chcp 65001 >nul
cd /d "%~dp0"
if not exist .env (
  copy .env.example .env >nul
  echo Создан файл .env. Отредактируйте его и добавьте токен бота Discord и ID сервера.
  notepad .env
  pause
  exit /b
)
if not exist node_modules (
  echo Установка зависимостей...
  call npm install
  if errorlevel 1 (echo Ошибка установки зависимостей. & pause & exit /b 1)
)
echo Запуск сервера...
call npm start
pause