const EventEmitter = require('events').EventEmitter;

const Linking = require('node-linking');
const linking = new Linking();

const TAG = 'linking-device: ';

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
                reject(error);
            });
        }
    });
}

module.exports = function(RED) {
    const event = new EventEmitter();   // manage internal events - discover, scanStatus,

    var scanning = false;

    var scanRequestNum = 0;
    var connectRequestNum = 0;

    var linkingDevices = {};    // key: localName, value: device object
    var deviceServices = {};    // key: localName, value: services

    ////////////////////////////////////////////////////////////////
    // Common function for scanning (discovery)
    ////////////////////////////////////////////////////////////////

    initLinking().then(function() {
        linking.noble.on('scanStart', onNobleScanStart);
        linking.noble.on('scanStop', onNobleScanStop);
        linking.noble.on('discover', onNobleDiscover);
    }).catch(function(error) {
        console.error(TAG + 'initLinking failed: ' + error);
    });

    function onNobleDiscover(peripheral) {
        const logger = console;

        const ad = peripheral.advertisement;
        if (!ad.localName) {
            logger.warn(TAG + 'Invalid advertisement. No localName.');
            return;
        }

        logger.debug(TAG + 'Got advertisement: ' + ad.localName);

        const advertisement = linking.LinkingAdvertising.parse(peripheral);
        if (advertisement) {
            const device = new linking.LinkingDevice(linking.noble, peripheral);
            if (device) {
                if (! linkingDevices[advertisement.localName]) {
                    logger.log(TAG + 'found device: ' + localName);
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
        const logger = console;

        scanning = false;

        if (0 < connectRequestNum) {
            logger.log(TAG + 'scanner suspendingfor connect operation.');
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
        const logger = console;

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
/*
                        const duration = (msg && (msg.duration === 0 || msg.duration)) ? msg.duration : config.duration;
                        if (0 < duration) {
                            setTimeout(function() {
                                stopNobleScan();
                            }, duration * 1000);
                        }
*/
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
        const logger = console;
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

            scanning = false;
            event.emit('scanStatus', {fill:'yellow', shape:'dot',text:'stopping scan'});
            
            initLinking().then(function() {
                linking.noble.stopScanning(function(error) {
                    if (error) {
                        logger.error(TAG + error);
                        event.emit('scanStatus', {fill:'red', shape:'ring',text:'error on stop'});
                        reject();
                    } else {
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

    ////////////////////////////////////////////////////////////////
    // linking-scanner node
    ////////////////////////////////////////////////////////////////
    function LinkingScannerNode(config) {
        RED.nodes.createNode(this, config);
        var node = this;

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
            startNobleScan().then(function() {
                event.on('discover', onDiscover);
                event.once('scanStop', function(normal) {
                    node.send([null, normal]);
                });
            }).catch(function(_error) {
                // failed to start scan
                node.send([null, false]);
            });
        }

        event.on('scanStatus', onScanStatus);

        node.on('input', function(msg) {
            if (msg.payload) {
                startScan();
            } else {
                event.removeListener('discover', onDiscover);

                stopNobleScan().then(function() {
                    // this will be sent by scanStop handler above.
                    // node.send([null, true]);
                }).catch(function(_error) {
                    // scan stopped by error
                    node.send([null, false]);
                });
            }
        });

        node.on('close', function(done) {
            node.log(TAG + 'Closing.');

            event.removeListener('discover', onDiscover);
            event.removeListener('scanStatus', onScanStatus);

            stopNobleScan(node, config).then(done).catch(done);
        });

        node.status({fill:'grey', shape:'dot',text:'idle'});

        if (config.autostart) {
            startScan();
        }
    }

    RED.nodes.registerType('linking-scanner', LinkingScannerNode);

    ////////////////////////////////////////////////////////////////
    // Common functions for connect/disconnect
    ////////////////////////////////////////////////////////////////

    // Returns: Promise<LinkingDevie>
    function getDevice(localName) {
        const logger = console;

        return new Promise(function(resolve, reject) {
            // check cache first
            if (linkingDevices[localName]) {
                resolve(linkingDevices[localName]);
            }

            function onDiscover(advertisement, device) {
                if (advertisement.localName === localName) {
                    event.removeListener('discover', onDiscover);

                    stopNobleScan().then(function() {
                        resolve(device);
                    }).catch(function() {
                        resolve(device);
                    });
                }
            }

            event.on('discover', onDiscover);

            logger.log(TAG + 'canning to discover: ' + localName);

            startNobleScan().then(function() {
                // scan device for 10 secnds

                setTimeout(function() {
                    logger.log(TAG + 'timed out to get device: ' + localName);
                    event.removeListener('discover', onDiscover);
                    stopNobleScan().then(reject).catch(reject);
                }, 10 * 1000);
            }).catch(function(error) {
                event.removeListener('discover', onDiscover);
                reject(error);
            });;
        });
    }

    // Returns Promise
    function connectDevice(localName) {
        const logger = console;

        return new Promise(function(resolve, reject) {
            getDevice(localName).then(function(device) {
                if (device.connected) {
                    logger.warn(TAG + 'device already connected: ' + localName);
                    resolve();
                }

                logger.log(TAG + 'Stopping scan to connect.');

                stopNobleScan(true).then(function() {
                    // TODO: Semaphore
                    connectRequestNum++;

                    device.connect().then(function() {
                        resolve();
                    }).catch(function(error) {
                        connectRequestNum--;
                        reject(error);
                    });
                    
                }).catch(function(error) {
                    reject(error);
                });
            }).catch(function(error) {
                rejet(error);
            });
        });
    }

    // Returns Promise
    function disconnectDevice(localName) {
        const logger = console;

        return new Promise(function(resolve, reject) {
            const device = linkingDevices[localName];
            if (! device) {
                logger.warn(TAG + 'can\t disconnect unpaired device: ' + localName);
                reject(new Error('can\t disconnect unpaired device'));
            }

            connectRequestNum--;
            if (connectRequestNum < 0) {
                logger.error(TAG + 'unexpected connectRequestNum');
                connectRequestNum = 0;
            }

            if (! device.connected) {
                // This can be possible because of signal lost, etc...
                logger.info(TAG + 'device alread disconnected: ' + localName);
                resolve();
            }

            device.disconnect().then(function() {
                resolve();
            }).catch(function(error) {
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

        try {
            node.on('input', function(msg) {
                if (msg.payload) {
                    // turn on led
                } else {
                    // turn off led
                }
            });

            node.on('close', function(done) {
                node.log('linking-led: Closing.');
                done();
            });
        } catch(e) {
            node.error('linking-led: ' + e);
        }
    }

    RED.nodes.registerType('linking-led',LinkingLedNode);

    // endpoints for preference
    
    // Returns array of localName of devices discovered
    RED.httpAdmin.get('/linking-device/getDevices', function(req, res) {
        console.log('linking-device/getDevice/');

        if (Object.keys(linkingDevices).length > 0) {
            // data: array of {text:<localName>, value:<address>}
            const response = Object.keys(linkingDevices).map(function (addr, _index) {
                return {
                    name: linkingDevices[addr].advertisement.localName,
                    address: addr
                };
            });
            res.status(200).send(response);
        } else {
            res.status(404).send();
        }
    });

    RED.httpAdmin.get('/linking-device/getServices/:address', function(req, res) {
        const address = req.params.address;

        if (address && linkingDevices[address]) {
            const device = linkingDevices[address];
            const services = deviceServices[address];
            const localName = device.advertisement && device.advertisement.localName;
            console.log('linking-device/getServices/' + localName);

            function connectDevice() {
                console.log(TAG + 'connecting to ' + localName);

                // relied on node-linking internal implementation
                device._peripheral.once('connect', function(error) {
                    if (error) {
                        console.log(TAG + 'connet error: ' + error);
                    }
                });

                device.connect().then(function() {
                    deviceServices[address] = device.services;

                    console.debug('Service of ' + address + ':' + JSON.stringify(device.services));
                    res.status(200).send(Object.keys(device.services));
                    device.disconnect();
                }).catch(function(error) {
                    console.error('linking-device/getServices/ failed: ' + error);
                    res.status(500).send();
                });
            }

            if (services) {
                // cache exists
                res.status(200).send(Object.keys(device.services));
            } else if (scanning) {
                // Stop scanning then connect to get services
                linking.noble.once('scanStop', connectDevice) ;
                restartRequired = true;
                linking.noble.stopScanning();
            } else {
                connectDevie();
            }
        } else {
            console.warn('linking-device/getServices/ failed: no such address: ' + address);
            res.status(404).send();
        }
    });
};

