'use strict';

const debug     = require ('debug')('dbus-native:utils')
const inspect   = require ('util').inspect
const signature = require ('./signature')

inspect.defaultOptions = {colors: true, breakLength: 1, depth: 5}

/** @module Utils */

/*
	This module contains util functions, wrappers and constants that are useful for the whole lib
*/

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

const singleTypes = 'ybnqiuxtdsog'

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
	} else {
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

/**
 * @todo Make a pass to add type checks:
 * @todo for single types, make sure it is a single type (check if number, string or boolean) and not containers
 * @todo for arrays, check if it's an array
 * @todo for dict, check that it is an object and not an array
*/
function fromNewToOldAPI (val, tree) {
	/*
		Single type
	*/
	if (singleTypes.includes (tree.type)){
		debug ('[N->O] Single type: ' + inspect (val))

		return val
	}

	/*
		Array
	*/
	if (tree.type === 'a' && tree.child[0].type !== '{') {
		// In an array, every element has the same type (/= struct), so recursively convert values with the same type
		let arr = val.map (v => fromNewToOldAPI (v, tree.child[0]))

		debug (`[N->O] Array: ${inspect (arr)}`)

		/*
			With current marshalling process, there is one level of array nesting.
			There is an additional level of array nesting for containers type, so an array is nested once more.
		*/
		return arr
	}

	/*
		Struct
	*/
	if (tree.type === '(') {
		// In a struct, each element has its own type (/= array), so recursively convert values with their own type
		let arr = val.map ((v, idx) => fromNewToOldAPI (v, tree.child[idx]))

		debug (`[N->O] Struct: ${inspect (arr)}`)

		/*
			With current marshalling process, there is one level of array nesting.
			There is an additional level of array nesting for containers type, so a struct is nested once more.
		*/
		return arr
	}

	/*
		Dict
	*/
	if (tree.type === 'a' && tree.child[0].type === '{') {
		let struct = []

		for (let k of Object.keys (val)) {
			let convertedKey = fromNewToOldAPI (k, tree.child[0].child[0])
			let convertedValue = fromNewToOldAPI (val[k], tree.child[0].child[1])
			struct.push ([convertedKey, convertedValue])
		}


		debug ('[N->O] Struct: ' + inspect (struct))

		/*
			With current marshalling process, there is one level of array nesting.
			A struct is a container type, so there's an additionnal level of nesting and each element is a 2-elem array
			whose first element is the key and the second is the value.
		*/
		return struct
	}

	/*
		Variant
	*/
	if (tree.type === 'v') {
		if (val.type !== undefined && val.value !== undefined) {
			let variantSigTree = signature (val.type)[0]
			let variantValue = fromNewToOldAPI (val.value, variantSigTree)

			/*
				The check if correct: IF the return value is ALREADY an array, THEN wrap it in another layer,
				otherwise, leave it.
				Explanations: this is due to the fact that the marshalling function expects the variant value to be
				already correctly formatted, so the containers must have an extra array wrapper around them.
				It's not the case at this point alreayd, because for the other types, we decided to make
				'fromNewToOldAPI' NOT return the containers type already re-wrapped. This is because we want to be able
				to call it recursively to nest object.
				This works very well, and we just need to wrap the converted value in another extra layer of array in
				the 'body' field of DBus messages for the marshalling.
			*/
			if (Array.isArray (variantValue))
				variantValue = [variantValue]

			return [val.type, variantValue]
		}

		throw new TypeError (`[N->O] Malformed variant type: it must be an object with 2 keys: 1) 'type' whose value is a DBus-valid signature describing the return value's type, 2) 'value' whose value is the value you want to return as the variant (it must, obviously, match the signature provided)\nHere is what was provided:\n${inspect(val)}`)
	}

	throw new TypeError (`[N->O] Unsupported type.\nval: ${inspect (val)}\ntree: ${inspect (tree)}`)
}
/**
 * Sister function, which does the opposite...<br>
 * Given a type formatted in the old API, convert it back to the new API
 * We need the signature to distinguish between an array of value and a struct (both of them are implemented as an
 * array of value, so there is no way to distinguish between an array of string and a structure made of only strings)
 */
function fromOldToNewAPI (vals, tree) {
	debug ('-- fromOldToNewAPI --')
	debug ('vals: ' + inspect (vals, {depth: 5}))
	debug ('tree: ' + inspect (tree, {depth: 6}))
	debug ('-- /fromOldToNewAPI --')

	/*
		Single type
	*/
	if (singleTypes.includes (tree.type)) {
		debug ('Got single type: ' + inspect (vals))
		return vals
	}

	/*
		Dict
	*/
	if (tree.type === 'a' && tree.child[0].type === '{') {
		debug ('Dict')
		let obj = vals.reduce( (acc, v, idx) => {
			let key = v[0]
			let val = fromOldToNewAPI (v[1], tree.child[0].child[1])

			acc[key] = val

			return acc
		}, {})

		debug (`obj: ${inspect (obj)}`)

		return obj
	}

	/*
		Arrays
	*/
	if (tree.type === 'a' && tree.child[0].type !== '{') {
		debug ('Array')

		// Special case for 'ay' (array of bytes) type since it's handled differently
		if (vals.type === 'Buffer' && vals.data != null) {
			// Make sure values are within range
			if (vals.data.some( v => v < 0 || v > 255))
				throw new TypeError(`Supposed Array of Buffer contains values out of range.`)

			return vals.data
		} else {

			let arr = vals.map (e => fromOldToNewAPI (e, tree.child[0]))

			// Return the array
			return arr
		}

	}

	/*
		Struct
	*/
	if (tree.type === '(') {
		debug ('STRUCT')

		let arr = vals.map ((e, idx) => fromOldToNewAPI (e, tree.child[idx]))
		// console.log ('Struct elems: ' + inspect (arr, {depth: 5}))

		debug ('arr: ' + inspect (arr))

		// Return the structure
		return arr
	}

	/*
		Variant
	*/
	if (tree.type === 'v') {
		let variantSig = vals[0][0]
		let variantVal = vals[1][0]
		let converted = fromOldToNewAPI (variantVal, variantSig)

		// Return the converted value
		return converted
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
	fromOldToNewAPI,
	fromNewToOldAPI,
}
