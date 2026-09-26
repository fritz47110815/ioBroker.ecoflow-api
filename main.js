/* eslint-disable no-console */
'use strict';

const crypto = require('node:crypto');
const https = require('node:https');
const { URL } = require('node:url');
const utils = require('@iobroker/adapter-core');

const HOSTS = {
    eu: 'https://api-e.ecoflow.com',
    us: 'https://api-a.ecoflow.com',
    global: 'https://api.ecoflow.com',
    apac: 'https://api-a.ecoflow.com',
};

class EcoflowApi extends utils.Adapter {
    constructor(options) {
        super({
            ...options,
            name: 'ecoflow-api',
        });

        this.pollTimer = null;
        this.pollInProgress = false;
        this.stopping = false;
        this.timeOffsetMs = 0;
        this.debugLogging = true;
        // Avoid repeating device/parameter query warnings on every poll.
        this.warnedDeviceFailures = new Set();
        this.warnedParameterFailures = new Set();

        this.on('ready', () => this.onReady());
        this.on('unload', callback => this.onUnload(callback));
    }

    async onReady() {
        try {
            this.config.region = this.config.region || 'eu';
            this.config.pollInterval = Number(this.config.pollInterval) || 60;
            // Credentials are frequently copied from the EcoFlow portal. Remove
            // accidental leading/trailing whitespace before signing requests.
            this.config.accessKey = String(this.config.accessKey || '').trim();
            this.config.secretKey = String(this.config.secretKey || '').trim();
            this.debugLogging = this.config.debugLogging !== false;

            if (this.config.pollInterval < 10) {
                this.config.pollInterval = 10;
            }

            if (!this.config.accessKey || !this.config.secretKey) {
                this.log.error('EcoFlow API credentials are missing. Instance will be stopped.');
                await this.stopInstance();
                return;
            }

            if (!HOSTS[this.config.region]) {
                this.log.error(`Unknown EcoFlow API region "${this.config.region}". Instance will be stopped.`);
                await this.stopInstance();
                return;
            }

            await this.setStateAsync('info.connection', false, true);
            this.log.info(
                `Starting EcoFlow API adapter; region=${this.config.region}, ` +
                `host=${HOSTS[this.config.region]}, pollInterval=${this.config.pollInterval}s`,
            );

            await this.poll();

            // poll() schedules the next cycle in its finally block.
        } catch (error) {
            this.log.error(`Fatal startup error: ${this.errorText(error)}`);
            await this.stopInstance();
        }
    }

    scheduleNextPoll() {
        if (this.stopping) {
            return;
        }

        if (this.pollTimer) {
            clearTimeout(this.pollTimer);
        }

        this.pollTimer = setTimeout(() => {
            this.pollTimer = null;
            this.poll().catch(error => {
                this.log.error(`Unhandled polling error: ${this.errorText(error)}`);
            });
        }, this.config.pollInterval * 1000);

        this.debugLog(`Next EcoFlow poll scheduled in ${this.config.pollInterval}s`);
    }

