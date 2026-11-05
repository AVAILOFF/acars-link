// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

using System.Collections.Concurrent;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace AcarsBridge;

/// <summary>A validated app → bridge command (protocol v2). <see cref="Args"/> holds flat JSON values only.</summary>
public sealed record SimCommand(string Id, string Name, IReadOnlyDictionary<string, JsonValue> Args);

/// <summary>Outcome of a command; <see cref="Error"/> is one of <see cref="CommandErrors"/>.</summary>
public sealed record CommandResult(bool Ok, string? Error = null, string? Detail = null)
{
    public static readonly CommandResult Success = new(true);

    public static CommandResult Fail(string error, string? detail = null) => new(false, error, detail);
}

/// <summary>Error codes of an <c>ack</c> frame.</summary>
public static class CommandErrors
{
    /// <summary>Not JSON, not an object, too long, or a bad <c>id</c> / <c>args</c> shape.</summary>
    public const string BadFrame = "bad_frame";
    /// <summary>Not in the whitelist (<see cref="CommandCatalog"/>) or not supported by this source.</summary>
    public const string UnknownCommand = "unknown_command";
    /// <summary>Arguments do not match the command.</summary>
    public const string BadArgs = "bad_args";
    /// <summary>Known command that cannot run now (sim not connected, add-on missing).</summary>
    public const string Unavailable = "unavailable";
    /// <summary>Too many commands from this client; nothing was done.</summary>
    public const string RateLimited = "rate_limited";
    /// <summary>The source tried and failed (or timed out).</summary>
    public const string Failed = "failed";
}

/// <summary>Executes commands in the simulator. Implemented by sim sources.</summary>
public interface ICommandTarget
{
    /// <summary>Command names this target can run (a subset of <see cref="CommandCatalog.Names"/>).</summary>
    IReadOnlyCollection<string> Commands { get; }

    /// <summary>Runs a command already checked by <see cref="CommandCatalog"/>. Must not throw for expected failures.</summary>
    Task<CommandResult> ExecuteAsync(SimCommand command, CancellationToken ct);
}

/// <summary>
/// Whitelist of commands and their arguments. Only names listed here are ever passed to a source.
/// <list type="bullet">
/// <item><c>ping</c>, no arguments: is the sim side ready for commands (ok, or <c>unavailable</c>).</item>
/// <item><c>smoke_start</c> (<c>lat</c>, <c>lon</c>) / <c>smoke_stop</c> (T34): a smoke column at a point, see <see cref="SmokeController"/>.</item>
/// <item><c>rescue_start</c> / <c>rescue_stop</c> (T54): rescue vehicles at the landing runway, see <see cref="RescueController"/>.</item>
/// </list>
/// New commands (T22 VDGS text, T34 effects) are added here with a validator, then implemented by a source.
/// </summary>
public static class CommandCatalog
{
    public const int MaxFrameBytes = 4096;
    public const int MaxArgs = 16;
    public const int MaxStringArg = 512;

    /// <summary>Validators: null = arguments are fine, otherwise why not.</summary>
    private static readonly Dictionary<string, Func<IReadOnlyDictionary<string, JsonValue>, string?>> Validators = new()
    {
        ["ping"] = args => args.Count == 0 ? null : "ping takes no arguments",
        ["smoke_start"] = ValidateSmokeStart,
        ["smoke_stop"] = args => args.Count == 0 ? null : "smoke_stop takes no arguments",
        ["rescue_start"] = ValidateRescueStart,
        ["rescue_stop"] = args => args.Count == 0 ? null : "rescue_stop takes no arguments",
    };

    private static readonly string[] RescueArgs = ["level", "thrLat", "thrLon", "hdg", "lengthM", "side", "fire", "fireFlip", "medic"];

