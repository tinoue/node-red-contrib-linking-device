const EventEmitter = require('events').EventEmitter;
const Semaphore = require('semaphore');
const RateLimiter = require('limiter').RateLimiter;

const Linking = require('node-linking');
const LinkingAdvertising = require('node-linking/lib/modules/advertising');
const LinkingDevice = require('node-linking/lib/modules/device');
const linking = new Linking();

const TAG = 'linking-device: ';

const MAX_CONNECTION_INTERVAL = 500;  // 500ms
const REQUEST_TIMEOUT = 60 * 1000;	// 1sec
const SCANNER_RESTART_INTERVAL = 60 * 1000;	// 1sec

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
    let deviceServices = {};    // key: localName, value: services

    ////////////////////////////////////////////////////////////////
    // Common function for scanning (discovery)
    ////////////////////////////////////////////////////////////////

    function sleep(msec) {
        return new Promise((resolve, _reject) => {
            if (msec === 0) {
                resolve();
            } else {
                setTimeout(resolve, msec);
            }
        });
    }

    function getTopic(localName, service) {
        return 'linking/' + localName + '_' + service;
    }

    function getBeaconData(data) {
        if (data.serviceId) {
            const serviceName = serviceNames[data.serviceId];

            if (data[serviceName]) {
                return data[serviceName];
            } else {
                switch(serviceName) {
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
            return;
        }

        // logger.debug(TAG + 'Got advertisement: ' + ad.localName);

        const advertisement = LinkingAdvertising.parse(peripheral);
        if (advertisement) {
            let device = linkingDevices[advertisement.localName];

            if (! device) {
                device = new LinkingDevice(linking.noble, peripheral);

                if (! device) {
                    logger.warn(TAG + 'Advertisement has no device object');
                    return;
                }

                logger.log(TAG + 'found device: ' + advertisement.localName);
                linkingDevices[advertisement.localName] = device;
            }

            const deviceNum =  + Object.keys(linkingDevices).length;
            event.emit('scannerStatus', {fill:'green',shape:'dot',text:'scanning. found ' + deviceNum});
            event.emit('discover', advertisement, device);
        } else {
            logger.warn(TAG + 'Invalid advertisement object');
            return;
        }
    } // onNobleDiscover()

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
                if (scanning) {
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
                clearTimeout(scanRetryTimerId);
                scanRetryTimerId = undefined;
            }
        }

        function onScannerStatus(status) {
            node.status(status);
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
                                data: getBeaconData(data)
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
                node.debug('linking-scanner closing.');

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
    function getDevice(localName, timeout) {
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
        let connectTimerId;
        let leaveSemaphore;

        logger.debug(TAG + 'Got request to connect to device: ' + localName);

        let device = linkingDevices[localName];
        if (device && device.connected) {
            return device;
        }

        try {
            await connectSemaphore.take();
            leaveSemaphore = true;

            // Check again. 
            device = linkingDevices[localName];
            if (device && device.connected) {
                connectSemaphore.leave();
                return device;
            }

            if (! device) {
                device = await getDevice(localName, timeout);
            }

            if (scanning) {
                logger.debug(TAG + 'Stopping scan to connect.');
                await stopNobleScan();
            }

            connectTimerId = setTimeout(() => {
                const message = 'connection timeout.';

                logger.log(TAG + message);
                if (leaveSemaphore) {
                    try {
                        connectSemaphore.leave();
                        leaveSemaphore = false;
                    } catch(error) {
                        logger.warn('connectSemaphore: ' + error);
                    }
                }
            }, REQUEST_TIMEOUT);

            logger.debug(TAG + 'connecting to device: ' + localName);
            await device.connect();
            logger.debug(TAG + 'device connected: ' + localName);

            deviceServices[localName] = device.services;
            clearTimeout(connectTimerId);

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

            clearTimeout(connectTimerId);
            connectSemaphore.leave();
            leaveSemaphore = false;

            return device;
        } catch(error) {
            logger.warn(error);

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

    // Returns async
    // eslint-disable-next-line no-unused-vars
    async function disconnectDevice(localName) {
        let leaveSemaphore;

        logger.log(TAG + 'disconnecting device: ' + localName);

        const device = linkingDevices[localName];
        if (! device) {
            const errormsg = 'can\t disconnect unpaired device: ' + localName;

            logger.debug(TAG + errormsg);
            throw new Error(errormsg);
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

        const onDisconnect = (name) => {
            if (localName === name) {
                node.status({fill:'yellow', shape:'dot', text:'disconnected'});
                event.removeListener('dicsonnect', onDisconnect);
            }
        };

        try {
            node.on('input', async (msg) => {
                localName = msg.device || config.device;

                if (! localName) {
                    node.error('no device name specified.');
                    return;
                }

                if (linkingDevices[localName] &&
                    deviceServices[localName] && (! deviceServices[localName].led)) {

                    node.warn('No led service: ' + localName);
                    return;
                }

                node.debug('Turning LED on : ' + localName);
                node.status({fill:'yellow', shape:'dot', text:'connecting'});

                try {
                    let device = await connectDevice(localName);

                    if (! device.services || ! device.services.led) {
                        node.warn('LED service unsupported: ' + localName);
                        node.status({fill:'red', shape:'ring', text:'No led support'});
                        return;
                    }

                    event.on('disconnect', onDisconnect);
                    node.status({fill:'green', shape:'dot', text:'connected'});

                    if (msg.payload) {
                    // turn on led
                        try {
                            const res = await device.services.led.turnOn(msg.color, msg.pattern, msg.duration);
                            if (!res.resultCode === 0) {
                                node.warn('led.turnOn() failed. resultCode:'
                                          + res.resultCode + '. ' + res.resultText);
                            }
                        } catch(error) {
                            node.info('led.turnOn() failed. ' + error);
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
                }
            });

            node.on('close', (done) => {
                function closed() {
                    node.debug('linking-led closed.');
                    node.status({fill:'grey', shape:'dot',text:'idle'});

                    done();
                }

                node.debug('linking-led closing.');

                event.removeListener('disconnect', onDisconnect);

                if (linkingDevices[localName] &&linkingDevices[localName].connected) {
                    node.status({fill:'yellow', shape:'dot',text:'disconnecting'});

                    disconnectDevice(localName).then(() => {
                        closed();
                    }).catch((error) => {
                        node.warn('failed to disconnect: ' + localName + ': ' + error);
                        closed();
                    });
                } else {
                    closed();
                }
            });

            node.status({fill:'grey', shape:'dot',text:'idle'});
        } catch(e) {
            node.error('linking-led: ' + e);
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

        let sensorEnabled = false;
        let sensorInterval = 0; // seconds
        let requestSemaphore = new PromiseSemaphore(1, REQUEST_TIMEOUT);

        let notifyCount = 0;

        function setRestartTimer(service) {
            if (sensorEnabled && sensorServices[service]) {
                setTimeout(() => {
                    try {
                        startSensor(service);
                    } catch(error) {
                        node.warn('failed to restart sensor: ' + localName + '/' + service + ': ' + error);
                    }
                }, Math.max(60 * 1000, sensorInterval * 1000));
            }
        }

        async function startSensor(service) {
            const postfixMsg = ': '+ localName + '/' + service;
            node.debug('startSensor' + postfixMsg);

            if (! sensorEnabled) {
                return;
            }

            try {
                let device = await connectDevice(localName);

                if (! sensorEnabled) {
                    return;
                }

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

                await requestSemaphore.take();

                if (! sensorEnabled) {
                    requestSemaphore.leave();
                    return;
                }

                node.debug('starting sensor' + postfixMsg);

                try {
                    const result = await device.services[service].start();

                    node.debug('sensor started' + postfixMsg);

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
                    requestSemaphore.leave();
                }
            } catch(error) {
                node.log('failed to connect' + postfixMsg);
                node.status({fill:'red', shape:'ring', text:'connect error'});

                setRestartTimer(service);
            }
        }

        async function stopSensor(service) {
            const postfixMsg = ': '+ localName + '/' + service;
            const device = linkingDevices[localName];
            node.debug('stopSensor ' + localName + '/' + service);

            if (device && device.services && device.services[service]) {
                if ((! sensorEnabled || 60 <= sensorInterval) &&
                    typeof(device.services[service].stop) === 'function') {

                    try {
                        node.debug('stopping sensor' + postfixMsg);
                        await requestSemaphore.take();
                        await device.services[service].stop();
                        node.debug('sensor stopped' + postfixMsg);
                    } catch(error) {
                        node.log('failed to stop sensor' + postfixMsg);
                    } finally {
                        requestSemaphore.leave();
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
                        data: getBeaconData(data)
                    },
                    topic: getTopic(localName, service)
                };

                node.send(msg);
                stopSensor(service);
            }
        }

        function onDisconnect(name) {
            if (localName === name) {
                if (sensorEnabled) {
                    node.status({fill:'yellow', shape:'dot', text:'disconnected'});
                }
            }
        }

        event.on('notify', onNotify);
        event.on('disconnect', onDisconnect);

        node.on('input', (msg) => {
            try {
                sensorEnabled = msg.payload;

                localName = config.device;
                sensorInterval = (msg && typeof(msg.interval) === 'number')
                    ? msg.interval : config.interval || 0;
                sensorServices = msg.services || config.services;

                if (! localName) {
                    node.error('no device name specified.');
                    node.status({fill:'red', shape:'ring', text:'no device name'});
                    return;
                }

                node.debug('Starting sensor: ' + localName);
                node.status({fill:'yellow', shape:'dot', text:'connecting'});

                connectDevice(localName).then(async (device) => {
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
                                if (sensorEnabled && sensorServices[service] === true) {
                                    await startSensor(service);
                                } else {
                                    await stopSensor(service);
                                }

                                await sleep(MAX_CONNECTION_INTERVAL);
                            } catch (error) {
                                node.warn('error start/stopping sensor: ' + service);
                            }
                        }
                    }

                    if (sensorEnabled) {
                        // startSensor() would change this status later
                        node.status({fill:'green', shape:'dot', text:'connected'});
                    } else {
                        node.status({fill:'grey', shape:'dot', text:'idle'});
                    }
                }).catch((error) => {
                    node.error('failed to connect ' + localName + ' : ' + error);
                    node.status({fill:'red', shape:'ring', text:'connect error'});
                });
            } catch(error) {
                node.error('exception: ' + error);
                node.status({fill:'red', shape:'ring', text:'error'});
            }
        });

        node.on('close', (done) => {
            sensorEnabled = false;

            function closed() {
                node.debug('linking-sensor closed.');
                done();
            }

            node.debug('linking-sensor closing.');

            event.removeListener('disconnect', onDisconnect);
            event.removeListener('notify', onNotify);
            
            if (linkingDevices[localName] && linkingDevices[localName].connected) {
                node.status({fill:'yellow', shape:'dot',text:'disconnecting'});

                disconnectDevice(localName).then(() => {
                    closed();
                }).catch((error) => {
                    node.warn('failed to disconnect: ' + localName + ':' + error);
                    closed();
                });
            } else {
                closed();
            }

            node.status({fill:'grey', shape:'dot', text:'idle'});
        });
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
            logger.log(TAG);

            const sendResponse = () => {
                if (Object.keys(linkingDevices).length > 0) {
                    // data: array of {text:<localName>, value:<address>}
                    const response = Object.keys(linkingDevices).map((localName) => {
                        const advertisement = linkingDevices[localName].advertisement;

                        return {
                            name: localName,
                            rssi: advertisement.rssi,
                            distance: Math.round(advertisement.distance * 10) / 10
                        };
                    });
                    
                    logger.log(TAG + ' returns ' + response.length + ' devices.');
                    res.status(200).send(response);
                } else {
                    logger.log(TAG + ' no device found.');
                    res.status(404).send('No device found. Please scan again later.');
                }
            };

            if (scanning || ! forceScan) {
                sendResponse();
            } else {
                getDevice('dummy', 10).then(sendResponse).catch((error) => {
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
    RED.httpAdmin.get('/linking-device/getServices/:localName', (req, res) => {
        const localName = req.params.localName;

        try {
            logger.log('linking-device/getServices/' + localName);

            if (! localName) {
                logger.warn('linking-device/getServices/ failed: no localName specified');
                res.status(400).send('No device name.');
                return;
            }

            const services = deviceServices[localName];

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

            if (linkingDevices[localName] &&
                deviceServices[localName] && (! deviceServices[localName].led)) {

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

