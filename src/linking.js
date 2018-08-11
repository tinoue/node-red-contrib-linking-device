const EventEmitter = require('events').EventEmitter;
const connectSem = require('semaphore')(1);

const Linking = require('node-linking');
const LinkingAdvertising = require('node-linking/lib/modules/advertising');
const LinkingDevice = require('node-linking/lib/modules/device');
const linking = new Linking();

const TAG = 'linking-device: ';

module.exports = function(RED) {
    const logger = console;
    // manages internal events - discover, scanStart, scanStop, scanStatus, connect, disconnect
    const event = new EventEmitter();

    var scanning = false;

    var scanRequestNum = 0;		// # of scan request from linking-scanner
    var connectingRequestNum = 0;	// # of devices which trying to connect (doesn't include devices connected)

    var linkingDevices = {};    // key: localName, value: device object
    var deviceServices = {};    // key: localName, value: services

    ////////////////////////////////////////////////////////////////
    // Common function for scanning (discovery)
    ////////////////////////////////////////////////////////////////

    function initLinking() {
        var initialized = false;

        return new Promise((resolve, reject) => {
            if (initialized) {
                resolve();
            } else {
                linking.init().then(function() {
                    initialized = true;
                    resolve();
                }).catch(function(error) {
                    logger.warn(TAG + 'faild to linking.init(): ' + error);
                    reject(error);
                });
            }
        });
    }

    function onNobleDiscover(peripheral) {
        const ad = peripheral.advertisement;
        if (!ad.localName) {
            // logger.warn(TAG + 'Invalid advertisement. No localName.');
            return;
        }

        logger.debug(TAG + 'Got advertisement: ' + ad.localName);

        const advertisement = LinkingAdvertising.parse(peripheral);
        if (advertisement) {
            const device = new LinkingDevice(linking.noble, peripheral);
            if (device) {
                if (! linkingDevices[advertisement.localName]) {
                    logger.log(TAG + 'found device: ' + advertisement.localName);
                    linkingDevices[advertisement.localName] = device;
                }

                const deviceNum =  + Object.keys(linkingDevices).length;
                event.emit('scanStatus', {fill:'green',shape:'dot',text:'scanning. found ' + deviceNum});
                event.emit('discover', advertisement, device);
            } else {
                logger.warn(TAG + 'Advertisement has no device object');
                return;
            }
        } else {
            logger.warn(TAG + 'Invalid advertisement object');
            return;
        }
    } // onNobleDiscover()

    function onNobleScanStart() {
        scanning = true;

        event.emit('scanStatus', {fill:'green', shape:'dot',text:'scanning. found ' + Object.keys(linkingDevices).length});
        event.emit('scanStart');
    }
    
    function onNobleScanStop() {
        scanning = false;

        if (0 < connectingRequestNum) {
            logger.log(TAG + 'scanner suspending for connect operation.');
            event.emit('scanStatus', {fill:'grey', shape:'dot',text:'suspending'});
            // event.emit('scanStop', true);
        } else if (0 < scanRequestNum) {
            logger.log(TAG + 'scanner interrupted unexpectedly.');
            event.emit('scanStatus', {fill:'yellow', shape:'dot',text:'interrupted'});
            event.emit('scanStop', false);
        } else {
            logger.log(TAG + 'scanner stopped.');
            event.emit('scanStatus', {fill:'grey', shape:'dot',text:'idle'});
            event.emit('scanStop', true);
        }
    }

    // This function calls noble.startScanning() directly instead of linking.startScan()
    // and heavyly relied on internal implementation of node-linking.
    // Params:
    //   resume: if true, resume to start scanning if necessary
    // Returns: Promise
    // event : discover, scanStart
    function startNobleScan(resume) {
        return new Promise(function(resolve, reject) {
            if (resume) {
                if (scanRequestNum <= 0) {
                    logger.log(TAG + 'no need to resume scanning.');
                    resolve();
                }
            } else {
                scanRequestNum++;
            }

            // Start scanning beacon
            logger.log(TAG + 'Start scanning.');

            if (scanning) {
                logger.log(TAG + 'scanner already started.');
                resolve();
            }

            scanning = true;
            event.emit('scanStatus', {fill:'yellow', shape:'dot',text:'starting scan'});

            initLinking().then(function() {
                linking.noble.startScanning(linking.PRIMARY_SERVICE_UUID_LIST, true, function(error) {
                    if (error) {
                        logger.error(TAG + error);
                        scanRequestNum--;
                        reject();
                    } else {
                        resolve();
                    }
                });
            }).catch(function(error) {
                scanning = false;

                logger.error(TAG + error);
                scanRequestNum--;
                event.emit('scanStatus', {fill:'red', shape:'ring',text:'error'});
                reject();
            });
        });
    }

    // NOTE: This function also calls noble.stopScanning() directly instead of linking.stopScan()
    // Params:
    //   suspend: if true, force calling noble.stopScanning regardless of scanRequestNum
    // Returns: Promise
    // event: scanStop
    function stopNobleScan(suspend) {
        logger.log(TAG + 'Stop scanning.');

        return new Promise(function(resolve, reject) {
            if (! suspend) {
                scanRequestNum--;
                if (0 < scanRequestNum) {
                    logger.log(TAG + 'skip to stop scanning. other module want to keep scanning.');
                    resolve();
                }
            }

            if (! scanning) {
                logger.log(TAG + 'scanner already stopped.');
                resolve();
            }

            event.emit('scanStatus', {fill:'yellow', shape:'dot',text:'stopping scan'});
            
            initLinking().then(function() {
                linking.noble.stopScanning(function(error) {
                    if (error) {
                        logger.error(TAG + error);
                        event.emit('scanStatus', {fill:'red', shape:'ring',text:'error on stop'});
                        reject();
                    } else {
                        // scanStop event handler will do the job
                        resolve();
                    }
                });
            }).catch(function(error) {
                logger.error(TAG + error);
                event.emit('scanStatus', {fill:'red', shape:'ring',text:'error on stop'});
                reject();
            });
        });
    }

    initLinking().then(function() {
        linking.noble.on('scanStart', onNobleScanStart);
        linking.noble.on('scanStop', onNobleScanStop);
        linking.noble.on('discover', onNobleDiscover);
    }).catch(function(error) {
        console.error(TAG + 'initLinking failed: ' + error);
    });

    ////////////////////////////////////////////////////////////////
    // linking-scanner node
    ////////////////////////////////////////////////////////////////
    function LinkingScannerNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        let scanDuration;
        let scanTimerId;

        function stopScanTimer() {
            if (scanTimerId) {
                clearTimeout(scanTimerId);
                scanTimerId = undefined;
            }
        }

        function onScanStatus(status) {
            node.status(status);
        }

        function onDiscover(advertisement, _device) {
            let msg = {};
    
            // original advertisement data
            msg.advertisement = advertisement;
    
            // set simplified payload
            msg.localName = advertisement.localName;
            msg.address = advertisement.address;
            msg.distance = advertisement.distance;
            msg.rssi = advertisement.rssi;
    
            if (advertisement.beaconDataList && (advertisement.beaconDataList.length)) {
                for (let data of advertisement.beaconDataList) {
                    msg.payload = data;
                    node.send([msg, null]);
                }
            } else {
                msg.payload = {};
                node.send([msg, null]);
            }
        }

        function startScan() {
            try {
                startNobleScan().then(function() {
                    event.on('discover', onDiscover);
                    event.once('scanStop', function(normal) {
                        node.send([null, normal]);
                    });

                    if (0 < scanDuration) {
                        scanTimerId = setTimeout(function() {
                            stopNobleScan();
                        }, scanDuration * 1000);
                    }
                }).catch(function(_error) {
                    // failed to start scan
                    node.send([null, false]);
                });
            } catch(error) {
                node.error(error);
            }
        }

        event.on('scanStatus', onScanStatus);

        node.on('input', function(msg) {
            try {
                if (msg.payload) {
                    scanDuration = (msg && typeof(msg.duration) === 'number')
                        ? msg.duration : config.duration;
                    startScan();
                } else {
                    stopScanTimer();
                    event.removeListener('discover', onDiscover);
                    
                    stopNobleScan().then(function() {
                        // this will be sent by scanStop handler above.
                        // node.send([null, true]);
                    }).catch(function(_error) {
                        // scan stopped by error
                        node.send([null, false]);
                    });
                }
            } catch(error) {
                node.error(error);
            }
        });

        node.on('close', function(done) {
            try {
                node.log(TAG + 'Closing.');

                stopScanTimer();
                event.removeListener('discover', onDiscover);
                event.removeListener('scanStatus', onScanStatus);
                
                stopNobleScan().then(done).catch(done);
            } catch(error) {
                node.error(error);
            }
        });

        node.status({fill:'grey', shape:'dot',text:'idle'});

        if (config.autostart) {
            try {
                startScan();
            } catch(error) {
                node(error);
            }
        }
    }

    RED.nodes.registerType('linking-scanner', LinkingScannerNode);

    ////////////////////////////////////////////////////////////////
    // Common functions for connect/disconnect
    ////////////////////////////////////////////////////////////////

    // Parameters:
    //    localName
    //    timeout: Optional. Default is 10 seconds.
    // Returns: Promise<LinkingDevie>
    function getDevice(localName, timeout) {
        timeout = (typeof(timeout) === 'number') || 30;

        return new Promise(function(resolve, reject) {
            var scanTimerId;

            // check cache first
            if (linkingDevices[localName]) {
                resolve(linkingDevices[localName]);
                return;
            }

            function onDiscover(advertisement, device) {
                if (advertisement.localName === localName) {
                    event.removeListener('discover', onDiscover);

                    clearTimeout(scanTimerId);


                    stopNobleScan().then(function() {
                        resolve(device);
                    }).catch(function(error) {
                        logger.wan(TAG + 'failed to stop scannig: ' + error);
                        // do not return error intentionally. you get device anyway.
                        resolve(device);
                    });
                }
            }

            function onScanTimeout() {
                const errormsg = 'timed out to get device: ' + localName;
                logger.log(TAG + errormsg);
                event.removeListener('discover', onDiscover);

                stopNobleScan().then(function() {
                    reject(new Error(errormsg));
                }).catch(function(error) {
                    reject(error);
                });
            }

            event.on('discover', onDiscover);
            logger.log(TAG + 'scanning to discover: ' + localName);

            startNobleScan().then(function() {
                // scan device for <timeout> secnds
                scanTimerId = setTimeout(onScanTimeout, timeout * 1000);
            }).catch(function(error) {
                clearTimeout(scanTimerId);
                event.removeListener('discover', onDiscover);
                logger.warn(TAG + 'failed to start scanning: ' + error);
                reject(error);
            });
        });
    }

    //    localName
    //    timeout: Optional. Default is 10 seconds.
    // Returns Promise<Device>
    function connectDevice(localName, timeout) {
        return new Promise(function(resolve, reject) {
            logger.log(TAG + 'connecting to device: ' + localName);

            connectingRequestNum++;
            
            if (! connectSem.available()) {
                logger.debug(TAG + 'waiting semaphore');
            }

            connectSem.take(function() {
                try {
                    getDevice(localName, timeout).then(function(device) {
                        const onSuccess = function() {
                            connectingRequestNum--;
                            connectSem.leave();
                            resolve(device);
                        };

                        if (device.connected) {
                            logger.debug(TAG + 'device already connected: ' + localName);
                            onSuccess();
                            return;
                        }

                        logger.log(TAG + 'Stopping scan to connect.');

                        stopNobleScan(true).then(function() {
                            return device.connect();
                        }).then(function() {
                            device.ondisconnect = function() {
                                logger.log(TAG + 'device disconnected: ' + localName);
                                device.ondisconnect = null;
                                event.emit('disconnect', localName);
                            };

                            logger.log(TAG + 'device connected: ' + localName);
                            event.emit('connect', localName);

                            deviceServices[localName] = device.services;
                            onSuccess();
                        });
                    });
                } catch(error) {
                    logger.warn(error);

                    connectingRequestNum--;
                    connectSem.leave();
                    reject(error);
                }
            });
        });
    }

    // Returns Promise
    // eslint-disable-next-line no-unused-vars
    function disconnectDevice(localName) {
        return new Promise(function(resolve, reject) {
            logger.log(TAG + 'disconnecting device: ' + localName);

            const device = linkingDevices[localName];
            if (! device) {
                const errormsg = 'can\t disconnect unpaired device: ' + localName;

                logger.warn(TAG + errormsg);
                reject(new Error(errormsg));
            }

            // This check might not be necessary
            if (! device.connected) {
                logger.info(TAG + 'device alread disconnected: ' + localName);
                resolve();
            }

            device.disconnect().then(function() {
                logger.log(TAG + 'disconnected device: ' + localName);
                resolve();
            }).catch(function(error) {
                logger.warn(TAG + 'failed to disconnect device: ' + localName);
                reject(error);
            });
        });
    }

    ////////////////////////////////////////////////////////////////
    // linking-led node
    ////////////////////////////////////////////////////////////////
    function LinkingLedNode(config) {
        RED.nodes.createNode(this, config);
        var node = this;
        var localName = config.device;

        const onDisconnect = function(name) {
            if (localName === name) {
                node.status({fill:'yellow', shape:'dot', text:'disconnected'});
                event.removeListener('dicsonnect', onDisconnect);
            }
        };

        try {
            node.on('input', function(msg) {
                localName = msg.device || config.device;

                if (! localName) {
                    node.error('no device name specified.');
                    return;
                }

                if (linkingDevices[localName] &&
                    deviceServices[localName] && (! deviceServices[localName].led)) {

                    logger.warn('No led service: ' + localName);
                    return;
                }

                node.debug('Turning LED on.');
                node.status({fill:'yellow', shape:'dot', text:'connecting'});

                connectDevice(localName).then(function(device) {
                    if (! device.services || ! device.services.led) {
                        node.error('LED service unsupported: ' + localName);
                        node.status({fill:'red', shape:'circle', text:'No led support'});
                        return;
                    }

                    event.on('disconnect', onDisconnect);
                    node.status({fill:'green', shape:'dot', text:'connected'});

                    if (msg.payload) {
                        // turn on led
                        device.services.led.turnOn(msg.color, msg.pattern, msg.duration).then(function(res) {
                            if (!res.resultCode === 0) {
                                node.warn('led.turnOn() failed. resultCode:'
                                          + res.resultCode + '. ' + res.resultText);
                            }
                        }).catch(function(error) {
                            node.warn('led.turnOn() failed. ' + error);
                            node.status({fill:'red', shape:'circle', text:'turnOn error'});
                        });
                    } else {
                        // turn off led
                        device.services.led.turnOff().then(function() {
                            // do nothing
                        }).catch(function(error) {
                            node.warn('led.turnOff() failed. ' + error);
                            node.status({fill:'red', shape:'circle', text:'turnOff error'});
                        });
                    }
                }).catch(function(error) {
                    node.error('failed to connect ' + localName + ' : ' + error);
                    node.status({fill:'red', shape:'circle', text:'connect error'});
                });
            });

            node.on('close', function(done) {
                event.removeListener('disconnect', onDisconnect);
                node.debug('linking-led: Closing.');
                done();
            });
        } catch(e) {
            node.error('linking-led: ' + e);
        }
    }

    RED.nodes.registerType('linking-led',LinkingLedNode);

    ////////////////////////////////////////////////////////////////
    // endpoints for preference
    ////////////////////////////////////////////////////////////////
    
    // Returns array of localName of devices discovered
    RED.httpAdmin.get('/linking-device/getDevices', function(req, res) {
        const TAG = 'linking-device/getDevices';
        const forceScan = req.query.forceScan;

        try {
            logger.log(TAG);

            const sendResponse = function() {
                if (Object.keys(linkingDevices).length > 0) {
                    // data: array of {text:<localName>, value:<address>}
                    const response = Object.keys(linkingDevices).map(function (localName, _index) {
                        return localName;
                    });
                    
                    logger.log(TAG + ' returns ' + response.length + ' devices.');
                    res.status(200).send(response);
                } else {
                    logger.log(TAG + 'no device found.');
                    res.status(404).send('No device found. Please scan again later.');
                }
            };

            if (scanning || ! forceScan) {
                sendResponse();
            } else {
                getDevice('dummy', 10).then(sendResponse).catch(function(error) {
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
    RED.httpAdmin.get('/linking-device/getServices/:localName', function(req, res) {
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
                connectDevice(localName).then(function(device) {
                    logger.debug('Service of ' + localName + ':' + JSON.stringify(device.services));
                    res.status(200).send(device.services);
                }).catch(function(error) {
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
    RED.httpAdmin.get('/linking-device/turnOnLed/:localName', function(req, res) {
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
            
            connectDevice(localName).then(function(device) {
                if (device.services && device.services.led) {
                    logger.debug('calling led.turnOn()');
                    device.services.led.turnOn(color, pattern).then(function(result) {
                        if (result.resultCode === 0) {
                            res.status(200).send();
                        } else {
                            const message = 'Failed to turn on LED. resultCode: '
                                  + result.resultCode + ': ' + result.resultText;
                            logger.warn(message);
                            res.status(500).send(message);
                        }
                    }).catch(function(error) {
                        logger.warn('led.turnOn() failed. ' + error);
                        res.status(500).send(error.message);
                    });
                } else {
                    logger.warn('linking-device/turnOnLed/ failed: no led service: ' + localName);
                    res.status(404).send('The device as no led servie.');
                    return;
                }
            }).catch(function(error) {
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

