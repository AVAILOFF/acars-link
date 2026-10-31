// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

using System.Diagnostics;

namespace AcarsBridge;

/// <summary>
/// The process that started the bridge (<c>--parent-pid</c>, T80). The app stops the bridge itself, but when
/// its main process is killed (Task Manager, a crash) nobody does: the bridge would keep the port with a stale
/// launch token (T65) and the next start would get "port in use" (T75). Watching the parent ends the bridge
/// with it.
/// </summary>
public sealed class ParentProcess : IDisposable
{
    private readonly Process _process;

    private ParentProcess(Process process, Task exited)
    {
        _process = process;
        Exited = exited;
    }

    /// <summary>Completes when the parent has exited.</summary>
    public Task Exited { get; }

    /// <summary>
    /// Opens the process <paramref name="pid"/>; null when it is gone already. The handle stays open while
    /// the bridge runs, so a later process that reuses the PID is not mistaken for the parent.
    /// </summary>
    public static ParentProcess? Open(int pid)
    {
        Process process;
        try
        {
            process = Process.GetProcessById(pid);
        }
        catch (ArgumentException)
        {
            return null; // no such process
        }
        try
        {
            // Opens the handle (SYNCHRONIZE) and holds it; an exit from here on is reported.
            var exited = process.WaitForExitAsync();
            if (process.HasExited)
            {
                process.Dispose();
                return null;
            }
            return new ParentProcess(process, exited);
        }
        catch (InvalidOperationException)
        {
            // Exited between the lookup and opening the handle.
            process.Dispose();
            return null;
        }
        catch
        {
            // The handle cannot be opened (Win32Exception, access denied): the caller decides, not "gone".
            process.Dispose();
            throw;
        }
    }

    /// <summary>The line the bridge prints when it stops because the parent is gone (stdout, bridge.log).</summary>
    public static string GoneMessage(int pid) => $"{Protocol.BridgeName}: parent process {pid} has exited, stopping";

    public void Dispose() => _process.Dispose();
}
