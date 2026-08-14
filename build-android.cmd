@echo off
REM DSH Mobile Android build launcher (ASCII only, CRLF)
REM Usage:
REM   build-android.cmd assembleDebug         build debug APK
REM   build-android.cmd assembleRelease       build standalone release APK (bundles JS)
REM   build-android.cmd installDebug          build + install to connected device
setlocal

REM ---- 1) Locate JDK 17: env JAVA_HOME -> Android Studio bundled JBR ----
if defined JAVA_HOME if exist "%JAVA_HOME%\bin\java.exe" goto jdk_ok
set "JAVA_HOME=%LOCALAPPDATA%\Programs\Android Studio\jbr"
if exist "%JAVA_HOME%\bin\java.exe" goto jdk_ok
set "JAVA_HOME=C:\Program Files\Android\Android Studio\jbr"
if exist "%JAVA_HOME%\bin\java.exe" goto jdk_ok
echo [ERROR] JDK 17 not found. Set JAVA_HOME to a JDK 17, or install Android Studio.
exit /b 1

:jdk_ok
REM ---- 2) Android SDK (default location) ----
set "ANDROID_HOME=%LOCALAPPDATA%\Android\Sdk"
if not exist "%ANDROID_HOME%" (
  echo [ERROR] Android SDK not found: %ANDROID_HOME%
  exit /b 1
)
set "PATH=%JAVA_HOME%\bin;%ANDROID_HOME%\platform-tools;%PATH%"
echo [JDK] %JAVA_HOME%
echo [SDK] %ANDROID_HOME%
cd /d "%~dp0android"
call gradlew.bat %*
endlocal
