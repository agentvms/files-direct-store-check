// Files Direct: the menu-bar program of the Mac app (files-direct-34).
// It shows a menu and starts the program's own engine (files-direct.mjs, run by the Node that is inside this app). It holds no transfer rule and no update rule:
// every file the person chooses is handed to the engine as a separate argument, after "--", and never pasted into a command line.
import AppKit
import Foundation

let resources = Bundle.main.resourcePath ?? ""
let nodePath = resources + "/node"
let enginePath = resources + "/files-direct.mjs"
let versionText = (Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String) ?? "0"

struct Outcome {
    let status: Int32
    let output: String
}

/// Runs the engine and waits for it. Output and errors are collected.
func runEngine(_ args: [String]) -> Outcome {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: nodePath)
    p.arguments = [enginePath] + args
    let pipe = Pipe()
    p.standardOutput = pipe
    p.standardError = pipe
    p.standardInput = FileHandle.nullDevice
    do { try p.run() } catch { return Outcome(status: 127, output: "\(error)") }
    let data = pipe.fileHandleForReading.readDataToEndOfFile()
    p.waitUntilExit()
    return Outcome(status: p.terminationStatus, output: String(data: data, encoding: .utf8) ?? "")
}

/// Starts the engine and does not wait (the Files Direct window it opens ends the run).
func startEngine(_ args: [String]) {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: nodePath)
    p.arguments = [enginePath] + args
    p.standardInput = FileHandle.nullDevice
    p.standardOutput = FileHandle.nullDevice
    p.standardError = FileHandle.nullDevice
    try? p.run()
}

/// The last line of the engine's output that is a JSON object.
func lastJSON(_ text: String) -> [String: Any]? {
    for line in text.split(separator: "\n").reversed() {
        if let d = line.data(using: .utf8), let o = try? JSONSerialization.jsonObject(with: d) as? [String: Any] { return o }
    }
    return nil
}

@discardableResult
func alert(_ title: String, _ info: String, _ buttons: [String] = ["OK"]) -> Int {
    NSApp.activate(ignoringOtherApps: true)
    let a = NSAlert()
    a.messageText = title
    a.informativeText = info
    for b in buttons { a.addButton(withTitle: b) }
    let r = a.runModal()
    return r.rawValue - NSApplication.ModalResponse.alertFirstButtonReturn.rawValue
}

final class Delegate: NSObject, NSApplicationDelegate {
    var item: NSStatusItem?

