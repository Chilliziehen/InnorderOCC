@rem
@rem Copyright 2015 the original author or authors.
@rem
@rem Licensed under the Apache License, Version 2.0 (the "License");
@rem you may not use this file except in compliance with the License.
@rem You may obtain a copy of the License at
@rem
@rem      https://www.apache.org/licenses/LICENSE-2.0
@rem
@rem Unless required by applicable law or agreed to in writing, software
@rem distributed under the License is distributed on an "AS IS" BASIS,
@rem WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
@rem See the License for the specific language governing permissions and
@rem limitations under the License.
@rem
@rem SPDX-License-Identifier: Apache-2.0
@rem

@if "%DEBUG%"=="" @echo off
@rem ##########################################################################
@rem
@rem  gradlew startup script for Windows
@rem
@rem ##########################################################################

@rem Set local scope for the variables, and ensure extensions are enabled
setlocal EnableExtensions

set DIRNAME=%~dp0
if "%DIRNAME%"=="" set DIRNAME=.
@rem This is normally unused
set APP_BASE_NAME=%~n0
set APP_HOME=%DIRNAME%

@rem Resolve any "." and ".." in APP_HOME to make it shorter.
for %%i in ("%APP_HOME%") do set APP_HOME=%%~fi

@rem Add default JVM options here. You can also use JAVA_OPTS and GRADLE_OPTS to pass JVM options to this script.
set DEFAULT_JVM_OPTS="-Xmx64m" "-Xms64m"

@rem Find java.exe
if defined JAVA_HOME goto findJavaFromJavaHome

set JAVA_EXE=java.exe
%JAVA_EXE% -version >NUL 2>&1
if %ERRORLEVEL% equ 0 goto checkJavaVersion

echo. 1>&2
echo ERROR: JAVA_HOME is not set and no 'java' command could be found in your PATH. 1>&2
echo. 1>&2
echo Please set the JAVA_HOME variable in your environment to match the 1>&2
echo location of your Java installation. 1>&2

"%COMSPEC%" /c exit 1

:findJavaFromJavaHome
set JAVA_HOME=%JAVA_HOME:"=%
set JAVA_EXE=%JAVA_HOME%/bin/java.exe

if exist "%JAVA_EXE%" goto checkJavaVersion

echo. 1>&2
echo ERROR: JAVA_HOME is set to an invalid directory: %JAVA_HOME% 1>&2
echo. 1>&2
echo Please set the JAVA_HOME variable in your environment to match the 1>&2
echo location of your Java installation. 1>&2

"%COMSPEC%" /c exit 1

:checkJavaVersion
set "JAVA_VERSION="
for /f "tokens=3" %%v in ('"%JAVA_EXE%" -version 2^>^&1') do if not defined JAVA_VERSION set "JAVA_VERSION=%%~v"
set "JAVA_MAJOR="
for /f "tokens=1,2 delims=.-" %%a in ("%JAVA_VERSION%") do (
    if "%%a"=="1" (set "JAVA_MAJOR=%%b") else set "JAVA_MAJOR=%%a"
)
if defined JAVA_MAJOR if %JAVA_MAJOR% GEQ 8 if %JAVA_MAJOR% LEQ 24 goto execute
if defined GRADLE_JAVA_FALLBACK goto unsupportedJava

@rem Gradle 8 cannot run on Java 25+. Only then use the repository fallback locator.
where.exe powershell.exe >NUL 2>&1
if errorlevel 1 goto unsupportedJava
set "GRADLE_SELECTED_JAVA_HOME="
for /f "usebackq delims=" %%i in (`powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%APP_HOME%\gradle\select-gradle-java.ps1"`) do set "GRADLE_SELECTED_JAVA_HOME=%%i"
if not defined GRADLE_SELECTED_JAVA_HOME goto unsupportedJava
set "GRADLE_JAVA_FALLBACK=1"
set "JAVA_HOME=%GRADLE_SELECTED_JAVA_HOME%"
set "JAVA_EXE=%JAVA_HOME%/bin/java.exe"
if exist "%JAVA_EXE%" goto checkJavaVersion

:unsupportedJava
echo. 1>&2
echo ERROR: Gradle 8.14.3 cannot run on Java %JAVA_VERSION%. Set JAVA_HOME to a Java 21-24 JDK. 1>&2
echo. 1>&2
exit /b 1

:execute
@rem Setup the command line



@rem Execute gradlew
@rem endlocal doesn't take effect until after the line is parsed and variables are expanded
@rem which allows us to clear the local environment before executing the java command
endlocal & "%JAVA_EXE%" %DEFAULT_JVM_OPTS% %JAVA_OPTS% %GRADLE_OPTS% "-Dorg.gradle.appname=%APP_BASE_NAME%" -jar "%APP_HOME%\gradle\wrapper\gradle-wrapper.jar" %* & call :exitWithErrorLevel

:exitWithErrorLevel
@rem Use "%COMSPEC%" /c exit to allow operators to work properly in scripts
"%COMSPEC%" /c exit %ERRORLEVEL%
