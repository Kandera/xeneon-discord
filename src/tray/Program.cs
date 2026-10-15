using System;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.Net;
using System.Reflection;
using System.Text;
using System.Threading;
using System.Windows.Forms;

internal static class Program
{
    private const string MutexName = "Local\\XeneonDiscordEdge";
    private static readonly object LogLock = new object();
    private static NotifyIcon tray;
    private static ToolStripMenuItem statusItem;
    private static ToolStripMenuItem startupItem;
    private static Process node;
    private static bool quitting;
    private static string status = "Starting…";
    private static string root;
    private static string logFile;

    [STAThread]
    private static void Main()
    {
        bool created;
        using (Mutex mutex = new Mutex(true, MutexName, out created))
        {
            if (!created) return;
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            root = Directory.GetParent(Path.GetDirectoryName(Application.ExecutablePath)).FullName;
            logFile = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "XeneonDiscord", "bridge.log");
            Directory.CreateDirectory(Path.GetDirectoryName(logFile));
            tray = new NotifyIcon
            {
                Icon = MakeIcon(),
                Visible = true,
                Text = "Discord Edge",
            };
            statusItem = new ToolStripMenuItem("Starting…") { Enabled = false };
            startupItem = new ToolStripMenuItem("Start with Windows") { Checked = StartupExists() };
            startupItem.Click += delegate { ToggleStartup(); };
            ToolStripMenuItem quit = new ToolStripMenuItem("Quit");
            quit.Click += delegate { Quit(); };
            ContextMenuStrip menu = new ContextMenuStrip();
            string marker = Path.Combine(Path.GetDirectoryName(logFile), "tray-installed");
            if (!File.Exists(marker))
            {
                CreateStartup();
                File.WriteAllText(marker, "1");
            }
            menu.Items.Add(statusItem);
            menu.Items.Add(startupItem);
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add(quit);
            tray.ContextMenuStrip = menu;
            startupItem.Checked = StartupExists();
            StartNode();
            System.Windows.Forms.Timer timer = new System.Windows.Forms.Timer { Interval = 2000 };
            timer.Tick += delegate { RefreshStatus(); };
            timer.Start();
            ThreadPool.QueueUserWorkItem(delegate { PollLoop(); });
            tray.ShowBalloonTip(2500, "Discord Edge", "Running in the tray.", ToolTipIcon.None);
            Application.Run();
            GC.KeepAlive(mutex);
        }
    }

    private static void StartNode()
    {
        string nodePath = FindNode();
        string entry = Path.Combine(root, "src", "index.ts");
        if (nodePath == null || !File.Exists(entry))
        {
            status = nodePath == null ? "node.exe was not found." : "Bridge files are missing.";
            Log(status);
            return;
        }
        ProcessStartInfo info = new ProcessStartInfo
        {
            FileName = nodePath,
            Arguments = "\"" + entry + "\"",
            WorkingDirectory = root,
            UseShellExecute = false,
            CreateNoWindow = true,
            WindowStyle = ProcessWindowStyle.Hidden,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            StandardOutputEncoding = Encoding.UTF8,
            StandardErrorEncoding = Encoding.UTF8,
        };
        node = Process.Start(info);
        node.EnableRaisingEvents = true;
        node.OutputDataReceived += delegate(object sender, DataReceivedEventArgs args) { Log(args.Data); };
        node.ErrorDataReceived += delegate(object sender, DataReceivedEventArgs args) { Log(args.Data); };
        node.BeginOutputReadLine();
        node.BeginErrorReadLine();
        node.Exited += delegate
        {
            if (quitting) return;
            Thread.Sleep(3000);
            if (!quitting) StartNode();
        };
    }

    private static void PollLoop()
    {
        while (!quitting)
        {
            status = ReadPhase();
            Thread.Sleep(2000);
        }
    }

    private static string ReadPhase()
    {
        try
        {
            HttpWebRequest request = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:47331/v1/state");
            request.Timeout = 800;
            request.Headers["X-Edge-Discord"] = "1";
            using (HttpWebResponse response = (HttpWebResponse)request.GetResponse())
            using (StreamReader reader = new StreamReader(response.GetResponseStream()))
            {
                string body = reader.ReadToEnd();
                string phase = Between(body, "\"phase\":\"", "\"");
                string detail = Between(body, "\"detail\":\"", "\"");
                if (phase == "ready") return "Connected";
                if (phase == "discord-down") return "Discord is not open";
                if (phase == "authorizing") return "Waiting for Discord";
                if (phase == "need-setup") return "Needs a Discord app";
                if (phase == "error") return string.IsNullOrEmpty(detail) ? "Connection failed" : detail;
                return string.IsNullOrEmpty(phase) ? "Starting…" : phase;
            }
        }
        catch
        {
            return node == null || node.HasExited ? "Bridge stopped" : "Starting…";
        }
    }

    private static void RefreshStatus()
    {
        string text = status ?? "Discord Edge";
        if (text.Length > 60) text = text.Substring(0, 60);
        statusItem.Text = text;
        tray.Text = "Discord Edge — " + text;
    }

    private static string Between(string source, string start, string end)
    {
        int from = source.IndexOf(start, StringComparison.Ordinal);
        if (from < 0) return "";
        from += start.Length;
        int to = source.IndexOf(end, from, StringComparison.Ordinal);
        return to < 0 ? "" : source.Substring(from, to - from);
    }

    private static string FindNode()
    {
        string bundled = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "nodejs", "node.exe");
        if (File.Exists(bundled)) return bundled;
        try
        {
            ProcessStartInfo info = new ProcessStartInfo("where.exe", "node")
            {
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
            };
            using (Process where = Process.Start(info))
            {
                string line = where.StandardOutput.ReadLine();
                where.WaitForExit(2000);
                if (!string.IsNullOrEmpty(line) && File.Exists(line)) return line;
            }
        }
        catch
        {
            return null;
        }
        return null;
    }

    private static string StartupPath()
    {
        return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Startup), "Discord Edge.lnk");
    }

    private static bool StartupExists()
    {
        return File.Exists(StartupPath());
    }

    private static void ToggleStartup()
    {
        if (StartupExists()) File.Delete(StartupPath());
        else CreateStartup();
        startupItem.Checked = StartupExists();
    }

    private static void CreateStartup()
    {
        Type shellType = Type.GetTypeFromProgID("WScript.Shell");
        object shell = Activator.CreateInstance(shellType);
        object shortcut = shellType.InvokeMember("CreateShortcut", BindingFlags.InvokeMethod, null, shell, new object[] { StartupPath() });
        Type shortcutType = shortcut.GetType();
        shortcutType.InvokeMember("TargetPath", BindingFlags.SetProperty, null, shortcut, new object[] { Application.ExecutablePath });
        shortcutType.InvokeMember("WorkingDirectory", BindingFlags.SetProperty, null, shortcut, new object[] { root });
        shortcutType.InvokeMember("Description", BindingFlags.SetProperty, null, shortcut, new object[] { "Discord Edge" });
        shortcutType.InvokeMember("Save", BindingFlags.InvokeMethod, null, shortcut, null);
    }

    private static Icon MakeIcon()
    {
        Bitmap bitmap = new Bitmap(32, 32);
        using (Graphics graphics = Graphics.FromImage(bitmap))
        {
            graphics.SmoothingMode = SmoothingMode.AntiAlias;
            graphics.Clear(Color.Transparent);
            using (Brush panel = new SolidBrush(Color.FromArgb(22, 24, 30)))
                graphics.FillEllipse(panel, 1, 1, 30, 30);
            using (Brush dot = new SolidBrush(Color.FromArgb(61, 220, 140)))
                graphics.FillEllipse(dot, 9, 9, 14, 14);
        }
        return Icon.FromHandle(bitmap.GetHicon());
    }

    private static void Log(string line)
    {
        if (string.IsNullOrEmpty(line)) return;
        lock (LogLock)
        {
            File.AppendAllText(logFile, DateTime.Now.ToString("HH:mm:ss ") + line + Environment.NewLine);
        }
    }

    private static void Quit()
    {
        quitting = true;
        try
        {
            if (node != null && !node.HasExited) node.Kill();
        }
        catch
        {
            // already gone
        }
        tray.Visible = false;
        Application.Exit();
    }
}
