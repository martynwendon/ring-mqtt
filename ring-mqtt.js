#!/usr/bin/env node

// Defines
const isOnline = require('is-online')
const debug = require('debug')('ring-mqtt')
const colors = require('colors/safe')
const ring = require('./lib/ring.js')
const mqtt = require('./lib/mqtt.js')
const config = require('./lib/config.js')
const utils = require('./lib/utils.js')
const tokenApp = require('./lib/tokenapp.js')
const fs = require('fs')

// Setup Exit Handwlers
process.on('exit', processExit.bind(0))
process.on('SIGINT', processExit.bind(0))
process.on('SIGTERM', processExit.bind(0))
process.on('uncaughtException', processExit.bind(1))

// Set unreachable status on exit
async function processExit(exitCode) {
    ring.devices.forEach(ringDevice => {
        if (ringDevice.availabilityState == 'online') { ringDevice.offline() }
    })
    if (exitCode || exitCode === 0) debug('Exit code: '+exitCode)
    await utils.sleep(1)
    process.exit()
}

/* End Functions */

// Main code loop
const main = async(generatedToken) => {
    let ringAuth = new Object()
    let ringConnected = false
    let configFile = './config.json'
    let stateData = new Object()
    let stateFile

    // For HASSIO and DOCKER latest token is saved in /data/ring-state.json
    if (process.env.HASSADDON || process.env.ISDOCKER) { 
        stateFile = '/data/ring-state.json'
        if (process.env.HASSADDON) {
            configFile = '/data/options.json'
            // For addon config is performed via Web UI
            if (!tokenApp.listener) {
                tokenApp.start()
                tokenApp.token.registerListener(function(generatedToken) {
                    main(generatedToken)
                })
            }
        } else {
            configFile = '/data/config.json'
        }
    }

    // Initiate CONFIG object from file or environment variables
    await config.init(configFile)

    // If refresh token was generated via web UI, use it, otherwise attempt to get latest token from state file
    if (generatedToken) {
        debug('Using refresh token generated via web UI.')
        stateData.ring_token = generatedToken
    } else if (stateFile) {
        if (fs.existsSync(stateFile)) {
            debug('Reading latest data from state file: '+stateFile)
            stateData = require(stateFile)
        } else {
            debug('File '+stateFile+' not found. No saved state data available.')
        }
    }
    
    // If no refresh tokens were found, either exit or start Web UI for token generator
    if (!config.options.ring_token && !stateData.ring_token) {
        if (process.env.ISDOCKER) {
            debug('No refresh token was found in state file and RINGTOKEN is not configured.')
            process.exit(2)
        } else {
            if (process.env.HASSADDON) {
                debug('No refresh token was found in saved state file or config file.')
                debug('Use the web interface to generate a new token.')
            } else {
                debug('No refresh token was found in config file.')
                tokenApp.start()
            }
        }
    } else {
        // There is at least one token in state file or config
        // Check if network is up before attempting to connect to Ring, wait if network is not ready
        while (!(await isOnline())) {
            debug('Network is offline, waiting 10 seconds to check again...')
            await utils.sleep(10)
        }

        // Define some basic parameters for connection to Ring API
        if (config.options.enable_cameras) {
            ringAuth = { 
                cameraStatusPollingSeconds: 20,
                cameraDingsPollingSeconds: 2
            }
        }
        if (config.options.enable_modes) { ringAuth.locationModePollingSeconds = 20 }
        if (!(config.options.location_ids === undefined || config.options.location_ids == 0)) {
            ringAuth.locationIds = config.options.location_ids
        }

        // If there is a saved or generated refresh token, try to connect using it first
        if (stateData.ring_token) {
            const tokenSource = generatedToken ? "generated" : "saved"
            debug('Attempting connection to Ring API using '+tokenSource+' refresh token.')
            ringAuth.refreshToken = stateData.ring_token
            ringConnected = ring.tryAuth(ringAuth)
            if (!ringConnected) {
                debug(colors.brightYellow('Unable to connect to Ring API using '+tokenSource+' refresh token.'))
            } 
        }

        // If Ring API is not already connected, try using refresh token from config file or RINGTOKEN variable
        if (!ringConnected) {
            if (config.options.ring_token) {
                const debugMsg = process.env.ISDOCKER ? 'RINGTOKEN environment variable.' : 'refresh token from file: '+configFile
                debug('Attempting connection to Ring API using '+debugMsg)
                ringAuth.refreshToken = config.options.ring_token
                ringConnected = ring.tryAuth(ringAuth, config.options)
                if (!ringConnected) {
                    debug(colors.brightRed(error.message))
                    debug(colors.brightRed('Could not create the API instance. This could be because the Ring servers are down/unreachable'))
                    debug(colors.brightRed('or maybe all available refresh tokens are invalid.'))
                    if (process.env.HASSADDON) {
                        debug('Restart the addon to try again or use the web interface to generate a new token.')
                    } else {
                        debug('Please check the configuration and network settings, or generate a new refresh token, and try again.')
                        process.exit(2)
                    }
                }
            } else {
                // No connection with Ring API using saved token and no configured token to try
                if (process.env.ISDOCKER) {
                    debug('Could not connect with saved refresh token and RINGTOKEN is not configured.')    
                    process.exit(2)
                } else if (process.env.HASSADDON) {
                    debug('Could not connect with saved refresh token and no refresh token exist in config file.')
                    debug('Restart the addon to try again or use the web interface to generate a new token.')
                }
            }
        }
    }

    if (ringConnected) {
        debug('Connection to Ring API successful')

        // Update the web app with current connected refresh token
        const currentAuth = await ring.ringApi.restClient.authPromise
        tokenApp.updateConnectedToken(currentAuth.refresh_token)

        // Subscribed to token update events and save new token
        ring.ringApi.onRefreshTokenUpdated.subscribe(async ({ newRefreshToken, oldRefreshToken }) => {
            updateToken(newRefreshToken, oldRefreshToken, stateFile, configFile)
        })

        mqtt.init(config.options)
    }
}

// Call the main code
main()
