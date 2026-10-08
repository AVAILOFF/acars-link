using System.Net;
using System.Net.WebSockets;
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
    /// No Origin (native clients: Electron main process, Node), <c>file://</c> / <c>null</c>
    /// (packaged Electron renderer) or a loopback http(s) origin (dev server). Anything else — a site
    /// on the internet — is rejected.
    /// </summary>
    public static bool IsAllowedOrigin(string? origin)
    {
        if (string.IsNullOrEmpty(origin)) return true;
        if (origin is "null" or "file://") return true;
        if (!Uri.TryCreate(origin, UriKind.Absolute, out var uri)) return false;
        return uri.Scheme is "http" or "https" && uri.Host is "127.0.0.1" or "localhost";
    }
}

/// <summary>WebSocket server on 127.0.0.1 that streams <see cref="BridgeHub"/> frames.</summary>
public static class BridgeServer
{
    public const int DefaultPort = 47830;
    public const string Path = "/";

    public static WebApplication Build(BridgeHub hub, int port, LogLevel logLevel = LogLevel.Warning)
    {
        var builder = WebApplication.CreateSlimBuilder();
        builder.Logging.SetMinimumLevel(logLevel);
        // Loopback IPv4 only. Never Any/IPv6Any (invariant 10).
        builder.WebHost.ConfigureKestrel(o => o.Listen(IPAddress.Loopback, port));

        var app = builder.Build();
        app.UseWebSockets(new WebSocketOptions { KeepAliveInterval = TimeSpan.FromSeconds(15) });
        app.Map(Path, ctx => Handle(ctx, hub));
        return app;
    }

    private static async Task Handle(HttpContext ctx, BridgeHub hub)
    {
        if (!AccessPolicy.IsAllowedHost(ctx.Request.Host.Value)
            || !AccessPolicy.IsAllowedOrigin(ctx.Request.Headers.Origin))
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

        using var ws = await ctx.WebSockets.AcceptWebSocketAsync();
        var (id, reader) = hub.Subscribe();
        using var cts = CancellationTokenSource.CreateLinkedTokenSource(ctx.RequestAborted);
        try
        {
            var receive = DrainInbound(ws, cts.Token);
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
        }
    }

    private static async Task Pump(WebSocket ws, System.Threading.Channels.ChannelReader<string> reader, CancellationToken ct)
    {
        await foreach (var frame in reader.ReadAllAsync(ct))
            await ws.SendAsync(Encoding.UTF8.GetBytes(frame), WebSocketMessageType.Text, true, ct);
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