    /// <summary>
    /// <c>rescue_start</c> (T54), the same rules as <c>checkRescueStart</c> in <c>@acars/core</c>: <c>level</c>
    /// <c>full</c> | <c>standby</c> | <c>medical</c>; the threshold <c>thrLat</c>, <c>thrLon</c>; <c>hdg</c> 0..360;
    /// <c>lengthM</c> 0..10000; <c>side</c> <c>left</c> | <c>right</c>; <c>fire</c> and <c>medic</c>: titles joined by <c>|</c>, at most
    /// <see cref="RescueController.MaxFire"/>, none empty; no fire trucks with <c>medical</c>.
    /// </summary>
    private static string? ValidateRescueStart(IReadOnlyDictionary<string, JsonValue> args)
    {
        // T88: an optional `ground: true`, a call on the ground.
        var ground = args.ContainsKey("ground") ? 1 : 0;
        if (args.Count != RescueArgs.Length + ground || !RescueArgs.All(args.ContainsKey))
            return $"rescue_start needs {string.Join(", ", RescueArgs)} only, and ground";
        if (ground == 1 && !(args["ground"].TryGetValue<bool>(out var g) && g)) return "ground must be true";
        if (!args["level"].TryGetValue<string>(out var level) || level is not ("full" or "standby" or "medical"))
            return "level must be full, standby or medical";
        if (!args["thrLat"].TryGetValue<double>(out var la) || !(la >= -90 && la <= 90)) return "thrLat must be -90..90";
        if (!args["thrLon"].TryGetValue<double>(out var lo) || !(lo >= -180 && lo <= 180)) return "thrLon must be -180..180";
        if (!args["hdg"].TryGetValue<double>(out var h) || !(h >= 0 && h < 360)) return "hdg must be 0..360";
        if (!args["lengthM"].TryGetValue<double>(out var len) || !(len > 0 && len <= 10_000)) return "lengthM must be 0..10000";
        if (!args["side"].TryGetValue<string>(out var side) || side is not ("left" or "right")) return "side must be left or right";
        foreach (var name in (string[])["fire", "medic"])
        {
            if (!args[name].TryGetValue<string>(out var v)) return $"{name} must be a string";
            var titles = v.Length == 0 ? [] : v.Split('|');
            if (titles.Length > RescueController.MaxFire) return $"{name}: at most {RescueController.MaxFire} titles";
            if (titles.Any(t => t.Trim().Length == 0 || t != t.Trim())) return $"{name}: empty title";
        }
        if (level == "medical" && args["fire"].GetValue<string>().Length > 0) return "medical takes no fire trucks";
        // fireFlip: 0 | 1 per fire truck, joined by | like fire (1 = the model is drawn nose to tail with its heading).
        if (!args["fireFlip"].TryGetValue<string>(out var flips)) return "fireFlip must be a string";
        var fire = args["fire"].GetValue<string>();
        var nFire = fire.Length == 0 ? 0 : fire.Split('|').Length;
        var f = flips.Length == 0 ? [] : flips.Split('|');
        if (f.Length != nFire || f.Any(x => x is not ("0" or "1"))) return "fireFlip: 0 or 1 per fire truck, joined by |";
        return null;
    }

    public static IReadOnlyCollection<string> Names => Validators.Keys;

    /// <summary><c>smoke_start</c>: exactly <c>lat</c> (-90..90) and <c>lon</c> (-180..180) as numbers.</summary>
    private static string? ValidateSmokeStart(IReadOnlyDictionary<string, JsonValue> args)
    {
        if (args.Count != 2 || !args.TryGetValue("lat", out var lat) || !args.TryGetValue("lon", out var lon))
            return "smoke_start needs lat and lon only";
        if (!lat.TryGetValue<double>(out var la) || !(la >= -90 && la <= 90)) return "lat must be a number -90..90";
        if (!lon.TryGetValue<double>(out var lo) || !(lo >= -180 && lo <= 180)) return "lon must be a number -180..180";
        return null;
    }

    private static readonly Regex IdRe = new("^[A-Za-z0-9._-]{1,64}$", RegexOptions.CultureInvariant);
    private static readonly Regex NameRe = new("^[a-z][a-z0-9_.]{0,47}$", RegexOptions.CultureInvariant);
    private static readonly Regex ArgNameRe = new("^[a-z][A-Za-z0-9_]{0,31}$", RegexOptions.CultureInvariant);

    /// <summary>
    /// Parses and validates one client frame <c>{"type":"command","id":…,"command":…,"args"?:{…}}</c>.
    /// On failure returns the id when it could be read (else null) and the error to acknowledge.
    /// </summary>
    public static (SimCommand? Command, string? Id, CommandResult? Error) Parse(string text)
    {
        JsonNode? node;
        try
        {
            node = JsonNode.Parse(text);
        }
        catch (JsonException)
        {
            return (null, null, CommandResult.Fail(CommandErrors.BadFrame, "not JSON"));
        }
        if (node is not JsonObject o) return (null, null, CommandResult.Fail(CommandErrors.BadFrame, "not an object"));

        var id = o["id"] is JsonValue idv && idv.TryGetValue<string>(out var s) && IdRe.IsMatch(s) ? s : null;
        if (id is null) return (null, null, CommandResult.Fail(CommandErrors.BadFrame, "id must be 1-64 of A-Z a-z 0-9 . _ -"));
        if (o["type"] is not JsonValue tv || !tv.TryGetValue<string>(out var type) || type != "command")
            return (null, id, CommandResult.Fail(CommandErrors.BadFrame, "type must be \"command\""));
        if (o["command"] is not JsonValue cv || !cv.TryGetValue<string>(out var name) || !NameRe.IsMatch(name))
            return (null, id, CommandResult.Fail(CommandErrors.BadFrame, "command must be a name"));
        foreach (var key in o.Select(p => p.Key))
            if (key is not ("type" or "id" or "command" or "args"))
                return (null, id, CommandResult.Fail(CommandErrors.BadFrame, $"unexpected field {key}"));

        var args = new Dictionary<string, JsonValue>(StringComparer.Ordinal);
        switch (o["args"])
        {
            case null when !o.ContainsKey("args"):
                break;
            case JsonObject a:
                if (a.Count > MaxArgs) return (null, id, CommandResult.Fail(CommandErrors.BadFrame, "too many args"));
                foreach (var (k, v) in a)
                {
                    if (!ArgNameRe.IsMatch(k)) return (null, id, CommandResult.Fail(CommandErrors.BadFrame, $"bad arg name {k}"));
                    if (v is not JsonValue jv || !IsFlat(jv))
                        return (null, id, CommandResult.Fail(CommandErrors.BadFrame, $"arg {k} must be a string, number or boolean"));
                    args[k] = jv;
                }
                break;
            default:
                return (null, id, CommandResult.Fail(CommandErrors.BadFrame, "args must be an object"));
        }

        if (!Validators.TryGetValue(name, out var validate))
            return (null, id, CommandResult.Fail(CommandErrors.UnknownCommand, name));
        var why = validate(args);
        if (why is not null) return (null, id, CommandResult.Fail(CommandErrors.BadArgs, why));
        return (new SimCommand(id, name, args), id, null);
    }

