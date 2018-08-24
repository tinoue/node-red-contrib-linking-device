/*
   Copyright (c) 2018 Takesh Inoue <inoue.takeshi@gmail.com>

   Licensed under the Apache License, Version 2.0 (the "License");
   you may not use this file except in compliance with the License.
   You may obtain a copy of the License at

       http://www.apache.org/licenses/LICENSE-2.0

   Unless required by applicable law or agreed to in writing, software
   distributed under the License is distributed on an "AS IS" BASIS,
   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   See the License for the specific language governing permissions and
   limitations under the License.
*/
const DEBUG = true;
const os = require('os');

const EventEmitter = require('events').EventEmitter;
const Semaphore = require('semaphore');
const RateLimiter = require('limiter').RateLimiter;

const Linking = require('node-linking');
const LinkingAdvertising = require('node-linking/lib/modules/advertising');
const LinkingDevice = require('node-linking/lib/modules/device');
const linking = new Linking();

const TAG = 'linking-device: ';

const REQUEST_TIMEOUT = 60 * 1000;	// 1sec
const SCANNER_RESTART_INTERVAL = 60 * 1000;	// 1sec
const AUTOSTART_INTERVAL = 30 * 1000;


// serviceId to string
const serviceNames = {
    '1': 'temperature',
    '2': 'humidity',
    '3': 'pressure',
    '4': 'battery',
    '5': 'button',
    '9': 'illuminance',
};

// class PromiseSemaphore: Promise version of Semaphore with timeout
class PromiseSemaphore {
    constructor(slotNum, timeout) {
        this.sem = Semaphore(slotNum || 1);
        this.timeout = timeout || 0;
    }

    // Promise take()
    take() {
        return new Promise((resolve, _reject) => {
            let timerId;

            if (this.sem.available()) {
                this.sem.take(resolve);
                return;
            }

            if (this.timeout) {
                timerId = setTimeout(() => {
                    const message = 'Semaphore timeout.';
                
                    console.warn(message);
                    this.sem.leave(); // force leave. The take() below will success.
                    
                    // reject(new Error(message));
                }, this.timeout);
            }

            this.sem.take(() => {
                if (this.timeout) {
                    clearTimeout(timerId);
                }

                resolve();
            });
        });
    }
        
    leave() {
        this.sem.leave();
    }

    available() {
        return this.sem.available();
    }
}



