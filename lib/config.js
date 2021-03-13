const debug = require('debug')('ring-mqtt')
const utils = require('./utils.js')
const fs = require('fs')

class Config {
    constructor() {
        this.client = false
        this.isConnected = true
        this.options
    }

    // Create this.options object from file or envrionment variables
    async init(configFile) {

        debug('Using configuration file: '+configFile)
        try {
            this.options = require(configFile)
        } catch (error) {
            debug('Configuration file not found, attempting to use environment variables for configuration.')
            this.options = {
                "host": process.env.MQTTHOST,
                "port": process.env.MQTTPORT,
                "ring_topic": process.env.MQTTRINGTOPIC,
                "hass_topic": process.env.MQTTHASSTOPIC,
                "mqtt_user": process.env.MQTTUSER,
                "mqtt_pass": process.env.MQTTPASSWORD,
                "ring_token": process.env.RINGTOKEN,
                "enable_cameras": process.env.ENABLECAMERAS,
                "snapshot_mode": process.env.SNAPSHOTMODE,
                "enable_modes" : process.env.ENABLEMODES,
                "enable_panic" : process.env.ENABLEPANIC,
                "enable_volume" : process.env.ENABLEVOLUME,
                "location_ids" : process.env.RINGLOCATIONIDS
            }
            if (this.options.enable_cameras && this.options.enable_cameras != 'true') { this.options.enable_cameras = false}
            if (this.options.location_ids) { this.options.location_ids = this.options.location_ids.split(',') }
        }
        // If Home Assistant addon, try config or environment for MQTT settings
        if (process.env.HASSADDON) {
            this.options.host = process.env.MQTTHOST
            this.options.port = process.env.MQTTPORT
            this.options.mqtt_user = process.env.MQTTUSER
            this.options.mqtt_pass = process.env.MQTTPASSWORD
        }

        // If there's still no configured settings, force some defaults.
        this.options.host = this.options.host ? this.options.host : 'localhost'
        this.options.port = this.options.port ? this.options.port : '1883'
        this.options.ring_topic = this.options.ring_topic ? this.options.ring_topic : 'ring'
        this.options.hass_topic = this.options.hass_topic ? this.options.hass_topic : 'homeassistant/status'
        if (!this.options.enable_cameras) { this.options.enable_cameras = false }
        if (!this.options.snapshot_mode) { this.options.snapshot_mode = "disabled" }
        if (!this.options.enable_modes) { this.options.enable_modes = false }
        if (!this.options.enable_panic) { this.options.enable_panic = false }
        if (!this.options.enable_volume) { this.options.enable_volume = false }
    }

    // Save updated refresh token to config or state file
    async updateToken(newRefreshToken, oldRefreshToken, stateFile, configFile) {
        if (!oldRefreshToken) { return }
        if (process.env.HASSADDON || process.env.ISDOCKER) {
            fs.writeFile(stateFile, JSON.stringify({ ring_token: newRefreshToken }), (err) => {
                if (err) throw err;
                debug('File ' + stateFile + ' saved with updated refresh token.')
            })
        } else if (configFile) {
            this.options.ring_token = newRefreshToken
            fs.writeFile(configFile, JSON.stringify(this.options, null, 4), (err) => {
                if (err) throw err;
                debug('Config file saved with updated refresh token.')
            })
        }
    }

}

module.exports = new Config()