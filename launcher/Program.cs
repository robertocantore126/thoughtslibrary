using System.Diagnostics;
using System.Net.Sockets;
using System.Windows.Forms;

const int Port = 5173;
const string Url = "http://127.0.0.1:5173/";

var appDir = AppContext.BaseDirectory;
var projectDir = FindProjectDirectory(appDir);
if (projectDir is null)
{
  MessageBox.Show(
    $"Could not find package.json near:\n{appDir}\n\nPlace this launcher inside the thoughtslibrary project.",
    "ThoughtsLibrary Launcher",
    MessageBoxButtons.OK,
    MessageBoxIcon.Error
  );
  return;
}

if (!IsPortOpen("127.0.0.1", Port))
{
  try
  {
    var psi = new ProcessStartInfo
    {
      FileName = "npm.cmd",
      Arguments = "run dev -- --host 127.0.0.1 --port 5173",
      WorkingDirectory = projectDir,
      UseShellExecute = true,
      CreateNoWindow = false,
    };

    Process.Start(psi);
  }
  catch (Exception ex)
  {
    MessageBox.Show(
      $"Failed to start dev server.\n\n{ex.Message}",
      "ThoughtsLibrary Launcher",
      MessageBoxButtons.OK,
      MessageBoxIcon.Error
    );
    return;
  }
}

for (var i = 0; i < 30; i++)
{
  if (IsPortOpen("127.0.0.1", Port))
    break;

  Thread.Sleep(250);
}

try
{
  Process.Start(new ProcessStartInfo
  {
    FileName = Url,
    UseShellExecute = true,
  });
}
catch (Exception ex)
{
  MessageBox.Show(
    $"Server may be running, but browser could not be opened automatically.\n\nOpen manually: {Url}\n\n{ex.Message}",
    "ThoughtsLibrary Launcher",
    MessageBoxButtons.OK,
    MessageBoxIcon.Warning
  );
}

static bool IsPortOpen(string host, int port)
{
  try
  {
    using var client = new TcpClient();
    var result = client.BeginConnect(host, port, null, null);
    var success = result.AsyncWaitHandle.WaitOne(TimeSpan.FromMilliseconds(150));
    if (!success)
      return false;

    client.EndConnect(result);
    return true;
  }
  catch
  {
    return false;
  }
}

static string? FindProjectDirectory(string startDir)
{
  var current = new DirectoryInfo(startDir);
  while (current is not null)
  {
    var candidate = Path.Combine(current.FullName, "package.json");
    if (File.Exists(candidate))
      return current.FullName;

    current = current.Parent;
  }

  return null;
}