    func applicationDidFinishLaunching(_ note: Notification) {
        // one menu-bar program at a time
        let mine = Bundle.main.bundleIdentifier ?? ""
        if NSRunningApplication.runningApplications(withBundleIdentifier: mine).count > 1 {
            NSApp.terminate(nil)
            return
        }
        let bar = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        if let button = bar.button {
            if let image = NSImage(systemSymbolName: "square.and.arrow.up", accessibilityDescription: "Files Direct") {
                image.isTemplate = true
                button.image = image
            } else {
                button.title = "Files Direct"
            }
        }
        let menu = NSMenu()
        let head = NSMenuItem(title: "Files Direct " + versionText, action: nil, keyEquivalent: "")
        head.isEnabled = false
        menu.addItem(head)
        menu.addItem(NSMenuItem.separator())
        add(menu, "Send…", #selector(send))
        add(menu, "Ask for files", #selector(openWindow))
        add(menu, "Receive by link or code", #selector(openWindow))
        menu.addItem(NSMenuItem.separator())
        add(menu, "Check for updates…", #selector(checkForUpdates))
        add(menu, "Remove Files Direct…", #selector(removeApp))
        menu.addItem(NSMenuItem.separator())
        add(menu, "Quit Files Direct", #selector(quit))
        bar.menu = menu
        item = bar
        installEntry()
        if CommandLine.arguments.contains("--update-now") { updateNow() }
    }

    func add(_ menu: NSMenu, _ title: String, _ action: Selector) {
        let i = NSMenuItem(title: title, action: action, keyEquivalent: "")
        i.target = self
        menu.addItem(i)
    }

    /// The right-click entry (the Finder Quick Action) is written, or written again, each time the app starts: it points at this app's own Node and engine.
    func installEntry() {
        // an app run straight from a download or a disk image is not where it will stay: the entry would point at a place that goes away
        let here = Bundle.main.bundlePath
        if here.contains("/AppTranslocation/") || here.hasPrefix("/Volumes/") {
            alert("Move Files Direct first", "Drag Files Direct into your Applications folder (or any folder of your own), then open it from there. Then the right-click entry can be added.")
            return
        }
        DispatchQueue.global().async { _ = runEngine(["menu", "install", "--app"]) }
    }

    @objc func send() {
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = true
        panel.allowsMultipleSelection = true
        panel.prompt = "Send"
        panel.message = "Choose the files or folders to send"
        NSApp.activate(ignoringOtherApps: true)
        if panel.runModal() == .OK {
            startEngine(["open", "--app", "--"] + panel.urls.map { $0.path })
        }
    }

    @objc func openWindow() {
        startEngine(["open", "--app"])
    }

    @objc func checkForUpdates() {
        DispatchQueue.global().async {
            let r = runEngine(["update", "check", "--json"])
            let j = lastJSON(r.output)
            DispatchQueue.main.async {
                let state = j?["state"] as? String
                if state == "available", let v = j?["version"] as? String {
                    if alert("Files Direct " + v + " is ready", "Install it now? Files Direct closes and opens again.", ["Install", "Not now"]) == 0 { self.install() }
                } else if state == "current" {
                    alert("Files Direct is up to date", "You have the newest version (" + versionText + ").")
                } else {
                    alert("No update", (j?["message"] as? String) ?? "Files Direct could not look for an update.")
                }
            }
        }
    }

    func install() {
        let pid = String(ProcessInfo.processInfo.processIdentifier)
        DispatchQueue.global().async {
            let r = runEngine(["update", "install", "--json", "--wait-for", pid])
            let j = lastJSON(r.output)
            DispatchQueue.main.async {
                if r.status == 0 {
                    NSApp.terminate(nil)
                } else {
                    alert("The update was not installed", (j?["message"] as? String) ?? "Something went wrong. Nothing was changed.")
                }
            }
        }
    }

    /// For a script or a check on a build machine: look for an update and install it, with no questions.
    func updateNow() {
        DispatchQueue.global().async {
            let pid = String(ProcessInfo.processInfo.processIdentifier)
            let r = runEngine(["update", "install", "--json", "--wait-for", pid])
            DispatchQueue.main.async {
                if r.status == 0, let j = lastJSON(r.output), (j["state"] as? String) == "restarting" { NSApp.terminate(nil) }
            }
        }
    }

    @objc func removeApp() {
        let choice = alert("Remove Files Direct?", "This takes \"Send with Files Direct\" out of Finder, deletes what Files Direct made in your Library folder, and moves this app to the Trash. Files you sent or received stay where they are.", ["Remove", "Cancel"])
        if choice != 0 { return }
        DispatchQueue.global().async {
            _ = runEngine(["app", "remove"])
            DispatchQueue.main.async {
                do {
                    try FileManager.default.trashItem(at: Bundle.main.bundleURL, resultingItemURL: nil)
                    alert("Files Direct is removed", "Its menu entry and its folders are gone, and the app is in the Trash.")
                } catch {
                    alert("Almost done", "The menu entry and the folders are gone. To finish, drag Files Direct from " + Bundle.main.bundlePath + " to the Trash.")
                }
                NSApp.terminate(nil)
            }
        }
    }

    @objc func quit() {
        NSApp.terminate(nil)
    }
}

let app = NSApplication.shared
let delegate = Delegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
