'use strict';

const log = require('./log');
const isObj = require('./isObj');



// Create shared prototype
function DeepObserve(callback) {
	// Create self and callback links
	this.prototype = this;
	this.callback = callback;

	// Create top property
	this.top = Object.create(this);
	this.top.store = {};

	// Return top value
	return this.top;
}

// Proxy value if it is an object
DeepObserve.prototype.topGetter = function (value) {
	return (!isObj(value)) ? value : this.getProxy(value);
};

// Get proxy for 'obj'
DeepObserve.prototype.getProxy = function (obj) {
	// Use existing proxy
	if (this.proxy) return this.proxy;

	// Create new proxy
	this.children = {};
	return this.proxy = new Proxy(obj, this);
};

// Add new data
DeepObserve.prototype.nextCallback = function () {
	// Force recreation of proxy with the new data
	this.proxy = null;

	// Run 'callback' once on next tick and reset
	if (!this.callback.wait) {
		this.callback.wait = true;
		process.nextTick(() => {
			this.callback(this.top.store);
			this.top.store = {};
			this.callback.wait = false;
		});
	}

	// Return object for adding new data
	if (this.store) return this.store;

	// Commit stored tmp data
	this.callback.store[this.callback.key] = this.callback.tmp;

	// Return object for adding new data
	return this.tmp;
};

// Create object path for setter
DeepObserve.prototype.get = function (target, key) {
	// Return untouched value unless it is an object
	if (!isObj(target[key])) return target[key];

	// Create child object if it does not exist
	if (!this.children[key]) this.children[key] = Object.create(this.prototype);

	// Set tmp object for child
	this.children[key].tmp = {};

	// Store data for callback argument
	if (this.store) {
		this.children[key].store = this.store[key];
		this.callback.key = key;
		this.callback.store = this.store;
		this.callback.tmp = this.children[key].tmp;
	}
	// Add data to callback store
	else {
		this.tmp[key] = this.children[key].tmp;
	}

	// Return proxy
	return this.children[key].getProxy(target[key]);
};

// Add new data to callback argument and object property
DeepObserve.prototype.set = function (target, key, value) {
	this.nextCallback()[key] = value;
	target[key] = value;
	return true;
};

// Add null to callback argument and delete object property
DeepObserve.prototype.deleteProperty = function (target, key) {
	this.nextCallback()[key] = null;
	delete target[key];
	return true;
};



// Run callback on update to objects property
exports.observe = function observe(obj, key, callback) {
	// Get original/current properties
	const descriptor = Object.getOwnPropertyDescriptor(obj, key) || {};

	// Handle missing setter function
	if (!descriptor.set) {
		// Abort if property is getter only
		if (descriptor.get) return

		// Create getter and setter linked to value if getter and setter doesn't exist
		descriptor.get = function () {
			return descriptor.value;
		};
		descriptor.set = function (value) {
			descriptor.value = value;
		};
	}

	// Redefine setter function to run middleware
	const setter = function (value) {
		// Run middleware with new property value
		setter.mid(value);

		// Run setter function
		descriptor.set(value);
	};

	// Create middleware function
	setter.mid = (value) => {
		// Make property visible if it is hidden
		if (!obj.propertyIsEnumerable()) {
			Object.defineProperty(obj, key, {
				enumerable: true
			});
		}

		// Reset proxy since proxied object changes
		if (setter.deepObserver.proxy) setter.deepObserver.proxy = null;

		// Commit changes to argument value if 'callback' is already cued
		if (callback.wait) {
			setter.deepObserver.store = value;
			return;
		}

		// Run callback with new value as arguments
		callback(value);
	};

	// Create deep observe getter/setter for child properties
	setter.deepObserver = new DeepObserve(callback);

	// Set property to use getter/setter
	Object.defineProperty(obj, key, {
		get: (!descriptor.get) ? undefined : function () {
			return setter.deepObserver.topGetter(descriptor.get());
		},
		set: setter,
		configurable: true
	});
};



// Update changed values from 'newObj' in 'oldObj' including child properties
exports.applyChange = function (oldObj, newObj, keyPath = '') {
	Object.keys({...oldObj, ...newObj}).forEach((key) => {
		// Abort if values are the same
		if (newObj[key] === oldObj[key]) return;

		// Display error message for updating locked properties
		const descriptor = Object.getOwnPropertyDescriptor(oldObj, key);
		if (descriptor && !descriptor.configurable) {
			if (newObj.hasOwnProperty(key)) {
				log.err("Unable to modify locked property:", key);
			}
		}
		// Add new properties not existing/visible in oldObj
		else if (!oldObj.propertyIsEnumerable(key)) {
			// Add/update property
			try {
				oldObj[key] = newObj[key];
			}
			// Error handling for if updating property failed
			catch (err) {
				log.err("Unable to add property:", key).ERROR(err);
				return;
			}

			// Make hidden properties visible
			if (oldObj.hasOwnProperty(key)) {
				Object.defineProperty(oldObj, key, {enumerable: true});
			}

			// Log, added new property
			log("Added property '" + keyPath + key + "' with value:", newObj[key]);
		}
		// Delete/hide properties not existing in newObj
		else if (!newObj.hasOwnProperty(key)) {
			// Delete value properties
			if (descriptor.value) {
				delete oldObj[key];
			}
			// Hide get/set properties
			else {
				if (descriptor.set) descriptor.set(undefined);
				Object.defineProperty(oldObj, key, {enumerable: false})
			}

			// Log, removed property
			log("Removed property:", keyPath + key);
		}
		// Combine objects properties
		else if (
			typeof newObj[key] === 'object' &&
			typeof oldObj[key] === 'object'
		) {
			exports.applyChange(oldObj[key], newObj[key], key + '/');
		}
		// Update property with value from newObj
		else {
			// Update property
			try {
				oldObj[key] = newObj[key];
			}
			// Error handling for if updating property failed
			catch (err) {
				log.err("Unable to update property:", key).ERROR(err);
				return
			}

			// Log, updated existing property
			log("Updated property '" + keyPath + key + "' to:", newObj[key]);
		}
	});
};
