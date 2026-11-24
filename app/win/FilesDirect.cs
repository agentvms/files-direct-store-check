// Files Direct: the tray and launcher program of the Windows app (files-direct-34).
// Written in the plain C# that the compiler in every Windows (.NET Framework 4) understands.
//
// It has no console window. It does two things and holds no rule of its own:
//   1. "Files Direct.exe verb <path>" and "Files Direct.exe sendto <paths...>" (what the right-click entry and Send to start): it hands the chosen paths to the program's
//      engine (files-direct.mjs, run by the Node in this folder) on the engine's standard input, one after another, each ended by a NUL byte (a path cannot hold one).
//      The paths are NEVER put into a command line, so a name made of quotes, spaces, "&", "%" or "^" is only ever a name.
//   2. "Files Direct.exe paths-stdin": the same, for the Store package's menu handler (files-direct-37), which is given everything that was selected at once and writes the paths to this
//      program's standard input itself (NUL-separated, nothing in a command line), so the whole selection is one room and no waiting for the others is needed.
//   3. With no arguments it is the tray icon and its menu. Every menu item starts the engine with fixed words; the files the person picks go in on the standard input.
// Built with FD_NAIVE defined it does the careless thing instead (the paths pasted into the command line, unquoted): the checks use that build to show that a hostile name
// breaks it, so that the real build passing means something.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Runtime.InteropServices;
using System.IO;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

namespace FilesDirect
{
    static class Program
    {
        static readonly string Here = AppDomain.CurrentDomain.BaseDirectory;
        static string Node { get { return Path.Combine(Here, "node.exe"); } }
        static string Engine { get { return Path.Combine(Here, "files-direct.mjs"); } }

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
        static extern int GetCurrentPackageFullName(ref int length, StringBuilder name);

        static bool? packaged;
        /// <summary>True when this runs as the Microsoft Store package: the package is installed, updated and removed by the Store, and its menu entry is in its manifest.</summary>
        public static bool Packaged
        {
            get
            {
                if (packaged == null)
                {
                    try
                    {
                        int length = 0;
                        packaged = GetCurrentPackageFullName(ref length, null) != 15700; // APPMODEL_ERROR_NO_PACKAGE: a program that is not packaged has no package name
                    }
                    catch (Exception) { packaged = false; } // an older Windows has no such call: it is not packaged
                }
                return packaged.Value;
            }
        }

        [STAThread]
        static int Main(string[] args)
        {
            if (args.Length >= 1 && (args[0] == "verb" || args[0] == "sendto"))
            {
                return args.Length < 2 ? 2 : HandOver(args[0], new List<string>(args).GetRange(1, args.Length - 1));
            }
            if (args.Length == 1 && args[0] == "paths-stdin")
            {
                return FromStdin();
            }
            if (args.Length >= 1 && args[0] == "quit")
            {
                // what the installer and the uninstaller run first: ask the running tray program to end (it has no window an installer could close)
                try { EventWaitHandle.OpenExisting("Local\\FilesDirectTrayQuit").Set(); } catch (Exception) { }
                return 0;
            }
            bool first;
            using (Mutex one = new Mutex(true, "Local\\FilesDirectTray", out first))
            {
                if (!first) return 0;
                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                bool now = Array.IndexOf(args, "--update-now") >= 0;
                using (Tray tray = new Tray(now))
                {
                    Application.Run(tray);
                }
            }
            return 0;
        }

        /// <summary>The menu handler of the Store package writes the chosen paths here, each ended by a NUL byte (a path cannot hold one). They go on to the engine the same way.</summary>
        static int FromStdin()
        {
            List<string> paths = new List<string>();
            byte[] all;
            using (Stream input = Console.OpenStandardInput())
            using (MemoryStream copy = new MemoryStream())
            {
                input.CopyTo(copy);
                all = copy.ToArray();
            }
            int start = 0;
            for (int i = 0; i < all.Length; i++)
            {
                if (all[i] == 0)
                {
                    if (i > start) paths.Add(new UTF8Encoding(false).GetString(all, start, i - start));
                    start = i + 1;
                }
            }
            return paths.Count == 0 ? 2 : HandOver("send", paths);
        }