    async poll() {
        if (this.stopping || this.pollInProgress) {
            this.debugLog('Poll skipped because the adapter is stopping or another poll is already running.');
            return;
        }

        this.pollInProgress = true;
        const started = Date.now();

        try {
            this.debugLog('Starting EcoFlow polling cycle.');

            let devices;
            try {
                devices = await this.getDeviceList();
            } catch (error) {
                await this.setStateAsync('info.connection', false, true).catch(() => undefined);
                this.log.error(`Cannot retrieve EcoFlow device list: ${this.errorText(error)}`);
                this.log.error('No device list is available. Stopping instance.');
                await this.stopInstance();
                return;
            }

            if (!Array.isArray(devices) || devices.length === 0) {
                await this.setStateAsync('info.connection', false, true).catch(() => undefined);
                this.log.error('EcoFlow API returned no registered devices. Stopping instance.');
                await this.stopInstance();
                return;
            }

            this.debugLog(`EcoFlow API returned ${devices.length} registered device(s).`);

            let successfulDevices = 0;
            const failures = [];

            for (const device of devices) {
                if (!device || !device.sn) {
                    failures.push('device without serial number');
                    this.log.error(`Skipping invalid device entry: ${JSON.stringify(device)}`);
                    continue;
                }

                try {
                    await this.updateDeviceMetadata(device);
                    await this.updateDeviceQuota(device);
                    successfulDevices++;
                    this.debugLog(`Successfully updated EcoFlow device ${device.sn}.`);
                } catch (error) {
                    failures.push(device.sn);
                    if (!this.warnedDeviceFailures.has(device.sn)) {
                        this.warnedDeviceFailures.add(device.sn);
                        this.log.warn(
                            `EcoFlow parameter query failed for device ${device.sn}: ${this.errorText(error)}. ` +
                            'This warning is shown only once per device during this instance run.',
                        );
                    } else {
                        this.debugLog(`Device ${device.sn} query failed again; warning already reported: ${this.errorText(error)}`);
                    }
                    this.debugLog(`Continuing with remaining devices after query failure for ${device.sn}.`);
                }
            }

            if (successfulDevices === 0) {
                await this.setStateAsync('info.connection', false, true).catch(() => undefined);
                this.log.warn(
                    `All ${devices.length} EcoFlow device query/queries failed. Stopping instance.`,
                );
                await this.stopInstance();
                return;
            }

            await this.setStateAsync('info.connection', true, true).catch(() => undefined);

            const duration = Date.now() - started;
            this.debugLog(
                `EcoFlow polling cycle completed in ${duration}ms: ` +
                `${successfulDevices}/${devices.length} device(s) successful` +
                (failures.length ? `; failed: ${failures.join(', ')}` : ''),
            );
        } catch (error) {
            await this.setStateAsync('info.connection', false, true).catch(() => undefined);
            this.log.error(`Unexpected EcoFlow polling error: ${this.errorText(error)}`);
            await this.stopInstance();
        } finally {
            this.pollInProgress = false;
            if (!this.stopping) {
                this.scheduleNextPoll();
            }
        }
    }

    async getDeviceList() {
        const result = await this.apiRequest('/iot-open/sign/device/list', {});
        if (!Array.isArray(result.data)) {
            throw new Error(`Unexpected device-list response: ${JSON.stringify(result)}`);
        }
        return result.data;
    }

    async updateDeviceMetadata(device) {
        const base = `device.${this.safeId(device.sn)}`;

        await this.setOrCreateObject(base, {
            type: 'device',
            common: {
                name: device.deviceName || device.productName || device.sn,
            },
            native: {
                serialNumber: device.sn,
                productName: device.productName || '',
            },
        });

        await this.setOrCreateObject(`${base}.info`, {
            type: 'channel',
            common: {
                name: 'Device information',
            },
            native: {},
        });

        await this.setOrCreateObject(`${base}.parameters`, {
            type: 'channel',
            common: {
                name: 'EcoFlow parameters',
            },
            native: {},
        });

        await this.setOrCreateState(`${base}.info.name`, {
            name: 'Device name',
            type: 'string',
            role: 'info.name',
            read: true,
            write: false,
        }, device.deviceName || device.sn);

        await this.setOrCreateState(`${base}.info.productName`, {
            name: 'Product name',
            type: 'string',
            role: 'info.product',
            read: true,
            write: false,
        }, device.productName || '');

        await this.setOrCreateState(`${base}.info.online`, {
            name: 'Online',
            type: 'boolean',
            role: 'indicator.reachable',
            read: true,
            write: false,
        }, Boolean(Number(device.online) || device.online === true));

        this.debugLog(
            `Device metadata updated: sn=${device.sn}, name=${device.deviceName || ''}, ` +
            `product=${device.productName || ''}, online=${device.online}`,
        );
    }

