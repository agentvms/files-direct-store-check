// "Send with Files Direct" in the main right-click menu of Windows 11 (files-direct-37).
// A small COM library the package manifest registers (windows.comServer, windows.fileExplorerContextMenus). Explorer loads it when a person right-clicks files or a
// folder, asks for the entry's title, and on a click calls Invoke with everything that was selected, all at once.
// It holds no rule of its own. Invoke starts the launcher that sits beside this library (the same program as the tray program of the installed app) with one fixed word,
// "paths-stdin", and writes the chosen paths to the launcher's standard input, each ended by a NUL byte (a path cannot hold one). A path is NEVER put into a command line,
// so a name made of quotes, spaces, "&", "%" or "^" is only ever a name. Built by scripts/app-store.mjs with the C++ compiler that is on the build machine.
// Built with FD_NAIVE defined it does the careless thing instead (the paths pasted into the command line, unquoted): the check uses that build to show that a hostile name
// breaks it, so that the real build passing means something. That build is never part of the package.
#define WIN32_LEAN_AND_MEAN
#define UNICODE
#define _UNICODE
#include <windows.h>
#include <shobjidl.h>
#include <shlwapi.h>
#include <new>
#include <string>

static LONG g_objects = 0;
static LONG g_locks = 0;
static HMODULE g_module = nullptr;

/** The folder this library is in (with a closing backslash). The launcher is beside it. */
static std::wstring OwnFolder() {
    wchar_t buffer[MAX_PATH * 4];
    DWORD n = GetModuleFileNameW(g_module, buffer, ARRAYSIZE(buffer));
    if (n == 0 || n >= ARRAYSIZE(buffer)) return L"";
    std::wstring path(buffer, n);
    size_t slash = path.find_last_of(L'\\');
    return slash == std::wstring::npos ? L"" : path.substr(0, slash + 1);
}

#ifdef FD_NAIVE
/** The careless form, for the check only: every path after the word, in a command line. */
static std::wstring NaivePaths(IShellItemArray* items) {
    std::wstring all;
    DWORD count = 0;
    items->GetCount(&count);
    for (DWORD i = 0; i < count; i++) {
        IShellItem* item = nullptr;
        if (FAILED(items->GetItemAt(i, &item))) continue;
        PWSTR path = nullptr;
        if (SUCCEEDED(item->GetDisplayName(SIGDN_FILESYSPATH, &path)) && path) {
            all += L" ";
            all += path;
            CoTaskMemFree(path);
        }
        item->Release();
    }
    return all;
}
#endif

/** Starts the launcher with its standard input connected to a pipe, and writes the paths to it. Returns false when the launcher could not be started. */
static bool HandOver(const std::wstring& launcher, const std::wstring& folder, IShellItemArray* items) {
    SECURITY_ATTRIBUTES inherit = { sizeof(inherit), nullptr, TRUE };
    HANDLE readEnd = nullptr, writeEnd = nullptr;
    if (!CreatePipe(&readEnd, &writeEnd, &inherit, 0)) return false;
    SetHandleInformation(writeEnd, HANDLE_FLAG_INHERIT, 0); // the launcher gets the reading end only
    HANDLE nul = CreateFileW(L"NUL", GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE, &inherit, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);

    // the one command line: the launcher's own path in quotes, and one fixed word
#ifdef FD_NAIVE
    std::wstring command = L"\"" + launcher + L"\" sendto" + NaivePaths(items);
#else
    std::wstring command = L"\"" + launcher + L"\" " L"paths-stdin";
#endif
    STARTUPINFOW start = { sizeof(start) };
    start.dwFlags = STARTF_USESTDHANDLES;
    start.hStdInput = readEnd;
    start.hStdOutput = nul;
    start.hStdError = nul;
    PROCESS_INFORMATION child = {};
    BOOL started = CreateProcessW(launcher.c_str(), &command[0], nullptr, nullptr, TRUE, CREATE_NO_WINDOW, nullptr, folder.c_str(), &start, &child);
    CloseHandle(readEnd);
    if (nul != INVALID_HANDLE_VALUE) CloseHandle(nul);
    if (!started) {
        CloseHandle(writeEnd);
        return false;
    }
    CloseHandle(child.hThread);
    CloseHandle(child.hProcess);

#ifdef FD_NAIVE
    CloseHandle(writeEnd);
    return true;
#endif
    DWORD count = 0;
    items->GetCount(&count);
    for (DWORD i = 0; i < count; i++) {
        IShellItem* item = nullptr;
        if (FAILED(items->GetItemAt(i, &item))) continue;
        PWSTR path = nullptr;
        if (SUCCEEDED(item->GetDisplayName(SIGDN_FILESYSPATH, &path)) && path) { // an item that is not a file or folder on a disk has no such name and is skipped
            int bytes = WideCharToMultiByte(CP_UTF8, 0, path, -1, nullptr, 0, nullptr, nullptr); // counts the ending NUL, which is the separator
            if (bytes > 1) {
                std::string utf8(bytes, '\0');
                WideCharToMultiByte(CP_UTF8, 0, path, -1, &utf8[0], bytes, nullptr, nullptr);
                const char* data = utf8.data();
                DWORD left = (DWORD)bytes;
                while (left > 0) {
                    DWORD wrote = 0;
                    if (!WriteFile(writeEnd, data, left, &wrote, nullptr) || wrote == 0) break;
                    data += wrote;
                    left -= wrote;
                }
            }
            CoTaskMemFree(path);
        }
        item->Release();
    }
    CloseHandle(writeEnd); // the end of the list
    return true;
}

