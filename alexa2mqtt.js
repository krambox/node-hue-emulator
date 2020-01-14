#!/usr/bin/env node
var pkg = require('./package.json');
var fs = require('fs');
const Hapi = require('hapi');
const Boom = require('boom');

var ssdp = require('peer-ssdp');
var Mqtt = require('mqtt');
var log = require('yalm');
var config = require('./config.js');
var yaml = require('yaml');

var address = config.bind;
var host = config.publish;
var port = config.port;

var mqttConnected;
var seen = false;

log.setLevel(config.verbose);

log.info(pkg.name + ' ' + pkg.version + ' starting');
log.info(config);

function buildExtendedColorLight (name) {
  return {
    'state': {
      'on': false,
      'bri': 0,
      'hue': 0,
      'sat': 0,
      'xy': [
        0,
        0
      ],
      'ct': 0,
      'alert': 'none',
      'effect': 'none',
      'colormode': 'hs',
      'reachable': true
    },
    'type': 'Extended color light',
    'name': name,
    'modelid': 'LCT001',
    'swversion': '66009461'
  };
}

log.info('Config file: ' + config.config);

var alexaConfigFile;
fs.watch(config.config, function (event, filename) {
  if (filename) {
    log.info('Reload config');
    setTimeout(buildConfig, 1500, 'funky');
  }
});

var alexaConfig = {};
var alexaMQTTConfig = {};
buildConfig();

function buildConfig () {
  log.info(config.config);
  alexaConfigFile = yaml.parse(fs.readFileSync(config.config, 'utf8')).alexa;
  log.debug(alexaConfigFile);
  alexaConfig = {};
  alexaMQTTConfig = {};
  for (let index = 0; index < alexaConfigFile.length; index++) {
    const element = alexaConfigFile[index];
    log.info('Element', element.id, element.name, JSON.stringify(element.switch), JSON.stringify(element.control));
    alexaMQTTConfig[element.id] = {
      name: element.name,
      switch: element.switch,
      control: element.control,
      color: element.color
    };
    alexaConfig[element.id] = buildExtendedColorLight(element.name);
  }
}

log.info('mqtt trying to connect', config.url);

var mqtt = Mqtt.connect(config.url, { will: { topic: config.name + '/connected', payload: '0', retain: true } });

mqtt.on('connect', function () {
  mqttConnected = true;

  log.info('mqtt connected', config.url);
  mqtt.publish(config.name + '/connected', '1', { retain: true });

  log.info('mqtt subscribe', config.name + '/set/#');
  mqtt.subscribe(config.name + '/set/#');
});

mqtt.on('close', function () {
  if (mqttConnected) {
    mqttConnected = false;
    log.info('mqtt closed ' + config.url);
  }
});

mqtt.on('error', function (err) {
  log.error('mqtt', err);
});

var peer = ssdp.createPeer();

//  handle peer ready event. This event will be emitted after `peer.start()` is called.
peer.on('ready', function () {
  log.info('UPNP server listening on port 1900.');
});

// handle SSDP NOTIFY messages.
// param headers is JSON object containing the headers of the SSDP NOTIFY message as key-value-pair.
// param address is the socket address of the sender
peer.on('notify', function (headers, address) {
  log.debug('NOTIFY:', headers);
});

// handle SSDP M-SEARCH messages.
// param headers is JSON object containing the headers of the SSDP M-SEARCH message as key-value-pair.
// param address is the socket address of the sender
peer.on('search', function (headers, address) {
  // handle search request
  // reply to search request
  // {{networkInterfaceAddress}} will be replaced with the actual IP Address of the corresponding
  // sending the SSDP message with the actual IP Address of the corresponding
  // Network interface.
  log.debug('SEARCH:', headers, address);
  if (headers.ST && headers.MAN === '"ssdp:discover"') {
    peer.reply({
      NT: 'urn:schemas-upnp-org:device:basic:1',
      SERVER: 'node.js/0.10.28 UPnP/1.1',
      ST: 'urn:schemas-upnp-org:device:basic:1',
      USN: 'uuid:Socket-1_0-221438K0100073::urn:Belkin:device:**',
      LOCATION: 'http://{{networkInterfaceAddress}}:8082/upnp/amazon-ha-bridge/setup.xml'
    }, address);
  }
});

