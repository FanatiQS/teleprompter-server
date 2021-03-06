'use strict';

const log = require('./log');
const isObj = require('./isObj');
const Client = require('./client');
const Project = require('./project');
const getConf = require('./getConf');
const getLoader = require('./getLoader');
const httpStatic = require('./httpStatic');
const socketServer = require('./socket');



// Create a new teleprompter server
const Server = module.exports = function TeleprompterServer(server, confInput1, confInput2) {
	// Make work with or without 'new' operator
	if (!(this instanceof Server)) return new Server(...arguments);

	// Log, started server setup
	log("Teleprompter server started...");

	// Create config from file or object
	this.conf = getConf(confInput1, confInput2, {
		// When 'autoLogin' property in 'conf' changes, send autoreload message to all clients that is using 'autologin'
		autoLogin: (value) => {
			log("Updating all clients using autoLogin to new ID:", value);
			this.autoLogins.forEach((client) => {
				client.tx({autoReload: value});
			});
		}
	});

	// Get custom- or default loader
	this.loader = getLoader(this.conf.loader, () => this.conf.timeout);

	// Uniq incrementing ID for clients
	this.clients = 0;

	// Library for all projects to live in
	this.library = {};

	// List of clients connected using 'autologin'
	this.autoLogins = [];



	// Counter for when everything is closed
	this.closedCount = 0;

	// Add callbacks for when 'conf' watcher is closed
	if (this.conf._watcher) {
		this.conf._watcher.callbacks.push(this.addOnClosed((path) => {
			log(/@!/, "Stopped waching config file:", /@path/, path);
		}));
	}



	// Storage for event triggers
	this.triggers = {};

	// Create trigger for when config file is created and add it to 'conf' when listeners are added
	if (this.conf._createFileCallback === null) {
		this.addTrigger(
			'createConf',
			(trigger) => this.conf._createFileCallback = trigger
		);
	}



	// Get, or create a new, socket server
	this.wss = socketServer.call(this, server);

	// Add 'wss' to closable systems to check when everything is closed
	if (this.wss) {
		this.wss.on('close', this.addOnClosed(() => {
			log(/@!/,"Websocket server closed");
		}));
	}



	// Skip preloading if loader function is missing
	if (!this.loader.getProjs) {
		log("Pre-loading disabled");
		return;
	}

	// Log, preloading projects
	log("Pre-loading projects...");

	// Create trigger for when preloading is done
	this.addTrigger('preload');

	// Preload projects received from 'getProjs' loader
	this.loader.getProjs(this.conf, (err, list) => {
		if (err) {
			// Log, 'getProjs' callback timed out
			if (err.code === 'TIMEOUT') {
				log.err("Timed out getting projects to preload").ERROR(err);
				return;
			}
			// Log, 'getProjs' callback has already been called
			else if (err.code === 'BLOCKED') {
				log.err("List of projects to preload has already been received").ERROR(err);
				return;
			}
			// Log, loader got an error
			else {
				log.err("Error getting projects list").ERROR(err);
			}
		}
		// Set up project for every 'projID' property in 'list'
		else if (Array.isArray(list)) {
			// Add all projects from 'list' to 'library'
			let completed = list.length;
			if (completed) {
				list.forEach((projID) => {
					let async;
					this.getProj(projID, null, () => {
						completed --;

						// Continue when all callbacks are called
						if (completed === 0) {
							// Log, list of set up projects
							const list = Object.keys(this.library);
							log((list && list.length) ? "Pre-loaded projects:\n\t" + list.join('\n\t') : "No projects pre-loaded");

							// Run trigger if async
							if (async) {
								this.triggers.preload(this.library);
							}
							// Save trigger to run when adding first listener
							else {
								this.triggers.preload.callback = () => {
									this.triggers.preload(this.library);
								};
							}
						}
					});
					async = true;
				});
				return;
			}
		}
		// Error handling for if 'list' is not an array or suppressed
		else if (list !== null) {
			log.err("Returned value from 'getProjs' needs to be an array:", list);
		}

		// Log, no projects preloaded
		log("Found no projects to pre-load");
	});
};

// Create a new client connected to this server
Server.prototype.createClient = function () {
	return new Client(this, ...arguments);
};

// Set up project in 'library' for 'projID'
Server.prototype.getProj = function (projID, init, callback) {
	// Run 'callback' if project already exists
	if (this.library[projID]) {
		callback(this.library[projID]);
	}
	// Add project to 'library' if it doesn't exist
	else {
		this.loader.loadProj(projID, init, this.conf, (err, settings) => {
			if (err) {
				// Log, 'loadProj' callback timed out
				if (err.code === 'TIMEOUT') {
					log.err("Timed out getting project settings for:", projID).ERROR(err);
				}
				// Log, 'loadProj' callback has already been called
				else if (err.code === 'BLOCKED') {
					log.err("Settings has already been received for:", projID).ERROR(err);
				}
				// Log, loader got an error
				else {
					log.err("Error loading proj:", projID).ERROR(err);
				}
			}
			// Create project in 'library'
			else if (isObj(settings)) {
				this.library[projID] = new Project(projID, settings, this.loader);
			}
			// Error handling for if 'settings' is not an object or suppressed
			else if (settings !== null) {
				log.err("Returned value from 'loadProj' needs to be an object:", settings);
			}

			// Run 'callback' with project object or undefined as argument
			callback(this.library[projID]);
		});
	}
};

// Create trigger for event listener
Server.prototype.addTrigger = function (event, callback) {
	// Create trigger function that runs every callback in 'listeners'
	const trigger = function () {
		trigger.listeners.forEach((cb) => cb(...arguments));
	};

	// Add 'callback'
	trigger.callback = callback;

	// Create 'listeners' array
	trigger.listeners = [];

	// Export 'trigger' function
	this.triggers[event] = trigger;
	return trigger;
};

// Create event listener
Server.prototype.on = function (event, callback) {
	// Error handling for malformed arguments
	if (typeof event !== 'string') throw TypeError("Event needs to be a string: " + event);
	if (typeof callback !== 'function') throw TypeError("Callback needs to be a function: " + callback);

	// Abort if 'event' is not valid
	if (!this.triggers[event]) return;

	// Add callback to 'listeners' for 'event'
	this.triggers[event].listeners.push(callback);

	// Run 'callback' when first listener is added
	if (this.triggers[event].callback) {
		this.triggers[event].callback(this.triggers[event]);
		this.triggers[event].callback = null;
	}
};

// Close teleprompter server
Server.prototype.close = function () {
	// Log, closing server
	log(/@!/, "Teleprompter server is shutting down...");

	// Stop watching config file
	if (this.conf._watcher) this.conf._watcher.close();

	// Close websocket server if it was created internally
	if (this.wss.internal) this.wss.close();
};

// Add this to closable systems to check for when everything is closed
Server.prototype.addOnClosed = function (callback) {
	this.closedCount ++;
	return (...args) => {
		// Run callback for close event
		callback(...args);

		// Remove it from the counter
		this.closedCount --;

		// Log, everything is shut down if this was the last one
		if (!this.closedCount) log(/@!/, "Teleprompter server shut down!");
	};
};

// Add static files served by http server created internally
Server.prototype.httpUse = httpStatic.use;