class __declspec(uuid("77EA6AA1-EAF9-46EF-962D-7862CB8CA0F0")) SendWithFilesDirect final : public IExplorerCommand, public IObjectWithSite {
public:
    SendWithFilesDirect() { InterlockedIncrement(&g_objects); }

    // IUnknown (one set answers for both bases)
    STDMETHODIMP QueryInterface(REFIID riid, void** out) override {
        if (!out) return E_POINTER;
        if (riid == IID_IUnknown || riid == IID_IExplorerCommand) *out = static_cast<IExplorerCommand*>(this);
        else if (riid == IID_IObjectWithSite) *out = static_cast<IObjectWithSite*>(this);
        else { *out = nullptr; return E_NOINTERFACE; }
        AddRef();
        return S_OK;
    }
    STDMETHODIMP_(ULONG) AddRef() override { return InterlockedIncrement(&refs_); }
    STDMETHODIMP_(ULONG) Release() override {
        LONG n = InterlockedDecrement(&refs_);
        if (n == 0) delete this;
        return n;
    }

    // IExplorerCommand
    STDMETHODIMP GetTitle(IShellItemArray*, PWSTR* name) override { return SHStrDupW(L"Send with Files Direct", name); }
    STDMETHODIMP GetIcon(IShellItemArray*, PWSTR* icon) override {
        std::wstring own = OwnFolder();
        if (own.empty()) { *icon = nullptr; return E_NOTIMPL; }
        return SHStrDupW((own + L"FilesDirect.exe,0").c_str(), icon);
    }
    STDMETHODIMP GetToolTip(IShellItemArray*, PWSTR* tip) override { *tip = nullptr; return E_NOTIMPL; }
    STDMETHODIMP GetCanonicalName(GUID* id) override { *id = GUID_NULL; return S_OK; }
    STDMETHODIMP GetState(IShellItemArray*, BOOL, EXPCMDSTATE* state) override { *state = ECS_ENABLED; return S_OK; }
    STDMETHODIMP GetFlags(EXPCMDFLAGS* flags) override { *flags = ECF_DEFAULT; return S_OK; }
    STDMETHODIMP EnumSubCommands(IEnumExplorerCommand** all) override { *all = nullptr; return E_NOTIMPL; }
    STDMETHODIMP Invoke(IShellItemArray* items, IBindCtx*) override {
        if (!items) return S_OK;
        std::wstring folder = OwnFolder();
        if (folder.empty()) return E_FAIL;
        return HandOver(folder + L"FilesDirect.exe", folder, items) ? S_OK : E_FAIL;
    }

    // IObjectWithSite: Explorer hands over its site and asks for it back; nothing here uses it
    STDMETHODIMP SetSite(IUnknown* site) override {
        if (site) site->AddRef();
        if (site_) site_->Release();
        site_ = site;
        return S_OK;
    }
    STDMETHODIMP GetSite(REFIID riid, void** out) override { return site_ ? site_->QueryInterface(riid, out) : E_FAIL; }

private:
    ~SendWithFilesDirect() {
        if (site_) site_->Release();
        InterlockedDecrement(&g_objects);
    }
    LONG refs_ = 1;
    IUnknown* site_ = nullptr;
};

class Factory final : public IClassFactory {
public:
    STDMETHODIMP QueryInterface(REFIID riid, void** out) override {
        if (!out) return E_POINTER;
        if (riid == IID_IUnknown || riid == IID_IClassFactory) { *out = static_cast<IClassFactory*>(this); return S_OK; }
        *out = nullptr;
        return E_NOINTERFACE;
    }
    STDMETHODIMP_(ULONG) AddRef() override { return 2; } // one factory for the life of the library
    STDMETHODIMP_(ULONG) Release() override { return 1; }
    STDMETHODIMP CreateInstance(IUnknown* outer, REFIID riid, void** out) override {
        if (!out) return E_POINTER;
        *out = nullptr;
        if (outer) return CLASS_E_NOAGGREGATION;
        SendWithFilesDirect* command = new (std::nothrow) SendWithFilesDirect();
        if (!command) return E_OUTOFMEMORY;
        HRESULT hr = command->QueryInterface(riid, out);
        command->Release();
        return hr;
    }
    STDMETHODIMP LockServer(BOOL lock) override {
        if (lock) InterlockedIncrement(&g_locks); else InterlockedDecrement(&g_locks);
        return S_OK;
    }
};
static Factory g_factory;

STDAPI DllGetClassObject(REFCLSID clsid, REFIID riid, void** out) {
    if (!out) return E_POINTER;
    *out = nullptr;
    if (clsid != __uuidof(SendWithFilesDirect)) return CLASS_E_CLASSNOTAVAILABLE;
    return g_factory.QueryInterface(riid, out);
}

STDAPI DllCanUnloadNow() { return (g_objects == 0 && g_locks == 0) ? S_OK : S_FALSE; }

BOOL APIENTRY DllMain(HMODULE module, DWORD reason, LPVOID) {
    if (reason == DLL_PROCESS_ATTACH) {
        g_module = module;
        DisableThreadLibraryCalls(module);
    }
    return TRUE;
}
