const Linking = require('node-linking');
const linking = new Linking();

function initLinking() {
    var initialized = false;

    return new Promise(function(resolve, reject) {
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
    function LinkingScannerNode(config) {
        RED.nodes.createNode(this, config);
        var node = this;

        node.on('input', function(msg) {
            if (msg.payload) {
                // Start scanning beacon
                initLinking.then(function() {
                    linking.onadvertisement = function(advertisement) {
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
                    node.error(error);
                    node.status({fill:'red', shape:'ring',text:'error'});
                });
            } else {
                // Stop scanning beacon
                linking.onadvertisement = null;

                initLinking.then(function() {
                    linking.stopScan();
                    node.status({fill:'grey', shape:'dot',text:'idle'});
                }).catch(function(error) {
                    node.error(error);
                    node.status({fill:'red', shape:'ring',text:'error'});
                });
            }
        });

        node.on('close', function(_msg) {
            // TODO
            initLinking.then(function() {
                linking.stopScan();
            }).catch(function(error) {
                node.error(error);
            });
        });
    }

    RED.nodes.registerType('linking-scanner',LinkingScannerNode);
};
