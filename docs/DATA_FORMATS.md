# GRIDx STS Vending Backend — Data Formats Reference

This document describes the exact data format at every link in the prepaid electricity vending chain, from the POS terminal through the HSM, over the air to the meter, and back as telemetry.

---

## Overview: The Full Chain

```
POS/Vendor ──► Vending System ──► HSM ──► 20-digit Token ──► Meter ──► Telemetry ──► Server
   (Link 1)        (Link 2)     (Link 3)     (Link 4)       (Link 5)    (Link 6)
```

---

## Link 1: POS / Vendor Interface → Vending System

The POS terminal (or web dashboard, or mobile app) initiates a vend by calling the HTTP API.

### Request

```
POST /api/vend
Content-Type: application/json
```

```json
{
  "drn":           "0000168453210",
  "amount_nad":    250.00,
  "customer_name": "Johannes Shikongo",
  "operator_id":   "OP-001"
}
```

| Field           | Type    | Description                                             |
|-----------------|---------|---------------------------------------------------------|
| `drn`           | string  | 13-digit Dispenser Reference Number (printed on meter)  |
| `amount_nad`    | number  | Purchase amount in Namibian Dollars                     |
| `customer_name` | string  | Customer name for the receipt                           |
| `operator_id`   | string  | Identifier of the POS operator / cashier                |

### Response (Success)

```json
{
  "success":        true,
  "transaction_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "token":          "58234917064823715904",
  "kwh":            125.0,
  "amount_nad":     250.00,
  "drn":            "0000168453210",
  "timestamp":      "2024-03-12T10:30:00.000Z"
}
```

| Field            | Type    | Description                                            |
|------------------|---------|--------------------------------------------------------|
| `success`        | boolean | Whether the vend succeeded                             |
| `transaction_id` | string  | UUID for this transaction                              |
| `token`          | string  | The 20-digit STS token for the customer                |
| `kwh`            | number  | Kilowatt-hours purchased                               |
| `amount_nad`     | number  | Amount charged                                         |
| `drn`            | string  | Meter DRN the token was generated for                  |
| `timestamp`      | string  | ISO 8601 timestamp                                     |

### Response (Error)

```json
{
  "success": false,
  "error":   "Meter not found",
  "code":    "METER_NOT_FOUND"
}
```

---

## Link 2: Vending System → HSM (Secure Module)

The Hardware Security Module (HSM) — or software STS library — generates the encrypted 20-digit token.  This link describes the inputs and outputs of the STS token generation process.

### Token Generation Inputs

| Parameter            | Size      | Description                                                    |
|----------------------|-----------|----------------------------------------------------------------|
| Meter DRN            | 13 digits | Dispenser Reference Number — uniquely identifies the meter     |
| Supply Group Code    | 6 digits  | Utility/supply group identifier (e.g., `600727`)               |
| Tariff Index         | 2 digits  | Tariff rate table selector (e.g., `01`)                        |
| Key Revision Number  | 1 digit   | Which decoder key generation is active (0-9)                   |
| Decoder Key          | 8 bytes   | DES key unique to this meter, derived from master key via KDF  |
| Amount               | integer   | Credit in units of 0.1 kWh (e.g., 1250 = 125.0 kWh)          |

### Key Derivation

The per-meter **Decoder Key** is derived from the utility's **Master Key** using a Key Derivation Function (KDF):

```
DecoderKey = DES_encrypt(MasterKey, DRN_padded)
```

Each meter has a unique decoder key.  The master key never leaves the HSM.

### STS Encryption (STA / EA07 Algorithm)

1. Assemble the 66-bit plaintext token (see Link 3 for bit layout)
2. Pack the 66 bits into a 9-byte buffer, zero-padded
3. Encrypt using the **STA** (Standard Transfer Algorithm) — specified as **EA07** in the STS standard
4. STA uses single-DES in a specific chaining mode with the meter's 8-byte decoder key
5. The encrypted 66 bits are unpacked back to a 20-digit decimal string

### Token Generation Output

```
Output: "58234917064823715904"   (20 decimal digits)
```

This 20-digit number encodes 66 bits of encrypted data.  The maximum value of 66 bits in decimal is 73,786,976,294,838,206,463 (20 digits), so 20 decimal digits are sufficient.

---

## Link 3: 66-Bit STS Token Structure

The STS standard defines a 66-bit token with different layouts depending on the **Class**.

### Token Classes

| Class Bits (2) | Value | Description                                       |
|----------------|-------|---------------------------------------------------|
| `00`           | 0     | Credit Transfer Token (electricity purchase)      |
| `01`           | 1     | Test / Initiate Meter Test                        |
| `10`           | 2     | Meter-Specific (key change, clear credit, etc.)   |
| `11`           | 3     | Reserved                                          |

