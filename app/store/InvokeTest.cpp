// Only for the build machine's check (scripts/app-store.mjs check), never shipped: loads the menu handler's library the way Explorer does, asks it for its title, and calls its
// Invoke with the paths listed in a file (UTF-8, each ended by a NUL byte), so a hostile file name can be followed from the click to the launcher.
//   InvokeTest.exe <library> <list file>      loads that library file itself (the handler as a plain file)
//   InvokeTest.exe --registered <list file>   asks Windows for the handler the installed package registered, as Explorer does
#define WIN32_LEAN_AND_MEAN
#define UNICODE
#define _UNICODE
#include <windows.h>
#include <shobjidl.h>
#include <shlobj.h>
#include <cstdio>
#include <string>
#include <vector>

typedef HRESULT(STDAPICALLTYPE* GetClassObjectFn)(REFCLSID, REFIID, void**);

int wmain(int argc, wchar_t** argv) {
    if (argc != 3) { fwprintf(stderr, L"usage: InvokeTest <library> <list file>\n"); return 2; }
    CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
    CLSID clsid;
    if (FAILED(CLSIDFromString(L"{77EA6AA1-EAF9-46EF-962D-7862CB8CA0F0}", &clsid))) return 5;
    IExplorerCommand* command = nullptr;
    HRESULT hr;
    if (wcscmp(argv[1], L"--registered") == 0) {
        hr = CoCreateInstance(clsid, nullptr, CLSCTX_LOCAL_SERVER | CLSCTX_INPROC_SERVER, IID_IExplorerCommand, (void**)&command);
        if (FAILED(hr)) { fwprintf(stderr, L"CoCreateInstance: 0x%08lx\n", hr); return 7; }
    } else {
        HMODULE lib = LoadLibraryW(argv[1]);
        if (!lib) { fwprintf(stderr, L"cannot load %s\n", argv[1]); return 3; }
        GetClassObjectFn get = (GetClassObjectFn)GetProcAddress(lib, "DllGetClassObject");
        if (!get) { fwprintf(stderr, L"no DllGetClassObject\n"); return 4; }
        IClassFactory* factory = nullptr;
        hr = get(clsid, IID_IClassFactory, (void**)&factory);
        if (FAILED(hr)) { fwprintf(stderr, L"DllGetClassObject: 0x%08lx\n", hr); return 6; }
        hr = factory->CreateInstance(nullptr, IID_IExplorerCommand, (void**)&command);
        if (FAILED(hr)) { fwprintf(stderr, L"CreateInstance: 0x%08lx\n", hr); return 7; }
    }

    PWSTR title = nullptr;
    command->GetTitle(nullptr, &title);
    wprintf(L"title: %s\n", title ? title : L"(none)");
    CoTaskMemFree(title);

    FILE* f = nullptr;
    if (_wfopen_s(&f, argv[2], L"rb") != 0 || !f) { fwprintf(stderr, L"cannot read %s\n", argv[2]); return 8; }
    std::string all;
    char block[4096];
    size_t got;
    while ((got = fread(block, 1, sizeof(block), f)) > 0) all.append(block, got);
    fclose(f);
    std::vector<PIDLIST_ABSOLUTE> ids;
    size_t start = 0;
    for (size_t i = 0; i < all.size(); i++) {
        if (all[i] != 0) continue;
        int chars = MultiByteToWideChar(CP_UTF8, 0, all.data() + start, (int)(i - start), nullptr, 0);
        std::wstring path(chars, L'\0');
        MultiByteToWideChar(CP_UTF8, 0, all.data() + start, (int)(i - start), &path[0], chars);
        PIDLIST_ABSOLUTE id = nullptr;
        if (SUCCEEDED(SHParseDisplayName(path.c_str(), nullptr, &id, 0, nullptr)) && id) ids.push_back(id);
        else fwprintf(stderr, L"not found: %s\n", path.c_str());
        start = i + 1;
    }
    IShellItemArray* items = nullptr;
    hr = SHCreateShellItemArrayFromIDLists((UINT)ids.size(), (PCIDLIST_ABSOLUTE_ARRAY)ids.data(), &items);
    if (FAILED(hr)) { fwprintf(stderr, L"SHCreateShellItemArrayFromIDLists: 0x%08lx\n", hr); return 9; }
    wprintf(L"items: %u\n", (unsigned)ids.size());
    hr = command->Invoke(items, nullptr);
    wprintf(L"invoke: 0x%08lx\n", hr);
    items->Release();
    for (auto id : ids) CoTaskMemFree(id);
    command->Release();
    CoUninitialize();
    return SUCCEEDED(hr) ? 0 : 10;
}
