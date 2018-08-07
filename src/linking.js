const EventEmitter = require('events').EventEmitter;

const event = new EventEmitter();	// manage internal events - discover, restart

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
    var scanning = false;
    var restartRequired = false;

    var linkingDevices = {};	// key: address, value: device object
    var deviceServices = {};	// key: address, value: services

    var nodeNum = 0;	// # of scanner nodes

    function LinkingScannerNode(config) {
        RED.nodes.createNode(this, config);
        var node = this;

        function onDiscover(peripheral) {
            node.debug(TAG + 'Got advertisement.');

            const ad = peripheral.advertisement;
            if (!ad.localName) {
                node.warn(TAG + 'Invalid advertisement. No localName.');
                return;
            }

            const advertisement = linking.LinkingAdvertising.parse(peripheral);
            if (advertisement) {
                const device = new linking.LinkingDevice(linking.noble, peripheral);
                if (device) {
                    if (! linkingDevices[advertisement.address]) {
                        linkingDevices[advertisement.address] = device;
                        const deviceNum =  + Object.keys(linkingDevices).length;
                        node.status({fill:'green',shape:'dot',text:'scanning. found ' + deviceNum});
                    }
                } else {
                    node.warn(TAG + 'Advertisement has no device object');
                    return;
                }
            } else {
                node.warn(TAG + 'Invalid advertisement object');
                return;
            }


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
        } // onDiscover()

        function onScanStop() {
            scanning = false;

            if (restartRequired) {
                node.log(TAG + 'scanner stopped and waiting for restart.');
                node.status({fill:'grey', shape:'dot',text:'suspending'});
                // do not send message in this case.
            } else if (scanning) {
                node.log(TAG + 'scanner interrupted unexpectedly.');
                node.status({fill:'yellow', shape:'dot',text:'interrupted'});
                node.send([null, { payload: false}]);
            } else {
                node.log(TAG + 'scanner stopped.');
                node.status({fill:'grey', shape:'dot',text:'idle'});
                node.send([null, { payload: true}]);
            }

            linking.noble.removeListener('scanStop', onScanStop);
        }

        function stopScan() {
            // Stop scanning beacon. Caller should set 'restartRequired' appropreately.
            // NOTE: This function also calls noble.stopScanning() directly instead of linking.stopScan()
            node.log(TAG + (restartRequired ? 'Suspend' : 'Stop') + ' scanning.');
            scanning = false;
            
            linking.noble.removeListener('discover', onDiscover);

            initLinking().then(function() {
                linking.noble.stopScanning();
            }).catch(function(error) {
                node.error(TAG + error);
                node.status({fill:'red', shape:'ring',text:'error'});
                node.send([null, {payload: false}]);
            });

        }

        function startScan(msg) {
            // This function calls noble.startScanning() directly instead of linking.startScan()
            // and heavyly relied on internal implementation of node-linking.

            // Start scanning beacon
            node.log(TAG + 'Start scanning.');

            if (scanning) {
                node.log(TAG + 'scanner already started.');
                return;
            }

            if (msg == null) {
                msg = {};
            }

            node.status({fill:'yellow', shape:'dot',text:'starting scan'});

            initLinking().then(function() {
                linking.noble.on('discover', onDiscover);

                // If interrupted by device discovery, wait until the discovery finished then restart.
                linking.noble.once('scanStop', onScanStop);

                linking.noble.once('scanStart', function() {
                    scanning = true;
                    restartRequired = false;

                    node.status({fill:'green', shape:'dot',text:'scanning. found ' + Object.keys(linkingDevices).length});
                });

                restartRequired = false; // in case of unexpected failure
                linking.noble.startScanning(linking.PRIMARY_SERVICE_UUID_LIST, true);

                const duration = (msg && (msg.duration === 0 || msg.duration)) ? msg.duration : config.duration;
                if (0 < duration) {
                    setTimeout(function() {
                        restartRequired = false;
                        stopScan();
                    }, duration * 1000);
                }

                node.status({fill:'green', shape:'dot',text:'scanning. found ' + Object.keys(linkingDevices).length});
            }).catch(function(error) {
                node.error(TAG + error);
                node.status({fill:'red', shape:'ring',text:'error'});
            });
        }

        if (nodeNum > 0) {
            node.error(TAG + 'can\'t deploy multiple scanner nodes');
            node.status({fill:'red', shape:'ring',text:'can\'t deploy multiple scanner nodes'});
            return;
        }

        nodeNum++;

        node.on('input', function(msg) {
            if (msg.payload) {
                startScan(msg);
            } else {
                stopScan();
            }
        });

        node.on('close', function(done) {
            node.log(TAG + 'Closing.');

            nodeNum--;
            if (! scanning) {
                stopScan(node, config);
            }
            done();
        });

        // Restart request from /linking-device/restartScan
        event.on('restart', function() {
            if (restartRequired) {
                node.log(TAG + 'restarting scan.');
                startScan(null);
            }

            restartRequired = false;
        });

        if (config.autostart) {
            startScan(null);
        }
    }

    RED.nodes.registerType('linking-scanner', LinkingScannerNode);

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