### Class 0 — Credit Transfer Token (66 bits)

This is the most common token — it transfers prepaid credit to the meter.

```
Bit Layout (MSB first):
┌──────────┬──────────────┬──────────┬──────────┬──────────┬──────────┐
│ Class    │ Service Type │ Amount   │ Token ID │ CRC      │ Random   │
│ 2 bits   │ 4 bits       │ 16 bits  │ 24 bits  │ 16 bits  │ 4 bits   │
│ [65:64]  │ [63:60]      │ [59:44]  │ [43:20]  │ [19:4]   │ [3:0]    │
└──────────┴──────────────┴──────────┴──────────┴──────────┴──────────┘
Total: 2 + 4 + 16 + 24 + 16 + 4 = 66 bits
```

| Field        | Bits | Range            | Description                                      |
|--------------|------|------------------|--------------------------------------------------|
| Class        | 2    | 0-3              | `00` for credit transfer                         |
| Service Type | 4    | 0-15             | Type of service (electricity=0, water=1, gas=2)  |
| Amount       | 16   | 0-65535          | Credit in units of 0.1 kWh (max 6553.5 kWh)     |
| Token ID     | 24   | 0-16777215       | Sequential counter, prevents replay attacks       |
| CRC          | 16   | 0-65535          | CRC-16 over the above fields, keyed to MFR code  |
| Random       | 4    | 0-15             | Random padding for cryptographic diffusion        |

**Amount encoding**: The 16-bit amount field stores credit in units of 0.1 kWh.
- Example: 1250 decimal = 125.0 kWh
- Maximum: 65535 = 6553.5 kWh per token

**Token ID**: A monotonically increasing counter.  The meter tracks the last accepted Token ID and rejects any token with an ID less than or equal to the last accepted one.  This prevents token replay.

### Class 1 — Test Token (66 bits)

```
┌──────────┬──────────────┬────────────────────────────────────────────┐
│ Class    │ Test Type    │ Test Parameters / Padding                  │
│ 2 bits   │ 4 bits       │ 60 bits                                    │
│ [65:64]  │ [63:60]      │ [59:0]                                     │
└──────────┴──────────────┴────────────────────────────────────────────┘
```

Class 1 tokens are NOT encrypted.  They pass through the meter's token pipeline and trigger test routines (display test, relay test, etc.).

### Class 2 — Meter-Specific Token (66 bits)

```
┌──────────┬──────────────┬──────────────────────────────────────────────┐
│ Class    │ Subclass     │ Payload                                      │
│ 2 bits   │ 4 bits       │ 60 bits                                      │
│ [65:64]  │ [63:60]      │ [59:0]                                       │
└──────────┴──────────────┴──────────────────────────────────────────────┘
```

| Subclass | Action                        | Payload                             |
|----------|-------------------------------|-------------------------------------|
| 0        | Set Maximum Power Limit       | Power limit in watts (32 bits)      |
| 1        | Clear Credit                  | Zeros credit balance                |
| 2        | Set Tariff Rate               | New tariff index (8 bits)           |
| 3        | Key Change (Decoder Key)      | New key data (48 bits + CRC)        |
| 4        | Clear Tamper Flag             | Resets tamper detection              |
| 5-15     | Reserved                      | —                                   |

Class 2 tokens ARE encrypted with the decoder key (same as Class 0).

### Byte-Level Layout After `int_string_to_token()`

The firmware function `int_string_to_token()` converts the 20-digit ASCII string into a 9-byte binary buffer:

```
Input:  "58234917064823715904"  (20 ASCII characters)

Step 1: Parse as big integer
        58234917064823715904 decimal

Step 2: Convert to bytes (big-endian, 9 bytes needed for 66 bits)
        Byte[0] = 0x00  (only bits 1:0 used for class)
        Byte[1] = 0x50
        Byte[2] = 0xA3
        Byte[3] = 0xE7
        Byte[4] = 0x1C
        Byte[5] = 0x48
        Byte[6] = 0x9F
        Byte[7] = 0xD2
        Byte[8] = 0x40

        9 bytes = 72 bits, but only the low 66 bits are meaningful.
        The top 6 bits of Byte[0] are always zero.
```

### Luhn Check Digit

The Luhn check digit is used in the **DRN** (Dispenser Reference Number), NOT in the 20-digit token itself.  The 13th digit of the DRN is a Luhn check over the first 12 digits.  The 20-digit STS token has its own CRC-16 integrity check embedded in the encrypted payload.