// handle SSDP HTTP 200 OK messages.
// param headers is JSON object containing the headers of the SSDP HTTP 200 OK  message as key-value-pair.
// param address is the socket address of the sender
peer.on('found', function (headers, address) {
  // handle found event
  log.info('FOUND:', headers);
});

// handle peer close event. This event will be emitted after `peer.close()` is called.
peer.on('close', function () {
  // handle close event
  log.info('CLOSING.');
});

// Start peer. Afer peer is ready the `ready` event will be emitted.
peer.start();

var setupFile = fs.readFileSync('setup.xml').toString();
setupFile.replace('##URLBASE##', host + ':' + port);

// Create a server with a host and port
const server = new Hapi.Server({
  port: port,
  address: address
});

// Add the route
server.route({
  method: 'GET',
  path: '/api/{name}/lights',
  handler: function (request, h) {
    log.info('LIGHTS', request.url.pathname);
    if (!seen) {
      seen = true;
      mqtt.publish(config.name + '/connected', '2', { retain: true });
    }
    const response = h.response(alexaConfig);
    response.type('application/json');
    return response;
  }
});

// Add the route
server.route({
  method: 'GET',
  path: '/api/{name}/lights/{id}',
  handler: function (request, h) {
    log.info('LIGHTS', request.url.pathname);
    if (!seen) {
      seen = true;
      mqtt.publish(config.name + '/connected', '2', { retain: true });
    }
    var lightState = alexaConfig[request.params.id];
    if (lightState) {
      const response = h.response(lightState);
      response.type('application/json');
      return response;
    } else {
      throw Boom.badRequest();
    }
  }
});

// Add the route
server.route({
  method: 'PUT',
  path: '/api/{name}/lights/{id}/state',
  handler: function (request, h) {
    var command = JSON.parse(request.payload.toString());
    log.info('COMMAND', request.url.pathname);
    log.info('command', JSON.stringify(command));
    if (!seen) {
      seen = true;
      mqtt.publish(config.name + '/connected', '2', { retain: true });
    }
    var mqttConfifg = alexaMQTTConfig[request.params.id];
    log.debug(mqttConfifg);
    if (mqttConfifg) {
      var topic = mqttConfifg.switch.topic;
      var value = mqttConfifg.switch.off;
      if (command.xy) {
        value = JSON.stringify(
          {
            x: command.xy[0],
            y: command.xy[1]
          });
        topic = mqttConfifg.color.topic;
      } else if (command.bri) {
        value = '' + command.bri / 2.55;
        topic = mqttConfifg.control.topic;
      } else if (command.on) {
        value = mqttConfifg.switch.on;
      }

      mqtt.publish(topic, value, function () {
        log.debug('meta', topic, value);
      });
    }
    var response = [{
      success: {
        ['/lights/' + request.params.id + '/state/on']: true
      }
    }];
    log.debug(response);
    const r = h.response(response);
    r.type('application/json');
    return r;
  },
  config: {
    payload: {
      output: 'data',
      parse: false
    }
  }

});

// Add the route
server.route({
  method: 'GET',
  path: '/upnp/amazon-ha-bridge/setup.xml',
  handler: function (request, h) {
    log.info('SETUP', request.url.pathname);
    if (!seen) {
      seen = true;
      mqtt.publish(config.name + '/connected', '2', { retain: true });
    }
    const r = h.response(setupFile);
    r.type('application/xml');
    return r;
  }
});

// Add the route
server.route({
  method: '*',
  path: '/{path*}',
  handler: function (request, h) {
    log.error('MISC', request.url.pathname);
    throw Boom.badRequest();
  }
});

// Start the server
server.start((err) => {
  if (err) {
    throw err;
  }
  log.info('Server running at:', server.info.uri);
});
