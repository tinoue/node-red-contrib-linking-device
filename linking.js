const Linking = require('node-linking');
const linking = new Linking();

const DEBUG = true;
functon debugLog(message) {
    console.error(message);
}

function initLinking() {
    var initialized = false;

    debugLog('initLinking');

    return new Promise((resolve, reject) => {
        if (initialized) {
            debugLog('initLinking already ok');
            resolve();
        } else {
            linking.init().then(function() {
                debugLog('initLinking ok');
                initialized = true;
                resolve();
            }).catch(function(error) {
                debugLog('initLinking error');
                reject(error);
            });
        }
    });
}

module.exports = function(RED) {


    function LinkingScannerNode(config) {
        RED.nodes.createNode(this, config);
        var node = this;

    try {

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
    } catch(e) {
	node.error(e);
    }
    }

    RED.nodes.registerType('linking-scanner',LinkingScannerNode);
};
