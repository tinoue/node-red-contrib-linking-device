const Linking = require('node-linking');
const linking = new Linking();

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
    var restartScan = false;
    var stopScanListener;
    var nodeNum = 0;

    function startScan(node, config, msg) {
        // Start scanning beacon

        node.log('linking-device: Start sanning.');
        if (msg == null) {
            msg = {};
        }

        node.status({fill:'yellow', shape:'dot',text:'starting scan'});

        initLinking().then(function() {
            linking.onadvertisement = function(advertisement) {
                node.debug('linking-device: Got advertisement.');

                // original advertisement data
                msg.advertisement = advertisement;

                // set simplified payload
                msg.payload = {
                    localName: advertisement.localName,
                    address: advertisement.address,
                    distance: advertisement.distance
                }

                if (advertisement.beaconDataList && (advertisement.beaconDataList.length)) {
                    for (let data of advertisement.beaconDataList) {
                        msg.payload.beaconData = data;
                        node.send(msg);
                    }
                } else {
                    node.send(msg);
                }
            };

            // If interrupted by device discovery, wait until the discovery finished then restart.
            stopScanListener = function() {
                if (restartScan) {
                    node.log('linking-device: restart scanner.');
                    startScan(node, config, msg);
                    restartScan = false;
                } else {
                    node.log('linking-device: scanner interrupted.');
                    restartScan = true;
                }
            }
            linking.noble.once('scanStop', stopScanListener);

            linking.noble.once('scanStart', function() {
                node.status({fill:'green', shape:'dot',text:'scanning'});
            });

            linking.startScan();
            if (0 < config.duration) {
                setTimeout(function() {
                    linking.stopScan();
                    node.status({fill:'grey', shape:'dot',text:'idle'});
                }, config.duration * 1000);
            }
            node.status({fill:'green', shape:'dot',text:'scanning'});
        }).catch(function(error) {
            node.error('linking-device: ' + error);
            node.status({fill:'red', shape:'ring',text:'error'});
        });
    }

    function stopScan(node, _config) {
        // Stop scanning beacon
        node.log('linking-device: Stop scanning.');

        linking.onadvertisement = null;
        if (stopScanListener) {
            linking.noble.removeListener('scanStop', stopScanListener);
            stopScanListener = null;
        }

        initLinking().then(function() {
            linking.stopScan();
            node.status({fill:'grey', shape:'dot',text:'idle'});
        }).catch(function(error) {
            node.error('linking-device: ' + error);
            node.status({fill:'red', shape:'ring',text:'error'});
        });
    }

    function LinkingScannerNode(config) {
        RED.nodes.createNode(this, config);
        var node = this;

        try {
            if (nodeNum > 0) {
                node.error('linking-device: can\'t deploy multiple scanner nodes');
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
                stopScan(node, config);
                done();
            });

            if (config.autostart) {
                startScan(node, config, null);
            }
        } catch(e) {
            node.error('linking-device: ' + e);
        }
    }

    RED.nodes.registerType('linking-scanner',LinkingScannerNode);
};
