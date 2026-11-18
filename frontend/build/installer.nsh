!include LogicLib.nsh

; Defining customCheckAppRunning makes electron-builder skip these, and its check still needs them.
!include "getProcessInfo.nsh"
Var pid

; electron-builder's check kills every process running from the install folder. If that hits
; the service, Windows restarts it 10 seconds later and it re-applies its policy while its
; files are being deleted. So remove the service first, which also restores its settings.
!macro customCheckAppRunning
  ${If} ${FileExists} "$INSTDIR\resources\windows-service\uninstall-service.cmd"
    Push $0
    DetailPrint "Removing aceHRM device service..."
    nsExec::ExecToLog '"$INSTDIR\resources\windows-service\uninstall-service.cmd"'
    Pop $0
    DetailPrint "aceHRM device service uninstaller exit code: $0"
    Pop $0
  ${EndIf}
  !insertmacro IS_POWERSHELL_AVAILABLE
  !insertmacro _CHECK_APP_RUNNING
!macroend

!macro customInstall
  ${If} ${FileExists} "$INSTDIR\resources\windows-service\install-service.cmd"
    DetailPrint "Installing aceHRM device service..."
    nsExec::ExecToLog '"$INSTDIR\resources\windows-service\install-service.cmd"'
    Pop $0
    DetailPrint "aceHRM device service installer exit code: $0"
  ${Else}
    DetailPrint "aceHRM device service payload not bundled; skipping service installation."
  ${EndIf}
!macroend

; The check above doesn't run in every uninstall mode. Harmless when the service is already gone.
!macro customUnInstall
  ${If} ${FileExists} "$INSTDIR\resources\windows-service\uninstall-service.cmd"
    DetailPrint "Removing aceHRM device service..."
    nsExec::ExecToLog '"$INSTDIR\resources\windows-service\uninstall-service.cmd"'
    Pop $0
    DetailPrint "aceHRM device service uninstaller exit code: $0"
  ${Else}
    DetailPrint "aceHRM device service payload not installed; skipping service removal."
  ${EndIf}
!macroend