        static ProcessStartInfo Engine_(string words)
        {
            ProcessStartInfo psi = new ProcessStartInfo();
            psi.FileName = Node;
            psi.Arguments = "\"" + Engine + "\" " + words; // the words are ours and fixed: never a name the person chose
            psi.WorkingDirectory = Here;
            psi.UseShellExecute = false;
            psi.CreateNoWindow = true;
            psi.WindowStyle = ProcessWindowStyle.Hidden;
            return psi;
        }

        /// <summary>Starts the engine for the chosen paths. The paths go in on its standard input, NUL-separated; nothing is pasted into a command line.</summary>
        public static int HandOver(string mode, List<string> paths)
        {
            List<string> full = new List<string>();
            foreach (string p in paths) full.Add(Path.GetFullPath(p));
            string gather = mode == "verb" ? "--gather " : "";
#if FD_NAIVE
            ProcessStartInfo psi = Engine_("open --app " + gather + "-- " + string.Join(" ", full.ToArray()));
            Process.Start(psi);
            return 0;
#else
            ProcessStartInfo psi = Engine_("open --app " + gather + "--paths-stdin");
            psi.RedirectStandardInput = true;
            Process child = Process.Start(psi);
            using (Stream s = child.StandardInput.BaseStream)
            {
                UTF8Encoding utf8 = new UTF8Encoding(false);
                foreach (string p in full)
                {
                    byte[] b = utf8.GetBytes(p);
                    s.Write(b, 0, b.Length);
                    s.WriteByte(0);
                }
            }
            return 0;
#endif
        }

        public static void Start(string words)
        {
            try { Process.Start(Engine_(words)); } catch (Exception) { }
        }

        /// <summary>Runs the engine and waits; returns what it printed. The words are fixed.</summary>
        public static string Run(string words, out int status)
        {
            ProcessStartInfo psi = Engine_(words);
            psi.RedirectStandardOutput = true;
            try
            {
                using (Process p = Process.Start(psi))
                {
                    string output = p.StandardOutput.ReadToEnd();
                    p.WaitForExit();
                    status = p.ExitCode;
                    return output;
                }
            }
            catch (Exception e)
            {
                status = 127;
                return e.Message;
            }
        }

        public static Dictionary<string, object> LastJson(string output)
        {
            string[] lines = output.Split('\n');
            JavaScriptSerializer json = new JavaScriptSerializer();
            for (int i = lines.Length - 1; i >= 0; i--)
            {
                string line = lines[i].Trim();
                if (line.StartsWith("{"))
                {
                    try { return json.DeserializeObject(line) as Dictionary<string, object>; } catch (Exception) { }
                }
            }
            return null;
        }

        public static string Text(Dictionary<string, object> j, string key)
        {
            object v;
            return j != null && j.TryGetValue(key, out v) && v != null ? v.ToString() : null;
        }
    }

    sealed class Tray : ApplicationContext
    {
        readonly NotifyIcon icon = new NotifyIcon();
        readonly ContextMenuStrip menu = new ContextMenuStrip();
        readonly SynchronizationContext ui;
        readonly string version;
        readonly EventWaitHandle quitSignal = new EventWaitHandle(false, EventResetMode.AutoReset, "Local\\FilesDirectTrayQuit");

