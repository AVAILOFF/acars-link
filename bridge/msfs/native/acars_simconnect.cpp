// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

#include <windows.h>

#include <deque>
#include <new>
#include <vector>

// The SDK header compares signed constants with DWORD (C4245) and the like.
#pragma warning(push, 0)
#include "SimConnect.h"
#pragma warning(pop)

#include "acars_simconnect.h"

static_assert(sizeof(AcarsScPosition) == sizeof(SIMCONNECT_DATA_INITPOSITION), "position layout");
static_assert(sizeof(AcarsScMessage) == 40, "message layout (C# SimConnectNative.cs)");

namespace
{
// A message from the callback, its data copied, so it outlives the callback.
struct Pending
{
    AcarsScMessage message{};
    std::vector<uint8_t> data;
};

// One session: the SimConnect handle, the messages one SimConnect_CallDispatch handed over and not yet taken, and
// the one taken last (its data stays valid until the next acars_sc_next_message).
struct Session
{
    HANDLE handle = nullptr;
    std::deque<Pending> queue;
    Pending current;
    bool outOfMemory = false;
};

Session* sessionOf(void* p)
{
    return static_cast<Session*>(p);
}

SIMCONNECT_DATA_INITPOSITION toSdk(const AcarsScPosition& p)
{
    SIMCONNECT_DATA_INITPOSITION s;
    s.Latitude = p.latitude;
    s.Longitude = p.longitude;
    s.Altitude = p.altitude;
    s.Pitch = p.pitch;
    s.Bank = p.bank;
    s.Heading = p.heading;
    s.OnGround = p.on_ground;
    s.Airspeed = p.airspeed;
    return s;
}

// Called by SimConnect_CallDispatch for each waiting message (one call may bring several: OPEN comes together with
// the first events); appends it to session->queue.
void CALLBACK onDispatch(SIMCONNECT_RECV* recv, DWORD, void* context)
{
    Session* s = sessionOf(context);
    if (recv == nullptr || recv->dwID == SIMCONNECT_RECV_ID_NULL) return;
    Pending p;
    AcarsScMessage& m = p.message;

    switch (recv->dwID)
    {
    case SIMCONNECT_RECV_ID_OPEN:
        m.kind = ACARS_SC_OPEN;
        break;
    case SIMCONNECT_RECV_ID_QUIT:
        m.kind = ACARS_SC_QUIT;
        break;
    case SIMCONNECT_RECV_ID_EXCEPTION:
    {
        const auto* e = static_cast<const SIMCONNECT_RECV_EXCEPTION*>(recv);
        m.kind = ACARS_SC_EXCEPTION;
        m.value = e->dwException;
        m.index = e->dwIndex;
        break;
    }
    case SIMCONNECT_RECV_ID_EVENT:
    case SIMCONNECT_RECV_ID_EVENT_FRAME:
    {
        const auto* e = static_cast<const SIMCONNECT_RECV_EVENT*>(recv);
        m.kind = recv->dwID == SIMCONNECT_RECV_ID_EVENT ? ACARS_SC_EVENT : ACARS_SC_EVENT_FRAME;
        m.event_id = e->uEventID;
        m.value = e->dwData;
        break;
    }
    case SIMCONNECT_RECV_ID_EVENT_EX1:
    {
        // Pause_EX1 may arrive in this form: its first datum carries the flags.
        const auto* e = static_cast<const SIMCONNECT_RECV_EVENT_EX1*>(recv);
        m.kind = ACARS_SC_EVENT;
        m.event_id = e->uEventID;
        m.value = e->dwData0;
        break;
    }
    case SIMCONNECT_RECV_ID_SIMOBJECT_DATA:
    {
        const auto* d = static_cast<const SIMCONNECT_RECV_SIMOBJECT_DATA*>(recv);
        const auto* first = reinterpret_cast<const uint8_t*>(&d->dwData);
        const auto offset = static_cast<uint32_t>(first - reinterpret_cast<const uint8_t*>(d));
        const uint32_t length = d->dwSize > offset ? d->dwSize - offset : 0;
        try
        {
            p.data.assign(first, first + length);
        }
        catch (const std::bad_alloc&)
        {
            s->outOfMemory = true;
            return;
        }
        m.kind = ACARS_SC_SIMOBJECT_DATA;
        m.request_id = d->dwRequestID;
        m.object_id = d->dwObjectID;
        m.data_len = length;
        break;
    }
    case SIMCONNECT_RECV_ID_ASSIGNED_OBJECT_ID:
    {
        const auto* a = static_cast<const SIMCONNECT_RECV_ASSIGNED_OBJECT_ID*>(recv);
        m.kind = ACARS_SC_ASSIGNED_OBJECT_ID;
        m.request_id = a->dwRequestID;
        m.object_id = a->dwObjectID;
        break;
    }
    default:
        m.kind = ACARS_SC_OTHER;
        break;
    }
    try
    {
        s->queue.push_back(std::move(p));
    }
    catch (const std::bad_alloc&)
    {
        s->outOfMemory = true;
    }
}
} // namespace

ACARS_SC_API int32_t acars_sc_abi()
{
    return ACARS_SC_ABI;
}

