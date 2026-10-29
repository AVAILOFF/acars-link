// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

using AcarsBridge;

namespace AcarsBridge.Tests;

public class ReconnectPolicyTests
{
    [Fact]
    public void Backoff_doubles_up_to_cap_and_resets()
    {
        var p = new ReconnectPolicy();
        var seconds = Enumerable.Range(0, 8).Select(_ => p.NextDelay().TotalSeconds).ToArray();
        Assert.Equal([1, 2, 4, 8, 16, 30, 30, 30], seconds);
        p.Reset();
        Assert.Equal(TimeSpan.FromSeconds(1), p.NextDelay());
    }

    [Fact]
    public void Many_attempts_do_not_overflow()
    {
        var p = new ReconnectPolicy();
        for (var i = 0; i < 10_000; i++) p.NextDelay();
        Assert.Equal(TimeSpan.FromSeconds(30), p.NextDelay());
    }
}

public class SimQueueTests
{
    [Fact]
    public void Drains_every_waiting_message_on_one_wake_up()
    {
        // Frames pile up between wake-ups; one ReceiveMessage handles one of them.
        var waiting = 300;
        var handled = 0L;
        var calls = 0;
        void Receive()
        {
            calls++;
            if (waiting == 0) return;
            waiting--;
            handled++;
        }

        Assert.Equal(300, SimQueue.Drain(Receive, () => handled));
        Assert.Equal(0, waiting);
        Assert.Equal(301, calls);
    }

    [Fact]
    public void An_empty_queue_takes_one_call()
    {
        var calls = 0;
        Assert.Equal(0, SimQueue.Drain(() => calls++, () => 0));
        Assert.Equal(1, calls);
    }

    [Fact]
    public void A_flood_stops_at_the_bound()
    {
        var handled = 0L;
        Assert.Equal(10, SimQueue.Drain(() => handled++, () => handled, max: 10));
        Assert.Equal(10, handled);
    }
}

public class SnapshotPumpTests
{
    private readonly ManualClock _clock = ManualClock.At(1_000_000);
    private readonly List<TelemetrySnapshot> _out = [];
    private readonly SnapshotPump _pump;

    public SnapshotPumpTests() => _pump = new SnapshotPump(_clock, _out.Add);

    private void Step(int ms) => _clock.Advance(TimeSpan.FromMilliseconds(ms));

    [Fact]
    public void Nothing_is_emitted_until_sim_runs()
    {
        _pump.OnFrame(Frames.Sample());
        _pump.Tick();
        Assert.Empty(_out);

        Assert.True(_pump.OnSimRunning(true));
        Assert.False(_pump.OnSimRunning(true));
        _pump.OnFrame(Frames.Sample());
        Assert.Single(_out);
    }

    [Fact]
    public void Frames_are_throttled_to_about_1hz_wall()
    {
        _pump.OnSimRunning(true);
        // Sim rate ×4: SECOND period may fire every 250 ms of wall time.
        for (var i = 0; i < 16; i++)
        {
            _pump.OnFrame(Frames.Sample().With(SimVars.SimRate, 4));
            Step(250);
        }
        Assert.Equal(4, _out.Count);
        Assert.All(_out, s => Assert.Equal(4, s.SimRate));
        Assert.Equal(4, _pump.SimRate);
    }

    [Fact]
    public void Pause_change_reemits_at_once_when_stream_is_idle()
    {
        _pump.OnSimRunning(true);
        _pump.OnFrame(Frames.Sample());
        Step(1000);

        Assert.True(_pump.OnPauseFlags(4)); // active pause
        Assert.Equal(2, _out.Count);
        Assert.True(_out[^1].Paused);
        Assert.False(_pump.OnPauseFlags(1)); // still paused (different flag)
    }

