using System.Collections.Concurrent;
using System.Threading.Channels;

namespace AcarsBridge;

/// <summary>
/// Fan-out of protocol frames to WebSocket clients. Each client has a small bounded queue that drops
/// the oldest frame, so a stalled client never blocks the sim loop. Keeps the latest status and
/// telemetry so a new client gets the current state right after <c>hello</c>.
/// </summary>
public sealed class BridgeHub(string version, string source) : ISimSink
{
    private const int QueueCapacity = 32;

    private readonly ConcurrentDictionary<Guid, Channel<string>> _clients = new();
    private readonly object _gate = new();
    private string _status = Protocol.Status(BridgeStatus.Initial);
    private string? _telemetry;

    public BridgeStatus LastStatus { get; private set; } = BridgeStatus.Initial;
    public int ClientCount => _clients.Count;

    /// <summary>Registers a client; its queue starts with hello, status and the last telemetry.</summary>
    public (Guid Id, ChannelReader<string> Reader) Subscribe()
    {
        var ch = Channel.CreateBounded<string>(new BoundedChannelOptions(QueueCapacity)
        {
            FullMode = BoundedChannelFullMode.DropOldest,
            SingleReader = true,
        });
        var id = Guid.NewGuid();
        lock (_gate)
        {
            ch.Writer.TryWrite(Protocol.Hello(version, source));
            ch.Writer.TryWrite(_status);
            if (_telemetry is not null) ch.Writer.TryWrite(_telemetry);
            _clients[id] = ch;
        }
        return (id, ch.Reader);
    }

    public void Unsubscribe(Guid id)
    {
        if (_clients.TryRemove(id, out var ch)) ch.Writer.TryComplete();
    }

    public void OnStatus(BridgeStatus status)
    {
        var frame = Protocol.Status(status);
        lock (_gate)
        {
            if (status == LastStatus) return;
            LastStatus = status;
            _status = frame;
            if (status.Sim != SimLink.Connected || !status.Running) _telemetry = null;
            Broadcast(frame);
        }
    }

    public void OnTelemetry(TelemetrySnapshot snapshot)
    {
        var frame = Protocol.Telemetry(snapshot);
        lock (_gate)
        {
            _telemetry = frame;
            Broadcast(frame);
        }
    }

    public void Complete()
    {
        foreach (var id in _clients.Keys) Unsubscribe(id);
    }

    private void Broadcast(string frame)
    {
        foreach (var ch in _clients.Values) ch.Writer.TryWrite(frame);
    }
}
