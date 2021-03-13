const RingApi = require('ring-client-api').RingApi
const RingDeviceType = require('ring-client-api').RingDeviceType
const RingCamera = require('ring-client-api').RingCamera
const debug = require('debug')('ring-mqtt')
const colors = require('colors/safe')
const utils = require('./utils.js')
const SecurityPanel = require('../devices/security-panel')
const ContactSensor = require('../devices/contact-sensor')
const MotionSensor = require('../devices/motion-sensor')
const FloodFreezeSensor = require('../devices/flood-freeze-sensor')
const SmokeCoListener = require('../devices/smoke-co-listener')
const SmokeAlarm = require('../devices/smoke-alarm')
const CoAlarm = require('../devices/co-alarm')
const Lock = require('../devices/lock')
const Switch = require('../devices/switch')
const MultiLevelSwitch = require('../devices/multi-level-switch')
const Fan = require('../devices/fan')
const Beam = require('../devices/beam')
const Camera = require('../devices/camera')
const ModesPanel = require('../devices/modes-panel')
const Keypad = require('../devices/keypad')
const BaseStation = require('../devices/base-station')
const RangeExtender = require('../devices/range-extender')

// Class with function to manage Ring locations and devices
class Ring {
    constructor() {
        this.ringApi = false
        this.locations = new Array()
        this.devices = new Array()
        this.republishCount = 6 // Republish config/state this many times after startup or HA start/restart
    }

    async tryAuth(ringAuth, CONFIG) {
        try {
            this.ringApi = new RingApi(ringAuth)
            await this.ringApi.getLocations()
            console.log(CONFIG)
            this.CONFIG = CONFIG
            return true
        } catch(error) {
            this.ringApi = false
            debug(colors.brightYellow(error.message))
            debug(colors.brightYellow('Unable to connect to Ring API using '+tokenSource+' refresh token.'))
            return false
        }
    }

    // Return supported device
    getDevice(device, CONFIG) {
        const deviceInfo = {
            device: device,
            category: 'alarm',
            mqttClient: this.mqttClient,
            CONFIG
        }
        if (device instanceof RingCamera) {
            return new Camera(deviceInfo)
        }
        switch (device.deviceType) {
            case RingDeviceType.ContactSensor:
            case RingDeviceType.RetrofitZone:
            case 'sensor.tilt':
                return new ContactSensor(deviceInfo)
            case RingDeviceType.MotionSensor:
                return new MotionSensor(deviceInfo)
            case RingDeviceType.FloodFreezeSensor:
                return new FloodFreezeSensor(deviceInfo)
            case RingDeviceType.SecurityPanel:
                return new SecurityPanel(deviceInfo)
            case RingDeviceType.SmokeAlarm:
                return new SmokeAlarm(deviceInfo)
            case RingDeviceType.CoAlarm:
                return new CoAlarm(deviceInfo)
            case RingDeviceType.SmokeCoListener:
                return new SmokeCoListener(deviceInfo)
            case RingDeviceType.BeamsMotionSensor:
            case RingDeviceType.BeamsSwitch:
            case RingDeviceType.BeamsTransformerSwitch:
            case RingDeviceType.BeamsLightGroupSwitch:
                deviceInfo.category = 'lighting'
                return new Beam(deviceInfo)
            case RingDeviceType.MultiLevelSwitch:
                return newDevice = (device.categoryId === 17) 
                    ? new Fan(deviceInfo)
                    : new MultiLevelSwitch(deviceInfo)
            case RingDeviceType.Switch:
                return new Switch(deviceInfo)
            case RingDeviceType.Keypad:
                return new Keypad(deviceInfo)
            case RingDeviceType.BaseStation:
                return new BaseStation(deviceInfo)
            case RingDeviceType.RangeExtender:
                return new RangeExtender(deviceInfo)
            case RingDeviceType.Sensor:
                return newDevice = (device.name.toLowerCase().includes('motion'))
                    ? new MotionSensor(deviceInfo)
                    : new ContactSensor(deviceInfo)
            case 'location.mode':
                return new ModesPanel(deviceInfo)
        }
        if (/^lock($|\.)/.test(device.deviceType)) {
            return new Lock(deviceInfo)
        }
        return null
    }

