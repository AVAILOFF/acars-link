// SPDX-License-Identifier: LicenseRef-ACARS-Link-Proprietary
// Copyright (c) 2026 AVAILOFF

// Flat C API of acars_simconnect.dll (T73): the part of SimConnect the bridge uses, in the
// bridge's own terms. The DLL links the SimConnect client statically (SimConnect.lib of the
// MSFS SDK, SimConnect SDK\lib\static), so no SimConnect.dll is shipped. C# declares the same
// layouts in src/AcarsBridge/SimConnectNative.cs: change both together.
//
// Every function returns an HRESULT (0 = S_OK). One session = one handle, used from one thread.
#pragma once

#include <stdint.h>

#ifdef ACARS_SC_BUILD
#define ACARS_SC_API extern "C" __declspec(dllexport)
#else
#define ACARS_SC_API extern "C" __declspec(dllimport)
#endif

// Increase when a layout or a function changes; C# refuses another value.
#define ACARS_SC_ABI 1

enum AcarsScKind : uint32_t
{
    ACARS_SC_NONE = 0,               // the queue is empty
    ACARS_SC_OPEN = 1,
    ACARS_SC_QUIT = 2,
    ACARS_SC_EXCEPTION = 3,          // value = SIMCONNECT_EXCEPTION, index = parameter index
    ACARS_SC_EVENT = 4,              // event_id, value = event data (Pause_EX1 flags, Sim 0/1)
    ACARS_SC_EVENT_FRAME = 5,        // event_id
    ACARS_SC_SIMOBJECT_DATA = 6,     // request_id, object_id, data / data_len
    ACARS_SC_ASSIGNED_OBJECT_ID = 7, // request_id, object_id
    ACARS_SC_OTHER = 99,             // a message the bridge does not use
};

enum AcarsScPeriod : uint32_t
{
    ACARS_PERIOD_ONCE = 1,
    ACARS_PERIOD_SECOND = 2,
};

#pragma pack(push, 8)
struct AcarsScMessage
{
    uint32_t kind;
    uint32_t request_id;
    uint32_t object_id;
    uint32_t event_id;
    uint32_t value;
    uint32_t index;
    uint32_t data_len;
    uint32_t reserved;
    const void* data; // valid until the next acars_sc_next_message / acars_sc_close
};

// Position of a SimObject: SIMCONNECT_DATA_INITPOSITION, field for field.
struct AcarsScPosition
{
    double latitude;  // degrees
    double longitude; // degrees
    double altitude;  // feet
    double pitch;     // degrees
    double bank;      // degrees
    double heading;   // degrees
    uint32_t on_ground; // 1 = force onto the ground
    uint32_t airspeed;  // knots
};
#pragma pack(pop)

ACARS_SC_API int32_t acars_sc_abi();

// event_handle: a Win32 event the sim signals when a message waits (EventWaitHandle.SafeWaitHandle).
// Fails (E_FAIL) when the simulator is not running.
ACARS_SC_API int32_t acars_sc_open(const char* name, void* event_handle, void** session);
ACARS_SC_API int32_t acars_sc_close(void* session);

ACARS_SC_API int32_t acars_sc_define_float64(void* session, uint32_t def, const char* name, const char* unit);
ACARS_SC_API int32_t acars_sc_define_string256(void* session, uint32_t def, const char* name);
ACARS_SC_API int32_t acars_sc_define_position(void* session, uint32_t def);

// object_id 0 = the user aircraft.
ACARS_SC_API int32_t acars_sc_request_data(void* session, uint32_t request, uint32_t def, uint32_t object_id, uint32_t period);
ACARS_SC_API int32_t acars_sc_set_float64(void* session, uint32_t def, uint32_t object_id, double value);
ACARS_SC_API int32_t acars_sc_set_position(void* session, uint32_t def, uint32_t object_id, const AcarsScPosition* position);

ACARS_SC_API int32_t acars_sc_subscribe_event(void* session, uint32_t event_id, const char* name);
ACARS_SC_API int32_t acars_sc_set_event_state(void* session, uint32_t event_id, int32_t on);

ACARS_SC_API int32_t acars_sc_create_object(void* session, const char* title, const AcarsScPosition* position, uint32_t request);
ACARS_SC_API int32_t acars_sc_remove_object(void* session, uint32_t object_id, uint32_t request);

// Takes the next message; message->kind is ACARS_SC_NONE when there is none (S_OK then too).
ACARS_SC_API int32_t acars_sc_next_message(void* session, AcarsScMessage* message);
