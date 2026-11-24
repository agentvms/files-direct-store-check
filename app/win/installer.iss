; The Files Direct installer for Windows (files-direct-34). It installs for the person who runs it only: no administrator, nothing system-wide.
; Built by scripts/app-build.mjs with: ISCC /DAppVersion=<version> /DSourceDir=<folder> /DOutDir=<folder> /DIcon=<.ico> installer.iss
; The menu entries are written by the program itself (menu install / menu remove), so what it adds and removes is the one tested list, not a second copy of it here.

#ifndef AppVersion
  #error AppVersion is not set
#endif

[Setup]
AppId={{B7F1C0A4-5E2D-4A63-9C18-3F5D7E9A2B10}
AppName=Files Direct
AppVersion={#AppVersion}
AppPublisher=Files Direct
VersionInfoVersion={#AppVersion}
DefaultDirName={localappdata}\Programs\Files Direct
DisableProgramGroupPage=yes
DisableDirPage=yes
DisableReadyPage=yes
DisableWelcomePage=no
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir={#OutDir}
OutputBaseFilename=files-direct-setup-{#AppVersion}-win-x64
SetupIconFile={#Icon}
UninstallDisplayIcon={app}\Files Direct.exe
UninstallDisplayName=Files Direct
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern
CloseApplications=yes
RestartApplications=no
MinVersion=10.0

[Files]
Source: "{#SourceDir}\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion

[Icons]
Name: "{userprograms}\Files Direct"; Filename: "{app}\Files Direct.exe"

[Run]
Filename: "{app}\node.exe"; Parameters: """{app}\files-direct.mjs"" menu install --app --launcher ""{app}\Files Direct.exe"""; Flags: runhidden waituntilterminated; StatusMsg: "Adding Send with Files Direct to the right-click menu..."
Filename: "{app}\Files Direct.exe"; Flags: nowait postinstall runasoriginaluser; Description: "Open Files Direct"

[UninstallRun]
Filename: "{app}\node.exe"; Parameters: """{app}\files-direct.mjs"" app remove"; Flags: runhidden waituntilterminated; RunOnceId: "RemoveFilesDirectMenu"

[UninstallDelete]
Type: filesandordirs; Name: "{app}"

[Code]
// The tray program has no window an installer could close: ask it to end with its own "quit" command, before files are replaced or deleted.
procedure StopTray();
var
  rc: Integer;
begin
  if FileExists(ExpandConstant('{app}\Files Direct.exe')) then begin
    Exec(ExpandConstant('{app}\Files Direct.exe'), 'quit', '', SW_HIDE, ewWaitUntilTerminated, rc);
    Sleep(1500);
  end;
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  StopTray();
  Result := '';
end;

function InitializeUninstall(): Boolean;
begin
  StopTray();
  Result := True;
end;