        public Tray(bool updateNow)
        {
            ui = SynchronizationContext.Current ?? new WindowsFormsSynchronizationContext();
            version = FileVersionInfo.GetVersionInfo(Application.ExecutablePath).ProductVersion;
            ToolStripMenuItem head = new ToolStripMenuItem("Files Direct " + version);
            head.Enabled = false;
            menu.Items.Add(head);
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add("Send files…", null, delegate { SendFiles(); });
            menu.Items.Add("Send a folder…", null, delegate { SendFolder(); });
            menu.Items.Add("Ask for files", null, delegate { Program.Start("open --app"); });
            menu.Items.Add("Receive by link or code", null, delegate { Program.Start("open --app"); });
            menu.Items.Add(new ToolStripSeparator());
            // the Store package is updated and removed by the Store (Settings, Apps), not by this program
            if (!Program.Packaged)
            {
                menu.Items.Add("Check for updates…", null, delegate { CheckForUpdates(); });
                menu.Items.Add("Remove Files Direct…", null, delegate { RemoveApp(); });
                menu.Items.Add(new ToolStripSeparator());
            }
            menu.Items.Add("Quit Files Direct", null, delegate { Quit(); });
            icon.Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
            icon.Text = "Files Direct";
            icon.ContextMenuStrip = menu;
            icon.MouseClick += delegate (object s, MouseEventArgs e)
            {
                if (e.Button == MouseButtons.Left) menu.Show(Cursor.Position);
            };
            icon.Visible = true;
            ThreadPool.RegisterWaitForSingleObject(quitSignal, delegate (object state, bool timedOut) { ui.Post(delegate { Quit(); }, null); }, null, -1, true);
            // the right-click entry is written, or written again, each time the app starts: it points at the launcher in this folder.
            // The Store package does not: its entry is in its manifest, and the manifest alone adds it and removes it.
            if (!Program.Packaged)
            {
                ThreadPool.QueueUserWorkItem(delegate
                {
                    int status;
                    Program.Run("menu install --app --launcher \"" + Application.ExecutablePath + "\"", out status);
                });
            }
            if (updateNow && !Program.Packaged) ThreadPool.QueueUserWorkItem(delegate { Install(); });
        }

        void SendFiles()
        {
            using (OpenFileDialog d = new OpenFileDialog())
            {
                d.Title = "Choose the files to send";
                d.Multiselect = true;
                d.CheckFileExists = true;
                if (d.ShowDialog() == DialogResult.OK && d.FileNames.Length > 0) Program.HandOver("send", new List<string>(d.FileNames));
            }
        }

        void SendFolder()
        {
            using (FolderBrowserDialog d = new FolderBrowserDialog())
            {
                d.Description = "Choose the folder to send";
                if (d.ShowDialog() == DialogResult.OK && d.SelectedPath.Length > 0) Program.HandOver("send", new List<string> { d.SelectedPath });
            }
        }

        void Say(string title, string text)
        {
            MessageBox.Show(text, title, MessageBoxButtons.OK, MessageBoxIcon.Information);
        }

        void CheckForUpdates()
        {
            ThreadPool.QueueUserWorkItem(delegate
            {
                int status;
                Dictionary<string, object> j = Program.LastJson(Program.Run("update check --json", out status));
                string state = Program.Text(j, "state");
                ui.Post(delegate
                {
                    if (state == "available")
                    {
                        string v = Program.Text(j, "version");
                        if (MessageBox.Show("Files Direct " + v + " is ready. Install it now? Files Direct closes and opens again.", "Files Direct", MessageBoxButtons.YesNo, MessageBoxIcon.Question) == DialogResult.Yes)
                            ThreadPool.QueueUserWorkItem(delegate { Install(); });
                    }
                    else if (state == "current") Say("Files Direct is up to date", "You have the newest version (" + version + ").");
                    else Say("No update", Program.Text(j, "message") ?? "Files Direct could not look for an update.");
                }, null);
            });
        }

        void Install()
        {
            int status;
            Dictionary<string, object> j = Program.LastJson(Program.Run("update install --json", out status));
            ui.Post(delegate
            {
                if (status == 0) Quit(); // the installer is running: it closes this program anyway
                else Say("The update was not installed", Program.Text(j, "message") ?? "Something went wrong. Nothing was changed.");
            }, null);
        }

        void RemoveApp()
        {
            if (MessageBox.Show("Remove Files Direct? This takes \"Send with Files Direct\" out of the right-click menu and Send to, and removes the app. Files you sent or received stay where they are.", "Files Direct", MessageBoxButtons.YesNo, MessageBoxIcon.Question) != DialogResult.Yes) return;
            string uninstaller = Path.Combine(Path.GetDirectoryName(Application.ExecutablePath), "unins000.exe");
            try
            {
                ProcessStartInfo psi = new ProcessStartInfo(uninstaller, "/SILENT");
                psi.UseShellExecute = false;
                Process.Start(psi);
            }
            catch (Exception)
            {
                Say("Remove Files Direct", "Open Settings, then Apps, find Files Direct and choose Uninstall.");
                return;
            }
            Quit();
        }

        void Quit()
        {
            icon.Visible = false;
            ExitThread();
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing) { icon.Dispose(); menu.Dispose(); quitSignal.Close(); }
            base.Dispose(disposing);
        }
    }
}