    [Fact]
    public void Pause_change_soon_after_a_snapshot_waits_for_min_interval_then_keepalive_continues()
    {
        _pump.OnSimRunning(true);
        _pump.OnFrame(Frames.Sample());
        Step(100);

        _pump.OnPauseFlags(1);
        Assert.Single(_out); // too soon: pending

        // Sim stops sending data while paused; Tick delivers the pending change, then a ~1.5 s heartbeat.
        for (var i = 0; i < 12; i++)
        {
            Step(250);
            _pump.Tick();
        }
        // t = 1100 pending pause, t = 2600 keepalive
        Assert.Equal(3, _out.Count);
        Assert.All(_out.Skip(1), s => Assert.True(s.Paused));
        Assert.Equal(1500, _out[2].T - _out[1].T);

        Step(1000);
        Assert.True(_pump.OnPauseFlags(0));
        Assert.False(_out[^1].Paused);
    }

    [Fact]
    public void Pause_flapping_while_flight_loads_stays_at_1hz_and_ends_in_final_state()
    {
        // Seen in MSFS 2024: 13 pause toggles within one second during flight load.
        _pump.OnSimRunning(true);
        _pump.OnFrame(Frames.Sample());
        for (var i = 0; i < 13; i++)
        {
            _pump.OnPauseFlags(i % 2 == 0 ? 1u : 0u);
            Step(70);
            _pump.Tick();
        }
        for (var i = 0; i < 8; i++)
        {
            Step(250);
            _pump.Tick();
        }

        for (var i = 1; i < _out.Count; i++)
            Assert.True(_out[i].T - _out[i - 1].T >= SnapshotPump.MinInterval.TotalMilliseconds);
        Assert.True(_pump.Paused); // 13 toggles starting from "paused" → paused
        Assert.Equal(_pump.Paused, _out[^1].Paused);
    }

    [Fact]
    public void Sim_stop_drops_stale_frame()
    {
        _pump.OnSimRunning(true);
        _pump.OnFrame(Frames.Sample());
        _pump.OnSimRunning(false);
        _pump.OnSimRunning(true);
        Step(5000);
        _pump.Tick();
        _pump.OnPauseFlags(1);
        Assert.Single(_out);
    }

    [Fact]
    public void Reset_clears_state()
    {
        _pump.OnSimRunning(true);
        _pump.OnPauseFlags(1);
        _pump.OnFrame(Frames.Sample().With(SimVars.SimRate, 2));
        _pump.Reset();
        Assert.False(_pump.Running);
        Assert.False(_pump.Paused);
        Assert.Equal(1, _pump.SimRate);
    }
}

public class AccessPolicyTests
{
    [Theory]
    [InlineData(null, true)]
    [InlineData("", true)]
    [InlineData("null", false)] // sandboxed iframe on any site (T65)
    [InlineData("file://", false)]
    [InlineData("http://localhost:5173", false)]
    [InlineData("http://127.0.0.1:5173", false)]
    [InlineData("https://evil.example", false)]
    [InlineData("http://127.0.0.1.evil.example", false)]
    [InlineData("http://192.168.1.10:5173", false)]
    [InlineData("chrome-extension://abc", false)]
    [InlineData("not a url", false)]
    public void Origin(string? origin, bool allowed) => Assert.Equal(allowed, AccessPolicy.IsAllowedOrigin(origin));

    [Theory]
    [InlineData("127.0.0.1:47830", true)]
    [InlineData("localhost:47830", true)]
    [InlineData("localhost", true)]
    [InlineData("evil.example:47830", false)]
    [InlineData("192.168.1.10:47830", false)]
    [InlineData("", false)]
    [InlineData(null, false)]
    public void Host(string? host, bool allowed) => Assert.Equal(allowed, AccessPolicy.IsAllowedHost(host));

    [Theory]
    [InlineData(null, null, true)] // started by hand: no token needed
    [InlineData(null, "anything", true)]
    [InlineData("s3cret-token", "s3cret-token", true)]
    [InlineData("s3cret-token", null, false)]
    [InlineData("s3cret-token", "", false)]
    [InlineData("s3cret-token", "s3cret-tokeN", false)]
    [InlineData("s3cret-token", "s3cret-token2", false)]
    public void Token(string? expected, string? presented, bool allowed) =>
        Assert.Equal(allowed, AccessPolicy.IsValidToken(expected, presented));
}