module.exports = function(RED) {
    const logger = console;

    // event: manages internal events :
    //   discover(advertisement, device), scanStart(), scanStop(expected), scannerStatus(status),
    //   connect(localName), disconnect(localName)
    //   notify(localName, service, data)
    const event = new EventEmitter();

    let initialized = false;

    let scannerExists = false;
    let scanning = false;
    let scannerEnabled = true;		// linking-scanner is enabled. i.e need to restart scan if stopped
    const scanSemaphore = new PromiseSemaphore(1);
    const connectSemaphore = new PromiseSemaphore(1);

    let linkingDevices = {};    // key: localName, value: device object
    let deviceSemaphores = {};  // key; localName, value; semaphore to request to device
    let lastBeaconTimes = {};   // key: localName, value: time(os.uptime) of last beacon.

    ////////////////////////////////////////////////////////////////
    // Common functions
    ////////////////////////////////////////////////////////////////
    /*
    function sleep(msec) {
        return new Promise((resolve, _reject) => {
            if (msec === 0) {
                resolve();
            } else {
                setTimeout(resolve, msec);
            }
        });
    }
    */
    function getDeviceSemaphore(localName) {
        if (! deviceSemaphores[localName]) {
            deviceSemaphores[localName] = new PromiseSemaphore(1, REQUEST_TIMEOUT);
        }

        return deviceSemaphores[localName];
    }

    function getTopic(localName, service) {
        return 'linking/' + localName + '_' + service;
    }

    function getBeaconData(data, service) {
        if (service && data[service]) {
            return data[service];
        } else {
            switch(service) {
            case 'battery':
                return {
                    chargeRequired: data.chargeRequired,
                    chargeLevel: data.chargeLevel
                };
            case 'button':
                return {
                    buttonId: data.buttonId,
                    buttonName: data.buttonName
                };
            case 'gyroscope':
            case 'accelerometer':
            case 'orientation':
                return {
                    x: data.x,
                    y: data.y,
                    z: data.z
                };
            default:
                logger.debug('Unsupported beacon data: ' + JSON.strigify(data));
                break;
            }
        }

        return null;
    }

    function initLinking() {
        return new Promise((resolve, reject) => {
            if (initialized) {
                resolve();
            } else {
                linking.init().then(() => {
                    initialized = true;

                    linking.noble.on('scanStart', onNobleScanStart);
                    linking.noble.on('scanStop', onNobleScanStop);
                    linking.noble.on('discover', onNobleDiscover);

                    resolve();
                }).catch((error) => {
                    logger.warn(TAG + 'faild to linking.init(): ' + error);
                    reject(error);
                });
            }
        });
    }

    function onNobleDiscover(peripheral) {
        const ad = peripheral.advertisement;
        if (!ad.localName) {
            // Advertisement from device which hasn't responded to scan request
            logger.log('Advertisement from undiscovered device.');
            return;
        }

        // logger.debug(TAG + 'Got advertisement: ' + ad.localName);

        const advertisement = LinkingAdvertising.parse(peripheral);
        if (advertisement) {
            const localName = advertisement.localName;
            let device = linkingDevices[localName];

            lastBeaconTimes[localName] = os.uptime();

            if (device && device.advertisement.address != advertisement.address) {
                logger.log('Address changed: ' + localName);
                device = null; // Create new LinkingDevice object
            }

            if (device) {
                // Update rssi and distance
                device.advertisement.rssi = advertisement.rssi;
                device.advertisement.distance = advertisement.distance;
            } else {
                device = new LinkingDevice(linking.noble, peripheral);

                if (! device) {
                    logger.warn(TAG + 'Advertisement has no device object');
                    return;
                }

                logger.log(TAG + 'found device: ' + localName);
                linkingDevices[localName] = device;
            }

            const deviceNum =  + Object.keys(linkingDevices).length;
            event.emit('scannerStatus', {fill:'green',shape:'dot',text:'scanning. found ' + deviceNum});
            event.emit('discover', advertisement, device);
        } else {
            logger.warn(TAG + 'Invalid advertisement object');
            return;
        }
    }

    function onNobleScanStart() {
        scanning = true;

        event.emit('scannerStatus', {
            fill:'green',
            shape:'dot',
            text:'scanning. found ' + Object.keys(linkingDevices).length
        });
        event.emit('scanStart');
    }
    
    function onNobleScanStop() {
        scanning = false;

        if (! connectSemaphore.available()) {
            logger.log(TAG + 'scanner suspended for connect operation.');
            event.emit('scannerStatus', {fill:'grey', shape:'dot',text:'suspending'});
            // event.emit('scanStop', true);
        } else if (scannerEnabled) {
            logger.log(TAG + 'scanner interrupted unexpectedly.');
            event.emit('scannerStatus', {fill:'yellow', shape:'dot',text:'interrupted'});
            event.emit('scanStop', false);
        } else {
            logger.log(TAG + 'scanner stopped.');
            event.emit('scannerStatus', {fill:'grey', shape:'dot',text:'idle'});
            event.emit('scanStop', true);
        }
    }

    // This function calls noble.startScanning() directly instead of linking.startScan()
    // and heavyly relied on internal implementation of node-linking.
    // Returns: Promise
    // event : discover, scanStart
    function startNobleScan() {
        return new Promise((resolve, reject) => {
            if (scanning) {
                logger.debug(TAG + 'scanner already started.');
                resolve();
                return;
            }

            // Start scanning beacon
            logger.log(TAG + 'Start scanning.');

            const onError = (error) => {
                logger.warn(TAG + error);
                event.emit('scannerStatus', {fill:'red', shape:'ring',text:'error'});
                reject();
            };

            initLinking().then(() => {
                return scanSemaphore.take();
            }).then(() => {
                if (scanning || ! scannerEnabled) {
                    scanSemaphore.leave();
                    resolve();
                    return;
                }

                event.emit('scannerStatus', {fill:'yellow', shape:'dot',text:'starting scan'});

                linking.noble.startScanning(linking.PRIMARY_SERVICE_UUID_LIST, true, (error) => {
                    scanSemaphore.leave();

                    if (error) {
                        onError(error);
                    } else {
                        // scanning = true // NOTE: The flag is set by event handler
                        resolve();
                    }
                });
            }).catch((error) => {
                onError(error);
            });
        });
    }

    // NOTE: This function also calls noble.stopScanning() directly instead of linking.stopScan()
    // Returns: Promise
    // event: scanStop
    function stopNobleScan() {
        logger.log(TAG + 'Stop scanning.');

        return new Promise((resolve, reject) => {
            if (! scanning) {
                logger.debug(TAG + 'scanner already stopped.');
                resolve();
                return;
            }

            const onError = (error) => {
                logger.warn(TAG + error);
                event.emit('scannerStatus', {fill:'red', shape:'ring',text:'error on stop'});
                reject();
            };
            
            initLinking().then(() => {
                return scanSemaphore.take();
            }).then(() => {
                if (! scanning) {
                    scanSemaphore.leave();
                    resolve();
                    return;
                }

                event.emit('scannerStatus', {fill:'yellow', shape:'dot',text:'stopping scan'});

                linking.noble.stopScanning((error) => {
                    scanSemaphore.leave();

                    if (error) {
                        onError(error);
                    } else {
                        // scanning = false // NOTE: The flag is set by event handler
                        resolve();
                    }
                });
            }).catch((error) => {
                onError(error);
            });
        });
    }

    ////////////////////////////////////////////////////////////////
    // linking-scanner node
    ////////////////////////////////////////////////////////////////
    function LinkingScannerNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        let scanDuration = config.duration || 0;
        let scanDurationTimerId;
        let scanRetryTimerId;

        const scannerLimiter = {};
        let scannerInterval = config.interval || 0;

        function stopScanDurationTimer() {
            if (scanDurationTimerId) {
                clearTimeout(scanDurationTimerId);
                scanDurationTimerId = undefined;
            }
        }

        function stopScanRetryTimer() {
            if (scanRetryTimerId) {
                clearInterval(scanRetryTimerId);
                scanRetryTimerId = undefined;
            }
        }

        function onScannerStatus(status) {
            if (scannerEnabled) {
                node.status(status);
            }
        }

        function onDiscover(advertisement, _device) {
            if (advertisement.beaconDataList && (advertisement.beaconDataList.length)) {
                // Convert beacon data to linking-scanner format
                for (let data of advertisement.beaconDataList) {
                    if (data.serviceId && serviceNames[data.serviceId]) {
                        const localName = advertisement.localName;
                        const service = serviceNames[data.serviceId];

                        // Check rate limit first
                        const topic = getTopic(localName, service);
                        if (scannerLimiter[topic] == null) {
                            scannerLimiter[topic]
                                = new RateLimiter(1, scannerInterval * 1000);
                        } else if (! scannerLimiter[topic].tryRemoveTokens(1)) {
                            return;
                        }

                        const msg = {
                            advertisement: advertisement,
                            payload : {
                                device: localName,
                                service: service,
                                data: getBeaconData(data, service)
                            },
                            topic: topic
                        };

                        node.send(msg);
                    } else {
                        node.debug('Unsupported beacon data: ' + JSON.strigify(data));
                    }
                }
            } else {
                node.debug('Advertisement has no beacon data.');
            }
        }

        async function startScanner() {
            try {
                await startNobleScan();

                event.on('discover', onDiscover);

                // duration timeout handler
                if (0 < scanDuration) {
                    scanDurationTimerId = setTimeout(() => {
                        scannerEnabled = false;

                        stopNobleScan().then(() => {
                            node.log('scan stopped.');
                        }).catch((error) => {
                            node.warn('failed to stop scanning: ' + error);
                        });
                    }, scanDuration * 1000);
                }
            } catch(error) {
                node.error(error);
                // fall through anyway to call setInterval below
            }

            // Start restart checker
            scanRetryTimerId = setInterval(() => {
                if (scannerEnabled && ! scanning &&
                    scanSemaphore.available() && connectSemaphore.available()) {

                    startNobleScan().then(() => {
                        node.log('scan restarted.');
                    }).catch((error) => {
                        node.warn('failed to restart scanning: ' + error);
                    });
                }
            }, SCANNER_RESTART_INTERVAL);
        }

        event.on('scannerStatus', onScannerStatus);

        node.on('input', (msg) => {
            try {
                if (msg.payload) {
                    if (! scannerEnabled || ! scanning) {
                        scannerEnabled = true;

                        scanDuration = (msg && typeof(msg.duration) === 'number')
                            ? msg.duration : config.duration || 0;
        
                        scannerInterval = (msg && typeof(msg.interval) === 'number')
                            ? msg.interval : config.interval || 0;

                        for (let topic in scannerLimiter) {
                            scannerLimiter[topic]
                                = new RateLimiter(1, scannerInterval * 1000);
                        }

                        startScanner();
                    }
                } else {
                    if (scannerEnabled || scanning) {
                        scannerEnabled = false;

                        stopScanDurationTimer();
                        stopScanRetryTimer();
                        event.removeListener('discover', onDiscover);
                    
                        stopNobleScan().then(() => {
                            node.log('scan stopped.');
                        }).catch((error) => {
                            node.warn('failed to stop scanning: ' + error);
                        });
                    }
                }
            } catch(error) {
                node.error(error);
            }
        });

        node.on('close', (remove, done) => {
            function closed() {
                scannerExists = false;
                node.debug('linking-scanner closed.');

                done();
            }

            try {
                // node.debug('linking-scanner closing.');

                stopScanDurationTimer();
                stopScanRetryTimer();
                event.removeListener('discover', onDiscover);
                event.removeListener('scannerStatus', onScannerStatus);
                
                if (remove) {
                    scannerEnabled = false;

                    setImmediate(() => {
                        stopNobleScan().then(() => {
                            // do nothing
                        }).catch((error) => {
                            logger.warn('failed to stop scanning: ' + error);
                        });
                    });
                }

                closed(); // don't wait until stop or node-red will timed out.
            } catch(error) {
                node.error(error);
                closed();
            }
        });

        if (scannerExists) {
            node.status({fill:'red', shape:'ring',text:'Multiple scanner exists'});
        } else {
            scannerExists = true;
            node.status({fill:'grey', shape:'dot',text:'idle'});

            if (config.autostart) {
                try {
                    startScanner();
                } catch(error) {
                    node(error);
                }
            }
        }
    }

    RED.nodes.registerType('linking-scanner', LinkingScannerNode);

    ////////////////////////////////////////////////////////////////
    // Common functions for connect/disconnect
    ////////////////////////////////////////////////////////////////

    // Parameters:
    //    localName
    //    timeout: Optional. Default is 30 seconds.
    // Returns: async LinkingDevie
    function discoverDevice(localName, timeout) {
        return new Promise((resolve, reject) => {
            let scanTimerId;

            function onDiscover(advertisement, device) {
                if (advertisement.localName === localName) {
                    event.removeListener('discover', onDiscover);

                    clearTimeout(scanTimerId);
                    resolve(device);
                }
            }

            function onScanTimeout() {
                const errormsg = 'timed out to get device: ' + localName;
                logger.log(TAG + errormsg);
                event.removeListener('discover', onDiscover);

                scanTimerId = undefined;

                reject(Error(errormsg));
            }

            // check cache first
            if (linkingDevices[localName]) {
                resolve(linkingDevices[localName]);
                return;
            }

            event.on('discover', onDiscover);
            logger.log(TAG + 'scanning to discover: ' + localName);

            startNobleScan().then(() => {
                // scan device for <timeout> secnds
                scanTimerId = setTimeout(onScanTimeout, timeout * 1000);
            }).catch((error) => {
                if (scanTimerId) {
                    clearTimeout(scanTimerId);
                }

                event.removeListener('discover', onDiscover);
                logger.warn(TAG + 'failed to scann: ' + error);

                reject(error);
            });
        });
    }

    // connectDevice
    // Params:
    //    localName
    //    timeout: Optional. Default is 10 seconds.
    // Returns async Device
    async function connectDevice(localName, timeout) {
        let device = linkingDevices[localName];
        if (device && device.connected) {
            return device;
        }

        logger.debug(TAG + 'Request to connect with device: ' + localName);

        try {
            await connectSemaphore.take();

            // Check again. 
            device = linkingDevices[localName];
            if (device && device.connected) {
                connectSemaphore.leave();
                return device;
            }

            if (! device) {
                device = await discoverDevice(localName, timeout);
            }

            if (scanning) {
                logger.debug(TAG + 'Stopping scan to connect.');
                await stopNobleScan();
            }

            // Set connection timeout handler

            const connectWithTimeout = (device) => {
                return new Promise((resolve, reject) => {
                    const connectTimerId = setTimeout(() => {
                        const message = 'connect doesn\'t respond.';

                        logger.log(TAG + message);
                        reject(new Error(message));
                    }, REQUEST_TIMEOUT);

                    device.connect().then(() => {
                        clearTimeout(connectTimerId);
                        resolve();
                    }).catch((error) => {
                        clearTimeout(connectTimerId);
                        reject(error);
                    });
                });
            };

            // connect

            logger.debug(TAG + 'connecting to device: ' + localName);
            await connectWithTimeout(device);
            logger.debug(TAG + 'device connected: ' + localName);

            device.ondisconnect = () => {
                logger.log(TAG + 'device disconnected: ' + localName);
                device.ondisconnect = null;
                event.emit('disconnect', localName);
            };

            for (let service of Object.keys(device.services)) {
                const serviceObj = device.services[service];
                if (serviceObj && ('onnotify' in serviceObj)) {
                    serviceObj.onnotify = (data) => {
                        event.emit('notify', localName, service, data);
                    };
                }
            }

            event.emit('connect', localName);
            connectSemaphore.leave();

            return device;
        } catch(error) {
            logger.warn(error + ': ' + localName);

            try {
                connectSemaphore.leave();
            } catch (error) {
                logger.warn('failed to leave semaphore: ' + error);
            }

            throw error;
        }
    }

    // Returns async
    // eslint-disable-next-line no-unused-vars
    async function disconnectDevice(localName) {
        let leaveSemaphore;

        logger.log(TAG + 'disconnecting device: ' + localName);

        const device = linkingDevices[localName];
        if (! device) {
            const errormsg = 'can\'t disconnect unpaired device: ' + localName;

            logger.debug(TAG + errormsg);
            return;
        }

        // This check might not be necessary
        if (! device.connected) {
            logger.debug(TAG + 'device alread disconnected: ' + localName);
            return;
        }

        try {
            await connectSemaphore.take();
            leaveSemaphore = true;

            // check again
            if (device.connected) {
                await device.disconnect();
                logger.log(TAG + 'disconnected device: ' + localName);
            } else {
                logger.debug(TAG + 'device alread disconnected: ' + localName);
            }

            connectSemaphore.leave();
            leaveSemaphore = false;
        } catch(error) {
            logger.warn(TAG + 'failed to disconnect device: ' + localName);

            if (leaveSemaphore) {
                try {
                    leaveSemaphore = false;
                    connectSemaphore.leave();
                } catch (error) {
                    logger.warn('failed to leave semaphore' + error);
                }
            }

            throw error;
        }
    }

    ////////////////////////////////////////////////////////////////
    // linking-led node
    ////////////////////////////////////////////////////////////////
    function LinkingLedNode(config) {
        RED.nodes.createNode(this, config);
        let node = this;
        let localName = config.device;
        let keepConnection = config.keepConnection;
        let ledEnabled = true;

        const onDisconnect = (name) => {
            if (localName === name) {
                if (ledEnabled) {
                    node.status({fill:'yellow', shape:'dot', text:'disconnected'});
                } else {
                    node.status({fill:'grey', shape:'dot',text:'idle'});
                }
                
                event.removeListener('dicsonnect', onDisconnect);
            }
        };

        node.on('input', async (msg) => {
            // do not use msg.device because of possible connection management issue.
            localName = config.device;
            keepConnection = (msg.keepConnection != null) ? msg.keepConnection : !!config.keepConnection;

            if (! localName) {
                node.error('no device name specified.');
                return;
            }

            const device = linkingDevices[localName];
            if (device && device.services && (! device.services.led)) {
                node.warn('No led service: ' + localName);
                return;
            }

            node.debug('Turning LED on : ' + localName);
            node.status({fill:'yellow', shape:'dot', text:'connecting'});

            await getDeviceSemaphore(localName).take();
            if (! ledEnabled) {
                getDeviceSemaphore(localName).leave();
                return;
            }

            try {
                let device = await connectDevice(localName);
                if (! ledEnabled) {
                    getDeviceSemaphore(localName).leave();
                    return;
                }

                if (! device.services || ! device.services.led) {
                    node.warn('LED service unsupported: ' + localName);
                    node.status({fill:'red', shape:'ring', text:'No led support'});
                    getDeviceSemaphore(localName).leave();

                    return;
                }

                node.status({fill:'green', shape:'dot', text:'connected'});

                if (msg.payload) {
                    try {
                        const res = await device.services.led.turnOn(msg.color, msg.pattern, msg.duration);
                        if (!res.resultCode === 0) {
                            node.warn('led.turnOn() failed. resultCode:'
                                      + res.resultCode + '. ' + res.resultText);
                        }
                    } catch(error) {
                        node.warn('led.turnOn() failed. ' + error);
                        node.status({fill:'red', shape:'ring', text:'turnOn error'});
                    }
                } else {
                    try {
                        // turn off led
                        await device.services.led.turnOff();
                        // do nothing about result code
                    } catch(error) {
                        node.log('led.turnOff() failed. ' + error);
                        node.status({fill:'red', shape:'ring', text:'turnOff error'});
                    }
                }
            } catch(error) {
                node.log('failed to connect ' + localName + ' : ' + error);
                node.status({fill:'red', shape:'ring', text:'connect error'});
            } finally {
                if (! keepConnection) {
                    try {
                        await disconnectDevice(localName);
                    } catch(error) {
                        node.log('failed to disconnect ' + localName + ' : ' + error);
                    }
                }

                getDeviceSemaphore(localName).leave();
            }
        });

        node.on('close', async (done) => {
            function closed() {
                node.debug('linking-led closed.');
                node.status({fill:'grey', shape:'dot',text:'idle'});

                done();
            }

            ledEnabled = true;
            // node.debug('linking-led closing.');

            event.removeListener('disconnect', onDisconnect);

            if (linkingDevices[localName] &&linkingDevices[localName].connected) {
                node.status({fill:'yellow', shape:'dot',text:'disconnecting'});

                await getDeviceSemaphore(localName).take();

                try {
                    await disconnectDevice(localName);
                    closed();
                } catch(error) {
                    node.warn('failed to disconnect: ' + localName + ': ' + error);
                    closed();
                } finally {
                    getDeviceSemaphore(localName).leave();
                }
            } else {
                closed();
            }
        });

        event.on('disconnect', onDisconnect);
        /*
        process.on('exit', () => {
            if (ledEnabled) {
                disconnectDevice(localName);
            }
        }
        */

        node.status({fill:'grey', shape:'dot',text:'idle'});

        if (config.keepConnection) {
            setTimeout(() => {
                if (ledEnabled) {
                    connectDevice(localName).then(() => {
                        node.status({fill:'green', shape:'dot', text:'connected'});
                    }).catch((error) => {
                        node.log('failed to connect: ' + error);
                        node.status({fill:'red', shape:'ring', text:'onnect error'});
                    });
                }
            }, AUTOSTART_INTERVAL);
        }
    }

    RED.nodes.registerType('linking-led',LinkingLedNode);

    ////////////////////////////////////////////////////////////////
    // linking-sensor node
    ////////////////////////////////////////////////////////////////
    function LinkingSensorNode(config) {
        RED.nodes.createNode(this, config);

        let node = this;
        let localName = config.device;
        let sensorServices = config.services || {};
        let messageLimiter = {};

        let sensorEnabled = config.autostart;
        let sensorInterval = 0; // seconds
        let timerIds = [];

        let notifyCount = 0;

        function setRestartTimer(service) {
            if (sensorEnabled && sensorServices[service]) {
                const id = setTimeout(() => {
                    try {
                        startSensor(service);
                    } catch(error) {
                        node.warn('failed to restart sensor: ' + localName + '/' + service + ': ' + error);
                    }

                    timerIds.splice(timerIds.indexOf(id), 1);
                }, Math.max(60 * 1000, sensorInterval * 1000));

                timerIds.push(id);
            }
        }

        function clearRestartTimer() {
            let id;
            while ((id = timerIds.pop()) != null) {
                clearTimeout(id);
            }
        }

        async function startSensor(service) {
            const postfixMsg = ': '+ localName + '/' + service;
            node.debug('startSensor' + postfixMsg);

            if (! sensorEnabled) {
                node.warn('startSensor() called while !sensorEnabled.');
                return;
            }

            await getDeviceSemaphore(localName).take();

            if (! sensorEnabled) {
                return;
            }
            
            try {
                let device = await connectDevice(localName);

                if (! device.services || ! device.services[service]) {
                    const errmsg = 'invalid service: ' + localName + '/' + service;
                    node.warn(errmsg);
                    node.status({fill:'red', shape:'ring', text:'error'});

                    // Just ignore the error not to restart
                    // throw new Error(errmsg);
                    return;
                }

                // The sensor doen't require start() but it is expected condition.
                if (typeof(device.services[service].start) !== 'function') {
                    setRestartTimer(service);	// Set restart in case of disconnection
                    return;
                }

                if (! sensorEnabled) {
                    getDeviceSemaphore(localName).leave();

                    // Assumed that the linking-sensor is disabled while connecting to device. So disconnect.
                    // This will take semaphore
                    disconnectToStopAllSensors();
                    return;
                }

                DEBUG && node.debug('starting sensor' + postfixMsg);

                try {
                    const result = await device.services[service].start();

                    DEBUG && node.debug('sensor started' + postfixMsg);

                    if (result.resultCode === 0) {
                        node.status({fill:'green', shape:'dot', text:notifyCount + ' notifications'});
                    } else {
                        node.log('failed to start ' + service + ': ' + result.resultText);
                        node.status({fill:'red', shape:'ring', text:service + ' error'});
                    }
                } catch(error) {
                    node.log('failed to start sensor' + postfixMsg);
                    node.status({fill:'red', shape:'ring', text:service + ' error'});

                    setRestartTimer(service);
                } finally {
                    getDeviceSemaphore(localName).leave();
                }
            } catch(error) {
                node.log('failed to connect' + postfixMsg);
                node.status({fill:'red', shape:'ring', text:'connect error'});

                getDeviceSemaphore(localName).leave();
                setRestartTimer(service);
            }
        }

        async function stopSensor(service) {
            const postfixMsg = ': '+ localName + '/' + service;
            const device = linkingDevices[localName];
            node.debug('stopSensor : ' + localName + '/' + service);

            if (device && device.services && device.services[service]) {
                if ((! sensorEnabled || 60 <= sensorInterval) &&
                    typeof(device.services[service].stop) === 'function') {

                    await getDeviceSemaphore(localName).take();
                    if (! sensorEnabled) {
                        return;
                    }

                    try {
                        DEBUG && node.debug('stopping sensor' + postfixMsg);

                        await device.services[service].stop();

                        DEBUG && node.debug('sensor stopped' + postfixMsg);
                    } catch(error) {
                        node.log('failed to stop sensor' + postfixMsg);
                    } finally {
                        getDeviceSemaphore(localName).leave();
                    }
                }

                // calling stop() isn't required but call this to reconnect if disconnected.
                setRestartTimer(service);
            } else {
                const errmsg = 'invalid service: ' + localName + '/' + service;
                node.warn(errmsg);
                node.status({fill:'red', shape:'ring', text:'error'});

                // Just ignore the error not to restart
                // throw new Error(errmsg);
            }
        }

        async function startAllSensors() {
            node.debug('Starting sensor: ' + localName);
            node.status({fill:'yellow', shape:'dot', text:'connecting'});

            if (! sensorEnabled) {
                return;
            }

            // NOTE: Taking semaphore not necessary. startSensor() will do this.

            try {
                const device = await connectDevice(localName);

                // If no service configuration then watch all available sensors.
                if (! sensorServices) {
                    sensorServices = device.services;
                }

                for(let service in sensorServices) {
                    const serviceObj = device.services[service];
                    if (sensorServices[service] != null && ('onnotify' in serviceObj)) {
                        if (typeof(serviceObj.start) === 'function') {
                            messageLimiter[service]
                                = new RateLimiter(1, sensorInterval * 1000);
                        }

                        try {
                            if (sensorServices[service]) {
                                await startSensor(service);
                            }
                        } catch (error) {
                            node.warn('error starting sensor: ' + service);
                        }
                    }
                }

                // startSensor() would change this status later
                node.status({fill:'green', shape:'dot', text:'connected'});
            } catch(error) {
                node.warn('failed to connect ' + localName + ' : ' + error);
                node.status({fill:'red', shape:'ring', text:'connect error'});

                // Retry
                const id = setTimeout(() => {
                    startAllSensors();

                    timerIds.splice(timerIds.indexOf(id), 1);
                }, Math.max(60 * 1000, sensorInterval * 1000));

                timerIds.push(id);
            }
        }

        async function disconnectToStopAllSensors() {
            if (sensorEnabled) {
                node.info('disconnectToStopAllSensors(): Unexpected condition. skip');
                return;
            }

            clearRestartTimer();

            node.debug('Disconnecting to stop all sensors: ' + localName);
            node.status({fill:'yellow', shape:'dot', text:'disconnecting'});
                    
            await getDeviceSemaphore(localName).take();

            try {
                await disconnectDevice(localName);
                // onDisconnect will set this status. but set also here if already disconnected
                node.status({fill:'grey', shape:'dot', text:'idle'});
            } catch(error) {
                node.warn('failed to disconnect: ' + localName + ': ' + error);
                node.status({fill:'red', shape:'ring', text:'disconnect error'});
            } finally {
                getDeviceSemaphore(localName).leave();
            }
        }

        function onNotify(name, service, data) {
            if (localName === name && sensorEnabled) {
                const limiter = messageLimiter[service];
                if (limiter != null && ! limiter.tryRemoveTokens(1)) {
                    // throttling this message
                    return;
                }

                notifyCount++;
                node.status({fill:'green', shape:'dot', text:notifyCount + ' notifications'});

                const msg = {
                    payload: {
                        device: name,
                        service: service,
                        data: getBeaconData(data, service)
                    },
                    topic: getTopic(localName, service)
                };

                node.send(msg);
                stopSensor(service);
            }
        }

        function onDisconnect(name) {
            if (localName === name) {
                notifyCount = 0;

                if (sensorEnabled) {
                    node.status({fill:'yellow', shape:'dot', text:'disconnected'});
                } else {
                    node.status({fill:'grey', shape:'dot', text:'idle'});
                }
            }
        }

        event.on('notify', onNotify);
        event.on('disconnect', onDisconnect);

        node.on('input', async (msg) => {
            sensorEnabled = !!msg.payload;

            // do not use msg.device because of possible connection management issue..
            localName = config.device;
            sensorInterval = (msg && typeof(msg.interval) === 'number')
                ? msg.interval : config.interval || 0;
            sensorServices = msg.services || config.services;

            try {
                if (! localName) {
                    node.error('no device name specified.');
                    node.status({fill:'red', shape:'ring', text:'no device name'});
                    return;
                }

                if (sensorEnabled) {
                    startAllSensors();
                } else {
                    // NOTE: will take semaphore
                    disconnectToStopAllSensors();
                }
            } catch(error) {
                node.error('exception: ' + error);
                node.status({fill:'red', shape:'ring', text:'error'});
            }
        });

        node.on('close', async (done) => {
            sensorEnabled = false;

            function closed() {
                node.debug('linking-sensor closed.');
                done();
            }

            // node.debug('linking-sensor closing.');

            event.removeListener('disconnect', onDisconnect);
            event.removeListener('notify', onNotify);
            
            // Call disconnectToStopAllSensors() even if disconnected to clear timers.
            if (linkingDevices[localName]/* && linkingDevices[localName].connected*/) {
                node.status({fill:'yellow', shape:'dot',text:'disconnecting'});

                try {
                    // NOTE: will take care of semaphore
                    await disconnectToStopAllSensors();

                    node.status({fill:'grey', shape:'dot', text:'idle'});
                } catch(error) {
                    node.warn('failed to disconnect: ' + localName + ':' + error);
                    node.status({fill:'yellow', shape:'dot',text:'disconnect error'});
                } finally {
                    closed();
                }
            } else {
                node.status({fill:'grey', shape:'dot', text:'idle'});
                closed();
            }
        });

        /*
        process.on('exit', () => {
            if (sensorEnabled) {
                disconnectDevice(localName);
            }
        }
        */
        if (config.autostart) {
            setTimeout(() => {
                if (sensorEnabled) {
                    node.emit('input', {payload: true});
                }
            }, AUTOSTART_INTERVAL);
        }
    }

    RED.nodes.registerType('linking-sensor',LinkingSensorNode);

    ////////////////////////////////////////////////////////////////
    // endpoints for preference
    ////////////////////////////////////////////////////////////////
    
    // Returns [{name: "Tsukeru_th01234", rssi: -96, distance: 1.2}, {}...]
    RED.httpAdmin.get('/linking-device/getDevices', (req, res) => {
        const TAG = 'linking-device/getDevices';
        const forceScan = req.query.forceScan;

        try {
            // logger.log(TAG);

            const sendResponse = () => {
                if (Object.keys(linkingDevices).length > 0) {
                    // data: array of {text:<localName>, value:<address>}
                    const response = Object.keys(linkingDevices).map((localName) => {
                        const peripheral = linkingDevices[localName]._peripheral;
                        const sinceLastBeacon = os.uptime() - lastBeaconTimes[localName];

                        return {
                            name: localName,
                            rssi: peripheral.rssi,
                            sinceLastBeacon: sinceLastBeacon
                        };
                    });
                    
                    // logger.log(TAG + ' returns ' + response.length + ' devices.');
                    res.status(200).send(response);
                } else {
                    logger.log(TAG + ' no device found.');
                    res.status(404).send('No device found. Please scan again later.');
                }
            };

            if (scanning || ! forceScan) {
                sendResponse();
            } else {
                discoverDevice('dummy', 10).then(sendResponse).catch((error) => {
                    if (error.message.startsWith('time')) {
                        sendResponse();
                    } else {
                        logger.error(error);
                        res.status(500).send(error.message);
                    }
                });
            }
        } catch(error) {
            logger.error(error);
            res.status(500).send(error.message);
        }
    });

    // Returns services of specified device
    RED.httpAdmin.get('/linking-device/disconnect/:localName', (req, res) => {
        const localName = req.params.localName;

        try {
            logger.log('linking-device/disconnect/' + localName);

            if (! localName) {
                logger.warn('linking-device/disconnects/ failed: no localName specified');
                res.status(400).send('No device name.');
                return;
            }

            disconnectDevice(localName).then(() => {
                res.status(200).send();
            }).catch((error) => {
                logger.warn('linking-device/disconnects/ failed to disconnect ' + localName + ' : ' + error);
                res.status(500).send(error.message);
            });
        } catch(error) {
            logger.warn('linking-device/disconnects/ failed to disconnect ' + localName + ' : ' + error);
            res.status(500).send(error.message);
        }
    });

    // Returns services of specified device
    RED.httpAdmin.get('/linking-device/getServices/:localName', (req, res) => {
        const localName = req.params.localName;

        try {
            logger.log('linking-device/getServices/' + localName);

            if (! localName) {
                logger.warn('linking-device/getServices/ failed: no localName specified');
                res.status(400).send('No device name.');
                return;
            }

            const services = linkingDevices[localName] && linkingDevices[localName].services;

            if (services) {
                res.status(200).send(services);
            } else {
                connectDevice(localName).then((device) => {
                    logger.debug('Service of ' + localName + ':' + JSON.stringify(device.services));
                    res.status(200).send(device.services);
                }).catch((error) => {
                    logger.warn('linking-device/getServices/ failed to connect ' + localName + ' : ' + error);
                    res.status(404).send(error.message);
                });
            }
        } catch(error) {
            logger.error('linking-device/getServices/ failed: ' + error);
            res.status(500).send(error.message);
        }
    });

    // Turn on led of specified device
    RED.httpAdmin.get('/linking-device/turnOnLed/:localName', (req, res) => {
        const localName = req.params.localName;
        const color = req.query.color;
        const pattern = req.query.pattern;

        try {
            logger.debug('linking-device/turnOnLed/' + localName + '/' + color + '/' + pattern);

            if (! localName) {
                logger.warn('linking-device/getServices/ failed: no localName specified');
                res.status(404).send('No device name.');
                return;
            }

            const device = linkingDevices[localName];
            if (device && device.services && (! device.services.led)) {
                logger.warn('linking-device/turnOnLed/ failed. no led service: ' + localName);
                res.status(404).send('The device has no led service.');
                return;
            }
            
            connectDevice(localName).then(async (device) => {
                if (device.services && device.services.led) {

                    logger.debug('calling led.turnOn()');
                    device.services.led.turnOn(color, pattern).then((result) => {
                        if (result.resultCode === 0) {
                            res.status(200).send();
                        } else {
                            const message = 'Failed to turn on LED. resultCode: '
                                  + result.resultCode + ': ' + result.resultText;
                            logger.warn(message);
                            res.status(500).send(message);
                        }
                    }).catch((error) => {
                        logger.warn('led.turnOn() failed. ' + error);
                        res.status(500).send(error.message);
                    });
                } else {
                    logger.warn('linking-device/turnOnLed/ failed: no led service: ' + localName);
                    res.status(404).send('The device as no led service.');
                    return;
                }
            }).catch((error) => {
                logger.warn('linking-device/turnOnLed/ failed to connect ' + localName + ' : ' + error);
                res.status(404).send(error.message);
                return;
            });
        } catch(error) {
            logger.error('linking-device/turnOnLed/ failed: ' + error);
            res.status(500).send(error.message);
        }

    });
};