---

## Link 4: Token Delivery to Meter

Once the 20-digit token is generated, it must be delivered to the physical meter.  Four delivery channels are supported:

### Channel 1: API (Server Push)

The preferred method.  The token is piggy-backed on the HTTP response when the meter posts its next telemetry data.

```
Meter sends:  POST /meterEnergy/MeterLog/0000168453210
              Body: [15234.5, 892.3, 45.2, 0, 0, 3, 1710240000]

Server responds:
{
  "status": "ok",
  "tk": "58234917064823715904"
}
```

The meter firmware checks every HTTP response for the `"tk"` field.  If present, it extracts the token and runs the decryption pipeline.

**Advantages**: Reliable (confirmed delivery over HTTPS), no extra cost, immediate on next telemetry cycle (typically every 30-60 seconds).

### Channel 2: SMS

An SMS is sent to the meter's SIM card phone number.

```
To: +264811234567
Body: token 58234917064823715904
```

The SIM800 modem receives the SMS and issues a UART notification to the main MCU.  The firmware reads the SMS, parses the `token <20-digits>` format, and processes it.

**Advantages**: Works even when HTTP server is unreachable; useful as a fallback.

**Disadvantages**: SMS delivery is not guaranteed; costs per message; slight delay (1-30 seconds typical).

### Channel 3: BLE (Bluetooth Low Energy)

For local/proximity delivery via a phone app or BLE-enabled POS terminal.

```
BLE Service UUID:    32511d36-429a-4a83-ab96-b40de9100000
Token Characteristic: 32511d36-429a-4a83-ab96-b40de9100376

Write value: "58234917064823715904"  (20 bytes ASCII)
```

The meter's ESP32 BLE peripheral exposes a writable characteristic.  Writing a 20-byte ASCII string triggers token processing.

**Advantages**: Works offline, no cellular required, instant.

**Disadvantages**: Requires physical proximity (~10m range), needs BLE-capable device.

### Channel 4: Console / Keypad (Manual Entry)

The meter has a Nextion touchscreen display with an on-screen numeric keypad.  The customer manually types the 20-digit token.

```
Screen: "Enter Token"
Input:  5 8 2 3 4 9 1 7 0 6 4 8 2 3 7 1 5 9 0 4
Button: [ACCEPT]
```

**Advantages**: Always available, no connectivity required.

**Disadvantages**: Error-prone (20 digits is a lot to type), slow.

---

## Link 5: Meter Token Processing Pipeline

When the meter receives a 20-digit token (from any channel), the firmware runs it through this pipeline:

### Step 1: `int_string_to_token()` — ASCII to Binary

```
Input:   "58234917064823715904"  (20 ASCII chars)
Output:  9-byte buffer [0x00, 0x50, 0xA3, 0xE7, 0x1C, 0x48, 0x9F, 0xD2, 0x40]
Method:  Parse the 20-digit string as a big integer, convert to 9 bytes big-endian
```

### Step 2: `sts_transpose_class_bits()` — Reorder Class Bits

```
Input:   9-byte buffer
Output:  9-byte buffer with class bits (bits 65:64) moved to their
         canonical position for the decryption algorithm.

The STS standard specifies that the class bits occupy a specific
position in the plaintext but a different position in the ciphertext.
This transposition reverses that mapping before decryption.
```

### Step 3: `sts_decrypt_sta()` — DES Decryption

```
Input:   9-byte transposed ciphertext
Key:     8-byte decoder key (unique to this meter, stored in secure flash)
Output:  9-byte plaintext token

Algorithm: STA (Standard Transfer Algorithm) / EA07
           Single-DES decryption in a specific chaining mode
           defined by IEC 62055-41

Note: Class 0 (credit) and Class 2 (meter-specific) tokens are encrypted.
      Class 1 (test) tokens skip this step — they are plaintext.
```

### Step 4: `sts_authenticate_token()` — CRC Verification

```
Input:   9-byte plaintext token
Params:  Manufacturer code (MFR), Supply Group Code

The CRC-16 field (bits 19:4) is verified against the other fields
(class, service type, amount, token ID) using the MFR code as a seed.

If CRC does not match:
  → Token is REJECTED (invalid key, corrupted, or wrong meter)
  → Display: "REJECT" on Nextion screen

If CRC matches:
  → Token is ACCEPTED, proceed to validation
```

### Step 5: Token ID Validation

```
Extract Token ID (bits 43:20, 24-bit counter)

Check against stored last_accepted_token_id:
  If token_id <= last_accepted_token_id:
    → REJECT (replay attack or already-used token)
    → Display: "OLD" or "USED" on Nextion screen

  If token_id > last_accepted_token_id:
    → ACCEPT, update last_accepted_token_id in flash
```

