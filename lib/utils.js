'use strict';

const inspect = require ('util').inspect

/** @module Utils */

/*
	This module contains util functions, wrappers and constants that are useful for the whole lib
*/

// Set to true to switch all library files into debug mode
const GLOBAL_DEBUG = false

// Wether to debug this file
const DEBUG = false

/**
 * Maximum name length for interface or error name that DBus allows
 * @type {number}
 */
const DBUS_MAX_NAME_LENGTH = 255

/**
 * Regex that validates an interface or error name (have to check max length first)
 * @type {regex}
 */
const DBUS_INTERFACE_NAME_REGEX = /^[a-zA-Z_]\w*(?:\.[a-zA-Z_]\w*)+$/

/**
 * Regex that validate a path <strong>component</strong> (not an entire path)
 * @type {regex}
 */
// const DBUS_OBJ_PATH_COMPONENT_REGEX = /^[a-zA-Z]\w*$/
const DBUS_OBJ_PATH_COMPONENT_REGEX = /^\w+$/

///////////////////////////////////////////////////////////////////////////////////
// DBus constants, do not change value, they are based on the DBus specification //
///////////////////////////////////////////////////////////////////////////////////
// Flags to request a name
const DBUS_NAME_FLAG_ALLOW_REPLACEMENT = 0x1 // allows someone to steal our name
const DBUS_NAME_FLAG_REPLACE_EXISTING  = 0x2 // try to steal the name from someone
const DBUS_NAME_FLAG_DO_NOT_QUEUE      = 0x4 // do not queue us if we can't get or steal the name and fail instead
// Return code when requesting a name
const DBUS_REQUEST_NAME_REPLY_PRIMARY_OWNER = 0x1  // OK, you are the name's owner now
const DBUS_REQUEST_NAME_REPLY_IN_QUEUE      = 0x2  // name already has an owner, you are in queue for it
const DBUS_REQUEST_NAME_REPLY_EXISTS        = 0x3  // NOK, name already has an owner, you were not queued
const DBUS_REQUEST_NAME_REPLY_ALREADY_OWNER = 0x4  // you are already the name's owner

/**
 * Test whether a name respects DBus interface naming convention<br>
 *
 * @param {string} name - The name to check for validity
 * @returns {boolean} Whether the name is valid or not, according to DBus naming rules
 * @see https://dbus.freedesktop.org/doc/dbus-specification.html#message-protocol-names-interface
 */
function isValidIfaceName (name) {
	if (typeof name !== 'string' || name.length >= DBUS_MAX_NAME_LENGTH || ! DBUS_INTERFACE_NAME_REGEX.test (name)) {
		return false
	} else {
		return true
	}
}

function isValidPathComponent (name) {
	if (typeof name !== 'string' || name.length >= DBUS_MAX_NAME_LENGTH || ! DBUS_OBJ_PATH_COMPONENT_REGEX.test (name)) {
		return false
	} else {DBUS_NAME_FLAG_REPLACE_EXISTING
		return true
	}
}

/**
 * Function used to translate the return types from the new API to the old API.<br>
 * As it is very complex to dive into the marshalling and change it, and since I'm on a timeline (and since, afterall,
 * it works fairly well), the goal of this function is to translate the return types from the function that use the new
 * API (so arrays, Map, custom structures, etc) to the nested array-like types that is used on the marshalling
 * side.<br>
 * The hope is that, when the new API is tested and stable, I'll go back to the marshalling process and directly support
 * marshalling from the new types.<br>
 * For now, this is a reasonnable choice.
 */
function translateTypesBetweenAPIs (retVal) {
	/*
		DBus STRUCT are represented as an object whose keys are integers {0: <value>, 1: <value>}.
		NOTE: we can't use simply Number.isNumber because JS transforms the 0,1,2 keys into '0','1','2' which are string
		So we have to 'convert' them into numbers first.
	*/
	if (typeof retVal === 'object'
	&& !Array.isArray (retVal) // To prevent matching on arrays
	&& Object.keys(retVal).length >= 2 // To prevent matching on Maps (for which Object.keys() return empty array)
	&& Object.keys(retVal).every (e => Number.isInteger (Math.floor(e)))) {
		let translation = []

		for (let k of Object.keys (retVal))
			translation.push (retVal[k])

		return [translation]
	}
	/*
		DBus DICT are represented as a Map whose keys are the DICT's keys and the values are the DICT's values.
	*/
	else if (retVal instanceof Map) {
		let translation = []

		for (let [k,v] of retVal) {
			translation.push ([k, v])
		}

		return [translation]
	}
	/*
		Dbus ARRAYs are represented as Javascript arrays
	*/
	else if (Array.isArray (retVal)) {
		return [retVal]
	}
	/*
		Multiple DBus values is represented in Javascript as an object with a field '_multiple' whose value is an array
		of the multiple values to return
	*/
	else if (typeof retVal === 'object'
	&& Object.keys(retVal).length === 1
	&& Object.keys(retVal)[0] === '_multiple'
	&& Array.isArray (retVal._multiple)
	&& retVal._multiple.length > 1) {
		throw new Error ('Multiple values is not yet supported')
	}
	// Otherwise it must be a single type
	else {
		if (DEBUG) {
			console.log ('Got Single Type')
			console.log (retVal)
		}
		return [retVal]
	}
}