ACARS_SC_API int32_t acars_sc_open(const char* name, void* event_handle, void** session)
{
    if (name == nullptr || session == nullptr) return E_POINTER;
    *session = nullptr;
    HANDLE h = nullptr;
    const HRESULT hr = SimConnect_Open(&h, name, nullptr, 0, static_cast<HANDLE>(event_handle), 0);
    if (FAILED(hr)) return hr;
    Session* s = new (std::nothrow) Session();
    if (s == nullptr)
    {
        SimConnect_Close(h);
        return E_OUTOFMEMORY;
    }
    s->handle = h;
    *session = s;
    return hr;
}

ACARS_SC_API int32_t acars_sc_close(void* session)
{
    Session* s = sessionOf(session);
    if (s == nullptr) return E_POINTER;
    const HRESULT hr = SimConnect_Close(s->handle);
    delete s;
    return hr;
}

ACARS_SC_API int32_t acars_sc_define_float64(void* session, uint32_t def, const char* name, const char* unit)
{
    return SimConnect_AddToDataDefinition(sessionOf(session)->handle, def, name, unit, SIMCONNECT_DATATYPE_FLOAT64);
}

ACARS_SC_API int32_t acars_sc_define_string256(void* session, uint32_t def, const char* name)
{
    return SimConnect_AddToDataDefinition(sessionOf(session)->handle, def, name, nullptr, SIMCONNECT_DATATYPE_STRING256);
}

ACARS_SC_API int32_t acars_sc_define_position(void* session, uint32_t def)
{
    return SimConnect_AddToDataDefinition(sessionOf(session)->handle, def, "Initial Position", nullptr, SIMCONNECT_DATATYPE_INITPOSITION);
}

ACARS_SC_API int32_t acars_sc_request_data(void* session, uint32_t request, uint32_t def, uint32_t object_id, uint32_t period)
{
    SIMCONNECT_PERIOD p;
    switch (period)
    {
    case ACARS_PERIOD_ONCE: p = SIMCONNECT_PERIOD_ONCE; break;
    case ACARS_PERIOD_SECOND: p = SIMCONNECT_PERIOD_SECOND; break;
    default: return E_INVALIDARG;
    }
    return SimConnect_RequestDataOnSimObject(sessionOf(session)->handle, request, def, object_id, p, SIMCONNECT_DATA_REQUEST_FLAG_DEFAULT, 0, 0, 0);
}

ACARS_SC_API int32_t acars_sc_set_float64(void* session, uint32_t def, uint32_t object_id, double value)
{
    return SimConnect_SetDataOnSimObject(sessionOf(session)->handle, def, object_id, SIMCONNECT_DATA_SET_FLAG_DEFAULT, 1, sizeof(double), &value);
}

ACARS_SC_API int32_t acars_sc_set_position(void* session, uint32_t def, uint32_t object_id, const AcarsScPosition* position)
{
    if (position == nullptr) return E_POINTER;
    SIMCONNECT_DATA_INITPOSITION s = toSdk(*position);
    return SimConnect_SetDataOnSimObject(sessionOf(session)->handle, def, object_id, SIMCONNECT_DATA_SET_FLAG_DEFAULT, 1, sizeof(s), &s);
}

ACARS_SC_API int32_t acars_sc_subscribe_event(void* session, uint32_t event_id, const char* name)
{
    return SimConnect_SubscribeToSystemEvent(sessionOf(session)->handle, event_id, name);
}

ACARS_SC_API int32_t acars_sc_set_event_state(void* session, uint32_t event_id, int32_t on)
{
    return SimConnect_SetSystemEventState(sessionOf(session)->handle, event_id, on != 0 ? SIMCONNECT_STATE_ON : SIMCONNECT_STATE_OFF);
}

ACARS_SC_API int32_t acars_sc_create_object(void* session, const char* title, const AcarsScPosition* position, uint32_t request)
{
    if (title == nullptr || position == nullptr) return E_POINTER;
    return SimConnect_AICreateSimulatedObject(sessionOf(session)->handle, title, toSdk(*position), request);
}

ACARS_SC_API int32_t acars_sc_remove_object(void* session, uint32_t object_id, uint32_t request)
{
    return SimConnect_AIRemoveObject(sessionOf(session)->handle, object_id, request);
}

// One message per call, as the managed wrapper's ReceiveMessage gave. SimConnect_CallDispatch hands over every waiting
// message to the callback in one call (none = S_OK, no callback), so they are queued and given out one by one; the
// queue is refilled only when empty. A broken connection is a failure here.
ACARS_SC_API int32_t acars_sc_next_message(void* session, AcarsScMessage* message)
{
    Session* s = sessionOf(session);
    if (s == nullptr || message == nullptr) return E_POINTER;
    *message = AcarsScMessage{};
    s->current = Pending{};
    if (s->queue.empty())
    {
        const HRESULT hr = SimConnect_CallDispatch(s->handle, onDispatch, s);
        if (FAILED(hr)) return hr;
    }
    if (s->outOfMemory)
    {
        s->outOfMemory = false;
        return E_OUTOFMEMORY;
    }
    if (s->queue.empty()) return S_OK;
    s->current = std::move(s->queue.front());
    s->queue.pop_front();
    *message = s->current.message;
    if (!s->current.data.empty()) message->data = s->current.data.data();
    return S_OK;
}
