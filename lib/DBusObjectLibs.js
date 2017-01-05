'use strict';

const Peer              = require ('./std_ifaces/Peer.js')
const debug             = require ('debug')('dbus-native:DBusObjectLibs')
const utils             = require ('./utils.js')
const Errors            = require ('./Errors.js')
const inspect           = require ('util').inspect
const stdifaces         = require ('./stdifaces.js')
const Properties        = require ('./std_ifaces/Properties.js')
const Introspectable    = require ('./std_ifaces/Introspectable.js')
const xmlbuilder        = require ('xmlbuilder')
const DBusInterfaceLibs = require ('./DBusInterfaceLibs')

const mandatory = utils.mandatory

const InvalidNameError = Errors.InvalidNameError

const DBusInterface = DBusInterfaceLibs.DBusInterface

/** @module DBusObject */

/**
 * Represents a DBus Object.<br>
 * A DBusObject can have other (children) objects, and/or one (of several) interfaces.
 *
 * @param {DBusObject|DBusInterface} [objOrIface] - Optional object or interface to create as child for this object
 *
 * @throws {module:Errors#InvalidNameError}
 */
class DBusObject {
	constructor (objOrIface, relativePath) {
		// If the object is passed a DBusObject and we have a 'relativePath', make it a child
		if (objOrIface !== undefined && objOrIface instanceof DBusObject && relativePath !== undefined) {
			this.addObject (objOrIface, relativePath)
		}
		// If the object is passed a DBusInterface, add it to this Object
		else if (objOrIface !== undefined && objOrIface instanceof DBusInterface) {
			// Warn the user in case a relative path is given with the interface
			// console.warn ('A relative path was given although an interface was passed, the name is useless and will be discarded')

			this.addInterface (objOrIface)
		}
		// Otherwise fail so that the user doesn't think whatever was passed was actually added
		else if (objOrIface !== undefined) {
			throw new TypeError (`DBusObject can only be created with an child object or an interface (or nothing).`)
		}

		// Add standard interface Properties
		this.addInterface (new Properties ('org.freedesktop.DBus.Properties'))

		// Add standard interface Peer
		this.addInterface (new Peer ('org.freedesktop.DBus.Peer'))

		// Add standard interface Introspectable
		this.addInterface (new Introspectable ('org.freedesktop.DBus.Introspectable'))
	}

	/**
	 * Generate introspection data for this object.<br>
	 * What it does is:
	 * <ul>
	 * <li>have all ints interfaces generate its introspection data</li>
	 * <li>list all children nodes (not the complete introspection data)</li>
	 * <li>concatenate and return</li>
	 * </ul>
	 */
	introspect () {
		let keys = Object.keys (this)
		let ifaces = this.getIfaceNames()
		let objs = this.getChildrenPaths()
		let xml = xmlbuilder.create ('node', {headless: true}) // Create root element without the <?xml version="1.0"?>
			.dtd ('-//freedesktop//DTD D-BUS Object Introspection 1.0//EN',
				'http://www.freedesktop.org/standards/dbus/1.0/introspect.dtd')
			.root() // don't forget to return to the root elem so that elems are not added to the DTD

		// Have each interface generate its introspection data and add it to the root XML element
		for (let iface of ifaces) {
			this[iface].introspect (xml)
		}

		// List each object as nodes
		for (let obj of objs) {
			xml.ele ('node', {name: obj})
		}

		// console.log (xml.end ({pretty: true}))

		// Return the XML string
		return xml.end ({pretty: true})
	}

	/**
	 * Add an interface (and thus a set of functions, methods and signals) to an Object
	 * @param {DBusInterface} iface  The interface to add to the object
	 * @throws {TypeError}
	 */
	addInterface (iface = mandatory()) {
		// Check that 'iface' is a DBusInterface
		if (! (iface instanceof DBusInterface)) {
			throw new TypeError (`'iface' is not a DBusInterface.`)
		}

		// Check if the iface we're trying to add has a valid name
		if (!utils.isValidIfaceName (iface._ifaceName)) {
			throw new TypeError (`'${iface._ifaceName}' is not a valid interface name.`)
		}

		// Everything looks good, proceed to add the interface to the object (erasing the previously one if present)
		this[iface._ifaceName] = iface

		// Give the interface a reference to the object it is associated to
		iface.__dbusObject = this

		// TODO: Implement & emit 'Interface added' from Object Manager
	}

	/**
	 * Used to add a child object to either a {@link DBusService} or a {@link DBusObject}.
	 * @param {DBusObject}         object The child object to add
	 * @param {string}             relativePath The relative path at which add the child object
	 *
	 * @throws {TypeError}
	 */
	addObject (object = mandatory(), relativePath = mandatory()) {
		let pathComponents = relativePath.split ('/')

		// Check that 'object' is a DBusObject
		if (! (object instanceof DBusObject)) {
			throw new TypeError (`'object' is not a DBusObject.`)
		}

		// Check that all paths components are valid
		if (!pathComponents.every (utils.isValidPathComponent)) {
			throw new TypeError (`'${relativePath}' contains non-valid path components.`)
		}

		/*
		 * Everything looks good, traverse the object according to the path components, and add the obj as child
		 */
		let currObj = this 
		// traverse the object
		while (pathComponents.length > 1) {
			let currPathComponent = pathComponents.shift()

			// If the current object doesn't already have an object at this path component, create one
			if (typeof currObj[currPathComponent] === 'undefined') {
				currObj[currPathComponent] = new DBusObject()
				this._linkParentObject(currObj, currPathComponent)
			}

			// traverse the object
			currObj = currObj[currPathComponent]
		}

		// Now we have traversed our object and reached the object path to host the child, so add it
		if (currObj[pathComponents[0]]) {
			throw new Error(`path ${relativePath} already exists`)
		}
		currObj[pathComponents[0]] = object

		this._linkParentObject(currObj, pathComponents[0])

		if (this.getService()) {
			this.getService().bus.exposeObject(this.getService(), this, `${this.getPath()}/${relativePath}`)
		}
	}

	getChildrenPaths () {
		return Object.keys(this).filter(key => this[key] instanceof DBusObject && key !== '_parentObject')
	}

	getChildren () {
		return getChildrenPaths().map(key => this[key])
	}

	getIfaceNames () {
		return Object.keys(this).filter(key => this[key] instanceof DBusInterface)
	}

	getIfaces () {
		return getIfaceNames().map(key => this[key])
	}

	getParentObject () {
		return this._parentObject
	}

	getPathComponent () {
		return this._pathComponent
	}

	getService () {
		return this._service
	}

	setService (service) {
		this._service = service
	}

	getPath () {
		let path = []
		let currObj = this
		let component

		while (currObj && (component = currObj.getPathComponent())) {
			path.unshift(component)
			currObj = currObj.getParentObject()
		}

		path = path.join('/')
		if (this.getService()) {
			path = '/'+path
		}
	}
	
	_linkParentObject (parent, pathComponent) {
		parent[pathComponent]._parentObject = parent
		parent[pathComponent]._pathComponent = pathComponent
	}
}

module.exports = {
	DBusObject,
}
