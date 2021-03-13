const debug = require('debug')('ring-mqtt')
const colors = require('colors/safe')
const mqttApi = require('mqtt')
const utils = require('./utils.js')

class Mqtt {
    constructor() {
        this.client = false
        this.isConnected = true
    }

    async init(CONFIG) {
        this.CONFIG = CONFIG
        // Initiate connection to MQTT broker
        try {
            debug('Starting connection to MQTT broker...')
            this.client = await this.connect()
            if (this.client.connected) {
                this.isConnected = true
                debug('MQTT connection established, sending config/state information in 5 seconds.')
            }
            // Monitor configured/default Home Assistant status topic
            this.client.subscribe(this.CONFIG.hass_topic)
            // Monitor legacy Home Assistant status topic
            this.client.subscribe('hass/status')
            this.start()
        } catch (error) {
            debug(error)
            debug( colors.red('Couldn\'t authenticate to MQTT broker. Please check the broker and configuration settings.'))
            process.exit(1)
        }
    }

    // Initiate the connection to MQTT broker
    connect() {
        const mqtt = mqttApi.connect({
            host: this.CONFIG.host,
            port: this.CONFIG.port,
            username: this.CONFIG.mqtt_user,
            password: this.CONFIG.mqtt_pass
        });
        return mqtt
    }

    // MQTT initialization successful, setup actions for MQTT events
    start() {
        // On MQTT connect/reconnect send config/state information after delay
        this.client.on('connect', async function () {
            if (!this.isConnected) {
                this.isConnected = true
                debug('MQTT connection established, processing locations...')
            }
            ring.processLocations(this.client, this.CONFIG)
        })

        this.client.on('reconnect', function () {
            if (this.isConnected) {
                debug('Connection to MQTT broker lost. Attempting to reconnect...')
            } else {
                debug('Attempting to reconnect to MQTT broker...')
            }
            this.isConnected = false
        })

        this.client.on('error', function (error) {
            debug('Unable to connect to MQTT broker.', error.message)
            this.isConnected = false
        })

        // Process MQTT messages from subscribed command topics
        this.client.on('message', async function (topic, message) {
            processMqttMessage(topic, message)
        })
    }
    
    // Process received MQTT command
    async processMqttMessage(topic, message) {
        message = message.toString()
        if (topic === CONFIG.hass_topic || topic === 'hass/status') {
            debug('Home Assistant state topic '+topic+' received message: '+message)
            if (message == 'online') {
                // Republish devices and state after 60 seconds if restart of HA is detected
                debug('Resending device config/state in 30 seconds')
                // Make sure any existing republish dies
                republishCount = 0 
                await utils.sleep(35)
                // Reset republish counter and start publishing config/state
                republishCount = 6
                ring.processLocations(this.client, this.CONFIG)
            }
        } else {
            // Parse topic to get location/device ID
            const ringTopicLevels = (CONFIG.ring_topic).split('/').length
            splitTopic = topic.split('/')
            const locationId = splitTopic[ringTopicLevels]
            const deviceId = splitTopic[ringTopicLevels + 2]

            // Find existing device by matching location & device ID
            const cmdDevice = ring.devices.find(d => (d.deviceId == deviceId && d.locationId == locationId))

            if (cmdDevice) {
                cmdDevice.processCommand(message, topic)
            } else {
                debug('Received MQTT message for device Id '+deviceId+' at location Id '+locationId+' but could not find matching device')
            }
        }
    }
}

module.exports = new Mqtt()