/**
 * Sister function, which does the opposite...<br>
 * Given a type formatted in the old API, convert it back to the new API
 * We need the signature to distinguish between an array of value and a struct (both of them are implemented as an
 * array of value, so there is no way to distinguish between an array of string and a structure made of only strings)
 */
const singleTypes = 'ybnqiuxtdsog'
function fromOldtoNewAPI (vals, tree) {
	if (DEBUG) console.log ('--')
	if (DEBUG) console.log ('vals: ' + inspect (vals, {depth: 5}))
	if (DEBUG) console.log ('tree: ' + inspect (tree, {depth: 6}))
	if (DEBUG) console.log ('--')

	/*
		Single type
	*/
	if (singleTypes.includes (tree.type)) {
		if (DEBUG) console.log ('Got single type: ' + inspect (vals))
		return vals
	}

	/*
		Arrays
	*/
	if (tree.type === 'a') {
		if (DEBUG) console.log ('Array')
		let arr = vals.map (e => fromOldtoNewAPI (e, tree.child[0]))

		// If the array's child is '{', it's a DICT, so make it a Map
		if (tree.child[0].type === '{') {
			let m = new Map (arr)
			if (DEBUG) console.log ('map: ' + inspect (m, {depth: 5}))
			// Return the Map
			return m
		}
		else {
			if (DEBUG) console.log ('arr: ' + inspect(arr,{depth: 5}))
			// Return the array
			return arr
		}
	}

	/*
		Dict
	*/
	if (tree.type === '{') {
		if(DEBUG) console.log ('DICT part')
		let arr = vals.map ((e, idx) => fromOldtoNewAPI (e, tree.child[idx]))
		if(DEBUG) console.log ('struct part: ' + inspect (arr, {depth :5}))
		return arr
	}

	/*
		Struct
	*/
	if (tree.type === '(') {
		let i = 0
		let obj = {}
		if (DEBUG) console.log ('STRUCT')

		let arr = vals.map ((e, idx) => fromOldtoNewAPI (e, tree.child[idx]))
		// console.log ('Struct elems: ' + inspect (arr, {depth: 5}))

		while (arr.length > 0) {
			obj[i++] = arr.shift()
		}

		if (DEBUG) console.log ('Returning struct: ' + inspect (obj))

		// Return the structure
		return obj
	}

	// Can't parse
	throw new TypeError ('Error while trying to parse result: data and signature don\'t match.')
}

/**
 * Convenient function to put as default value for function's argument that we want to make mandatory.<br>
 * It throws an error so that the user knows he missed a mandatory argument.
 *
 * @throws {TypeError}
 */
function mandatory () {
	throw new TypeError ('Missed a mandatory argument in function call!')
}

module.exports = {
	DBUS_MAX_NAME_LENGTH,
	GLOBAL_DEBUG,
	DBUS_NAME_FLAG_ALLOW_REPLACEMENT,
	DBUS_NAME_FLAG_REPLACE_EXISTING,
	DBUS_NAME_FLAG_DO_NOT_QUEUE,
	DBUS_REQUEST_NAME_REPLY_PRIMARY_OWNER,
	DBUS_REQUEST_NAME_REPLY_IN_QUEUE,
	DBUS_REQUEST_NAME_REPLY_EXISTS,
	DBUS_REQUEST_NAME_REPLY_ALREADY_OWNER,
	mandatory,
	isValidIfaceName,
	isValidErrorName: isValidIfaceName, // turns out, Error names must respect the same rules as interface names
	isValidPathComponent,
	translateTypesBetweenAPIs,
	fromOldtoNewAPI,
}