### Step 6: Execute Token

Based on the class bits:

**Class 0 (Credit Transfer):**
```
Extract amount (bits 59:44, 16-bit, in 0.1 kWh units)
credit_kwh = amount / 10.0
Add credit_kwh to the meter's prepaid balance
Update Nextion display with new balance
Log transaction to internal EEPROM
```

**Class 1 (Test):**
```
Execute test routine based on test type field
Display test results on Nextion screen
```

**Class 2 (Meter-Specific):**
```
Execute action based on subclass:
  0 → Set power limit
  1 → Clear credit balance
  2 → Change tariff
  3 → Rotate decoder key
  4 → Clear tamper flag
```

---

## Link 6: Meter → Server Telemetry (Ongoing)

The meter continuously reports operational data to the server via HTTP POST requests.  Each endpoint accepts a JSON array with a specific format.

### Power Data

```
POST /meterPower/MeterLog/{DRN}
Content-Type: application/json
```

```json
[2.5, 232.1, 580.2, 45.3, 582.0, 28.5, 50.01, 0.997, 1710240000]
```

| Index | Field         | Type  | Unit | Description                              |
|-------|---------------|-------|------|------------------------------------------|
| 0     | `current_A`   | float | A    | RMS current                              |
| 1     | `voltage_V`   | float | V    | RMS voltage                              |
| 2     | `active_W`    | float | W    | Active power                             |
| 3     | `reactive_VAR`| float | VAR  | Reactive power                           |
| 4     | `apparent_VA` | float | VA   | Apparent power                           |
| 5     | `temp_C`      | float | C    | Internal temperature                     |
| 6     | `freq_Hz`     | float | Hz   | Line frequency                           |
| 7     | `pf`          | float | -    | Power factor (0.0 to 1.0)               |
| 8     | `epoch`       | int   | s    | Unix timestamp of the reading            |

**Response:**

```json
{
  "status": "ok",
  "ms": 1
}
```

| Field    | Type | Description                                                |
|----------|------|------------------------------------------------------------|
| `status` | str  | Always `"ok"`                                              |
| `ms`     | int  | Meter switch command: `1`=relay ON, `0`=relay OFF, omitted=no change |

### Energy Data

```
POST /meterEnergy/MeterLog/{DRN}
Content-Type: application/json
```

```json
[15234.5, 892.3, 45.2, 0, 0, 3, 1710240000]
```

| Index | Field          | Type  | Unit | Description                              |
|-------|----------------|-------|------|------------------------------------------|
| 0     | `active_Wh`    | float | Wh   | Cumulative active energy consumed        |
| 1     | `reactive_Wh`  | float | Wh   | Cumulative reactive energy consumed      |
| 2     | `credit_kWh`   | float | kWh  | Remaining prepaid credit balance         |
| 3     | `tamper_flag`   | int   | -    | 0=normal, nonzero=tamper event code      |
| 4     | `tamper_ts`     | int   | s    | Tamper event epoch timestamp, 0 if none  |
| 5     | `reset_count`   | int   | -    | Number of meter resets since install     |
| 6     | `epoch`         | int   | s    | Unix timestamp of the reading            |

**Response:**

```json
{
  "status": "ok",
  "tk": "58234917064823715904"
}
```

| Field    | Type | Description                                                         |
|----------|------|---------------------------------------------------------------------|
| `status` | str  | Always `"ok"`                                                       |
| `tk`     | str  | Queued 20-digit STS token, omitted if no token pending              |

### Cellular Network Info

```
POST /meterCellNetwork/MeterLog/{DRN}
Content-Type: application/json
```

```json
[-67, "MTC Namibia", "0811234567", "862345678901234", 1710240000]
```

| Index | Field           | Type   | Description                              |
|-------|-----------------|--------|------------------------------------------|
| 0     | `rssi_dBm`      | int    | Signal strength in dBm (-113 to -51)     |
| 1     | `operator_name`  | string | Network operator name                    |
| 2     | `phone_number`   | string | SIM phone number (MSISDN)                |
| 3     | `imei`           | string | SIM800 modem IMEI (15 digits)            |
| 4     | `epoch`          | int    | Unix timestamp of the reading            |

**Response:**

```json
{
  "status": "ok"
}
```

### Meter Registration

```
POST /meters/getAccessToken
Content-Type: application/json
```

```json
{
  "DRN": "0000168453210"
}
```

| Field | Type   | Description                              |
|-------|--------|------------------------------------------|
| `DRN` | string | 13-digit Dispenser Reference Number      |

