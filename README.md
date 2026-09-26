# ioBroker.ecoflow-api

Version 0.1.6

ioBroker adapter for the official EcoFlow Public API.

## Features

- Discovers **all devices registered to the configured EcoFlow API account**.
- Polls the device list and then the current quota/parameter data for every device.
- Creates an ioBroker device object for every discovered device.
- Stores device metadata under `device.<serial>.info`.
- Stores all returned EcoFlow parameters under `device.<serial>.parameters`.
- Parameter names are converted to ioBroker-safe IDs; the original EcoFlow key is kept in `native.ecoflowKey`.
- A failed device does not prevent the remaining devices from being queried.
- If the device list cannot be retrieved, or if **all discovered device queries fail**, the instance stops.
- Extensive debug/error logging. Secrets are never written to the log.
- Automatically assigns physical units such as `%`, `W`, `Wh`, `V`, `A`, `°C`, `Hz`, `min`, `mAh`, `dBm` and `Ω` to known EcoFlow parameters.
- Polling is non-overlapping: the next poll is scheduled only after the previous one has finished.

## Configuration

- Region:
  - Europe: `api-e.ecoflow.com`
  - North America: `api-a.ecoflow.com`
  - Global / other: `api.ecoflow.com`
  - Australia / Asia-Pacific: `api-a.ecoflow.com`
- Poll frequency in seconds (10–86400)
- EcoFlow API Access Key
- EcoFlow API Secret Key
- Detailed debug logging (enabled by default)

The API key pair is generated through the EcoFlow developer portal.

## Object tree

Example:

```text
ecoflow-api.0
├── info.connection
└── device
    └── DCEBxxxxxxxxxxxx
        ├── info
        │   ├── name
        │   ├── productName
        │   └── online
        └── parameters
            ├── 20_1_pv2Temp
            ├── 20_1_invOutputWatts
            └── ...
```

The parameter state names are sanitized for ioBroker. The exact EcoFlow parameter name is available as `native.ecoflowKey` on the object. Known physical units are stored in `common.unit` and mirrored in `native.unit`.

## API

The adapter uses the signed EcoFlow Public API endpoints:

- `GET /iot-open/sign/device/list`
- `GET /iot-open/sign/device/quota/all?sn=<serial>`

EcoFlow requests are authenticated with HMAC-SHA256. The signature follows the working Python reference implementation: the literal query string (for example `sn=<serial>`) is followed by `accessKey`, `nonce`, and `timestamp` in that exact order. Credentials are trimmed before signing. On error 8521 the adapter retries once with a fresh nonce and uses the HTTP Date header to compensate for host clock drift. This is important because a clock offset can also cause EcoFlow to report 8521.

## Important

EcoFlow can add or remove device parameters over time. The adapter therefore creates states dynamically from the API response rather than maintaining a hard-coded device model.

No write/control functionality is intentionally implemented in this first version.

## Configuration language

The configuration form contains English and German translations. ioBroker displays the labels and help texts according to the currently selected ioBroker/admin language.

## Adapter icon

The project contains `admin/ecoflow-api.png` as the adapter icon.


## Version 0.1.3

Die Signaturerzeugung der EcoFlow-API wurde exakt an die funktionierende Python-Referenzimplementierung angepasst. Für die Quota-Abfrage wird die Signatur nun aus dem wörtlichen Query-String `sn=...` gefolgt von `accessKey`, `nonce` und `timestamp` gebildet. Zusätzlich wird der von der Referenz verwendete `User-Agent: Mozilla/5.0` gesendet.

## Version 0.1.4

Detailed diagnostics are now written both with the ioBroker debug logger and, when enabled, as `[DEBUG]` messages in the normal info log. This makes request paths, signature strings (without the secret), API responses and polling details visible without changing the host-wide ioBroker log level. The configuration contains a switch to disable the additional info-level debug messages.

The adapter icon is a dedicated EcoFlow logo graphic based on the EcoFlow brand mark shown on the official EcoFlow website.


## Version 0.1.5

Known EcoFlow quota parameters now receive a physical unit in the ioBroker object definition. Examples include `%` for state of charge, `W` for power, `Wh` for energy counters, `V` for voltage, `A` for current, `°C` for temperature and `min` for remaining times. The original API values are not silently converted, because some EcoFlow models use device-specific scaling factors.


## Version 0.1.6

All parameters returned by EcoFlow are retained; unit detection only adds metadata and never filters unknown parameters. A device query failure is logged as a warning once per device per instance run; repeated failures are available in debug logging. Parameter object update warnings are likewise limited to once per parameter per instance run. API Access Key and Secret Key fields are displayed as visible text in the configuration form.