    // Update all Ring location/device data
    async updateRingData() {
        // Small delay makes debug output more readable
        await utils.sleep(1)

        // Loop through each location and update stored locations/devices
        for (const location of await this.ringApi.getLocations()) {
            let cameras = new Array()
            const unsupportedDevices = new Array()

            debug(colors.green('-'.repeat(80)))
            let foundLocation = this.locations.find(l => l.locationId == location.locationId)
            // If new location, set custom properties and add to location list
            if (foundLocation) {
                debug(colors.green('Found existing location '+location.name+' with id '+location.id))
            } else {
                debug(colors.green('Found new location '+location.name+' with id '+location.id))
                if (location.hasHubs) { location.needsSubscribe = true }
                this.locations.push(location)
                foundLocation = location
            }

            // Get all location devices and, if configured, cameras
            const devices = await foundLocation.getDevices()
            if (this.CONFIG.enable_cameras) { cameras = await location.cameras }
            const allDevices = [...devices, ...cameras]

            // Add modes panel, if configured and the location supports it
            if (this.CONFIG.enable_modes && (await foundLocation.supportsLocationModeSwitching())) {
                allDevices.push({
                    deviceType: 'location.mode',
                    location: location,
                    id: location.locationId + '_mode',
                    deviceId: location.locationId + '_mode'
                })
            }

            // Update Ring devices for location
            for (const device of allDevices) {
                const deviceId = (device instanceof RingCamera) ? device.data.device_id : device.id
                const foundDevice = this.devices.find(d => d.deviceId == deviceId && d.locationId == location.locationId)
                if (foundDevice) {
                    debug(colors.green('  Existing device of type: '+device.deviceType))
                } else {
                    const newDevice = this.getDevice(device, this.CONFIG)
                    if (newDevice) {
                        this.devices.push(newDevice)
                        debug(colors.green('  New device of type: '+device.deviceType))
                    } else {
                        // Save unsupported device type
                        unsupportedDevices.push(device.deviceType)
                    }
                }
            }
            // Output any unsupported devices to debug with warning
            unsupportedDevices.forEach(deviceType => {
                debug(colors.yellow('  Unsupported device of type: '+deviceType))
            })
        }
        debug(colors.green('-'.repeat(80)))
        debug('Ring location/device data updated, sleeping for 5 seconds.')
        await utils.sleep(5)
    }

    // Set all devices for location offline
    async setLocationOffline(location) {
        // Wait 30 seconds before setting devices offline in case disconnect is transient
        // Keeps from creating "unknown" state for sensors if connection error is short lived
        await utils.sleep(30)
        if (location.onConnected._value) { return }
        this.devices.forEach(device => {
            if (device.locationId == location.locationId && !device.camera) {
                device.offline()
            }
        })
    }

    // Publish devices/cameras for given location
    async publishDevices(devices, location) {
        this.republishCount = (this.republishCount < 1) ? 1 : this.republishCount
        while (this.republishCount > 0 && this.mqttClient.connected) {
            try {
                if (devices && devices.length) {
                    devices.forEach(device => {
                        // Provide location websocket connection state to device
                        device.publish(location.onConnected._value)
                    })
                }
            } catch (error) {
                debug(error)
            }
            await utils.sleep(30)
            this.republishCount--
        }
    }

    // Loop through each location and call publishLocation for supported/connected devices
    async processLocations(mqttClient) {
        this.mqttClient = mqttClient

        // Update Ring location and device data
        await this.updateRingData()
    
        // For each location get existing alarm & camera devices
        this.locations.forEach(async location => {
            const devices = await this.devices.filter(d => d.locationId == location.locationId)
            // If location has devices publish them
            if (devices && devices.length) {
                if (location.needsSubscribe) {
                    // Location has an alarm or smart bridge so subscribe to websocket connection monitor
                    location.needsSubscribe = false
                    location.onConnected.subscribe(async connected => {
                        if (connected) {
                            debug('Websocket for location id '+location.locationId+' is connected')
                            this.publishDevices(devices, location)
                        } else {
                            debug('Websocket for location id '+location.locationId+' is disconnected')
                            this.setLocationOffline(location)
                        }
                    })
                } else {
                    this.publishDevices(devices, location)
                }
            } else {
                debug('No devices found for location ID '+location.id)
            }
        })
    }
}

module.exports = new Ring()