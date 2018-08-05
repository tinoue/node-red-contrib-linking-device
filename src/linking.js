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
    var stopScanListener;
    var nodeNum = 0;	// # of scanner nodes

    var linkingDevices = {};	// devices discovered.

    function startScan(node, config, msg) {
        // Start scanning beacon

        node.log('linking-device: Start scanning.');
        if (msg == null) {
            msg = {};
        }

        node.status({fill:'yellow', shape:'dot',text:'starting scan'});

        initLinking().then(function() {
            linking.onadvertisement = function(advertisement, device) {
                node.debug(TAG + 'Got advertisement.');
                if (device) {
                    if (! linkingDevices[advertisement.localName]) {
                        linkingDevices[advertisement.localName] = device;
                        node.status({fill:'green', shape:'dot',text:'scanning. found ' + Object.keys(linkingDevices).length});
                    }
                } else {
                    node.warn(TAG + 'Advertisement has no device object');
                }

                // original advertisement data
                msg.advertisement = advertisement;

                // set simplified payload
                msg.localName = advertisement.localName;
                msg.address = advertisement.address;
                msg.distance = advertisement.distance;

                if (advertisement.beaconDataList && (advertisement.beaconDataList.length)) {
                    for (let data of advertisement.beaconDataList) {
                        msg.payload = data;
                        node.send([msg, null]);
                    }
                } else {
                    msg.payload = {};
                    node.send([msg, null]);
                }
            };

            // If interrupted by device discovery, wait until the discovery finished then restart.
            stopScanListener = function() {
                node.log(TAG + 'scanner interrupted.');
                node.status({fill:'yellow', shape:'dot',text:'interrupted'});
                node.send([null, { payload: false}]);
            };
            linking.noble.once('scanStop', stopScanListener);

            linking.noble.once('scanStart', function() {
                scanning = true;
                node.status({fill:'green', shape:'dot',text:'scanning. found ' + Object.keys(linkingDevices).length});
            });

            linking.startScan();
            const duration = (msg && (msg.duration === 0 || msg.duration)) ? msg.duration : config.duration;
            if (0 < duration) {
                setTimeout(function() {
                    linking.stopScan();
                    node.status({fill:'grey', shape:'dot',text:'idle'});
                }, duration * 1000);
            }
            node.status({
                fill:'green',
                shape:'dot',
                text:'scanning ' + (0 < duration) ? duration + 'secs' : 'forever'
            });
        }).catch(function(error) {
            node.error(TAG + error);
            node.status({fill:'red', shape:'ring',text:'error'});
        });
    }

    function stopScan(node, _config) {
        // Stop scanning beacon
        node.log(TAG + 'Stop scanning.');

        linking.onadvertisement = null;

        if (stopScanListener) {
            linking.noble.removeListener('scanStop', stopScanListener);
            stopScanListener = null;
        }

        initLinking().then(function() {
            linking.stopScan();
            node.status({fill:'grey', shape:'dot',text:'idle'});
            node.send([null, {payload: true}]);
        }).catch(function(error) {
            node.error(TAG + error);
            node.status({fill:'red', shape:'ring',text:'error'});
            node.send([null, {payload: false}]);
        });

        scanning = false;
    }

    function LinkingScannerNode(config) {
        RED.nodes.createNode(this, config);
        var node = this;

        try {
            if (nodeNum > 0) {
                node.error(TAG + 'can\'t deploy multiple scanner nodes');
                node.status({fill:'red', shape:'ring',text:'can\'t deploy multiple scanner nodes'});
                return;
            }

            nodeNum++;

            node.on('input', function(msg) {
                if (msg.payload) {
                    startScan(node, config, msg);
                } else {
                    stopScan(node, config);
                }
            });

            node.on('close', function(done) {
                node.log('linking-scanner: Closing.');

                nodeNum--;
                if (! scanning) {
                    stopScan(node, config);
                }
                done();
            });

            if (config.autostart) {
                startScan(node, config, null);
            }
        } catch(e) {
            node.error('linking-scanner: ' + e);
        }
    }

    RED.nodes.registerType('linking-scanner',LinkingScannerNode);

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

        res.status(200).send(Object.keys(linkingDevices)); // returns ['name1', 'name2']
    });

    RED.httpAdmin.get('/linking-device/getServices/:localName', function(req, res) {
        const localName = req.params.localName;
        console.log('linking-device/getServices/' + localName);

        if (localName && linkingDevices[localName]) {
            const device = linkingDevices[localName];

            linking.noble.once('scanStop', function() {
                console.log('connecting');
                console.log(device._peripheral);
                device._peripheral.once('connect', function(error) {
                    console.log('connet: ' + error);
                });
            device.connect().then(function() {
                console.debug('Service of ' + localName + ':' + JSON.stringify(device.services));
                res.status(200).send(Object.keys(device.services));
            }).catch(function(error) {
                console.error('linking-device/getServices/ failed: ' + error);
                res.status(500).send();
            });
            });

            linking.stopScan();
        } else {
            console.warn('linking-device/getServices/ failed: no such device');
            res.status(404).send();
        }
    });
};
