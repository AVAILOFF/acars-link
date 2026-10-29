// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

using System.Net;
using System.Net.WebSockets;
using System.Security.Cryptography;
using System.Text;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Logging;

namespace AcarsBridge;

/// <summary>
/// Who may connect. The server already listens on 127.0.0.1 only (CLAUDE.md, invariant 10); this
/// also blocks other web pages open in a browser on the same machine (cross-site WebSocket) and DNS
/// rebinding.
/// </summary>
public static class AccessPolicy
{
    /// <summary>Host header must name the loopback address (any port).</summary>
    public static bool IsAllowedHost(string? host)
    {
        if (string.IsNullOrEmpty(host)) return false;
        var name = HostString.FromUriComponent(host).Host;
        return name is "127.0.0.1" or "localhost";
    }

    /// <summary>
    /// No Origin only: the app connects from its main process (Node <c>WebSocket</c>), which sends none
    /// (T65). Every web origin is refused, <c>null</c> (sandboxed iframe on any site) and
    /// <c>file://</c> included; the app's renderer never connects to the bridge, so no loopback
    /// exception for the dev server is needed either.
    /// </summary>
    public static bool IsAllowedOrigin(string? origin) => string.IsNullOrEmpty(origin);

    /// <summary>Header that carries the launch token (T65).</summary>
    public const string TokenHeader = "X-Acars-Bridge-Token";

    /// <summary>Environment variable the app passes the launch token in (not the command line: T65).</summary>
    public const string TokenVariable = "ACARS_BRIDGE_TOKEN";

    /// <summary>
    /// <paramref name="expected"/> null: a bridge started by hand, any token or none passes. Else the
    /// client must present the same token; compared in constant time.
    /// </summary>
    public static bool IsValidToken(string? expected, string? presented)
    {
        if (expected is null) return true;
        if (presented is null) return false;
        return CryptographicOperations.FixedTimeEquals(Encoding.UTF8.GetBytes(expected), Encoding.UTF8.GetBytes(presented));
    }
}

/// <summary>
/// WebSocket server on 127.0.0.1 that streams <see cref="BridgeHub"/> frames. A client asking for
/// <c>?protocol=2</c> may send commands (<see cref="CommandDispatcher"/>); the <c>ack</c> goes to it alone.
/// With a launch <c>token</c> (set by the app, T65) a client without the same
/// <see cref="AccessPolicy.TokenHeader"/> gets 403.
/// </summary>
public static class BridgeServer
{
    public const int DefaultPort = 47830;
    public const string Path = "/";

    public static WebApplication Build(BridgeHub hub, int port, CommandDispatcher? commands = null, LogLevel logLevel = LogLevel.Warning,
        string? token = null)
    {
        var dispatcher = commands ?? new CommandDispatcher(null, TimeProvider.System);
        var builder = WebApplication.CreateSlimBuilder();
        builder.Logging.SetMinimumLevel(logLevel);
        // Loopback IPv4 only. Never Any/IPv6Any (invariant 10).
        builder.WebHost.ConfigureKestrel(o => o.Listen(IPAddress.Loopback, port));

        var app = builder.Build();
        app.UseWebSockets(new WebSocketOptions { KeepAliveInterval = TimeSpan.FromSeconds(15) });
        app.Map(Path, ctx => Handle(ctx, hub, dispatcher, token));
        return app;
    }

    private static async Task Handle(HttpContext ctx, BridgeHub hub, CommandDispatcher commands, string? token)
    {
        if (!AccessPolicy.IsAllowedHost(ctx.Request.Host.Value)
            || !AccessPolicy.IsAllowedOrigin(ctx.Request.Headers.Origin)
            || !AccessPolicy.IsValidToken(token, ctx.Request.Headers[AccessPolicy.TokenHeader].FirstOrDefault()))
        {
            ctx.Response.StatusCode = StatusCodes.Status403Forbidden;
            return;
        }
        if (!ctx.WebSockets.IsWebSocketRequest)
        {
            ctx.Response.StatusCode = StatusCodes.Status426UpgradeRequired;
            await ctx.Response.WriteAsync($"{Protocol.BridgeName}: WebSocket only\n");
            return;
        }

        var protocol = Protocol.Negotiate(ctx.Request.Query["protocol"].FirstOrDefault());
        using var ws = await ctx.WebSockets.AcceptWebSocketAsync();
        var (id, reader) = hub.Subscribe(protocol);
        using var cts = CancellationTokenSource.CreateLinkedTokenSource(ctx.RequestAborted);
        try
        {
            var receive = protocol >= 2 ? ReadCommands(ws, id, hub, commands, cts.Token) : DrainInbound(ws, cts.Token);
            var send = Pump(ws, reader, cts.Token);
            await Task.WhenAny(receive, send);
            await cts.CancelAsync();
            if (ws.State is WebSocketState.Open or WebSocketState.CloseReceived)
                await ws.CloseOutputAsync(WebSocketCloseStatus.NormalClosure, "bye", CancellationToken.None);
        }
        catch (Exception e) when (e is WebSocketException or OperationCanceledException)
        {
        }
        finally
        {
            hub.Unsubscribe(id);
            commands.Forget(id);
        }
    }

    private static async Task Pump(WebSocket ws, System.Threading.Channels.ChannelReader<string> reader, CancellationToken ct)
    {
        await foreach (var frame in reader.ReadAllAsync(ct))
            await ws.SendAsync(Encoding.UTF8.GetBytes(frame), WebSocketMessageType.Text, true, ct);
    }

    /// <summary>
    /// Protocol v2: each text message is one command, run in order; the <c>ack</c> is queued to this
    /// client. Messages over <see cref="CommandCatalog.MaxFrameBytes"/> and binary ones are refused
    /// (<c>bad_frame</c>) without being parsed.
    /// </summary>
    private static async Task ReadCommands(WebSocket ws, Guid client, BridgeHub hub, CommandDispatcher commands, CancellationToken ct)
    {
        var buffer = new byte[CommandCatalog.MaxFrameBytes];
        while (ws.State == WebSocketState.Open)
        {
            var length = 0;
            var tooLong = false;
            ValueWebSocketReceiveResult r;
            do
            {
                if (length == buffer.Length)
                {
                    tooLong = true;
                    length = 0; // keep reading to the end of the message, drop the bytes
                }
                r = await ws.ReceiveAsync(buffer.AsMemory(length), ct);
                if (r.MessageType == WebSocketMessageType.Close) return;
                length += r.Count;
            } while (!r.EndOfMessage);

            string ack;
            if (tooLong || r.MessageType != WebSocketMessageType.Text)
                ack = Protocol.Ack(null, CommandResult.Fail(CommandErrors.BadFrame, tooLong ? "frame too long" : "text frames only"));
            else
                ack = await commands.HandleAsync(client, Encoding.UTF8.GetString(buffer, 0, length), ct);
            hub.Send(client, ack);
        }
    }

    /// <summary>Protocol v1 has no client → bridge messages: read and discard until close.</summary>
    private static async Task DrainInbound(WebSocket ws, CancellationToken ct)
    {
        var buffer = new byte[1024];
        while (ws.State == WebSocketState.Open)
        {
            var r = await ws.ReceiveAsync(buffer, ct);
            if (r.MessageType == WebSocketMessageType.Close) return;
        }
    }
}
