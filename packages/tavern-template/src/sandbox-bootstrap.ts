/**
 * Host-authored bootstrap. Runs inside the fresh context, receives only a JSON
 * descriptor string and the host dispatch function (kept in this closure), and
 * returns a context-owned env. Captured intrinsics keep the membrane working
 * even if template code later replaces context globals/prototypes.
 */
const BOOTSTRAP_SOURCE = `(function (__descriptorJson, __dispatch) {
  'use strict'
  var __ObjectCreate = Object.create
  var __ObjectKeys = Object.keys
  var __ObjectFreeze = Object.freeze
  var __ObjectDefineProperty = Object.defineProperty
  var __ObjectHasOwn = Object.prototype.hasOwnProperty
  var __ObjectToString = Object.prototype.toString
  var __ObjectIs = Object.is
  var __Array = Array
  var __ArrayIsArray = Array.isArray
  var __String = String
  var __Number = Number
  var __NumberIsNaN = Number.isNaN
  var __NumberIsInteger = Number.isInteger
  var __JSONParse = JSON.parse
  var __JSONStringify = JSON.stringify
  var __Map = Map
  var __MapGet = Map.prototype.get
  var __MapSet = Map.prototype.set
  var __Promise = Promise
  var __RegExp = RegExp
  var __Date = Date
  var __Error = Error
  var __BigInt = BigInt
  var __ReflectApply = Reflect.apply
  var __StringReplace = String.prototype.replace

  var pending = __ObjectCreate(null)
  var wrappers = __ObjectCreate(null)
  var bridgeThis = __ObjectFreeze(__ObjectCreate(null))
  var nextToken = 0

  function hasOwn(target, key) {
    return __ReflectApply(__ObjectHasOwn, target, [key])
  }

  function isRecord(value) {
    return value !== null && typeof value === 'object' && !__ArrayIsArray(value)
  }

  function malformed(detail) {
    return new __Error('malformed sandbox bridge payload: ' + detail)
  }

  function requireRecord(value, label) {
    if (!isRecord(value)) throw malformed(label + ' is not an object')
    return value
  }

  function requireArray(value, label) {
    if (!__ArrayIsArray(value)) throw malformed(label + ' is not an array')
    return value
  }

  function requireString(value, label) {
    if (typeof value !== 'string') throw malformed(label + ' is not a string')
    return value
  }

  function requireInteger(value, label) {
    if (typeof value !== 'number' || !__NumberIsInteger(value) || value < 0) {
      throw malformed(label + ' is not a non-negative integer')
    }
    return value
  }

  function requireIndex(value, limit, label) {
    var index = requireInteger(value, label)
    if (limit !== undefined && index >= limit) throw malformed(label + ' is out of range')
    return index
  }

  function requireLength(value, label) {
    var length = requireInteger(value, label)
    if (length > 4294967295) throw malformed(label + ' is too large')
    return length
  }

  function lastIndexValue(value) {
    return typeof value === 'number' && __NumberIsInteger(value) && value >= 0 ? value : 0
  }

  function decodeNumber(raw) {
    if (typeof raw === 'number' && !__NumberIsNaN(raw) && raw !== Infinity && raw !== -Infinity) return raw
    if (raw === 'NaN') return NaN
    if (raw === 'Infinity') return Infinity
    if (raw === '-Infinity') return -Infinity
    if (raw === '-0') return -0
    throw malformed('invalid number')
  }

  function decodeEnc(enc, built) {
    var value = requireRecord(enc, 'wire value')
    switch (value.t) {
      case 'null': return null
      case 'u': return undefined
      case 's': return requireString(value.v, 'string value')
      case 'b':
        if (typeof value.v !== 'boolean') throw malformed('invalid boolean')
        return value.v
      case 'n': return decodeNumber(value.v)
      case 'big': return __BigInt(requireString(value.v, 'bigint value'))
      case 'ref': {
        var index = requireIndex(value.v, built.length, 'wire reference')
        return built[index]
      }
      default: throw malformed('unknown value tag ' + __String(value.t))
    }
  }

  function errorFrom(value) {
    var name = 'Error'
    var message
    try {
      if (value !== null && typeof value === 'object') {
        if (typeof value.name === 'string' && value.name !== '') name = value.name
        message = typeof value.message === 'string' ? value.message : __String(value)
      } else {
        message = __String(value)
      }
    } catch (error) {
      message = 'the template sandbox bridge returned an unprintable error'
    }
    var result = new __Error(message)
    result.name = name
    return result
  }

  function makeWrapper(id) {
    var key = 'f' + id
    if (hasOwn(wrappers, key)) return wrappers[key]
    var wrapper = function () {
      var args = []
      for (var i = 0; i < arguments.length; i++) args[i] = arguments[i]
      return invoke(id, args)
    }
    __ObjectDefineProperty(wrappers, key, { value: wrapper, writable: false, enumerable: false, configurable: false })
    return wrapper
  }

  function materialize(wire) {
    var root = requireRecord(wire, 'wire')
    var nodes = requireArray(root.nodes, 'wire nodes')
    var built = new __Array(nodes.length)
    var i
    for (i = 0; i < nodes.length; i++) {
      var node = requireRecord(nodes[i], 'wire node')
      switch (node.t) {
        case 'o': built[i] = {}; break
        case 'a': built[i] = new __Array(requireLength(node.n, 'array length')); break
        case 'f': built[i] = makeWrapper(requireIndex(node.v, undefined, 'function id')); break
        case 'r': {
          var regexp = new __RegExp(requireString(node.s, 'regexp source'), requireString(node.f, 'regexp flags'))
          regexp.lastIndex = requireInteger(node.l, 'regexp lastIndex')
          built[i] = regexp
          break
        }
        case 'd': {
          var rawDate = requireString(node.v, 'date value')
          built[i] = rawDate === 'Invalid' ? new __Date(NaN) : new __Date(rawDate)
          break
        }
        default: throw malformed('unknown node tag ' + __String(node.t))
      }
    }
    for (i = 0; i < nodes.length; i++) {
      var entry = requireRecord(nodes[i], 'wire node')
      if (entry.t === 'o') {
        var objectEntries = requireArray(entry.e, 'object entries')
        for (var j = 0; j < objectEntries.length; j++) {
          var pair = requireArray(objectEntries[j], 'object entry')
          if (pair.length !== 2) throw malformed('object entry is not a pair')
          var key = requireString(pair[0], 'object key')
          __ObjectDefineProperty(built[i], key, {
            value: decodeEnc(pair[1], built),
            writable: true,
            enumerable: true,
            configurable: true,
          })
        }
      } else if (entry.t === 'a') {
        var arrayEntries = requireArray(entry.e, 'array entries')
        var arrayLength = requireLength(entry.n, 'array length')
        for (var k = 0; k < arrayEntries.length; k++) {
          var item = requireArray(arrayEntries[k], 'array entry')
          if (item.length !== 2) throw malformed('array entry is not a pair')
          built[i][requireIndex(item[0], arrayLength, 'array index')] = decodeEnc(item[1], built)
        }
      }
    }
    return decodeEnc(root.root, built)
  }

  function encodeArgs(args) {
    var nodes = []
    var seen = new __Map()
    var fns = []

    function enc(value) {
      if (value === null) return { t: 'null' }
      var type = typeof value
      if (type === 'undefined') return { t: 'u' }
      if (type === 'string') return { t: 's', v: value }
      if (type === 'boolean') return { t: 'b', v: value }
      if (type === 'number') {
        var raw = __NumberIsNaN(value) ? 'NaN' : value === Infinity ? 'Infinity' : value === -Infinity ? '-Infinity' : __ObjectIs(value, -0) ? '-0' : value
        return { t: 'n', v: raw }
      }
      if (type === 'bigint') return { t: 'big', v: value.toString() }
      if (type === 'symbol') throw new __Error('cannot pass a symbol to a host function')
      if (type === 'function') {
        var fnIndex = fns.length
        fns[fnIndex] = value
        nodes[nodes.length] = { t: 'f', v: fnIndex }
        return { t: 'ref', v: nodes.length - 1 }
      }

      var seenIndex = __ReflectApply(__MapGet, seen, [value])
      if (seenIndex !== undefined) return { t: 'ref', v: seenIndex }

      var tag = __ReflectApply(__ObjectToString, value, [])
      if (tag === '[object Promise]') throw new __Error('cannot pass a Promise to a host function')
      if (tag === '[object Map]' || tag === '[object Set]' || tag === '[object WeakMap]' || tag === '[object WeakSet]') {
        throw new __Error('cannot pass a ' + tag.slice(8, -1) + ' to a host function')
      }
      if (/^\\[object (?:Uint|Int|Float|BigUint|BigInt)\\w*Array\\]$/.test(tag) || tag === '[object ArrayBuffer]' || tag === '[object SharedArrayBuffer]' || tag === '[object DataView]') {
        throw new __Error('cannot pass a ' + tag.slice(8, -1) + ' to a host function')
      }

      if (__ArrayIsArray(value)) {
        var arrayIndex = nodes.length
        nodes[arrayIndex] = null
        __ReflectApply(__MapSet, seen, [value, arrayIndex])
        var arrayEntries = []
        var arrayKeys = __ObjectKeys(value)
        for (var ai = 0; ai < arrayKeys.length; ai++) {
          var arrayKey = arrayKeys[ai]
          var numeric = __Number(arrayKey)
          if (__String(numeric) === arrayKey && numeric >= 0 && numeric < value.length) {
            arrayEntries[arrayEntries.length] = [numeric, enc(value[numeric])]
          }
        }
        nodes[arrayIndex] = { t: 'a', n: value.length, e: arrayEntries }
        return { t: 'ref', v: arrayIndex }
      }

      if (tag === '[object RegExp]') {
        var regexpIndex = nodes.length
        nodes[regexpIndex] = null
        __ReflectApply(__MapSet, seen, [value, regexpIndex])
        nodes[regexpIndex] = {
          t: 'r',
          s: __String(value.source),
          f: __String(value.flags),
          l: lastIndexValue(value.lastIndex),
        }
        return { t: 'ref', v: regexpIndex }
      }

      if (tag === '[object Date]') {
        var dateIndex = nodes.length
        nodes[dateIndex] = null
        __ReflectApply(__MapSet, seen, [value, dateIndex])
        var time = __ReflectApply(__Date.prototype.getTime, value, [])
        nodes[dateIndex] = { t: 'd', v: __NumberIsNaN(time) ? 'Invalid' : new __Date(time).toISOString() }
        return { t: 'ref', v: dateIndex }
      }

      var objectIndex = nodes.length
      nodes[objectIndex] = null
      __ReflectApply(__MapSet, seen, [value, objectIndex])
      var objectKeys = __ObjectKeys(value)
      var objectEntries = []
      for (var oi = 0; oi < objectKeys.length; oi++) {
        objectEntries[objectEntries.length] = [objectKeys[oi], enc(value[objectKeys[oi]])]
      }
      nodes[objectIndex] = { t: 'o', e: objectEntries }
      return { t: 'ref', v: objectIndex }
    }

    return { wire: { root: enc(args), nodes: nodes }, fns: fns }
  }

  function reconcile(existing, enc, nodes, memo) {
    var value = requireRecord(enc, 'mutation value')
    if (value.t !== 'ref') return decodeEnc(value, [])
    var nodeIndex = requireIndex(value.v, nodes.length, 'wire reference')
    var node = requireRecord(nodes[nodeIndex], 'wire node')

    if (node.t === 'keep') return existing
    if (node.t === 'f') return typeof existing === 'function' ? existing : makeWrapper(requireIndex(node.v, undefined, 'function id'))

    if (node.t === 'r') {
      if (__ReflectApply(__ObjectToString, existing, []) === '[object RegExp]'
        && existing.source === node.s && existing.flags === node.f) {
        existing.lastIndex = requireInteger(node.l, 'regexp lastIndex')
        return existing
      }
      var regexp = new __RegExp(requireString(node.s, 'regexp source'), requireString(node.f, 'regexp flags'))
      regexp.lastIndex = requireInteger(node.l, 'regexp lastIndex')
      return regexp
    }

    if (node.t === 'd') {
      var rawDate = requireString(node.v, 'date value')
      if (__ReflectApply(__ObjectToString, existing, []) === '[object Date]') {
        __ReflectApply(__Date.prototype.setTime, existing, [rawDate === 'Invalid' ? NaN : new __Date(rawDate).getTime()])
        return existing
      }
      return rawDate === 'Invalid' ? new __Date(NaN) : new __Date(rawDate)
    }

    var memoized = __ReflectApply(__MapGet, memo, [nodeIndex])
    if (memoized !== undefined) return memoized

    if (node.t === 'o') {
      var existingTag = existing !== null && typeof existing === 'object' ? __ReflectApply(__ObjectToString, existing, []) : ''
      var target = existingTag === '[object Object]' ? existing : {}
      __ReflectApply(__MapSet, memo, [nodeIndex, target])
      var entries = requireArray(node.e, 'object entries')
      var previous = __ObjectKeys(target)
      var keep = __ObjectCreate(null)
      for (var pi = 0; pi < previous.length; pi++) keep[previous[pi]] = true
      for (var ei = 0; ei < entries.length; ei++) {
        var pair = requireArray(entries[ei], 'object entry')
        if (pair.length !== 2) throw malformed('object entry is not a pair')
        var key = requireString(pair[0], 'object key')
        delete keep[key]
        __ObjectDefineProperty(target, key, {
          value: reconcile(target[key], pair[1], nodes, memo),
          writable: true,
          enumerable: true,
          configurable: true,
        })
      }
      var stale = __ObjectKeys(keep)
      for (var si = 0; si < stale.length; si++) delete target[stale[si]]
      return target
    }

    if (node.t === 'a') {
      var array = __ArrayIsArray(existing) ? existing : []
      __ReflectApply(__MapSet, memo, [nodeIndex, array])
      var length = requireLength(node.n, 'array length')
      var oldKeys = __ObjectKeys(array)
      array.length = length
      var present = __ObjectCreate(null)
      var arrayEntries = requireArray(node.e, 'array entries')
      for (var ai = 0; ai < arrayEntries.length; ai++) {
        var item = requireArray(arrayEntries[ai], 'array entry')
        if (item.length !== 2) throw malformed('array entry is not a pair')
        var index = requireIndex(item[0], length, 'array index')
        present[index] = true
        array[index] = reconcile(array[index], item[1], nodes, memo)
      }
      for (var oi = 0; oi < oldKeys.length; oi++) {
        if (!hasOwn(present, oldKeys[oi])) delete array[oldKeys[oi]]
      }
      return array
    }

    throw malformed('unknown node tag ' + __String(node.t))
  }

  function reconcileRoot(args, wire) {
    if (wire === undefined || wire === null) return
    var root = requireRecord(wire, 'mutation wire')
    var nodes = requireArray(root.nodes, 'mutation nodes')
    reconcile(args, root.root, nodes, new __Map())
  }

  function settle(token, ok, payloadJson) {
    var key = 't' + token
    var entry = hasOwn(pending, key) ? pending[key] : undefined
    if (entry === undefined) return
    delete pending[key]
    var payload
    try {
      payload = __JSONParse(payloadJson)
    } catch (error) {
      entry.reject(errorFrom(error))
      return
    }
    if (!isRecord(payload)) {
      entry.reject(new __Error('template sandbox bridge returned a malformed payload'))
      return
    }
    try {
      reconcileRoot(entry.args, payload.p)
    } catch (error) {
      entry.reject(errorFrom(error))
      return
    }
    if (ok === 1 && payload.ok === 1) {
      var value
      try {
        value = materialize(payload.v)
      } catch (error) {
        entry.reject(errorFrom(error))
        return
      }
      entry.resolve(value)
      return
    }
    entry.reject(errorFrom(payload.e))
  }

  function invoke(id, args) {
    var encoded
    try {
      encoded = encodeArgs(args)
    } catch (error) {
      throw errorFrom(error)
    }

    var token = ++nextToken
    var key = 't' + token
    var promise = new __Promise(function (resolve, reject) {
      pending[key] = { resolve: resolve, reject: reject, args: args }
    })
    var raw
    try {
      raw = __dispatch(id, __JSONStringify(encoded.wire), encoded.fns, args, token, settle, bridgeThis)
    } catch (error) {
      delete pending[key]
      throw errorFrom(error)
    }

    var reply
    try {
      reply = __JSONParse(raw)
    } catch (error) {
      delete pending[key]
      throw new __Error('template sandbox bridge returned a malformed reply')
    }
    if (!isRecord(reply) || (reply.a !== 0 && reply.a !== 1)) {
      delete pending[key]
      throw new __Error('template sandbox bridge returned a malformed reply')
    }
    if (reply.a === 1) return promise

    delete pending[key]
    try {
      reconcileRoot(args, reply.p)
    } catch (error) {
      throw errorFrom(error)
    }
    if (reply.ok === 1) {
      try {
        return materialize(reply.v)
      } catch (error) {
        throw errorFrom(error)
      }
    }
    throw errorFrom(reply.e)
  }

  function escapeHtml(text) {
    var value = __ReflectApply(__StringReplace, text, [/&/g, '&amp;'])
    value = __ReflectApply(__StringReplace, value, [/</g, '&lt;'])
    value = __ReflectApply(__StringReplace, value, [/>/g, '&gt;'])
    value = __ReflectApply(__StringReplace, value, [/"/g, '&quot;'])
    value = __ReflectApply(__StringReplace, value, [/'/g, '&#39;'])
    return value
  }

  var descriptor = requireRecord(__JSONParse(__descriptorJson), 'descriptor')
  var source = materialize(descriptor)
  var env = __ObjectCreate(null)
  var keys = __ObjectKeys(source)
  for (var i = 0; i < keys.length; i++) {
    __ObjectDefineProperty(env, keys[i], {
      value: source[keys[i]],
      writable: true,
      enumerable: true,
      configurable: true,
    })
  }

  var out = ''
  __ObjectDefineProperty(env, '__out', {
    get: function () { return out },
    set: function (value) { out = value === null || value === undefined ? '' : __String(value) },
    enumerable: false,
    configurable: true,
  })
  __ObjectDefineProperty(env, '__append', {
    value: function (value) { out += value === null || value === undefined ? '' : __String(value) },
    enumerable: false,
    configurable: true,
    writable: true,
  })
  __ObjectDefineProperty(env, '__escape', {
    value: escapeHtml,
    enumerable: false,
    configurable: true,
    writable: true,
  })
  __ObjectDefineProperty(env, 'print', {
    value: function () {
      for (var i = 0; i < arguments.length; i++) {
        if (i > 0) out += ' '
        var value = arguments[i]
        out += value === null || value === undefined ? '' : __String(value)
      }
    },
    enumerable: false,
    configurable: true,
    writable: true,
  })
  __ObjectDefineProperty(env, 'await', {
    value: function (value) {
      if (value !== null && typeof value === 'object' && typeof value.then === 'function') {
        throw new __Error('async template expression used inside a synchronous callback is not supported')
      }
      return value
    },
    enumerable: false,
    configurable: true,
    writable: true,
  })

  return env
})`
export { BOOTSTRAP_SOURCE }