    async updateDeviceQuota(device) {
        const result = await this.apiRequest('/iot-open/sign/device/quota/all', { sn: device.sn });

        if (!result || result.data === undefined || result.data === null) {
            throw new Error(`No quota data returned for ${device.sn}: ${JSON.stringify(result)}`);
        }

        const parameters = this.extractParameters(result.data);
        const parameterKeys = Object.keys(parameters);

        this.debugLog(
            `Received ${parameterKeys.length} parameter(s) for ${device.sn}.`,
        );

        if (parameterKeys.length === 0) {
            this.log.warn(`EcoFlow device ${device.sn} returned an empty parameter set.`);
        }

        for (const originalKey of parameterKeys) {
            const value = parameters[originalKey];
            const stateId = `device.${this.safeId(device.sn)}.parameters.${this.safeId(originalKey)}`;

            try {
                await this.setOrCreateDynamicState(stateId, originalKey, value);
            } catch (error) {
                // A malformed parameter must not make the complete device fail.
                const warningKey = `${device.sn}:${originalKey}`;
                if (!this.warnedParameterFailures.has(warningKey)) {
                    this.warnedParameterFailures.add(warningKey);
                    this.log.warn(
                        `Cannot create/update parameter "${originalKey}" for ${device.sn}: ${this.errorText(error)}. ` +
                        'This warning is shown only once for this parameter during this instance run.',
                    );
                } else {
                    this.debugLog(`Parameter ${originalKey} for ${device.sn} failed again; warning already reported: ${this.errorText(error)}`);
                }
            }
        }
    }

    extractParameters(data) {
        // The public API normally returns a flat object of quota key/value pairs.
        // Some API/device versions may wrap the quota in a "quota" property.
        if (data && typeof data === 'object' && !Array.isArray(data)) {
            if (data.quota && typeof data.quota === 'object' && !Array.isArray(data.quota)) {
                return data.quota;
            }
            return data;
        }

        if (Array.isArray(data)) {
            const result = {};
            for (const item of data) {
                if (item && typeof item === 'object') {
                    Object.assign(result, item);
                }
            }
            return result;
        }

        return { value: data };
    }

    async setOrCreateDynamicState(id, originalKey, value) {
        const typeInfo = this.ioBrokerType(value);
        // Keep every API parameter, including unknown keys. Unit detection only
        // enriches metadata; it never filters or drops a parameter.
        const unit = this.getParameterUnit(originalKey);
        const common = {
            name: originalKey,
            type: typeInfo.type,
            role: unit ? this.getParameterRole(unit, originalKey) : 'value',
            read: true,
            write: false,
            def: typeInfo.defaultValue,
        };

        if (unit) {
            common.unit = unit;
        }

        const existing = await this.getObjectAsync(id);
        if (!existing) {
            await this.setOrCreateStateObject(id, common, {
                ecoflowKey: originalKey,
                unit: unit || '',
            });
            this.debugLog(
                `Created parameter state ${id} for EcoFlow key "${originalKey}" ` +
                `(type=${typeInfo.type}${unit ? `, unit=${unit}` : ''}).`,
            );
        } else {
            // Keep the user's existing object settings, but refresh the EcoFlow
            // mapping and the detected physical unit. This also adds units to
            // states created by older adapter versions.
            const native = {
                ...(existing.native || {}),
                ecoflowKey: originalKey,
                unit: unit || '',
            };
            const extend = { native };
            if (unit && existing.common && existing.common.unit !== unit) {
                extend.common = {
                    ...(existing.common || {}),
                    unit,
                    role: this.getParameterRole(unit, originalKey),
                };
            }
            await this.extendObjectAsync(id, extend);
        }

        const normalized = typeInfo.value;
        await this.setStateAsync(id, normalized, true);
    }

