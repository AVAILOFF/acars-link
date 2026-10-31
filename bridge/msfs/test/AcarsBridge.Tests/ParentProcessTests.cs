// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

using System.Diagnostics;
using System.Net;
using System.Net.Sockets;
using System.Text;

namespace AcarsBridge.Tests;

/// <summary>T80: the bridge stops when the process that started it (<c>--parent-pid</c>) is gone.</summary>
public class ParentProcessTests
{
    private static readonly TimeSpan Wait = TimeSpan.FromSeconds(15);

    /// <summary>A stand-in for the app: a process that runs until killed.</summary>
    private static Process StartParent() =>
        Process.Start(new ProcessStartInfo(Path.Combine(Environment.SystemDirectory, "ping.exe"), "-n 120 127.0.0.1")
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
        })!;

    /// <summary>The PID of a process that has exited (not reused this soon).</summary>
    private static int GonePid()
    {
        using var p = StartParent();
        p.Kill();
        p.WaitForExit();
        return p.Id;
    }

    private static int FreePort()
    {
        var l = new TcpListener(IPAddress.Loopback, 0);
        l.Start();
        var port = ((IPEndPoint)l.LocalEndpoint).Port;
        l.Stop();
        return port;
    }

    /// <summary>The bridge exe next to the tests (project reference), with a fake source.</summary>
    private sealed class Bridge : IDisposable
    {
        private readonly StringBuilder _out = new();
        public Process Process { get; }

        public Bridge(params string[] args)
        {
            var info = new ProcessStartInfo(Path.Combine(AppContext.BaseDirectory, "acars-msfs-bridge.exe"))
            {
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
            };
            foreach (var a in (string[])["--source", "fake", "--port", FreePort().ToString(), .. args]) info.ArgumentList.Add(a);
            info.Environment.Remove(AccessPolicy.TokenVariable);
            Process = Process.Start(info)!;
            Process.OutputDataReceived += (_, e) => { lock (_out) _out.AppendLine(e.Data); };
            Process.ErrorDataReceived += (_, e) => { lock (_out) _out.AppendLine(e.Data); };
            Process.BeginOutputReadLine();
            Process.BeginErrorReadLine();
        }

        public string Output
        {
            get { lock (_out) return _out.ToString(); }
        }

        /// <summary>Waits for a line on stdout or stderr.</summary>
        public async Task WaitForOutput(string text)
        {
            var until = DateTime.UtcNow + Wait;
            while (!Output.Contains(text))
            {
                Assert.True(DateTime.UtcNow < until && !Process.HasExited, $"no \"{text}\" in:\n{Output}");
                await Task.Delay(50);
            }
        }

        public void Dispose()
        {
            if (!Process.HasExited) Process.Kill();
            Process.Dispose();
        }
    }

    [Fact]
    public async Task Open_follows_a_running_process_until_it_exits()
    {
        using var parent = StartParent();
        using var watch = ParentProcess.Open(parent.Id);
        Assert.NotNull(watch);
        await Task.Delay(200);
        Assert.False(watch.Exited.IsCompleted);

        parent.Kill();
        await watch.Exited.WaitAsync(Wait);
    }

    [Fact]
    public void Open_of_a_process_that_is_gone_is_null()
    {
        Assert.Null(ParentProcess.Open(GonePid()));
    }

    [Fact]
    public async Task The_bridge_stops_with_code_0_when_its_parent_exits()
    {
        using var parent = StartParent();
        using var bridge = new Bridge("--parent-pid", parent.Id.ToString());
        await bridge.WaitForOutput("listening on");

        parent.Kill();
        using var timeout = new CancellationTokenSource(Wait);
        await bridge.Process.WaitForExitAsync(timeout.Token);

        Assert.Equal(ExitCodes.Ok, bridge.Process.ExitCode);
        Assert.Contains(ParentProcess.GoneMessage(parent.Id), bridge.Output);
    }

    [Fact]
    public async Task The_bridge_does_not_start_when_its_parent_is_gone()
    {
        var pid = GonePid();
        using var bridge = new Bridge("--parent-pid", pid.ToString());
        using var timeout = new CancellationTokenSource(Wait);
        await bridge.Process.WaitForExitAsync(timeout.Token);

        Assert.Equal(ExitCodes.Ok, bridge.Process.ExitCode);
        Assert.Contains(ParentProcess.GoneMessage(pid), bridge.Output);
        Assert.DoesNotContain("listening on", bridge.Output);
    }

    [Fact]
    public async Task Without_a_parent_the_bridge_keeps_running()
    {
        using var bridge = new Bridge();
        await bridge.WaitForOutput("listening on");
        await Task.Delay(1000);
        Assert.False(bridge.Process.HasExited, bridge.Output);
    }

    [Fact]
    public void A_bad_parent_pid_is_a_bad_argument()
    {
        foreach (var bad in new[] { "0", "-1", "x" })
        {
            using var bridge = new Bridge("--parent-pid", bad);
            Assert.True(bridge.Process.WaitForExit(Wait), bridge.Output);
            Assert.Equal(ExitCodes.BadArguments, bridge.Process.ExitCode);
        }
    }
}