    private static bool IsFlat(JsonValue v) => v.GetValueKind() switch
    {
        JsonValueKind.String => v.GetValue<string>().Length <= MaxStringArg,
        JsonValueKind.Number => true,
        JsonValueKind.True or JsonValueKind.False => true,
        _ => false,
    };
}

/// <summary>
/// Token bucket per client: <see cref="Burst"/> commands at once, then <see cref="PerSecond"/> per second
/// (CLAUDE.md, invariant 6 in spirit: a runaway client cannot flood the sim).
/// </summary>
public sealed class CommandRateLimiter(TimeProvider clock, int burst = CommandRateLimiter.Burst, double perSecond = CommandRateLimiter.PerSecond)
{
    public const int Burst = 10;
    public const double PerSecond = 2;

    private double _tokens = burst;
    private DateTimeOffset _last = clock.GetUtcNow();

    public bool TryTake()
    {
        var now = clock.GetUtcNow();
        _tokens = Math.Min(burst, _tokens + (now - _last).TotalSeconds * perSecond);
        _last = now;
        if (_tokens < 1) return false;
        _tokens -= 1;
        return true;
    }
}

/// <summary>
/// Runs client commands against the source: whitelist and arguments (<see cref="CommandCatalog"/>),
/// what the source supports, a rate limit per client and a timeout. Never throws to the caller.
/// </summary>
public sealed class CommandDispatcher(ICommandTarget? target, TimeProvider clock, TimeSpan? timeout = null)
{
    public static readonly TimeSpan DefaultTimeout = TimeSpan.FromSeconds(10);

    private readonly TimeSpan _timeout = timeout ?? DefaultTimeout;
    private readonly ConcurrentDictionary<Guid, CommandRateLimiter> _limits = new();

    /// <summary>Commands announced in <c>hello</c>: the whitelist that the source supports, sorted.</summary>
    public IReadOnlyList<string> Commands { get; } =
        target is null ? [] : [.. CommandCatalog.Names.Intersect(target.Commands).Order(StringComparer.Ordinal)];

    public TimeProvider Clock => clock;

    /// <summary>Handles one frame from <paramref name="client"/>; returns the <c>ack</c> frame to send back.</summary>
    public async Task<string> HandleAsync(Guid client, string text, CancellationToken ct)
    {
        var (command, id, error) = CommandCatalog.Parse(text);
        if (command is null) return Protocol.Ack(id, error!);
        if (!_limits.GetOrAdd(client, _ => new CommandRateLimiter(clock)).TryTake())
            return Protocol.Ack(id, CommandResult.Fail(CommandErrors.RateLimited));
        if (!Commands.Contains(command.Name))
            return Protocol.Ack(id, CommandResult.Fail(CommandErrors.UnknownCommand, $"{command.Name} is not supported by this source"));

        using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        cts.CancelAfter(_timeout);
        CommandResult result;
        try
        {
            result = await target!.ExecuteAsync(command, cts.Token).WaitAsync(_timeout, clock, ct);
        }
        catch (TimeoutException)
        {
            result = CommandResult.Fail(CommandErrors.Failed, "timeout");
        }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested)
        {
            result = CommandResult.Fail(CommandErrors.Failed, "timeout");
        }
        catch (Exception e) when (e is not OperationCanceledException)
        {
            result = CommandResult.Fail(CommandErrors.Failed, e.Message);
        }
        return Protocol.Ack(id, result);
    }

    public void Forget(Guid client) => _limits.TryRemove(client, out _);
}