    /**
     * EcoFlow quota keys are device/model dependent. There is no unit field
     * in the flat quota response, so the adapter derives the physical unit
     * from the well-known EcoFlow parameter naming conventions.
     *
     * The value itself is deliberately not converted here. Some EcoFlow
     * products report scaled values (for example tenths of a degree or
     * hundredths of a volt). Keeping the API value unchanged prevents silent
     * changes to existing histories. The unit therefore describes the native
     * EcoFlow quantity; model-specific scaling can be added later when the
     * corresponding device model is known.
     */
    getParameterUnit(key) {
        const k = String(key || '').toLowerCase();
        const name = k.includes('.') ? k.substring(k.lastIndexOf('.') + 1) : k;

        // Percent / state-of-charge / state-of-health.
        if (
            /(^|_)(soc|soh|show_soc|lcdshowsoc|f32showsoc)$/.test(name) ||
            /soc$/.test(name) ||
            /soh$/.test(name)
        ) {
            return '%';
        }

        // Time values exposed by EcoFlow are minutes.
        if (
            /remain(time)?$/.test(name) ||
            /^(chg|dsg|charge|discharge)(remain(time)?|chargingtime|dischargingtime)$/.test(name) ||
            /(chargingtime|dischargingtime)$/.test(name)
        ) {
            return 'min';
        }

        // Temperatures.
        if (/(temp|temperature)$/.test(name)) {
            return '°C';
        }

        // Frequency.
        if (/(freq|frequency)$/.test(name)) {
            return 'Hz';
        }

        // Electrical current.
        if (
            /(amp|amps|current|cur)$/.test(name) ||
            /(^|_)(inamp|outamp)$/.test(name)
        ) {
            return 'A';
        }

        // Electrical voltage.
        if (
            /(volt|vol|voltage)$/.test(name) ||
            /volt(?!.*watts)/.test(name)
        ) {
            return 'V';
        }

        // Energy counters. The documented EcoFlow quota counters are Wh.
        // They are intentionally not converted to kWh so the raw API value
        // remains intact. Check these before generic "Power" detection because
        // some energy counters (for example chgSunPower) contain "Power" in
        // their name.
        if (
            /(energy|powerac|powerdc|chgsunpower|accuchgenergy|accudsgenergy)$/.test(name) ||
            /^(chgpower|dsgpower)/.test(name)
        ) {
            return 'Wh';
        }

        // Power. EcoFlow names instantaneous power values with Watts/Power.
        if (
            /(watts?|power|powerfactor)$/.test(name) ||
            /(^|_)(inputwatts|outputwatts|inputpower|outputpower)$/.test(name)
        ) {
            if (/powerfactor$/.test(name)) {
                return '';
            }
            return 'W';
        }

        // Battery capacity values in EcoFlow's quota API are normally Wh.
        if (/(designcap|fullcap|remaincap|capacity)$/.test(name)) {
            return 'Wh';
        }

        // Accumulated charge/discharge capacity is commonly reported in mAh.
        if (/(accuchgcap|accudsgcap)$/.test(name)) {
            return 'mAh';
        }

        if (/cycles?$/.test(name)) {
            return 'cycles';
        }

        if (/rssi$/.test(name)) {
            return 'dBm';
        }

        if (/(ohm|resistance)$/.test(name)) {
            return 'Ω';
        }

        return '';
    }

    getParameterRole(unit, key) {
        switch (unit) {
            case '%':
                return 'value.battery';
            case 'W':
                return 'value.power';
            case 'Wh':
            case 'kWh':
                return 'value.energy';
            case 'V':
                return 'value.voltage';
            case 'A':
                return 'value.current';
            case '°C':
                return 'value.temperature';
            case 'Hz':
                return 'value.frequency';
            case 'min':
                return 'value.time';
            default:
                return 'value';
        }
    }

    ioBrokerType(value) {
        if (typeof value === 'boolean') {
            return { type: 'boolean', value, defaultValue: false };
        }

        if (typeof value === 'number' && Number.isFinite(value)) {
            return {
                type: Number.isInteger(value) ? 'number' : 'number',
                value,
                defaultValue: 0,
            };
        }

        if (typeof value === 'string') {
            return { type: 'string', value, defaultValue: '' };
        }

        if (value === null || value === undefined) {
            return { type: 'string', value: '', defaultValue: '' };
        }

        return {
            type: 'string',
            value: JSON.stringify(value),
            defaultValue: '',
        };
    }

