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
    function startScan(node, config, msg) {
        node.log('linking-device: Start sanning.');
        if (msg == null) {
            msg = {};
        }

        // Start scanning beacon
        initLinking().then(function() {
            linking.onadvertisement = function(advertisement) {
                node.debug('linking-device: Got advertisement.');
                msg.payload = advertisement;
                node.send(msg);
            };

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
        node.log('linking-device: Stop scanning.');

        // Stop scanning beacon
        linking.onadvertisement = null;

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
            node.on('input', function(msg) {
                if (msg.payload) {
                    startScan(node, config, msg);
                } else {
                    stopScan(node, config);
                }
            });

            node.on('close', function(done) {
                node.log('linking-scanner: Closing.');

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
