import { spawn } from 'node:child_process';

// Desktop notifications without npm dependencies. Text goes in through environment
// variables or argv (never pasted into a script), so page content can't inject commands.

const WINDOWS_TOAST = `
$ErrorActionPreference = 'Stop'
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] > $null
$xml = New-Object Windows.Data.Xml.Dom.XmlDocument
$xml.LoadXml("<toast><visual><binding template='ToastGeneric'><text></text><text></text></binding></visual></toast>")
$nodes = $xml.GetElementsByTagName('text')
$nodes.Item(0).AppendChild($xml.CreateTextNode($env:TITEN_TITLE)) > $null
$nodes.Item(1).AppendChild($xml.CreateTextNode($env:TITEN_MESSAGE)) > $null
$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)
$app = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($app).Show($toast)
`;

function run(cmd, args, env) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { env: { ...process.env, ...env }, stdio: 'ignore', windowsHide: true });
    } catch {
      return resolve(false);
    }
    const timer = setTimeout(() => {
      child.kill();
      resolve(false);
    }, 15_000);
    child.on('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
  });
}

/** Show a desktop notification. Returns true when the OS accepted it. */
export async function notify({ title, message }) {
  if (process.env.TITEN_NOTIFY === '0') return false;
  const t = String(title || 'Titen').slice(0, 120);
  const m = String(message || '').slice(0, 300);
  let ok = false;
  if (process.platform === 'win32') {
    ok = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', WINDOWS_TOAST], { TITEN_TITLE: t, TITEN_MESSAGE: m });
  } else if (process.platform === 'darwin') {
    ok = await run('osascript', ['-e', 'on run argv', '-e', 'display notification (item 2 of argv) with title (item 1 of argv)', '-e', 'end run', t, m]);
  } else {
    ok = await run('notify-send', ['--app-name=Titen', t, m]);
  }
  if (!ok && process.stdout.isTTY) process.stdout.write('\x07'); // terminal bell as a last resort
  return ok;
}