    safeId(value) {
        let id = String(value)
            .trim()
            .replace(/[\\/#?[\]*"']/g, '_')
            .replace(/\s+/g, '_')
            .replace(/\.+/g, '_')
            .replace(/[^a-zA-Z0-9_-]/g, '_')
            .replace(/_+/g, '_')
            .replace(/^_+|_+$/g, '');

        if (!id) {
            id = 'unknown';
        }

        // Object IDs must not begin with a digit in some ioBroker tooling.
        if (/^\d/.test(id)) {
            id = `p_${id}`;
        }

        return id.substring(0, 250);
    }

    async setOrCreateObject(id, object) {
        const existing = await this.getObjectAsync(id);
        if (!existing) {
            await this.setObjectAsync(id, object);
        }
    }

    async setOrCreateStateObject(id, common, native = {}) {
        const existing = await this.getObjectAsync(id);
        if (!existing) {
            await this.setObjectAsync(id, {
                type: 'state',
                common,
                native,
            });
        }
    }

    async setOrCreateState(id, common, value) {
        await this.setOrCreateStateObject(id, common);
        await this.setStateAsync(id, value, true);
    }

    /**
     * Creates the EcoFlow Public API headers exactly like the known-working
     * Python reference implementation:
     *
     *   query parameters first (in the exact order used in the URL), then
     *   accessKey, nonce and timestamp.
     *
     * Important: Do not alphabetically sort the authentication parameters.
     * For the quota endpoint the signed string must be, for example:
     *   sn=SERIAL&accessKey=KEY&nonce=123456&timestamp=...
     */
    createEcoflowHeaders(endpointPath) {
        const accessKey = String(this.config.accessKey || '').trim();
        const secretKey = String(this.config.secretKey || '').trim();

        if (!accessKey || !secretKey) {
            throw new Error('EcoFlow Access Key or Secret Key is empty.');
        }

        const nonce = String(crypto.randomInt(100000, 1000000));
        const timestamp = String(Date.now() + this.timeOffsetMs);

        let path = endpointPath;
        let query = '';

        const questionMark = endpointPath.indexOf('?');
        if (questionMark >= 0) {
            path = endpointPath.substring(0, questionMark);
            query = endpointPath.substring(questionMark + 1);
        }

        // This deliberately mirrors the working Python implementation.
        // Query parameters are part of the signature and precede the auth
        // parameters. For the current API request there is only "sn".
        const signParts = [];
        if (query) {
            signParts.push(query);
        }
        signParts.push(`accessKey=${accessKey}`);
        signParts.push(`nonce=${nonce}`);
        signParts.push(`timestamp=${timestamp}`);

        const signString = signParts.join('&');
        const sign = crypto
            .createHmac('sha256', secretKey)
            .update(signString, 'utf8')
            .digest('hex');

        return {
            path,
            requestPath: endpointPath,
            accessKey,
            nonce,
            timestamp,
            sign,
            signString,
        };
    }

    async apiRequest(path, params, retry = 0) {
        const host = HOSTS[this.config.region];
        if (!host) {
            throw new Error(`Unknown EcoFlow API region: ${this.config.region}`);
        }

        // Build the exact URL path first. This is intentionally not done with
        // URLSearchParams because the proven Python implementation signs the
        // literal query string (e.g. "sn=SERIAL").
        let requestPath = path;
        const entries = Object.entries(params || {});
        if (entries.length) {
            const query = entries
                .map(([key, value]) => `${key}=${encodeURIComponent(String(value))}`)
                .join('&');
            requestPath += `?${query}`;
        }

        const signing = this.createEcoflowHeaders(requestPath);
        const requestUrl = new URL(requestPath, host);

        this.debugLog(
            `EcoFlow API request: GET ${requestUrl.pathname}${requestUrl.search} ` +
            `(nonce=${signing.nonce}, timestamp=${signing.timestamp}, ` +
            `timeOffset=${this.timeOffsetMs}ms)`,
        );
        this.debugLog(`EcoFlow signature string: ${signing.signString}`);
        this.debugLog(`EcoFlow signature: ${signing.sign}`);

        const response = await new Promise((resolve, reject) => {
            const request = https.request(requestUrl, {
                method: 'GET',
                timeout: 30000,
                // Keep the request headers aligned with the working Python
                // reference script. In particular, EcoFlow's gateway accepts
                // this User-Agent reliably.
                headers: {
                    Accept: 'application/json',
                    'User-Agent': 'Mozilla/5.0',
                    accessKey: signing.accessKey,
                    nonce: signing.nonce,
                    timestamp: signing.timestamp,
                    sign: signing.sign,
                },
            }, response => {
                let body = '';

                response.setEncoding('utf8');
                response.on('data', chunk => {
                    body += chunk;
                });

                response.on('end', () => resolve({
                    statusCode: response.statusCode,
                    headers: response.headers,
                    body,
                }));
            });

            request.on('timeout', () => {
                request.destroy(new Error('EcoFlow API request timed out after 30 seconds'));
            });
            request.on('error', reject);
            request.end();
        });

        this.debugLog(
            `EcoFlow API response: HTTP ${response.statusCode}, ` +
            `${response.body.length} byte(s) from ${requestUrl.pathname}`,
        );

        if (response.headers && response.headers.date) {
            const serverTime = Date.parse(response.headers.date);
            if (Number.isFinite(serverTime)) {
                const measuredOffset = serverTime - Date.now();
                if (Math.abs(measuredOffset - this.timeOffsetMs) > 1000) {
                    this.debugLog(
                        `EcoFlow server clock offset measured at approximately ${measuredOffset}ms ` +
                        `(HTTP Date: ${response.headers.date}).`,
                    );
                    this.timeOffsetMs = measuredOffset;
                }
            }
        }

        let parsed;
        try {
            parsed = response.body ? JSON.parse(response.body) : {};
        } catch (error) {
            throw new Error(
                `EcoFlow returned invalid JSON (HTTP ${response.statusCode}): ` +
                response.body.substring(0, 500),
            );
        }

        if (response.statusCode < 200 || response.statusCode >= 300) {
            throw new Error(
                `EcoFlow HTTP ${response.statusCode}: ${parsed.message || response.body.substring(0, 500)}`,
            );
        }

        if (parsed.code !== undefined && String(parsed.code) !== '0') {
            const message = parsed.message || 'unknown error';

            if (String(parsed.code) === '8521' && retry < 1) {
                this.log.warn(
                    `EcoFlow returned 8521 (signature is wrong). Retrying once with ` +
                    `a fresh nonce/timestamp and calculated clock offset (${this.timeOffsetMs}ms).`,
                );
                return this.apiRequest(path, params, retry + 1);
            }

            if (String(parsed.code) === '8521') {
                throw new Error(
                    `EcoFlow API error 8521: signature is wrong. ` +
                    `Signed request: ${signing.signString}. ` +
                    `Server time offset: ${this.timeOffsetMs}ms. ` +
                    `Request URL: ${requestUrl.toString()}`,
                );
            }

            throw new Error(`EcoFlow API error ${parsed.code}: ${message}`);
        }

        return parsed;
    }

    flattenValue(value) {
        if (value === null || value === undefined) {
            return '';
        }

        if (typeof value === 'object') {
            return JSON.stringify(value);
        }

        return String(value);
    }

    /**
     * Writes detailed diagnostics both to the ioBroker debug logger and, when
     * enabled, to the normal info logger. This makes the adapter diagnostics
     * visible even when the ioBroker host log level is not set to debug.
     */
    debugLog(message) {
        this.log.debug(message);
        if (this.debugLogging) {
            this.log.info(`[DEBUG] ${message}`);
        }
    }

    errorText(error) {
        if (!error) {
            return 'unknown error';
        }
        return error.stack || error.message || String(error);
    }

    async stopInstance() {
        if (this.stopping) {
            return;
        }

        this.stopping = true;

        if (this.pollTimer) {
            clearTimeout(this.pollTimer);
            this.pollTimer = null;
        }

        try {
            await this.setStateAsync('info.connection', false, true);
        } catch {
            // Ignore errors during shutdown.
        }

        this.log.warn('Stopping EcoFlow API instance.');
        if (typeof this.terminate === 'function') {
            this.terminate();
        } else {
            this.stop();
        }
    }

    onUnload(callback) {
        this.stopping = true;

        if (this.pollTimer) {
            clearTimeout(this.pollTimer);
            this.pollTimer = null;
        }

        callback();
    }
}

if (require.main !== module) {
    module.exports = options => new EcoflowApi(options);
} else {
    new EcoflowApi();
}