**Response:**

```json
{
  "token": "eyJhbGciOiJIUzI1NiIs...",
  "meter": {
    "drn": "0000168453210",
    "registered_at": "2024-03-12T10:00:00.000Z",
    "status": "active"
  }
}
```

---

## Telemetry Timing

| Data Type       | Typical Interval | Trigger                             |
|-----------------|------------------|-------------------------------------|
| Power data      | 30 seconds       | Periodic timer                      |
| Energy data     | 60 seconds       | Periodic timer                      |
| Cellular info   | 5 minutes        | Periodic timer or on network change |
| Registration    | Once             | On meter boot / first power-up      |

---

## Testing with curl

Below are curl commands to test every endpoint from the command line.

### Register a meter

```bash
curl -X POST http://localhost:4000/meters/getAccessToken \
  -H "Content-Type: application/json" \
  -d '{"DRN": "0000168453210"}'
```

### Post power data

```bash
curl -X POST http://localhost:4000/meterPower/MeterLog/0000168453210 \
  -H "Content-Type: application/json" \
  -d '[2.5, 232.1, 580.2, 45.3, 582.0, 28.5, 50.01, 0.997, 1710240000]'
```

### Post energy data

```bash
curl -X POST http://localhost:4000/meterEnergy/MeterLog/0000168453210 \
  -H "Content-Type: application/json" \
  -d '[15234.5, 892.3, 45.2, 0, 0, 3, 1710240000]'
```

### Post cellular info

```bash
curl -X POST http://localhost:4000/meterCellNetwork/MeterLog/0000168453210 \
  -H "Content-Type: application/json" \
  -d '[-67, "MTC Namibia", "0811234567", "862345678901234", 1710240000]'
```

### Vend a token

```bash
curl -X POST http://localhost:4000/api/vend \
  -H "Content-Type: application/json" \
  -d '{
    "drn": "0000168453210",
    "amount_nad": 250.00,
    "customer_name": "Johannes Shikongo",
    "operator_id": "OP-001"
  }'
```

### List all meters

```bash
curl http://localhost:4000/api/meters
```

### Get meter detail

```bash
curl http://localhost:4000/api/meters/0000168453210
```

### List transactions

```bash
curl http://localhost:4000/api/transactions
```

### Send relay command

```bash
curl -X POST http://localhost:4000/api/meters/0000168453210/command \
  -H "Content-Type: application/json" \
  -d '{"command": "relay_on"}'
```

### Energy post (to pick up queued token)

```bash
# After vending, the next energy POST response will include "tk"
curl -X POST http://localhost:4000/meterEnergy/MeterLog/0000168453210 \
  -H "Content-Type: application/json" \
  -d '[15240.1, 893.0, 45.0, 0, 0, 3, 1710243600]'
```

### Power post (to pick up queued relay command)

```bash
# After sending a relay command, the next power POST response will include "ms"
curl -X POST http://localhost:4000/meterPower/MeterLog/0000168453210 \
  -H "Content-Type: application/json" \
  -d '[2.6, 231.8, 603.7, 47.1, 605.5, 29.0, 50.00, 0.998, 1710243600]'
```

---

## Error Codes

| HTTP Status | Code                | Description                                 |
|-------------|---------------------|---------------------------------------------|
| 200         | —                   | Success                                     |
| 400         | `INVALID_DRN`       | DRN is not 13 digits                        |
| 400         | `INVALID_AMOUNT`    | Amount is zero, negative, or too large      |
| 400         | `INVALID_COMMAND`   | Command not recognized                      |
| 404         | `METER_NOT_FOUND`   | No meter registered with this DRN           |
| 409         | `DUPLICATE_VEND`    | Idempotency key already used                |
| 500         | `TOKEN_GEN_FAILED`  | HSM / STS token generation failed           |
| 500         | `INTERNAL_ERROR`    | Unexpected server error                     |

---

## Security Notes

1. **Decoder keys** are stored encrypted at rest and only decrypted inside the HSM / secure enclave for token generation.
2. **Access tokens** returned by `/meters/getAccessToken` should be sent as `Authorization: Bearer <token>` on subsequent meter requests (implementation-dependent).
3. **Token ID monotonicity** prevents replay attacks. Even if an attacker intercepts a token, it cannot be used on a different meter (wrong decoder key) or reused on the same meter (Token ID already consumed).
4. **HTTPS** should be enforced in production to prevent man-in-the-middle interception of tokens in transit.
5. The **master key** is provisioned into the HSM during utility setup and is never exported. Per-meter decoder keys are derived from it deterministically.
