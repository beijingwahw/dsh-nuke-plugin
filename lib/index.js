import { createRequire } from "node:module";
import * as fs from "fs";
import * as path from "path";
import { Service } from "@deepseek-ai/cordis";
import { AnonymousEntries, NamedEntries, ScopedLayers, scopeOf, scopeTarget } from "@deepseek-ai/dsh-scope";
import { CallId, HarnessError, assertNever, deepFreeze } from "@deepseek-ai/dsh-llm";
import { isJsonValue, snapshotJsonValue } from "@deepseek-ai/dsh-session";
import * as os from "os";
import * as crypto from "crypto";
import { execFile, spawnSync } from "child_process";
//#region \0rolldown/runtime.js
var __commonJSMin = (cb, mod) => () => (mod || (cb((mod = { exports: {} }).exports, mod), cb = null), mod.exports);
var __require = /* #__PURE__ */ (() => createRequire(import.meta.url))();
//#endregion
//#region node_modules/@deepseek-ai/cosmokit/lib/index.js
/** Return true when a value is `null` or `undefined`. */
function isNullable(value) {
	return value === null || value === void 0;
}
/** Return true for non-array object values. */
function isPlainObject(data) {
	return data && typeof data === "object" && !Array.isArray(data);
}
/** Filter object entries and return a new object. */
function filterKeys(object, filter) {
	return Object.fromEntries(Object.entries(object).filter(([key, value]) => filter(key, value)));
}
/** Map object values while preserving the original key set. */
function mapValues(object, transform) {
	return Object.fromEntries(Object.entries(object).map(([key, value]) => [key, transform(value, key)]));
}
/** Pick selected keys from an object, optionally including `undefined` values. */
function pick(source, keys, forced) {
	if (!keys) return { ...source };
	const result = {};
	for (const key of keys) if (forced || source[key] !== void 0) result[key] = source[key];
	return result;
}
/** Test values using `instanceof` with a `toStringTag` fallback. */
function is(type, value) {
	if (arguments.length === 1) return (value) => is(type, value);
	return type in globalThis && value instanceof globalThis[type] || Object.prototype.toString.call(value).slice(8, -1) === type;
}
function isArrayBufferLike(value) {
	return is("ArrayBuffer", value) || is("SharedArrayBuffer", value);
}
function isArrayBufferSource(value) {
	return isArrayBufferLike(value) || ArrayBuffer.isView(value);
}
/** Binary source detection and base64/hex conversion helpers. */
var Binary;
(function(Binary) {
	Binary.is = isArrayBufferLike;
	Binary.isSource = isArrayBufferSource;
	function fromSource(source) {
		if (ArrayBuffer.isView(source)) return source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength);
		else return source;
	}
	Binary.fromSource = fromSource;
	function toBase64(source) {
		source = fromSource(source);
		if (typeof Buffer !== "undefined") return Buffer.from(source).toString("base64");
		let binary = "";
		const bytes = new Uint8Array(source);
		for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
		return btoa(binary);
	}
	Binary.toBase64 = toBase64;
	function fromBase64(source) {
		if (typeof Buffer !== "undefined") return fromSource(Buffer.from(source, "base64"));
		return Uint8Array.from(atob(source), (c) => c.charCodeAt(0));
	}
	Binary.fromBase64 = fromBase64;
	function toHex(source) {
		source = fromSource(source);
		if (typeof Buffer !== "undefined") return Buffer.from(source).toString("hex");
		return Array.from(new Uint8Array(source), (byte) => byte.toString(16).padStart(2, "0")).join("");
	}
	Binary.toHex = toHex;
	function fromHex(source) {
		if (typeof Buffer !== "undefined") return fromSource(Buffer.from(source, "hex"));
		const hex = source.length % 2 === 0 ? source : source.slice(0, source.length - 1);
		const buffer = [];
		for (let i = 0; i < hex.length; i += 2) buffer.push(parseInt(`${hex[i]}${hex[i + 1]}`, 16));
		return Uint8Array.from(buffer).buffer;
	}
	Binary.fromHex = fromHex;
})(Binary || (Binary = {}));
Binary.fromBase64;
Binary.toBase64;
Binary.fromHex;
Binary.toHex;
/** Deep-clone common JavaScript values while preserving prototypes and cycles. */
function clone(source, refs = /* @__PURE__ */ new Map()) {
	if (!source || typeof source !== "object") return source;
	if (is("Date", source)) return new Date(source.valueOf());
	if (is("RegExp", source)) return new RegExp(source.source, source.flags);
	if (isArrayBufferLike(source)) return source.slice(0);
	if (ArrayBuffer.isView(source)) return source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength);
	const cached = refs.get(source);
	if (cached) return cached;
	if (Array.isArray(source)) {
		const result = [];
		refs.set(source, result);
		source.forEach((value, index) => {
			result[index] = Reflect.apply(clone, null, [value, refs]);
		});
		return result;
	}
	const result = Object.create(Object.getPrototypeOf(source));
	refs.set(source, result);
	for (const key of Reflect.ownKeys(source)) {
		const descriptor = { ...Reflect.getOwnPropertyDescriptor(source, key) };
		if ("value" in descriptor) descriptor.value = Reflect.apply(clone, null, [descriptor.value, refs]);
		Reflect.defineProperty(result, key, descriptor);
	}
	return result;
}
/** Deeply compare arrays, dates, regexps, buffers, and plain object fields. */
function deepEqual(a, b, strict) {
	if (a === b) return true;
	if (!strict && isNullable(a) && isNullable(b)) return true;
	if (typeof a !== typeof b) return false;
	if (typeof a !== "object") return false;
	if (!a || !b) return false;
	function check(test, then) {
		return test(a) ? test(b) ? then(a, b) : false : test(b) ? false : void 0;
	}
	return check(Array.isArray, (a, b) => a.length === b.length && a.every((item, index) => deepEqual(item, b[index]))) ?? check(is("Date"), (a, b) => a.valueOf() === b.valueOf()) ?? check(is("RegExp"), (a, b) => a.source === b.source && a.flags === b.flags) ?? check(isArrayBufferLike, (a, b) => {
		if (a.byteLength !== b.byteLength) return false;
		const viewA = new Uint8Array(a);
		const viewB = new Uint8Array(b);
		for (let i = 0; i < viewA.length; i++) if (viewA[i] !== viewB[i]) return false;
		return true;
	}) ?? Object.keys({
		...a,
		...b
	}).every((key) => deepEqual(a[key], b[key], strict));
}
/** Time constants plus parsing and formatting helpers. */
var Time;
(function(Time) {
	Time.millisecond = 1;
	Time.second = 1e3;
	Time.minute = Time.second * 60;
	Time.hour = Time.minute * 60;
	Time.day = Time.hour * 24;
	Time.week = Time.day * 7;
	let timezoneOffset = (/* @__PURE__ */ new Date()).getTimezoneOffset();
	function setTimezoneOffset(offset) {
		timezoneOffset = offset;
	}
	Time.setTimezoneOffset = setTimezoneOffset;
	function getTimezoneOffset() {
		return timezoneOffset;
	}
	Time.getTimezoneOffset = getTimezoneOffset;
	function getDateNumber(date = /* @__PURE__ */ new Date(), offset) {
		if (typeof date === "number") date = new Date(date);
		if (offset === void 0) offset = timezoneOffset;
		return Math.floor((date.valueOf() / Time.minute - offset) / 1440);
	}
	Time.getDateNumber = getDateNumber;
	function fromDateNumber(value, offset) {
		const date = new Date(value * Time.day);
		if (offset === void 0) offset = timezoneOffset;
		return new Date(+date + offset * Time.minute);
	}
	Time.fromDateNumber = fromDateNumber;
	const numeric = /\d+(?:\.\d+)?/.source;
	const timeRegExp = new RegExp(`^${[
		"w(?:eek(?:s)?)?",
		"d(?:ay(?:s)?)?",
		"h(?:our(?:s)?)?",
		"m(?:in(?:ute)?(?:s)?)?",
		"s(?:ec(?:ond)?(?:s)?)?"
	].map((unit) => `(${numeric}${unit})?`).join("")}$`);
	function parseTime(source) {
		const capture = timeRegExp.exec(source);
		if (!capture) return 0;
		return (parseFloat(capture[1]) * Time.week || 0) + (parseFloat(capture[2]) * Time.day || 0) + (parseFloat(capture[3]) * Time.hour || 0) + (parseFloat(capture[4]) * Time.minute || 0) + (parseFloat(capture[5]) * Time.second || 0);
	}
	Time.parseTime = parseTime;
	function parseDate(date) {
		const parsed = parseTime(date);
		if (parsed) date = Date.now() + parsed;
		else if (/^\d{1,2}(:\d{1,2}){1,2}$/.test(date)) date = `${(/* @__PURE__ */ new Date()).toLocaleDateString()}-${date}`;
		else if (/^\d{1,2}-\d{1,2}-\d{1,2}(:\d{1,2}){1,2}$/.test(date)) date = `${(/* @__PURE__ */ new Date()).getFullYear()}-${date}`;
		return date ? new Date(date) : /* @__PURE__ */ new Date();
	}
	Time.parseDate = parseDate;
	function format(ms) {
		const abs = Math.abs(ms);
		if (abs >= Time.day - Time.hour / 2) return Math.round(ms / Time.day) + "d";
		else if (abs >= Time.hour - Time.minute / 2) return Math.round(ms / Time.hour) + "h";
		else if (abs >= Time.minute - Time.second / 2) return Math.round(ms / Time.minute) + "m";
		else if (abs >= Time.second) return Math.round(ms / Time.second) + "s";
		return ms + "ms";
	}
	Time.format = format;
	function toDigits(source, length = 2) {
		return source.toString().padStart(length, "0");
	}
	Time.toDigits = toDigits;
	function template(template, time = /* @__PURE__ */ new Date()) {
		return template.replace("yyyy", time.getFullYear().toString()).replace("yy", time.getFullYear().toString().slice(2)).replace("MM", toDigits(time.getMonth() + 1)).replace("dd", toDigits(time.getDate())).replace("hh", toDigits(time.getHours())).replace("mm", toDigits(time.getMinutes())).replace("ss", toDigits(time.getSeconds())).replace("SSS", toDigits(time.getMilliseconds(), 3));
	}
	Time.template = template;
})(Time || (Time = {}));
//#endregion
//#region node_modules/@deepseek-ai/schemastery/lib/index.mjs
const kSchema = Symbol.for("schemastery");
const kValidationError = Symbol.for("ValidationError");
globalThis.__schemastery_index__ ??= 0;
globalThis.__schemastery_refs__ = void 0;
var ValidationError = class extends TypeError {
	options;
	name = "ValidationError";
	constructor(message, options) {
		let prefix = "$";
		for (const segment of options.path || []) if (typeof segment === "string") prefix += "." + segment;
		else if (typeof segment === "number") prefix += "[" + segment + "]";
		else if (typeof segment === "symbol") prefix += `[Symbol(${segment.toString()})]`;
		if (prefix.startsWith(".")) prefix = prefix.slice(1);
		super((prefix === "$" ? "" : `${prefix} `) + message);
		this.options = options;
	}
	static is(error) {
		return !!error?.[kValidationError];
	}
};
Object.defineProperty(ValidationError.prototype, kValidationError, { value: true });
const Schema = function(options) {
	const schema = function(data, options = {}) {
		return Schema.resolve(data, schema, options)[0];
	};
	if (options.refs) {
		const refs = mapValues(options.refs, (options) => new Schema(options));
		const getRef = (uid) => refs[uid];
		for (const key in refs) {
			const options = refs[key];
			options.sKey = getRef(options.sKey);
			options.inner = getRef(options.inner);
			options.list = options.list && options.list.map(getRef);
			options.dict = options.dict && mapValues(options.dict, getRef);
		}
		return refs[options.uid];
	}
	Object.assign(schema, options);
	if (typeof schema.callback === "string") try {
		schema.callback = new Function("return " + schema.callback)();
	} catch {}
	Object.defineProperty(schema, "uid", { value: globalThis.__schemastery_index__++ });
	Object.setPrototypeOf(schema, Schema.prototype);
	schema.meta ||= {};
	schema.toString = schema.toString.bind(schema);
	return schema;
};
Schema.prototype = Object.create(Function.prototype);
Schema.prototype[kSchema] = true;
Object.defineProperty(Schema.prototype, "~standard", { get() {
	return {
		version: 1,
		vendor: "schemastery",
		validate: (value) => {
			try {
				return { value: Schema.resolve(value, this, {})[0] };
			} catch (error) {
				if (ValidationError.is(error)) return { issues: [{
					message: error.message,
					path: error.options.path
				}] };
				throw error;
			}
		}
	};
} });
Schema.ValidationError = ValidationError;
Schema.prototype.toJSON = function toJSON() {
	if (globalThis.__schemastery_refs__) {
		globalThis.__schemastery_refs__[this.uid] ??= JSON.parse(JSON.stringify({ ...this }));
		return this.uid;
	}
	globalThis.__schemastery_refs__ = { [this.uid]: { ...this } };
	globalThis.__schemastery_refs__[this.uid] = JSON.parse(JSON.stringify({ ...this }));
	const result = {
		uid: this.uid,
		refs: globalThis.__schemastery_refs__
	};
	globalThis.__schemastery_refs__ = void 0;
	return result;
};
Schema.prototype.set = function set(key, value) {
	this.dict[key] = value;
	return this;
};
Schema.prototype.push = function push(value) {
	this.list.push(value);
	return this;
};
function mergeDesc(original, messages) {
	const result = typeof original === "string" ? { "": original } : { ...original };
	for (const locale in messages) {
		const value = messages[locale];
		if (value?.$description || value?.$desc) result[locale] = value.$description || value.$desc;
		else if (typeof value === "string") result[locale] = value;
	}
	return result;
}
function getInner(value) {
	return value?.$value ?? value?.$inner;
}
function extractKeys(data) {
	return filterKeys(data ?? {}, (key) => !key.startsWith("$"));
}
Schema.prototype.i18n = function i18n(messages) {
	const schema = Schema(this);
	const desc = mergeDesc(schema.meta.description, messages);
	if (Object.keys(desc).length) schema.meta.description = desc;
	if (schema.dict) schema.dict = mapValues(schema.dict, (inner, key) => {
		return inner.i18n(mapValues(messages, (data) => getInner(data)?.[key] ?? data?.[key]));
	});
	if (schema.list) schema.list = schema.list.map((inner, index) => {
		return inner.i18n(mapValues(messages, (data = {}) => {
			if (Array.isArray(getInner(data))) return getInner(data)[index];
			if (Array.isArray(data)) return data[index];
			return extractKeys(data);
		}));
	});
	if (schema.inner) schema.inner = schema.inner.i18n(mapValues(messages, (data) => {
		if (getInner(data)) return getInner(data);
		return extractKeys(data);
	}));
	if (schema.sKey) schema.sKey = schema.sKey.i18n(mapValues(messages, (data) => data?.$key));
	return schema;
};
Schema.prototype.extra = function extra(key, value) {
	const schema = Schema(this);
	schema.meta = {
		...schema.meta,
		[key]: value
	};
	return schema;
};
for (const key of [
	"required",
	"disabled",
	"collapse",
	"hidden",
	"loose"
]) Object.assign(Schema.prototype, { [key](value = true) {
	const schema = Schema(this);
	schema.meta = {
		...schema.meta,
		[key]: value
	};
	return schema;
} });
Schema.prototype.deprecated = function deprecated() {
	const schema = Schema(this);
	schema.meta.badges ||= [];
	schema.meta.badges.push({
		text: "deprecated",
		type: "danger"
	});
	return schema;
};
Schema.prototype.experimental = function experimental() {
	const schema = Schema(this);
	schema.meta.badges ||= [];
	schema.meta.badges.push({
		text: "experimental",
		type: "warning"
	});
	return schema;
};
Schema.prototype.pattern = function pattern(regexp) {
	const schema = Schema(this);
	const pattern = pick(regexp, ["source", "flags"]);
	schema.meta = {
		...schema.meta,
		pattern
	};
	return schema;
};
Schema.prototype.simplify = function simplify(value) {
	if (deepEqual(value, this.meta.default, this.type === "dict")) return null;
	if (isNullable(value)) return value;
	if (this.type === "object" || this.type === "dict") {
		const result = {};
		for (const key in value) {
			const item = (this.type === "object" ? this.dict[key] : this.inner)?.simplify(value[key]);
			if (this.type === "dict" || !isNullable(item)) result[key] = item;
		}
		if (deepEqual(result, this.meta.default, this.type === "dict")) return null;
		return result;
	} else if (this.type === "array" || this.type === "tuple") {
		const result = [];
		value.forEach((value, index) => {
			const schema = this.type === "array" ? this.inner : this.list[index];
			const item = schema ? schema.simplify(value) : value;
			result.push(item);
		});
		return result;
	} else if (this.type === "intersect") {
		const result = {};
		for (const item of this.list) Object.assign(result, item.simplify(value));
		return result;
	} else if (this.type === "union") for (const schema of this.list) try {
		Schema.resolve(value, schema, {});
		return schema.simplify(value);
	} catch {}
	return value;
};
Schema.prototype.toString = function toString(inline) {
	return formatters[this.type]?.(this, inline) ?? `Schema<${this.type}>`;
};
Schema.prototype.role = function role(role, extra) {
	const schema = Schema(this);
	schema.meta = {
		...schema.meta,
		role,
		extra
	};
	return schema;
};
for (const key of [
	"default",
	"link",
	"comment",
	"description",
	"max",
	"min",
	"step"
]) Object.assign(Schema.prototype, { [key](value) {
	const schema = Schema(this);
	schema.meta = {
		...schema.meta,
		[key]: value
	};
	return schema;
} });
const resolvers = {};
Schema.extend = function extend(type, resolve) {
	resolvers[type] = resolve;
};
Schema.resolve = function resolve(data, schema, options = {}, strict = false) {
	if (!schema) return [data];
	if (options.ignore?.(data, schema)) return [data];
	if (isNullable(data) && schema.type !== "lazy") {
		if (schema.meta.required) throw new ValidationError(`missing required value`, options);
		let current = schema;
		let fallback = schema.meta.default;
		while (current?.type === "intersect" && isNullable(fallback)) {
			current = current.list[0];
			fallback = current?.meta.default;
		}
		if (isNullable(fallback)) return [data];
		data = clone(fallback);
	}
	const callback = resolvers[schema.type];
	if (!callback) throw new ValidationError(`unsupported type "${schema.type}"`, options);
	try {
		return callback(data, schema, options, strict);
	} catch (error) {
		if (!schema.meta.loose) throw error;
		return [schema.meta.default];
	}
};
Schema.from = function from(source) {
	if (isNullable(source)) return Schema.any();
	else if ([
		"string",
		"number",
		"boolean"
	].includes(typeof source)) return Schema.const(source).required();
	else if (source[kSchema]) return source;
	else if (typeof source === "function") switch (source) {
		case String: return Schema.string().required();
		case Number: return Schema.number().required();
		case Boolean: return Schema.boolean().required();
		case Function: return Schema.function().required();
		default: return Schema.is(source).required();
	}
	else throw new TypeError(`cannot infer schema from ${source}`);
};
Schema.lazy = function lazy(builder) {
	const toJSON = () => {
		if (!schema.inner[kSchema]) {
			schema.inner = schema.builder();
			schema.inner.meta = {
				...schema.meta,
				...schema.inner.meta
			};
		}
		return schema.inner.toJSON();
	};
	const schema = new Schema({
		type: "lazy",
		builder,
		inner: { toJSON }
	});
	return schema;
};
Schema.natural = function natural() {
	return Schema.number().step(1).min(0);
};
Schema.percent = function percent() {
	return Schema.number().step(.01).min(0).max(1).role("slider");
};
Schema.date = function date() {
	return Schema.union([Schema.is(Date), Schema.transform(Schema.string().role("datetime"), (value, options) => {
		const date = new Date(value);
		if (isNaN(+date)) throw new ValidationError(`invalid date "${value}"`, options);
		return date;
	}, true)]);
};
Schema.regExp = function regExp(flag = "") {
	return Schema.union([Schema.is(RegExp), Schema.transform(Schema.string().role("regexp", { flag }), (value, options) => {
		try {
			return new RegExp(value, flag);
		} catch (e) {
			throw new ValidationError(e.message, options);
		}
	}, true)]);
};
Schema.arrayBuffer = function arrayBuffer(encoding) {
	return Schema.union([
		Schema.is(ArrayBuffer),
		Schema.is(SharedArrayBuffer),
		Schema.transform(Schema.any(), (value, options) => {
			if (Binary.isSource(value)) return Binary.fromSource(value);
			throw new ValidationError(`expected ArrayBufferSource but got ${value}`, options);
		}, true),
		...encoding ? [Schema.transform(Schema.string(), (value, options) => {
			try {
				return encoding === "base64" ? Binary.fromBase64(value) : Binary.fromHex(value);
			} catch (e) {
				throw new ValidationError(e.message, options);
			}
		}, true)] : []
	]);
};
Schema.extend("lazy", (data, schema, options, strict) => {
	if (!schema.inner[kSchema]) {
		schema.inner = schema.builder();
		schema.inner.meta = {
			...schema.meta,
			...schema.inner.meta
		};
	}
	return Schema.resolve(data, schema.inner, options, strict);
});
Schema.extend("any", (data) => {
	return [data];
});
Schema.extend("never", (data, _, options) => {
	throw new ValidationError(`expected nullable but got ${data}`, options);
});
Schema.extend("const", (data, { value }, options) => {
	if (deepEqual(data, value)) return [value];
	throw new ValidationError(`expected ${value} but got ${data}`, options);
});
function checkWithinRange(data, meta, description, options, skipMin = false) {
	const { max = Infinity, min = -Infinity } = meta;
	if (data > max) throw new ValidationError(`expected ${description} <= ${max} but got ${data}`, options);
	if (data < min && !skipMin) throw new ValidationError(`expected ${description} >= ${min} but got ${data}`, options);
}
Schema.extend("string", (data, { meta }, options) => {
	if (typeof data !== "string") throw new ValidationError(`expected string but got ${data}`, options);
	if (meta.pattern) {
		const regexp = new RegExp(meta.pattern.source, meta.pattern.flags);
		if (!regexp.test(data)) throw new ValidationError(`expect string to match regexp ${regexp}`, options);
	}
	checkWithinRange(data.length, meta, "string length", options);
	return [data];
});
function decimalShift(data, digits) {
	const str = data.toString();
	if (str.includes("e")) return data * Math.pow(10, digits);
	const index = str.indexOf(".");
	if (index === -1) return data * Math.pow(10, digits);
	const frac = str.slice(index + 1);
	const integer = str.slice(0, index);
	if (frac.length <= digits) return +(integer + frac.padEnd(digits, "0"));
	return +(integer + frac.slice(0, digits) + "." + frac.slice(digits));
}
function isMultipleOf(data, min, step) {
	step = Math.abs(step);
	if (!/^\d+\.\d+$/.test(step.toString())) return (data - min) % step === 0;
	const index = step.toString().indexOf(".");
	const digits = step.toString().slice(index + 1).length;
	return Math.abs(decimalShift(data, digits) - decimalShift(min, digits)) % decimalShift(step, digits) === 0;
}
Schema.extend("number", (data, { meta }, options) => {
	if (typeof data !== "number") throw new ValidationError(`expected number but got ${data}`, options);
	checkWithinRange(data, meta, "number", options);
	const { step } = meta;
	if (step && !isMultipleOf(data, meta.min ?? 0, step)) throw new ValidationError(`expected number multiple of ${step} but got ${data}`, options);
	return [data];
});
Schema.extend("boolean", (data, _, options) => {
	if (typeof data === "boolean") return [data];
	throw new ValidationError(`expected boolean but got ${data}`, options);
});
Schema.extend("bitset", (data, { bits, meta }, options) => {
	let value = 0, keys = [];
	if (typeof data === "number") {
		value = data;
		for (const key in bits) if (data & bits[key]) keys.push(key);
	} else if (Array.isArray(data)) {
		keys = data;
		for (const key of keys) {
			if (typeof key !== "string") throw new ValidationError(`expected string but got ${key}`, options);
			if (key in bits) value |= bits[key];
		}
	} else throw new ValidationError(`expected number or array but got ${data}`, options);
	if (value === meta.default) return [value];
	return [value, keys];
});
Schema.extend("function", (data, _, options) => {
	if (typeof data === "function") return [data];
	throw new ValidationError(`expected function but got ${data}`, options);
});
Schema.extend("is", (data, { constructor }, options) => {
	if (typeof constructor === "function") {
		if (data instanceof constructor) return [data];
		throw new ValidationError(`expected ${constructor.name} but got ${data}`, options);
	} else {
		if (isNullable(data)) throw new ValidationError(`expected ${constructor} but got ${data}`, options);
		let prototype = Object.getPrototypeOf(data);
		while (prototype) {
			if (prototype.constructor?.name === constructor) return [data];
			prototype = Object.getPrototypeOf(prototype);
		}
		throw new ValidationError(`expected ${constructor} but got ${data}`, options);
	}
});
function property(data, key, schema, options) {
	try {
		const [value, adapted] = Schema.resolve(data[key], schema, {
			...options,
			path: [...options.path || [], key]
		});
		if (adapted !== void 0) data[key] = adapted;
		return value;
	} catch (e) {
		if (!options?.autofix) throw e;
		delete data[key];
		return schema.meta.default;
	}
}
Schema.extend("array", (data, { inner, meta }, options) => {
	if (!Array.isArray(data)) throw new ValidationError(`expected array but got ${data}`, options);
	checkWithinRange(data.length, meta, "array length", options, !isNullable(inner.meta.default));
	return [data.map((_, index) => property(data, index, inner, options))];
});
Schema.extend("dict", (data, { inner, sKey }, options, strict) => {
	if (!isPlainObject(data)) throw new ValidationError(`expected object but got ${data}`, options);
	const result = {};
	for (const key in data) {
		let rKey;
		try {
			rKey = Schema.resolve(key, sKey, options)[0];
		} catch (error) {
			if (strict) continue;
			throw error;
		}
		result[rKey] = property(data, key, inner, options);
		data[rKey] = data[key];
		if (key !== rKey) delete data[key];
	}
	return [result];
});
Schema.extend("tuple", (data, { list }, options, strict) => {
	if (!Array.isArray(data)) throw new ValidationError(`expected array but got ${data}`, options);
	const result = list.map((inner, index) => property(data, index, inner, options));
	if (strict) return [result];
	result.push(...data.slice(list.length));
	return [result];
});
function merge(result, data) {
	for (const key in data) {
		if (key in result) continue;
		result[key] = data[key];
	}
}
Schema.extend("object", (data, { dict }, options, strict) => {
	if (!isPlainObject(data)) throw new ValidationError(`expected object but got ${data}`, options);
	const result = {};
	for (const key in dict) {
		const value = property(data, key, dict[key], options);
		if (!isNullable(value) || key in data) result[key] = value;
	}
	if (!strict) merge(result, data);
	return [result];
});
Schema.extend("union", (data, { list, toString }, options, strict) => {
	const messages = [];
	for (const inner of list) try {
		return Schema.resolve(data, inner, options, strict);
	} catch (error) {
		messages.push(error);
	}
	throw new ValidationError(`expected ${toString()} but got ${JSON.stringify(data)}`, options);
});
Schema.extend("intersect", (data, { list, toString }, options, strict) => {
	if (!list.length) return [data];
	let result;
	for (const inner of list) {
		const value = Schema.resolve(data, inner, options, true)[0];
		if (isNullable(value)) continue;
		if (isNullable(result)) result = value;
		else if (typeof result !== typeof value) throw new ValidationError(`expected ${toString()} but got ${JSON.stringify(data)}`, options);
		else if (typeof value === "object") merge(result ??= {}, value);
		else if (result !== value) throw new ValidationError(`expected ${toString()} but got ${JSON.stringify(data)}`, options);
	}
	if (!strict && isPlainObject(data)) merge(result, data);
	return [result];
});
Schema.extend("transform", (data, { inner, callback, preserve }, options) => {
	const [result, adapted = data] = Schema.resolve(data, inner, options, true);
	if (preserve) return [callback(result)];
	else return [callback(result), callback(adapted)];
});
const formatters = {};
function defineMethod(name, keys, format) {
	formatters[name] = format;
	Object.assign(Schema, { [name](...args) {
		const schema = new Schema({ type: name });
		keys.forEach((key, index) => {
			switch (key) {
				case "sKey":
					schema.sKey = args[index] ?? Schema.string();
					break;
				case "inner":
					schema.inner = Schema.from(args[index]);
					break;
				case "list":
					schema.list = args[index].map(Schema.from);
					break;
				case "dict":
					schema.dict = mapValues(args[index], Schema.from);
					break;
				case "bits":
					schema.bits = {};
					for (const key in args[index]) {
						if (typeof args[index][key] !== "number") continue;
						schema.bits[key] = args[index][key];
					}
					break;
				case "callback": {
					const callback = schema.callback = args[index];
					callback["toJSON"] ||= () => callback.toString();
					break;
				}
				case "constructor": {
					const constructor = schema.constructor = args[index];
					if (typeof constructor === "function") constructor["toJSON"] ||= () => constructor["name"];
					break;
				}
				default: schema[key] = args[index];
			}
		});
		if (name === "object" || name === "dict") schema.meta.default = {};
		else if (name === "array" || name === "tuple") schema.meta.default = [];
		else if (name === "bitset") schema.meta.default = 0;
		return schema;
	} });
}
defineMethod("is", ["constructor"], ({ constructor }) => {
	if (typeof constructor === "function") return constructor.name;
	else return constructor;
});
defineMethod("any", [], () => "any");
defineMethod("never", [], () => "never");
defineMethod("const", ["value"], ({ value }) => typeof value === "string" ? JSON.stringify(value) : value);
defineMethod("string", [], () => "string");
defineMethod("number", [], () => "number");
defineMethod("boolean", [], () => "boolean");
defineMethod("bitset", ["bits"], () => "bitset");
defineMethod("function", [], () => "function");
defineMethod("array", ["inner"], ({ inner }) => `${inner.toString(true)}[]`);
defineMethod("dict", ["inner", "sKey"], ({ inner, sKey }) => `{ [key: ${sKey.toString()}]: ${inner.toString()} }`);
defineMethod("tuple", ["list"], ({ list }) => `[${list.map((inner) => inner.toString()).join(", ")}]`);
defineMethod("object", ["dict"], ({ dict }) => {
	if (Object.keys(dict).length === 0) return "{}";
	return `{ ${Object.entries(dict).map(([key, inner]) => {
		return `${key}${inner.meta.required ? "" : "?"}: ${inner.toString()}`;
	}).join(", ")} }`;
});
defineMethod("union", ["list"], ({ list }, inline) => {
	const result = list.map(({ toString: format }) => format()).join(" | ");
	return inline ? `(${result})` : result;
});
defineMethod("intersect", ["list"], ({ list }) => {
	return `${list.map((inner) => inner.toString(true)).join(" & ")}`;
});
defineMethod("transform", [
	"inner",
	"callback",
	"preserve"
], ({ inner }, isInner) => inner.toString(isInner));
//#endregion
//#region node_modules/@deepseek-ai/dsh-tools/lib/index.js
/**
* Enforced JSON Schema subset shared by tool outputs, generated Code Mode
* types, subagents, and workflows. The subset accepts any JSON root, an
* annotation-only schema for unconstrained JSON, one scalar `type`, object
* `properties`/`required`/boolean `additionalProperties`, array `items`,
* type-correct scalar `enum`/`const`, and exact-one `oneOf`.
*
* Unsupported or misplaced keywords reject rather than being accepted without
* enforcement. Consumers that require an object root apply
* {@link assertObjectJsonSchema} before accepting input.
* @module dsh-tools/json-schema
*/
/**
* Thrown when a raw schema falls outside the enforced subset. `violations`
* lists every offending path instead of stopping at the first author error.
*/
var JsonSchemaError = class extends HarnessError {
	/** Individual schema violations in walk order. */
	violations;
	constructor(violations) {
		super(`unsupported JSON schema: ${violations.join("; ")}`, "UNSUPPORTED_SCHEMA");
		this.name = "JsonSchemaError";
		this.violations = violations;
	}
};
const CONSTRAINT_KEYWORDS = /* @__PURE__ */ new Set([
	"type",
	"oneOf",
	"properties",
	"required",
	"additionalProperties",
	"items",
	"enum",
	"const"
]);
const ANNOTATION_KEYWORDS = /* @__PURE__ */ new Set([
	"description",
	"title",
	"default",
	"examples"
]);
const SCHEMA_TYPES = [
	"object",
	"array",
	"string",
	"number",
	"integer",
	"boolean",
	"null"
];
/** Whether a realm-owned intrinsic prototype is backed by its native constructor. */
function hasIntrinsicConstructor(prototype, name) {
	const constructor = Object.getOwnPropertyDescriptor(prototype, "constructor")?.value;
	if (typeof constructor !== "function") return false;
	try {
		return constructor.name === name && constructor.prototype === prototype && Function.prototype.toString.call(constructor) === `function ${name}() { [native code] }`;
	} catch {
		return false;
	}
}
/** Whether a candidate is one realm's intrinsic `Object.prototype`. */
function isIntrinsicObjectPrototype(value) {
	return Object.getPrototypeOf(value) === null && hasIntrinsicConstructor(value, "Object");
}
/**
* Test for a realm-agnostic plain JSON record without accepting arrays or
* exotic objects.
* @param value - candidate record from any JavaScript realm.
* @returns Whether the value has a plain-object prototype chain.
*/
function isPlainJsonRecord(value) {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	try {
		const prototype = Object.getPrototypeOf(value);
		return prototype === null || typeof prototype === "object" && isIntrinsicObjectPrototype(prototype);
	} catch {
		return false;
	}
}
/** Whether an array uses one realm's intrinsic `Array.prototype`. */
function hasPlainArrayPrototype(value) {
	const prototype = Object.getPrototypeOf(value);
	if (!Array.isArray(prototype) || !hasIntrinsicConstructor(prototype, "Array")) return false;
	const objectPrototype = Object.getPrototypeOf(prototype);
	return typeof objectPrototype === "object" && objectPrototype !== null && isIntrinsicObjectPrototype(objectPrototype);
}
/** Return whether a record contains only own enumerable string keys. */
function hasOnlyEnumerableStringKeys(value) {
	try {
		return Reflect.ownKeys(value).every((key) => typeof key === "string" && Object.prototype.propertyIsEnumerable.call(value, key));
	} catch {
		return false;
	}
}
/**
* Test for an ordinary schema record whose keys survive JSON projection.
* @param value - candidate record from any JavaScript realm.
* @returns Whether the record has an intrinsic prototype and only own enumerable string keys.
*/
function isJsonSchemaRecord(value) {
	return isPlainJsonRecord(value) && hasOnlyEnumerableStringKeys(value);
}
/**
* Test for a dense ordinary array with no JSON-invisible decorations.
* @param value - candidate array from any JavaScript realm.
* @returns Whether the array is intrinsic, dense, and undecorated.
*/
function isPlainJsonArray(value) {
	if (!Array.isArray(value)) return false;
	try {
		if (!hasPlainArrayPrototype(value) || Reflect.ownKeys(value).length !== value.length + 1) return false;
		for (let index = 0; index < value.length; index++) if (!Object.hasOwn(value, index)) return false;
		return true;
	} catch {
		return false;
	}
}
/** Lossless finite JSON number, excluding negative zero. */
function isJsonNumber(value) {
	return typeof value === "number" && Number.isFinite(value) && !Object.is(value, -0);
}
/** Whether a scalar is valid for one declared schema type. */
function scalarMatches(type, value) {
	switch (type) {
		case "string": return typeof value === "string";
		case "number": return isJsonNumber(value);
		case "integer": return isJsonNumber(value) && Number.isInteger(value);
		case "boolean": return typeof value === "boolean";
		case "null": return value === null;
		/* v8 ignore next -- JsonSchemaScalarType is closed; this retains compile-time exhaustiveness. */
		default: return assertNever(type, "JsonSchemaType");
	}
}
/** Keywords that are invalid beside `oneOf`. */
const ONE_OF_SIBLING_KEYWORDS = [
	"properties",
	"required",
	"additionalProperties",
	"items",
	"enum",
	"const"
];
/** Validate object-only fields after its property schemas have been visited. */
function checkObjectSchemaTail(node, path, properties, violations) {
	const hasRequired = Object.hasOwn(node, "required");
	const required = hasRequired ? node.required : void 0;
	if (hasRequired) if (!isPlainJsonArray(required) || required.some((entry) => typeof entry !== "string")) violations.push(`${path}.required must be an array of strings`);
	else {
		const declared = isJsonSchemaRecord(properties) ? properties : {};
		for (const key of required) if (!Object.hasOwn(declared, key)) violations.push(`${path}.required names "${key}" which is not in properties`);
	}
	if (Object.hasOwn(node, "additionalProperties") && typeof node.additionalProperties !== "boolean") violations.push(`${path}.additionalProperties must be a boolean`);
}
/** Collect every violation for one raw schema tree without using the JavaScript call stack. */
function checkSchemaNode(root, rootPath, violations, seen) {
	const tasks = [{
		kind: "enter",
		node: root,
		path: rootPath
	}];
	for (let task = tasks.pop(); task !== void 0; task = tasks.pop()) {
		if (task.kind === "leave") {
			seen.delete(task.node);
			continue;
		}
		if (task.kind === "one-of-tail") {
			for (const key of ONE_OF_SIBLING_KEYWORDS) if (Object.hasOwn(task.node, key)) violations.push(`${task.path}.${key} is not supported beside oneOf`);
			continue;
		}
		if (task.kind === "object-tail") {
			checkObjectSchemaTail(task.node, task.path, task.properties, violations);
			continue;
		}
		const { node, path } = task;
		if (!isJsonSchemaRecord(node)) {
			violations.push(`${path} must be a schema object`);
			continue;
		}
		if (seen.has(node)) {
			violations.push(`${path} is circular`);
			continue;
		}
		seen.add(node);
		tasks.push({
			kind: "leave",
			node
		});
		for (const key of Object.keys(node)) {
			if (CONSTRAINT_KEYWORDS.has(key)) continue;
			if (ANNOTATION_KEYWORDS.has(key)) {
				try {
					if (!isJsonValue(node[key])) violations.push(`${path}.${key} annotation must be lossless JSON data`);
				} catch {
					violations.push(`${path}.${key} annotation must be lossless JSON data`);
				}
				continue;
			}
			violations.push(`${path}.${key} is not a supported keyword (subset: type/oneOf/properties/required/additionalProperties/items/enum/const + annotations)`);
		}
		if (Object.hasOwn(node, "description") && typeof node.description !== "string") violations.push(`${path}.description must be a string`);
		if (Object.hasOwn(node, "title") && typeof node.title !== "string") violations.push(`${path}.title must be a string`);
		const hasType = Object.hasOwn(node, "type");
		const hasOneOf = Object.hasOwn(node, "oneOf");
		if (hasType && hasOneOf) {
			violations.push(`${path} cannot declare both type and oneOf`);
			continue;
		}
		if (!hasType && !hasOneOf) {
			for (const key of ONE_OF_SIBLING_KEYWORDS) if (Object.hasOwn(node, key)) violations.push(`${path}.${key} requires type or oneOf`);
			continue;
		}
		if (hasOneOf) {
			const oneOf = node.oneOf;
			tasks.push({
				kind: "one-of-tail",
				node,
				path
			});
			if (!isPlainJsonArray(oneOf) || oneOf.length < 2) violations.push(`${path}.oneOf must be an array of at least two schemas`);
			else for (let index = oneOf.length - 1; index >= 0; index--) tasks.push({
				kind: "enter",
				node: oneOf[index],
				path: `${path}.oneOf[${index}]`
			});
			continue;
		}
		const type = node.type;
		if (typeof type !== "string" || !SCHEMA_TYPES.includes(type)) {
			violations.push(Array.isArray(type) ? `${path}.type must be a single type string (type arrays are not supported)` : `${path}.type must be one of ${SCHEMA_TYPES.join("/")}`);
			continue;
		}
		const schemaType = type;
		for (const [key, types] of Object.entries({
			properties: ["object"],
			required: ["object"],
			additionalProperties: ["object"],
			items: ["array"],
			enum: [
				"string",
				"number",
				"integer",
				"boolean",
				"null"
			],
			const: [
				"string",
				"number",
				"integer",
				"boolean",
				"null"
			]
		})) if (Object.hasOwn(node, key) && !types.includes(schemaType)) violations.push(`${path}.${key} is not supported on type "${schemaType}"`);
		switch (schemaType) {
			case "object": {
				const properties = Object.hasOwn(node, "properties") ? node.properties : void 0;
				tasks.push({
					kind: "object-tail",
					node,
					path,
					properties
				});
				if (Object.hasOwn(node, "properties")) if (!isJsonSchemaRecord(properties)) violations.push(`${path}.properties must be an object of schemas`);
				else {
					const entries = Object.entries(properties);
					for (let index = entries.length - 1; index >= 0; index--) {
						const entry = entries[index];
						/* v8 ignore next -- the loop is bounded by the captured entry count. */
						if (entry === void 0) continue;
						tasks.push({
							kind: "enter",
							node: entry[1],
							path: `${path}.properties.${entry[0]}`
						});
					}
				}
				break;
			}
			case "array":
				if (Object.hasOwn(node, "items")) tasks.push({
					kind: "enter",
					node: node.items,
					path: `${path}.items`
				});
				break;
			case "string":
			case "number":
			case "integer":
			case "boolean":
			case "null": {
				const hasEnum = Object.hasOwn(node, "enum");
				const allowed = hasEnum ? node.enum : void 0;
				const enumValid = isPlainJsonArray(allowed) && allowed.length > 0 && allowed.every((entry) => scalarMatches(schemaType, entry));
				if (hasEnum && !enumValid) violations.push(`${path}.enum must be a non-empty array of ${schemaType} values`);
				const hasConst = Object.hasOwn(node, "const");
				const declaredConst = hasConst ? node.const : void 0;
				const constValid = scalarMatches(schemaType, declaredConst);
				if (hasConst) {
					if (!constValid) violations.push(`${path}.const must be a ${schemaType} value`);
					else if (enumValid && !allowed.includes(declaredConst)) violations.push(`${path}.const must be one of ${path}.enum when both are declared`);
				}
				break;
			}
			/* v8 ignore next -- schemaType was narrowed from the closed SCHEMA_TYPES table above. */
			default: assertNever(schemaType, "JsonSchemaType");
		}
	}
}
/**
* Assert that an arbitrary raw schema uses only the enforced subset.
* Annotation-only schemas are accepted as the standard unconstrained-JSON
* form; callers that require an object root use {@link assertObjectJsonSchema}.
* @param schema - untrusted raw JSON Schema.
* @returns Assertion that the schema belongs to the supported subset.
*/
function assertSupportedJsonSchema(schema) {
	const violations = [];
	checkSchemaNode(schema, "schema", violations, /* @__PURE__ */ new Set());
	if (violations.length > 0) throw new JsonSchemaError(violations);
}
/** Safely test the lossless JSON boundary when a getter may throw. */
function safelyIsJsonValue(value) {
	try {
		return isJsonValue(value);
	} catch {
		return false;
	}
}
/** Root-aware diagnostic path for the parameter validator's empty sentinel. */
function diagnosticPath(path) {
	return path === "" ? "arguments" : path;
}
/** Append one object property without a leading dot at an implicit root. */
function propertyPath(path, key) {
	return path === "" ? key : `${path}.${key}`;
}
/** The generic exception-containment diagnostic owned by one valid schema node. */
function losslessValueViolation(path) {
	return [`"${diagnosticPath(path)}" must be a lossless JSON value`];
}
/** Append diagnostics without spreading a potentially wide child result as call arguments. */
function appendViolations(target, source) {
	for (const violation of source) target.push(violation);
}
/** Initialize one validation frame with empty aggregation state. */
function valueFrame(node, value, path) {
	return {
		node,
		value,
		path,
		catches: false,
		phase: "start",
		children: [],
		childIndex: 0,
		violations: [],
		tailViolations: [],
		matches: 0
	};
}
/** Validate one scalar node after its primitive type check. */
function checkScalarValue(node, value, path) {
	const allowed = Object.hasOwn(node, "enum") ? node.enum : void 0;
	if (allowed !== void 0 && !allowed.includes(value)) return [`"${diagnosticPath(path)}" must be one of ${JSON.stringify(allowed)}`];
	if (Object.hasOwn(node, "const") && value !== node.const) return [`"${diagnosticPath(path)}" must be ${JSON.stringify(node.const)}`];
	return [];
}
/** Validate one trusted schema/value pair with explicit frames rather than recursive calls. */
function checkValue(schema, value, path) {
	const frames = [valueFrame(schema, value, path)];
	let rootResult;
	const receive = (result) => {
		const parent = frames.at(-1);
		if (parent === void 0) {
			rootResult = result;
			return;
		}
		if (parent.kind === "oneOf") {
			if (result.length === 0) parent.matches++;
		} else appendViolations(parent.violations, result);
	};
	const finish = (result) => {
		frames.pop();
		receive(result);
	};
	while (frames.length > 0) {
		const frame = frames.at(-1);
		/* v8 ignore next -- the loop condition guarantees a current frame. */
		if (frame === void 0) break;
		try {
			if (frame.phase === "children") {
				if (frame.childIndex < frame.children.length) {
					const child = frame.children[frame.childIndex];
					/* v8 ignore next -- childIndex is bounded by children.length. */
					if (child === void 0) throw new Error("missing schema-value child frame");
					frame.childIndex++;
					frames.push(valueFrame(child.node, child.value, child.path));
					continue;
				}
				if (frame.kind === "oneOf") {
					finish(frame.matches === 1 ? [] : [`"${diagnosticPath(frame.path)}" must match exactly one oneOf branch (matched ${frame.matches})`]);
					continue;
				}
				appendViolations(frame.violations, frame.tailViolations);
				if (frame.violations.length > 0) finish(frame.violations);
				else if (frame.kind === "object") finish(safelyIsJsonValue(frame.value) ? [] : [`"${diagnosticPath(frame.path)}" must be a lossless JSON object`]);
				else finish(safelyIsJsonValue(frame.value) ? [] : [`"${diagnosticPath(frame.path)}" must be a dense lossless JSON array`]);
				continue;
			}
			const nodeType = Object.hasOwn(frame.node, "type") ? frame.node.type : void 0;
			frame.catches = !(nodeType !== void 0 && !SCHEMA_TYPES.includes(nodeType));
			const oneOf = Object.hasOwn(frame.node, "oneOf") ? frame.node.oneOf : void 0;
			if (oneOf !== void 0) {
				frame.kind = "oneOf";
				frame.children = Array.from(oneOf, (branch) => ({
					node: branch,
					value: frame.value,
					path: frame.path
				}));
				frame.childIndex = 0;
				frame.matches = 0;
				frame.phase = "children";
				continue;
			}
			if (nodeType === void 0) {
				finish(safelyIsJsonValue(frame.value) ? [] : losslessValueViolation(frame.path));
				continue;
			}
			switch (nodeType) {
				case "object": {
					if (!isPlainJsonRecord(frame.value)) {
						finish([`"${diagnosticPath(frame.path)}" must be an object`]);
						break;
					}
					const properties = Object.hasOwn(frame.node, "properties") ? frame.node.properties ?? {} : {};
					const violations = [];
					const required = Object.hasOwn(frame.node, "required") ? frame.node.required ?? [] : [];
					for (const key of required) if (!Object.hasOwn(frame.value, key) || frame.value[key] === void 0) violations.push(`missing required property "${propertyPath(frame.path, key)}"`);
					const children = [];
					for (const [key, child] of Object.entries(properties)) {
						if (!Object.hasOwn(frame.value, key) || frame.value[key] === void 0) continue;
						children.push({
							node: child,
							value: frame.value[key],
							path: propertyPath(frame.path, key)
						});
					}
					const tailViolations = [];
					if (Object.hasOwn(frame.node, "additionalProperties") && frame.node.additionalProperties === false) {
						for (const key of Object.keys(frame.value)) if (!Object.hasOwn(properties, key)) tailViolations.push(`"${propertyPath(frame.path, key)}" is not a declared property (additionalProperties: false)`);
					}
					frame.kind = "object";
					frame.children = children;
					frame.childIndex = 0;
					frame.violations = violations;
					frame.tailViolations = tailViolations;
					frame.phase = "children";
					break;
				}
				case "array": {
					if (!Array.isArray(frame.value)) {
						finish([`"${diagnosticPath(frame.path)}" must be an array`]);
						break;
					}
					const items = Object.hasOwn(frame.node, "items") ? frame.node.items : void 0;
					const children = items === void 0 ? [] : frame.value.flatMap((entry, index) => [{
						node: items,
						value: entry,
						path: `${frame.path}[${index}]`
					}]);
					frame.kind = "array";
					frame.children = children;
					frame.childIndex = 0;
					frame.violations = [];
					frame.phase = "children";
					break;
				}
				case "string":
					finish(typeof frame.value === "string" ? checkScalarValue(frame.node, frame.value, frame.path) : [`"${diagnosticPath(frame.path)}" must be a string`]);
					break;
				case "number":
					finish(typeof frame.value !== "number" ? [`"${diagnosticPath(frame.path)}" must be a number`] : !isJsonNumber(frame.value) ? [`"${diagnosticPath(frame.path)}" must be a finite JSON number`] : checkScalarValue(frame.node, frame.value, frame.path));
					break;
				case "integer":
					finish(!isJsonNumber(frame.value) || !Number.isInteger(frame.value) ? [`"${diagnosticPath(frame.path)}" must be an integer`] : checkScalarValue(frame.node, frame.value, frame.path));
					break;
				case "boolean":
					finish(typeof frame.value === "boolean" ? checkScalarValue(frame.node, frame.value, frame.path) : [`"${diagnosticPath(frame.path)}" must be a boolean`]);
					break;
				case "null":
					finish(frame.value === null ? checkScalarValue(frame.node, frame.value, frame.path) : [`"${diagnosticPath(frame.path)}" must be null`]);
					break;
				default: finish(assertNever(nodeType, "JsonSchemaType"));
			}
		} catch (error) {
			let failed = frames.pop();
			while (failed !== void 0 && !failed.catches) failed = frames.pop();
			if (failed === void 0) throw error;
			receive(losslessValueViolation(failed.path));
		}
	}
	/* v8 ignore next -- every root frame finishes or throws. */
	return rootResult ?? losslessValueViolation(path);
}
/**
* Validate a candidate value against an asserted raw schema. The function is
* total for arbitrary values and returns path-qualified violations.
* @param schema - a schema accepted by {@link assertSupportedJsonSchema}.
* @param value - the candidate JSON value.
* @param path - root label used in diagnostics.
* @returns All violations in walk order; empty means valid.
*/
function validateJsonSchemaValue(schema, value, path = "value") {
	return checkValue(schema, value, path);
}
/** Unified JSON-value schema DSL, inference, compilation, and typed tool helper. @module dsh-tools/schema */
const ANNOTATION_KEYS = [
	"description",
	"title",
	"default",
	"examples"
];
/** Throw one author-schema violation through the shared schema error type. */
function authorError(message) {
	throw new JsonSchemaError([message]);
}
/** Copy own annotation fields for validation by the raw-schema boundary. */
function copyAnnotations(source, target) {
	if (Object.hasOwn(source, "description")) target.description = source.description;
	if (Object.hasOwn(source, "title")) target.title = source.title;
	if (Object.hasOwn(source, "default")) target.default = source.default;
	if (Object.hasOwn(source, "examples")) target.examples = source.examples;
}
/** Reject author-only keys outside one node's declared vocabulary. */
function assertAuthorKeys(source, path, allowed) {
	for (const key of Object.keys(source)) if (!allowed.includes(key)) authorError(`${path}.${key} is not supported by the value schema DSL`);
}
/** Install a compiled node without giving `__proto__` assignment semantics. */
function assignCompiledNode(destination, node) {
	switch (destination.kind) {
		case "root":
			destination.holder.value = node;
			break;
		case "property":
			Object.defineProperty(destination.target, destination.key, {
				value: node,
				enumerable: true,
				configurable: true,
				writable: true
			});
			break;
		case "item":
			destination.target.items = node;
			break;
		case "one-of": destination.target[destination.index] = node;
	}
}
/** Install a compiled property map at its root or containing object node. */
function assignCompiledPropertyMap(destination, compiled) {
	if (destination.kind === "root") destination.holder.value = compiled;
	else destination.target.properties = compiled.properties;
}
/** Execute an author-schema compilation task graph without recursive descent. */
function runSchemaCompiler(initial) {
	const seen = /* @__PURE__ */ new Set();
	const tasks = [initial];
	for (let task = tasks.pop(); task !== void 0; task = tasks.pop()) {
		if (task.kind === "leave") {
			seen.delete(task.input);
			continue;
		}
		if (task.kind === "property-map-tail") {
			if (task.required.length > 0) {
				task.compiled.required = task.required;
				if (task.destination.kind === "object") task.destination.target.required = task.required;
			}
			continue;
		}
		if (task.kind === "property") {
			if (!isJsonSchemaRecord(task.property)) authorError(`${task.path} must be a value schema object`);
			if (Object.hasOwn(task.property, "required") && task.property.required !== true) authorError(`${task.path}.required must be true when present`);
			if (Object.hasOwn(task.property, "required") && task.property.required === true) task.required.push(task.key);
			tasks.push({
				kind: "value",
				input: task.property,
				path: task.path,
				allowRequired: true,
				destination: {
					kind: "property",
					target: task.properties,
					key: task.key
				}
			});
			continue;
		}
		if (task.kind === "property-map") {
			if (!isJsonSchemaRecord(task.input)) authorError(`${task.path} must be an object of value schemas`);
			if (seen.has(task.input)) authorError(`${task.path} is circular`);
			seen.add(task.input);
			const compiled = { properties: {} };
			const required = [];
			assignCompiledPropertyMap(task.destination, compiled);
			tasks.push({
				kind: "leave",
				input: task.input
			});
			tasks.push({
				kind: "property-map-tail",
				compiled,
				required,
				destination: task.destination
			});
			const entries = Object.entries(task.input);
			for (let index = entries.length - 1; index >= 0; index--) {
				const entry = entries[index];
				/* v8 ignore next -- the loop is bounded by the captured entry count. */
				if (entry === void 0) continue;
				tasks.push({
					kind: "property",
					property: entry[1],
					path: `${task.path}.${entry[0]}`,
					key: entry[0],
					properties: compiled.properties,
					required
				});
			}
			continue;
		}
		const { input, path } = task;
		if (!isJsonSchemaRecord(input)) authorError(`${path} must be a value schema object`);
		if (seen.has(input)) authorError(`${path} is circular`);
		seen.add(input);
		const authorKeys = [...ANNOTATION_KEYS, ...task.allowRequired ? ["required"] : []];
		const node = {};
		assignCompiledNode(task.destination, node);
		tasks.push({
			kind: "leave",
			input
		});
		if (Object.hasOwn(input, "oneOf")) {
			assertAuthorKeys(input, path, [
				...authorKeys,
				"oneOf",
				"type"
			]);
			if (Object.hasOwn(input, "type")) authorError(`${path} cannot declare both type and oneOf`);
			if (!isPlainJsonArray(input.oneOf)) authorError(`${path}.oneOf must be an array of at least two value schemas`);
			const branches = [];
			node.oneOf = branches;
			copyAnnotations(input, node);
			for (let index = input.oneOf.length - 1; index >= 0; index--) tasks.push({
				kind: "value",
				input: input.oneOf[index],
				path: `${path}.oneOf[${index}]`,
				allowRequired: false,
				destination: {
					kind: "one-of",
					target: branches,
					index
				}
			});
			continue;
		}
		const inputType = Object.hasOwn(input, "type") ? input.type : void 0;
		switch (inputType) {
			case "json":
				assertAuthorKeys(input, path, [...authorKeys, "type"]);
				copyAnnotations(input, node);
				break;
			case "object":
				assertAuthorKeys(input, path, [
					...authorKeys,
					"type",
					"properties",
					"additionalProperties"
				]);
				if (!Object.hasOwn(input, "additionalProperties") || typeof input.additionalProperties !== "boolean") authorError(`${path}.additionalProperties must be explicitly true or false`);
				node.type = "object";
				copyAnnotations(input, node);
				node.additionalProperties = input.additionalProperties;
				if (Object.hasOwn(input, "properties")) tasks.push({
					kind: "property-map",
					input: input.properties,
					path: `${path}.properties`,
					destination: {
						kind: "object",
						target: node
					}
				});
				break;
			case "array":
				assertAuthorKeys(input, path, [
					...authorKeys,
					"type",
					"items"
				]);
				node.type = "array";
				copyAnnotations(input, node);
				if (Object.hasOwn(input, "items")) tasks.push({
					kind: "value",
					input: input.items,
					path: `${path}.items`,
					allowRequired: false,
					destination: {
						kind: "item",
						target: node
					}
				});
				break;
			case "string":
			case "number":
			case "integer":
			case "boolean":
			case "null":
				assertAuthorKeys(input, path, [
					...authorKeys,
					"type",
					"enum",
					"const"
				]);
				node.type = inputType;
				copyAnnotations(input, node);
				if (Object.hasOwn(input, "enum")) {
					if (!isPlainJsonArray(input.enum)) authorError(`${path}.enum must be a non-empty array of scalar values`);
					node.enum = Array.from(input.enum, (entry) => entry);
				}
				if (Object.hasOwn(input, "const")) node.const = input.const;
				break;
			default: authorError(`${path}.type must be string/number/integer/boolean/null/array/object/json, or use oneOf`);
		}
	}
}
/** Compile one implicit property map, collecting per-property requiredness. */
function compilePropertyMap(input, path) {
	const holder = {};
	runSchemaCompiler({
		kind: "property-map",
		input,
		path,
		destination: {
			kind: "root",
			holder
		}
	});
	/* v8 ignore next -- the root task assigns before scheduling any descendants. */
	return holder.value ?? authorError(`${path} did not compile`);
}
/** Compile one author node without applying any consumer root restriction. */
function compileValueSchema(input, path) {
	const holder = {};
	runSchemaCompiler({
		kind: "value",
		input,
		path,
		allowRequired: false,
		destination: {
			kind: "root",
			holder
		}
	});
	/* v8 ignore next -- the root task assigns before scheduling any descendants. */
	return holder.value ?? authorError(`${path} did not compile`);
}
/**
* Compile one author-facing value schema to the enforced raw JSON Schema
* subset. The author-only `json` node becomes an annotation-only schema.
* @param spec - schema for any JSON-value root.
* @returns The asserted raw schema projection.
*/
function valueSchemaSpecToJsonSchema(spec) {
	const schema = compileValueSchema(spec, "schema");
	assertSupportedJsonSchema(schema);
	return schema;
}
/**
* Compile the implicit open parameter object into raw JSON Schema.
* @param spec - per-property parameter definitions.
* @returns An object-rooted raw schema with no implicit-root openness override.
*/
function parameterSchemaSpecToJsonSchema(spec) {
	const compiled = compilePropertyMap(spec, "parameters");
	const schema = {
		type: "object",
		properties: compiled.properties,
		...compiled.required === void 0 ? {} : { required: compiled.required }
	};
	assertSupportedJsonSchema(schema);
	return schema;
}
/** Invalid model-generated arguments for a typed tool. */
var ToolArgsError = class extends HarnessError {
	/** Individual violations in schema-walk order. */
	violations;
	constructor(violations) {
		super(`invalid arguments: ${violations.join("; ")}`, "INVALID_ARGS");
		this.name = "ToolArgsError";
		this.violations = violations;
	}
};
/**
* Define a first-party tool with inferred arguments and strict execution
* validation. Replay-only presenters validate softly and fall back to generic
* rendering for obsolete logged arguments.
* @param options - typed definition and optional finalizer and presenters.
* @returns A registry-ready definition.
*/
function defineTool(options) {
	const userExecute = options.execute;
	const userFinalizeContent = options.finalizeContent;
	const userRender = options.output.render;
	const userPresentationMeta = options.output.presentationMeta;
	const userPresentCall = options.presentCall;
	const userPresentResult = options.presentResult;
	const userIsConcurrencySafe = options.isConcurrencySafe;
	if (options.timeoutMs !== void 0 && (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)) throw new Error(`defineTool(${options.name}): timeoutMs must be a positive finite number`);
	const parameters = parameterSchemaSpecToJsonSchema(options.parameters);
	const outputSchema = valueSchemaSpecToJsonSchema(options.output.schema);
	const validate = (args) => validateJsonSchemaValue(parameters, args, "");
	const tool = {
		name: options.name,
		description: options.description,
		parameters,
		output: {
			schema: outputSchema,
			render(args, value) {
				return userRender(args, value);
			},
			...userPresentationMeta !== void 0 ? { presentationMeta(args, value) {
				return userPresentationMeta(args, value);
			} } : {}
		},
		...options.timeoutMs !== void 0 ? { timeoutMs: options.timeoutMs } : {},
		async execute(args, exec) {
			const violations = validate(args);
			if (violations.length > 0) throw new ToolArgsError(violations);
			return userExecute(args, exec);
		}
	};
	if (userFinalizeContent) tool.finalizeContent = (exec, result) => userFinalizeContent(exec, result);
	if (userPresentCall) tool.presentCall = (args) => {
		if (validate(args).length > 0) return void 0;
		return userPresentCall(args);
	};
	if (userPresentResult) tool.presentResult = (args, result) => {
		if (validate(args).length > 0) return void 0;
		return userPresentResult(args, result);
	};
	if (userIsConcurrencySafe) tool.isConcurrencySafe = (args) => {
		if (validate(args).length > 0) return false;
		return userIsConcurrencySafe(args);
	};
	return tool;
}
/**
* Code Mode `run_code` transport. Programs call the registry's agent-visible
* tools through nested executions scheduled under the native concurrency
* contract; each sub-dispatch is logged for reconstruction, while only the
* outer curated result enters model history.
* @module @deepseek-ai/dsh-tools/src/code-mode
*/
/** The model-facing name of the Code Mode tool. */
const RUN_CODE_NAME = "run_code";
/**
* The TypeScript flavor: the fallback for a schema read with no runtime
* mounted ({@link resolveFlavor} owns which readers reach that). A real
* assembly always resolves a runtime first, so the model never sees this
* fallback outside its own language.
*/
const TYPESCRIPT_FLAVOR = {
	description: "Execute a TypeScript program against the available tools. Takes two required arguments: `code`, the BODY of an async function (erasable syntax only; top-level `await` and `return` work), and `description`, a short summary of what the program does. Call tools as `await tools.name(args)` per the declarations in the system prompt. Only what you print or return comes back — curate it.",
	codeDescription: "The program: the body of an async TypeScript function."
};
/** Per-language `run_code` schema flavors (see {@link RunCodeFlavor}); one entry per {@link CodeSdkLanguage}. */
const RUN_CODE_FLAVORS = {
	typescript: TYPESCRIPT_FLAVOR,
	python: {
		description: "Execute a Python program against the available tools. Takes two required arguments: `code`, the BODY of an async function (top-level `await` and `return` work), and `description`, a short summary of what the program does. Call tools as `await tools.name(args)` per the declarations in the system prompt. Answer with `print(...)` and/or `return <value>` — only that comes back, so curate it.",
		codeDescription: "The program: the body of an async Python function."
	}
};
/**
* The `description` parameter's model-facing description: language-independent
* (the UI label contract is the same for every runtime), shared between the
* static spec and the language-aware `parameters` getter so the two emissions
* can never drift.
*/
const RUN_CODE_DESCRIPTION_PARAM_DESCRIPTION = "Clear, concise description of what this program does in active voice, 5-10 words (shown in the UI). Examples: \"Count TODO markers across packages\"; \"Read failing test and its fixture\"; \"Rename config key in every cordis.yml\".";
/**
* Resolve the {@link RunCodeFlavor} for the loaded runtime's language, read at
* schema-emission time so the model-visible `run_code` schema always matches
* the SDK section's language. `peekRuntime` returns `undefined` only when no
* runtime is mounted, which reaches this function through definition readers
* and `schemas()` — the doc-catalog harvest is the only shipped one, and none
* of them feeds a model, because `wireSchemas` calls `requireCodeRuntime`
* before projecting — so that path degrades to {@link TYPESCRIPT_FLAVOR}. A
* mounted runtime whose language has no flavor entry fails loud, exactly as
* `requireCodeRuntime` rejects it at assembly. Keeping this table in step with
* `SDK_RENDERERS` is the compiler's job ({@link CodeSdkLanguage}); what this
* guard owns is the runtime-supplied language neither table knows, which never
* yields a wrong-language schema for a real runtime.
*/
function resolveFlavor(peekRuntime) {
	const runtime = peekRuntime();
	if (runtime === void 0) return TYPESCRIPT_FLAVOR;
	const flavor = RUN_CODE_FLAVORS[runtime.language];
	if (!Object.hasOwn(RUN_CODE_FLAVORS, runtime.language) || flavor === void 0) {
		const known = Object.keys(RUN_CODE_FLAVORS).map((name) => JSON.stringify(name)).join(", ");
		throw new Error(`dsh-tools: no run_code schema flavor registered for runtime language ${JSON.stringify(runtime.language)} (known: ${known})`);
	}
	return flavor;
}
/**
* Thrown by `run_code` when the program run itself failed — a program
* exception, a budget expiry, an abort, or substrate death. Extends
* {@link HarnessError} (`code: 'CODE_RUN_FAILED'`); the registry's execution
* pipeline converts it into a structured `isError` result whose text carries
* the failure kind plus the captured logs, so the model can self-correct.
*/
var CodeRunFailedError = class extends HarnessError {
	constructor(message) {
		super(message, "CODE_RUN_FAILED");
		this.name = "CodeRunFailedError";
	}
};
/**
* Snapshot one binding call's argument as lossless JSON, then snapshot that
* detached value again so dispatch and logging stay independent without
* reintroducing structured-clone's platform-specific nesting limit.
*/
function jsonNormalizeArgs(value) {
	let snapshot;
	try {
		snapshot = snapshotJsonValue(value);
	} catch (error) {
		throw new Error(`tool arguments must be lossless JSON: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (snapshot === void 0) throw new Error("tool arguments must be lossless JSON (call the tool with an arguments object, e.g. `{}`)");
	const logged = snapshotJsonValue(snapshot);
	/* v8 ignore next -- snapshot is already a detached lossless JSON value. */
	if (logged === void 0) throw new Error("tool arguments could not be detached for durable logging");
	return {
		dispatched: snapshot,
		logged
	};
}
/** Two-space JSON presentation, matching the existing shallow `run_code` text contract. */
const JSON_INDENT = "  ";
/**
* ECMAScript caps `JSON.stringify`'s `space` string at ten characters. The
* renderer also caps TOTAL indentation there, compacting deeper subtrees, so
* formatted output remains linear in the canonical JSON size.
*/
const MAX_JSON_INDENT_CHARS = 10;
/** Render one non-string JSON root without recursive traversal or unbounded indentation growth. */
function renderJsonValue(value) {
	const chunks = [];
	const tasks = [{
		kind: "value",
		value,
		depth: 0,
		compact: false
	}];
	for (let task = tasks.pop(); task !== void 0; task = tasks.pop()) {
		if (task.kind === "text") {
			chunks.push(task.text);
			continue;
		}
		const current = task.value;
		if (current === null || typeof current === "boolean" || typeof current === "number") {
			chunks.push(String(current));
			continue;
		}
		if (typeof current === "string") {
			chunks.push(JSON.stringify(current));
			continue;
		}
		const compact = task.compact || (task.depth + 1) * 2 > MAX_JSON_INDENT_CHARS;
		const childDepth = task.depth + 1;
		if (Array.isArray(current)) {
			chunks.push("[");
			if (current.length === 0) {
				chunks.push("]");
				continue;
			}
			tasks.push({
				kind: "text",
				text: compact ? "]" : `\n${JSON_INDENT.repeat(task.depth)}]`
			});
			for (let index = current.length - 1; index >= 0; index--) {
				const item = current[index];
				/* v8 ignore next -- canonical JsonValue arrays are dense. */
				if (item === void 0) throw new Error("cannot render a sparse JSON array");
				tasks.push({
					kind: "value",
					value: item,
					depth: childDepth,
					compact
				});
				tasks.push({
					kind: "text",
					text: compact ? index === 0 ? "" : "," : `${index === 0 ? "\n" : ",\n"}${JSON_INDENT.repeat(childDepth)}`
				});
			}
			continue;
		}
		const keys = Object.keys(current);
		chunks.push("{");
		if (keys.length === 0) {
			chunks.push("}");
			continue;
		}
		tasks.push({
			kind: "text",
			text: compact ? "}" : `\n${JSON_INDENT.repeat(task.depth)}}`
		});
		for (let index = keys.length - 1; index >= 0; index--) {
			const key = keys[index];
			/* v8 ignore next -- the loop is bounded by the captured key count. */
			if (key === void 0) throw new Error("cannot render a missing JSON object key");
			const item = current[key];
			/* v8 ignore next -- canonical JsonValue records contain no undefined properties. */
			if (item === void 0) throw new Error("cannot render an undefined JSON object property");
			tasks.push({
				kind: "value",
				value: item,
				depth: childDepth,
				compact
			});
			tasks.push({
				kind: "text",
				text: compact ? `${index === 0 ? "" : ","}${JSON.stringify(key)}:` : `${index === 0 ? "\n" : ",\n"}${JSON_INDENT.repeat(childDepth)}${JSON.stringify(key)}: `
			});
		}
	}
	return chunks.join("");
}
/** Render one present program completion value for the model-facing result text. */
function renderValue(value) {
	return typeof value === "string" ? value : renderJsonValue(value);
}
/**
* Build the `run_code` {@link ToolDefinition}: required `code` and
* `description` parameters, executed through the dispatch bridge described
* above. The
* registry reserves it as presentation infrastructure under non-native modes,
* outside the filterable global/scoped capability layers.
* @param registry - the owning registry (sub-calls go through its `execute`,
*   bindings cover its registered tools).
* @param options - the registry-private capabilities described above.
* @returns the registry-ready definition.
*/
function createRunCodeTool(registry, options) {
	const { requireRuntime, peekRuntime, maxParallel, shapeDispatchLog } = options;
	const definition = defineTool({
		name: RUN_CODE_NAME,
		description: TYPESCRIPT_FLAVOR.description,
		parameters: {
			code: {
				type: "string",
				required: true,
				description: TYPESCRIPT_FLAVOR.codeDescription
			},
			description: {
				type: "string",
				required: true,
				description: RUN_CODE_DESCRIPTION_PARAM_DESCRIPTION
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					logs: {
						type: "array",
						required: true,
						items: { type: "string" }
					},
					result: { type: "json" }
				}
			},
			render: (_args, value) => {
				const rendered = value.result === void 0 ? "" : renderValue(value.result);
				const parts = [value.logs.join("\n"), rendered].filter((part) => part.length > 0);
				return [{
					type: "text",
					text: parts.length > 0 ? parts.join("\n") : "(run_code completed with no output)"
				}];
			}
		},
		async execute(args, exec) {
			if (args.description.trim().length === 0) throw new Error("invalid description: expected a non-empty string");
			const runtime = requireRuntime();
			const runController = new AbortController();
			const onOuterAbort = () => {
				runController.abort(exec.signal.reason);
			};
			exec.signal.addEventListener("abort", onOuterAbort, { once: true });
			let dispatches = 0;
			const pendingQueue = [];
			const inFlight = /* @__PURE__ */ new Set();
			/** Tracked settle-event side work (log-content listener + append), drained at run settlement. */
			const logWork = /* @__PURE__ */ new Set();
			const commitQueue = [];
			let exclusiveActive = false;
			let driving = false;
			let driverRun = Promise.resolve();
			let wake;
			const wakeup = () => {
				const release = wake;
				wake = void 0;
				release?.();
			};
			/**
			* The single ordered lane. Each pass commits the head-of-line settled
			* dispatch (ordered post-execute), then starts the next queued entry if
			* its slot is free (ordered pre-execute), and otherwise sleeps until a
			* body settles or a new submission arrives. One run reaching the
			* empty-queues/empty-pool state is quiescence.
			*/
			const drive = () => {
				if (driving) return driverRun;
				driving = true;
				driverRun = (async () => {
					try {
						for (;;) {
							const signal = new Promise((resolve) => {
								wake = resolve;
							});
							const commitHead = commitQueue[0];
							if (commitHead !== void 0 && commitHead.settled) {
								commitQueue.shift();
								await commitHead.commit();
								if (commitHead.mode === "exclusive") exclusiveActive = false;
								continue;
							}
							const head = pendingQueue[0];
							if (head !== void 0) {
								if (runController.signal.aborted) {
									pendingQueue.shift();
									head.abandon();
									continue;
								}
								const mode = head.classify();
								if (!exclusiveActive && (mode === "exclusive" ? inFlight.size === 0 : inFlight.size < maxParallel)) {
									if (mode === "exclusive") exclusiveActive = true;
									head.mode = mode;
									pendingQueue.shift();
									commitQueue.push(head);
									await head.start();
									const flight = head.flight.finally(() => {
										inFlight.delete(flight);
										wakeup();
									});
									inFlight.add(flight);
									continue;
								}
							}
							if (pendingQueue.length === 0 && commitQueue.length === 0 && inFlight.size === 0) return;
							await signal;
						}
					} finally {
						driving = false;
						wake = void 0;
					}
				})();
				return driverRun;
			};
			/** Every dispatch settled AND committed; nothing can start (the run is aborted at call time). */
			const drainDispatches = async () => {
				await drive();
				while (logWork.size > 0) await Promise.allSettled([...logWork]);
			};
			const runOver = () => runController.signal.aborted;
			const binding = (name) => async (rawArgs) => {
				if (runOver()) throw new Error(`run_code run is over (${String(runController.signal.reason)}); ${name} not dispatched`);
				const normalized = jsonNormalizeArgs(rawArgs);
				const n = ++dispatches;
				const subCallId = CallId(`${String(exec.callId)}:code:${n}`);
				const input = {
					callId: subCallId,
					rootCallId: exec.rootCallId,
					name,
					arguments: normalized.dispatched,
					...exec.agent ? { agent: exec.agent } : {},
					parent: exec.token,
					signal: runController.signal
				};
				const scheduler = registry[TOOL_RUNTIME_SCHEDULER];
				const outcome = await new Promise((resolve, reject) => {
					let parked;
					const settle = (result) => {
						resolve(result.isError ? {
							isError: true,
							message: result.error.message
						} : {
							isError: false,
							value: result.value
						});
						const agent = exec.agent;
						if (agent === void 0) return;
						const task = (async () => {
							const logged = await shapeDispatchLog({
								exec,
								agent,
								subCallId,
								name,
								isError: result.isError,
								content: result.content
							});
							agent.session.append("tool/code-dispatch", {
								rootCallId: exec.rootCallId,
								parentCallId: exec.callId,
								subCallId,
								name,
								arguments: normalized.logged,
								isError: result.isError,
								content: logged
							});
						})().finally(() => {
							logWork.delete(task);
						});
						logWork.add(task);
					};
					pendingQueue.push({
						flight: Promise.resolve(),
						settled: false,
						classify: () => registry.executionMode(input).kind,
						abandon: () => {
							reject(/* @__PURE__ */ new Error(`run_code run is over (${String(runController.signal.reason)}); ${name} tool call abandoned`));
						},
						async start() {
							exec.agent?.session.append("tool/code-dispatch-start", {
								rootCallId: exec.rootCallId,
								parentCallId: exec.callId,
								subCallId,
								name,
								arguments: normalized.logged
							});
							const prepared = await scheduler.prepare(input);
							if (prepared.kind === "dispatch") {
								this.flight = scheduler.dispatch(prepared.exec).then((dispatchOutcome) => {
									parked = {
										kind: dispatchOutcome.kind,
										exec: prepared.exec,
										result: dispatchOutcome.result
									};
									this.settled = true;
								});
								return;
							}
							parked = {
								kind: prepared.kind,
								exec: prepared.exec,
								result: prepared.result
							};
							this.settled = true;
						},
						async commit() {
							/* v8 ignore next -- commit() runs only after `settled` flipped, which set parked. */
							if (parked === void 0) return;
							const result = parked.kind === "post-result" ? await scheduler.finalize(parked.exec, parked.result) : scheduler.finish(parked.exec, parked.result);
							for (const context of result.additionalContexts ?? []) exec.deferContext(context);
							if (result.concludesTurn) exec.concludeTurn();
							settle(result);
							while (logWork.size > maxParallel) await Promise.race(logWork);
						}
					});
					wakeup();
					drive();
				});
				if (runOver()) throw new Error(`run_code run is over (${String(runController.signal.reason)}); ${name} result discarded`);
				if (outcome.isError) throw new Error(outcome.message);
				return outcome.value;
			};
			const functions = Object.create(null);
			for (const schema of registry.schemas(exec.agent)) {
				if (schema.name === "run_code") continue;
				Object.defineProperty(functions, schema.name, {
					enumerable: true,
					value: binding(schema.name)
				});
			}
			try {
				let result;
				try {
					result = await runtime.run({
						program: args.code,
						bindings: [{
							global: "tools",
							functions,
							errorClass: {
								name: "ToolCallError",
								memberNameProperty: "toolName"
							}
						}],
						signal: runController.signal
					});
				} finally {
					runController.abort("run_code settled");
					await drainDispatches();
				}
				if (result.error) {
					const logsText = result.logs.length > 0 ? `\nCaptured output:\n${result.logs.join("\n")}` : "";
					throw new CodeRunFailedError(`code run failed (${result.error.kind}): ${result.error.message}${logsText}`);
				}
				return {
					logs: result.logs,
					...result.value !== void 0 ? { result: result.value } : {}
				};
			} finally {
				exec.signal.removeEventListener("abort", onOuterAbort);
			}
		},
		presentCall: (args) => ({
			card: "generic",
			title: args.description,
			kind: "execute",
			rawInput: args.code
		})
	});
	Object.defineProperty(definition, "description", {
		enumerable: true,
		get: () => resolveFlavor(peekRuntime).description
	});
	Object.defineProperty(definition, "parameters", {
		enumerable: true,
		get: () => parameterSchemaSpecToJsonSchema({
			code: {
				type: "string",
				required: true,
				description: resolveFlavor(peekRuntime).codeDescription
			},
			description: {
				type: "string",
				required: true,
				description: RUN_CODE_DESCRIPTION_PARAM_DESCRIPTION
			}
		})
	});
	return definition;
}
/**
* Code Mode codegen: the pure projection from registered tool schemas to the TypeScript SDK
* text the model programs against (the `tools:sdk` prompt section). Sibling of
* `json-schema.ts` — `schemas()` (native function calling) and this module (the generated
* `declare const tools` API) are two projections of the same store.
* @module @deepseek-ai/dsh-tools/src/ts-types
*/
/** Property names that are valid bare TS identifiers; anything else is quoted. */
const IDENTIFIER$1 = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
/** Render an object key: bare when it is a valid identifier, quoted otherwise (every name stays reachable, no aliasing). */
function renderKey(name) {
	return IDENTIFIER$1.test(name) ? name : JSON.stringify(name);
}
/** One `indent`-deep line prefix (two spaces per level). */
function pad$1(indent) {
	return "  ".repeat(indent);
}
/** A one-line JSDoc block for a schema `description`, or no lines when there is none. */
function docLines$1(description, indent) {
	if (typeof description !== "string" || description.length === 0) return [];
	const collapsed = description.replace(/\s+/g, " ").trim();
	return [`${pad$1(indent)}/** ${collapsed.replaceAll("*/", String.raw`*\/`)} */`];
}
/** Render one scalar already validated by the unified schema boundary. */
function renderScalar(value) {
	return JSON.stringify(value);
}
/** Render a validated scalar `const`/`enum`, falling back to the broad type. */
function renderConstrainedScalar$1(node, type) {
	const broad = type === "integer" ? "number" : type;
	if (Object.hasOwn(node, "const")) return renderScalar(node.const);
	if (Object.hasOwn(node, "enum")) return node.enum.map(renderScalar).join(" | ");
	return broad;
}
/** Build one document from captured parts while retaining the legacy array-parenthesization test. */
function typeDocumentFrom(parts) {
	return {
		parts,
		containsUnionOrIntersection: parts.some((part) => typeof part === "string" ? part.includes("|") || part.includes("&") : part.containsUnionOrIntersection)
	};
}
/** Build a small document without an intermediate array at each call site. */
function typeDocument(...parts) {
	return typeDocumentFrom(parts);
}
/** Flatten a nested document with an explicit work stack. */
function flattenTypeDocument(document) {
	const chunks = [];
	const tasks = [document];
	for (let task = tasks.pop(); task !== void 0; task = tasks.pop()) {
		if (typeof task === "string") {
			chunks.push(task);
			continue;
		}
		for (let index = task.parts.length - 1; index >= 0; index--) {
			const part = task.parts[index];
			/* v8 ignore next -- the loop is bounded by the captured part count. */
			if (part !== void 0) tasks.push(part);
		}
	}
	return chunks.join("");
}
/** Initialize one schema-render frame with empty aggregation state. */
function schemaRenderFrame(node, indent) {
	return {
		node,
		indent,
		phase: "start",
		children: [],
		childIndex: 0,
		childDocuments: [],
		entries: []
	};
}
/** Render an already asserted schema to a composable document. */
function renderSupportedSchema(schema, indent) {
	const frames = [schemaRenderFrame(schema, indent)];
	let rootDocument;
	const finish = (document) => {
		frames.pop();
		const parent = frames.at(-1);
		if (parent === void 0) rootDocument = document;
		else parent.childDocuments.push(document);
	};
	while (frames.length > 0) {
		const frame = frames.at(-1);
		/* v8 ignore next -- the loop condition guarantees a current frame. */
		if (frame === void 0) break;
		if (frame.phase === "children") {
			if (frame.childIndex < frame.children.length) {
				const child = frame.children[frame.childIndex];
				/* v8 ignore next -- childIndex is bounded by children.length. */
				if (child === void 0) throw new Error("missing schema render child");
				frame.childIndex++;
				frames.push(schemaRenderFrame(child.node, child.indent));
				continue;
			}
			if (frame.kind === "oneOf") {
				const parts = [];
				for (let index = 0; index < frame.childDocuments.length; index++) {
					if (index > 0) parts.push(" | ");
					const child = frame.childDocuments[index];
					/* v8 ignore next -- child documents correspond one-to-one with children. */
					if (child !== void 0) parts.push(child);
				}
				finish(typeDocumentFrom(parts));
				continue;
			}
			if (frame.kind === "array") {
				const child = frame.childDocuments[0];
				/* v8 ignore next -- array frames always schedule exactly one child. */
				if (child === void 0) throw new Error("missing array item type");
				finish(child.containsUnionOrIntersection ? typeDocument("(", child, ")[]") : typeDocument(child, "[]"));
				continue;
			}
			const required = new Set(frame.node.required);
			const parts = ["{"];
			for (let index = 0; index < frame.entries.length; index++) {
				const entry = frame.entries[index];
				const child = frame.childDocuments[index];
				/* v8 ignore next -- object entries and child documents have the same length. */
				if (entry === void 0 || child === void 0) throw new Error("missing object property type");
				const [name, prop] = entry;
				for (const line of docLines$1(prop.description, frame.indent + 1)) parts.push("\n", line);
				parts.push("\n", `${pad$1(frame.indent + 1)}${renderKey(name)}${required.has(name) ? "" : "?"}: `, child, ";");
			}
			parts.push("\n", `${pad$1(frame.indent)}}`);
			const declared = typeDocumentFrom(parts);
			finish(frame.node.additionalProperties === false ? declared : typeDocument(declared, " & Record<string, JsonValue>"));
			continue;
		}
		const node = frame.node;
		if (node.oneOf !== void 0) {
			frame.kind = "oneOf";
			frame.children = Array.from(node.oneOf, (child) => ({
				node: child,
				indent: frame.indent
			}));
			frame.childIndex = 0;
			frame.childDocuments = [];
			frame.phase = "children";
			continue;
		}
		if (node.type === void 0) {
			finish(typeDocument("JsonValue"));
			continue;
		}
		switch (node.type) {
			case "string":
			case "number":
			case "integer":
			case "boolean":
			case "null":
				finish(typeDocument(renderConstrainedScalar$1(node, node.type)));
				break;
			case "array":
				if (node.items === void 0) finish(typeDocument("JsonValue[]"));
				else {
					frame.kind = "array";
					frame.children = [{
						node: node.items,
						indent: frame.indent
					}];
					frame.childIndex = 0;
					frame.childDocuments = [];
					frame.phase = "children";
				}
				break;
			case "object": {
				const open = node.additionalProperties !== false;
				const entries = Object.entries(node.properties ?? {});
				if (entries.length === 0) finish(typeDocument(open ? "Record<string, JsonValue>" : "Record<string, never>"));
				else {
					frame.kind = "object";
					frame.entries = entries;
					frame.children = entries.map(([, child]) => ({
						node: child,
						indent: frame.indent + 1
					}));
					frame.childIndex = 0;
					frame.childDocuments = [];
					frame.phase = "children";
				}
				break;
			}
			/* v8 ignore next -- assertSupportedJsonSchema narrowed this closed type union. */
			default: finish(typeDocument("unknown"));
		}
	}
	/* v8 ignore next -- every root frame produces one document. */
	return rootDocument ?? typeDocument("unknown");
}
/**
* Map one enforced JSON-Schema node to a TypeScript type literal. Supports
* every unified schema construct and returns `unknown` for malformed or
* unsupported inputs without throwing.
* @param schema - the JSON-Schema node (any shape; hostile inputs degrade).
* @param indent - the indentation level for nested object members.
* @returns the TS type text (multi-line for objects with properties).
*/
function jsonSchemaToTs(schema, indent = 0) {
	try {
		assertSupportedJsonSchema(schema);
		return flattenTypeDocument(renderSupportedSchema(schema, indent));
	} catch {
		return "unknown";
	}
}
/** The fixed model-facing usage contract rendered above the declarations (see the Code Mode Agent Note's "What the model sees"). */
const SDK_INSTRUCTIONS$1 = `## Writing code for run_code

\`run_code\` takes two required arguments: \`code\` — the body of an async TypeScript function (erasable syntax only — no \`enum\` or namespaces; type annotations are advisory, the code runs type-stripped) — and \`description\`, a short summary of what the program does. Inside the program:

- Call tools as \`await tools.name(args)\` — quoted access for exotic names: \`tools["my-tool"](args)\`. Every call resolves to the tool's typed canonical JSON value. Tool arguments must be lossless JSON.
- A FAILED tool call rejects with \`ToolCallError\`, whose \`toolName\` identifies the failed tool and whose \`message\` is human-readable — \`try/catch\` it to handle and continue.
- Independent read-only calls MAY overlap under \`Promise.all\` (safe calls run concurrently; mutating calls run alone, in submission order). Sequence dependent work with \`await\`.
- Emit results with \`return\` and/or \`console.log(...)\`. ONLY what you print or return comes back to you — intermediate tool results never enter the conversation, so extract just what you need.

The available tools:`;
/**
* Render the full `tools:sdk` prompt section: the fixed usage instructions
* plus one `declare const tools` interface covering every given tool.
* Deterministic — tools are emitted in lexicographic name order, so an
* unchanged tool set produces byte-identical text across assemblies. The sort
* is not a total order on byte-equal names, so two schemas sharing a name
* would render in argument order; the caller's visible-capability map is keyed
* by name, so the input never carries a duplicate.
* @param schemas - the tool schemas to declare (the caller excludes
*   `run_code` itself).
* @returns the complete section text.
*/
function renderToolsSdk(schemas) {
	const sorted = [...schemas].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
	const argsMembers = [];
	const outputMembers = [];
	for (const schema of sorted) {
		argsMembers.push(...docLines$1(schema.description, 1));
		argsMembers.push(`${pad$1(1)}${renderKey(schema.name)}: ${jsonSchemaToTs(schema.parameters, 1)};`);
		outputMembers.push(`${pad$1(1)}${renderKey(schema.name)}: ${jsonSchemaToTs(schema.output, 1)};`);
	}
	return `${SDK_INSTRUCTIONS$1}\n\n\`\`\`ts\ntype JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }\n\n${[
		`interface ToolArgsMap {${argsMembers.length > 0 ? `\n${argsMembers.join("\n")}\n` : ""}}`,
		`interface ToolOutputMap {${outputMembers.length > 0 ? `\n${outputMembers.join("\n")}\n` : ""}}`,
		"type ToolName = keyof ToolOutputMap",
		[
			"declare class ToolCallError extends Error {",
			"  readonly name: \"ToolCallError\";",
			"  readonly toolName: ToolName;",
			"}"
		].join("\n"),
		[
			"declare const tools: {",
			"  [K in ToolName]: (args: ToolArgsMap[K]) => Promise<ToolOutputMap[K]>;",
			"}"
		].join("\n")
	].join("\n\n")}\n\`\`\``;
}
/**
* Code Mode codegen — Python flavor. The pure projection from registered tool schemas to the
* Python SDK text the model programs against under `runtime.language === 'python'`. Sibling of
* {@link ./ts-types.ts | ts-types.ts}; the two files are two projections of the same registry
* store, keyed by the loaded {@link @deepseek-ai/dsh-code-runtime#CodeRuntime.language | code
* runtime's language}.
*
* Under `mode: 'code'` the native tool schemas are omitted from the request, so this generated
* SDK is the model's ONLY source for each tool's argument names, required fields, types,
* descriptions, and canonical output shapes; under `mode: 'both'` the native schemas ship
* alongside it and it is one of two. Object-shaped arguments and outputs therefore render as one
* named `TypedDict` per tool (and per nested object), not an opaque `dict[str, Any]`, so the
* shape survives into the program under the mode that has nothing else to carry it.
* @module @deepseek-ai/dsh-tools/src/py-types
*/
/**
* The reference grammar's `xid_start xid_continue*` — the set
* `str.isidentifier()` accepts on a CPython whose Unicode tables match the
* engine's. See {@link isBareIdentifier} for what a version skew does.
*/
const IDENTIFIER = /^[\p{XID_Start}_]\p{XID_Continue}*$/u;
/**
* Whether a name can be emitted as a bare Python identifier rather than
* routed to the subscript/`dict[str, Any]` path.
*
* Python identifiers are not ASCII: `路径` is as legal a field name as `path`,
* and rejecting it would degrade the whole enclosing object, dropping every
* field's name, requiredness, and type — information whose only source under
* `mode: 'code'` is this generated text.
*
* NFKC stability is a second and separate condition, because CPython
* normalizes identifiers at compile time while JSON keys are compared as
* written: `ﬁeld` would be declared and reachable as `field`, so the SDK would
* advertise a key under a spelling the harness never accepts, and two keys
* that normalize together would collapse into one declaration. Those names
* take the subscript path, which carries their exact bytes.
*
* `IDENTIFIER` matches `str.isidentifier()` (measured on Node 22.23.1 vs
* CPython 3.9.6 tables): the equivalence holds inside the two versions' shared
* tables, and the skew characters below are exactly where that pair diverges.
* The predicate as a whole is deliberately stricter than `isidentifier()`,
* which does not test NFKC stability: `'ﬁeld'.isidentifier()` is True and
* this returns false.
*
* Both conditions are evaluated against the ENGINE's Unicode tables, and the
* two sides are versioned independently — `\p{XID_Start}`/`\p{XID_Continue}`
* follow the running engine (Node 22.23.1 reports Unicode 17.0) while CPython
* follows its own (3.9.6 reports 13.0.0). The skew is not symmetric. A CPython
* older than the engine is the dangerous direction: a character added to either
* property since its tables (U+10570 Vithkuqi and U+1E290 Toto, 14.0; U+1E4D0
* Nag Mundari, 15.0; U+1C89 Cyrillic TJE, 16.0 — ages per `DerivedAge.txt`; all
* four are NFKC-stable and accepted here, and all four are `Cn` on that 3.9.6,
* which rejects them) is emitted bare and its tokenizer refuses the character,
* taking the whole SDK block down — the same parseability invariant
* {@link UNPRINTABLE}, {@link LONE_SURROGATE} and {@link MAX_LIST_NESTING}
* exist for. Both properties carry it: a character added only to `XID_Continue`
* passes the trailing `\p{XID_Continue}*` in a tail position and fails the same
* way — U+200C ZWNJ and U+200D ZWJ are that case, gaining `XID_Continue` in UCD
* 15.1 and absent from it in 13.0.0, 14.0.0 and 15.0.0, so `a\u{200C}b` is
* emitted bare here while `isidentifier()` is False on 3.9.6 and on 3.12.13
* (15.0.0). A CPython newer than the engine only routes a legal name to the
* subscript/`dict[str, Any]` path: less readable, still correct. The NFKC
* condition reduces to the same skew, since normalization stability guarantees
* an assigned character's normalization never changes afterwards.
*
* This predicate is not the only reader of engine tables. {@link camelCase}
* reads them at three further points — its split set, its head test, and its
* `toUpperCase()` case mapping — and this predicate's verdict gates none of
* them: a class name derived there reaches emitted text whenever any object
* shape in the tool's schema declares a `TypedDict`, including for a tool this
* predicate rejected. A tool named `zz-\u{1E4D0}x` with such parameters never
* reaches the skew here (the `-` rejects it outright) yet emits `class
* Zz\u{1E4D0}xArgs`, which that same 3.9.6 refuses — Nag Mundari arrived two
* releases after its tables. The case mapping is a separate table rather than
* an XID membership test, and it fails on names both conditions above accept:
* `\u{019B}` is XID_Start and NFKC-stable, so this predicate accepts it and
* `async def \u{019B}` compiles on 3.9.6, but Node uppercases it to
* `\u{A7DC}` — unassigned in that CPython, whose own `.upper()` is the identity
* here — and the declared `class \u{A7DC}Args` fails with `invalid
* non-printable character U+A7DC`. Closing the exposure therefore covers all
* four read points, not this predicate alone; it needs the target interpreter's
* version, which the backend reporting `language: 'python'` owns; the
* language-dispatch Agent Note records the deferral.
*
* The `ts-types` sibling keeps its own ASCII rule rather than sharing this
* one: ECMAScript identifiers are a different set (`$`) and are never
* normalized, so one predicate cannot be correct for both. ZWJ/ZWNJ are not
* part of that difference — both sets carry them on the engine's tables; what
* separates the two there is the CPython table version above.
* @param name - the raw schema field or tool name.
* @returns whether the name can be emitted bare.
*/
function isBareIdentifier(name) {
	return IDENTIFIER.test(name) && name.normalize("NFKC") === name;
}
/**
* Python hard keywords: reserved everywhere, so a tool or field named
* ``class`` or ``lambda`` is legal on the wire but not as an attribute
* (``tools.class`` would be a SyntaxError in the model program) and not as a
* class-syntax `TypedDict` field. Such a tool renders under subscript access
* and such an object degrades to ``dict[str, Any]`` — the model still reaches
* every tool and field without collisions.
* Soft keywords (``match``, ``case``, ``type``, ``_`` — the language
* reference's whole set) are deliberately ABSENT: each is special in exactly
* one syntactic position — a statement head (``match``, ``type``), a ``match``
* statement's clause head (``case``), or a pattern (``_``) — so ``match: str``
* as a field and ``async def match(...)`` as a method are both legal, and
* including them would needlessly degrade common search/regex tool fields to
* ``dict[str, Any]``. Underscore-leading names are handled separately, not
* here: a non-dunder ``__token`` name-mangles, a dunder present on
* ``object``/``type`` resolves before the proxy hook, and implicit
* special-method lookup bypasses the hook.
*/
const RESERVED = /* @__PURE__ */ new Set([
	"False",
	"None",
	"True",
	"and",
	"as",
	"assert",
	"async",
	"await",
	"break",
	"class",
	"continue",
	"def",
	"del",
	"elif",
	"else",
	"except",
	"finally",
	"for",
	"from",
	"global",
	"if",
	"import",
	"in",
	"is",
	"lambda",
	"nonlocal",
	"not",
	"or",
	"pass",
	"raise",
	"return",
	"try",
	"while",
	"with",
	"yield",
	"__debug__"
]);
/** `typing` symbols this module may emit, in the deterministic import order. */
const TYPING_ORDER = [
	"Any",
	"Literal",
	"NotRequired",
	"Protocol",
	"TypedDict"
];
/** `indent`-deep line prefix (four spaces per level to match PEP 8 output). */
function pad(indent) {
	return "    ".repeat(indent);
}
/**
* The `Cc` code points that survive the whitespace collapse in {@link describe}
* and have no printable form: the C0 controls, DEL, and the C1 controls. Only
* U+0009 to U+000D are absent, because ECMAScript `\s` already collapsed them —
* `\s` is TAB/VT/FF/SP/NBSP/ZWNBSP/Zs plus LF/CR/LS/PS, so no C1 code point is
* in it and the whole U+0080 to U+009F block reaches this rule intact. Those
* are not hypothetical input: they are what Windows-1252 bytes 0x80 to 0x9F
* (smart quotes, em dash) become when decoded as Latin-1.
* CPython rejects source containing a NUL outright
* (`SyntaxError: source code string cannot contain null bytes`), whether it
* sits in a docstring or in a comment, so one such byte anywhere in a schema
* description would make the whole generated SDK unparseable — under
* `mode: 'code'`, the model's only declaration of the tools. The rest are
* legal but invisible; escaping them with the same rule keeps the emitted text
* readable and the treatment uniform.
*
* The boundary is the category, not per-code-point addressability: `\xNN`
* addresses U+0000 to U+00FF, so one escape form covers `Cc` exactly. The
* invisible `Cf` formatting characters pass through by design — of them only
* U+00AD soft hyphen would fit `\xNN` at all, and escaping that one while
* U+200B ZWSP, U+200E/U+200F bidi marks, and U+2060 word joiner passed through
* would leave a rule that is neither category- nor addressability-shaped. The
* whole family is legal in both consumers, since only LF and CR terminate a
* Python string literal or a `#` comment. That set is the tokenizer's, not
* `str.splitlines()`': NEL (U+0085), LS (U+2028), and PS (U+2029) split a
* string at run time but do not end a physical line in source — measured on
* CPython 3.9.6 and 3.12.13, each accepted in both positions with the value
* round-tripping — so they are safe raw wherever they reach emitted text
* unescaped, which for all three is `JSON.stringify`, at two call sites:
* {@link pyScalar}'s literal path, and the subscript tool-name comment's own
* call, which a name carrying any of them always reaches, none being
* `XID_Continue`. The `description` path escapes NEL under the class above and
* folds LS and PS in {@link describe}'s `\s+` collapse, both being `\s`.
*/
const UNPRINTABLE = /[\u0000-\u0008\u000e-\u001f\u007f-\u009f]/g;
/**
* Unpaired surrogate code points, escaped by {@link describe} as `\uNNNN` —
* its own form, since `\xNN` stops at U+00FF. The `u` flag is what makes this
* the LONE ones: in Unicode mode a well-formed pair is a single astral code
* point outside D800 to DFFF, so an emoji in a description survives untouched.
*
* This is the NUL case from {@link UNPRINTABLE}, not the invisible-character
* case. Python source must be UTF-8-encodable and a lone surrogate is not, so
* `compile()` raises `UnicodeEncodeError: surrogates not allowed` for one
* anywhere in the text — measured on 3.9 for a string literal and for a `#`
* comment alike. A raw or MCP tool description reaches this: `JSON.parse` on a
* wire `"\ud800"` escape yields exactly such a code point.
*/
const LONE_SURROGATE = /[\ud800-\udfff]/gu;
/**
* The collapsed one-line `description` of a schema node (byte-stable across
* formatting churn), or `undefined` when the node carries none. Every caller
* passes an object — a validated property node, the `ToolSdkSchema` itself, or
* the `{ description }` wrapper {@link docLines} synthesizes — so only the
* description field needs guarding. A description that collapses
* to nothing (empty, or whitespace only) is `undefined` too: it documents the
* node no better than an absent one, and emitting it would leave an empty
* `"""` docstring or a bare `#   ` line in the SDK. Only ECMAScript whitespace
* folds, so a description of whitespace plus one surviving control character is
* NOT absent: it collapses to that character's visible escape.
*
* Control characters left over after the whitespace collapse are rendered as
* their `\xNN` escapes (see {@link UNPRINTABLE}) and unpaired surrogates as
* their `\uNNNN` escapes (see {@link LONE_SURROGATE}); the escape's own backslash is
* emitted literally by both consumers, since {@link docLines} doubles it into a
* Python source escape and a `#` comment carries it verbatim.
*/
function describe(schema) {
	const description = schema.description;
	if (typeof description !== "string") return void 0;
	const collapsed = description.replace(/\s+/g, " ").replace(UNPRINTABLE, (char) => `\\x${char.charCodeAt(0).toString(16).padStart(2, "0")}`).replace(LONE_SURROGATE, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`).trim();
	return collapsed.length === 0 ? void 0 : collapsed;
}
/**
* One-line docstring for a tool `description`, or no lines when there is none.
* Backslashes are doubled first, every quote is escaped, and a trailing
* backslash cannot survive: a description ending in `"` or an odd backslash
* would otherwise merge with (or escape) the closing triple quote and make
* the generated block — Code Mode's only SDK — syntactically invalid Python.
*/
function docLines(description, indent) {
	const collapsed = describe({ description });
	if (collapsed === void 0) return [];
	const escaped = collapsed.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"");
	return [`${pad(indent)}"""${escaped}"""`];
}
/**
* CamelCase a name into a Python type identifier: non-identifier characters
* split words, `_` splits too (it is `XID_Continue`, so the split set names it
* explicitly), and a head that cannot start an identifier takes a `Tool`
* prefix. Unicode survives, so a `路径` field yields `路径`-based class names
* instead of collapsing to the bare prefix. A character that is not
* `XID_Continue` splits even when it is a letter, so a name whose NFKC folding
* would leave the identifier set is not carried through — the split set is the
* grammar's, not an ASCII approximation of it.
*
* The result is NFKC-normalized: these names are generated, never matched
* against a JSON key, so normalizing is free here and keeps what CPython
* compiles identical to what is emitted — unlike {@link isBareIdentifier},
* which must reject unstable names outright. Normalizing AFTER the prefix
* decision is what makes that hold at the seam the prefix creates: `Tool` +
* a combining-mark head composes there (`U+0301` gives `Tooĺ`, U+013A), so
* normalizing only the un-prefixed part would emit a name CPython compiles to
* a different symbol. The second call is idempotent on the un-prefixed arm.
*
* The split set, the head test, and `toUpperCase()` all read the engine's
* Unicode tables, so this function carries the same version skew
* {@link isBareIdentifier} documents, by paths independent of it: a class name
* derived here reaches emitted text whenever any object shape in the tool's
* schema declares a `TypedDict`, and the predicate's verdict on the tool name
* does not gate that. The case mapping is the one that can fail on a name the
* predicate accepted; the worked example is there.
* @param raw - the schema field or tool name to derive from.
* @returns a class-name segment safe to emit.
*/
function camelCase(raw) {
	const joined = raw.split(/[^\p{XID_Continue}]+|_+/u).filter((part) => part.length > 0).map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`).join("").normalize("NFKC");
	return (/^\p{XID_Start}/u.test(joined) ? joined : `Tool${joined}`).normalize("NFKC");
}
/** Class-name base cap keeping each emitted name — and total text — linear in schema depth. */
const MAX_CLASS_NAME_BASE = 120;
/**
* Deepest `list[…]` nesting emitted into one annotation before the item type
* degrades to `Any`. CPython's tokenizer rejects a logical line holding more
* than 200 simultaneously-open brackets (`MAXLEVEL`, `SyntaxError: too many
* nested parentheses`), so an array chain deeper than that would render an SDK
* block that is not valid Python at all — the same failure the docstring
* escaping in {@link docLines} exists to prevent. 180 leaves headroom for the
* few brackets an annotation can add around the chain, all of which count
* toward the same limit. Per emission site, counting brackets open at the
* chain's innermost point:
*
* - Return annotation, `async def f(self, args: X) -> chain:` — 180 `list[`
*   plus an innermost `Literal[`. The parameter list's `(` closed at the `)`
*   before the `->`, so it is NOT open here: 181.
* - TypedDict field, `field: NotRequired[chain]` — a class-body line with no
*   other open bracket, and its children start at `listDepth: 1` to reserve
*   the `NotRequired[`, so 179 `list[` plus `Literal[`: 181. Required fields
*   share that start for uniformity, spending one level of representable depth
*   on a bracket they never emit.
* - Argument annotation, `async def f(self, args: chain) -> Y:` — the `(` IS
*   still open around it: 180 `list[` plus `Literal[` plus the paren, 182, the
*   worst case. Reachable only through a raw `register()` whose `parameters`
*   is an array reached from the root through `oneOf` arms alone — the root
*   array itself, or one nested under any depth of unions, since an arm
*   inherits the enclosing depth unchanged (`A | B` opens no bracket). An
*   object ancestor takes it out of this case: its fields restart the chain at
*   the 181 site. `defineTool` compiles an object root, so the annotation is a
*   bare TypedDict class name or a one-bracket `dict[str, Any]` when that
*   object degrades — never a chain.
*
* A CPython grammar limit, not a deployment choice, so it is fixed rather than
* configurable. The sibling `ts-types` renderer needs no counterpart: nothing
* in the TypeScript grammar bounds nesting, and its SDK block is never type-
* checked. Only bracket nesting counts — a `oneOf` renders as a flat `A | B`
* chain and nested objects render as separate `class` statements, so neither
* accumulates open brackets at any depth. The invariant this cap serves is
* grammatical validity; see the `oneOf` arm in {@link renderType} for the one
* interpreter limit deliberately left uncapped.
*/
const MAX_LIST_NESTING = 180;
/**
* Cap a class-name base at {@link MAX_CLASS_NAME_BASE} (see the callers for
* why capping keeps the render linear). `slice` counts UTF-16 code units, so
* an astral character straddling the boundary would be cut in half and leave a
* lone surrogate — not an identifier character, and not even well-formed text;
* drop it rather than emit it.
*/
function capClassNameBase(base) {
	if (base.length <= MAX_CLASS_NAME_BASE) return base;
	const capped = base.slice(0, MAX_CLASS_NAME_BASE);
	return /[\uD800-\uDBFF]$/.test(capped) ? capped.slice(0, -1) : capped;
}
/**
* Reserve a unique class name from a base, suffixing `2`, `3`, … on collision.
* The base is capped at {@link MAX_CLASS_NAME_BASE} first: child class names
* derive from their parent's allocated name (`ParentChild`), so an unbounded
* schema of single-field objects would otherwise grow each name by one field
* per level and the sum of all names to Θ(depth²). Capping the base keeps each
* name — and the total emitted text — linear in depth. Collisions resume from
* the per-base counter in `state.nextClassCounter` rather than rescanning from
* `2`, so a deep chain sharing one capped base stays O(1) per allocation
* (amortized) instead of Θ(depth²) in time.
*/
function allocateClassName(base, state) {
	const capped = capClassNameBase(base);
	let name = capped;
	if (state.usedClassNames.has(name)) {
		let n = state.nextClassCounter.get(capped) ?? 2;
		while (state.usedClassNames.has(`${capped}${n}`)) n++;
		name = `${capped}${n}`;
		state.nextClassCounter.set(capped, n + 1);
	}
	state.usedClassNames.add(name);
	return name;
}
/**
* Append a child-name segment to a parent class-name base, capping the result
* at {@link MAX_CLASS_NAME_BASE}. Capping AT PROPAGATION (not only inside
* {@link allocateClassName}) keeps each level O(1): a deep `oneOf`- or
* object-chain would otherwise carry an ever-growing ConsString down the tree
* and re-materialize it (via `.length`/`.slice`) at every level — Θ(depth²).
* The bounded base plus the collision counter still yields unique names.
*
* The join is NFKC-normalized because both sides are separately normalized yet
* their concatenation need not be: a base ending in a Hangul L jamo or LV
* syllable composes with a following V or T jamo head (`가` + `ᆨ` gives `각`),
* so the emitted class name would differ from the symbol CPython compiles, and
* two byte-distinct names could fold onto one — `usedClassNames` dedupes by the
* raw bytes, so the collision counter would not see it. Normalizing costs
* O(cap + segment) per level, the same order as the `slice` it feeds. The other
* two join points need no counterpart: `Args`/`Output` start with `A`/`O` and
* {@link allocateClassName}'s suffix is digits, none of which compose backwards.
*/
function childClassName(base, segment) {
	return capClassNameBase(`${base}${segment}`.normalize("NFKC"));
}
/**
* Render one validated scalar as Python literal text (`True`/`False`,
* JSON-quoted strings, bare numbers). `null` cannot reach here: the `null`
* type renders directly as `None`, and the unified validator rejects a null
* `const`/`enum` entry on every other scalar type.
*
* A beyond-safe-range integral number takes `BigInt` digits rather than
* `String`: Python integers are arbitrary-precision, so the emitted digits ARE
* the value the model programs against, and `String` can give a different
* integer than the double holds (`2 ** 60` prints the rounded `...847000`, not
* the exact `...846976`) or no integer literal at all (`1e21` prints `1e+21`).
* `String`'s rounding is not a bug in it: `Number::toString` emits the shortest
* decimal string that re-reads to the same double, then pads to the exponent
* with zeros (1 significant digit for `1e20`, 16 for `2 ** 60`) — and when the
* shortest string is shorter than the double's exact value, those padded digits
* name an integer no double holds. Passing one back would have to cross the
* argument boundary as a JSON number — a double again — so the SDK would
* document a value no program can pass. `BigInt` needs no case split: where
* `String` is already exact (`2 ** 53`, `1e20`) the two agree byte for byte,
* and where it is not, `BigInt` is the exact one. The TS flavor needs no
* counterpart at all: its literal is re-read by a JS parser back into the same
* double.
*
* `JSON.stringify` is also what keeps this path's output parseable, and it is
* the only thing that does. It covers both classes of hazard: the two kinds of
* code point CPython refuses anywhere in source — NUL among the C0 controls,
* and the whole D800–DFFF unpaired-surrogate block, escaped under ES2019
* well-formed stringification, which the engines range guarantees — and the
* ones that break this line in particular, a bare `"` closing the literal
* early, a trailing odd backslash eating the closing quote, and a bare LF/CR
* ending it before its terminator. The `description` path carries
* {@link UNPRINTABLE} and {@link LONE_SURROGATE} because nothing quotes it,
* and folds newlines in {@link describe}.
*
* That leans on a coincidence worth naming: every escape `JSON.stringify` can
* emit (`\"`, `\\`, `\b`, `\f`, `\n`, `\r`, `\t`, `\uXXXX`) is also a Python
* escape denoting the same character, so the emitted `Literal[...]` both
* parses and decodes back to the value the schema declared. DEL, the C1
* controls (NEL among them), and LS/PS (U+2028/U+2029) do reach it raw —
* legal but invisible, byte-for-byte as in the TS flavor; escaping them is a
* both-flavors change. Those last three are legal here for the reason
* {@link UNPRINTABLE} records: they are `str.splitlines()` boundaries, not
* tokenizer line terminators. The subscript tool-name comment quotes its name
* through its own call to the same `JSON.stringify`, never through this
* function, and inherits both halves — escapes and pass-throughs alike.
*/
function pyScalar(value) {
	if (value === true) return "True";
	if (value === false) return "False";
	if (typeof value === "string") return JSON.stringify(value);
	if (typeof value === "number" && Number.isInteger(value) && !Number.isSafeInteger(value)) return BigInt(value).toString();
	return String(value);
}
/**
* Render a validated scalar `const`/`enum` as `Literal[...]`, falling back to
* the broad type. Deliberately deviates from PEP 586, which restricts `Literal`
* parameters to int/bool/str/bytes/enum/None: a non-integral number
* `const`/`enum` emits a float literal (`Literal[1.5]`) a strict checker would
* reject. An integral one does not deviate — {@link pyScalar} emits int digits,
* including for the beyond-safe-range values it widens through `BigInt`, and
* PEP 586 admits int parameters. Harmless either way — the stub is advisory
* prompt text, only required to parse — and keeping the exact value
* communicates the constraint to the model.
*/
function renderConstrainedScalar(node, broad, state) {
	if (node.const !== void 0) {
		state.typing.add("Literal");
		return `Literal[${pyScalar(node.const)}]`;
	}
	if (node.enum !== void 0) {
		state.typing.add("Literal");
		return `Literal[${node.enum.map(pyScalar).join(", ")}]`;
	}
	return broad;
}
/**
* Map one JSON-Schema node to a Python type expression, threading `state` to
* collect the `TypedDict` declarations and `typing` symbols a full render
* needs. `className` is the name to give an object node with properties (and
* the prefix for its nested objects). Handles every unified schema construct —
* `oneOf` (→ `X | Y`), `const`/`enum` (→ `Literal[...]`), `integer` (→ `int`),
* `null` (→ `None`) — and degrades an unsupported or malformed schema to `Any`
* without throwing, the same trusted-after-validation stance as the sibling
* {@link ./ts-types.ts | ts-types} renderer. {@link jsonSchemaToPy} is the
* context-free entry point; this is the collecting core.
*/
function renderType(schema, className, state) {
	const newFrame = (schema, className, listDepth) => ({
		schema,
		className,
		phase: "start",
		listDepth,
		children: [],
		childIndex: 0,
		childTypes: [],
		entries: []
	});
	try {
		assertSupportedJsonSchema(schema);
		const frames = [newFrame(schema, className, 0)];
		let result;
		const finish = (type) => {
			frames.pop();
			const parent = frames.at(-1);
			if (parent === void 0) result = type;
			else parent.childTypes.push(type);
		};
		while (frames.length > 0) {
			const frame = frames.at(-1);
			/* v8 ignore next -- the loop condition guarantees a current frame. */
			if (frame === void 0) break;
			if (frame.phase === "children") {
				if (frame.childIndex < frame.children.length) {
					const child = frame.children[frame.childIndex];
					/* v8 ignore next -- childIndex is bounded by children.length. */
					if (child === void 0) throw new Error("missing python render child");
					frame.childIndex++;
					frames.push(newFrame(child.schema, child.className, child.listDepth));
					continue;
				}
				if (frame.kind === "oneOf") {
					let union = "";
					for (const [index, childType] of frame.childTypes.entries()) union = index === 0 ? childType : `${union} | ${childType}`;
					finish(union);
					continue;
				}
				if (frame.kind === "array") {
					/* v8 ignore next -- the ?? arm needs a childless array frame, which start never builds. */
					finish(`list[${frame.childTypes[0] ?? "Any"}]`);
					continue;
				}
				const node = frame.node;
				const name = frame.allocated;
				/* v8 ignore next -- typeddict frames always set node and allocated at start. */
				if (node === void 0 || name === void 0) throw new Error("missing typeddict frame state");
				const required = new Set(node.required);
				const lines = [`class ${name}(TypedDict):`];
				for (let index = 0; index < frame.entries.length; index++) {
					const entry = frame.entries[index];
					const fieldType = frame.childTypes[index];
					/* v8 ignore next -- entries and childTypes correspond one-to-one. */
					if (entry === void 0 || fieldType === void 0) throw new Error("missing typeddict field type");
					const [field, fieldSchema] = entry;
					const description = describe(fieldSchema);
					if (description !== void 0) lines.push(`${pad(1)}# ${description}`);
					if (required.has(field)) lines.push(`${pad(1)}${field}: ${fieldType}`);
					else {
						state.typing.add("NotRequired");
						lines.push(`${pad(1)}${field}: NotRequired[${fieldType}]`);
					}
				}
				if (node.additionalProperties !== false) lines.push(`${pad(1)}# Additional keys beyond those declared are allowed.`);
				if (lines.length === 1) lines.push(`${pad(1)}pass`);
				state.classes.push(lines.join("\n"));
				finish(name);
				continue;
			}
			frame.phase = "children";
			const node = frame.schema;
			if (node.oneOf !== void 0) {
				frame.kind = "oneOf";
				frame.children = node.oneOf.map((branch, index) => ({
					schema: branch,
					className: childClassName(frame.className, `${index + 1}`),
					listDepth: frame.listDepth
				}));
				continue;
			}
			if (node.type === void 0) {
				state.typing.add("Any");
				finish("Any");
				continue;
			}
			switch (node.type) {
				case "string":
					finish(renderConstrainedScalar(node, "str", state));
					break;
				case "number":
					finish(renderConstrainedScalar(node, "float", state));
					break;
				case "integer":
					finish(renderConstrainedScalar(node, "int", state));
					break;
				case "boolean":
					finish(renderConstrainedScalar(node, "bool", state));
					break;
				case "null":
					finish("None");
					break;
				case "array":
					if (node.items === void 0) {
						state.typing.add("Any");
						finish("list[Any]");
						break;
					}
					if (frame.listDepth >= MAX_LIST_NESTING) {
						state.typing.add("Any");
						finish("Any");
						break;
					}
					frame.kind = "array";
					frame.children = [{
						schema: node.items,
						className: frame.className,
						listDepth: frame.listDepth + 1
					}];
					break;
				case "object": {
					const entries = Object.entries(node.properties ?? {});
					if (className === "" || !entries.every(([name]) => isBareIdentifier(name) && !RESERVED.has(name) && !(name.startsWith("__") && !name.endsWith("__")))) {
						state.typing.add("Any");
						finish("dict[str, Any]");
						break;
					}
					if (entries.length === 0 && node.additionalProperties !== false) {
						state.typing.add("Any");
						finish("dict[str, Any]");
						break;
					}
					frame.kind = "typeddict";
					frame.node = node;
					frame.allocated = allocateClassName(frame.className, state);
					state.typing.add("TypedDict");
					frame.entries = entries;
					/* v8 ignore next -- allocated is always set before children are built. */
					frame.children = entries.map(([field, child]) => ({
						schema: child,
						className: childClassName(frame.allocated ?? "", camelCase(field)),
						listDepth: 1
					}));
					break;
				}
				/* v8 ignore next 4 -- assertSupportedJsonSchema narrowed this closed type union. */
				default:
					state.typing.add("Any");
					finish("Any");
			}
		}
		/* v8 ignore next -- every root frame produces one expression. */
		return result ?? "Any";
	} catch {
		state.typing.add("Any");
		return "Any";
	}
}
/** The fixed model-facing usage contract rendered above the declarations. */
const SDK_INSTRUCTIONS = `## Writing code for run_code

\`run_code\` takes two required arguments: \`code\` — the body of an async Python function (top-level \`await\` and \`return\` both work) — and \`description\`, a short summary of what the program does. At run time exactly two of the names declared below are bound: \`tools\` and \`ToolCallError\`. Everything else is a STATIC STUB describing argument and return types — in particular the \`TypedDict\` classes do NOT exist at run time, so build arguments as plain \`dict\`/\`list\` JSON values: \`await tools.name({"field": 1})\`, never \`FooArgs(field=1)\`, which raises \`NameError\`. Inside the program:

- Call tools as \`await tools.name(args)\` — subscript access for exotic, reserved, or underscore-leading names: \`await tools["my-tool"](args)\`. Every call resolves to the tool's typed canonical JSON value (each method's return type below). Tool arguments must be lossless JSON.
- A FAILED tool call raises \`ToolCallError\`, whose \`toolName\` identifies the failed tool and whose message is human-readable — wrap in \`try/except\` to handle and continue.
- Independent read-only calls MAY overlap under \`asyncio.gather\` (safe calls run concurrently; mutating calls run alone, in submission order). Sequence dependent work with \`await\`.
- Emit the run's answer with \`print(...)\` and/or a top-level \`return <value>\`; the returned value must be lossless JSON. ONLY what you print and the returned value come back — intermediate tool results never enter the conversation, so extract just what you need.

The available tools:`;
/**
* Render the full `tools:sdk` prompt section under `runtime.language ===
* 'python'`: the Python-flavored usage instructions plus one named `TypedDict`
* per tool argument or output object (and per nested object) and one awaitable
* method per visible tool on a `Tools` protocol — typed args in, the tool's
* canonical output value out — with a `tools: Tools` singleton the model calls
* into. The `typing` import line lists exactly the symbols the render used.
* Deterministic — tools are emitted in lexicographic name order, and class
* declarations precede the protocol in that same order (nested classes before
* the parent that references them), so an unchanged tool set produces
* byte-identical text across assemblies. The sort is not a total order on
* byte-equal names, so two schemas sharing a name would render in argument
* order; the caller's visible-capability map is keyed by name, so the input
* never carries a duplicate.
* @param schemas - the tool schemas plus canonical output schemas to declare
*   (the caller excludes `run_code` itself).
* @returns the complete section text.
*/
function renderToolsSdkPy(schemas) {
	const sorted = [...schemas].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
	const state = {
		classes: [],
		usedClassNames: /* @__PURE__ */ new Set(),
		nextClassCounter: /* @__PURE__ */ new Map(),
		typing: /* @__PURE__ */ new Set(["Protocol"])
	};
	const members = [];
	let statements = 0;
	for (const schema of sorted) {
		const argType = renderType(schema.parameters, `${camelCase(schema.name)}Args`, state);
		const outputType = renderType(schema.output, `${camelCase(schema.name)}Output`, state);
		if (isBareIdentifier(schema.name) && !RESERVED.has(schema.name) && !schema.name.startsWith("_")) {
			const doc = docLines(schema.description, 2);
			members.push(doc.length > 0 ? `${pad(1)}async def ${schema.name}(self, args: ${argType}) -> ${outputType}:` : `${pad(1)}async def ${schema.name}(self, args: ${argType}) -> ${outputType}: ...`);
			members.push(...doc);
			statements += 1;
		} else {
			members.push(`${pad(1)}# tools[${JSON.stringify(schema.name)}](args: ${argType}) -> ${outputType}`);
			const description = describe(schema);
			if (description !== void 0) members.push(`${pad(1)}#   ${description}`);
		}
	}
	const body = (statements > 0 ? members : [`${pad(1)}pass`, ...members]).join("\n");
	const imports = TYPING_ORDER.filter((symbol) => state.typing.has(symbol));
	const classBlock = state.classes.length > 0 ? `${state.classes.join("\n\n")}\n\n` : "";
	return `${SDK_INSTRUCTIONS}\n\n\`\`\`python\n${`from typing import ${imports.join(", ")}\n\nclass ToolCallError(Exception):
    toolName: str\n\n${classBlock}class Tools(Protocol):\n${body}\n\ntools: Tools`}\n\`\`\``;
}
/**
* Tool registry, model presentation modes, and pre/guard/around/post/result
* execution pipeline.
* @module @deepseek-ai/dsh-tools
*/
/**
* Language → SDK-section renderer. The registry looks up the loaded
* `ctx.codeRuntime.language` in this table when assembling the `tools:sdk`
* section under a non-native mode; a runtime whose language is not a key
* fails the assembly loudly (same idiom as `toolOrder` violations). Adding a
* new backend language is three parallel edits — a {@link CodeSdkLanguage}
* member, an entry here, and a `RUN_CODE_FLAVORS` entry in `code-mode.ts` for
* its `run_code` schema strings — plus the renderer function this table points
* at. The `satisfies` clause pins this table's key set to that union, which
* the flavor table is checked against too, so any of the three left out is a
* typecheck failure. What no check reaches is the prose that names the values
* instead of deriving them: the seam's `dsh-code-runtime` README pair, its
* `CodeRuntime.language` JSDoc, and `docs/subsystems/code-runtime.md`
* with its zh pair, plus this package's own README pair and the
* {@link Config.mode} JSDoc.
*/
/**
* Prompt order of the `code` collapse statement: after the persona and before
* the 100-199 per-tool guidance band, so the model reads which tools it may
* call before it reads what each one is for.
*/
const COLLAPSE_SECTION_ORDER = 99;
/**
* The model-facing statement of the `code` collapse. Names the consequence
* (the call fails) and the route (inside the program), because a rule the
* model can only discover by being denied is one it corrects too late.
*/
const CODE_ONLY_INSTRUCTION = `\`${RUN_CODE_NAME}\` is the only tool you can call directly — a tool call naming any other tool fails. Reach every tool the SDK declares below from inside the program.`;
const SDK_RENDERERS = {
	typescript: renderToolsSdk,
	python: renderToolsSdkPy
};
/**
* Scheduler entry point omitted from the generated named service API.
* @internal
*/
const TOOL_RUNTIME_SCHEDULER = Symbol("@deepseek-ai/dsh-tools.scheduler");
/** Canonical error code for cancellation after a tool body was invoked. */
const TOOL_ABORTED = "ABORTED";
/** Canonical error code for cancellation before a tool body was invoked. */
const TOOL_ABORTED_BEFORE_DISPATCH = "ABORTED_BEFORE_DISPATCH";
/**
* Thrown (internally) when the model requests a tool that isn't registered.
* Extends {@link HarnessError} (`code: 'UNKNOWN_TOOL'`) so an unknown-tool
* failure is as routable as a tool-thrown one — retry/sandbox/replay code can
* distinguish it from a tool body's own error.
*/
var ToolNotFoundError = class extends HarnessError {
	/**
	* @param toolName - the name the caller asked for.
	* @param reachableFrom - how the model reaches this tool instead, when the
	*   name IS visible and only the presentation denies calling it directly.
	*   Omitted for a name that is registered nowhere.
	*/
	constructor(toolName, reachableFrom) {
		super(reachableFrom === void 0 ? `unknown tool "${toolName}"` : `unknown tool "${toolName}": ${reachableFrom}`, "UNKNOWN_TOOL");
		this.name = "ToolNotFoundError";
	}
};
/** Thrown when a tool body or post-policy value violates its declared output. */
var ToolOutputError = class extends HarnessError {
	/** Schema/value violations in validation order. */
	violations;
	constructor(toolName, violations) {
		super(`tool "${toolName}" returned invalid output: ${violations.join("; ")}`, "INVALID_TOOL_OUTPUT");
		this.name = "ToolOutputError";
		this.violations = violations;
	}
};
/** Convert one projector exception into the canonical invalid-output failure. */
function projectionError(toolName, projector, error) {
	return new ToolOutputError(toolName, [`output.${projector} failed: ${errorMessage(error)}`]);
}
/** Snapshot one projector result before later durable-result materialization. */
function snapshotProjection(toolName, projector, candidate) {
	try {
		const detached = snapshotJsonValue(candidate);
		if (detached === void 0) throw new ToolOutputError(toolName, [`output.${projector} returned non-lossless JSON`]);
		return detached;
	} catch (error) {
		if (error instanceof ToolOutputError) throw error;
		throw projectionError(toolName, projector, error);
	}
}
/** Snapshot one body or policy value into the canonical invalid-output failure class. */
function snapshotToolValue(toolName, candidate) {
	try {
		const detached = snapshotJsonValue(candidate);
		if (detached === void 0) throw new ToolOutputError(toolName, ["value is not lossless JSON"]);
		return detached;
	} catch (error) {
		if (error instanceof ToolOutputError) throw error;
		throw new ToolOutputError(toolName, [`value snapshot failed: ${errorMessage(error)}`]);
	}
}
/**
* Best-effort human-readable message from an arbitrary thrown value: Error
* instances use `.message`; non-Error objects with a string `message`
* property (e.g. `throw { message: 'denied' }`) use it too; everything else
* is stringified.
*/
function errorMessage(error) {
	try {
		if (error instanceof Error) return error.message;
		if (typeof error === "object" && error !== null && "message" in error && typeof error.message === "string") return error.message;
		return String(error);
	} catch {
		return "<unprintable thrown value>";
	}
}
/** Derive one failure message from policy feedback without changing its rendered blocks. */
function failureMessageFromContent(content) {
	const text = content.map((block) => block.type === "text" ? block.text : `[${block.type} content]`).join("\n");
	return text.length > 0 ? text : "tool result blocked by post-execute policy";
}
/** Snapshot and freeze one durable tool-result projection or reject lossy data. */
function materializePresentation(candidate) {
	const detached = snapshotJsonValue(candidate);
	if (detached === void 0) throw new TypeError("tool result must be losslessly JSON-serializable");
	return deepFreeze(detached);
}
/** Structured `{ name, code }` for a thrown HarnessError, else undefined. */
function errorInfo(error) {
	try {
		return error instanceof HarnessError ? {
			name: error.name,
			code: error.code
		} : void 0;
	} catch {
		return;
	}
}
/** One scope's complete tool-registry contribution. */
var ToolLayer = class {
	tools;
	restrictions = new AnonymousEntries();
	guards = new AnonymousEntries();
	/**
	* Presentation this scope's agent declared for itself, shadowing the
	* deployment default. One cell rather than an entry table: two answers to
	* "which form does the model see" is a contradiction, not a merge.
	*/
	mode;
	constructor(scope) {
		this.tools = new NamedEntries((name) => /* @__PURE__ */ new Error(scope === void 0 ? `tool "${name}" is already registered (for a per-agent variant, register through that agent's \`agent.ctx\` instead)` : `tool "${name}" is already registered in this scope`));
	}
	/** Whether every contribution table in this aggregate layer is empty. */
	isEmpty() {
		return this.tools.isEmpty() && this.restrictions.isEmpty() && this.guards.isEmpty() && this.mode === void 0;
	}
	/** Whether every compiled restriction in this layer admits a global tool name. */
	admits(name) {
		for (const filter of this.restrictions.values()) if (filter.allow !== void 0 && !filter.allow.has(name) || filter.deny !== void 0 && filter.deny.has(name)) return false;
		return true;
	}
	/** First monotonic denial from this layer's live guard registrations. */
	guardReason(exec) {
		for (const guard of this.guards.values()) {
			const reason = guard(exec);
			if (reason !== void 0) return reason;
		}
	}
};
/** Resolve the run_code overlap cap at the owning config boundary (direct construction bypasses the Loader schema). */
function resolveMaxParallelSubCalls(value) {
	const maxParallelSubCalls = value ?? 10;
	if (!Number.isInteger(maxParallelSubCalls) || maxParallelSubCalls < 1) throw new Error("maxParallelSubCalls must be a positive integer");
	return maxParallelSubCalls;
}
(class extends Service {
	static inject = ["systemPrompt"];
	static Config = Schema.object({
		mode: Schema.union([
			"native",
			"code",
			"both"
		]).default("native"),
		maxParallelSubCalls: Schema.natural().min(1).default(10)
	});
	/** Internal staged view consumed by `dsh-agent-loop`'s parallel scheduler. */
	[TOOL_RUNTIME_SCHEDULER] = {
		prepare: (exec) => this.prepareScheduledExecution(exec),
		dispatch: (exec) => this.dispatchScheduledExecution(exec),
		finalize: (exec, result) => this.finalizeScheduledExecution(exec, result),
		finish: (exec, result) => this.finishScheduledExecution(exec, result)
	};
	/** Context deferred by a running tool body, keyed by its scheduler-owned execution. */
	deferredContexts = /* @__PURE__ */ new WeakMap();
	/** Executions whose tool body declared the current turn complete. */
	concludingExecutions = /* @__PURE__ */ new WeakSet();
	/** Original caller cancellation, kept outside the wrapper-mutable execution object. */
	cancellationStates = /* @__PURE__ */ new WeakMap();
	/** Definition-owned final content transform snapshotted before policy begins. */
	contentFinalizers = /* @__PURE__ */ new WeakMap();
	layers = new ScopedLayers((scope) => new ToolLayer(scope), () => {
		this.ctx.emit("tools/change");
	});
	/** Presentation for scopes that declare none; {@link presentAs} shadows it per scope. */
	defaultMode;
	maxParallelSubCalls;
	/**
	* Reserved presentation transport, kept outside the filterable registration
	* layers. Built on first need rather than at construction: which agents run
	* a code mode is no longer known when the service is constructed, and the
	* transport is stateless beyond its closures over `this`.
	*/
	codeTransport;
	constructor(ctx, config = {}) {
		super(ctx, "tools");
		this.defaultMode = config.mode ?? "native";
		this.maxParallelSubCalls = resolveMaxParallelSubCalls(config.maxParallelSubCalls);
		ctx.systemPrompt.tools((context) => this.wireSchemas(context.scope));
		if (this.defaultMode !== "native") {
			ctx.systemPrompt.section(this.collapseSection());
			ctx.systemPrompt.section(this.sdkSection());
		}
	}
	/**
	* The prompt statement of the `code` executor collapse, registered wherever
	* {@link sdkSection} is and rendering empty outside an effective `code`.
	*
	* Every tool contributes its own guidance section naming its tool, none of
	* them qualify how that tool is reached, and they all render before the SDK
	* (orders 100-199 against {@link SDK_SECTION_ORDER}). Without this the model
	* reads a catalog of tools it is told to use and no statement that only
	* `run_code` may be called, so it emits a native call, receives
	* `UNKNOWN_TOOL` for a tool the prompt just declared, and concludes the
	* deployment is inconsistent. {@link COLLAPSE_SECTION_ORDER} places the rule
	* before that guidance rather than after it.
	*
	* `both` renders empty: native calls do execute there, so the rule is false.
	* @returns the section registration.
	*/
	collapseSection() {
		return {
			name: "tools:code-only",
			order: COLLAPSE_SECTION_ORDER,
			text: (context) => this.modeFor(context.scope) === "code" ? CODE_ONLY_INSTRUCTION : ""
		};
	}
	/**
	* The generated-SDK prompt section, registered globally by a code-mode
	* deployment and per scope by {@link presentAs}.
	*
	* The body regenerates from the CALLING scope, and renders empty for an
	* agent presenting natively — an agent that opted out under a code-mode
	* deployment still sees the global registration, and an empty section is
	* dropped from the rendered prompt.
	* @returns the section registration.
	*/
	sdkSection() {
		return {
			name: "tools:sdk",
			order: 150,
			text: (context) => {
				const mode = this.modeFor(context.scope);
				if (mode === "native") return "";
				const runtime = this.requireCodeRuntime(mode);
				const render = SDK_RENDERERS[runtime.language];
				/* v8 ignore next -- requireCodeRuntime rejects an unknown language before this runs. */
				if (render === void 0) throw new Error(`dsh-tools: no SDK renderer for ${runtime.language}`);
				return render(this.sdkSchemas(context.scope));
			}
		};
	}
	/**
	* The presentation one scope's agent sees: its own declaration, else the
	* deployment default.
	* @param scope - the calling agent, or undefined for the global view.
	* @returns the resolved presentation mode.
	*/
	modeFor(scope) {
		const layers = this.layers.chainLayers(scope);
		for (let index = layers.length - 1; index >= 0; index -= 1) {
			const mode = layers[index]?.mode;
			if (mode !== void 0) return mode;
		}
		return this.defaultMode;
	}
	/**
	* The reserved `run_code` transport, built on first need.
	*
	* It never enters the global layer: per-agent restrictions must not remove
	* it, and a scoped registration must not shadow it. The visibility resolver
	* appends it after resolving the filterable global/scoped capability layers,
	* and only for scopes whose mode actually presents it.
	* @returns the shared transport definition.
	*/
	requireCodeTransport() {
		this.codeTransport ??= createRunCodeTool(this, {
			requireRuntime: () => this.requireCodeRuntime(this.defaultMode),
			peekRuntime: () => this.ctx.get("codeRuntime"),
			maxParallel: this.maxParallelSubCalls,
			shapeDispatchLog: (dispatch) => this.shapeDispatchLog(dispatch)
		});
		return this.codeTransport;
	}
	/**
	* Present the calling scope's tools in `mode` instead of the deployment
	* default. Nearest scope on the chain wins, so a preset's standing
	* declaration covers every agent joined under it.
	*
	* Scoped only, and one declaration per scope: this is how an agent preset
	* composes Code Mode agents beside native ones in the same process, and a
	* process-global override would be the `mode` config field instead.
	* @param mode - the presentation the covered agents' models see.
	* @returns the exact disposer that restores the deployment default.
	*/
	presentAs(mode) {
		const ctx = this.ctx;
		if (scopeOf(ctx) === void 0) throw new Error("tools.presentAs() requires a scoped context (agent.ctx): a context-global presentation is the `mode` config field on the tools row");
		return ctx.effect(function* () {
			yield this.layers.effect(ctx, (layer) => {
				if (layer.mode !== void 0) throw new Error(`tools.presentAs("${mode}") conflicts with "${layer.mode}" already declared for this scope; one composition selects one presentation`);
				layer.mode = mode;
				return () => {
					layer.mode = void 0;
				};
			}, { label: "tools.presentAs()" });
			if (mode !== "native") {
				yield ctx.systemPrompt.section(this.collapseSection());
				yield ctx.systemPrompt.section(this.sdkSection());
			}
		}.bind(this), "tools.presentAs()");
	}
	/**
	* Build one scope's wire schemas and names for prompt-order validation.
	* Restrictions do not make known tools invalid, but a mode collapse does.
	*/
	wireSchemas(scope) {
		const view = this.view(scope);
		const mode = this.modeFor(scope);
		if (mode === "native") return {
			schemas: [...view.visible.values()].map((definition) => this.schemaOf(definition, false)),
			knownNames: [...view.knownNames]
		};
		this.requireCodeRuntime(mode);
		const schemas = [...view.visible.values()].map((definition) => this.schemaOf(definition, false));
		if (mode === "code") return {
			schemas: schemas.filter((schema) => schema.name === RUN_CODE_NAME),
			knownNames: [RUN_CODE_NAME]
		};
		return {
			schemas,
			knownNames: [...view.knownNames, RUN_CODE_NAME]
		};
	}
	/**
	* Resolve the code runtime or throw the actionable misconfiguration error.
	* Read at use time (assembly / run_code execution), NOT via static
	* `inject`: an inject entry would hold `ctx.tools` — and every tool plugin
	* behind it — hostage to a code runtime existing even under `mode:
	* 'native'` (the loop's optional-backend idiom, same as
	* `sessionPersistence`).
	*
	* Assembly and `run_code` execution read separately, so the language is not
	* bound to a request. Harmless while one published backend exists — both
	* reads return the same flavor — but a reload that swapped in a second
	* language between them would hand a program written against one SDK to the
	* other. Binding it is deferred until a second backend ships (the first
	* point it is testable); rationale in the
	* [language-dispatch note](../../../../.agents/notes/implemented/feature/2026-07-31-code-mode-language-dispatch.md).
	*/
	requireCodeRuntime(mode) {
		const runtime = this.ctx.get("codeRuntime");
		if (!runtime) throw new Error(`dsh-tools: mode "${mode}" requires a code runtime — load a ctx.codeRuntime implementation (e.g. @deepseek-ai/dsh-code-runtime-worker-thread) or set tools mode to "native"`);
		if (!Object.hasOwn(SDK_RENDERERS, runtime.language)) {
			const known = Object.keys(SDK_RENDERERS).map((name) => JSON.stringify(name)).join(", ");
			throw new Error(`dsh-tools: no SDK renderer registered for runtime language ${JSON.stringify(runtime.language)} (known: ${known})`);
		}
		return runtime;
	}
	/**
	* Register globally or in the calling agent scope. Scoped tools shadow
	* globals; duplicates within one layer and the reserved `run_code` name fail.
	* @param definition - tool schema, execution, and optional finalization/presentation callbacks.
	* @returns the exact disposer that unregisters the tool.
	*/
	register(definition) {
		const name = definition.name;
		const output = definition.output;
		if (output === void 0 || typeof output !== "object" || typeof output.render !== "function" || output.presentationMeta !== void 0 && typeof output.presentationMeta !== "function") throw new TypeError(`tool "${name}" must declare output { schema, render, presentationMeta? }`);
		assertSupportedJsonSchema(output.schema);
		const timeoutMs = definition.timeoutMs;
		if (timeoutMs !== void 0 && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) throw new TypeError(`tool "${name}" timeoutMs must be a positive finite number`);
		if (name === "run_code") throw new Error(`tool name "${RUN_CODE_NAME}" is reserved for the Code Mode presentation transport and cannot be registered or shadowed`);
		return this.layers.effect(this.ctx, (layer) => layer.tools.insert(name, definition), { label: "tools.register()" });
	}
	/**
	* Restrict global tools for the calling agent scope. Empty filters, unknown
	* names, scope-local names, and reserved transport names fail. Restrictions
	* intersect; scoped registrations remain visible.
	* @param filter - global-tool mask: `allow` (keep only) and/or `deny` (remove).
	* @returns the exact disposer that lifts this restriction.
	*/
	restrict(filter) {
		const scope = scopeOf(this.ctx);
		if (scope === void 0) throw new Error("tools.restrict() requires a scoped context (agent.ctx): a context-global restriction would mask every agent — deny the tool for the intended agent instead");
		const allow = filter.allow;
		const deny = filter.deny;
		if (allow === void 0 && deny === void 0) throw new Error("tools.restrict({}) is a no-op: pass `allow` and/or `deny` (an empty filter is almost always a materialized-empty-config bug)");
		const compiled = {
			...allow !== void 0 ? { allow: new Set(allow) } : {},
			...deny !== void 0 ? { deny: new Set(deny) } : {}
		};
		if ([...allow ?? [], ...deny ?? []].includes("run_code")) throw new Error(`tools.restrict() cannot name reserved Code Mode presentation transport "${RUN_CODE_NAME}"; restrict end-capability tools instead`);
		const known = this.view(scope).restrictableNames;
		const unknown = [...allow ?? [], ...deny ?? []].filter((name) => !known.has(name));
		if (unknown.length > 0) throw new Error(`tools.restrict() names unknown global tool${unknown.length > 1 ? "s" : ""} ${unknown.map((n) => `"${n}"`).join(", ")}; known global tools: ${[...known].sort().join(", ") || "(none)"}`);
		return this.layers.effect(this.ctx, (layer) => layer.restrictions.append(compiled), { label: "tools.restrict()" });
	}
	/**
	* Register a monotonic guard after the extensible `tools/pre-execute`
	* waterfall. A plain-context guard applies globally; one registered through
	* `agent.ctx` applies only to that agent. Any matching guard may deny by
	* returning a reason, while no guard can force-allow a call another guard
	* denied. The exact effect disposer is returned for ordered ownership and
	* HMR cleanup.
	* @param guard - synchronous check; a returned string denies the execution.
	* @returns the exact disposer that unregisters the guard.
	*/
	guard(guard) {
		return this.layers.effect(this.ctx, (layer) => layer.guards.append(guard), {
			label: "tools.guard()",
			notify: false
		});
	}
	/** First monotonic denial from the global then the scope chain's guard layers, farthest first. */
	guardReason(exec) {
		const globalReason = this.layers.global.guardReason(exec);
		if (globalReason !== void 0) return globalReason;
		if (exec.agent === void 0) return void 0;
		for (const layer of this.layers.chainLayers(exec.agent)) {
			const reason = layer.guardReason(exec);
			if (reason !== void 0) return reason;
		}
	}
	/**
	* Resolve every registry fact one scope needs in one layer traversal. The
	* visible map applies restrictions to the INHERITED surface, then the
	* scope's own registrations and the reserved presentation transport; the
	* other sets retain the pre-restriction facts needed by restriction and
	* prompt-order validation.
	*
	* A restriction filters what a scope inherits — the global layer and every
	* ancestor layer on its chain — and never what its OWN layer registers.
	* That exemption is what a per-child capability filter has to keep intact:
	* the delegation runtime registers a child's reporting and structured-output
	* tools into the child's own layer, and a filter naming the capabilities the
	* child may use must not strip the machinery it answers through.
	*
	* Reading the exempt set as "the global layer" instead of "not mine" held
	* only while every model-facing tool sat in the host composition. Once
	* presets moved them onto the agent plane they became an ANCESTOR
	* contribution, so a child's filter silently stopped constraining anything
	* it was given.
	* @param scope - the viewing scope (the agent), or undefined for the global view.
	* @returns the complete derived view for that scope.
	*/
	view(scope) {
		const layers = this.layers.chainLayers(scope);
		const own = this.layers.peek(scope);
		const inherited = new Map(this.layers.global.tools.entries());
		for (const layer of layers) {
			if (layer === own) continue;
			for (const [name, definition] of layer.tools.entries()) inherited.set(name, definition);
		}
		const visible = /* @__PURE__ */ new Map();
		const knownNames = /* @__PURE__ */ new Set();
		const restrictableNames = /* @__PURE__ */ new Set();
		for (const [name, definition] of inherited) {
			knownNames.add(name);
			restrictableNames.add(name);
			if (layers.every((layer) => layer.admits(name))) visible.set(name, definition);
		}
		if (own !== void 0) for (const [name, definition] of own.tools.entries()) {
			knownNames.add(name);
			visible.set(name, definition);
		}
		if (this.modeFor(scope) !== "native") visible.set(RUN_CODE_NAME, this.requireCodeTransport());
		return {
			visible,
			knownNames,
			restrictableNames
		};
	}
	/**
	* Look up a tool as one scope sees it (scoped
	* shadows global; a restricted-away global reads as absent). Presenters pass
	* the calling agent so the rendered card matches the definition that
	* actually executed.
	* @param name - the tool name as registered.
	* @param scope - the viewing scope (the agent); omitted = the global view.
	* @returns the definition the scope resolves, or undefined when none is visible.
	*/
	get(name, scope) {
		return this.view(scope).visible.get(name);
	}
	/**
	* Resolve the definition that MAY EXECUTE for a call, applying the mode
	* collapse at the operation boundary that owns it. The registry view
	* (`get`) is presentation-agnostic; here a MODEL-DIRECT call under `code`
	* may only name the reserved `run_code` transport, while a nested
	* sub-dispatch (a `parent` token set — the `run_code` SDK calling a tool
	* it bound) may call any visible tool. Denial surfaces as `UNKNOWN_TOOL`
	* through the executor, matching an absent definition.
	* @param name - the tool name as registered.
	* @param scope - the viewing scope (the agent); omitted = the global view.
	* @param nested - whether the call is a transport sub-dispatch, not a model-direct call.
	* @returns the definition that may run, or undefined when the call must be rejected.
	*/
	resolveExecution(name, scope, nested) {
		const tool = this.get(name, scope);
		if (tool === void 0) return void 0;
		if (this.collapses(name, scope, nested)) return void 0;
		return tool;
	}
	/**
	* Project visible definitions onto the allowlisted model-facing schema fields,
	* excluding execution and presentation callbacks.
	* @param scope - the viewing scope (the agent); omitted = the global view.
	* @returns one deep-cloned schema per visible tool.
	*/
	schemas(scope) {
		return [...this.view(scope).visible.values()].map((definition) => this.schemaOf(definition, true));
	}
	/** Project visible callable tools onto the generated Code Mode SDK contract. */
	sdkSchemas(scope) {
		return [...this.view(scope).visible.values()].filter((definition) => definition.name !== RUN_CODE_NAME).map((definition) => {
			const output = snapshotJsonValue(definition.output.schema);
			/* v8 ignore next -- registration already validated and retained this schema as lossless JSON. */
			if (output === void 0) throw new Error(`tool "${definition.name}" output schema must be lossless JSON before SDK projection`);
			return {
				...this.schemaOf(definition, true),
				output
			};
		});
	}
	/** Project one definition onto the model-facing schema fields. */
	schemaOf(definition, detachParameters) {
		const { name, description, parameters } = definition;
		const detached = detachParameters ? snapshotJsonValue(parameters) : parameters;
		if (detached === void 0) throw new Error(`tool "${name}" parameters must be lossless JSON before schema projection`);
		return {
			name,
			description,
			parameters: detached
		};
	}
	/**
	* Classify a pending call through the caller's visible tool definition. Only
	* an exact `true` is parallel; unknown, hidden, undeclared, invalid, or
	* throwing classifiers are exclusive.
	* @param exec - call name, parsed arguments, and optional agent scope.
	* @returns the fail-closed scheduling mode.
	*/
	executionMode(exec) {
		const tool = this.resolveExecution(exec.name, exec.agent, exec.parent !== void 0);
		if (!tool?.isConcurrencySafe) return { kind: "exclusive" };
		try {
			return tool.isConcurrencySafe(exec.arguments) === true ? { kind: "parallel" } : { kind: "exclusive" };
		} catch {
			return { kind: "exclusive" };
		}
	}
	/**
	* Run the `tools/code-dispatch-log` waterfall over one settled sub-dispatch
	* and return the content the bridge should log on `tool/code-dispatch`.
	* Contained: when a listener throws, the method logs the original settled
	* content; that failure must not fail the dispatch or omit the settle event. Private:
	* the ONE consumer is the `run_code` bridge this registry constructs, which
	* receives it as a capability parameter (the `requireRuntime` idiom) — the
	* waterfall, not this invoker, is the public extension point.
	*/
	async shapeDispatchLog(dispatch) {
		try {
			return await this.ctx.waterfall(scopeTarget(this, dispatch.agent), "tools/code-dispatch-log", dispatch, () => Promise.resolve(dispatch.content));
		} catch (error) {
			this.ctx.logger.warn(`tools: code-dispatch-log listener failed for ${dispatch.name}: ${errorMessage(error)}; logging the original settled content`);
			return dispatch.content;
		}
	}
	/**
	* Whether the `code` mode collapse denies a model-direct call: only the
	* reserved `run_code` transport may be named. Nested sub-dispatches (a
	* `parent` token set) bypass the collapse. One home for the
	* security-relevant predicate, shared by {@link resolveExecution} and
	* {@link createExecution} so the two can never drift apart.
	*
	* Resolved through {@link modeFor}, NOT `defaultMode`: an agent given `code`
	* by an agent preset under a native deployment is the composition
	* `dsh-agent-tool-presentation` exists for, and reading the deployment default would
	* leave exactly that agent uncollapsed — announcing one surface while
	* executing another, which is the bypass this collapse closes.
	* @param name - the tool name as registered.
	* @param scope - the viewing scope whose effective presentation mode applies.
	* @param nested - whether the call is a transport sub-dispatch, not a model-direct call.
	*/
	collapses(name, scope, nested) {
		return !nested && this.modeFor(scope) === "code" && name !== "run_code";
	}
	/**
	* Execute through pre-policy, guards, around-dispatch, post-policy,
	* definition-owned content finalization, and final notification. Tool and
	* listener failures resolve as materialized error results; an invisible tool
	* reports `UNKNOWN_TOOL`. The returned outcome is the same lossless, frozen
	* snapshot final observers receive. Cancellation
	* arriving after entry and before final result materialization skips a
	* not-yet-started body with `ABORTED_BEFORE_DISPATCH` or replaces a
	* successful started outcome with `ABORTED`; already-started work is still
	* drained and may retain a tool-owned structured error.
	* @param exec - the typed same-process call input. The registry assigns its
	*   correlation token before policy begins.
	* @returns the materialized final result.
	*/
	async execute(exec) {
		return this.prepareExecution(exec, (prepared) => this.completeScheduledExecution(prepared));
	}
	async completeScheduledExecution(prepared) {
		switch (prepared.kind) {
			case "dispatch": {
				const dispatched = await this.dispatchScheduledExecution(prepared.exec);
				return dispatched.kind === "post-result" ? await this.finalizeScheduledExecution(prepared.exec, dispatched.result) : this.finishScheduledExecution(prepared.exec, dispatched.result);
			}
			case "post-result": return await this.finalizeScheduledExecution(prepared.exec, prepared.result);
			case "final-result": return this.finishScheduledExecution(prepared.exec, prepared.result);
			/* v8 ignore next -- closed-union exhaustiveness guard */
			default: return assertNever(prepared, "scheduled tool preparation");
		}
	}
	createExecution(exec) {
		const deferredContexts = [];
		const token = createExecutionToken();
		const callId = exec.callId;
		const rootCallId = exec.rootCallId ?? callId;
		const name = exec.name;
		const agent = exec.agent;
		const parent = exec.parent;
		const signal = exec.signal;
		const visible = this.get(name, agent);
		const collapsed = visible !== void 0 && this.collapses(name, agent, parent !== void 0);
		const concludingExecutions = this.concludingExecutions;
		const base = {
			token,
			callId,
			rootCallId,
			name,
			signal,
			...agent !== void 0 ? { agent } : {},
			...parent !== void 0 ? { parent } : {},
			deferContext(context) {
				deferredContexts.push(context);
			},
			concludeTurn() {
				concludingExecutions.add(this);
			}
		};
		const capturedFinalizer = visible?.finalizeContent?.bind(visible);
		const finalizerFor = () => collapsed && !signal.aborted ? void 0 : capturedFinalizer;
		try {
			const detached = snapshotJsonValue(exec.arguments);
			if (detached === void 0) throw new TypeError("tool execution arguments must be losslessly JSON-serializable");
			const execution = {
				...base,
				arguments: deepFreeze(detached)
			};
			this.deferredContexts.set(execution, deferredContexts);
			this.contentFinalizers.set(execution, finalizerFor());
			this.cancellationStates.set(execution, {
				callerSignal: signal,
				bodyInvoked: false
			});
			if (collapsed) {
				if (signal.aborted) return {
					kind: "final-result",
					exec: execution,
					result: toolAbortedBeforeDispatchResult()
				};
				return {
					kind: "final-result",
					exec: execution,
					result: toolErrorResult(new ToolNotFoundError(name, `only \`${RUN_CODE_NAME}\` is callable directly — call \`${name}\` from inside a \`${RUN_CODE_NAME}\` program instead`))
				};
			}
			return {
				kind: "ready",
				exec: execution
			};
		} catch (error) {
			const execution = {
				...base,
				arguments: void 0
			};
			this.contentFinalizers.set(execution, finalizerFor());
			return {
				kind: "final-result",
				exec: execution,
				result: toolErrorResult(error)
			};
		}
	}
	/**
	* Run the ordered pre-execute and monotonic guard stages for the scheduler.
	* @param input - the caller-supplied execution input.
	* @returns the prepared execution plus the next scheduler stage.
	* @internal
	*/
	async prepareScheduledExecution(input) {
		return this.prepareExecution(input, (prepared) => prepared);
	}
	async prepareExecution(input, next) {
		const created = this.createExecution(input);
		if (created.kind !== "ready") return next(created);
		const exec = created.exec;
		if (this.callerCancelled(exec)) return next({
			kind: "final-result",
			exec,
			result: toolAbortedBeforeDispatchResult()
		});
		try {
			const carrier = scopeTarget(this, exec.agent);
			const gate = await this.ctx.waterfall(carrier, "tools/pre-execute", exec, () => Promise.resolve({ kind: "allow" }));
			const askResolution = gate.kind === "ask" ? await this.serviceAsk(exec, gate) : {
				decision: gate,
				approvalCancelled: false
			};
			const { decision } = askResolution;
			if (this.callerCancelled(exec) && askResolution.approvalCancelled) return await next({
				kind: "post-result",
				exec,
				result: toolAbortedBeforeDispatchResult()
			});
			const denialReason = decision.kind === "allow" ? this.guardReason(exec) : decision.reason;
			if (denialReason !== void 0) return await next({
				kind: "post-result",
				exec,
				result: this.materializeFinalResult({
					content: [{
						type: "text",
						text: `Error: ${denialReason}`
					}],
					isError: true,
					error: { message: denialReason }
				})
			});
			if (this.callerCancelled(exec)) return await next({
				kind: "post-result",
				exec,
				result: toolAbortedBeforeDispatchResult()
			});
			return await next({
				kind: "dispatch",
				exec
			});
		} catch (error) {
			return next({
				kind: "final-result",
				exec,
				result: toolErrorResult(error)
			});
		}
	}
	/** Whether the original caller signal is currently aborted. */
	callerCancelled(exec) {
		const state = this.cancellationStates.get(exec);
		/* v8 ignore next -- only registry-minted executions reach the staged scheduler methods */
		if (state === void 0) throw new Error("tool registry scheduler invariant violated: missing cancellation state");
		return state.callerSignal.aborted;
	}
	/** Canonical cancellation outcome selected by whether the tool body started. */
	cancellationResult(exec, prior) {
		const state = this.cancellationStates.get(exec);
		/* v8 ignore next -- only registry-minted executions reach the staged scheduler methods */
		if (state === void 0) throw new Error("tool registry scheduler invariant violated: missing cancellation state");
		return state.bodyInvoked ? toolAbortedResult(prior) : toolAbortedBeforeDispatchResult(prior);
	}
	/**
	* Dispatch the registered body with the original caller signal fused back
	* into any around-wrapper replacement. Cancellation never abandons the body:
	* a started promise reaches quiescence before its outcome becomes `ABORTED`.
	*/
	async dispatchToolBody(exec) {
		const state = this.cancellationStates.get(exec);
		/* v8 ignore next -- only registry-minted executions reach the staged scheduler methods */
		if (state === void 0) throw new Error("tool registry scheduler invariant violated: missing cancellation state");
		const wrapperSignal = exec.signal;
		const fused = fuseToolSignals(state.callerSignal, wrapperSignal);
		const signal = fused.signal;
		if (isAborted(signal)) {
			fused.dispose();
			return toolAbortedBeforeDispatchResult();
		}
		exec.signal = signal;
		try {
			const tool = this.resolveExecution(exec.name, exec.agent, exec.parent !== void 0);
			if (!tool) throw new ToolNotFoundError(exec.name);
			state.bodyInvoked = true;
			const returned = await tool.execute(exec.arguments, exec);
			const result = this.createSuccessResult(exec, tool, returned);
			return isAborted(signal) ? toolAbortedResult(result) : result;
		} catch (error) {
			return toolErrorResult(error);
		} finally {
			fused.dispose();
			exec.signal = wrapperSignal;
		}
	}
	/**
	* Run around-dispatch and the tool body. Tool and unknown-tool failures still
	* receive post-execute; pipeline failures are already final.
	* @param exec - the prepared execution.
	* @returns whether the result still needs post-execute.
	* @internal
	*/
	async dispatchScheduledExecution(exec) {
		try {
			const mutableExec = exec;
			const carrier = scopeTarget(this, exec.agent);
			const result = await this.ctx.waterfall(carrier, "tools/execute", mutableExec, () => this.dispatchToolBody(mutableExec));
			const normalized = this.normalizeDispatchResult(exec, result);
			const deferredContexts = this.deferredContexts.get(exec);
			/* v8 ignore next -- dispatch only receives executions minted by this registry's prepare stage */
			if (deferredContexts === void 0) throw new Error("tool registry scheduler invariant violated: unprepared execution");
			const resultWithDeferredContexts = deferredContexts.length === 0 ? normalized : this.markCanonical(exec, {
				...normalized,
				additionalContexts: [...deferredContexts, ...normalized.additionalContexts ?? []]
			});
			return {
				kind: "post-result",
				result: this.callerCancelled(exec) && !resultWithDeferredContexts.isError ? this.cancellationResult(exec, resultWithDeferredContexts) : resultWithDeferredContexts
			};
		} catch (error) {
			return {
				kind: "final-result",
				result: toolErrorResult(error)
			};
		}
	}
	/**
	* Run ordered post-execute, then apply definition-owned content finalization,
	* materialize, and notify the final outcome.
	* @param exec - the prepared execution.
	* @param result - dispatch/pre result that still needs post-execute.
	* @returns the materialized final result.
	* @internal
	*/
	async finalizeScheduledExecution(exec, result) {
		try {
			const postResult = await this.postExecute(exec, result);
			return this.finishScheduledExecution(exec, this.callerCancelled(exec) && !postResult.isError ? this.cancellationResult(exec, postResult) : postResult);
		} catch (error) {
			return this.finishScheduledExecution(exec, toolErrorResult(error));
		}
	}
	/**
	* Materialize the candidate, apply definition-owned content finalization,
	* then materialize and notify the authoritative result.
	* @param exec - the prepared execution.
	* @param result - final result.
	* @returns the materialized final result.
	* @internal
	*/
	finishScheduledExecution(exec, result) {
		let materializedResult;
		try {
			materializedResult = this.materializeFinalResult(result);
		} catch (error) {
			materializedResult = this.materializeFinalResult(toolErrorResult(error));
		}
		let finalResult;
		try {
			finalResult = this.materializeFinalResult(this.applyFinalContent(exec, materializedResult));
		} catch (error) {
			finalResult = this.materializeFinalResult(toolErrorResult(error));
		}
		this.notifyResult(exec, finalResult);
		return finalResult;
	}
	/** Apply the snapshotted tool-owned content transform without exposing other result fields. */
	applyFinalContent(exec, result) {
		const finalizeContent = this.contentFinalizers.get(exec);
		if (finalizeContent === void 0) return result;
		const content = finalizeContent(exec, result);
		return content === void 0 ? result : {
			...result,
			content
		};
	}
	/** Notify observers without exposing a mutation or error channel into the outcome. */
	notifyResult(exec, result) {
		Object.freeze(exec);
		const { name: toolName, callId } = exec;
		const reportFailure = (error) => {
			this.ctx.logger.warn(`tool "${toolName}" (${callId}): tools/result observer failed: ${errorMessage(error)}`);
		};
		const callbacks = this.ctx.events.dispatch("emit", [
			scopeTarget(this, exec.agent),
			"tools/result",
			exec,
			result
		]);
		for (const callback of callbacks) try {
			const returned = callback(exec, result);
			Promise.resolve(returned).catch(reportFailure);
		} catch (error) {
			reportFailure(error);
		}
	}
	/**
	* Resolve an `ask` decision to allow/deny through the approval seam. The
	* seam is consumed opportunistically with `ctx.get('approval')` — a
	* deployment that composes no ApprovalService keeps the historical degrade
	* to deny, and an unmount mid-session degrades the same way on the next ask.
	* An agent-less execution also degrades: without an agent there is no
	* session to audit to and no UI to route to. Otherwise the outcome maps
	* one-to-one — `allowed-once` proceeds; the three non-grants deny with
	* distinct reasons so the model can tell a human "no" from an absent
	* approval channel.
	*/
	async serviceAsk(exec, ask) {
		const approval = this.ctx.get("approval");
		if (approval === void 0) return {
			decision: {
				kind: "deny",
				reason: ask.reason ?? `tool "${exec.name}" requires approval (not yet supported)`
			},
			approvalCancelled: false
		};
		if (exec.agent === void 0) return {
			decision: {
				kind: "deny",
				reason: `tool "${exec.name}" requires approval, but the call has no agent to route it through`
			},
			approvalCancelled: false
		};
		const outcome = await approval.request({
			agent: exec.agent,
			toolName: exec.name,
			callId: exec.callId,
			...ask.reason !== void 0 ? { reason: ask.reason } : {},
			signal: exec.signal
		});
		switch (outcome) {
			case "allowed-once": return {
				decision: { kind: "allow" },
				approvalCancelled: false
			};
			case "rejected": return {
				decision: {
					kind: "deny",
					reason: `the user rejected tool "${exec.name}"`
				},
				approvalCancelled: false
			};
			case "cancelled": return {
				decision: {
					kind: "deny",
					reason: `approval for tool "${exec.name}" was cancelled`
				},
				approvalCancelled: true
			};
			case "unavailable": return {
				decision: {
					kind: "deny",
					reason: `tool "${exec.name}" requires approval, but no approval channel is available`
				},
				approvalCancelled: false
			};
			default: return assertNever(outcome, "ApprovalOutcome");
		}
	}
	/**
	* Run the `tools/post-execute` waterfall over a dispatched `result` and apply
	* its {@link PostToolDecision}: `accept` keeps the call successful (replacing
	* `content` when given), `block` turns it into an `isError` whose content is
	* the corrective `feedback`. Either decision may attach `additionalContexts`,
	* which are ferried on the returned result for the loop's active-batch FIFO.
	* Context deferred by the tool body survives an accepted result but is
	* discarded when the outer call is blocked; a block exposes only context the
	* blocking decision explicitly supplied.
	* Runs inside `execute`'s outer try/catch (a throwing listener → isError).
	*/
	async postExecute(exec, result) {
		const decision = await this.ctx.waterfall(scopeTarget(this, exec.agent), "tools/post-execute", exec, result, () => Promise.resolve({ kind: "accept" }));
		const decisionContexts = decision.additionalContexts ?? [];
		if (decision.kind === "block") {
			const message = failureMessageFromContent(decision.feedback);
			return this.markCanonical(exec, {
				content: decision.feedback,
				isError: true,
				error: { message },
				...decisionContexts.length > 0 ? { additionalContexts: decisionContexts } : {}
			});
		}
		if (Object.hasOwn(decision, "content") && Object.hasOwn(decision, "value")) throw new TypeError("tools/post-execute accept decision cannot replace both value and content");
		const additionalContexts = [...result.additionalContexts ?? [], ...decisionContexts];
		if (Object.hasOwn(decision, "value")) {
			if (result.isError) throw new TypeError("tools/post-execute cannot replace the value of a failed result");
			const tool = this.resolveExecution(exec.name, exec.agent, exec.parent !== void 0);
			if (tool === void 0) throw new ToolNotFoundError(exec.name);
			const replaced = this.createSuccessResult(exec, tool, decision.value);
			return this.markCanonical(exec, {
				...replaced,
				...additionalContexts.length > 0 ? { additionalContexts } : {}
			});
		}
		return this.markCanonical(exec, {
			...result,
			...decision.content !== void 0 ? { content: decision.content } : {},
			...additionalContexts.length > 0 ? { additionalContexts } : {}
		});
	}
	/** Registry-normalized results and the exact dispatch that validated each value. */
	canonicalResults = /* @__PURE__ */ new WeakMap();
	/** Mark one registry-normalized result as canonical only for its owning dispatch. */
	markCanonical(exec, result) {
		this.canonicalResults.set(result, exec.token);
		return result;
	}
	/** Snapshot, validate, render, and optionally project one successful body value. */
	createSuccessResult(exec, tool, candidate) {
		const detached = snapshotToolValue(tool.name, candidate);
		const violations = validateJsonSchemaValue(tool.output.schema, detached, "value");
		if (violations.length > 0) throw new ToolOutputError(tool.name, violations);
		const value = deepFreeze(detached);
		let rendered;
		try {
			rendered = tool.output.render(exec.arguments, value);
		} catch (error) {
			throw projectionError(tool.name, "render", error);
		}
		const content = snapshotProjection(tool.name, "render", rendered);
		let meta;
		if (exec.parent === void 0 && tool.output.presentationMeta !== void 0) {
			let projected;
			try {
				projected = tool.output.presentationMeta(exec.arguments, value);
			} catch (error) {
				throw projectionError(tool.name, "presentationMeta", error);
			}
			meta = snapshotProjection(tool.name, "presentationMeta", projected);
		}
		const concludesTurn = this.concludingExecutions.has(exec);
		return this.markCanonical(exec, this.materializeFinalResult({
			isError: false,
			value,
			content,
			...meta !== void 0 ? { meta } : {},
			...concludesTurn ? { concludesTurn: true } : {}
		}));
	}
	/** Normalize an around-dispatch wrapper's authored result through the owning output contract. */
	normalizeDispatchResult(exec, result) {
		if (this.canonicalResults.get(result) === exec.token) return result;
		if (result.isError) return this.markCanonical(exec, {
			isError: true,
			error: result.error,
			content: result.content,
			...result.meta !== void 0 ? { meta: result.meta } : {},
			...result.additionalContexts !== void 0 ? { additionalContexts: result.additionalContexts } : {}
		});
		const tool = this.resolveExecution(exec.name, exec.agent, exec.parent !== void 0);
		if (tool === void 0) throw new ToolNotFoundError(exec.name);
		const normalized = this.createSuccessResult(exec, tool, result.value);
		return this.markCanonical(exec, {
			...normalized,
			...result.additionalContexts !== void 0 ? { additionalContexts: result.additionalContexts } : {}
		});
	}
	/** Materialize the authoritative commit outcome once, immediately before `tools/result`. */
	materializeFinalResult(result) {
		const presentation = {
			content: result.content,
			...result.meta !== void 0 ? { meta: result.meta } : {},
			...result.additionalContexts !== void 0 ? { additionalContexts: result.additionalContexts } : {}
		};
		if (result.isError) return materializePresentation({
			isError: true,
			error: result.error,
			...presentation
		});
		return deepFreeze({
			...materializePresentation({
				isError: false,
				...presentation,
				...result.concludesTurn === true ? { concludesTurn: true } : {}
			}),
			value: result.value
		});
	}
});
/** Mint a same-process correlation token whose identity is its value. */
function createExecutionToken() {
	return Symbol("dsh.tool.execution");
}
function toolErrorResult(error) {
	const info = errorInfo(error);
	const message = errorMessage(error);
	return {
		content: [{
			type: "text",
			text: `Error: ${message}`
		}],
		isError: true,
		error: {
			message,
			...info ? { info } : {}
		}
	};
}
/** Read live abort state across an await without treating it as synchronously immutable. */
function isAborted(signal) {
	return signal.aborted;
}
/**
* Fuse caller and wrapper cancellation without nesting `AbortSignal.any`.
* Keeping the relay dispatch-scoped also removes listeners when work settles.
*/
function fuseToolSignals(caller, wrapper) {
	if (caller === wrapper) return {
		signal: caller,
		dispose() {}
	};
	const controller = new AbortController();
	let listening = false;
	const dispose = () => {
		if (!listening) return;
		listening = false;
		caller.removeEventListener("abort", abortFromCaller);
		wrapper.removeEventListener("abort", abortFromWrapper);
	};
	const abortFrom = (source) => {
		const reason = source.reason;
		controller.abort(reason);
		dispose();
	};
	const abortFromCaller = () => {
		abortFrom(caller);
	};
	const abortFromWrapper = () => {
		abortFrom(wrapper);
	};
	if (wrapper.aborted) abortFromWrapper();
	else if (caller.aborted) abortFromCaller();
	else {
		listening = true;
		caller.addEventListener("abort", abortFromCaller, { once: true });
		wrapper.addEventListener("abort", abortFromWrapper, { once: true });
	}
	return {
		signal: controller.signal,
		dispose
	};
}
/** Canonical result when cancellation supersedes success after body invocation. */
function toolAbortedResult(prior) {
	const additionalContexts = prior?.additionalContexts ?? [];
	return {
		content: [{
			type: "text",
			text: "Error: tool call aborted"
		}],
		isError: true,
		error: {
			message: "tool call aborted",
			info: {
				name: "AbortError",
				code: TOOL_ABORTED
			}
		},
		...additionalContexts.length > 0 ? { additionalContexts } : {}
	};
}
/** Canonical result when cancellation prevents tool body invocation. */
function toolAbortedBeforeDispatchResult(prior) {
	const additionalContexts = prior?.additionalContexts ?? [];
	return {
		content: [{
			type: "text",
			text: "Error: tool call aborted before dispatch"
		}],
		isError: true,
		error: {
			message: "tool call aborted before dispatch",
			info: {
				name: "AbortError",
				code: TOOL_ABORTED_BEFORE_DISPATCH
			}
		},
		...additionalContexts.length > 0 ? { additionalContexts } : {}
	};
}
//#endregion
//#region src/infra/logger.ts
const LEVEL_ORDER = {
	debug: 10,
	info: 20,
	warn: 30,
	error: 40
};
const ANSI = {
	debug: "\x1B[2m",
	info: "\x1B[36m",
	warn: "\x1B[33m",
	error: "\x1B[31m"
};
const RESET = "\x1B[0m";
const LABEL = {
	debug: "DEBUG",
	info: "INFO ",
	warn: "WARN ",
	error: "ERROR"
};
function createLogger(options = {}) {
	const sink = options.sink ?? (process.stdout.isTTY ? "tty" : "plain");
	const minOrder = LEVEL_ORDER[options.minLevel ?? "info"];
	const write = options.writer ?? ((l) => process.stdout.write(l + "\n"));
	const writeErr = options.errWriter ?? options.writer ?? ((l) => process.stderr.write(l + "\n"));
	let inProgress = false;
	/** 非 TTY 刻度去重：同一 10% 刻度只输出一行（旧实现 0.91~0.99 会刷出 9 行 "90%"） */
	let lastEmittedTick = -1;
	function render(level, message, fields) {
		const ts = (/* @__PURE__ */ new Date()).toISOString().slice(11, 23);
		const color = sink === "tty" ? ANSI[level] : "";
		const reset = sink === "tty" ? RESET : "";
		let line = `${color}[${ts}] ${LABEL[level]}${reset} ${message}`;
		const merged = {
			...options.bindings,
			...fields
		};
		const keys = Object.keys(merged);
		if (keys.length > 0) {
			const pairs = keys.map((k) => `${k}=${fmtVal(merged[k])}`).join(" ");
			line += `  ${sink === "tty" ? "\x1B[2m" + pairs + RESET : pairs}`;
		}
		return line;
	}
	function fmtVal(v) {
		if (typeof v === "string") return v.includes(" ") ? JSON.stringify(v) : v;
		try {
			return JSON.stringify(v) ?? String(v);
		} catch {
			return String(v);
		}
	}
	const logger = {
		sink,
		log(level, message, fields) {
			if (LEVEL_ORDER[level] < minOrder) return;
			if (inProgress && sink === "tty") {
				write("\n");
				inProgress = false;
			}
			const line = render(level, message, fields);
			if (level === "error") writeErr(line);
			else if (level === "warn") write(line);
			else write(line);
		},
		debug(m, f) {
			logger.log("debug", m, f);
		},
		info(m, f) {
			logger.log("info", m, f);
		},
		warn(m, f) {
			logger.log("warn", m, f);
		},
		error(m, f) {
			logger.log("error", m, f);
		},
		child(bindings) {
			return createLogger({
				...options,
				bindings: {
					...options.bindings,
					...bindings
				}
			});
		},
		progress(ratio, label) {
			if (sink !== "tty") {
				if (ratio === null) {
					lastEmittedTick = -1;
					return;
				}
				const pct = Math.round(ratio * 100);
				const tick = Math.floor(pct / 10) * 10;
				if (pct % 10 === 0 && tick !== lastEmittedTick) {
					lastEmittedTick = tick;
					write(render("debug", `[progress] ${label} ${pct}%`));
				}
				return;
			}
			const width = 24;
			const filled = Math.round(width * Math.max(0, Math.min(1, ratio ?? 0)));
			const bar = "█".repeat(filled) + "░".repeat(width - filled);
			const pct = ratio === null ? " -- " : String(Math.round(ratio * 100)).padStart(3) + "%";
			write(`\r\x1b[2m  ${bar} ${pct} ${label}\x1b[0m`);
			inProgress = ratio !== null && ratio < 1;
			if (ratio === null || ratio >= 1) write("\n");
		}
	};
	return logger;
}
//#endregion
//#region src/contracts/base.ts
function ok(value) {
	return {
		ok: true,
		value
	};
}
function err(error) {
	return {
		ok: false,
		error
	};
}
function errorToMessage(e) {
	if (e instanceof Error) return e.message;
	if (typeof e === "object" && e !== null) {
		const maybe = e;
		if (typeof maybe.message === "string") return typeof maybe.code === "string" ? `[${maybe.code}] ${maybe.message}` : maybe.message;
	}
	return String(e);
}
/** 统一 IO 类错误构造：message 形如 "<context>: <root cause>" */
function ioError(context, e) {
	return {
		code: "E_IO",
		message: `${context}: ${errorToMessage(e)}`
	};
}
var SimulatedCrashError = class extends Error {
	txId;
	stepIndex;
	constructor(txId, stepIndex) {
		super(`SIMULATED_CRASH: 事务 ${txId} 第 ${stepIndex} 步成功落盘后模拟进程死亡（跳过回滚与锁释放）`);
		this.txId = txId;
		this.stepIndex = stepIndex;
		this.name = "SimulatedCrashError";
	}
};
/** 全项目唯一的字节数人性化格式化（B/KB/MB/GB）。
*  此前 severity-scorer 与 reporter 各持一份相同实现 —— 统一到契约层。 */
function fmtBytes(n) {
	if (n < 1024) return `${n}B`;
	if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)}KB`;
	if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)}MB`;
	return `${(n / 1024 ** 3).toFixed(2)}GB`;
}
//#endregion
//#region src/infra/validator.ts
const PLUGIN_NAME_RE = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;
const PROFILE_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const RESERVED_PROFILES = /* @__PURE__ */ new Set([
	"profiles",
	"storages",
	"attachments",
	"sessions",
	"node_modules",
	"global"
]);
const NUL_RE = /\0/;
const SHELL_META_RE = /[;|&$`\n\r]/;
const WIN_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i;
const REDOS_PATTERNS = [
	/\((?:[^()\\]|\\.)*[+*]\)\s*[+*{]/,
	/\((?:[^()\\]|\\.)*[+*]\s*\|/,
	/\\[bB]|\(\?<=/
];
function v(kind, detail, field) {
	return {
		kind,
		detail,
		...field ? { field } : {}
	};
}
function splitSegments(p) {
	return p.split(/[\\/]+/).filter((s) => s.length > 0);
}
function createValidator(platform = "linux") {
	const isWin = platform === "windows";
	return {
		validatePluginName(input) {
			const violations = [];
			if (!input || input.length === 0) return err([v("empty", "插件名为空", "pluginName")]);
			if (input.length > 214) violations.push(v("too-long", `长度 ${input.length} 超过 npm 上限 214`, "pluginName"));
			if (NUL_RE.test(input)) violations.push(v("nul-byte", "包含 NUL 字节", "pluginName"));
			if (!PLUGIN_NAME_RE.test(input)) violations.push(v("charset", `仅允许小写字母/数字/-/./_/~ 与可选 @scope/ 前缀，收到: "${input}"`, "pluginName"));
			if (SHELL_META_RE.test(input)) violations.push(v("shell-metachar", "包含 shell 元字符", "pluginName"));
			return violations.length ? err(violations) : ok(input);
		},
		validateProfileName(input) {
			const violations = [];
			if (!input || input.length === 0) return err([v("empty", "profile 名为空", "profileName")]);
			if (NUL_RE.test(input)) violations.push(v("nul-byte", "包含 NUL 字节", "profileName"));
			if (!PROFILE_NAME_RE.test(input)) violations.push(v("charset", "仅允许 [a-z0-9-]，首字符须为字母或数字，长度 1~64", "profileName"));
			if (RESERVED_PROFILES.has(input)) violations.push(v("syntax", `"${input}" 是保留目录名`, "profileName"));
			if (SHELL_META_RE.test(input)) violations.push(v("shell-metachar", "包含 shell 元字符", "profileName"));
			return violations.length ? err(violations) : ok(input);
		},
		validatePath(input, options) {
			const violations = [];
			const field = "path";
			if (!input || input.length === 0) return err([v("empty", "路径为空", field)]);
			if (NUL_RE.test(input)) violations.push(v("nul-byte", "包含 NUL 字节", field));
			if (input.length > 4096) violations.push(v("too-long", "路径超过 4096 字符", field));
			const segments = splitSegments(input);
			if (segments.includes("..")) violations.push(v("traversal", "包含 \"..\" 穿越段", field));
			if (options.mustBeAbsolute) {
				if (!(input.startsWith("/") || isWin && /^[a-zA-Z]:[\\/]/.test(input))) violations.push(v("absolute-required", "必须是绝对路径", field));
			}
			if (isWin && options.strictWindows) {
				if (input.startsWith("\\\\") || input.startsWith("//")) violations.push(v("unc-path", "Windows 严格模式拒绝 UNC 路径", field));
				for (const seg of segments) if (WIN_RESERVED.test(seg)) {
					violations.push(v("syntax", `Windows 保留设备名: "${seg}"`, field));
					break;
				}
			}
			if (/[\n\r]/.test(input)) violations.push(v("shell-metachar", "路径含换行符", field));
			return violations.length ? err(violations) : ok(input);
		},
		validateRegex(input) {
			const violations = [];
			if (!input || input.length === 0) return err([v("empty", "正则为空", "regex")]);
			if (input.length > 512) violations.push(v("too-long", "正则长度超过 512", "regex"));
			for (const pat of REDOS_PATTERNS) if (pat.test(input)) {
				violations.push(v("regex-unsafe", `检测到回溯风险结构（匹配 ${pat}），拒绝编译`, "regex"));
				break;
			}
			if (violations.length) return err(violations);
			try {
				return ok(new RegExp(input));
			} catch (e) {
				return err([v("syntax", `正则编译失败: ${errorToMessage(e)}`, "regex")]);
			}
		},
		validateCommandArgv(argv, allowBin) {
			const violations = [];
			if (argv.length === 0) return err([v("empty", "argv 为空", "command")]);
			const bin = argv[0];
			if (/[\\/]/.test(bin)) violations.push(v("syntax", `argv[0] 不允许包含路径分隔符（防白名单绕过）: "${bin}"`, "command"));
			const base = bin.split(/[\\/]/).pop().replace(/\.exe$/i, "");
			if (!allowBin.includes(base)) violations.push(v("syntax", `可执行文件 "${base}" 不在白名单 [${allowBin.join(", ")}]`, "command"));
			for (const [i, arg] of argv.entries()) {
				if (NUL_RE.test(arg)) {
					violations.push(v("nul-byte", `argv[${i}] 含 NUL`, "command"));
					break;
				}
				if (SHELL_META_RE.test(arg)) {
					violations.push(v("shell-metachar", `argv[${i}]="${arg}" 含 shell 元字符（命令必须是 argv 数组，禁止 shell 字符串）`, "command"));
					break;
				}
			}
			return violations.length ? err(violations) : ok(argv);
		},
		sanitizeForDisplay(input) {
			return input.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\x1b][^\x07\x1b]*(?:\x07|\x1b\\)/g, "").replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
		}
	};
}
//#endregion
//#region src/infra/path-resolver.ts
/** 简化 glob → RegExp：支持 * ? **（仅用于 denyGlobs 匹配） */
function globToRegex(glob) {
	let re = "";
	for (let i = 0; i < glob.length; i++) {
		const ch = glob[i];
		if (ch === "*") {
			if (glob[i + 1] === "*") {
				re += ".*";
				i++;
			} else re += "[^/\\\\]*";
		} else if (ch === "?") re += "[^/\\\\]";
		else if ("\\^$.|+()[]{}".includes(ch)) re += "\\" + ch;
		else re += ch;
	}
	return new RegExp(`^${re}$`, "i");
}
function createPathResolver(options = {}) {
	const env = options.env ?? process.env;
	const platform = options.platform ?? os.platform();
	const isWin = platform === "win32";
	const homeAbs = env.HOME || env.USERPROFILE || os.homedir();
	const tempAbs = isWin ? env.TEMP || env.APPDATA : env.TMPDIR || "/tmp";
	const dshHomeAbs = env.DSH_HOME || path.join(homeAbs, ".dsh");
	const info = {
		os: isWin ? "windows" : platform === "darwin" ? "macos" : "linux",
		home: homeAbs,
		tempRoot: tempAbs,
		dshHome: dshHomeAbs,
		pathSep: isWin ? "\\" : "/"
	};
	/** 归一化：win 反斜杠 → /，统一小写比较（win 大小写不敏感） */
	function normalizeForCompare(p) {
		let s = p.replace(/\\/g, "/");
		if (isWin) s = s.toLowerCase();
		return s;
	}
	const resolver = {
		platform() {
			return info;
		},
		async canonicalize(p) {
			try {
				const resolved = path.resolve(p);
				return ok(await fs.promises.realpath(resolved).catch(() => resolved));
			} catch (e) {
				return err(ioError(`路径解析失败: ${p}`, e));
			}
		},
		async isWithin(child, root) {
			const c = await resolver.canonicalize(child);
			const r = await resolver.canonicalize(root);
			if (!c.ok || !r.ok) return false;
			const cn = normalizeForCompare(c.value);
			const rn = normalizeForCompare(r.value);
			return cn === rn || cn.startsWith(rn + "/");
		},
		async assertDeletable(p, policy) {
			const canon = await resolver.canonicalize(p);
			if (!canon.ok) return canon;
			for (const glob of policy.denyGlobs) if (matchesGlob(canon.value, glob)) return err({
				code: "E_PATH_POLICY",
				message: `路径命中拒绝清单 "${glob}": ${canon.value}`,
				details: {
					path: canon.value,
					glob
				}
			});
			for (const root of resolveAllowedRoots(policy.allowedRoots)) if (await resolver.isWithin(canon.value, root)) {
				if (normalizeForCompare(canon.value).startsWith(normalizeForCompare(resolver.nukeStateRoot()))) return err({
					code: "E_PATH_POLICY",
					message: `禁止删除 nuke 自身状态目录下的路径: ${canon.value}`,
					details: { path: canon.value }
				});
				return ok(canon.value);
			}
			return err({
				code: "E_PATH_POLICY",
				message: `路径越出删除白名单根: ${canon.value}`,
				details: {
					path: canon.value,
					allowedRoots: policy.allowedRoots
				}
			});
		},
		profileDir(profile) {
			return path.join(dshHomeAbs, "profiles", profile);
		},
		storagesRoot() {
			return path.join(dshHomeAbs, "storages");
		},
		attachmentsRoot() {
			return path.join(dshHomeAbs, "attachments", "v1");
		},
		dshHomePatchFile() {
			return path.join(dshHomeAbs, "cordis.patch.yml");
		},
		nukeStateRoot() {
			return path.join(dshHomeAbs, ".nuke");
		}
	};
	/** denyGlob 匹配：全路径命中，或（多段 glob 时）路径尾部等长段命中，或（单段时）basename 命中 */
	function matchesGlob(canonPath, glob) {
		const norm = normalizeForCompare(canonPath);
		const re = globToRegex(glob);
		if (re.test(norm)) return true;
		const globSegs = glob.split("/").filter(Boolean);
		if (globSegs.length > 1) {
			const tail = norm.split("/").filter(Boolean).slice(-globSegs.length).join("/");
			return re.test(tail);
		}
		const base = norm.split("/").pop();
		return re.test(base);
	}
	function resolveAllowedRoots(roots) {
		const out = [];
		for (const root of roots) switch (root.kind) {
			case "profile-dir":
				out.push(path.join(dshHomeAbs, "profiles", root.profile));
				break;
			case "storages":
				out.push(path.join(dshHomeAbs, "storages"));
				break;
			case "attachments":
				out.push(path.join(dshHomeAbs, "attachments", "v1"));
				break;
			case "dsh-home-patch":
				out.push(path.join(dshHomeAbs, "cordis.patch.yml"));
				break;
			case "temp-orphan": out.push(tempAbs);
		}
		return out;
	}
	return resolver;
}
//#endregion
//#region src/infra/lock-manager.ts
const LOCK_DIR_NAME = "locks";
function scopeKey(scope) {
	switch (scope.kind) {
		case "global": return "global";
		case "profile": return `profile:${scope.profile}`;
		case "plugin": return `plugin:${scope.profile}/${scope.plugin}`;
	}
}
/** owner 内容等值（pid + bootToken）：反序列化后对象引用不同，禁止用 === 比较 */
function sameOwner(a, b) {
	return a.pid === b.pid && a.bootToken === b.bootToken;
}
function createLockManager(options) {
	const lockDir = path.join(options.lockRoot, LOCK_DIR_NAME);
	const now = options.now ?? (() => Date.now());
	const probe = options.probe ?? { isAlive(pid, hostname) {
		if (hostname !== os.hostname()) return false;
		try {
			process.kill(pid, 0);
			return true;
		} catch {
			return false;
		}
	} };
	fs.mkdirSync(lockDir, { recursive: true });
	function lockPath(scope) {
		return path.join(lockDir, `${scopeKey(scope).replace(/[/@]/g, "_")}.lock`);
	}
	function readLock(p) {
		try {
			const parsed = JSON.parse(fs.readFileSync(p, "utf-8"));
			if (typeof parsed !== "object" || parsed === null) return null;
			const c = parsed;
			if (c.version !== 1) return null;
			if (c.mode !== "shared" && c.mode !== "exclusive") return null;
			if (!Array.isArray(c.owners)) return null;
			for (const o of c.owners) {
				if (typeof o !== "object" || o === null) return null;
				if (typeof o.owner?.pid !== "number" || typeof o.owner?.bootToken !== "string") return null;
				if (typeof o.expiresAt !== "number") return null;
			}
			return parsed;
		} catch {
			return null;
		}
	}
	function writeLockAtomic(p, content) {
		try {
			const fd = fs.openSync(p, "wx");
			fs.writeSync(fd, JSON.stringify(content, null, 2));
			fs.fsyncSync(fd);
			fs.closeSync(fd);
			return true;
		} catch {
			return false;
		}
	}
	/** 单次获取尝试（不含等待循环） */
	async function tryOnce(request) {
		const p = lockPath(request.scope);
		const me = {
			owner: request.owner,
			acquiredAt: new Date(now()).toISOString(),
			expiresAt: now() + request.ttlMs
		};
		if (request.mode === "shared") {
			if (await withGuard(p, now, () => {
				const cur = readLock(p);
				if (cur && cur.mode === "exclusive") return false;
				const content = cur && cur.mode === "shared" ? {
					...cur,
					owners: [...cur.owners.filter((o) => o.expiresAt > now()), me]
				} : {
					version: 1,
					scope: scopeKey(request.scope),
					mode: "shared",
					owners: [me]
				};
				const tmp = p + ".tmp." + crypto.randomBytes(4).toString("hex");
				fs.writeFileSync(tmp, JSON.stringify(content, null, 2));
				fs.renameSync(tmp, p);
				return true;
			}) !== true) return null;
		} else if (!writeLockAtomic(p, {
			version: 1,
			scope: scopeKey(request.scope),
			mode: "exclusive",
			owners: [me]
		})) return null;
		const lockId = crypto.randomBytes(8).toString("hex");
		let released = false;
		return {
			id: lockId,
			request,
			acquiredAt: me.acquiredAt,
			async refresh() {
				if (released) return err({
					code: "E_LOCK_STATE",
					message: "锁已释放"
				});
				const done = await withGuard(p, now, () => {
					const cur = readLock(p);
					if (!cur) return false;
					if (!cur.owners.find((o) => sameOwner(o.owner, request.owner))) return false;
					const content = {
						...cur,
						owners: cur.owners.map((o) => sameOwner(o.owner, request.owner) ? {
							...o,
							expiresAt: now() + request.ttlMs
						} : o)
					};
					const tmp = p + ".tmp." + crypto.randomBytes(4).toString("hex");
					fs.writeFileSync(tmp, JSON.stringify(content, null, 2));
					fs.renameSync(tmp, p);
					return true;
				});
				if (done === null) return err({
					code: "E_LOCK_STATE",
					message: "刷新锁失败：互斥 guard 在等待窗口内不可用"
				});
				if (done === false) return err({
					code: "E_LOCK_STALE",
					message: "锁文件已消失或本持有者已不在锁中（可能被安全破锁）"
				});
				return ok(void 0);
			},
			async release() {
				if (released) return ok(void 0);
				released = true;
				try {
					if (request.mode === "shared") {
						if (await withGuard(p, now, () => {
							const cur = readLock(p);
							if (!cur) return true;
							const rest = cur.owners.filter((o) => !sameOwner(o.owner, request.owner));
							if (rest.length === 0) try {
								fs.unlinkSync(p);
							} catch {}
							else {
								const tmp = p + ".tmp." + crypto.randomBytes(4).toString("hex");
								fs.writeFileSync(tmp, JSON.stringify({
									...cur,
									owners: rest
								}, null, 2));
								fs.renameSync(tmp, p);
							}
							return true;
						}) !== true) return err({
							code: "E_LOCK_STATE",
							message: "释放锁失败：互斥 guard 在等待窗口内不可用"
						});
					} else try {
						fs.unlinkSync(p);
					} catch {}
					return ok(void 0);
				} catch (e) {
					return err(ioError("释放锁失败", e));
				}
			}
		};
	}
	async function acquire(request) {
		const deadline = now() + request.waitTimeoutMs;
		for (;;) {
			const handle = await tryOnce(request);
			if (handle) return ok(handle);
			if (now() >= deadline) {
				const holders = readLock(lockPath(request.scope))?.owners.map((o) => `${o.owner.purpose}(pid ${o.owner.pid})`).join(", ") ?? "unknown";
				return err({
					code: "E_LOCK_HELD",
					message: `获取锁超时（${request.waitTimeoutMs}ms）：scope=${scopeKey(request.scope)} mode=${request.mode}，当前持有: ${holders}`
				});
			}
			await sleep(Math.min(50, Math.max(1, deadline - now())));
		}
	}
	return {
		acquire,
		async tryAcquire(request) {
			return await tryOnce(request);
		},
		async withLock(request, fn) {
			const got = await acquire(request);
			if (!got.ok) return got;
			try {
				return await fn(got.value);
			} catch (e) {
				return err(ioError("临界区异常", e));
			} finally {
				await got.value.release();
			}
		},
		async breakStale(proof) {
			if (!proof.verifiedDead) return err({
				code: "E_LOCK_STALE",
				message: "拒绝破锁：持有者进程仍存活，未满足 verifiedDead"
			});
			if (!proof.ttlExpired) return err({
				code: "E_LOCK_STALE",
				message: "拒绝破锁：TTL 未过期"
			});
			let broken = 0;
			for (const f of fs.readdirSync(lockDir)) {
				if (!f.endsWith(".lock")) continue;
				const fp = path.join(lockDir, f);
				if (await withGuard(fp, now, () => {
					const cur = readLock(fp);
					if (!cur) return;
					const staleSlots = cur.owners.filter((o) => sameOwner(o.owner, proof.owner) && o.expiresAt <= now() && !probe.isAlive(o.owner.pid, o.owner.hostname));
					if (staleSlots.length === 0) return;
					const rest = cur.owners.filter((o) => !staleSlots.includes(o));
					if (rest.length === 0) try {
						fs.unlinkSync(fp);
					} catch {}
					else {
						const tmp = fp + ".tmp." + crypto.randomBytes(4).toString("hex");
						fs.writeFileSync(tmp, JSON.stringify({
							...cur,
							owners: rest
						}, null, 2));
						fs.renameSync(tmp, fp);
					}
					broken++;
				}) === null) continue;
			}
			if (broken === 0) return err({
				code: "E_LOCK_STALE",
				message: "未找到符合条件的陈旧锁"
			});
			return ok(void 0);
		},
		holders(scope) {
			const cur = readLock(lockPath(scope));
			if (!cur) return [];
			return cur.owners.filter((o) => o.expiresAt > now()).map((o) => o.owner);
		}
	};
}
function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
const GUARD_SUFFIX = ".mut";
const GUARD_SUPERSEDE_MS = 1e4;
const GUARD_RETRY_MS = 20;
const GUARD_MAX_WAIT_MS = 15e3;
/** 在 p 的 guard 保护下执行 fn（同步体）。返回 null = guard 在等待窗口内不可用。 */
async function withGuard(p, now, fn) {
	const guard = p + GUARD_SUFFIX;
	const token = crypto.randomBytes(8).toString("hex");
	const start = now();
	for (;;) {
		try {
			fs.mkdirSync(guard);
		} catch (e) {
			if (e.code !== "EEXIST") return null;
			try {
				const st = fs.statSync(guard);
				if (now() - st.mtimeMs > GUARD_SUPERSEDE_MS) {
					fs.rmSync(guard, {
						recursive: true,
						force: true
					});
					continue;
				}
			} catch {}
			if (now() - start > GUARD_MAX_WAIT_MS) return null;
			await sleep(GUARD_RETRY_MS);
			continue;
		}
		try {
			fs.writeFileSync(path.join(guard, "owner"), token, "utf-8");
			return fn();
		} finally {
			try {
				if (fs.readFileSync(path.join(guard, "owner"), "utf-8") === token) fs.rmSync(guard, {
					recursive: true,
					force: true
				});
			} catch {}
		}
	}
}
//#endregion
//#region src/infra/wal.ts
/**
* 每事务一个 <txId>.wal.jsonl。
* 物理保证：每条记录 append + fdatasync 后才返回 —— 进程崩溃最多丢"正在写"的
* 那一条；重放时 step-intent 无对应 step-done 的步骤按"半执行"处理（触发反向补偿）。
*
* 完整性保证（世界级升级）：JSON.parse 只能拦"语法损坏"——字段被篡改或位腐烂后
* 仍是合法 JSON，重放会拿到被污染的意图。每条记录写入时附带 `__crc`
* （SHA-256 截断 16 hex，覆盖记录除 __crc 外的规范化 JSON），
* replay/unfinishedTxIds 逐条校验：CRC 不匹配按损坏处理（同语法损坏纪律）。
* 无 __crc 的历史行（旧版本写入）按原样接受 —— 读取宽容，写入严格。
*/
const TXID_RE$1 = /^[A-Za-z0-9_-]{1,64}$/;
const CRC_FIELD = "__crc";
/** 规范化 CRC：键序稳定的 JSON 序列化后取 SHA-256 前 16 hex */
function computeCrc(record) {
	const { ...rest } = record;
	delete rest[CRC_FIELD];
	const canonical = JSON.stringify(rest, Object.keys(rest).sort());
	return crypto.createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}
/** 解析并校验一行；返回 null = 该行损坏（语法或 CRC） */
function parseLine(line) {
	let parsed;
	try {
		parsed = JSON.parse(line);
	} catch {
		return null;
	}
	if (typeof parsed !== "object" || parsed === null || typeof parsed.type !== "string") return null;
	if (parsed[CRC_FIELD] !== void 0) {
		if (typeof parsed[CRC_FIELD] !== "string" || parsed[CRC_FIELD] !== computeCrc(parsed)) return null;
		const { ...clean } = parsed;
		delete clean[CRC_FIELD];
		return clean;
	}
	return parsed;
}
function createWal(options) {
	fs.mkdirSync(options.walRoot, { recursive: true });
	function file(txId) {
		if (!TXID_RE$1.test(txId)) throw new Error(`非法 txId（疑似路径注入）: ${JSON.stringify(String(txId).slice(0, 40))}`);
		return path.join(options.walRoot, `${txId}.wal.jsonl`);
	}
	return {
		async append(txId, record) {
			const line = JSON.stringify({
				...record,
				[CRC_FIELD]: computeCrc(record)
			});
			const fd = fs.openSync(file(txId), "a");
			try {
				fs.writeSync(fd, line + "\n");
				fs.fdatasyncSync(fd);
			} finally {
				fs.closeSync(fd);
			}
		},
		async replay(txId) {
			const p = file(txId);
			let text;
			try {
				text = fs.readFileSync(p, "utf-8");
			} catch {
				return [];
			}
			const lines = text.split("\n").filter((l) => l.trim().length > 0);
			const records = [];
			let corruptMiddle = false;
			for (const [i, line] of lines.entries()) {
				const rec = parseLine(line);
				if (rec === null) {
					if (i === lines.length - 1) break;
					corruptMiddle = true;
					break;
				}
				records.push(rec);
			}
			if (corruptMiddle) return [];
			return records;
		},
		unfinishedTxIds() {
			const out = [];
			let files;
			try {
				files = fs.readdirSync(options.walRoot);
			} catch {
				return out;
			}
			for (const f of files) {
				if (!f.endsWith(".wal.jsonl")) continue;
				const txId = f.slice(0, -10);
				if (!TXID_RE$1.test(txId)) continue;
				let text;
				try {
					text = fs.readFileSync(path.join(options.walRoot, f), "utf-8");
				} catch {
					continue;
				}
				const lines = text.split("\n").filter((l) => l.trim().length > 0);
				let corruptMiddle = false;
				let finished = false;
				lines.forEach((l, i) => {
					const rec = parseLine(l);
					if (rec === null) {
						if (i !== lines.length - 1) corruptMiddle = true;
						return;
					}
					if (rec.type === "tx-commit" || rec.type === "tx-rollback") finished = true;
				});
				if (corruptMiddle) continue;
				if (!finished) out.push(txId);
			}
			return out;
		}
	};
}
//#endregion
//#region src/infra/fs-utils.ts
/** 递归目录体积（符号链接不跟随；读不到的条目按 0 计）。
*  入口 lstat 防护 + 深度上限：传入符号链接返回 0（防 symlink→/ 的全盘递归 DoS），
*  超过 64 层深视为异常结构直接停止。 */
function dirSize(p) {
	try {
		if (fs.lstatSync(p).isSymbolicLink()) return 0;
	} catch {
		return 0;
	}
	let total = 0;
	const walk = (dir, depth) => {
		if (depth > 64) return;
		let entries;
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const e of entries) {
			const full = path.join(dir, e.name);
			if (e.isDirectory()) walk(full, depth + 1);
			else if (e.isFile()) try {
				total += fs.statSync(full).size;
			} catch {}
		}
	};
	walk(p, 0);
	return total;
}
function existsSafe(p) {
	try {
		return fs.existsSync(p);
	} catch {
		return false;
	}
}
/** statfs 磁盘采样（Node ≥18.15）：free = bsize×bavail，total = bsize×blocks。
*  旧 Node（API 缺失抛 TypeError）/ 无权限 / 路径不存在 → null（fail-soft，
*  调用方按"磁盘信息不可用"降级，绝不阻断主流程）。全项目唯一实现。 */
function statfsBytes(root) {
	try {
		const st = fs.statfsSync(root);
		if (!st) return null;
		return {
			free: Number(st.bsize) * Number(st.bavail),
			total: Number(st.bsize) * Number(st.blocks)
		};
	} catch {
		return null;
	}
}
/** 进程崩溃安全的唯一临时文件名：同进程并发不撞车 */
function tmpName(dst) {
	return `${dst}.tmp-${process.pid}-${crypto.randomBytes(3).toString("hex")}`;
}
/**
* 原子复制：tmp + rename，中断不留半写文件于目标位。
* 自动创建父目录；返回目标文件字节数。失败路径清理 tmp（防半写残留堆积）。
*/
function copyAtomic(src, dst) {
	fs.mkdirSync(path.dirname(dst), { recursive: true });
	const tmp = tmpName(dst);
	try {
		fs.copyFileSync(src, tmp);
		fs.renameSync(tmp, dst);
	} catch (e) {
		try {
			fs.unlinkSync(tmp);
		} catch {}
		throw e;
	}
	return fs.statSync(dst).size;
}
/** 原子写文本（UTF-8）：配置/meta 落盘统一入口。失败路径清理 tmp。 */
function writeTextAtomic(file, content) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const tmp = tmpName(file);
	try {
		fs.writeFileSync(tmp, content, "utf-8");
		fs.renameSync(tmp, file);
	} catch (e) {
		try {
			fs.unlinkSync(tmp);
		} catch {}
		throw e;
	}
}
/** 原子写 JSON（2 空格缩进，确定性输出） */
function writeJsonAtomic(file, value) {
	writeTextAtomic(file, JSON.stringify(value, null, 2));
}
/**
* 容错式 JSONL 读取：逐行解析，损坏行（含崩溃残留的尾部半行）跳过。
* 返回 null 表示文件不存在/不可读。
*/
function readJsonl(file) {
	let text;
	try {
		text = fs.readFileSync(file, "utf-8");
	} catch {
		return null;
	}
	const out = [];
	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			out.push(JSON.parse(trimmed));
		} catch {}
	}
	return out;
}
/** 追加一行 JSON（自动建目录） */
function appendJsonl(file, entry) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.appendFileSync(file, JSON.stringify(entry) + "\n", "utf-8");
}
/** 有界并发 map：保持输入顺序的输出；fn 抛错该项为 rejected（不炸整池） */
async function forEachPool(items, concurrency, fn) {
	const results = new Array(items.length);
	let cursor = 0;
	const lanes = Math.max(1, Math.min(concurrency, items.length || 1));
	const worker = async () => {
		for (;;) {
			const i = cursor++;
			if (i >= items.length) return;
			try {
				results[i] = {
					status: "fulfilled",
					value: await fn(items[i], i)
				};
			} catch (e) {
				results[i] = {
					status: "rejected",
					reason: e
				};
			}
		}
	};
	await Promise.all(Array.from({ length: lanes }, worker));
	return results;
}
/** 并行目录体积（dirSize 的并发版）：目录读经并发池分发。
*  语义与 dirSize 一致：符号链接不跟随、读不到按 0、深度上限 64。 */
async function dirSizeAsync(p, opts = {}) {
	const concurrency = opts.concurrency ?? 8;
	try {
		if (fs.lstatSync(p).isSymbolicLink()) return 0;
	} catch {
		return 0;
	}
	let total = 0;
	const walk = async (dir, depth) => {
		if (depth > 64 || opts.signal?.aborted) return;
		let entries;
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		const subdirs = [];
		await forEachPool(entries, concurrency, async (e) => {
			const full = path.join(dir, e.name);
			if (e.isDirectory()) subdirs.push(full);
			else if (e.isFile()) try {
				total += fs.statSync(full).size;
			} catch {}
		});
		await forEachPool(subdirs, concurrency, (sub) => walk(sub, depth + 1));
	};
	await walk(p, 0);
	return total;
}
/** TEMP 根目录下带 dsh 痕迹且超过 maxAgeDays 的条目，按体积降序。
*  符号链接不跟随（statSync 遵循链接，故先用 lstat 排除）。 */
function tempOrphanEntries(tempRoot, maxAgeDays, now, markerRe = /dsh|deepseek|cordis/i) {
	const out = [];
	let entries;
	try {
		entries = fs.readdirSync(tempRoot, { withFileTypes: true });
	} catch {
		return out;
	}
	const nowMs = now().getTime();
	for (const e of entries) {
		if (!markerRe.test(e.name)) continue;
		const full = path.join(tempRoot, e.name);
		try {
			const lst = fs.lstatSync(full);
			if (lst.isSymbolicLink()) continue;
			const st = fs.statSync(full);
			const ageDays = (nowMs - st.mtimeMs) / 864e5;
			if (ageDays >= maxAgeDays) out.push({
				path: full,
				isDir: lst.isDirectory(),
				sizeBytes: lst.isDirectory() ? dirSize(full) : st.size,
				ageDays
			});
		} catch {}
	}
	return out.sort((a, b) => b.sizeBytes - a.sizeBytes);
}
//#endregion
//#region src/infra/backup-store.ts
const TXID_RE = /^[A-Za-z0-9_-]{1,64}$/;
function createBackupStore(options) {
	fs.mkdirSync(options.backupRoot, { recursive: true });
	function hashFile(p) {
		return crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex").slice(0, 16);
	}
	function hashString(s) {
		return crypto.createHash("sha256").update(s, "utf-8").digest("hex").slice(0, 16);
	}
	/** 目录指纹：按序累积全部文件内容哈希（结构敏感，与旧 fingerprint.ts 一致） */
	function hashDir(p) {
		const h = crypto.createHash("sha256");
		const walk = (dir) => {
			for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
				const full = path.join(dir, e.name);
				if (e.isDirectory()) walk(full);
				else if (e.isFile()) h.update(fs.readFileSync(full));
			}
		};
		walk(p);
		return h.digest("hex").slice(0, 16);
	}
	function fingerprintOf(p, content) {
		const stat = fs.statSync(p);
		if (stat.isDirectory()) return {
			path: p,
			hash: hashDir(p),
			size: dirSize(p),
			mtime: Math.floor(stat.mtimeMs)
		};
		return {
			path: p,
			hash: content !== void 0 ? hashString(content) : hashFile(p),
			size: content !== void 0 ? Buffer.byteLength(content) : stat.size,
			mtime: Math.floor(stat.mtimeMs)
		};
	}
	function txArea(txId) {
		if (!TXID_RE.test(txId)) throw new Error(`非法 txId（疑似路径注入）: ${JSON.stringify(String(txId).slice(0, 40))}`);
		return path.join(options.backupRoot, txId);
	}
	function manifestFile(txId) {
		return path.join(txArea(txId), "manifest.jsonl");
	}
	function appendManifest(txId, record) {
		const fd = fs.openSync(manifestFile(txId), "a");
		try {
			fs.writeSync(fd, JSON.stringify(record) + "\n");
			fs.fdatasyncSync(fd);
		} finally {
			fs.closeSync(fd);
		}
	}
	function writeSync(p, content) {
		const fd = fs.openSync(p, "w");
		try {
			fs.writeSync(fd, content);
			fs.fsyncSync(fd);
		} finally {
			fs.closeSync(fd);
		}
	}
	return { async reserve(txId) {
		fs.mkdirSync(txArea(txId), { recursive: true });
		/** manifest 读取的闭包级实现（对象字面量方法间不能互相按名调用） */
		const readManifest = () => {
			const p = manifestFile(txId);
			if (!fs.existsSync(p)) return [];
			return readJsonl(p) ?? [];
		};
		return {
			async stageFile(original) {
				const backupPath = path.join(txArea(txId), `f-${counter()}-${path.basename(original)}`);
				fs.copyFileSync(original, backupPath);
				const record = {
					operationId: counter(),
					kind: "file-copy",
					originalPath: original,
					backupPath,
					fingerprint: fingerprintOf(backupPath)
				};
				try {
					appendManifest(txId, record);
				} catch (e) {
					try {
						fs.unlinkSync(backupPath);
					} catch {}
					throw e;
				}
				return record;
			},
			async stageDir(original) {
				const backupPath = path.join(txArea(txId), `d-${counter()}-${path.basename(original)}`);
				let movedByRename = false;
				try {
					fs.renameSync(original, backupPath);
					movedByRename = true;
				} catch {
					try {
						fs.cpSync(original, backupPath, { recursive: true });
					} catch (e) {
						try {
							fs.rmSync(backupPath, {
								recursive: true,
								force: true
							});
						} catch {}
						throw e;
					}
				}
				const record = {
					operationId: counter(),
					kind: "dir-move",
					originalPath: original,
					backupPath,
					fingerprint: fingerprintOf(backupPath)
				};
				try {
					appendManifest(txId, record);
				} catch (e) {
					if (movedByRename) try {
						fs.renameSync(backupPath, original);
					} catch {}
					else try {
						fs.rmSync(backupPath, {
							recursive: true,
							force: true
						});
					} catch {}
					throw e;
				}
				if (!movedByRename) fs.rmSync(original, {
					recursive: true,
					force: true
				});
				return record;
			},
			async stageEdit(original, nextContent) {
				const backupPath = path.join(txArea(txId), `e-${counter()}-${path.basename(original)}`);
				const originalContent = fs.readFileSync(original, "utf-8");
				writeSync(backupPath, originalContent);
				writeSync(original, nextContent);
				const record = {
					operationId: counter(),
					kind: "yaml-edit",
					originalPath: original,
					backupPath,
					fingerprint: fingerprintOf(backupPath, originalContent),
					originalContent
				};
				try {
					appendManifest(txId, record);
				} catch (e) {
					writeSync(original, originalContent);
					try {
						fs.unlinkSync(backupPath);
					} catch {}
					throw e;
				}
				return record;
			},
			async restore(record) {
				try {
					if (!fs.existsSync(record.backupPath)) {
						if (record.kind === "dir-move" && fs.existsSync(record.originalPath)) return ok(void 0);
						return err({
							code: "E_IO",
							message: `备份产物不存在: ${record.backupPath}`
						});
					}
					const currentHash = record.kind === "dir-move" ? hashDir(record.backupPath) : record.originalContent !== void 0 ? hashString(fs.readFileSync(record.backupPath, "utf-8")) : hashFile(record.backupPath);
					if (currentHash !== record.fingerprint.hash) return err({
						code: "E_IO",
						message: `备份被篡改，拒绝恢复: ${record.backupPath}`,
						details: {
							expected: record.fingerprint.hash,
							actual: currentHash
						}
					});
					switch (record.kind) {
						case "file-copy":
							fs.copyFileSync(record.backupPath, record.originalPath);
							break;
						case "dir-move":
							if (fs.existsSync(record.originalPath)) return err({
								code: "E_IO",
								message: `原位已存在新内容，拒绝覆盖式恢复: ${record.originalPath}`
							});
							try {
								fs.renameSync(record.backupPath, record.originalPath);
							} catch {
								fs.cpSync(record.backupPath, record.originalPath, { recursive: true });
								fs.rmSync(record.backupPath, {
									recursive: true,
									force: true
								});
							}
							break;
						case "yaml-edit": writeSync(record.originalPath, record.originalContent ?? fs.readFileSync(record.backupPath, "utf-8"));
					}
					return ok(void 0);
				} catch (e) {
					return err(ioError("恢复失败", e));
				}
			},
			manifest() {
				return readManifest();
			},
			orphanArtifacts() {
				const area = txArea(txId);
				let entries;
				try {
					entries = fs.readdirSync(area);
				} catch {
					return 0;
				}
				const known = new Set(readManifest().map((r) => path.basename(r.backupPath)));
				known.add("manifest.jsonl");
				return entries.filter((name) => !known.has(name)).length;
			},
			async purge(txId) {
				try {
					fs.rmSync(txArea(txId), {
						recursive: true,
						force: true
					});
					return ok(void 0);
				} catch (e) {
					return err(ioError("清理备份区失败", e));
				}
			}
		};
	} };
	/** 备份产物唯一后缀（随机 hex：同事务内多文件备份不撞名） */
	function counter() {
		return crypto.randomBytes(6).toString("hex");
	}
}
//#endregion
//#region src/infra/audit-log.ts
const GENESIS = "0".repeat(16);
/** 规范化 JSON：键排序 + 无空格，保证同一条目任何环境算出同一 hash */
function canonicalJson(v) {
	if (v === null || typeof v !== "object") return JSON.stringify(v);
	if (Array.isArray(v)) return "[" + v.map(canonicalJson).join(",") + "]";
	return "{" + Object.entries(v).filter(([, val]) => val !== void 0).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, val]) => `${JSON.stringify(k)}:${canonicalJson(val)}`).join(",") + "}";
}
function computeHash(prevHash, entry) {
	return crypto.createHash("sha256").update(prevHash + canonicalJson(entry)).digest("hex").slice(0, 16);
}
function createAuditLog(options) {
	fs.mkdirSync(path.dirname(options.filePath), { recursive: true });
	if (!fs.existsSync(options.filePath)) fs.writeFileSync(options.filePath, "");
	/** 链尾哨兵文件：独立记录最后一次 append 的 seq/hash。
	*  单独删除链文件尾部不会破坏剩余链的连续性（尾条目无后继引用），
	*  哨兵使 verify() 能检出这种"抹除最近记录"的截断攻击。 */
	function headFile() {
		return options.filePath + ".head.json";
	}
	function readAll() {
		return readJsonl(options.filePath) ?? [];
	}
	const tail = (() => {
		const all = readAll();
		const last = all[all.length - 1];
		return {
			seq: all.length,
			hash: last?.hash ?? GENESIS
		};
	})();
	return {
		async append(entry) {
			const prev = tail.hash;
			const seq = tail.seq;
			const hashed = {
				...entry,
				seq,
				prevHash: prev,
				hash: computeHash(prev, entry)
			};
			tail.seq = seq + 1;
			tail.hash = hashed.hash;
			const fd = fs.openSync(options.filePath, "a");
			try {
				fs.writeSync(fd, JSON.stringify(hashed) + "\n");
				fs.fdatasyncSync(fd);
			} finally {
				fs.closeSync(fd);
			}
			writeJsonAtomic(headFile(), {
				seq: hashed.seq,
				hash: hashed.hash
			});
			return hashed;
		},
		async verify() {
			const all = readAll();
			let prev = GENESIS;
			for (const [i, e] of all.entries()) {
				const { seq: _s, prevHash: _p, hash: _h, ...raw } = e;
				if (e.seq !== i || e.prevHash !== prev || e.hash !== computeHash(prev, raw)) return {
					valid: false,
					firstBrokenSeq: e.seq,
					totalEntries: all.length
				};
				prev = e.hash;
			}
			if (fs.existsSync(headFile())) {
				let head = null;
				try {
					head = JSON.parse(fs.readFileSync(headFile(), "utf-8"));
				} catch {
					head = null;
				}
				const last = all[all.length - 1];
				if (head && typeof head.seq === "number" && typeof head.hash === "string") {
					const expectedSeq = last ? last.seq : -1;
					const expectedHash = last ? last.hash : GENESIS;
					if (head.seq !== expectedSeq || head.hash !== expectedHash) return {
						valid: false,
						firstBrokenSeq: null,
						totalEntries: all.length
					};
				}
			}
			return {
				valid: true,
				firstBrokenSeq: null,
				totalEntries: all.length
			};
		},
		async query(filter) {
			return readAll().filter((e) => (filter.txId === void 0 || e.txId === filter.txId) && (filter.actor === void 0 || e.actor === filter.actor) && (filter.since === void 0 || e.timestamp >= filter.since));
		}
	};
}
//#endregion
//#region src/engine/hook-registry.ts
const DEFAULT_ALLOW_BINS = [
	"node",
	"python",
	"python3",
	"dsh",
	"pnpm",
	"npm",
	"git"
];
function createHookRegistry(options) {
	const allowBins = options.allowBins ?? DEFAULT_ALLOW_BINS;
	const defs = [];
	let seq = 0;
	/** 磁盘钩子的注销句柄：loadFromDisk 幂等的关键 —— 重载前先注销上一轮，
	*  否则多次调用（如配置热重载）会叠加注册同一批钩子导致重复执行。 */
	let diskUnsubscribers = [];
	function runCommand(handler, ctx) {
		return new Promise((resolve) => {
			const bin = handler.argv[0] ?? "";
			const env = { PATH: process.env.PATH ?? "" };
			for (const key of handler.envWhitelist) {
				const v = process.env[key];
				if (v !== void 0) env[key] = v;
			}
			env.NUKE_PLUGIN = ctx.plugin;
			env.NUKE_PROFILE = ctx.profile;
			env.NUKE_ACTION = ctx.action;
			env.NUKE_TX = ctx.txId;
			execFile(bin, handler.argv.slice(1), {
				env,
				timeout: handler.timeoutMs,
				maxBuffer: 65536
			}, (error, stdout, stderr) => {
				if (error) {
					const detail = String(stderr || stdout || "").trim().slice(0, 200);
					resolve({
						ok: false,
						message: `钩子命令失败(${bin}): ${error.message}${detail ? ` | ${detail}` : ""}`
					});
				} else resolve({
					ok: true,
					message: String(stdout).trim().slice(0, 200)
				});
			});
		});
	}
	function register(def) {
		const id = def.id ?? `hook-${seq++}`;
		const withId = {
			...def,
			id
		};
		defs.push(withId);
		return () => {
			const i = defs.indexOf(withId);
			if (i >= 0) defs.splice(i, 1);
		};
	}
	return {
		register,
		async emit(timing, ctx) {
			const matching = defs.filter((d) => d.timing === timing).filter((d) => d.actions === "*" || d.actions.includes(ctx.action)).sort((a, b) => a.priority - b.priority);
			let executed = 0, failed = 0;
			let verdict = { kind: "proceed" };
			let errorDirective = null;
			const messages = [];
			for (const def of matching) {
				executed++;
				if (def.handler.type === "inline") try {
					const r = await def.handler.run(ctx);
					if (timing === "pre" && r && typeof r === "object" && "kind" in r) {
						const v = r;
						if (v.kind === "veto" && verdict.kind !== "veto") verdict = v;
						if (v.kind === "proceed-with-warning") messages.push(`⚠️ ${v.message}`);
					}
					if (timing === "error" && typeof r === "string") errorDirective = errorDirective ?? r;
				} catch (e) {
					failed++;
					messages.push(`❌ 钩子 ${def.id} 异常: ${errorToMessage(e)}`);
					if (def.onFailure === "fail-fast") return err({
						code: "E_HOOK_VETO",
						message: `钩子 ${def.id} fail-fast: ${errorToMessage(e)}`
					});
				}
				else {
					const argv0 = def.handler.argv[0] ?? "";
					if (argv0 === "" || /[\\/]/.test(argv0)) {
						failed++;
						messages.push(`❌ 钩子 ${def.id} argv[0] 必须为裸命令名（禁止路径）: "${argv0}"`);
						if (def.onFailure === "fail-fast") return err({
							code: "E_HOOK_VETO",
							message: `钩子 ${def.id} argv[0] 含路径，拒绝执行`
						});
						continue;
					}
					const bin = argv0.replace(/\.exe$/i, "");
					if (!allowBins.includes(bin)) {
						failed++;
						messages.push(`❌ 钩子 ${def.id} 命令不在白名单: ${bin}`);
						if (def.onFailure === "fail-fast") return err({
							code: "E_HOOK_VETO",
							message: `钩子命令白名单外: ${bin}`
						});
						continue;
					}
					const r = await runCommand(def.handler, ctx);
					if (r.ok) {
						if (r.message) messages.push(`✅ [${def.id}] ${r.message}`);
					} else {
						failed++;
						messages.push(`❌ [${def.id}] ${r.message}`);
						if (timing === "pre" && def.handler.nonzeroExitIsVeto) verdict = {
							kind: "veto",
							reason: r.message
						};
						if (def.onFailure === "fail-fast") return err({
							code: "E_HOOK_VETO",
							message: `钩子 ${def.id} fail-fast`
						});
					}
				}
			}
			return ok({
				executed,
				failed,
				verdict,
				errorDirective,
				messages
			});
		},
		async loadFromDisk() {
			for (const off of diskUnsubscribers) off();
			diskUnsubscribers = [];
			for (const timing of [
				"pre",
				"post",
				"error"
			]) {
				const p = path.join(options.dir, `${timing}.json`);
				if (!fs.existsSync(p)) continue;
				try {
					const parsed = JSON.parse(fs.readFileSync(p, "utf-8"));
					if (!Array.isArray(parsed)) return err({
						code: "E_VALIDATION",
						message: `钩子文件必须是数组: ${p}`
					});
					for (const d of parsed) {
						if (typeof d !== "object" || d === null) continue;
						const def = d;
						if (typeof def.timing !== "string" || typeof def.onFailure !== "string") continue;
						if (def.handler?.type === "command") {
							const argv = def.handler.argv;
							if (!Array.isArray(argv) || argv.length === 0 || !argv.every((a) => typeof a === "string")) continue;
							if (/[\\/]/.test(argv[0] ?? "")) continue;
							if (!Array.isArray(def.handler.envWhitelist)) continue;
							if (typeof def.handler.timeoutMs !== "number") continue;
						} else if (def.handler?.type !== "inline") continue;
						diskUnsubscribers.push(register({
							...d,
							timing
						}));
					}
				} catch (e) {
					return err(ioError(`钩子文件解析失败 ${p}`, e));
				}
			}
			return ok(void 0);
		},
		list() {
			return [...defs];
		}
	};
}
//#endregion
//#region src/infra/scan-cache.ts
const MAX_DEFAULT = 4096;
const MAX_AGE_MS_DEFAULT = 864e5;
function createScanCache(options) {
	const maxEntries = options.maxEntries ?? MAX_DEFAULT;
	const maxAgeMs = options.maxAgeMs ?? MAX_AGE_MS_DEFAULT;
	const cache = /* @__PURE__ */ new Map();
	let dirty = false;
	let hits = 0;
	let misses = 0;
	try {
		if (fs.existsSync(options.filePath)) {
			const parsed = JSON.parse(fs.readFileSync(options.filePath, "utf-8"));
			if (typeof parsed === "object" && parsed !== null) {
				const shape = parsed;
				if (shape.version === 1 && typeof shape.entries === "object" && shape.entries !== null) {
					for (const [k, v] of Object.entries(shape.entries)) if (typeof v === "object" && v !== null && typeof v.mtimeMs === "number" && typeof v.size === "number" && typeof v.cachedAt === "number") cache.set(k, v);
				}
			}
		}
	} catch {}
	function evictIfNeeded() {
		while (cache.size > maxEntries) {
			const oldest = cache.keys().next().value;
			if (oldest === void 0) break;
			cache.delete(oldest);
		}
	}
	return {
		get(filePath, mtimeMs, size) {
			const hit = cache.get(filePath);
			if (hit === void 0) {
				misses++;
				return null;
			}
			if (hit.mtimeMs !== mtimeMs || hit.size !== size) {
				misses++;
				return null;
			}
			if (Date.now() - hit.cachedAt >= maxAgeMs) {
				misses++;
				return null;
			}
			hits++;
			cache.delete(filePath);
			cache.set(filePath, hit);
			return hit;
		},
		set(filePath, entry) {
			cache.delete(filePath);
			cache.set(filePath, {
				...entry,
				cachedAt: Date.now()
			});
			evictIfNeeded();
			dirty = true;
		},
		flush() {
			if (!dirty) return;
			const shape = {
				version: 1,
				entries: Object.fromEntries(cache)
			};
			try {
				fs.mkdirSync(path.dirname(options.filePath), { recursive: true });
				writeJsonAtomic(options.filePath, shape);
				dirty = false;
			} catch {}
		},
		stats() {
			return {
				entries: cache.size,
				hits,
				misses
			};
		}
	};
}
//#endregion
//#region src/engine/transaction-engine.ts
/** 状态机合法迁移表 */
const TRANSITIONS = {
	draft: ["planned"],
	planned: ["validating", "draft"],
	validating: ["executing", "planned"],
	executing: ["committing", "rolling-back"],
	committing: ["committed"],
	"rolling-back": ["rolled-back", "failed"],
	committed: [],
	"rolled-back": [],
	failed: []
};
function createTransactionEngine(deps, operationFactory) {
	const runtimes = /* @__PURE__ */ new Map();
	/** 终结事务摘要缓存（commit/rollback 后仍可 status 查询；进程重启后回退 WAL 重建）。
	*  LRU 上限：长驻进程中无限增长的 Map 是慢性内存泄漏；溢出逐最旧，
	*  被逐条目仍可从 WAL 重建（status 的第三路径）。 */
	const FINISHED_CACHE_MAX = 128;
	const finished = /* @__PURE__ */ new Map();
	function rememberFinished(txId, summary) {
		if (finished.has(txId)) finished.delete(txId);
		else if (finished.size >= FINISHED_CACHE_MAX) {
			const oldest = finished.keys().next().value;
			if (oldest !== void 0) finished.delete(oldest);
		}
		finished.set(txId, summary);
	}
	function setState(rt, next) {
		if (!TRANSITIONS[rt.state].includes(next)) return err({
			code: "E_TX_STATE",
			message: `非法状态迁移: ${rt.state} → ${next}（tx ${rt.txId}）`
		});
		rt.state = next;
		return ok(void 0);
	}
	function makeCtxFromRt(rt) {
		return {
			txId: rt.txId,
			request: rt.request,
			resolver: deps.resolver,
			logger: deps.logger.child({ tx: rt.txId }),
			clock: deps.clock,
			backups: rt.backupsArea
		};
	}
	function hookCtx(txId, request, op, backup) {
		return {
			txId,
			actor: request.actor,
			plugin: op.target,
			profile: request.profile,
			strategy: request.strategy,
			action: op.action,
			...backup ? { backup } : {}
		};
	}
	/** Saga 反向补偿：manifest 逆序 restore（幂等），并逐 op 调 undo 做额外清理。
	*  安全纪律：本函数自身绝不抛出 —— 它运行在 commit 的失败分支与 catch 块中，
	*  一旦抛出会跳过外层的锁释放（独占锁悬挂 = 后续所有事务被阻塞直至 TTL）。 */
	async function rollbackRuntime(rt, reason) {
		if (!setState(rt, "rolling-back").ok) deps.logger.warn("回滚状态迁移被拒，继续执行补偿动作", {
			tx: rt.txId,
			state: rt.state
		});
		const ctx = makeCtxFromRt(rt);
		const records = rt.backupsArea.manifest();
		for (const record of [...records].reverse()) try {
			const r = await rt.backupsArea.restore(record);
			if (!r.ok) deps.logger.error("回滚恢复失败", {
				path: record.originalPath,
				error: r.error.message
			});
		} catch (e) {
			deps.logger.error("回滚恢复异常", {
				path: record.originalPath,
				error: errorToMessage(e)
			});
		}
		const executedOps = new Map(rt.steps.filter((s) => s.status === "done").map((s) => [s.operationId, s.backup]));
		for (const op of operationFactory(rt.request)) {
			const backup = executedOps.get(op.id) ?? null;
			try {
				const undo = await op.undo(ctx, backup);
				if (!undo.ok) deps.logger.warn("op.undo 报告", {
					op: op.id,
					error: undo.error.message
				});
			} catch (e) {
				deps.logger.error("op.undo 异常", {
					op: op.id,
					error: errorToMessage(e)
				});
			}
			rt.steps = rt.steps.map((s) => s.operationId === op.id && s.status === "done" ? {
				...s,
				status: "undone"
			} : s);
		}
		try {
			await deps.wal.append(ctx.txId, {
				type: "tx-rollback",
				txId: ctx.txId,
				reason
			});
		} catch (e) {
			deps.logger.error("回滚 WAL 追加失败（事务将保持可恢复状态）", {
				tx: ctx.txId,
				error: errorToMessage(e)
			});
		}
		rt.finishedAt = deps.clock.now().toISOString();
		setState(rt, rt.state === "rolling-back" ? "rolled-back" : "failed");
		try {
			await deps.audit.append({
				timestamp: rt.finishedAt,
				actor: rt.request.actor,
				action: "tx-rollback",
				txId: ctx.txId,
				outcome: "failure",
				detail: {
					reason,
					undone: records.length
				}
			});
		} catch (e) {
			deps.logger.error("回滚审计追加失败", {
				tx: ctx.txId,
				error: errorToMessage(e)
			});
		}
	}
	/** 事务终结收尾：摘要入缓存 → 释放独占锁 → 移除运行时。
	*  commit/rollback 的所有终态路径（成功/补偿失败/逃逸异常）都必须经过这里，
	*  否则锁悬挂会阻塞后续全部清理事务。 */
	async function finalize(rt) {
		rememberFinished(rt.txId, summarize(rt, rt.txId));
		await rt.lockHandle.release();
		runtimes.delete(rt.txId);
	}
	function summarize(rt, txId) {
		return {
			txId,
			state: rt.state,
			steps: rt.steps,
			bytesFreedTotal: rt.steps.reduce((sum, s) => sum + (s.bytesFreed || 0), 0),
			startedAt: rt.startedAt,
			...rt.finishedAt ? { finishedAt: rt.finishedAt } : {}
		};
	}
	/** WAL 重建路径的 startedAt：显式定位 tx-begin，不依赖 query 的返回顺序 */
	async function startedAtFromAudit(txId) {
		try {
			const entries = await deps.audit.query({ txId });
			return entries.find((e) => e.action === "tx-begin")?.timestamp ?? entries[0]?.timestamp ?? "";
		} catch {
			return "";
		}
	}
	/** 步骤审计（可靠性模型的数据源）：action 前缀 OP_AUDIT_PREFIX（契约
	*  单一事实源，读方 reliability.ts 同源导入）区分于事务级条目。
	*  detail 携带 estimated/actual/ratio —— 每一次清理都在训练下一次预测。
	*  审计失败只记日志不阻断事务：统计飞轮是增强能力，不是关键路径。 */
	async function auditStep(rt, op, outcome, detail) {
		try {
			await deps.audit.append({
				timestamp: deps.clock.now().toISOString(),
				actor: rt.request.actor,
				action: `op:${op.action}`,
				txId: rt.txId,
				outcome,
				detail
			});
		} catch (e) {
			deps.logger.warn("步骤审计追加失败（可靠性统计缺此样本）", {
				tx: rt.txId,
				op: op.id,
				error: errorToMessage(e)
			});
		}
	}
	return {
		async begin(request) {
			if (request.strategy === "aggressive" && !request.confirmationToken) return err({
				code: "E_VALIDATION",
				message: "aggressive 策略必须携带 confirmationToken（二次确认）"
			});
			const owner = {
				pid: process.pid,
				hostname: os.hostname(),
				bootToken: crypto.randomBytes(8).toString("hex"),
				purpose: "clean"
			};
			const acquired = await deps.lockManager.acquire({
				scope: { kind: "global" },
				mode: "exclusive",
				owner,
				waitTimeoutMs: 5e3,
				ttlMs: 3e5
			});
			if (!acquired.ok) return err(acquired.error);
			const txId = crypto.randomBytes(8).toString("hex");
			let backupsArea;
			try {
				backupsArea = await deps.backups.reserve(txId);
			} catch (e) {
				await acquired.value.release();
				return err(ioError("备份区预留失败", e));
			}
			const rt = {
				txId,
				state: "draft",
				request,
				steps: [],
				startedAt: deps.clock.now().toISOString(),
				lockHandle: acquired.value,
				backupsArea,
				estimates: /* @__PURE__ */ new Map()
			};
			runtimes.set(txId, rt);
			await deps.wal.append(txId, {
				type: "tx-begin",
				txId,
				request
			});
			await deps.audit.append({
				timestamp: rt.startedAt,
				actor: request.actor,
				action: "tx-begin",
				txId,
				outcome: "success",
				detail: {
					plugins: request.plugins,
					profile: request.profile,
					strategy: request.strategy,
					dryRun: request.dryRun
				}
			});
			return ok({
				txId,
				lockId: acquired.value.id,
				request
			});
		},
		async plan(session) {
			const rt = runtimes.get(session.txId);
			if (!rt) return err({
				code: "E_TX_NOT_FOUND",
				message: `事务不存在: ${session.txId}`
			});
			const st = setState(rt, "planned");
			if (!st.ok) return err(st.error);
			const ctx = makeCtxFromRt(rt);
			const ops = operationFactory(rt.request);
			const warnings = [];
			if (rt.request.strategy === "aggressive") {
				const token = rt.request.confirmationToken ?? "";
				if (!(deps.verifyConfirmationToken ? deps.verifyConfirmationToken(token, rt.request) : false)) warnings.push({
					code: "CONFIRMATION_TOKEN_INVALID",
					blocking: true,
					message: "aggressive 策略确认令牌无效，commit 被阻止"
				});
			}
			let total = 0;
			for (const op of ops) {
				const p = await op.preview(ctx);
				rt.estimates.set(op.id, p.estimatedBytesReclaimable);
				total += p.estimatedBytesReclaimable;
			}
			return ok({
				txId: session.txId,
				operations: ops,
				estimatedBytesReclaimable: total,
				warnings,
				requiresConfirmationToken: rt.request.strategy === "aggressive"
			});
		},
		async dryRun(plan) {
			const rt = runtimes.get(plan.txId);
			if (!rt) return err({
				code: "E_TX_NOT_FOUND",
				message: `事务不存在: ${plan.txId}`
			});
			const ctx = makeCtxFromRt(rt);
			const reports = [];
			let total = 0;
			for (const op of plan.operations) {
				const p = await op.preview(ctx);
				rt.estimates.set(op.id, p.estimatedBytesReclaimable);
				total += p.estimatedBytesReclaimable;
				reports.push({
					operation: p,
					summary: p.summary
				});
			}
			const report = {
				txId: plan.txId,
				plans: reports,
				estimatedBytesReclaimable: total,
				warnings: plan.warnings
			};
			await deps.audit.append({
				timestamp: deps.clock.now().toISOString(),
				actor: rt.request.actor,
				action: "dry-run",
				txId: plan.txId,
				outcome: "success",
				detail: {
					operations: reports.length,
					estimatedBytes: total
				}
			});
			return ok(report);
		},
		async commit(plan) {
			const rt = runtimes.get(plan.txId);
			if (!rt) return err({
				code: "E_TX_NOT_FOUND",
				message: `事务不存在: ${plan.txId}`
			});
			if (rt.request.strategy === "aggressive") {
				if (!(deps.verifyConfirmationToken && rt.request.confirmationToken !== void 0 ? deps.verifyConfirmationToken(rt.request.confirmationToken, rt.request) : false)) return err({
					code: "E_VALIDATION",
					message: "aggressive 策略确认令牌无效，commit 被拒绝（令牌复验失败）"
				});
			}
			const blocking = plan.warnings.find((w) => w.blocking);
			if (blocking) return err({
				code: "E_VALIDATION",
				message: `计划存在阻断性警告: ${blocking.message}`
			});
			let st = setState(rt, "validating");
			if (!st.ok) return err(st.error);
			const ctx = makeCtxFromRt(rt);
			const txId = plan.txId;
			try {
				for (const op of plan.operations) {
					const v = await op.validate(ctx);
					if (!v.ok) {
						await rollbackRuntime(rt, `validate 失败: ${op.id}: ${v.error.message}`);
						await finalize(rt);
						return err(v.error);
					}
				}
				st = setState(rt, "executing");
				if (!st.ok) return err(st.error);
				for (const [index, op] of plan.operations.entries()) {
					rt.steps.push({
						index,
						operationId: op.id,
						action: op.action,
						status: "pending",
						bytesFreed: 0,
						backup: null
					});
					await deps.wal.append(txId, {
						type: "step-intent",
						index,
						operationId: op.id,
						action: op.action,
						backup: null
					});
					const pre = await deps.hooks.emit("pre", hookCtx(txId, rt.request, op));
					if (pre.ok && pre.value.verdict.kind === "veto") {
						rt.steps[index] = {
							...rt.steps[index],
							status: "skipped"
						};
						await rollbackRuntime(rt, `pre 钩子否决: ${pre.value.verdict.reason}`);
						await finalize(rt);
						return err({
							code: "E_HOOK_VETO",
							message: `钩子否决: ${pre.value.verdict.reason}`
						});
					}
					try {
						let estimated = rt.estimates.get(op.id);
						if (estimated === void 0) try {
							estimated = (await op.preview(ctx)).estimatedBytesReclaimable;
							rt.estimates.set(op.id, estimated);
						} catch {
							estimated = void 0;
						}
						const executed = await op.execute(ctx);
						if (!executed.ok) {
							rt.steps[index] = {
								...rt.steps[index],
								status: "failed",
								backup: null
							};
							await deps.wal.append(txId, {
								type: "step-failed",
								index,
								error: executed.error
							});
							await auditStep(rt, op, "failure", {
								operationId: op.id,
								estimated: estimated ?? null,
								error: executed.error.message
							});
							const errHook = await deps.hooks.emit("error", {
								...hookCtx(txId, rt.request, op),
								error: executed.error
							});
							if ((errHook.ok ? errHook.value.errorDirective : null) === "skip-and-continue") {
								rt.steps[index] = {
									...rt.steps[index],
									status: "skipped"
								};
								continue;
							}
							await rollbackRuntime(rt, `步骤 ${index}(${op.id}) 失败: ${executed.error.message}`);
							await finalize(rt);
							return err(executed.error);
						}
						const { outcome, backup } = executed.value;
						rt.steps[index] = {
							...rt.steps[index],
							status: "done",
							bytesFreed: outcome.bytesFreed,
							backup
						};
						await deps.wal.append(txId, {
							type: "step-done",
							index,
							operationId: op.id,
							outcome,
							backup
						});
						await auditStep(rt, op, "success", {
							operationId: op.id,
							estimated: estimated ?? null,
							actual: outcome.bytesFreed,
							...estimated !== void 0 && estimated > 0 ? { ratio: outcome.bytesFreed / estimated } : {}
						});
						await deps.hooks.emit("post", hookCtx(txId, rt.request, op, backup));
						if (deps.crashAfterStep === index) throw new SimulatedCrashError(txId, index);
					} catch (e) {
						if (e instanceof SimulatedCrashError) throw e;
						await rollbackRuntime(rt, `步骤 ${index}(${op.id}) 异常: ${errorToMessage(e)}`);
						await finalize(rt);
						return err(ioError("事务执行失败", e));
					}
				}
				st = setState(rt, "committing");
				if (!st.ok) return err(st.error);
				await deps.wal.append(txId, {
					type: "tx-commit",
					txId
				});
				rt.finishedAt = deps.clock.now().toISOString();
				setState(rt, "committed");
				await deps.audit.append({
					timestamp: rt.finishedAt,
					actor: rt.request.actor,
					action: "tx-commit",
					txId,
					outcome: "success",
					detail: {
						steps: rt.steps.length,
						bytesFreed: rt.steps.reduce((s, x) => s + x.bytesFreed, 0)
					}
				});
				await finalize(rt);
				return ok(summarize(rt, txId));
			} catch (e) {
				if (e instanceof SimulatedCrashError) throw e;
				try {
					await rollbackRuntime(rt, `commit 逃逸异常: ${errorToMessage(e)}`);
				} catch {}
				await finalize(rt);
				return err(ioError("事务执行失败", e));
			}
		},
		async rollback(txId) {
			const rt = runtimes.get(txId);
			if (!rt) return err({
				code: "E_TX_NOT_FOUND",
				message: `事务不存在: ${txId}`
			});
			if (rt.state === "committed" || rt.state === "rolled-back") return err({
				code: "E_TX_STATE",
				message: `事务已终结（${rt.state}），无法回滚`
			});
			try {
				await rollbackRuntime(rt, "手动回滚");
			} finally {
				await finalize(rt);
			}
			return ok(summarize(rt, txId));
		},
		async recover() {
			const recovered = [];
			for (const txId of deps.wal.unfinishedTxIds()) {
				if (runtimes.has(txId)) continue;
				try {
					const intents = (await deps.wal.replay(txId)).filter((r) => r.type === "step-intent");
					const area = await deps.backups.reserve(txId);
					const manifest = area.manifest();
					let restoreFailures = 0;
					for (const record of [...manifest].reverse()) try {
						if (!(await area.restore(record)).ok) restoreFailures++;
					} catch {
						restoreFailures++;
					}
					if (restoreFailures > 0 || area.orphanArtifacts() > 0) {
						deps.logger.error("崩溃恢复存在失败项/孤儿产物：备份保留待人工核查/下次重试", {
							txId,
							failures: restoreFailures,
							orphans: area.orphanArtifacts(),
							total: manifest.length
						});
						recovered.push({
							txId,
							state: "failed",
							steps: intents.map((r) => ({
								index: r.index,
								operationId: r.operationId,
								action: r.action,
								status: "undone",
								bytesFreed: 0,
								backup: null
							})),
							bytesFreedTotal: 0,
							startedAt: await startedAtFromAudit(txId)
						});
						continue;
					}
					await deps.wal.append(txId, {
						type: "tx-rollback",
						txId,
						reason: "crash-recovery"
					});
					await area.purge(txId);
					const summary = {
						txId,
						state: "rolled-back",
						steps: intents.map((r) => ({
							index: r.index,
							operationId: r.operationId,
							action: r.action,
							status: "undone",
							bytesFreed: 0,
							backup: null
						})),
						bytesFreedTotal: 0,
						startedAt: await startedAtFromAudit(txId)
					};
					recovered.push(summary);
					deps.logger.info("崩溃恢复完成", {
						txId,
						restored: manifest.length
					});
				} catch (e) {
					deps.logger.error("崩溃恢复事务异常，跳过", {
						txId,
						error: errorToMessage(e)
					});
				}
			}
			return ok(recovered);
		},
		async status(txId) {
			const rt = runtimes.get(txId);
			if (rt) return summarize(rt, txId);
			const cached = finished.get(txId);
			if (cached) {
				finished.delete(txId);
				finished.set(txId, cached);
				return cached;
			}
			const records = await deps.wal.replay(txId);
			if (records.length === 0) return null;
			const begin = records.find((r) => r.type === "tx-begin");
			if (!begin || begin.type !== "tx-begin") return null;
			const actionByIndex = /* @__PURE__ */ new Map();
			for (const r of records) if (r.type === "step-intent") actionByIndex.set(r.index, r.action);
			const steps = records.filter((r) => r.type === "step-done").map((r) => ({
				index: r.index,
				operationId: r.operationId,
				action: actionByIndex.get(r.index) ?? "standard-remove",
				status: "done",
				bytesFreed: r.outcome.bytesFreed,
				backup: r.backup
			}));
			return {
				txId,
				state: records.some((r) => r.type === "tx-commit") ? "committed" : records.some((r) => r.type === "tx-rollback") ? "rolled-back" : "failed",
				steps,
				bytesFreedTotal: steps.reduce((s, x) => s + x.bytesFreed, 0),
				startedAt: await startedAtFromAudit(txId)
			};
		}
	};
}
//#endregion
//#region src/engine/severity-scorer.ts
const DEFAULT_WEIGHTS = {
	type: 30,
	recency: 20,
	depth: 10,
	reference: 30,
	size: 10,
	recencyHalfLifeDays: 30,
	bands: {
		info: 0,
		low: 20,
		medium: 40,
		high: 60,
		critical: 80
	}
};
/** 类型基础风险：config-ref 涉及配置改写最高危；temp 孤儿最低 */
const TYPE_BASE = {
	"config-ref": .9,
	"node-modules": .45,
	"storage": .65,
	"attachment": .4,
	"temp-orphan": .15,
	"lockfile": .3,
	"unknown": .55
};
const DAY_MS$1 = 864e5;
function createSeverityScorer(options = {}) {
	const w = options.weights ?? DEFAULT_WEIGHTS;
	const now = options.now ?? (() => /* @__PURE__ */ new Date());
	const weightSum = w.type + w.recency + w.depth + w.reference + w.size;
	function bandOf(total) {
		for (const b of [
			"critical",
			"high",
			"medium",
			"low",
			"info"
		]) if (total >= w.bands[b]) return b;
		return "info";
	}
	function factorType(e) {
		const raw = TYPE_BASE[e.kind];
		return {
			factor: "type",
			weight: w.type,
			raw,
			contribution: w.type * raw,
			note: `类型 ${e.kind} 基础风险 ${raw.toFixed(2)}`
		};
	}
	function factorRecency(e) {
		let raw;
		let note;
		if (e.lastAccessedAt === null) {
			raw = .5;
			note = "atime 不可用 → 中性 0.50";
		} else {
			const ageDays = Math.max(0, (now().getTime() - e.lastAccessedAt.getTime()) / DAY_MS$1);
			raw = 1 - Math.pow(2, -ageDays / w.recencyHalfLifeDays);
			note = `${Math.round(ageDays)} 天未访问（半衰期 ${w.recencyHalfLifeDays}d）→ 衰减 ${raw.toFixed(2)}`;
		}
		return {
			factor: "recency",
			weight: w.recency,
			raw,
			contribution: w.recency * raw,
			note
		};
	}
	function factorDepth(e) {
		const segs = e.location.replace(/\\/g, "/").split("/").filter(Boolean);
		const raw = Math.min(1, Math.max(0, segs.length - 4) / 8);
		return {
			factor: "depth",
			weight: w.depth,
			raw,
			contribution: w.depth * raw,
			note: `路径深度 ${segs.length} 段 → ${raw.toFixed(2)}`
		};
	}
	function factorReference(e) {
		const n = e.referencedBy.length;
		const raw = n === 0 ? 0 : Math.min(1, .7 + .1 * (n - 1));
		return {
			factor: "reference",
			weight: w.reference,
			raw,
			contribution: w.reference * raw,
			note: n === 0 ? "无任何插件引用（孤儿）" : `仍被 ${n} 个插件引用: ${e.referencedBy.join(", ")}`
		};
	}
	function factorSize(e) {
		const raw = Math.min(1, Math.log10(1 + Math.max(0, e.sizeBytes)) / 9);
		return {
			factor: "size",
			weight: w.size,
			raw,
			contribution: w.size * raw,
			note: `${fmtBytes(e.sizeBytes)} → 对数缩放 ${raw.toFixed(2)}`
		};
	}
	const scorer = {
		score(evidence) {
			const breakdown = [
				factorType(evidence),
				factorRecency(evidence),
				factorDepth(evidence),
				factorReference(evidence),
				factorSize(evidence)
			];
			const total = Math.round(Math.max(0, Math.min(100, 100 * breakdown.reduce((s, f) => s + f.contribution, 0) / weightSum)));
			return {
				total,
				band: bandOf(total),
				breakdown,
				safeToAutoClean: evidence.referencedBy.length === 0 && total < w.bands.high
			};
		},
		rank(evidences) {
			return evidences.map((e) => ({
				...e,
				score: scorer.score(e)
			})).sort((a, b) => b.score.total - a.score.total || b.sizeBytes - a.sizeBytes);
		}
	};
	return scorer;
}
//#endregion
//#region node_modules/yaml/dist/nodes/identity.js
var require_identity = /* @__PURE__ */ __commonJSMin(((exports) => {
	const ALIAS = Symbol.for("yaml.alias");
	const DOC = Symbol.for("yaml.document");
	const MAP = Symbol.for("yaml.map");
	const PAIR = Symbol.for("yaml.pair");
	const SCALAR = Symbol.for("yaml.scalar");
	const SEQ = Symbol.for("yaml.seq");
	const NODE_TYPE = Symbol.for("yaml.node.type");
	const isAlias = (node) => !!node && typeof node === "object" && node[NODE_TYPE] === ALIAS;
	const isDocument = (node) => !!node && typeof node === "object" && node[NODE_TYPE] === DOC;
	const isMap = (node) => !!node && typeof node === "object" && node[NODE_TYPE] === MAP;
	const isPair = (node) => !!node && typeof node === "object" && node[NODE_TYPE] === PAIR;
	const isScalar = (node) => !!node && typeof node === "object" && node[NODE_TYPE] === SCALAR;
	const isSeq = (node) => !!node && typeof node === "object" && node[NODE_TYPE] === SEQ;
	function isCollection(node) {
		if (node && typeof node === "object") switch (node[NODE_TYPE]) {
			case MAP:
			case SEQ: return true;
		}
		return false;
	}
	function isNode(node) {
		if (node && typeof node === "object") switch (node[NODE_TYPE]) {
			case ALIAS:
			case MAP:
			case SCALAR:
			case SEQ: return true;
		}
		return false;
	}
	const hasAnchor = (node) => (isScalar(node) || isCollection(node)) && !!node.anchor;
	exports.ALIAS = ALIAS;
	exports.DOC = DOC;
	exports.MAP = MAP;
	exports.NODE_TYPE = NODE_TYPE;
	exports.PAIR = PAIR;
	exports.SCALAR = SCALAR;
	exports.SEQ = SEQ;
	exports.hasAnchor = hasAnchor;
	exports.isAlias = isAlias;
	exports.isCollection = isCollection;
	exports.isDocument = isDocument;
	exports.isMap = isMap;
	exports.isNode = isNode;
	exports.isPair = isPair;
	exports.isScalar = isScalar;
	exports.isSeq = isSeq;
}));
//#endregion
//#region node_modules/yaml/dist/visit.js
var require_visit = /* @__PURE__ */ __commonJSMin(((exports) => {
	var identity = require_identity();
	const BREAK = Symbol("break visit");
	const SKIP = Symbol("skip children");
	const REMOVE = Symbol("remove node");
	/**
	* Apply a visitor to an AST node or document.
	*
	* Walks through the tree (depth-first) starting from `node`, calling a
	* `visitor` function with three arguments:
	*   - `key`: For sequence values and map `Pair`, the node's index in the
	*     collection. Within a `Pair`, `'key'` or `'value'`, correspondingly.
	*     `null` for the root node.
	*   - `node`: The current node.
	*   - `path`: The ancestry of the current node.
	*
	* The return value of the visitor may be used to control the traversal:
	*   - `undefined` (default): Do nothing and continue
	*   - `visit.SKIP`: Do not visit the children of this node, continue with next
	*     sibling
	*   - `visit.BREAK`: Terminate traversal completely
	*   - `visit.REMOVE`: Remove the current node, then continue with the next one
	*   - `Node`: Replace the current node, then continue by visiting it
	*   - `number`: While iterating the items of a sequence or map, set the index
	*     of the next step. This is useful especially if the index of the current
	*     node has changed.
	*
	* If `visitor` is a single function, it will be called with all values
	* encountered in the tree, including e.g. `null` values. Alternatively,
	* separate visitor functions may be defined for each `Map`, `Pair`, `Seq`,
	* `Alias` and `Scalar` node. To define the same visitor function for more than
	* one node type, use the `Collection` (map and seq), `Value` (map, seq & scalar)
	* and `Node` (alias, map, seq & scalar) targets. Of all these, only the most
	* specific defined one will be used for each node.
	*/
	function visit(node, visitor) {
		const visitor_ = initVisitor(visitor);
		if (identity.isDocument(node)) {
			if (visit_(null, node.contents, visitor_, Object.freeze([node])) === REMOVE) node.contents = null;
		} else visit_(null, node, visitor_, Object.freeze([]));
	}
	/** Terminate visit traversal completely */
	visit.BREAK = BREAK;
	/** Do not visit the children of the current node */
	visit.SKIP = SKIP;
	/** Remove the current node */
	visit.REMOVE = REMOVE;
	function visit_(key, node, visitor, path) {
		const ctrl = callVisitor(key, node, visitor, path);
		if (identity.isNode(ctrl) || identity.isPair(ctrl)) {
			replaceNode(key, path, ctrl);
			return visit_(key, ctrl, visitor, path);
		}
		if (typeof ctrl !== "symbol") {
			if (identity.isCollection(node)) {
				path = Object.freeze(path.concat(node));
				for (let i = 0; i < node.items.length; ++i) {
					const ci = visit_(i, node.items[i], visitor, path);
					if (typeof ci === "number") i = ci - 1;
					else if (ci === BREAK) return BREAK;
					else if (ci === REMOVE) {
						node.items.splice(i, 1);
						i -= 1;
					}
				}
			} else if (identity.isPair(node)) {
				path = Object.freeze(path.concat(node));
				const ck = visit_("key", node.key, visitor, path);
				if (ck === BREAK) return BREAK;
				else if (ck === REMOVE) node.key = null;
				const cv = visit_("value", node.value, visitor, path);
				if (cv === BREAK) return BREAK;
				else if (cv === REMOVE) node.value = null;
			}
		}
		return ctrl;
	}
	/**
	* Apply an async visitor to an AST node or document.
	*
	* Walks through the tree (depth-first) starting from `node`, calling a
	* `visitor` function with three arguments:
	*   - `key`: For sequence values and map `Pair`, the node's index in the
	*     collection. Within a `Pair`, `'key'` or `'value'`, correspondingly.
	*     `null` for the root node.
	*   - `node`: The current node.
	*   - `path`: The ancestry of the current node.
	*
	* The return value of the visitor may be used to control the traversal:
	*   - `Promise`: Must resolve to one of the following values
	*   - `undefined` (default): Do nothing and continue
	*   - `visit.SKIP`: Do not visit the children of this node, continue with next
	*     sibling
	*   - `visit.BREAK`: Terminate traversal completely
	*   - `visit.REMOVE`: Remove the current node, then continue with the next one
	*   - `Node`: Replace the current node, then continue by visiting it
	*   - `number`: While iterating the items of a sequence or map, set the index
	*     of the next step. This is useful especially if the index of the current
	*     node has changed.
	*
	* If `visitor` is a single function, it will be called with all values
	* encountered in the tree, including e.g. `null` values. Alternatively,
	* separate visitor functions may be defined for each `Map`, `Pair`, `Seq`,
	* `Alias` and `Scalar` node. To define the same visitor function for more than
	* one node type, use the `Collection` (map and seq), `Value` (map, seq & scalar)
	* and `Node` (alias, map, seq & scalar) targets. Of all these, only the most
	* specific defined one will be used for each node.
	*/
	async function visitAsync(node, visitor) {
		const visitor_ = initVisitor(visitor);
		if (identity.isDocument(node)) {
			if (await visitAsync_(null, node.contents, visitor_, Object.freeze([node])) === REMOVE) node.contents = null;
		} else await visitAsync_(null, node, visitor_, Object.freeze([]));
	}
	/** Terminate visit traversal completely */
	visitAsync.BREAK = BREAK;
	/** Do not visit the children of the current node */
	visitAsync.SKIP = SKIP;
	/** Remove the current node */
	visitAsync.REMOVE = REMOVE;
	async function visitAsync_(key, node, visitor, path) {
		const ctrl = await callVisitor(key, node, visitor, path);
		if (identity.isNode(ctrl) || identity.isPair(ctrl)) {
			replaceNode(key, path, ctrl);
			return visitAsync_(key, ctrl, visitor, path);
		}
		if (typeof ctrl !== "symbol") {
			if (identity.isCollection(node)) {
				path = Object.freeze(path.concat(node));
				for (let i = 0; i < node.items.length; ++i) {
					const ci = await visitAsync_(i, node.items[i], visitor, path);
					if (typeof ci === "number") i = ci - 1;
					else if (ci === BREAK) return BREAK;
					else if (ci === REMOVE) {
						node.items.splice(i, 1);
						i -= 1;
					}
				}
			} else if (identity.isPair(node)) {
				path = Object.freeze(path.concat(node));
				const ck = await visitAsync_("key", node.key, visitor, path);
				if (ck === BREAK) return BREAK;
				else if (ck === REMOVE) node.key = null;
				const cv = await visitAsync_("value", node.value, visitor, path);
				if (cv === BREAK) return BREAK;
				else if (cv === REMOVE) node.value = null;
			}
		}
		return ctrl;
	}
	function initVisitor(visitor) {
		if (typeof visitor === "object" && (visitor.Collection || visitor.Node || visitor.Value)) return Object.assign({
			Alias: visitor.Node,
			Map: visitor.Node,
			Scalar: visitor.Node,
			Seq: visitor.Node
		}, visitor.Value && {
			Map: visitor.Value,
			Scalar: visitor.Value,
			Seq: visitor.Value
		}, visitor.Collection && {
			Map: visitor.Collection,
			Seq: visitor.Collection
		}, visitor);
		return visitor;
	}
	function callVisitor(key, node, visitor, path) {
		if (typeof visitor === "function") return visitor(key, node, path);
		if (identity.isMap(node)) return visitor.Map?.(key, node, path);
		if (identity.isSeq(node)) return visitor.Seq?.(key, node, path);
		if (identity.isPair(node)) return visitor.Pair?.(key, node, path);
		if (identity.isScalar(node)) return visitor.Scalar?.(key, node, path);
		if (identity.isAlias(node)) return visitor.Alias?.(key, node, path);
	}
	function replaceNode(key, path, node) {
		const parent = path[path.length - 1];
		if (identity.isCollection(parent)) parent.items[key] = node;
		else if (identity.isPair(parent)) {
			if (key === "key") parent.key = node;
			else parent.value = node;
		} else if (identity.isDocument(parent)) parent.contents = node;
		else {
			const pt = identity.isAlias(parent) ? "alias" : "scalar";
			throw new Error(`Cannot replace node with ${pt} parent`);
		}
	}
	exports.visit = visit;
	exports.visitAsync = visitAsync;
}));
//#endregion
//#region node_modules/yaml/dist/doc/directives.js
var require_directives = /* @__PURE__ */ __commonJSMin(((exports) => {
	var identity = require_identity();
	var visit = require_visit();
	const escapeChars = {
		"!": "%21",
		",": "%2C",
		"[": "%5B",
		"]": "%5D",
		"{": "%7B",
		"}": "%7D"
	};
	const escapeTagName = (tn) => tn.replace(/[!,[\]{}]/g, (ch) => escapeChars[ch]);
	var Directives = class Directives {
		constructor(yaml, tags) {
			/**
			* The directives-end/doc-start marker `---`. If `null`, a marker may still be
			* included in the document's stringified representation.
			*/
			this.docStart = null;
			/** The doc-end marker `...`.  */
			this.docEnd = false;
			this.yaml = Object.assign({}, Directives.defaultYaml, yaml);
			this.tags = Object.assign({}, Directives.defaultTags, tags);
		}
		clone() {
			const copy = new Directives(this.yaml, this.tags);
			copy.docStart = this.docStart;
			return copy;
		}
		/**
		* During parsing, get a Directives instance for the current document and
		* update the stream state according to the current version's spec.
		*/
		atDocument() {
			const res = new Directives(this.yaml, this.tags);
			switch (this.yaml.version) {
				case "1.1":
					this.atNextDocument = true;
					break;
				case "1.2":
					this.atNextDocument = false;
					this.yaml = {
						explicit: Directives.defaultYaml.explicit,
						version: "1.2"
					};
					this.tags = Object.assign({}, Directives.defaultTags);
			}
			return res;
		}
		/**
		* @param onError - May be called even if the action was successful
		* @returns `true` on success
		*/
		add(line, onError) {
			if (this.atNextDocument) {
				this.yaml = {
					explicit: Directives.defaultYaml.explicit,
					version: "1.1"
				};
				this.tags = Object.assign({}, Directives.defaultTags);
				this.atNextDocument = false;
			}
			const parts = line.trim().split(/[ \t]+/);
			const name = parts.shift();
			switch (name) {
				case "%TAG": {
					if (parts.length !== 2) {
						onError(0, "%TAG directive should contain exactly two parts");
						if (parts.length < 2) return false;
					}
					const [handle, prefix] = parts;
					this.tags[handle] = prefix;
					return true;
				}
				case "%YAML": {
					this.yaml.explicit = true;
					if (parts.length !== 1) {
						onError(0, "%YAML directive should contain exactly one part");
						return false;
					}
					const [version] = parts;
					if (version === "1.1" || version === "1.2") {
						this.yaml.version = version;
						return true;
					} else {
						const isValid = /^\d+\.\d+$/.test(version);
						onError(6, `Unsupported YAML version ${version}`, isValid);
						return false;
					}
				}
				default:
					onError(0, `Unknown directive ${name}`, true);
					return false;
			}
		}
		/**
		* Resolves a tag, matching handles to those defined in %TAG directives.
		*
		* @returns Resolved tag, which may also be the non-specific tag `'!'` or a
		*   `'!local'` tag, or `null` if unresolvable.
		*/
		tagName(source, onError) {
			if (source === "!") return "!";
			if (source[0] !== "!") {
				onError(`Not a valid tag: ${source}`);
				return null;
			}
			if (source[1] === "<") {
				const verbatim = source.slice(2, -1);
				if (verbatim === "!" || verbatim === "!!") {
					onError(`Verbatim tags aren't resolved, so ${source} is invalid.`);
					return null;
				}
				if (source[source.length - 1] !== ">") onError("Verbatim tags must end with a >");
				return verbatim;
			}
			const [, handle, suffix] = source.match(/^(.*!)([^!]*)$/s);
			if (!suffix) onError(`The ${source} tag has no suffix`);
			const prefix = this.tags[handle];
			if (prefix) try {
				return prefix + decodeURIComponent(suffix);
			} catch (error) {
				onError(String(error));
				return null;
			}
			if (handle === "!") return source;
			onError(`Could not resolve tag: ${source}`);
			return null;
		}
		/**
		* Given a fully resolved tag, returns its printable string form,
		* taking into account current tag prefixes and defaults.
		*/
		tagString(tag) {
			for (const [handle, prefix] of Object.entries(this.tags)) if (tag.startsWith(prefix)) return handle + escapeTagName(tag.substring(prefix.length));
			return tag[0] === "!" ? tag : `!<${tag}>`;
		}
		toString(doc) {
			const lines = this.yaml.explicit ? [`%YAML ${this.yaml.version || "1.2"}`] : [];
			const tagEntries = Object.entries(this.tags);
			let tagNames;
			if (doc && tagEntries.length > 0 && identity.isNode(doc.contents)) {
				const tags = {};
				visit.visit(doc.contents, (_key, node) => {
					if (identity.isNode(node) && node.tag) tags[node.tag] = true;
				});
				tagNames = Object.keys(tags);
			} else tagNames = [];
			for (const [handle, prefix] of tagEntries) {
				if (handle === "!!" && prefix === "tag:yaml.org,2002:") continue;
				if (!doc || tagNames.some((tn) => tn.startsWith(prefix))) lines.push(`%TAG ${handle} ${prefix}`);
			}
			return lines.join("\n");
		}
	};
	Directives.defaultYaml = {
		explicit: false,
		version: "1.2"
	};
	Directives.defaultTags = { "!!": "tag:yaml.org,2002:" };
	exports.Directives = Directives;
}));
//#endregion
//#region node_modules/yaml/dist/doc/anchors.js
var require_anchors = /* @__PURE__ */ __commonJSMin(((exports) => {
	var identity = require_identity();
	var visit = require_visit();
	/**
	* Verify that the input string is a valid anchor.
	*
	* Will throw on errors.
	*/
	function anchorIsValid(anchor) {
		if (/[\x00-\x19\s,[\]{}]/.test(anchor)) {
			const msg = `Anchor must not contain whitespace or control characters: ${JSON.stringify(anchor)}`;
			throw new Error(msg);
		}
		return true;
	}
	function anchorNames(root) {
		const anchors = /* @__PURE__ */ new Set();
		visit.visit(root, { Value(_key, node) {
			if (node.anchor) anchors.add(node.anchor);
		} });
		return anchors;
	}
	/** Find a new anchor name with the given `prefix` and a one-indexed suffix. */
	function findNewAnchor(prefix, exclude) {
		for (let i = 1;; ++i) {
			const name = `${prefix}${i}`;
			if (!exclude.has(name)) return name;
		}
	}
	function createNodeAnchors(doc, prefix) {
		const aliasObjects = [];
		const sourceObjects = /* @__PURE__ */ new Map();
		let prevAnchors = null;
		return {
			onAnchor: (source) => {
				aliasObjects.push(source);
				prevAnchors ?? (prevAnchors = anchorNames(doc));
				const anchor = findNewAnchor(prefix, prevAnchors);
				prevAnchors.add(anchor);
				return anchor;
			},
			/**
			* With circular references, the source node is only resolved after all
			* of its child nodes are. This is why anchors are set only after all of
			* the nodes have been created.
			*/
			setAnchors: () => {
				for (const source of aliasObjects) {
					const ref = sourceObjects.get(source);
					if (typeof ref === "object" && ref.anchor && (identity.isScalar(ref.node) || identity.isCollection(ref.node))) ref.node.anchor = ref.anchor;
					else {
						const error = /* @__PURE__ */ new Error("Failed to resolve repeated object (this should not happen)");
						error.source = source;
						throw error;
					}
				}
			},
			sourceObjects
		};
	}
	exports.anchorIsValid = anchorIsValid;
	exports.anchorNames = anchorNames;
	exports.createNodeAnchors = createNodeAnchors;
	exports.findNewAnchor = findNewAnchor;
}));
//#endregion
//#region node_modules/yaml/dist/doc/applyReviver.js
var require_applyReviver = /* @__PURE__ */ __commonJSMin(((exports) => {
	/**
	* Applies the JSON.parse reviver algorithm as defined in the ECMA-262 spec,
	* in section 24.5.1.1 "Runtime Semantics: InternalizeJSONProperty" of the
	* 2021 edition: https://tc39.es/ecma262/#sec-json.parse
	*
	* Includes extensions for handling Map and Set objects.
	*/
	function applyReviver(reviver, obj, key, val) {
		if (val && typeof val === "object") {
			if (Array.isArray(val)) for (let i = 0, len = val.length; i < len; ++i) {
				const v0 = val[i];
				const v1 = applyReviver(reviver, val, String(i), v0);
				if (v1 === void 0) delete val[i];
				else if (v1 !== v0) val[i] = v1;
			}
			else if (val instanceof Map) for (const k of Array.from(val.keys())) {
				const v0 = val.get(k);
				const v1 = applyReviver(reviver, val, k, v0);
				if (v1 === void 0) val.delete(k);
				else if (v1 !== v0) val.set(k, v1);
			}
			else if (val instanceof Set) for (const v0 of Array.from(val)) {
				const v1 = applyReviver(reviver, val, v0, v0);
				if (v1 === void 0) val.delete(v0);
				else if (v1 !== v0) {
					val.delete(v0);
					val.add(v1);
				}
			}
			else for (const [k, v0] of Object.entries(val)) {
				const v1 = applyReviver(reviver, val, k, v0);
				if (v1 === void 0) delete val[k];
				else if (v1 !== v0) val[k] = v1;
			}
		}
		return reviver.call(obj, key, val);
	}
	exports.applyReviver = applyReviver;
}));
//#endregion
//#region node_modules/yaml/dist/nodes/toJS.js
var require_toJS = /* @__PURE__ */ __commonJSMin(((exports) => {
	var identity = require_identity();
	/**
	* Recursively convert any node or its contents to native JavaScript
	*
	* @param value - The input value
	* @param arg - If `value` defines a `toJSON()` method, use this
	*   as its first argument
	* @param ctx - Conversion context, originally set in Document#toJS(). If
	*   `{ keep: true }` is not set, output should be suitable for JSON
	*   stringification.
	*/
	function toJS(value, arg, ctx) {
		if (Array.isArray(value)) return value.map((v, i) => toJS(v, String(i), ctx));
		if (value && typeof value.toJSON === "function") {
			if (!ctx || !identity.hasAnchor(value)) return value.toJSON(arg, ctx);
			const data = {
				aliasCount: 0,
				count: 1,
				res: void 0
			};
			ctx.anchors.set(value, data);
			ctx.onCreate = (res) => {
				data.res = res;
				delete ctx.onCreate;
			};
			const res = value.toJSON(arg, ctx);
			if (ctx.onCreate) ctx.onCreate(res);
			return res;
		}
		if (typeof value === "bigint" && !ctx?.keep) return Number(value);
		return value;
	}
	exports.toJS = toJS;
}));
//#endregion
//#region node_modules/yaml/dist/nodes/Node.js
var require_Node = /* @__PURE__ */ __commonJSMin(((exports) => {
	var applyReviver = require_applyReviver();
	var identity = require_identity();
	var toJS = require_toJS();
	var NodeBase = class {
		constructor(type) {
			Object.defineProperty(this, identity.NODE_TYPE, { value: type });
		}
		/** Create a copy of this node.  */
		clone() {
			const copy = Object.create(Object.getPrototypeOf(this), Object.getOwnPropertyDescriptors(this));
			if (this.range) copy.range = this.range.slice();
			return copy;
		}
		/** A plain JavaScript representation of this node. */
		toJS(doc, { mapAsMap, maxAliasCount, onAnchor, reviver } = {}) {
			if (!identity.isDocument(doc)) throw new TypeError("A document argument is required");
			const ctx = {
				anchors: /* @__PURE__ */ new Map(),
				doc,
				keep: true,
				mapAsMap: mapAsMap === true,
				mapKeyWarned: false,
				maxAliasCount: typeof maxAliasCount === "number" ? maxAliasCount : 100
			};
			const res = toJS.toJS(this, "", ctx);
			if (typeof onAnchor === "function") for (const { count, res } of ctx.anchors.values()) onAnchor(res, count);
			return typeof reviver === "function" ? applyReviver.applyReviver(reviver, { "": res }, "", res) : res;
		}
	};
	exports.NodeBase = NodeBase;
}));
//#endregion
//#region node_modules/yaml/dist/nodes/Alias.js
var require_Alias = /* @__PURE__ */ __commonJSMin(((exports) => {
	var anchors = require_anchors();
	var visit = require_visit();
	var identity = require_identity();
	var Node = require_Node();
	var toJS = require_toJS();
	var Alias = class extends Node.NodeBase {
		constructor(source) {
			super(identity.ALIAS);
			this.source = source;
			Object.defineProperty(this, "tag", { set() {
				throw new Error("Alias nodes cannot have tags");
			} });
		}
		/**
		* Resolve the value of this alias within `doc`, finding the last
		* instance of the `source` anchor before this node.
		*/
		resolve(doc, ctx) {
			if (ctx?.maxAliasCount === 0) throw new ReferenceError("Alias resolution is disabled");
			let nodes;
			if (ctx?.aliasResolveCache) nodes = ctx.aliasResolveCache;
			else {
				nodes = [];
				visit.visit(doc, { Node: (_key, node) => {
					if (identity.isAlias(node) || identity.hasAnchor(node)) nodes.push(node);
				} });
				if (ctx) ctx.aliasResolveCache = nodes;
			}
			let found = void 0;
			for (const node of nodes) {
				if (node === this) break;
				if (node.anchor === this.source) found = node;
			}
			return found;
		}
		toJSON(_arg, ctx) {
			if (!ctx) return { source: this.source };
			const { anchors, doc, maxAliasCount } = ctx;
			const source = this.resolve(doc, ctx);
			if (!source) {
				const msg = `Unresolved alias (the anchor must be set before the alias): ${this.source}`;
				throw new ReferenceError(msg);
			}
			let data = anchors.get(source);
			if (!data) {
				toJS.toJS(source, null, ctx);
				data = anchors.get(source);
			}
			/* istanbul ignore if */
			if (data?.res === void 0) throw new ReferenceError("This should not happen: Alias anchor was not resolved?");
			if (maxAliasCount >= 0) {
				data.count += 1;
				if (data.aliasCount === 0) data.aliasCount = getAliasCount(doc, source, anchors);
				if (data.count * data.aliasCount > maxAliasCount) throw new ReferenceError("Excessive alias count indicates a resource exhaustion attack");
			}
			return data.res;
		}
		toString(ctx, _onComment, _onChompKeep) {
			const src = `*${this.source}`;
			if (ctx) {
				anchors.anchorIsValid(this.source);
				if (ctx.options.verifyAliasOrder && !ctx.anchors.has(this.source)) {
					const msg = `Unresolved alias (the anchor must be set before the alias): ${this.source}`;
					throw new Error(msg);
				}
				if (ctx.implicitKey) return `${src} `;
			}
			return src;
		}
	};
	function getAliasCount(doc, node, anchors) {
		if (identity.isAlias(node)) {
			const source = node.resolve(doc);
			const anchor = anchors && source && anchors.get(source);
			return anchor ? anchor.count * anchor.aliasCount : 0;
		} else if (identity.isCollection(node)) {
			let count = 0;
			for (const item of node.items) {
				const c = getAliasCount(doc, item, anchors);
				if (c > count) count = c;
			}
			return count;
		} else if (identity.isPair(node)) {
			const kc = getAliasCount(doc, node.key, anchors);
			const vc = getAliasCount(doc, node.value, anchors);
			return Math.max(kc, vc);
		}
		return 1;
	}
	exports.Alias = Alias;
}));
//#endregion
//#region node_modules/yaml/dist/nodes/Scalar.js
var require_Scalar = /* @__PURE__ */ __commonJSMin(((exports) => {
	var identity = require_identity();
	var Node = require_Node();
	var toJS = require_toJS();
	const isScalarValue = (value) => !value || typeof value !== "function" && typeof value !== "object";
	var Scalar = class extends Node.NodeBase {
		constructor(value) {
			super(identity.SCALAR);
			this.value = value;
		}
		toJSON(arg, ctx) {
			return ctx?.keep ? this.value : toJS.toJS(this.value, arg, ctx);
		}
		toString() {
			return String(this.value);
		}
	};
	Scalar.BLOCK_FOLDED = "BLOCK_FOLDED";
	Scalar.BLOCK_LITERAL = "BLOCK_LITERAL";
	Scalar.PLAIN = "PLAIN";
	Scalar.QUOTE_DOUBLE = "QUOTE_DOUBLE";
	Scalar.QUOTE_SINGLE = "QUOTE_SINGLE";
	exports.Scalar = Scalar;
	exports.isScalarValue = isScalarValue;
}));
//#endregion
//#region node_modules/yaml/dist/doc/createNode.js
var require_createNode = /* @__PURE__ */ __commonJSMin(((exports) => {
	var Alias = require_Alias();
	var identity = require_identity();
	var Scalar = require_Scalar();
	const defaultTagPrefix = "tag:yaml.org,2002:";
	function findTagObject(value, tagName, tags) {
		if (tagName) {
			const match = tags.filter((t) => t.tag === tagName);
			const tagObj = match.find((t) => !t.format) ?? match[0];
			if (!tagObj) throw new Error(`Tag ${tagName} not found`);
			return tagObj;
		}
		return tags.find((t) => t.identify?.(value) && !t.format);
	}
	function createNode(value, tagName, ctx) {
		if (identity.isDocument(value)) value = value.contents;
		if (identity.isNode(value)) return value;
		if (identity.isPair(value)) {
			const map = ctx.schema[identity.MAP].createNode?.(ctx.schema, null, ctx);
			map.items.push(value);
			return map;
		}
		if (value instanceof String || value instanceof Number || value instanceof Boolean || typeof BigInt !== "undefined" && value instanceof BigInt) value = value.valueOf();
		const { aliasDuplicateObjects, onAnchor, onTagObj, schema, sourceObjects } = ctx;
		let ref = void 0;
		if (aliasDuplicateObjects && value && typeof value === "object") {
			ref = sourceObjects.get(value);
			if (ref) {
				ref.anchor ?? (ref.anchor = onAnchor(value));
				return new Alias.Alias(ref.anchor);
			} else {
				ref = {
					anchor: null,
					node: null
				};
				sourceObjects.set(value, ref);
			}
		}
		if (tagName?.startsWith("!!")) tagName = defaultTagPrefix + tagName.slice(2);
		let tagObj = findTagObject(value, tagName, schema.tags);
		if (!tagObj) {
			if (value && typeof value.toJSON === "function") value = value.toJSON();
			if (!value || typeof value !== "object") {
				const node = new Scalar.Scalar(value);
				if (ref) ref.node = node;
				return node;
			}
			tagObj = value instanceof Map ? schema[identity.MAP] : Symbol.iterator in Object(value) ? schema[identity.SEQ] : schema[identity.MAP];
		}
		if (onTagObj) {
			onTagObj(tagObj);
			delete ctx.onTagObj;
		}
		const node = tagObj?.createNode ? tagObj.createNode(ctx.schema, value, ctx) : typeof tagObj?.nodeClass?.from === "function" ? tagObj.nodeClass.from(ctx.schema, value, ctx) : new Scalar.Scalar(value);
		if (tagName) node.tag = tagName;
		else if (!tagObj.default) node.tag = tagObj.tag;
		if (ref) ref.node = node;
		return node;
	}
	exports.createNode = createNode;
}));
//#endregion
//#region node_modules/yaml/dist/nodes/Collection.js
var require_Collection = /* @__PURE__ */ __commonJSMin(((exports) => {
	var createNode = require_createNode();
	var identity = require_identity();
	var Node = require_Node();
	function collectionFromPath(schema, path, value) {
		let v = value;
		for (let i = path.length - 1; i >= 0; --i) {
			const k = path[i];
			if (typeof k === "number" && Number.isInteger(k) && k >= 0) {
				const a = [];
				a[k] = v;
				v = a;
			} else v = /* @__PURE__ */ new Map([[k, v]]);
		}
		return createNode.createNode(v, void 0, {
			aliasDuplicateObjects: false,
			keepUndefined: false,
			onAnchor: () => {
				throw new Error("This should not happen, please report a bug.");
			},
			schema,
			sourceObjects: /* @__PURE__ */ new Map()
		});
	}
	const isEmptyPath = (path) => path == null || typeof path === "object" && !!path[Symbol.iterator]().next().done;
	var Collection = class extends Node.NodeBase {
		constructor(type, schema) {
			super(type);
			Object.defineProperty(this, "schema", {
				value: schema,
				configurable: true,
				enumerable: false,
				writable: true
			});
		}
		/**
		* Create a copy of this collection.
		*
		* @param schema - If defined, overwrites the original's schema
		*/
		clone(schema) {
			const copy = Object.create(Object.getPrototypeOf(this), Object.getOwnPropertyDescriptors(this));
			if (schema) copy.schema = schema;
			copy.items = copy.items.map((it) => identity.isNode(it) || identity.isPair(it) ? it.clone(schema) : it);
			if (this.range) copy.range = this.range.slice();
			return copy;
		}
		/**
		* Adds a value to the collection. For `!!map` and `!!omap` the value must
		* be a Pair instance or a `{ key, value }` object, which may not have a key
		* that already exists in the map.
		*/
		addIn(path, value) {
			if (isEmptyPath(path)) this.add(value);
			else {
				const [key, ...rest] = path;
				const node = this.get(key, true);
				if (identity.isCollection(node)) node.addIn(rest, value);
				else if (node === void 0 && this.schema) this.set(key, collectionFromPath(this.schema, rest, value));
				else throw new Error(`Expected YAML collection at ${key}. Remaining path: ${rest}`);
			}
		}
		/**
		* Removes a value from the collection.
		* @returns `true` if the item was found and removed.
		*/
		deleteIn(path) {
			const [key, ...rest] = path;
			if (rest.length === 0) return this.delete(key);
			const node = this.get(key, true);
			if (identity.isCollection(node)) return node.deleteIn(rest);
			else throw new Error(`Expected YAML collection at ${key}. Remaining path: ${rest}`);
		}
		/**
		* Returns item at `key`, or `undefined` if not found. By default unwraps
		* scalar values from their surrounding node; to disable set `keepScalar` to
		* `true` (collections are always returned intact).
		*/
		getIn(path, keepScalar) {
			const [key, ...rest] = path;
			const node = this.get(key, true);
			if (rest.length === 0) return !keepScalar && identity.isScalar(node) ? node.value : node;
			else return identity.isCollection(node) ? node.getIn(rest, keepScalar) : void 0;
		}
		hasAllNullValues(allowScalar) {
			return this.items.every((node) => {
				if (!identity.isPair(node)) return false;
				const n = node.value;
				return n == null || allowScalar && identity.isScalar(n) && n.value == null && !n.commentBefore && !n.comment && !n.tag;
			});
		}
		/**
		* Checks if the collection includes a value with the key `key`.
		*/
		hasIn(path) {
			const [key, ...rest] = path;
			if (rest.length === 0) return this.has(key);
			const node = this.get(key, true);
			return identity.isCollection(node) ? node.hasIn(rest) : false;
		}
		/**
		* Sets a value in this collection. For `!!set`, `value` needs to be a
		* boolean to add/remove the item from the set.
		*/
		setIn(path, value) {
			const [key, ...rest] = path;
			if (rest.length === 0) this.set(key, value);
			else {
				const node = this.get(key, true);
				if (identity.isCollection(node)) node.setIn(rest, value);
				else if (node === void 0 && this.schema) this.set(key, collectionFromPath(this.schema, rest, value));
				else throw new Error(`Expected YAML collection at ${key}. Remaining path: ${rest}`);
			}
		}
	};
	exports.Collection = Collection;
	exports.collectionFromPath = collectionFromPath;
	exports.isEmptyPath = isEmptyPath;
}));
//#endregion
//#region node_modules/yaml/dist/stringify/stringifyComment.js
var require_stringifyComment = /* @__PURE__ */ __commonJSMin(((exports) => {
	/**
	* Stringifies a comment.
	*
	* Empty comment lines are left empty,
	* lines consisting of a single space are replaced by `#`,
	* and all other lines are prefixed with a `#`.
	*/
	const stringifyComment = (str) => str.replace(/^(?!$)(?: $)?/gm, "#");
	function indentComment(comment, indent) {
		if (/^\n+$/.test(comment)) return comment.substring(1);
		return indent ? comment.replace(/^(?! *$)/gm, indent) : comment;
	}
	const lineComment = (str, indent, comment) => str.endsWith("\n") ? indentComment(comment, indent) : comment.includes("\n") ? "\n" + indentComment(comment, indent) : (str.endsWith(" ") ? "" : " ") + comment;
	exports.indentComment = indentComment;
	exports.lineComment = lineComment;
	exports.stringifyComment = stringifyComment;
}));
//#endregion
//#region node_modules/yaml/dist/stringify/foldFlowLines.js
var require_foldFlowLines = /* @__PURE__ */ __commonJSMin(((exports) => {
	const FOLD_FLOW = "flow";
	const FOLD_BLOCK = "block";
	const FOLD_QUOTED = "quoted";
	/**
	* Tries to keep input at up to `lineWidth` characters, splitting only on spaces
	* not followed by newlines or spaces unless `mode` is `'quoted'`. Lines are
	* terminated with `\n` and started with `indent`.
	*/
	function foldFlowLines(text, indent, mode = "flow", { indentAtStart, lineWidth = 80, minContentWidth = 20, onFold, onOverflow } = {}) {
		if (!lineWidth || lineWidth < 0) return text;
		if (lineWidth < minContentWidth) minContentWidth = 0;
		const endStep = Math.max(1 + minContentWidth, 1 + lineWidth - indent.length);
		if (text.length <= endStep) return text;
		const folds = [];
		const escapedFolds = {};
		let end = lineWidth - indent.length;
		if (typeof indentAtStart === "number") {
			if (indentAtStart > lineWidth - Math.max(2, minContentWidth)) folds.push(0);
			else end = lineWidth - indentAtStart;
		}
		let split = void 0;
		let prev = void 0;
		let overflow = false;
		let i = -1;
		let escStart = -1;
		let escEnd = -1;
		if (mode === FOLD_BLOCK) {
			i = consumeMoreIndentedLines(text, i, indent.length);
			if (i !== -1) end = i + endStep;
		}
		for (let ch; ch = text[i += 1];) {
			if (mode === FOLD_QUOTED && ch === "\\") {
				escStart = i;
				switch (text[i + 1]) {
					case "x":
						i += 3;
						break;
					case "u":
						i += 5;
						break;
					case "U":
						i += 9;
						break;
					default: i += 1;
				}
				escEnd = i;
			}
			if (ch === "\n") {
				if (mode === FOLD_BLOCK) i = consumeMoreIndentedLines(text, i, indent.length);
				end = i + indent.length + endStep;
				split = void 0;
			} else {
				if (ch === " " && prev && prev !== " " && prev !== "\n" && prev !== "	") {
					const next = text[i + 1];
					if (next && next !== " " && next !== "\n" && next !== "	") split = i;
				}
				if (i >= end) {
					if (split) {
						folds.push(split);
						end = split + endStep;
						split = void 0;
					} else if (mode === FOLD_QUOTED) {
						while (prev === " " || prev === "	") {
							prev = ch;
							ch = text[i += 1];
							overflow = true;
						}
						const j = i > escEnd + 1 ? i - 2 : escStart - 1;
						if (escapedFolds[j]) return text;
						folds.push(j);
						escapedFolds[j] = true;
						end = j + endStep;
						split = void 0;
					} else overflow = true;
				}
			}
			prev = ch;
		}
		if (overflow && onOverflow) onOverflow();
		if (folds.length === 0) return text;
		if (onFold) onFold();
		let res = text.slice(0, folds[0]);
		for (let i = 0; i < folds.length; ++i) {
			const fold = folds[i];
			const end = folds[i + 1] || text.length;
			if (fold === 0) res = `\n${indent}${text.slice(0, end)}`;
			else {
				if (mode === FOLD_QUOTED && escapedFolds[fold]) res += `${text[fold]}\\`;
				res += `\n${indent}${text.slice(fold + 1, end)}`;
			}
		}
		return res;
	}
	/**
	* Presumes `i + 1` is at the start of a line
	* @returns index of last newline in more-indented block
	*/
	function consumeMoreIndentedLines(text, i, indent) {
		let end = i;
		let start = i + 1;
		let ch = text[start];
		while (ch === " " || ch === "	") if (i < start + indent) ch = text[++i];
		else {
			do
				ch = text[++i];
			while (ch && ch !== "\n");
			end = i;
			start = i + 1;
			ch = text[start];
		}
		return end;
	}
	exports.FOLD_BLOCK = FOLD_BLOCK;
	exports.FOLD_FLOW = FOLD_FLOW;
	exports.FOLD_QUOTED = FOLD_QUOTED;
	exports.foldFlowLines = foldFlowLines;
}));
//#endregion
//#region node_modules/yaml/dist/stringify/stringifyString.js
var require_stringifyString = /* @__PURE__ */ __commonJSMin(((exports) => {
	var Scalar = require_Scalar();
	var foldFlowLines = require_foldFlowLines();
	const getFoldOptions = (ctx, isBlock) => ({
		indentAtStart: isBlock ? ctx.indent.length : ctx.indentAtStart,
		lineWidth: ctx.options.lineWidth,
		minContentWidth: ctx.options.minContentWidth
	});
	const containsDocumentMarker = (str) => /^(%|---|\.\.\.)/m.test(str);
	function lineLengthOverLimit(str, lineWidth, indentLength) {
		if (!lineWidth || lineWidth < 0) return false;
		const limit = lineWidth - indentLength;
		const strLen = str.length;
		if (strLen <= limit) return false;
		for (let i = 0, start = 0; i < strLen; ++i) if (str[i] === "\n") {
			if (i - start > limit) return true;
			start = i + 1;
			if (strLen - start <= limit) return false;
		}
		return true;
	}
	function doubleQuotedString(value, ctx) {
		const json = JSON.stringify(value);
		if (ctx.options.doubleQuotedAsJSON) return json;
		const { implicitKey } = ctx;
		const minMultiLineLength = ctx.options.doubleQuotedMinMultiLineLength;
		const indent = ctx.indent || (containsDocumentMarker(value) ? "  " : "");
		let str = "";
		let start = 0;
		for (let i = 0, ch = json[i]; ch; ch = json[++i]) {
			if (ch === " " && json[i + 1] === "\\" && json[i + 2] === "n") {
				str += json.slice(start, i) + "\\ ";
				i += 1;
				start = i;
				ch = "\\";
			}
			if (ch === "\\") switch (json[i + 1]) {
				case "u":
					{
						str += json.slice(start, i);
						const code = json.substr(i + 2, 4);
						switch (code) {
							case "0000":
								str += "\\0";
								break;
							case "0007":
								str += "\\a";
								break;
							case "000b":
								str += "\\v";
								break;
							case "001b":
								str += "\\e";
								break;
							case "0085":
								str += "\\N";
								break;
							case "00a0":
								str += "\\_";
								break;
							case "2028":
								str += "\\L";
								break;
							case "2029":
								str += "\\P";
								break;
							default: if (code.substr(0, 2) === "00") str += "\\x" + code.substr(2);
							else str += json.substr(i, 6);
						}
						i += 5;
						start = i + 1;
					}
					break;
				case "n":
					if (implicitKey || json[i + 2] === "\"" || json.length < minMultiLineLength) i += 1;
					else {
						str += json.slice(start, i) + "\n\n";
						while (json[i + 2] === "\\" && json[i + 3] === "n" && json[i + 4] !== "\"") {
							str += "\n";
							i += 2;
						}
						str += indent;
						if (json[i + 2] === " ") str += "\\";
						i += 1;
						start = i + 1;
					}
					break;
				default: i += 1;
			}
		}
		str = start ? str + json.slice(start) : json;
		return implicitKey ? str : foldFlowLines.foldFlowLines(str, indent, foldFlowLines.FOLD_QUOTED, getFoldOptions(ctx, false));
	}
	function singleQuotedString(value, ctx) {
		if (ctx.options.singleQuote === false || ctx.implicitKey && value.includes("\n") || /[ \t]\n|\n[ \t]/.test(value)) return doubleQuotedString(value, ctx);
		const indent = ctx.indent || (containsDocumentMarker(value) ? "  " : "");
		const res = "'" + value.replace(/'/g, "''").replace(/\n+/g, `$&\n${indent}`) + "'";
		return ctx.implicitKey ? res : foldFlowLines.foldFlowLines(res, indent, foldFlowLines.FOLD_FLOW, getFoldOptions(ctx, false));
	}
	function quotedString(value, ctx) {
		const { singleQuote } = ctx.options;
		let qs;
		if (singleQuote === false) qs = doubleQuotedString;
		else {
			const hasDouble = value.includes("\"");
			const hasSingle = value.includes("'");
			if (hasDouble && !hasSingle) qs = singleQuotedString;
			else if (hasSingle && !hasDouble) qs = doubleQuotedString;
			else qs = singleQuote ? singleQuotedString : doubleQuotedString;
		}
		return qs(value, ctx);
	}
	let blockEndNewlines;
	try {
		blockEndNewlines = new RegExp("(^|(?<!\n))\n+(?!\n|$)", "g");
	} catch {
		blockEndNewlines = /\n+(?!\n|$)/g;
	}
	function blockString({ comment, type, value }, ctx, onComment, onChompKeep) {
		const { blockQuote, commentString, lineWidth } = ctx.options;
		if (!blockQuote || /\n[\t ]+$/.test(value)) return quotedString(value, ctx);
		const indent = ctx.indent || (ctx.forceBlockIndent || containsDocumentMarker(value) ? "  " : "");
		const literal = blockQuote === "literal" ? true : blockQuote === "folded" || type === Scalar.Scalar.BLOCK_FOLDED ? false : type === Scalar.Scalar.BLOCK_LITERAL ? true : !lineLengthOverLimit(value, lineWidth, indent.length);
		if (!value) return literal ? "|\n" : ">\n";
		let chomp;
		let endStart;
		for (endStart = value.length; endStart > 0; --endStart) {
			const ch = value[endStart - 1];
			if (ch !== "\n" && ch !== "	" && ch !== " ") break;
		}
		let end = value.substring(endStart);
		const endNlPos = end.indexOf("\n");
		if (endNlPos === -1) chomp = "-";
		else if (value === end || endNlPos !== end.length - 1) {
			chomp = "+";
			if (onChompKeep) onChompKeep();
		} else chomp = "";
		if (end) {
			value = value.slice(0, -end.length);
			if (end[end.length - 1] === "\n") end = end.slice(0, -1);
			end = end.replace(blockEndNewlines, `$&${indent}`);
		}
		let startWithSpace = false;
		let startEnd;
		let startNlPos = -1;
		for (startEnd = 0; startEnd < value.length; ++startEnd) {
			const ch = value[startEnd];
			if (ch === " ") startWithSpace = true;
			else if (ch === "\n") startNlPos = startEnd;
			else break;
		}
		let start = value.substring(0, startNlPos < startEnd ? startNlPos + 1 : startEnd);
		if (start) {
			value = value.substring(start.length);
			start = start.replace(/\n+/g, `$&${indent}`);
		}
		let header = (startWithSpace ? indent ? "2" : "1" : "") + chomp;
		if (comment) {
			header += " " + commentString(comment.replace(/ ?[\r\n]+/g, " "));
			if (onComment) onComment();
		}
		if (!literal) {
			const foldedValue = value.replace(/\n+/g, "\n$&").replace(/(?:^|\n)([\t ].*)(?:([\n\t ]*)\n(?![\n\t ]))?/g, "$1$2").replace(/\n+/g, `$&${indent}`);
			let literalFallback = false;
			const foldOptions = getFoldOptions(ctx, true);
			if (blockQuote !== "folded" && type !== Scalar.Scalar.BLOCK_FOLDED) foldOptions.onOverflow = () => {
				literalFallback = true;
			};
			const body = foldFlowLines.foldFlowLines(`${start}${foldedValue}${end}`, indent, foldFlowLines.FOLD_BLOCK, foldOptions);
			if (!literalFallback) return `>${header}\n${indent}${body}`;
		}
		value = value.replace(/\n+/g, `$&${indent}`);
		return `|${header}\n${indent}${start}${value}${end}`;
	}
	function plainString(item, ctx, onComment, onChompKeep) {
		const { type, value } = item;
		const { actualString, implicitKey, indent, indentStep, inFlow } = ctx;
		if (implicitKey && value.includes("\n") || inFlow && /[[\]{},]/.test(value)) return quotedString(value, ctx);
		if (/^[\n\t ,[\]{}#&*!|>'"%@`]|^[?-]$|^[?-][ \t]|[\n:][ \t]|[ \t]\n|[\n\t ]#|[\n\t :]$/.test(value)) return implicitKey || inFlow || !value.includes("\n") ? quotedString(value, ctx) : blockString(item, ctx, onComment, onChompKeep);
		if (!implicitKey && !inFlow && type !== Scalar.Scalar.PLAIN && value.includes("\n")) return blockString(item, ctx, onComment, onChompKeep);
		if (containsDocumentMarker(value)) {
			if (indent === "") {
				ctx.forceBlockIndent = true;
				return blockString(item, ctx, onComment, onChompKeep);
			} else if (implicitKey && indent === indentStep) return quotedString(value, ctx);
		}
		const str = value.replace(/\n+/g, `$&\n${indent}`);
		if (actualString) {
			const test = (tag) => tag.default && tag.tag !== "tag:yaml.org,2002:str" && tag.test?.test(str);
			const { compat, tags } = ctx.doc.schema;
			if (tags.some(test) || compat?.some(test)) return quotedString(value, ctx);
		}
		return implicitKey ? str : foldFlowLines.foldFlowLines(str, indent, foldFlowLines.FOLD_FLOW, getFoldOptions(ctx, false));
	}
	function stringifyString(item, ctx, onComment, onChompKeep) {
		const { implicitKey, inFlow } = ctx;
		const ss = typeof item.value === "string" ? item : Object.assign({}, item, { value: String(item.value) });
		let { type } = item;
		if (type !== Scalar.Scalar.QUOTE_DOUBLE) {
			if (/[\x00-\x08\x0b-\x1f\x7f-\x9f\u{D800}-\u{DFFF}]/u.test(ss.value)) type = Scalar.Scalar.QUOTE_DOUBLE;
		}
		const _stringify = (_type) => {
			switch (_type) {
				case Scalar.Scalar.BLOCK_FOLDED:
				case Scalar.Scalar.BLOCK_LITERAL: return implicitKey || inFlow ? quotedString(ss.value, ctx) : blockString(ss, ctx, onComment, onChompKeep);
				case Scalar.Scalar.QUOTE_DOUBLE: return doubleQuotedString(ss.value, ctx);
				case Scalar.Scalar.QUOTE_SINGLE: return singleQuotedString(ss.value, ctx);
				case Scalar.Scalar.PLAIN: return plainString(ss, ctx, onComment, onChompKeep);
				default: return null;
			}
		};
		let res = _stringify(type);
		if (res === null) {
			const { defaultKeyType, defaultStringType } = ctx.options;
			const t = implicitKey && defaultKeyType || defaultStringType;
			res = _stringify(t);
			if (res === null) throw new Error(`Unsupported default string type ${t}`);
		}
		return res;
	}
	exports.stringifyString = stringifyString;
}));
//#endregion
//#region node_modules/yaml/dist/stringify/stringify.js
var require_stringify = /* @__PURE__ */ __commonJSMin(((exports) => {
	var anchors = require_anchors();
	var identity = require_identity();
	var stringifyComment = require_stringifyComment();
	var stringifyString = require_stringifyString();
	function createStringifyContext(doc, options) {
		const opt = Object.assign({
			blockQuote: true,
			commentString: stringifyComment.stringifyComment,
			defaultKeyType: null,
			defaultStringType: "PLAIN",
			directives: null,
			doubleQuotedAsJSON: false,
			doubleQuotedMinMultiLineLength: 40,
			falseStr: "false",
			flowCollectionPadding: true,
			indentSeq: true,
			lineWidth: 80,
			minContentWidth: 20,
			nullStr: "null",
			simpleKeys: false,
			singleQuote: null,
			trailingComma: false,
			trueStr: "true",
			verifyAliasOrder: true
		}, doc.schema.toStringOptions, options);
		let inFlow;
		switch (opt.collectionStyle) {
			case "block":
				inFlow = false;
				break;
			case "flow":
				inFlow = true;
				break;
			default: inFlow = null;
		}
		return {
			anchors: /* @__PURE__ */ new Set(),
			doc,
			flowCollectionPadding: opt.flowCollectionPadding ? " " : "",
			indent: "",
			indentStep: typeof opt.indent === "number" ? " ".repeat(opt.indent) : "  ",
			inFlow,
			options: opt
		};
	}
	function getTagObject(tags, item) {
		if (item.tag) {
			const match = tags.filter((t) => t.tag === item.tag);
			if (match.length > 0) return match.find((t) => t.format === item.format) ?? match[0];
		}
		let tagObj = void 0;
		let obj;
		if (identity.isScalar(item)) {
			obj = item.value;
			let match = tags.filter((t) => t.identify?.(obj));
			if (match.length > 1) {
				const testMatch = match.filter((t) => t.test);
				if (testMatch.length > 0) match = testMatch;
			}
			tagObj = match.find((t) => t.format === item.format) ?? match.find((t) => !t.format);
		} else {
			obj = item;
			tagObj = tags.find((t) => t.nodeClass && obj instanceof t.nodeClass);
		}
		if (!tagObj) {
			const name = obj?.constructor?.name ?? (obj === null ? "null" : typeof obj);
			throw new Error(`Tag not resolved for ${name} value`);
		}
		return tagObj;
	}
	function stringifyProps(node, tagObj, { anchors: anchors$1, doc }) {
		if (!doc.directives) return "";
		const props = [];
		const anchor = (identity.isScalar(node) || identity.isCollection(node)) && node.anchor;
		if (anchor && anchors.anchorIsValid(anchor)) {
			anchors$1.add(anchor);
			props.push(`&${anchor}`);
		}
		const tag = node.tag ?? (tagObj.default ? null : tagObj.tag);
		if (tag) props.push(doc.directives.tagString(tag));
		return props.join(" ");
	}
	function stringify(item, ctx, onComment, onChompKeep) {
		if (identity.isPair(item)) return item.toString(ctx, onComment, onChompKeep);
		if (identity.isAlias(item)) {
			if (ctx.doc.directives) return item.toString(ctx);
			if (ctx.resolvedAliases?.has(item)) throw new TypeError(`Cannot stringify circular structure without alias nodes`);
			else {
				if (ctx.resolvedAliases) ctx.resolvedAliases.add(item);
				else ctx.resolvedAliases = /* @__PURE__ */ new Set([item]);
				item = item.resolve(ctx.doc);
			}
		}
		let tagObj = void 0;
		const node = identity.isNode(item) ? item : ctx.doc.createNode(item, { onTagObj: (o) => tagObj = o });
		tagObj ?? (tagObj = getTagObject(ctx.doc.schema.tags, node));
		const props = stringifyProps(node, tagObj, ctx);
		if (props.length > 0) ctx.indentAtStart = (ctx.indentAtStart ?? 0) + props.length + 1;
		const str = typeof tagObj.stringify === "function" ? tagObj.stringify(node, ctx, onComment, onChompKeep) : identity.isScalar(node) ? stringifyString.stringifyString(node, ctx, onComment, onChompKeep) : node.toString(ctx, onComment, onChompKeep);
		if (!props) return str;
		return identity.isScalar(node) || str[0] === "{" || str[0] === "[" ? `${props} ${str}` : `${props}\n${ctx.indent}${str}`;
	}
	exports.createStringifyContext = createStringifyContext;
	exports.stringify = stringify;
}));
//#endregion
//#region node_modules/yaml/dist/stringify/stringifyPair.js
var require_stringifyPair = /* @__PURE__ */ __commonJSMin(((exports) => {
	var identity = require_identity();
	var Scalar = require_Scalar();
	var stringify = require_stringify();
	var stringifyComment = require_stringifyComment();
	function stringifyPair({ key, value }, ctx, onComment, onChompKeep) {
		const { allNullValues, doc, indent, indentStep, options: { commentString, indentSeq, simpleKeys } } = ctx;
		let keyComment = identity.isNode(key) && key.comment || null;
		if (simpleKeys) {
			if (keyComment) throw new Error("With simple keys, key nodes cannot have comments");
			if (identity.isCollection(key) || !identity.isNode(key) && typeof key === "object") throw new Error("With simple keys, collection cannot be used as a key value");
		}
		let explicitKey = !simpleKeys && (!key || keyComment && value == null && !ctx.inFlow || identity.isCollection(key) || (identity.isScalar(key) ? key.type === Scalar.Scalar.BLOCK_FOLDED || key.type === Scalar.Scalar.BLOCK_LITERAL : typeof key === "object"));
		ctx = Object.assign({}, ctx, {
			allNullValues: false,
			implicitKey: !explicitKey && (simpleKeys || !allNullValues),
			indent: indent + indentStep
		});
		let keyCommentDone = false;
		let chompKeep = false;
		let str = stringify.stringify(key, ctx, () => keyCommentDone = true, () => chompKeep = true);
		if (!explicitKey && !ctx.inFlow && str.length > 1024) {
			if (simpleKeys) throw new Error("With simple keys, single line scalar must not span more than 1024 characters");
			explicitKey = true;
		}
		if (ctx.inFlow) {
			if (allNullValues || value == null) {
				if (keyCommentDone && onComment) onComment();
				return str === "" ? "?" : explicitKey ? `? ${str}` : str;
			}
		} else if (allNullValues && !simpleKeys || value == null && explicitKey) {
			str = `? ${str}`;
			if (keyComment && !keyCommentDone) str += stringifyComment.lineComment(str, ctx.indent, commentString(keyComment));
			else if (chompKeep && onChompKeep) onChompKeep();
			return str;
		}
		if (keyCommentDone) keyComment = null;
		if (explicitKey) {
			if (keyComment) str += stringifyComment.lineComment(str, ctx.indent, commentString(keyComment));
			str = `? ${str}\n${indent}:`;
		} else {
			str = `${str}:`;
			if (keyComment) str += stringifyComment.lineComment(str, ctx.indent, commentString(keyComment));
		}
		let vsb, vcb, valueComment;
		if (identity.isNode(value)) {
			vsb = !!value.spaceBefore;
			vcb = value.commentBefore;
			valueComment = value.comment;
		} else {
			vsb = false;
			vcb = null;
			valueComment = null;
			if (value && typeof value === "object") value = doc.createNode(value);
		}
		ctx.implicitKey = false;
		if (!explicitKey && !keyComment && identity.isScalar(value)) ctx.indentAtStart = str.length + 1;
		chompKeep = false;
		if (!indentSeq && indentStep.length >= 2 && !ctx.inFlow && !explicitKey && identity.isSeq(value) && !value.flow && !value.tag && !value.anchor) ctx.indent = ctx.indent.substring(2);
		let valueCommentDone = false;
		const valueStr = stringify.stringify(value, ctx, () => valueCommentDone = true, () => chompKeep = true);
		let ws = " ";
		if (keyComment || vsb || vcb) {
			ws = vsb ? "\n" : "";
			if (vcb) {
				const cs = commentString(vcb);
				ws += `\n${stringifyComment.indentComment(cs, ctx.indent)}`;
			}
			if (valueStr === "" && !ctx.inFlow) {
				if (ws === "\n" && valueComment) ws = "\n\n";
			} else ws += `\n${ctx.indent}`;
		} else if (!explicitKey && identity.isCollection(value)) {
			const vs0 = valueStr[0];
			const nl0 = valueStr.indexOf("\n");
			const hasNewline = nl0 !== -1;
			const flow = ctx.inFlow ?? value.flow ?? value.items.length === 0;
			if (hasNewline || !flow) {
				let hasPropsLine = false;
				if (hasNewline && (vs0 === "&" || vs0 === "!")) {
					let sp0 = valueStr.indexOf(" ");
					if (vs0 === "&" && sp0 !== -1 && sp0 < nl0 && valueStr[sp0 + 1] === "!") sp0 = valueStr.indexOf(" ", sp0 + 1);
					if (sp0 === -1 || nl0 < sp0) hasPropsLine = true;
				}
				if (!hasPropsLine) ws = `\n${ctx.indent}`;
			}
		} else if (valueStr === "" || valueStr[0] === "\n") ws = "";
		str += ws + valueStr;
		if (ctx.inFlow) {
			if (valueCommentDone && onComment) onComment();
		} else if (valueComment && !valueCommentDone) str += stringifyComment.lineComment(str, ctx.indent, commentString(valueComment));
		else if (chompKeep && onChompKeep) onChompKeep();
		return str;
	}
	exports.stringifyPair = stringifyPair;
}));
//#endregion
//#region node_modules/yaml/dist/log.js
var require_log = /* @__PURE__ */ __commonJSMin(((exports) => {
	var node_process$2 = __require("process");
	function debug(logLevel, ...messages) {
		if (logLevel === "debug") console.log(...messages);
	}
	function warn(logLevel, warning) {
		if (logLevel === "debug" || logLevel === "warn") {
			if (typeof node_process$2.emitWarning === "function") node_process$2.emitWarning(warning);
			else console.warn(warning);
		}
	}
	exports.debug = debug;
	exports.warn = warn;
}));
//#endregion
//#region node_modules/yaml/dist/schema/yaml-1.1/merge.js
var require_merge = /* @__PURE__ */ __commonJSMin(((exports) => {
	var identity = require_identity();
	var Scalar = require_Scalar();
	const MERGE_KEY = "<<";
	const merge = {
		identify: (value) => value === MERGE_KEY || typeof value === "symbol" && value.description === MERGE_KEY,
		default: "key",
		tag: "tag:yaml.org,2002:merge",
		test: /^<<$/,
		resolve: () => Object.assign(new Scalar.Scalar(Symbol(MERGE_KEY)), { addToJSMap: addMergeToJSMap }),
		stringify: () => MERGE_KEY
	};
	const isMergeKey = (ctx, key) => (merge.identify(key) || identity.isScalar(key) && (!key.type || key.type === Scalar.Scalar.PLAIN) && merge.identify(key.value)) && ctx?.doc.schema.tags.some((tag) => tag.tag === merge.tag && tag.default);
	function addMergeToJSMap(ctx, map, value) {
		const source = resolveAliasValue(ctx, value);
		if (identity.isSeq(source)) for (const it of source.items) mergeValue(ctx, map, it);
		else if (Array.isArray(source)) for (const it of source) mergeValue(ctx, map, it);
		else mergeValue(ctx, map, source);
	}
	function mergeValue(ctx, map, value) {
		const source = resolveAliasValue(ctx, value);
		if (!identity.isMap(source)) throw new Error("Merge sources must be maps or map aliases");
		const srcMap = source.toJSON(null, ctx, Map);
		for (const [key, value] of srcMap) if (map instanceof Map) {
			if (!map.has(key)) map.set(key, value);
		} else if (map instanceof Set) map.add(key);
		else if (!Object.prototype.hasOwnProperty.call(map, key)) Object.defineProperty(map, key, {
			value,
			writable: true,
			enumerable: true,
			configurable: true
		});
		return map;
	}
	function resolveAliasValue(ctx, value) {
		return ctx && identity.isAlias(value) ? value.resolve(ctx.doc, ctx) : value;
	}
	exports.addMergeToJSMap = addMergeToJSMap;
	exports.isMergeKey = isMergeKey;
	exports.merge = merge;
}));
//#endregion
//#region node_modules/yaml/dist/nodes/addPairToJSMap.js
var require_addPairToJSMap = /* @__PURE__ */ __commonJSMin(((exports) => {
	var log = require_log();
	var merge = require_merge();
	var stringify = require_stringify();
	var identity = require_identity();
	var toJS = require_toJS();
	function addPairToJSMap(ctx, map, { key, value }) {
		if (identity.isNode(key) && key.addToJSMap) key.addToJSMap(ctx, map, value);
		else if (merge.isMergeKey(ctx, key)) merge.addMergeToJSMap(ctx, map, value);
		else {
			const jsKey = toJS.toJS(key, "", ctx);
			if (map instanceof Map) map.set(jsKey, toJS.toJS(value, jsKey, ctx));
			else if (map instanceof Set) map.add(jsKey);
			else {
				const stringKey = stringifyKey(key, jsKey, ctx);
				const jsValue = toJS.toJS(value, stringKey, ctx);
				if (stringKey in map) Object.defineProperty(map, stringKey, {
					value: jsValue,
					writable: true,
					enumerable: true,
					configurable: true
				});
				else map[stringKey] = jsValue;
			}
		}
		return map;
	}
	function stringifyKey(key, jsKey, ctx) {
		if (jsKey === null) return "";
		if (typeof jsKey !== "object") return String(jsKey);
		if (identity.isNode(key) && ctx?.doc) {
			const strCtx = stringify.createStringifyContext(ctx.doc, {});
			strCtx.anchors = /* @__PURE__ */ new Set();
			for (const node of ctx.anchors.keys()) strCtx.anchors.add(node.anchor);
			strCtx.inFlow = true;
			strCtx.inStringifyKey = true;
			const strKey = key.toString(strCtx);
			if (!ctx.mapKeyWarned) {
				let jsonStr = JSON.stringify(strKey);
				if (jsonStr.length > 40) jsonStr = jsonStr.substring(0, 36) + "...\"";
				log.warn(ctx.doc.options.logLevel, `Keys with collection values will be stringified due to JS Object restrictions: ${jsonStr}. Set mapAsMap: true to use object keys.`);
				ctx.mapKeyWarned = true;
			}
			return strKey;
		}
		return JSON.stringify(jsKey);
	}
	exports.addPairToJSMap = addPairToJSMap;
}));
//#endregion
//#region node_modules/yaml/dist/nodes/Pair.js
var require_Pair = /* @__PURE__ */ __commonJSMin(((exports) => {
	var createNode = require_createNode();
	var stringifyPair = require_stringifyPair();
	var addPairToJSMap = require_addPairToJSMap();
	var identity = require_identity();
	function createPair(key, value, ctx) {
		return new Pair(createNode.createNode(key, void 0, ctx), createNode.createNode(value, void 0, ctx));
	}
	var Pair = class Pair {
		constructor(key, value = null) {
			Object.defineProperty(this, identity.NODE_TYPE, { value: identity.PAIR });
			this.key = key;
			this.value = value;
		}
		clone(schema) {
			let { key, value } = this;
			if (identity.isNode(key)) key = key.clone(schema);
			if (identity.isNode(value)) value = value.clone(schema);
			return new Pair(key, value);
		}
		toJSON(_, ctx) {
			const pair = ctx?.mapAsMap ? /* @__PURE__ */ new Map() : {};
			return addPairToJSMap.addPairToJSMap(ctx, pair, this);
		}
		toString(ctx, onComment, onChompKeep) {
			return ctx?.doc ? stringifyPair.stringifyPair(this, ctx, onComment, onChompKeep) : JSON.stringify(this);
		}
	};
	exports.Pair = Pair;
	exports.createPair = createPair;
}));
//#endregion
//#region node_modules/yaml/dist/stringify/stringifyCollection.js
var require_stringifyCollection = /* @__PURE__ */ __commonJSMin(((exports) => {
	var identity = require_identity();
	var stringify = require_stringify();
	var stringifyComment = require_stringifyComment();
	function stringifyCollection(collection, ctx, options) {
		return (ctx.inFlow ?? collection.flow ? stringifyFlowCollection : stringifyBlockCollection)(collection, ctx, options);
	}
	function stringifyBlockCollection({ comment, items }, ctx, { blockItemPrefix, flowChars, itemIndent, onChompKeep, onComment }) {
		const { indent, options: { commentString } } = ctx;
		const itemCtx = Object.assign({}, ctx, {
			indent: itemIndent,
			type: null
		});
		let chompKeep = false;
		const lines = [];
		for (let i = 0; i < items.length; ++i) {
			const item = items[i];
			let comment = null;
			if (identity.isNode(item)) {
				if (!chompKeep && item.spaceBefore) lines.push("");
				addCommentBefore(ctx, lines, item.commentBefore, chompKeep);
				if (item.comment) comment = item.comment;
			} else if (identity.isPair(item)) {
				const ik = identity.isNode(item.key) ? item.key : null;
				if (ik) {
					if (!chompKeep && ik.spaceBefore) lines.push("");
					addCommentBefore(ctx, lines, ik.commentBefore, chompKeep);
				}
			}
			chompKeep = false;
			let str = stringify.stringify(item, itemCtx, () => comment = null, () => chompKeep = true);
			if (comment) str += stringifyComment.lineComment(str, itemIndent, commentString(comment));
			if (chompKeep && comment) chompKeep = false;
			lines.push(blockItemPrefix + str);
		}
		let str;
		if (lines.length === 0) str = flowChars.start + flowChars.end;
		else {
			str = lines[0];
			for (let i = 1; i < lines.length; ++i) {
				const line = lines[i];
				str += line ? `\n${indent}${line}` : "\n";
			}
		}
		if (comment) {
			str += "\n" + stringifyComment.indentComment(commentString(comment), indent);
			if (onComment) onComment();
		} else if (chompKeep && onChompKeep) onChompKeep();
		return str;
	}
	function stringifyFlowCollection({ items }, ctx, { flowChars, itemIndent }) {
		const { indent, indentStep, flowCollectionPadding: fcPadding, options: { commentString } } = ctx;
		itemIndent += indentStep;
		const itemCtx = Object.assign({}, ctx, {
			indent: itemIndent,
			inFlow: true,
			type: null
		});
		let reqNewline = false;
		let linesAtValue = 0;
		const lines = [];
		for (let i = 0; i < items.length; ++i) {
			const item = items[i];
			let comment = null;
			if (identity.isNode(item)) {
				if (item.spaceBefore) lines.push("");
				addCommentBefore(ctx, lines, item.commentBefore, false);
				if (item.comment) comment = item.comment;
			} else if (identity.isPair(item)) {
				const ik = identity.isNode(item.key) ? item.key : null;
				if (ik) {
					if (ik.spaceBefore) lines.push("");
					addCommentBefore(ctx, lines, ik.commentBefore, false);
					if (ik.comment) reqNewline = true;
				}
				const iv = identity.isNode(item.value) ? item.value : null;
				if (iv) {
					if (iv.comment) comment = iv.comment;
					if (iv.commentBefore) reqNewline = true;
				} else if (item.value == null && ik?.comment) comment = ik.comment;
			}
			if (comment) reqNewline = true;
			let str = stringify.stringify(item, itemCtx, () => comment = null);
			reqNewline || (reqNewline = lines.length > linesAtValue || str.includes("\n"));
			if (i < items.length - 1) str += ",";
			else if (ctx.options.trailingComma) {
				if (ctx.options.lineWidth > 0) reqNewline || (reqNewline = lines.reduce((sum, line) => sum + line.length + 2, 2) + (str.length + 2) > ctx.options.lineWidth);
				if (reqNewline) str += ",";
			}
			if (comment) str += stringifyComment.lineComment(str, itemIndent, commentString(comment));
			lines.push(str);
			linesAtValue = lines.length;
		}
		const { start, end } = flowChars;
		if (lines.length === 0) return start + end;
		else {
			if (!reqNewline) {
				const len = lines.reduce((sum, line) => sum + line.length + 2, 2);
				reqNewline = ctx.options.lineWidth > 0 && len > ctx.options.lineWidth;
			}
			if (reqNewline) {
				let str = start;
				for (const line of lines) str += line ? `\n${indentStep}${indent}${line}` : "\n";
				return `${str}\n${indent}${end}`;
			} else return `${start}${fcPadding}${lines.join(" ")}${fcPadding}${end}`;
		}
	}
	function addCommentBefore({ indent, options: { commentString } }, lines, comment, chompKeep) {
		if (comment && chompKeep) comment = comment.replace(/^\n+/, "");
		if (comment) {
			const ic = stringifyComment.indentComment(commentString(comment), indent);
			lines.push(ic.trimStart());
		}
	}
	exports.stringifyCollection = stringifyCollection;
}));
//#endregion
//#region node_modules/yaml/dist/nodes/YAMLMap.js
var require_YAMLMap = /* @__PURE__ */ __commonJSMin(((exports) => {
	var stringifyCollection = require_stringifyCollection();
	var addPairToJSMap = require_addPairToJSMap();
	var Collection = require_Collection();
	var identity = require_identity();
	var Pair = require_Pair();
	var Scalar = require_Scalar();
	function findPair(items, key) {
		const k = identity.isScalar(key) ? key.value : key;
		for (const it of items) if (identity.isPair(it)) {
			if (it.key === key || it.key === k) return it;
			if (identity.isScalar(it.key) && it.key.value === k) return it;
		}
	}
	var YAMLMap = class extends Collection.Collection {
		static get tagName() {
			return "tag:yaml.org,2002:map";
		}
		constructor(schema) {
			super(identity.MAP, schema);
			this.items = [];
		}
		/**
		* A generic collection parsing method that can be extended
		* to other node classes that inherit from YAMLMap
		*/
		static from(schema, obj, ctx) {
			const { keepUndefined, replacer } = ctx;
			const map = new this(schema);
			const add = (key, value) => {
				if (typeof replacer === "function") value = replacer.call(obj, key, value);
				else if (Array.isArray(replacer) && !replacer.includes(key)) return;
				if (value !== void 0 || keepUndefined) map.items.push(Pair.createPair(key, value, ctx));
			};
			if (obj instanceof Map) for (const [key, value] of obj) add(key, value);
			else if (obj && typeof obj === "object") for (const key of Object.keys(obj)) add(key, obj[key]);
			if (typeof schema.sortMapEntries === "function") map.items.sort(schema.sortMapEntries);
			return map;
		}
		/**
		* Adds a value to the collection.
		*
		* @param overwrite - If not set `true`, using a key that is already in the
		*   collection will throw. Otherwise, overwrites the previous value.
		*/
		add(pair, overwrite) {
			let _pair;
			if (identity.isPair(pair)) _pair = pair;
			else if (!pair || typeof pair !== "object" || !("key" in pair)) _pair = new Pair.Pair(pair, pair?.value);
			else _pair = new Pair.Pair(pair.key, pair.value);
			const prev = findPair(this.items, _pair.key);
			const sortEntries = this.schema?.sortMapEntries;
			if (prev) {
				if (!overwrite) throw new Error(`Key ${_pair.key} already set`);
				if (identity.isScalar(prev.value) && Scalar.isScalarValue(_pair.value)) prev.value.value = _pair.value;
				else prev.value = _pair.value;
			} else if (sortEntries) {
				const i = this.items.findIndex((item) => sortEntries(_pair, item) < 0);
				if (i === -1) this.items.push(_pair);
				else this.items.splice(i, 0, _pair);
			} else this.items.push(_pair);
		}
		delete(key) {
			const it = findPair(this.items, key);
			if (!it) return false;
			return this.items.splice(this.items.indexOf(it), 1).length > 0;
		}
		get(key, keepScalar) {
			const node = findPair(this.items, key)?.value;
			return (!keepScalar && identity.isScalar(node) ? node.value : node) ?? void 0;
		}
		has(key) {
			return !!findPair(this.items, key);
		}
		set(key, value) {
			this.add(new Pair.Pair(key, value), true);
		}
		/**
		* @param ctx - Conversion context, originally set in Document#toJS()
		* @param {Class} Type - If set, forces the returned collection type
		* @returns Instance of Type, Map, or Object
		*/
		toJSON(_, ctx, Type) {
			const map = Type ? new Type() : ctx?.mapAsMap ? /* @__PURE__ */ new Map() : {};
			if (ctx?.onCreate) ctx.onCreate(map);
			for (const item of this.items) addPairToJSMap.addPairToJSMap(ctx, map, item);
			return map;
		}
		toString(ctx, onComment, onChompKeep) {
			if (!ctx) return JSON.stringify(this);
			for (const item of this.items) if (!identity.isPair(item)) throw new Error(`Map items must all be pairs; found ${JSON.stringify(item)} instead`);
			if (!ctx.allNullValues && this.hasAllNullValues(false)) ctx = Object.assign({}, ctx, { allNullValues: true });
			return stringifyCollection.stringifyCollection(this, ctx, {
				blockItemPrefix: "",
				flowChars: {
					start: "{",
					end: "}"
				},
				itemIndent: ctx.indent || "",
				onChompKeep,
				onComment
			});
		}
	};
	exports.YAMLMap = YAMLMap;
	exports.findPair = findPair;
}));
//#endregion
//#region node_modules/yaml/dist/schema/common/map.js
var require_map = /* @__PURE__ */ __commonJSMin(((exports) => {
	var identity = require_identity();
	var YAMLMap = require_YAMLMap();
	exports.map = {
		collection: "map",
		default: true,
		nodeClass: YAMLMap.YAMLMap,
		tag: "tag:yaml.org,2002:map",
		resolve(map, onError) {
			if (!identity.isMap(map)) onError("Expected a mapping for this tag");
			return map;
		},
		createNode: (schema, obj, ctx) => YAMLMap.YAMLMap.from(schema, obj, ctx)
	};
}));
//#endregion
//#region node_modules/yaml/dist/nodes/YAMLSeq.js
var require_YAMLSeq = /* @__PURE__ */ __commonJSMin(((exports) => {
	var createNode = require_createNode();
	var stringifyCollection = require_stringifyCollection();
	var Collection = require_Collection();
	var identity = require_identity();
	var Scalar = require_Scalar();
	var toJS = require_toJS();
	var YAMLSeq = class extends Collection.Collection {
		static get tagName() {
			return "tag:yaml.org,2002:seq";
		}
		constructor(schema) {
			super(identity.SEQ, schema);
			this.items = [];
		}
		add(value) {
			this.items.push(value);
		}
		/**
		* Removes a value from the collection.
		*
		* `key` must contain a representation of an integer for this to succeed.
		* It may be wrapped in a `Scalar`.
		*
		* @returns `true` if the item was found and removed.
		*/
		delete(key) {
			const idx = asItemIndex(key);
			if (typeof idx !== "number") return false;
			return this.items.splice(idx, 1).length > 0;
		}
		get(key, keepScalar) {
			const idx = asItemIndex(key);
			if (typeof idx !== "number") return void 0;
			const it = this.items[idx];
			return !keepScalar && identity.isScalar(it) ? it.value : it;
		}
		/**
		* Checks if the collection includes a value with the key `key`.
		*
		* `key` must contain a representation of an integer for this to succeed.
		* It may be wrapped in a `Scalar`.
		*/
		has(key) {
			const idx = asItemIndex(key);
			return typeof idx === "number" && idx < this.items.length;
		}
		/**
		* Sets a value in this collection. For `!!set`, `value` needs to be a
		* boolean to add/remove the item from the set.
		*
		* If `key` does not contain a representation of an integer, this will throw.
		* It may be wrapped in a `Scalar`.
		*/
		set(key, value) {
			const idx = asItemIndex(key);
			if (typeof idx !== "number") throw new Error(`Expected a valid index, not ${key}.`);
			const prev = this.items[idx];
			if (identity.isScalar(prev) && Scalar.isScalarValue(value)) prev.value = value;
			else this.items[idx] = value;
		}
		toJSON(_, ctx) {
			const seq = [];
			if (ctx?.onCreate) ctx.onCreate(seq);
			let i = 0;
			for (const item of this.items) seq.push(toJS.toJS(item, String(i++), ctx));
			return seq;
		}
		toString(ctx, onComment, onChompKeep) {
			if (!ctx) return JSON.stringify(this);
			return stringifyCollection.stringifyCollection(this, ctx, {
				blockItemPrefix: "- ",
				flowChars: {
					start: "[",
					end: "]"
				},
				itemIndent: (ctx.indent || "") + "  ",
				onChompKeep,
				onComment
			});
		}
		static from(schema, obj, ctx) {
			const { replacer } = ctx;
			const seq = new this(schema);
			if (obj && Symbol.iterator in Object(obj)) {
				let i = 0;
				for (let it of obj) {
					if (typeof replacer === "function") {
						const key = obj instanceof Set ? it : String(i++);
						it = replacer.call(obj, key, it);
					}
					seq.items.push(createNode.createNode(it, void 0, ctx));
				}
			}
			return seq;
		}
	};
	function asItemIndex(key) {
		let idx = identity.isScalar(key) ? key.value : key;
		if (idx && typeof idx === "string") idx = Number(idx);
		return typeof idx === "number" && Number.isInteger(idx) && idx >= 0 ? idx : null;
	}
	exports.YAMLSeq = YAMLSeq;
}));
//#endregion
//#region node_modules/yaml/dist/schema/common/seq.js
var require_seq = /* @__PURE__ */ __commonJSMin(((exports) => {
	var identity = require_identity();
	var YAMLSeq = require_YAMLSeq();
	exports.seq = {
		collection: "seq",
		default: true,
		nodeClass: YAMLSeq.YAMLSeq,
		tag: "tag:yaml.org,2002:seq",
		resolve(seq, onError) {
			if (!identity.isSeq(seq)) onError("Expected a sequence for this tag");
			return seq;
		},
		createNode: (schema, obj, ctx) => YAMLSeq.YAMLSeq.from(schema, obj, ctx)
	};
}));
//#endregion
//#region node_modules/yaml/dist/schema/common/string.js
var require_string = /* @__PURE__ */ __commonJSMin(((exports) => {
	var stringifyString = require_stringifyString();
	exports.string = {
		identify: (value) => typeof value === "string",
		default: true,
		tag: "tag:yaml.org,2002:str",
		resolve: (str) => str,
		stringify(item, ctx, onComment, onChompKeep) {
			ctx = Object.assign({ actualString: true }, ctx);
			return stringifyString.stringifyString(item, ctx, onComment, onChompKeep);
		}
	};
}));
//#endregion
//#region node_modules/yaml/dist/schema/common/null.js
var require_null = /* @__PURE__ */ __commonJSMin(((exports) => {
	var Scalar = require_Scalar();
	const nullTag = {
		identify: (value) => value == null,
		createNode: () => new Scalar.Scalar(null),
		default: true,
		tag: "tag:yaml.org,2002:null",
		test: /^(?:~|[Nn]ull|NULL)?$/,
		resolve: () => new Scalar.Scalar(null),
		stringify: ({ source }, ctx) => typeof source === "string" && nullTag.test.test(source) ? source : ctx.options.nullStr
	};
	exports.nullTag = nullTag;
}));
//#endregion
//#region node_modules/yaml/dist/schema/core/bool.js
var require_bool$1 = /* @__PURE__ */ __commonJSMin(((exports) => {
	var Scalar = require_Scalar();
	const boolTag = {
		identify: (value) => typeof value === "boolean",
		default: true,
		tag: "tag:yaml.org,2002:bool",
		test: /^(?:[Tt]rue|TRUE|[Ff]alse|FALSE)$/,
		resolve: (str) => new Scalar.Scalar(str[0] === "t" || str[0] === "T"),
		stringify({ source, value }, ctx) {
			if (source && boolTag.test.test(source)) {
				if (value === (source[0] === "t" || source[0] === "T")) return source;
			}
			return value ? ctx.options.trueStr : ctx.options.falseStr;
		}
	};
	exports.boolTag = boolTag;
}));
//#endregion
//#region node_modules/yaml/dist/stringify/stringifyNumber.js
var require_stringifyNumber = /* @__PURE__ */ __commonJSMin(((exports) => {
	function stringifyNumber({ format, minFractionDigits, tag, value }) {
		if (typeof value === "bigint") return String(value);
		const num = typeof value === "number" ? value : Number(value);
		if (!isFinite(num)) return isNaN(num) ? ".nan" : num < 0 ? "-.inf" : ".inf";
		let n = Object.is(value, -0) ? "-0" : JSON.stringify(value);
		if (!format && minFractionDigits && (!tag || tag === "tag:yaml.org,2002:float") && /^-?\d/.test(n) && !n.includes("e")) {
			let i = n.indexOf(".");
			if (i < 0) {
				i = n.length;
				n += ".";
			}
			let d = minFractionDigits - (n.length - i - 1);
			while (d-- > 0) n += "0";
		}
		return n;
	}
	exports.stringifyNumber = stringifyNumber;
}));
//#endregion
//#region node_modules/yaml/dist/schema/core/float.js
var require_float$1 = /* @__PURE__ */ __commonJSMin(((exports) => {
	var Scalar = require_Scalar();
	var stringifyNumber = require_stringifyNumber();
	const floatNaN = {
		identify: (value) => typeof value === "number",
		default: true,
		tag: "tag:yaml.org,2002:float",
		test: /^(?:[-+]?\.(?:inf|Inf|INF)|\.nan|\.NaN|\.NAN)$/,
		resolve: (str) => str.slice(-3).toLowerCase() === "nan" ? NaN : str[0] === "-" ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY,
		stringify: stringifyNumber.stringifyNumber
	};
	const floatExp = {
		identify: (value) => typeof value === "number",
		default: true,
		tag: "tag:yaml.org,2002:float",
		format: "EXP",
		test: /^[-+]?(?:\.[0-9]+|[0-9]+(?:\.[0-9]*)?)[eE][-+]?[0-9]+$/,
		resolve: (str) => parseFloat(str),
		stringify(node) {
			const num = Number(node.value);
			return isFinite(num) ? num.toExponential() : stringifyNumber.stringifyNumber(node);
		}
	};
	exports.float = {
		identify: (value) => typeof value === "number",
		default: true,
		tag: "tag:yaml.org,2002:float",
		test: /^[-+]?(?:\.[0-9]+|[0-9]+\.[0-9]*)$/,
		resolve(str) {
			const node = new Scalar.Scalar(parseFloat(str));
			const dot = str.indexOf(".");
			if (dot !== -1 && str[str.length - 1] === "0") node.minFractionDigits = str.length - dot - 1;
			return node;
		},
		stringify: stringifyNumber.stringifyNumber
	};
	exports.floatExp = floatExp;
	exports.floatNaN = floatNaN;
}));
//#endregion
//#region node_modules/yaml/dist/schema/core/int.js
var require_int$1 = /* @__PURE__ */ __commonJSMin(((exports) => {
	var stringifyNumber = require_stringifyNumber();
	const intIdentify = (value) => typeof value === "bigint" || Number.isInteger(value);
	const intResolve = (str, offset, radix, { intAsBigInt }) => intAsBigInt ? BigInt(str) : parseInt(str.substring(offset), radix);
	function intStringify(node, radix, prefix) {
		const { value } = node;
		if (intIdentify(value) && value >= 0) return prefix + value.toString(radix);
		return stringifyNumber.stringifyNumber(node);
	}
	const intOct = {
		identify: (value) => intIdentify(value) && value >= 0,
		default: true,
		tag: "tag:yaml.org,2002:int",
		format: "OCT",
		test: /^0o[0-7]+$/,
		resolve: (str, _onError, opt) => intResolve(str, 2, 8, opt),
		stringify: (node) => intStringify(node, 8, "0o")
	};
	const int = {
		identify: intIdentify,
		default: true,
		tag: "tag:yaml.org,2002:int",
		test: /^[-+]?[0-9]+$/,
		resolve: (str, _onError, opt) => intResolve(str, 0, 10, opt),
		stringify: stringifyNumber.stringifyNumber
	};
	const intHex = {
		identify: (value) => intIdentify(value) && value >= 0,
		default: true,
		tag: "tag:yaml.org,2002:int",
		format: "HEX",
		test: /^0x[0-9a-fA-F]+$/,
		resolve: (str, _onError, opt) => intResolve(str, 2, 16, opt),
		stringify: (node) => intStringify(node, 16, "0x")
	};
	exports.int = int;
	exports.intHex = intHex;
	exports.intOct = intOct;
}));
//#endregion
//#region node_modules/yaml/dist/schema/core/schema.js
var require_schema$2 = /* @__PURE__ */ __commonJSMin(((exports) => {
	var map = require_map();
	var _null = require_null();
	var seq = require_seq();
	var string = require_string();
	var bool = require_bool$1();
	var float = require_float$1();
	var int = require_int$1();
	exports.schema = [
		map.map,
		seq.seq,
		string.string,
		_null.nullTag,
		bool.boolTag,
		int.intOct,
		int.int,
		int.intHex,
		float.floatNaN,
		float.floatExp,
		float.float
	];
}));
//#endregion
//#region node_modules/yaml/dist/schema/json/schema.js
var require_schema$1 = /* @__PURE__ */ __commonJSMin(((exports) => {
	var Scalar = require_Scalar();
	var map = require_map();
	var seq = require_seq();
	function intIdentify(value) {
		return typeof value === "bigint" || Number.isInteger(value);
	}
	const stringifyJSON = ({ value }) => JSON.stringify(value);
	const jsonScalars = [
		{
			identify: (value) => typeof value === "string",
			default: true,
			tag: "tag:yaml.org,2002:str",
			resolve: (str) => str,
			stringify: stringifyJSON
		},
		{
			identify: (value) => value == null,
			createNode: () => new Scalar.Scalar(null),
			default: true,
			tag: "tag:yaml.org,2002:null",
			test: /^null$/,
			resolve: () => null,
			stringify: stringifyJSON
		},
		{
			identify: (value) => typeof value === "boolean",
			default: true,
			tag: "tag:yaml.org,2002:bool",
			test: /^true$|^false$/,
			resolve: (str) => str === "true",
			stringify: stringifyJSON
		},
		{
			identify: intIdentify,
			default: true,
			tag: "tag:yaml.org,2002:int",
			test: /^-?(?:0|[1-9][0-9]*)$/,
			resolve: (str, _onError, { intAsBigInt }) => intAsBigInt ? BigInt(str) : parseInt(str, 10),
			stringify: ({ value }) => intIdentify(value) ? value.toString() : JSON.stringify(value)
		},
		{
			identify: (value) => typeof value === "number",
			default: true,
			tag: "tag:yaml.org,2002:float",
			test: /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]*)?(?:[eE][-+]?[0-9]+)?$/,
			resolve: (str) => parseFloat(str),
			stringify: stringifyJSON
		}
	];
	exports.schema = [map.map, seq.seq].concat(jsonScalars, {
		default: true,
		tag: "",
		test: /^/,
		resolve(str, onError) {
			onError(`Unresolved plain scalar ${JSON.stringify(str)}`);
			return str;
		}
	});
}));
//#endregion
//#region node_modules/yaml/dist/schema/yaml-1.1/binary.js
var require_binary = /* @__PURE__ */ __commonJSMin(((exports) => {
	var node_buffer = __require("buffer");
	var Scalar = require_Scalar();
	var stringifyString = require_stringifyString();
	exports.binary = {
		identify: (value) => value instanceof Uint8Array,
		default: false,
		tag: "tag:yaml.org,2002:binary",
		/**
		* Returns a Buffer in node and an Uint8Array in browsers
		*
		* To use the resulting buffer as an image, you'll want to do something like:
		*
		*   const blob = new Blob([buffer], { type: 'image/jpeg' })
		*   document.querySelector('#photo').src = URL.createObjectURL(blob)
		*/
		resolve(src, onError) {
			if (typeof node_buffer.Buffer === "function") return node_buffer.Buffer.from(src, "base64");
			else if (typeof atob === "function") {
				const str = atob(src.replace(/[\n\r]/g, ""));
				const buffer = new Uint8Array(str.length);
				for (let i = 0; i < str.length; ++i) buffer[i] = str.charCodeAt(i);
				return buffer;
			} else {
				onError("This environment does not support reading binary tags; either Buffer or atob is required");
				return src;
			}
		},
		stringify({ comment, type, value }, ctx, onComment, onChompKeep) {
			if (!value) return "";
			const buf = value;
			let str;
			if (typeof node_buffer.Buffer === "function") str = buf instanceof node_buffer.Buffer ? buf.toString("base64") : node_buffer.Buffer.from(buf.buffer).toString("base64");
			else if (typeof btoa === "function") {
				let s = "";
				for (let i = 0; i < buf.length; ++i) s += String.fromCharCode(buf[i]);
				str = btoa(s);
			} else throw new Error("This environment does not support writing binary tags; either Buffer or btoa is required");
			type ?? (type = Scalar.Scalar.BLOCK_LITERAL);
			if (type !== Scalar.Scalar.QUOTE_DOUBLE) {
				const lineWidth = Math.max(ctx.options.lineWidth - ctx.indent.length, ctx.options.minContentWidth);
				const n = Math.ceil(str.length / lineWidth);
				const lines = new Array(n);
				for (let i = 0, o = 0; i < n; ++i, o += lineWidth) lines[i] = str.substr(o, lineWidth);
				str = lines.join(type === Scalar.Scalar.BLOCK_LITERAL ? "\n" : " ");
			}
			return stringifyString.stringifyString({
				comment,
				type,
				value: str
			}, ctx, onComment, onChompKeep);
		}
	};
}));
//#endregion
//#region node_modules/yaml/dist/schema/yaml-1.1/pairs.js
var require_pairs = /* @__PURE__ */ __commonJSMin(((exports) => {
	var identity = require_identity();
	var Pair = require_Pair();
	var Scalar = require_Scalar();
	var YAMLSeq = require_YAMLSeq();
	function resolvePairs(seq, onError) {
		if (identity.isSeq(seq)) for (let i = 0; i < seq.items.length; ++i) {
			let item = seq.items[i];
			if (identity.isPair(item)) continue;
			else if (identity.isMap(item)) {
				if (item.items.length > 1) onError("Each pair must have its own sequence indicator");
				const pair = item.items[0] || new Pair.Pair(new Scalar.Scalar(null));
				if (item.commentBefore) pair.key.commentBefore = pair.key.commentBefore ? `${item.commentBefore}\n${pair.key.commentBefore}` : item.commentBefore;
				if (item.comment) {
					const cn = pair.value ?? pair.key;
					cn.comment = cn.comment ? `${item.comment}\n${cn.comment}` : item.comment;
				}
				item = pair;
			}
			seq.items[i] = identity.isPair(item) ? item : new Pair.Pair(item);
		}
		else onError("Expected a sequence for this tag");
		return seq;
	}
	function createPairs(schema, iterable, ctx) {
		const { replacer } = ctx;
		const pairs = new YAMLSeq.YAMLSeq(schema);
		pairs.tag = "tag:yaml.org,2002:pairs";
		let i = 0;
		if (iterable && Symbol.iterator in Object(iterable)) for (let it of iterable) {
			if (typeof replacer === "function") it = replacer.call(iterable, String(i++), it);
			let key, value;
			if (Array.isArray(it)) {
				if (it.length === 2) {
					key = it[0];
					value = it[1];
				} else throw new TypeError(`Expected [key, value] tuple: ${it}`);
			} else if (it && it instanceof Object) {
				const keys = Object.keys(it);
				if (keys.length === 1) {
					key = keys[0];
					value = it[key];
				} else throw new TypeError(`Expected tuple with one key, not ${keys.length} keys`);
			} else key = it;
			pairs.items.push(Pair.createPair(key, value, ctx));
		}
		return pairs;
	}
	const pairs = {
		collection: "seq",
		default: false,
		tag: "tag:yaml.org,2002:pairs",
		resolve: resolvePairs,
		createNode: createPairs
	};
	exports.createPairs = createPairs;
	exports.pairs = pairs;
	exports.resolvePairs = resolvePairs;
}));
//#endregion
//#region node_modules/yaml/dist/schema/yaml-1.1/omap.js
var require_omap = /* @__PURE__ */ __commonJSMin(((exports) => {
	var identity = require_identity();
	var toJS = require_toJS();
	var YAMLMap = require_YAMLMap();
	var YAMLSeq = require_YAMLSeq();
	var pairs = require_pairs();
	var YAMLOMap = class YAMLOMap extends YAMLSeq.YAMLSeq {
		constructor() {
			super();
			this.add = YAMLMap.YAMLMap.prototype.add.bind(this);
			this.delete = YAMLMap.YAMLMap.prototype.delete.bind(this);
			this.get = YAMLMap.YAMLMap.prototype.get.bind(this);
			this.has = YAMLMap.YAMLMap.prototype.has.bind(this);
			this.set = YAMLMap.YAMLMap.prototype.set.bind(this);
			this.tag = YAMLOMap.tag;
		}
		/**
		* If `ctx` is given, the return type is actually `Map<unknown, unknown>`,
		* but TypeScript won't allow widening the signature of a child method.
		*/
		toJSON(_, ctx) {
			if (!ctx) return super.toJSON(_);
			const map = /* @__PURE__ */ new Map();
			if (ctx?.onCreate) ctx.onCreate(map);
			for (const pair of this.items) {
				let key, value;
				if (identity.isPair(pair)) {
					key = toJS.toJS(pair.key, "", ctx);
					value = toJS.toJS(pair.value, key, ctx);
				} else key = toJS.toJS(pair, "", ctx);
				if (map.has(key)) throw new Error("Ordered maps must not include duplicate keys");
				map.set(key, value);
			}
			return map;
		}
		static from(schema, iterable, ctx) {
			const pairs$1 = pairs.createPairs(schema, iterable, ctx);
			const omap = new this();
			omap.items = pairs$1.items;
			return omap;
		}
	};
	YAMLOMap.tag = "tag:yaml.org,2002:omap";
	const omap = {
		collection: "seq",
		identify: (value) => value instanceof Map,
		nodeClass: YAMLOMap,
		default: false,
		tag: "tag:yaml.org,2002:omap",
		resolve(seq, onError) {
			const pairs$1 = pairs.resolvePairs(seq, onError);
			const seenKeys = [];
			for (const { key } of pairs$1.items) if (identity.isScalar(key)) {
				if (seenKeys.includes(key.value)) onError(`Ordered maps must not include duplicate keys: ${key.value}`);
				else seenKeys.push(key.value);
			}
			return Object.assign(new YAMLOMap(), pairs$1);
		},
		createNode: (schema, iterable, ctx) => YAMLOMap.from(schema, iterable, ctx)
	};
	exports.YAMLOMap = YAMLOMap;
	exports.omap = omap;
}));
//#endregion
//#region node_modules/yaml/dist/schema/yaml-1.1/bool.js
var require_bool = /* @__PURE__ */ __commonJSMin(((exports) => {
	var Scalar = require_Scalar();
	function boolStringify({ value, source }, ctx) {
		if (source && (value ? trueTag : falseTag).test.test(source)) return source;
		return value ? ctx.options.trueStr : ctx.options.falseStr;
	}
	const trueTag = {
		identify: (value) => value === true,
		default: true,
		tag: "tag:yaml.org,2002:bool",
		test: /^(?:Y|y|[Yy]es|YES|[Tt]rue|TRUE|[Oo]n|ON)$/,
		resolve: () => new Scalar.Scalar(true),
		stringify: boolStringify
	};
	const falseTag = {
		identify: (value) => value === false,
		default: true,
		tag: "tag:yaml.org,2002:bool",
		test: /^(?:N|n|[Nn]o|NO|[Ff]alse|FALSE|[Oo]ff|OFF)$/,
		resolve: () => new Scalar.Scalar(false),
		stringify: boolStringify
	};
	exports.falseTag = falseTag;
	exports.trueTag = trueTag;
}));
//#endregion
//#region node_modules/yaml/dist/schema/yaml-1.1/float.js
var require_float = /* @__PURE__ */ __commonJSMin(((exports) => {
	var Scalar = require_Scalar();
	var stringifyNumber = require_stringifyNumber();
	const floatNaN = {
		identify: (value) => typeof value === "number",
		default: true,
		tag: "tag:yaml.org,2002:float",
		test: /^(?:[-+]?\.(?:inf|Inf|INF)|\.nan|\.NaN|\.NAN)$/,
		resolve: (str) => str.slice(-3).toLowerCase() === "nan" ? NaN : str[0] === "-" ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY,
		stringify: stringifyNumber.stringifyNumber
	};
	const floatExp = {
		identify: (value) => typeof value === "number",
		default: true,
		tag: "tag:yaml.org,2002:float",
		format: "EXP",
		test: /^[-+]?(?:[0-9][0-9_]*)?(?:\.[0-9_]*)?[eE][-+]?[0-9]+$/,
		resolve: (str) => parseFloat(str.replace(/_/g, "")),
		stringify(node) {
			const num = Number(node.value);
			return isFinite(num) ? num.toExponential() : stringifyNumber.stringifyNumber(node);
		}
	};
	exports.float = {
		identify: (value) => typeof value === "number",
		default: true,
		tag: "tag:yaml.org,2002:float",
		test: /^[-+]?(?:[0-9][0-9_]*)?\.[0-9_]*$/,
		resolve(str) {
			const node = new Scalar.Scalar(parseFloat(str.replace(/_/g, "")));
			const dot = str.indexOf(".");
			if (dot !== -1) {
				const f = str.substring(dot + 1).replace(/_/g, "");
				if (f[f.length - 1] === "0") node.minFractionDigits = f.length;
			}
			return node;
		},
		stringify: stringifyNumber.stringifyNumber
	};
	exports.floatExp = floatExp;
	exports.floatNaN = floatNaN;
}));
//#endregion
//#region node_modules/yaml/dist/schema/yaml-1.1/int.js
var require_int = /* @__PURE__ */ __commonJSMin(((exports) => {
	var stringifyNumber = require_stringifyNumber();
	const intIdentify = (value) => typeof value === "bigint" || Number.isInteger(value);
	function intResolve(str, offset, radix, { intAsBigInt }) {
		const sign = str[0];
		if (sign === "-" || sign === "+") offset += 1;
		str = str.substring(offset).replace(/_/g, "");
		if (intAsBigInt) {
			switch (radix) {
				case 2:
					str = `0b${str}`;
					break;
				case 8:
					str = `0o${str}`;
					break;
				case 16: str = `0x${str}`;
			}
			const n = BigInt(str);
			return sign === "-" ? BigInt(-1) * n : n;
		}
		const n = parseInt(str, radix);
		return sign === "-" ? -1 * n : n;
	}
	function intStringify(node, radix, prefix) {
		const { value } = node;
		if (intIdentify(value)) {
			const str = value.toString(radix);
			return value < 0 ? "-" + prefix + str.substr(1) : prefix + str;
		}
		return stringifyNumber.stringifyNumber(node);
	}
	const intBin = {
		identify: intIdentify,
		default: true,
		tag: "tag:yaml.org,2002:int",
		format: "BIN",
		test: /^[-+]?0b[0-1_]+$/,
		resolve: (str, _onError, opt) => intResolve(str, 2, 2, opt),
		stringify: (node) => intStringify(node, 2, "0b")
	};
	const intOct = {
		identify: intIdentify,
		default: true,
		tag: "tag:yaml.org,2002:int",
		format: "OCT",
		test: /^[-+]?0[0-7_]+$/,
		resolve: (str, _onError, opt) => intResolve(str, 1, 8, opt),
		stringify: (node) => intStringify(node, 8, "0")
	};
	const int = {
		identify: intIdentify,
		default: true,
		tag: "tag:yaml.org,2002:int",
		test: /^[-+]?[0-9][0-9_]*$/,
		resolve: (str, _onError, opt) => intResolve(str, 0, 10, opt),
		stringify: stringifyNumber.stringifyNumber
	};
	const intHex = {
		identify: intIdentify,
		default: true,
		tag: "tag:yaml.org,2002:int",
		format: "HEX",
		test: /^[-+]?0x[0-9a-fA-F_]+$/,
		resolve: (str, _onError, opt) => intResolve(str, 2, 16, opt),
		stringify: (node) => intStringify(node, 16, "0x")
	};
	exports.int = int;
	exports.intBin = intBin;
	exports.intHex = intHex;
	exports.intOct = intOct;
}));
//#endregion
//#region node_modules/yaml/dist/schema/yaml-1.1/set.js
var require_set = /* @__PURE__ */ __commonJSMin(((exports) => {
	var identity = require_identity();
	var Pair = require_Pair();
	var YAMLMap = require_YAMLMap();
	var YAMLSet = class YAMLSet extends YAMLMap.YAMLMap {
		constructor(schema) {
			super(schema);
			this.tag = YAMLSet.tag;
		}
		add(key) {
			let pair;
			if (identity.isPair(key)) pair = key;
			else if (key && typeof key === "object" && "key" in key && "value" in key && key.value === null) pair = new Pair.Pair(key.key, null);
			else pair = new Pair.Pair(key, null);
			if (!YAMLMap.findPair(this.items, pair.key)) this.items.push(pair);
		}
		/**
		* If `keepPair` is `true`, returns the Pair matching `key`.
		* Otherwise, returns the value of that Pair's key.
		*/
		get(key, keepPair) {
			const pair = YAMLMap.findPair(this.items, key);
			return !keepPair && identity.isPair(pair) ? identity.isScalar(pair.key) ? pair.key.value : pair.key : pair;
		}
		set(key, value) {
			if (typeof value !== "boolean") throw new Error(`Expected boolean value for set(key, value) in a YAML set, not ${typeof value}`);
			const prev = YAMLMap.findPair(this.items, key);
			if (prev && !value) this.items.splice(this.items.indexOf(prev), 1);
			else if (!prev && value) this.items.push(new Pair.Pair(key));
		}
		toJSON(_, ctx) {
			return super.toJSON(_, ctx, Set);
		}
		toString(ctx, onComment, onChompKeep) {
			if (!ctx) return JSON.stringify(this);
			if (this.hasAllNullValues(true)) return super.toString(Object.assign({}, ctx, { allNullValues: true }), onComment, onChompKeep);
			else throw new Error("Set items must all have null values");
		}
		static from(schema, iterable, ctx) {
			const { replacer } = ctx;
			const set = new this(schema);
			if (iterable && Symbol.iterator in Object(iterable)) for (let value of iterable) {
				if (typeof replacer === "function") value = replacer.call(iterable, value, value);
				set.items.push(Pair.createPair(value, null, ctx));
			}
			return set;
		}
	};
	YAMLSet.tag = "tag:yaml.org,2002:set";
	const set = {
		collection: "map",
		identify: (value) => value instanceof Set,
		nodeClass: YAMLSet,
		default: false,
		tag: "tag:yaml.org,2002:set",
		createNode: (schema, iterable, ctx) => YAMLSet.from(schema, iterable, ctx),
		resolve(map, onError) {
			if (identity.isMap(map)) {
				if (map.hasAllNullValues(true)) return Object.assign(new YAMLSet(), map);
				else onError("Set items must all have null values");
			} else onError("Expected a mapping for this tag");
			return map;
		}
	};
	exports.YAMLSet = YAMLSet;
	exports.set = set;
}));
//#endregion
//#region node_modules/yaml/dist/schema/yaml-1.1/timestamp.js
var require_timestamp = /* @__PURE__ */ __commonJSMin(((exports) => {
	var stringifyNumber = require_stringifyNumber();
	/** Internal types handle bigint as number, because TS can't figure it out. */
	function parseSexagesimal(str, asBigInt) {
		const sign = str[0];
		const parts = sign === "-" || sign === "+" ? str.substring(1) : str;
		const num = (n) => asBigInt ? BigInt(n) : Number(n);
		const res = parts.replace(/_/g, "").split(":").reduce((res, p) => res * num(60) + num(p), num(0));
		return sign === "-" ? num(-1) * res : res;
	}
	/**
	* hhhh:mm:ss.sss
	*
	* Internal types handle bigint as number, because TS can't figure it out.
	*/
	function stringifySexagesimal(node) {
		let { value } = node;
		let num = (n) => n;
		if (typeof value === "bigint") num = (n) => BigInt(n);
		else if (isNaN(value) || !isFinite(value)) return stringifyNumber.stringifyNumber(node);
		let sign = "";
		if (value < 0) {
			sign = "-";
			value *= num(-1);
		}
		const _60 = num(60);
		const parts = [value % _60];
		if (value < 60) parts.unshift(0);
		else {
			value = (value - parts[0]) / _60;
			parts.unshift(value % _60);
			if (value >= 60) {
				value = (value - parts[0]) / _60;
				parts.unshift(value);
			}
		}
		return sign + parts.map((n) => String(n).padStart(2, "0")).join(":").replace(/000000\d*$/, "");
	}
	const intTime = {
		identify: (value) => typeof value === "bigint" || Number.isInteger(value),
		default: true,
		tag: "tag:yaml.org,2002:int",
		format: "TIME",
		test: /^[-+]?[0-9][0-9_]*(?::[0-5]?[0-9])+$/,
		resolve: (str, _onError, { intAsBigInt }) => parseSexagesimal(str, intAsBigInt),
		stringify: stringifySexagesimal
	};
	const floatTime = {
		identify: (value) => typeof value === "number",
		default: true,
		tag: "tag:yaml.org,2002:float",
		format: "TIME",
		test: /^[-+]?[0-9][0-9_]*(?::[0-5]?[0-9])+\.[0-9_]*$/,
		resolve: (str) => parseSexagesimal(str, false),
		stringify: stringifySexagesimal
	};
	const timestamp = {
		identify: (value) => value instanceof Date,
		default: true,
		tag: "tag:yaml.org,2002:timestamp",
		test: RegExp("^([0-9]{4})-([0-9]{1,2})-([0-9]{1,2})(?:(?:t|T|[ \\t]+)([0-9]{1,2}):([0-9]{1,2}):([0-9]{1,2}(\\.[0-9]+)?)(?:[ \\t]*(Z|[-+][012]?[0-9](?::[0-9]{2})?))?)?$"),
		resolve(str) {
			const match = str.match(timestamp.test);
			if (!match) throw new Error("!!timestamp expects a date, starting with yyyy-mm-dd");
			const [, year, month, day, hour, minute, second] = match.map(Number);
			const millisec = match[7] ? Number((match[7] + "00").substr(1, 3)) : 0;
			let date = Date.UTC(year, month - 1, day, hour || 0, minute || 0, second || 0, millisec);
			const tz = match[8];
			if (tz && tz !== "Z") {
				let d = parseSexagesimal(tz, false);
				if (Math.abs(d) < 30) d *= 60;
				date -= 6e4 * d;
			}
			return new Date(date);
		},
		stringify: ({ value }) => value?.toISOString().replace(/(T00:00:00)?\.000Z$/, "") ?? ""
	};
	exports.floatTime = floatTime;
	exports.intTime = intTime;
	exports.timestamp = timestamp;
}));
//#endregion
//#region node_modules/yaml/dist/schema/yaml-1.1/schema.js
var require_schema = /* @__PURE__ */ __commonJSMin(((exports) => {
	var map = require_map();
	var _null = require_null();
	var seq = require_seq();
	var string = require_string();
	var binary = require_binary();
	var bool = require_bool();
	var float = require_float();
	var int = require_int();
	var merge = require_merge();
	var omap = require_omap();
	var pairs = require_pairs();
	var set = require_set();
	var timestamp = require_timestamp();
	exports.schema = [
		map.map,
		seq.seq,
		string.string,
		_null.nullTag,
		bool.trueTag,
		bool.falseTag,
		int.intBin,
		int.intOct,
		int.int,
		int.intHex,
		float.floatNaN,
		float.floatExp,
		float.float,
		binary.binary,
		merge.merge,
		omap.omap,
		pairs.pairs,
		set.set,
		timestamp.intTime,
		timestamp.floatTime,
		timestamp.timestamp
	];
}));
//#endregion
//#region node_modules/yaml/dist/schema/tags.js
var require_tags = /* @__PURE__ */ __commonJSMin(((exports) => {
	var map = require_map();
	var _null = require_null();
	var seq = require_seq();
	var string = require_string();
	var bool = require_bool$1();
	var float = require_float$1();
	var int = require_int$1();
	var schema = require_schema$2();
	var schema$1 = require_schema$1();
	var binary = require_binary();
	var merge = require_merge();
	var omap = require_omap();
	var pairs = require_pairs();
	var schema$2 = require_schema();
	var set = require_set();
	var timestamp = require_timestamp();
	const schemas = /* @__PURE__ */ new Map([
		["core", schema.schema],
		["failsafe", [
			map.map,
			seq.seq,
			string.string
		]],
		["json", schema$1.schema],
		["yaml11", schema$2.schema],
		["yaml-1.1", schema$2.schema]
	]);
	const tagsByName = {
		binary: binary.binary,
		bool: bool.boolTag,
		float: float.float,
		floatExp: float.floatExp,
		floatNaN: float.floatNaN,
		floatTime: timestamp.floatTime,
		int: int.int,
		intHex: int.intHex,
		intOct: int.intOct,
		intTime: timestamp.intTime,
		map: map.map,
		merge: merge.merge,
		null: _null.nullTag,
		omap: omap.omap,
		pairs: pairs.pairs,
		seq: seq.seq,
		set: set.set,
		timestamp: timestamp.timestamp
	};
	const coreKnownTags = {
		"tag:yaml.org,2002:binary": binary.binary,
		"tag:yaml.org,2002:merge": merge.merge,
		"tag:yaml.org,2002:omap": omap.omap,
		"tag:yaml.org,2002:pairs": pairs.pairs,
		"tag:yaml.org,2002:set": set.set,
		"tag:yaml.org,2002:timestamp": timestamp.timestamp
	};
	function getTags(customTags, schemaName, addMergeTag) {
		const schemaTags = schemas.get(schemaName);
		if (schemaTags && !customTags) return addMergeTag && !schemaTags.includes(merge.merge) ? schemaTags.concat(merge.merge) : schemaTags.slice();
		let tags = schemaTags;
		if (!tags) {
			if (Array.isArray(customTags)) tags = [];
			else {
				const keys = Array.from(schemas.keys()).filter((key) => key !== "yaml11").map((key) => JSON.stringify(key)).join(", ");
				throw new Error(`Unknown schema "${schemaName}"; use one of ${keys} or define customTags array`);
			}
		}
		if (Array.isArray(customTags)) for (const tag of customTags) tags = tags.concat(tag);
		else if (typeof customTags === "function") tags = customTags(tags.slice());
		if (addMergeTag) tags = tags.concat(merge.merge);
		return tags.reduce((tags, tag) => {
			const tagObj = typeof tag === "string" ? tagsByName[tag] : tag;
			if (!tagObj) {
				const tagName = JSON.stringify(tag);
				const keys = Object.keys(tagsByName).map((key) => JSON.stringify(key)).join(", ");
				throw new Error(`Unknown custom tag ${tagName}; use one of ${keys}`);
			}
			if (!tags.includes(tagObj)) tags.push(tagObj);
			return tags;
		}, []);
	}
	exports.coreKnownTags = coreKnownTags;
	exports.getTags = getTags;
}));
//#endregion
//#region node_modules/yaml/dist/schema/Schema.js
var require_Schema = /* @__PURE__ */ __commonJSMin(((exports) => {
	var identity = require_identity();
	var map = require_map();
	var seq = require_seq();
	var string = require_string();
	var tags = require_tags();
	const sortMapEntriesByKey = (a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
	exports.Schema = class Schema {
		constructor({ compat, customTags, merge, resolveKnownTags, schema, sortMapEntries, toStringDefaults }) {
			this.compat = Array.isArray(compat) ? tags.getTags(compat, "compat") : compat ? tags.getTags(null, compat) : null;
			this.name = typeof schema === "string" && schema || "core";
			this.knownTags = resolveKnownTags ? tags.coreKnownTags : {};
			this.tags = tags.getTags(customTags, this.name, merge);
			this.toStringOptions = toStringDefaults ?? null;
			Object.defineProperty(this, identity.MAP, { value: map.map });
			Object.defineProperty(this, identity.SCALAR, { value: string.string });
			Object.defineProperty(this, identity.SEQ, { value: seq.seq });
			this.sortMapEntries = typeof sortMapEntries === "function" ? sortMapEntries : sortMapEntries === true ? sortMapEntriesByKey : null;
		}
		clone() {
			const copy = Object.create(Schema.prototype, Object.getOwnPropertyDescriptors(this));
			copy.tags = this.tags.slice();
			return copy;
		}
	};
}));
//#endregion
//#region node_modules/yaml/dist/stringify/stringifyDocument.js
var require_stringifyDocument = /* @__PURE__ */ __commonJSMin(((exports) => {
	var identity = require_identity();
	var stringify = require_stringify();
	var stringifyComment = require_stringifyComment();
	function stringifyDocument(doc, options) {
		const lines = [];
		let hasDirectives = options.directives === true;
		if (options.directives !== false && doc.directives) {
			const dir = doc.directives.toString(doc);
			if (dir) {
				lines.push(dir);
				hasDirectives = true;
			} else if (doc.directives.docStart) hasDirectives = true;
		}
		if (hasDirectives) lines.push("---");
		const ctx = stringify.createStringifyContext(doc, options);
		const { commentString } = ctx.options;
		if (doc.commentBefore) {
			if (lines.length !== 1) lines.unshift("");
			const cs = commentString(doc.commentBefore);
			lines.unshift(stringifyComment.indentComment(cs, ""));
		}
		let chompKeep = false;
		let contentComment = null;
		if (doc.contents) {
			if (identity.isNode(doc.contents)) {
				if (doc.contents.spaceBefore && hasDirectives) lines.push("");
				if (doc.contents.commentBefore) {
					const cs = commentString(doc.contents.commentBefore);
					lines.push(stringifyComment.indentComment(cs, ""));
				}
				ctx.forceBlockIndent = !!doc.comment;
				contentComment = doc.contents.comment;
			}
			const onChompKeep = contentComment ? void 0 : () => chompKeep = true;
			let body = stringify.stringify(doc.contents, ctx, () => contentComment = null, onChompKeep);
			if (contentComment) body += stringifyComment.lineComment(body, "", commentString(contentComment));
			if ((body[0] === "|" || body[0] === ">") && lines[lines.length - 1] === "---") lines[lines.length - 1] = `--- ${body}`;
			else lines.push(body);
		} else lines.push(stringify.stringify(doc.contents, ctx));
		if (doc.directives?.docEnd) {
			if (doc.comment) {
				const cs = commentString(doc.comment);
				if (cs.includes("\n")) {
					lines.push("...");
					lines.push(stringifyComment.indentComment(cs, ""));
				} else lines.push(`... ${cs}`);
			} else lines.push("...");
		} else {
			let dc = doc.comment;
			if (dc && chompKeep) dc = dc.replace(/^\n+/, "");
			if (dc) {
				if ((!chompKeep || contentComment) && lines[lines.length - 1] !== "") lines.push("");
				lines.push(stringifyComment.indentComment(commentString(dc), ""));
			}
		}
		return lines.join("\n") + "\n";
	}
	exports.stringifyDocument = stringifyDocument;
}));
//#endregion
//#region node_modules/yaml/dist/doc/Document.js
var require_Document = /* @__PURE__ */ __commonJSMin(((exports) => {
	var Alias = require_Alias();
	var Collection = require_Collection();
	var identity = require_identity();
	var Pair = require_Pair();
	var toJS = require_toJS();
	var Schema = require_Schema();
	var stringifyDocument = require_stringifyDocument();
	var anchors = require_anchors();
	var applyReviver = require_applyReviver();
	var createNode = require_createNode();
	var directives = require_directives();
	var Document = class Document {
		constructor(value, replacer, options) {
			/** A comment before this Document */
			this.commentBefore = null;
			/** A comment immediately after this Document */
			this.comment = null;
			/** Errors encountered during parsing. */
			this.errors = [];
			/** Warnings encountered during parsing. */
			this.warnings = [];
			Object.defineProperty(this, identity.NODE_TYPE, { value: identity.DOC });
			let _replacer = null;
			if (typeof replacer === "function" || Array.isArray(replacer)) _replacer = replacer;
			else if (options === void 0 && replacer) {
				options = replacer;
				replacer = void 0;
			}
			const opt = Object.assign({
				intAsBigInt: false,
				keepSourceTokens: false,
				logLevel: "warn",
				prettyErrors: true,
				strict: true,
				stringKeys: false,
				uniqueKeys: true,
				version: "1.2"
			}, options);
			this.options = opt;
			let { version } = opt;
			if (options?._directives) {
				this.directives = options._directives.atDocument();
				if (this.directives.yaml.explicit) version = this.directives.yaml.version;
			} else this.directives = new directives.Directives({ version });
			this.setSchema(version, options);
			this.contents = value === void 0 ? null : this.createNode(value, _replacer, options);
		}
		/**
		* Create a deep copy of this Document and its contents.
		*
		* Custom Node values that inherit from `Object` still refer to their original instances.
		*/
		clone() {
			const copy = Object.create(Document.prototype, { [identity.NODE_TYPE]: { value: identity.DOC } });
			copy.commentBefore = this.commentBefore;
			copy.comment = this.comment;
			copy.errors = this.errors.slice();
			copy.warnings = this.warnings.slice();
			copy.options = Object.assign({}, this.options);
			if (this.directives) copy.directives = this.directives.clone();
			copy.schema = this.schema.clone();
			copy.contents = identity.isNode(this.contents) ? this.contents.clone(copy.schema) : this.contents;
			if (this.range) copy.range = this.range.slice();
			return copy;
		}
		/** Adds a value to the document. */
		add(value) {
			if (assertCollection(this.contents)) this.contents.add(value);
		}
		/** Adds a value to the document. */
		addIn(path, value) {
			if (assertCollection(this.contents)) this.contents.addIn(path, value);
		}
		/**
		* Create a new `Alias` node, ensuring that the target `node` has the required anchor.
		*
		* If `node` already has an anchor, `name` is ignored.
		* Otherwise, the `node.anchor` value will be set to `name`,
		* or if an anchor with that name is already present in the document,
		* `name` will be used as a prefix for a new unique anchor.
		* If `name` is undefined, the generated anchor will use 'a' as a prefix.
		*/
		createAlias(node, name) {
			if (!node.anchor) {
				const prev = anchors.anchorNames(this);
				node.anchor = !name || prev.has(name) ? anchors.findNewAnchor(name || "a", prev) : name;
			}
			return new Alias.Alias(node.anchor);
		}
		createNode(value, replacer, options) {
			let _replacer = void 0;
			if (typeof replacer === "function") {
				value = replacer.call({ "": value }, "", value);
				_replacer = replacer;
			} else if (Array.isArray(replacer)) {
				const keyToStr = (v) => typeof v === "number" || v instanceof String || v instanceof Number;
				const asStr = replacer.filter(keyToStr).map(String);
				if (asStr.length > 0) replacer = replacer.concat(asStr);
				_replacer = replacer;
			} else if (options === void 0 && replacer) {
				options = replacer;
				replacer = void 0;
			}
			const { aliasDuplicateObjects, anchorPrefix, flow, keepUndefined, onTagObj, tag } = options ?? {};
			const { onAnchor, setAnchors, sourceObjects } = anchors.createNodeAnchors(this, anchorPrefix || "a");
			const ctx = {
				aliasDuplicateObjects: aliasDuplicateObjects ?? true,
				keepUndefined: keepUndefined ?? false,
				onAnchor,
				onTagObj,
				replacer: _replacer,
				schema: this.schema,
				sourceObjects
			};
			const node = createNode.createNode(value, tag, ctx);
			if (flow && identity.isCollection(node)) node.flow = true;
			setAnchors();
			return node;
		}
		/**
		* Convert a key and a value into a `Pair` using the current schema,
		* recursively wrapping all values as `Scalar` or `Collection` nodes.
		*/
		createPair(key, value, options = {}) {
			const k = this.createNode(key, null, options);
			const v = this.createNode(value, null, options);
			return new Pair.Pair(k, v);
		}
		/**
		* Removes a value from the document.
		* @returns `true` if the item was found and removed.
		*/
		delete(key) {
			return assertCollection(this.contents) ? this.contents.delete(key) : false;
		}
		/**
		* Removes a value from the document.
		* @returns `true` if the item was found and removed.
		*/
		deleteIn(path) {
			if (Collection.isEmptyPath(path)) {
				if (this.contents == null) return false;
				this.contents = null;
				return true;
			}
			return assertCollection(this.contents) ? this.contents.deleteIn(path) : false;
		}
		/**
		* Returns item at `key`, or `undefined` if not found. By default unwraps
		* scalar values from their surrounding node; to disable set `keepScalar` to
		* `true` (collections are always returned intact).
		*/
		get(key, keepScalar) {
			return identity.isCollection(this.contents) ? this.contents.get(key, keepScalar) : void 0;
		}
		/**
		* Returns item at `path`, or `undefined` if not found. By default unwraps
		* scalar values from their surrounding node; to disable set `keepScalar` to
		* `true` (collections are always returned intact).
		*/
		getIn(path, keepScalar) {
			if (Collection.isEmptyPath(path)) return !keepScalar && identity.isScalar(this.contents) ? this.contents.value : this.contents;
			return identity.isCollection(this.contents) ? this.contents.getIn(path, keepScalar) : void 0;
		}
		/**
		* Checks if the document includes a value with the key `key`.
		*/
		has(key) {
			return identity.isCollection(this.contents) ? this.contents.has(key) : false;
		}
		/**
		* Checks if the document includes a value at `path`.
		*/
		hasIn(path) {
			if (Collection.isEmptyPath(path)) return this.contents !== void 0;
			return identity.isCollection(this.contents) ? this.contents.hasIn(path) : false;
		}
		/**
		* Sets a value in this document. For `!!set`, `value` needs to be a
		* boolean to add/remove the item from the set.
		*/
		set(key, value) {
			if (this.contents == null) this.contents = Collection.collectionFromPath(this.schema, [key], value);
			else if (assertCollection(this.contents)) this.contents.set(key, value);
		}
		/**
		* Sets a value in this document. For `!!set`, `value` needs to be a
		* boolean to add/remove the item from the set.
		*/
		setIn(path, value) {
			if (Collection.isEmptyPath(path)) this.contents = value;
			else if (this.contents == null) this.contents = Collection.collectionFromPath(this.schema, Array.from(path), value);
			else if (assertCollection(this.contents)) this.contents.setIn(path, value);
		}
		/**
		* Change the YAML version and schema used by the document.
		* A `null` version disables support for directives, explicit tags, anchors, and aliases.
		* It also requires the `schema` option to be given as a `Schema` instance value.
		*
		* Overrides all previously set schema options.
		*/
		setSchema(version, options = {}) {
			if (typeof version === "number") version = String(version);
			let opt;
			switch (version) {
				case "1.1":
					if (this.directives) this.directives.yaml.version = "1.1";
					else this.directives = new directives.Directives({ version: "1.1" });
					opt = {
						resolveKnownTags: false,
						schema: "yaml-1.1"
					};
					break;
				case "1.2":
				case "next":
					if (this.directives) this.directives.yaml.version = version;
					else this.directives = new directives.Directives({ version });
					opt = {
						resolveKnownTags: true,
						schema: "core"
					};
					break;
				case null:
					if (this.directives) delete this.directives;
					opt = null;
					break;
				default: {
					const sv = JSON.stringify(version);
					throw new Error(`Expected '1.1', '1.2' or null as first argument, but found: ${sv}`);
				}
			}
			if (options.schema instanceof Object) this.schema = options.schema;
			else if (opt) this.schema = new Schema.Schema(Object.assign(opt, options));
			else throw new Error(`With a null YAML version, the { schema: Schema } option is required`);
		}
		toJS({ json, jsonArg, mapAsMap, maxAliasCount, onAnchor, reviver } = {}) {
			const ctx = {
				anchors: /* @__PURE__ */ new Map(),
				doc: this,
				keep: !json,
				mapAsMap: mapAsMap === true,
				mapKeyWarned: false,
				maxAliasCount: typeof maxAliasCount === "number" ? maxAliasCount : 100
			};
			const res = toJS.toJS(this.contents, jsonArg ?? "", ctx);
			if (typeof onAnchor === "function") for (const { count, res } of ctx.anchors.values()) onAnchor(res, count);
			return typeof reviver === "function" ? applyReviver.applyReviver(reviver, { "": res }, "", res) : res;
		}
		/**
		* A JSON representation of the document `contents`.
		*
		* @param jsonArg Used by `JSON.stringify` to indicate the array index or
		*   property name.
		*/
		toJSON(jsonArg, onAnchor) {
			return this.toJS({
				json: true,
				jsonArg,
				mapAsMap: false,
				onAnchor
			});
		}
		/** A YAML representation of the document. */
		toString(options = {}) {
			if (this.errors.length > 0) throw new Error("Document with errors cannot be stringified");
			if ("indent" in options && (!Number.isInteger(options.indent) || Number(options.indent) <= 0)) {
				const s = JSON.stringify(options.indent);
				throw new Error(`"indent" option must be a positive integer, not ${s}`);
			}
			return stringifyDocument.stringifyDocument(this, options);
		}
	};
	function assertCollection(contents) {
		if (identity.isCollection(contents)) return true;
		throw new Error("Expected a YAML collection as document contents");
	}
	exports.Document = Document;
}));
//#endregion
//#region node_modules/yaml/dist/errors.js
var require_errors = /* @__PURE__ */ __commonJSMin(((exports) => {
	var YAMLError = class extends Error {
		constructor(name, pos, code, message) {
			super();
			this.name = name;
			this.code = code;
			this.message = message;
			this.pos = pos;
		}
	};
	var YAMLParseError = class extends YAMLError {
		constructor(pos, code, message) {
			super("YAMLParseError", pos, code, message);
		}
	};
	var YAMLWarning = class extends YAMLError {
		constructor(pos, code, message) {
			super("YAMLWarning", pos, code, message);
		}
	};
	const prettifyError = (src, lc) => (error) => {
		if (error.pos[0] === -1) return;
		error.linePos = error.pos.map((pos) => lc.linePos(pos));
		const { line, col } = error.linePos[0];
		error.message += ` at line ${line}, column ${col}`;
		let ci = col - 1;
		let lineStr = src.substring(lc.lineStarts[line - 1], lc.lineStarts[line]).replace(/[\n\r]+$/, "");
		if (ci >= 60 && lineStr.length > 80) {
			const trimStart = Math.min(ci - 39, lineStr.length - 79);
			lineStr = "…" + lineStr.substring(trimStart);
			ci -= trimStart - 1;
		}
		if (lineStr.length > 80) lineStr = lineStr.substring(0, 79) + "…";
		if (line > 1 && /^ *$/.test(lineStr.substring(0, ci))) {
			let prev = src.substring(lc.lineStarts[line - 2], lc.lineStarts[line - 1]);
			if (prev.length > 80) prev = prev.substring(0, 79) + "…\n";
			lineStr = prev + lineStr;
		}
		if (/[^ ]/.test(lineStr)) {
			let count = 1;
			const end = error.linePos[1];
			if (end?.line === line && end.col > col) count = Math.max(1, Math.min(end.col - col, 80 - ci));
			const pointer = " ".repeat(ci) + "^".repeat(count);
			error.message += `:\n\n${lineStr}\n${pointer}\n`;
		}
	};
	exports.YAMLError = YAMLError;
	exports.YAMLParseError = YAMLParseError;
	exports.YAMLWarning = YAMLWarning;
	exports.prettifyError = prettifyError;
}));
//#endregion
//#region node_modules/yaml/dist/compose/resolve-props.js
var require_resolve_props = /* @__PURE__ */ __commonJSMin(((exports) => {
	function resolveProps(tokens, { flow, indicator, next, offset, onError, parentIndent, startOnNewline }) {
		let spaceBefore = false;
		let atNewline = startOnNewline;
		let hasSpace = startOnNewline;
		let comment = "";
		let commentSep = "";
		let hasNewline = false;
		let reqSpace = false;
		let tab = null;
		let anchor = null;
		let tag = null;
		let newlineAfterProp = null;
		let comma = null;
		let found = null;
		let start = null;
		for (const token of tokens) {
			if (reqSpace) {
				if (token.type !== "space" && token.type !== "newline" && token.type !== "comma") onError(token.offset, "MISSING_CHAR", "Tags and anchors must be separated from the next token by white space");
				reqSpace = false;
			}
			if (tab) {
				if (atNewline && token.type !== "comment" && token.type !== "newline") onError(tab, "TAB_AS_INDENT", "Tabs are not allowed as indentation");
				tab = null;
			}
			switch (token.type) {
				case "space":
					if (!flow && (indicator !== "doc-start" || next?.type !== "flow-collection") && token.source.includes("	")) tab = token;
					hasSpace = true;
					break;
				case "comment": {
					if (!hasSpace) onError(token, "MISSING_CHAR", "Comments must be separated from other tokens by white space characters");
					const cb = token.source.substring(1) || " ";
					if (!comment) comment = cb;
					else comment += commentSep + cb;
					commentSep = "";
					atNewline = false;
					break;
				}
				case "newline":
					if (atNewline) {
						if (comment) comment += token.source;
						else if (!found || indicator !== "seq-item-ind") spaceBefore = true;
					} else commentSep += token.source;
					atNewline = true;
					hasNewline = true;
					if (anchor || tag) newlineAfterProp = token;
					hasSpace = true;
					break;
				case "anchor":
					if (anchor) onError(token, "MULTIPLE_ANCHORS", "A node can have at most one anchor");
					if (token.source.endsWith(":")) onError(token.offset + token.source.length - 1, "BAD_ALIAS", "Anchor ending in : is ambiguous", true);
					anchor = token;
					start ?? (start = token.offset);
					atNewline = false;
					hasSpace = false;
					reqSpace = true;
					break;
				case "tag":
					if (tag) onError(token, "MULTIPLE_TAGS", "A node can have at most one tag");
					tag = token;
					start ?? (start = token.offset);
					atNewline = false;
					hasSpace = false;
					reqSpace = true;
					break;
				case indicator:
					if (anchor || tag) onError(token, "BAD_PROP_ORDER", `Anchors and tags must be after the ${token.source} indicator`);
					if (found) onError(token, "UNEXPECTED_TOKEN", `Unexpected ${token.source} in ${flow ?? "collection"}`);
					found = token;
					atNewline = indicator === "seq-item-ind" || indicator === "explicit-key-ind";
					hasSpace = false;
					break;
				case "comma": if (flow) {
					if (comma) onError(token, "UNEXPECTED_TOKEN", `Unexpected , in ${flow}`);
					comma = token;
					atNewline = false;
					hasSpace = false;
					break;
				}
				default:
					onError(token, "UNEXPECTED_TOKEN", `Unexpected ${token.type} token`);
					atNewline = false;
					hasSpace = false;
			}
		}
		const last = tokens[tokens.length - 1];
		const end = last ? last.offset + last.source.length : offset;
		if (reqSpace && next && next.type !== "space" && next.type !== "newline" && next.type !== "comma" && (next.type !== "scalar" || next.source !== "")) onError(next.offset, "MISSING_CHAR", "Tags and anchors must be separated from the next token by white space");
		if (tab && (atNewline && tab.indent <= parentIndent || next?.type === "block-map" || next?.type === "block-seq")) onError(tab, "TAB_AS_INDENT", "Tabs are not allowed as indentation");
		return {
			comma,
			found,
			spaceBefore,
			comment,
			hasNewline,
			anchor,
			tag,
			newlineAfterProp,
			end,
			start: start ?? end
		};
	}
	exports.resolveProps = resolveProps;
}));
//#endregion
//#region node_modules/yaml/dist/compose/util-contains-newline.js
var require_util_contains_newline = /* @__PURE__ */ __commonJSMin(((exports) => {
	function containsNewline(key) {
		if (!key) return null;
		switch (key.type) {
			case "alias":
			case "scalar":
			case "double-quoted-scalar":
			case "single-quoted-scalar":
				if (key.source.includes("\n")) return true;
				if (key.end) {
					for (const st of key.end) if (st.type === "newline") return true;
				}
				return false;
			case "flow-collection":
				for (const it of key.items) {
					for (const st of it.start) if (st.type === "newline") return true;
					if (it.sep) {
						for (const st of it.sep) if (st.type === "newline") return true;
					}
					if (containsNewline(it.key) || containsNewline(it.value)) return true;
				}
				return false;
			default: return true;
		}
	}
	exports.containsNewline = containsNewline;
}));
//#endregion
//#region node_modules/yaml/dist/compose/util-flow-indent-check.js
var require_util_flow_indent_check = /* @__PURE__ */ __commonJSMin(((exports) => {
	var utilContainsNewline = require_util_contains_newline();
	function flowIndentCheck(indent, fc, onError) {
		if (fc?.type === "flow-collection") {
			const end = fc.end[0];
			if (end.indent === indent && (end.source === "]" || end.source === "}") && utilContainsNewline.containsNewline(fc)) onError(end, "BAD_INDENT", "Flow end indicator should be more indented than parent", true);
		}
	}
	exports.flowIndentCheck = flowIndentCheck;
}));
//#endregion
//#region node_modules/yaml/dist/compose/util-map-includes.js
var require_util_map_includes = /* @__PURE__ */ __commonJSMin(((exports) => {
	var identity = require_identity();
	function mapIncludes(ctx, items, search) {
		const { uniqueKeys } = ctx.options;
		if (uniqueKeys === false) return false;
		const isEqual = typeof uniqueKeys === "function" ? uniqueKeys : (a, b) => a === b || identity.isScalar(a) && identity.isScalar(b) && a.value === b.value;
		return items.some((pair) => isEqual(pair.key, search));
	}
	exports.mapIncludes = mapIncludes;
}));
//#endregion
//#region node_modules/yaml/dist/compose/resolve-block-map.js
var require_resolve_block_map = /* @__PURE__ */ __commonJSMin(((exports) => {
	var Pair = require_Pair();
	var YAMLMap = require_YAMLMap();
	var resolveProps = require_resolve_props();
	var utilContainsNewline = require_util_contains_newline();
	var utilFlowIndentCheck = require_util_flow_indent_check();
	var utilMapIncludes = require_util_map_includes();
	const startColMsg = "All mapping items must start at the same column";
	function resolveBlockMap({ composeNode, composeEmptyNode }, ctx, bm, onError, tag) {
		const map = new ((tag?.nodeClass) ?? YAMLMap.YAMLMap)(ctx.schema);
		if (ctx.atRoot) ctx.atRoot = false;
		let offset = bm.offset;
		let commentEnd = null;
		for (const collItem of bm.items) {
			const { start, key, sep, value } = collItem;
			const keyProps = resolveProps.resolveProps(start, {
				indicator: "explicit-key-ind",
				next: key ?? sep?.[0],
				offset,
				onError,
				parentIndent: bm.indent,
				startOnNewline: true
			});
			const implicitKey = !keyProps.found;
			if (implicitKey) {
				if (key) {
					if (key.type === "block-seq") onError(offset, "BLOCK_AS_IMPLICIT_KEY", "A block sequence may not be used as an implicit map key");
					else if ("indent" in key && key.indent !== bm.indent) onError(offset, "BAD_INDENT", startColMsg);
				}
				if (!keyProps.anchor && !keyProps.tag && !sep) {
					commentEnd = keyProps.end;
					if (keyProps.comment) {
						if (map.comment) map.comment += "\n" + keyProps.comment;
						else map.comment = keyProps.comment;
					}
					continue;
				}
				if (keyProps.newlineAfterProp || utilContainsNewline.containsNewline(key)) onError(key ?? start[start.length - 1], "MULTILINE_IMPLICIT_KEY", "Implicit keys need to be on a single line");
			} else if (keyProps.found?.indent !== bm.indent) onError(offset, "BAD_INDENT", startColMsg);
			ctx.atKey = true;
			const keyStart = keyProps.end;
			const keyNode = key ? composeNode(ctx, key, keyProps, onError) : composeEmptyNode(ctx, keyStart, start, null, keyProps, onError);
			if (ctx.schema.compat) utilFlowIndentCheck.flowIndentCheck(bm.indent, key, onError);
			ctx.atKey = false;
			if (utilMapIncludes.mapIncludes(ctx, map.items, keyNode)) onError(keyStart, "DUPLICATE_KEY", "Map keys must be unique");
			const valueProps = resolveProps.resolveProps(sep ?? [], {
				indicator: "map-value-ind",
				next: value,
				offset: keyNode.range[2],
				onError,
				parentIndent: bm.indent,
				startOnNewline: !key || key.type === "block-scalar"
			});
			offset = valueProps.end;
			if (valueProps.found) {
				if (implicitKey) {
					if (value?.type === "block-map" && !valueProps.hasNewline) onError(offset, "BLOCK_AS_IMPLICIT_KEY", "Nested mappings are not allowed in compact mappings");
					if (ctx.options.strict && keyProps.start < valueProps.found.offset - 1024) onError(keyNode.range, "KEY_OVER_1024_CHARS", "The : indicator must be at most 1024 chars after the start of an implicit block mapping key");
				}
				const valueNode = value ? composeNode(ctx, value, valueProps, onError) : composeEmptyNode(ctx, offset, sep, null, valueProps, onError);
				if (ctx.schema.compat) utilFlowIndentCheck.flowIndentCheck(bm.indent, value, onError);
				offset = valueNode.range[2];
				const pair = new Pair.Pair(keyNode, valueNode);
				if (ctx.options.keepSourceTokens) pair.srcToken = collItem;
				map.items.push(pair);
			} else {
				if (implicitKey) onError(keyNode.range, "MISSING_CHAR", "Implicit map keys need to be followed by map values");
				if (valueProps.comment) {
					if (keyNode.comment) keyNode.comment += "\n" + valueProps.comment;
					else keyNode.comment = valueProps.comment;
				}
				const pair = new Pair.Pair(keyNode);
				if (ctx.options.keepSourceTokens) pair.srcToken = collItem;
				map.items.push(pair);
			}
		}
		if (commentEnd && commentEnd < offset) onError(commentEnd, "IMPOSSIBLE", "Map comment with trailing content");
		map.range = [
			bm.offset,
			offset,
			commentEnd ?? offset
		];
		return map;
	}
	exports.resolveBlockMap = resolveBlockMap;
}));
//#endregion
//#region node_modules/yaml/dist/compose/resolve-block-seq.js
var require_resolve_block_seq = /* @__PURE__ */ __commonJSMin(((exports) => {
	var YAMLSeq = require_YAMLSeq();
	var resolveProps = require_resolve_props();
	var utilFlowIndentCheck = require_util_flow_indent_check();
	function resolveBlockSeq({ composeNode, composeEmptyNode }, ctx, bs, onError, tag) {
		const seq = new ((tag?.nodeClass) ?? YAMLSeq.YAMLSeq)(ctx.schema);
		if (ctx.atRoot) ctx.atRoot = false;
		if (ctx.atKey) ctx.atKey = false;
		let offset = bs.offset;
		let commentEnd = null;
		for (const { start, value } of bs.items) {
			const props = resolveProps.resolveProps(start, {
				indicator: "seq-item-ind",
				next: value,
				offset,
				onError,
				parentIndent: bs.indent,
				startOnNewline: true
			});
			if (!props.found) {
				if (props.anchor || props.tag || value) {
					if (value?.type === "block-seq") onError(props.end, "BAD_INDENT", "All sequence items must start at the same column");
					else onError(offset, "MISSING_CHAR", "Sequence item without - indicator");
				} else {
					commentEnd = props.end;
					if (props.comment) seq.comment = props.comment;
					continue;
				}
			}
			const node = value ? composeNode(ctx, value, props, onError) : composeEmptyNode(ctx, props.end, start, null, props, onError);
			if (ctx.schema.compat) utilFlowIndentCheck.flowIndentCheck(bs.indent, value, onError);
			offset = node.range[2];
			seq.items.push(node);
		}
		seq.range = [
			bs.offset,
			offset,
			commentEnd ?? offset
		];
		return seq;
	}
	exports.resolveBlockSeq = resolveBlockSeq;
}));
//#endregion
//#region node_modules/yaml/dist/compose/resolve-end.js
var require_resolve_end = /* @__PURE__ */ __commonJSMin(((exports) => {
	function resolveEnd(end, offset, reqSpace, onError) {
		let comment = "";
		if (end) {
			let hasSpace = false;
			let sep = "";
			for (const token of end) {
				const { source, type } = token;
				switch (type) {
					case "space":
						hasSpace = true;
						break;
					case "comment": {
						if (reqSpace && !hasSpace) onError(token, "MISSING_CHAR", "Comments must be separated from other tokens by white space characters");
						const cb = source.substring(1) || " ";
						if (!comment) comment = cb;
						else comment += sep + cb;
						sep = "";
						break;
					}
					case "newline":
						if (comment) sep += source;
						hasSpace = true;
						break;
					default: onError(token, "UNEXPECTED_TOKEN", `Unexpected ${type} at node end`);
				}
				offset += source.length;
			}
		}
		return {
			comment,
			offset
		};
	}
	exports.resolveEnd = resolveEnd;
}));
//#endregion
//#region node_modules/yaml/dist/compose/resolve-flow-collection.js
var require_resolve_flow_collection = /* @__PURE__ */ __commonJSMin(((exports) => {
	var identity = require_identity();
	var Pair = require_Pair();
	var YAMLMap = require_YAMLMap();
	var YAMLSeq = require_YAMLSeq();
	var resolveEnd = require_resolve_end();
	var resolveProps = require_resolve_props();
	var utilContainsNewline = require_util_contains_newline();
	var utilMapIncludes = require_util_map_includes();
	const blockMsg = "Block collections are not allowed within flow collections";
	const isBlock = (token) => token && (token.type === "block-map" || token.type === "block-seq");
	function resolveFlowCollection({ composeNode, composeEmptyNode }, ctx, fc, onError, tag) {
		const isMap = fc.start.source === "{";
		const fcName = isMap ? "flow map" : "flow sequence";
		const coll = new ((tag?.nodeClass) ?? (isMap ? YAMLMap.YAMLMap : YAMLSeq.YAMLSeq))(ctx.schema);
		coll.flow = true;
		const atRoot = ctx.atRoot;
		if (atRoot) ctx.atRoot = false;
		if (ctx.atKey) ctx.atKey = false;
		let offset = fc.offset + fc.start.source.length;
		for (let i = 0; i < fc.items.length; ++i) {
			const collItem = fc.items[i];
			const { start, key, sep, value } = collItem;
			const props = resolveProps.resolveProps(start, {
				flow: fcName,
				indicator: "explicit-key-ind",
				next: key ?? sep?.[0],
				offset,
				onError,
				parentIndent: fc.indent,
				startOnNewline: false
			});
			if (!props.found) {
				if (!props.anchor && !props.tag && !sep && !value) {
					if (i === 0 && props.comma) onError(props.comma, "UNEXPECTED_TOKEN", `Unexpected , in ${fcName}`);
					else if (i < fc.items.length - 1) onError(props.start, "UNEXPECTED_TOKEN", `Unexpected empty item in ${fcName}`);
					if (props.comment) {
						if (coll.comment) coll.comment += "\n" + props.comment;
						else coll.comment = props.comment;
					}
					offset = props.end;
					continue;
				}
				if (!isMap && ctx.options.strict && utilContainsNewline.containsNewline(key)) onError(key, "MULTILINE_IMPLICIT_KEY", "Implicit keys of flow sequence pairs need to be on a single line");
			}
			if (i === 0) {
				if (props.comma) onError(props.comma, "UNEXPECTED_TOKEN", `Unexpected , in ${fcName}`);
			} else {
				if (!props.comma) onError(props.start, "MISSING_CHAR", `Missing , between ${fcName} items`);
				if (props.comment) {
					let prevItemComment = "";
					loop: for (const st of start) switch (st.type) {
						case "comma":
						case "space": break;
						case "comment":
							prevItemComment = st.source.substring(1);
							break loop;
						default: break loop;
					}
					if (prevItemComment) {
						let prev = coll.items[coll.items.length - 1];
						if (identity.isPair(prev)) prev = prev.value ?? prev.key;
						if (prev.comment) prev.comment += "\n" + prevItemComment;
						else prev.comment = prevItemComment;
						props.comment = props.comment.substring(prevItemComment.length + 1);
					}
				}
			}
			if (!isMap && !sep && !props.found) {
				const valueNode = value ? composeNode(ctx, value, props, onError) : composeEmptyNode(ctx, props.end, sep, null, props, onError);
				coll.items.push(valueNode);
				offset = valueNode.range[2];
				if (isBlock(value)) onError(valueNode.range, "BLOCK_IN_FLOW", blockMsg);
			} else {
				ctx.atKey = true;
				const keyStart = props.end;
				const keyNode = key ? composeNode(ctx, key, props, onError) : composeEmptyNode(ctx, keyStart, start, null, props, onError);
				if (isBlock(key)) onError(keyNode.range, "BLOCK_IN_FLOW", blockMsg);
				ctx.atKey = false;
				const valueProps = resolveProps.resolveProps(sep ?? [], {
					flow: fcName,
					indicator: "map-value-ind",
					next: value,
					offset: keyNode.range[2],
					onError,
					parentIndent: fc.indent,
					startOnNewline: false
				});
				if (valueProps.found) {
					if (!isMap && !props.found && ctx.options.strict) {
						if (sep) for (const st of sep) {
							if (st === valueProps.found) break;
							if (st.type === "newline") {
								onError(st, "MULTILINE_IMPLICIT_KEY", "Implicit keys of flow sequence pairs need to be on a single line");
								break;
							}
						}
						if (props.start < valueProps.found.offset - 1024) onError(valueProps.found, "KEY_OVER_1024_CHARS", "The : indicator must be at most 1024 chars after the start of an implicit flow sequence key");
					}
				} else if (value) {
					if ("source" in value && value.source?.[0] === ":") onError(value, "MISSING_CHAR", `Missing space after : in ${fcName}`);
					else onError(valueProps.start, "MISSING_CHAR", `Missing , or : between ${fcName} items`);
				}
				const valueNode = value ? composeNode(ctx, value, valueProps, onError) : valueProps.found ? composeEmptyNode(ctx, valueProps.end, sep, null, valueProps, onError) : null;
				if (valueNode) {
					if (isBlock(value)) onError(valueNode.range, "BLOCK_IN_FLOW", blockMsg);
				} else if (valueProps.comment) {
					if (keyNode.comment) keyNode.comment += "\n" + valueProps.comment;
					else keyNode.comment = valueProps.comment;
				}
				const pair = new Pair.Pair(keyNode, valueNode);
				if (ctx.options.keepSourceTokens) pair.srcToken = collItem;
				if (isMap) {
					const map = coll;
					if (utilMapIncludes.mapIncludes(ctx, map.items, keyNode)) onError(keyStart, "DUPLICATE_KEY", "Map keys must be unique");
					map.items.push(pair);
				} else {
					const map = new YAMLMap.YAMLMap(ctx.schema);
					map.flow = true;
					map.items.push(pair);
					const endRange = (valueNode ?? keyNode).range;
					map.range = [
						keyNode.range[0],
						endRange[1],
						endRange[2]
					];
					coll.items.push(map);
				}
				offset = valueNode ? valueNode.range[2] : valueProps.end;
			}
		}
		const expectedEnd = isMap ? "}" : "]";
		const [ce, ...ee] = fc.end;
		let cePos = offset;
		if (ce?.source === expectedEnd) cePos = ce.offset + ce.source.length;
		else {
			const name = fcName[0].toUpperCase() + fcName.substring(1);
			const msg = atRoot ? `${name} must end with a ${expectedEnd}` : `${name} in block collection must be sufficiently indented and end with a ${expectedEnd}`;
			onError(offset, atRoot ? "MISSING_CHAR" : "BAD_INDENT", msg);
			if (ce && ce.source.length !== 1) ee.unshift(ce);
		}
		if (ee.length > 0) {
			const end = resolveEnd.resolveEnd(ee, cePos, ctx.options.strict, onError);
			if (end.comment) {
				if (coll.comment) coll.comment += "\n" + end.comment;
				else coll.comment = end.comment;
			}
			coll.range = [
				fc.offset,
				cePos,
				end.offset
			];
		} else coll.range = [
			fc.offset,
			cePos,
			cePos
		];
		return coll;
	}
	exports.resolveFlowCollection = resolveFlowCollection;
}));
//#endregion
//#region node_modules/yaml/dist/compose/compose-collection.js
var require_compose_collection = /* @__PURE__ */ __commonJSMin(((exports) => {
	var identity = require_identity();
	var Scalar = require_Scalar();
	var YAMLMap = require_YAMLMap();
	var YAMLSeq = require_YAMLSeq();
	var resolveBlockMap = require_resolve_block_map();
	var resolveBlockSeq = require_resolve_block_seq();
	var resolveFlowCollection = require_resolve_flow_collection();
	function resolveCollection(CN, ctx, token, onError, tagName, tag) {
		const coll = token.type === "block-map" ? resolveBlockMap.resolveBlockMap(CN, ctx, token, onError, tag) : token.type === "block-seq" ? resolveBlockSeq.resolveBlockSeq(CN, ctx, token, onError, tag) : resolveFlowCollection.resolveFlowCollection(CN, ctx, token, onError, tag);
		const Coll = coll.constructor;
		if (tagName === "!" || tagName === Coll.tagName) {
			coll.tag = Coll.tagName;
			return coll;
		}
		if (tagName) coll.tag = tagName;
		return coll;
	}
	function composeCollection(CN, ctx, token, props, onError) {
		const tagToken = props.tag;
		const tagName = !tagToken ? null : ctx.directives.tagName(tagToken.source, (msg) => onError(tagToken, "TAG_RESOLVE_FAILED", msg));
		if (token.type === "block-seq") {
			const { anchor, newlineAfterProp: nl } = props;
			const lastProp = anchor && tagToken ? anchor.offset > tagToken.offset ? anchor : tagToken : anchor ?? tagToken;
			if (lastProp && (!nl || nl.offset < lastProp.offset)) onError(lastProp, "MISSING_CHAR", "Missing newline after block sequence props");
		}
		const expType = token.type === "block-map" ? "map" : token.type === "block-seq" ? "seq" : token.start.source === "{" ? "map" : "seq";
		if (!tagToken || !tagName || tagName === "!" || tagName === YAMLMap.YAMLMap.tagName && expType === "map" || tagName === YAMLSeq.YAMLSeq.tagName && expType === "seq") return resolveCollection(CN, ctx, token, onError, tagName);
		let tag = ctx.schema.tags.find((t) => t.tag === tagName && t.collection === expType);
		if (!tag) {
			const kt = ctx.schema.knownTags[tagName];
			if (kt?.collection === expType) {
				ctx.schema.tags.push(Object.assign({}, kt, { default: false }));
				tag = kt;
			} else {
				if (kt) onError(tagToken, "BAD_COLLECTION_TYPE", `${kt.tag} used for ${expType} collection, but expects ${kt.collection ?? "scalar"}`, true);
				else onError(tagToken, "TAG_RESOLVE_FAILED", `Unresolved tag: ${tagName}`, true);
				return resolveCollection(CN, ctx, token, onError, tagName);
			}
		}
		const coll = resolveCollection(CN, ctx, token, onError, tagName, tag);
		const res = tag.resolve?.(coll, (msg) => onError(tagToken, "TAG_RESOLVE_FAILED", msg), ctx.options) ?? coll;
		const node = identity.isNode(res) ? res : new Scalar.Scalar(res);
		node.range = coll.range;
		node.tag = tagName;
		if (tag?.format) node.format = tag.format;
		return node;
	}
	exports.composeCollection = composeCollection;
}));
//#endregion
//#region node_modules/yaml/dist/compose/resolve-block-scalar.js
var require_resolve_block_scalar = /* @__PURE__ */ __commonJSMin(((exports) => {
	var Scalar = require_Scalar();
	function resolveBlockScalar(ctx, scalar, onError) {
		const start = scalar.offset;
		const header = parseBlockScalarHeader(scalar, ctx.options.strict, onError);
		if (!header) return {
			value: "",
			type: null,
			comment: "",
			range: [
				start,
				start,
				start
			]
		};
		const type = header.mode === ">" ? Scalar.Scalar.BLOCK_FOLDED : Scalar.Scalar.BLOCK_LITERAL;
		const lines = scalar.source ? splitLines(scalar.source) : [];
		let chompStart = lines.length;
		for (let i = lines.length - 1; i >= 0; --i) {
			const content = lines[i][1];
			if (content === "" || content === "\r") chompStart = i;
			else break;
		}
		if (chompStart === 0) {
			const value = header.chomp === "+" && lines.length > 0 ? "\n".repeat(Math.max(1, lines.length - 1)) : "";
			let end = start + header.length;
			if (scalar.source) end += scalar.source.length;
			return {
				value,
				type,
				comment: header.comment,
				range: [
					start,
					end,
					end
				]
			};
		}
		let trimIndent = scalar.indent + header.indent;
		let offset = scalar.offset + header.length;
		let contentStart = 0;
		for (let i = 0; i < chompStart; ++i) {
			const [indent, content] = lines[i];
			if (content === "" || content === "\r") {
				if (header.indent === 0 && indent.length > trimIndent) trimIndent = indent.length;
			} else {
				if (indent.length < trimIndent) onError(offset + indent.length, "MISSING_CHAR", "Block scalars with more-indented leading empty lines must use an explicit indentation indicator");
				if (header.indent === 0) trimIndent = indent.length;
				contentStart = i;
				if (trimIndent === 0 && !ctx.atRoot) onError(offset, "BAD_INDENT", "Block scalar values in collections must be indented");
				break;
			}
			offset += indent.length + content.length + 1;
		}
		for (let i = lines.length - 1; i >= chompStart; --i) if (lines[i][0].length > trimIndent) chompStart = i + 1;
		let value = "";
		let sep = "";
		let prevMoreIndented = false;
		for (let i = 0; i < contentStart; ++i) value += lines[i][0].slice(trimIndent) + "\n";
		for (let i = contentStart; i < chompStart; ++i) {
			let [indent, content] = lines[i];
			offset += indent.length + content.length + 1;
			const crlf = content[content.length - 1] === "\r";
			if (crlf) content = content.slice(0, -1);
			/* istanbul ignore if already caught in lexer */
			if (content && indent.length < trimIndent) {
				const message = `Block scalar lines must not be less indented than their ${header.indent ? "explicit indentation indicator" : "first line"}`;
				onError(offset - content.length - (crlf ? 2 : 1), "BAD_INDENT", message);
				indent = "";
			}
			if (type === Scalar.Scalar.BLOCK_LITERAL) {
				value += sep + indent.slice(trimIndent) + content;
				sep = "\n";
			} else if (indent.length > trimIndent || content[0] === "	") {
				if (sep === " ") sep = "\n";
				else if (!prevMoreIndented && sep === "\n") sep = "\n\n";
				value += sep + indent.slice(trimIndent) + content;
				sep = "\n";
				prevMoreIndented = true;
			} else if (content === "") {
				if (sep === "\n") value += "\n";
				else sep = "\n";
			} else {
				value += sep + content;
				sep = " ";
				prevMoreIndented = false;
			}
		}
		switch (header.chomp) {
			case "-": break;
			case "+":
				for (let i = chompStart; i < lines.length; ++i) value += "\n" + lines[i][0].slice(trimIndent);
				if (value[value.length - 1] !== "\n") value += "\n";
				break;
			default: value += "\n";
		}
		const end = start + header.length + scalar.source.length;
		return {
			value,
			type,
			comment: header.comment,
			range: [
				start,
				end,
				end
			]
		};
	}
	function parseBlockScalarHeader({ offset, props }, strict, onError) {
		/* istanbul ignore if should not happen */
		if (props[0].type !== "block-scalar-header") {
			onError(props[0], "IMPOSSIBLE", "Block scalar header not found");
			return null;
		}
		const { source } = props[0];
		const mode = source[0];
		let indent = 0;
		let chomp = "";
		let error = -1;
		for (let i = 1; i < source.length; ++i) {
			const ch = source[i];
			if (!chomp && (ch === "-" || ch === "+")) chomp = ch;
			else {
				const n = Number(ch);
				if (!indent && n) indent = n;
				else if (error === -1) error = offset + i;
			}
		}
		if (error !== -1) onError(error, "UNEXPECTED_TOKEN", `Block scalar header includes extra characters: ${source}`);
		let hasSpace = false;
		let comment = "";
		let length = source.length;
		for (let i = 1; i < props.length; ++i) {
			const token = props[i];
			switch (token.type) {
				case "space": hasSpace = true;
				case "newline":
					length += token.source.length;
					break;
				case "comment":
					if (strict && !hasSpace) onError(token, "MISSING_CHAR", "Comments must be separated from other tokens by white space characters");
					length += token.source.length;
					comment = token.source.substring(1);
					break;
				case "error":
					onError(token, "UNEXPECTED_TOKEN", token.message);
					length += token.source.length;
					break;
				/* istanbul ignore next should not happen */
				default: {
					onError(token, "UNEXPECTED_TOKEN", `Unexpected token in block scalar header: ${token.type}`);
					const ts = token.source;
					if (ts && typeof ts === "string") length += ts.length;
				}
			}
		}
		return {
			mode,
			indent,
			chomp,
			comment,
			length
		};
	}
	/** @returns Array of lines split up as `[indent, content]` */
	function splitLines(source) {
		const split = source.split(/\n( *)/);
		const first = split[0];
		const m = first.match(/^( *)/);
		const lines = [m?.[1] ? [m[1], first.slice(m[1].length)] : ["", first]];
		for (let i = 1; i < split.length; i += 2) lines.push([split[i], split[i + 1]]);
		return lines;
	}
	exports.resolveBlockScalar = resolveBlockScalar;
}));
//#endregion
//#region node_modules/yaml/dist/compose/resolve-flow-scalar.js
var require_resolve_flow_scalar = /* @__PURE__ */ __commonJSMin(((exports) => {
	var Scalar = require_Scalar();
	var resolveEnd = require_resolve_end();
	function resolveFlowScalar(scalar, strict, onError) {
		const { offset, type, source, end } = scalar;
		let _type;
		let value;
		const _onError = (rel, code, msg) => onError(offset + rel, code, msg);
		switch (type) {
			case "scalar":
				_type = Scalar.Scalar.PLAIN;
				value = plainValue(source, _onError);
				break;
			case "single-quoted-scalar":
				_type = Scalar.Scalar.QUOTE_SINGLE;
				value = singleQuotedValue(source, _onError);
				break;
			case "double-quoted-scalar":
				_type = Scalar.Scalar.QUOTE_DOUBLE;
				value = doubleQuotedValue(source, _onError);
				break;
			/* istanbul ignore next should not happen */
			default:
				onError(scalar, "UNEXPECTED_TOKEN", `Expected a flow scalar value, but found: ${type}`);
				return {
					value: "",
					type: null,
					comment: "",
					range: [
						offset,
						offset + source.length,
						offset + source.length
					]
				};
		}
		const valueEnd = offset + source.length;
		const re = resolveEnd.resolveEnd(end, valueEnd, strict, onError);
		return {
			value,
			type: _type,
			comment: re.comment,
			range: [
				offset,
				valueEnd,
				re.offset
			]
		};
	}
	function plainValue(source, onError) {
		let badChar = "";
		switch (source[0]) {
			/* istanbul ignore next should not happen */
			case "	":
				badChar = "a tab character";
				break;
			case ",":
				badChar = "flow indicator character ,";
				break;
			case "%":
				badChar = "directive indicator character %";
				break;
			case "|":
			case ">":
				badChar = `block scalar indicator ${source[0]}`;
				break;
			case "@":
			case "`": badChar = `reserved character ${source[0]}`;
		}
		if (badChar) onError(0, "BAD_SCALAR_START", `Plain value cannot start with ${badChar}`);
		return foldLines(source);
	}
	function singleQuotedValue(source, onError) {
		if (source[source.length - 1] !== "'" || source.length === 1) onError(source.length, "MISSING_CHAR", "Missing closing 'quote");
		return foldLines(source.slice(1, -1)).replace(/''/g, "'");
	}
	function foldLines(source) {
		/**
		* The negative lookbehind here and in the `re` RegExp is to
		* prevent causing a polynomial search time in certain cases.
		*
		* The try-catch is for Safari, which doesn't support this yet:
		* https://caniuse.com/js-regexp-lookbehind
		*/
		let first, line;
		try {
			first = new RegExp("(.*?)(?<![ 	])[ 	]*\r?\n", "sy");
			line = new RegExp("[ 	]*(.*?)(?:(?<![ 	])[ 	]*)?\r?\n", "sy");
		} catch {
			first = /(.*?)[ \t]*\r?\n/sy;
			line = /[ \t]*(.*?)[ \t]*\r?\n/sy;
		}
		let match = first.exec(source);
		if (!match) return source;
		let res = match[1];
		let sep = " ";
		let pos = first.lastIndex;
		line.lastIndex = pos;
		while (match = line.exec(source)) {
			if (match[1] === "") {
				if (sep === "\n") res += sep;
				else sep = "\n";
			} else {
				res += sep + match[1];
				sep = " ";
			}
			pos = line.lastIndex;
		}
		const last = /[ \t]*(.*)/sy;
		last.lastIndex = pos;
		match = last.exec(source);
		return res + sep + (match?.[1] ?? "");
	}
	function doubleQuotedValue(source, onError) {
		let res = "";
		for (let i = 1; i < source.length - 1; ++i) {
			const ch = source[i];
			if (ch === "\r" && source[i + 1] === "\n") continue;
			if (ch === "\n") {
				const { fold, offset } = foldNewline(source, i);
				res += fold;
				i = offset;
			} else if (ch === "\\") {
				let next = source[++i];
				const cc = escapeCodes[next];
				if (cc) res += cc;
				else if (next === "\n") {
					next = source[i + 1];
					while (next === " " || next === "	") next = source[++i + 1];
				} else if (next === "\r" && source[i + 1] === "\n") {
					next = source[++i + 1];
					while (next === " " || next === "	") next = source[++i + 1];
				} else if (next === "x" || next === "u" || next === "U") {
					const length = next === "x" ? 2 : next === "u" ? 4 : 8;
					res += parseCharCode(source, i + 1, length, onError);
					i += length;
				} else {
					const raw = source.substr(i - 1, 2);
					onError(i - 1, "BAD_DQ_ESCAPE", `Invalid escape sequence ${raw}`);
					res += raw;
				}
			} else if (ch === " " || ch === "	") {
				const wsStart = i;
				let next = source[i + 1];
				while (next === " " || next === "	") next = source[++i + 1];
				if (next !== "\n" && !(next === "\r" && source[i + 2] === "\n")) res += i > wsStart ? source.slice(wsStart, i + 1) : ch;
			} else res += ch;
		}
		if (source[source.length - 1] !== "\"" || source.length === 1) onError(source.length, "MISSING_CHAR", "Missing closing \"quote");
		return res;
	}
	/**
	* Fold a single newline into a space, multiple newlines to N - 1 newlines.
	* Presumes `source[offset] === '\n'`
	*/
	function foldNewline(source, offset) {
		let fold = "";
		let ch = source[offset + 1];
		while (ch === " " || ch === "	" || ch === "\n" || ch === "\r") {
			if (ch === "\r" && source[offset + 2] !== "\n") break;
			if (ch === "\n") fold += "\n";
			offset += 1;
			ch = source[offset + 1];
		}
		if (!fold) fold = " ";
		return {
			fold,
			offset
		};
	}
	const escapeCodes = {
		"0": "\0",
		a: "\x07",
		b: "\b",
		e: "\x1B",
		f: "\f",
		n: "\n",
		r: "\r",
		t: "	",
		v: "\v",
		N: "",
		_: "\xA0",
		L: "\u2028",
		P: "\u2029",
		" ": " ",
		"\"": "\"",
		"/": "/",
		"\\": "\\",
		"	": "	"
	};
	function parseCharCode(source, offset, length, onError) {
		const cc = source.substr(offset, length);
		const code = cc.length === length && /^[0-9a-fA-F]+$/.test(cc) ? parseInt(cc, 16) : NaN;
		try {
			return String.fromCodePoint(code);
		} catch {
			const raw = source.substr(offset - 2, length + 2);
			onError(offset - 2, "BAD_DQ_ESCAPE", `Invalid escape sequence ${raw}`);
			return raw;
		}
	}
	exports.resolveFlowScalar = resolveFlowScalar;
}));
//#endregion
//#region node_modules/yaml/dist/compose/compose-scalar.js
var require_compose_scalar = /* @__PURE__ */ __commonJSMin(((exports) => {
	var identity = require_identity();
	var Scalar = require_Scalar();
	var resolveBlockScalar = require_resolve_block_scalar();
	var resolveFlowScalar = require_resolve_flow_scalar();
	function composeScalar(ctx, token, tagToken, onError) {
		const { value, type, comment, range } = token.type === "block-scalar" ? resolveBlockScalar.resolveBlockScalar(ctx, token, onError) : resolveFlowScalar.resolveFlowScalar(token, ctx.options.strict, onError);
		const tagName = tagToken ? ctx.directives.tagName(tagToken.source, (msg) => onError(tagToken, "TAG_RESOLVE_FAILED", msg)) : null;
		let tag;
		if (ctx.options.stringKeys && ctx.atKey) tag = ctx.schema[identity.SCALAR];
		else if (tagName) tag = findScalarTagByName(ctx.schema, value, tagName, tagToken, onError);
		else if (token.type === "scalar") tag = findScalarTagByTest(ctx, value, token, onError);
		else tag = ctx.schema[identity.SCALAR];
		let scalar;
		try {
			const res = tag.resolve(value, (msg) => onError(tagToken ?? token, "TAG_RESOLVE_FAILED", msg), ctx.options);
			scalar = identity.isScalar(res) ? res : new Scalar.Scalar(res);
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			onError(tagToken ?? token, "TAG_RESOLVE_FAILED", msg);
			scalar = new Scalar.Scalar(value);
		}
		scalar.range = range;
		scalar.source = value;
		if (type) scalar.type = type;
		if (tagName) scalar.tag = tagName;
		if (tag.format) scalar.format = tag.format;
		if (comment) scalar.comment = comment;
		return scalar;
	}
	function findScalarTagByName(schema, value, tagName, tagToken, onError) {
		if (tagName === "!") return schema[identity.SCALAR];
		const matchWithTest = [];
		for (const tag of schema.tags) if (!tag.collection && tag.tag === tagName) {
			if (tag.default && tag.test) matchWithTest.push(tag);
			else return tag;
		}
		for (const tag of matchWithTest) if (tag.test?.test(value)) return tag;
		const kt = schema.knownTags[tagName];
		if (kt && !kt.collection) {
			schema.tags.push(Object.assign({}, kt, {
				default: false,
				test: void 0
			}));
			return kt;
		}
		onError(tagToken, "TAG_RESOLVE_FAILED", `Unresolved tag: ${tagName}`, tagName !== "tag:yaml.org,2002:str");
		return schema[identity.SCALAR];
	}
	function findScalarTagByTest({ atKey, directives, schema }, value, token, onError) {
		const tag = schema.tags.find((tag) => (tag.default === true || atKey && tag.default === "key") && tag.test?.test(value)) || schema[identity.SCALAR];
		if (schema.compat) {
			const compat = schema.compat.find((tag) => tag.default && tag.test?.test(value)) ?? schema[identity.SCALAR];
			if (tag.tag !== compat.tag) onError(token, "TAG_RESOLVE_FAILED", `Value may be parsed as either ${directives.tagString(tag.tag)} or ${directives.tagString(compat.tag)}`, true);
		}
		return tag;
	}
	exports.composeScalar = composeScalar;
}));
//#endregion
//#region node_modules/yaml/dist/compose/util-empty-scalar-position.js
var require_util_empty_scalar_position = /* @__PURE__ */ __commonJSMin(((exports) => {
	function emptyScalarPosition(offset, before, pos) {
		if (before) {
			pos ?? (pos = before.length);
			for (let i = pos - 1; i >= 0; --i) {
				let st = before[i];
				switch (st.type) {
					case "space":
					case "comment":
					case "newline":
						offset -= st.source.length;
						continue;
				}
				st = before[++i];
				while (st?.type === "space") {
					offset += st.source.length;
					st = before[++i];
				}
				break;
			}
		}
		return offset;
	}
	exports.emptyScalarPosition = emptyScalarPosition;
}));
//#endregion
//#region node_modules/yaml/dist/compose/compose-node.js
var require_compose_node = /* @__PURE__ */ __commonJSMin(((exports) => {
	var Alias = require_Alias();
	var identity = require_identity();
	var composeCollection = require_compose_collection();
	var composeScalar = require_compose_scalar();
	var resolveEnd = require_resolve_end();
	var utilEmptyScalarPosition = require_util_empty_scalar_position();
	const CN = {
		composeNode,
		composeEmptyNode
	};
	function composeNode(ctx, token, props, onError) {
		const atKey = ctx.atKey;
		const { spaceBefore, comment, anchor, tag } = props;
		let node;
		let isSrcToken = true;
		switch (token.type) {
			case "alias":
				node = composeAlias(ctx, token, onError);
				if (anchor || tag) onError(token, "ALIAS_PROPS", "An alias node must not specify any properties");
				break;
			case "scalar":
			case "single-quoted-scalar":
			case "double-quoted-scalar":
			case "block-scalar":
				node = composeScalar.composeScalar(ctx, token, tag, onError);
				if (anchor) node.anchor = anchor.source.substring(1);
				break;
			case "block-map":
			case "block-seq":
			case "flow-collection":
				try {
					node = composeCollection.composeCollection(CN, ctx, token, props, onError);
					if (anchor) node.anchor = anchor.source.substring(1);
				} catch (error) {
					onError(token, "RESOURCE_EXHAUSTION", error instanceof Error ? error.message : String(error));
				}
				break;
			default:
				onError(token, "UNEXPECTED_TOKEN", token.type === "error" ? token.message : `Unsupported token (type: ${token.type})`);
				isSrcToken = false;
		}
		node ?? (node = composeEmptyNode(ctx, token.offset, void 0, null, props, onError));
		if (anchor && node.anchor === "") onError(anchor, "BAD_ALIAS", "Anchor cannot be an empty string");
		if (atKey && ctx.options.stringKeys && (!identity.isScalar(node) || typeof node.value !== "string" || node.tag && node.tag !== "tag:yaml.org,2002:str")) onError(tag ?? token, "NON_STRING_KEY", "With stringKeys, all keys must be strings");
		if (spaceBefore) node.spaceBefore = true;
		if (comment) {
			if (token.type === "scalar" && token.source === "") node.comment = comment;
			else node.commentBefore = comment;
		}
		if (ctx.options.keepSourceTokens && isSrcToken) node.srcToken = token;
		return node;
	}
	function composeEmptyNode(ctx, offset, before, pos, { spaceBefore, comment, anchor, tag, end }, onError) {
		const token = {
			type: "scalar",
			offset: utilEmptyScalarPosition.emptyScalarPosition(offset, before, pos),
			indent: -1,
			source: ""
		};
		const node = composeScalar.composeScalar(ctx, token, tag, onError);
		if (anchor) {
			node.anchor = anchor.source.substring(1);
			if (node.anchor === "") onError(anchor, "BAD_ALIAS", "Anchor cannot be an empty string");
		}
		if (spaceBefore) node.spaceBefore = true;
		if (comment) {
			node.comment = comment;
			node.range[2] = end;
		}
		return node;
	}
	function composeAlias({ options }, { offset, source, end }, onError) {
		const alias = new Alias.Alias(source.substring(1));
		if (alias.source === "") onError(offset, "BAD_ALIAS", "Alias cannot be an empty string");
		if (alias.source.endsWith(":")) onError(offset + source.length - 1, "BAD_ALIAS", "Alias ending in : is ambiguous", true);
		const valueEnd = offset + source.length;
		const re = resolveEnd.resolveEnd(end, valueEnd, options.strict, onError);
		alias.range = [
			offset,
			valueEnd,
			re.offset
		];
		if (re.comment) alias.comment = re.comment;
		return alias;
	}
	exports.composeEmptyNode = composeEmptyNode;
	exports.composeNode = composeNode;
}));
//#endregion
//#region node_modules/yaml/dist/compose/compose-doc.js
var require_compose_doc = /* @__PURE__ */ __commonJSMin(((exports) => {
	var Document = require_Document();
	var composeNode = require_compose_node();
	var resolveEnd = require_resolve_end();
	var resolveProps = require_resolve_props();
	function composeDoc(options, directives, { offset, start, value, end }, onError) {
		const opts = Object.assign({ _directives: directives }, options);
		const doc = new Document.Document(void 0, opts);
		const ctx = {
			atKey: false,
			atRoot: true,
			directives: doc.directives,
			options: doc.options,
			schema: doc.schema
		};
		const props = resolveProps.resolveProps(start, {
			indicator: "doc-start",
			next: value ?? end?.[0],
			offset,
			onError,
			parentIndent: 0,
			startOnNewline: true
		});
		if (props.found) {
			doc.directives.docStart = true;
			if (value && (value.type === "block-map" || value.type === "block-seq") && !props.hasNewline) onError(props.end, "MISSING_CHAR", "Block collection cannot start on same line with directives-end marker");
		}
		doc.contents = value ? composeNode.composeNode(ctx, value, props, onError) : composeNode.composeEmptyNode(ctx, props.end, start, null, props, onError);
		const contentEnd = doc.contents.range[2];
		const re = resolveEnd.resolveEnd(end, contentEnd, false, onError);
		if (re.comment) doc.comment = re.comment;
		doc.range = [
			offset,
			contentEnd,
			re.offset
		];
		return doc;
	}
	exports.composeDoc = composeDoc;
}));
//#endregion
//#region node_modules/yaml/dist/compose/composer.js
var require_composer = /* @__PURE__ */ __commonJSMin(((exports) => {
	var node_process$1 = __require("process");
	var directives = require_directives();
	var Document = require_Document();
	var errors = require_errors();
	var identity = require_identity();
	var composeDoc = require_compose_doc();
	var resolveEnd = require_resolve_end();
	function getErrorPos(src) {
		if (typeof src === "number") return [src, src + 1];
		if (Array.isArray(src)) return src.length === 2 ? src : [src[0], src[1]];
		const { offset, source } = src;
		return [offset, offset + (typeof source === "string" ? source.length : 1)];
	}
	function parsePrelude(prelude) {
		let comment = "";
		let atComment = false;
		let afterEmptyLine = false;
		for (let i = 0; i < prelude.length; ++i) {
			const source = prelude[i];
			switch (source[0]) {
				case "#":
					comment += (comment === "" ? "" : afterEmptyLine ? "\n\n" : "\n") + (source.substring(1) || " ");
					atComment = true;
					afterEmptyLine = false;
					break;
				case "%":
					if (prelude[i + 1]?.[0] !== "#") i += 1;
					atComment = false;
					break;
				default:
					if (!atComment) afterEmptyLine = true;
					atComment = false;
			}
		}
		return {
			comment,
			afterEmptyLine
		};
	}
	/**
	* Compose a stream of CST nodes into a stream of YAML Documents.
	*
	* ```ts
	* import { Composer, Parser } from 'yaml'
	*
	* const src: string = ...
	* const tokens = new Parser().parse(src)
	* const docs = new Composer().compose(tokens)
	* ```
	*/
	var Composer = class {
		constructor(options = {}) {
			this.doc = null;
			this.atDirectives = false;
			this.prelude = [];
			this.errors = [];
			this.warnings = [];
			this.onError = (source, code, message, warning) => {
				const pos = getErrorPos(source);
				if (warning) this.warnings.push(new errors.YAMLWarning(pos, code, message));
				else this.errors.push(new errors.YAMLParseError(pos, code, message));
			};
			this.directives = new directives.Directives({ version: options.version || "1.2" });
			this.options = options;
		}
		decorate(doc, afterDoc) {
			const { comment, afterEmptyLine } = parsePrelude(this.prelude);
			if (comment) {
				const dc = doc.contents;
				if (afterDoc) doc.comment = doc.comment ? `${doc.comment}\n${comment}` : comment;
				else if (afterEmptyLine || doc.directives.docStart || !dc) doc.commentBefore = comment;
				else if (identity.isCollection(dc) && !dc.flow && dc.items.length > 0) {
					let it = dc.items[0];
					if (identity.isPair(it)) it = it.key;
					const cb = it.commentBefore;
					it.commentBefore = cb ? `${comment}\n${cb}` : comment;
				} else {
					const cb = dc.commentBefore;
					dc.commentBefore = cb ? `${comment}\n${cb}` : comment;
				}
			}
			if (afterDoc) {
				for (let i = 0; i < this.errors.length; ++i) doc.errors.push(this.errors[i]);
				for (let i = 0; i < this.warnings.length; ++i) doc.warnings.push(this.warnings[i]);
			} else {
				doc.errors = this.errors;
				doc.warnings = this.warnings;
			}
			this.prelude = [];
			this.errors = [];
			this.warnings = [];
		}
		/**
		* Current stream status information.
		*
		* Mostly useful at the end of input for an empty stream.
		*/
		streamInfo() {
			return {
				comment: parsePrelude(this.prelude).comment,
				directives: this.directives,
				errors: this.errors,
				warnings: this.warnings
			};
		}
		/**
		* Compose tokens into documents.
		*
		* @param forceDoc - If the stream contains no document, still emit a final document including any comments and directives that would be applied to a subsequent document.
		* @param endOffset - Should be set if `forceDoc` is also set, to set the document range end and to indicate errors correctly.
		*/
		*compose(tokens, forceDoc = false, endOffset = -1) {
			for (const token of tokens) yield* this.next(token);
			yield* this.end(forceDoc, endOffset);
		}
		/** Advance the composer by one CST token. */
		*next(token) {
			if (node_process$1.env.LOG_STREAM) console.dir(token, { depth: null });
			switch (token.type) {
				case "directive":
					this.directives.add(token.source, (offset, message, warning) => {
						const pos = getErrorPos(token);
						pos[0] += offset;
						this.onError(pos, "BAD_DIRECTIVE", message, warning);
					});
					this.prelude.push(token.source);
					this.atDirectives = true;
					break;
				case "document": {
					const doc = composeDoc.composeDoc(this.options, this.directives, token, this.onError);
					if (this.atDirectives && !doc.directives.docStart) this.onError(token, "MISSING_CHAR", "Missing directives-end/doc-start indicator line");
					this.decorate(doc, false);
					if (this.doc) yield this.doc;
					this.doc = doc;
					this.atDirectives = false;
					break;
				}
				case "byte-order-mark":
				case "space": break;
				case "comment":
				case "newline":
					this.prelude.push(token.source);
					break;
				case "error": {
					const msg = token.source ? `${token.message}: ${JSON.stringify(token.source)}` : token.message;
					const error = new errors.YAMLParseError(getErrorPos(token), "UNEXPECTED_TOKEN", msg);
					if (this.atDirectives || !this.doc) this.errors.push(error);
					else this.doc.errors.push(error);
					break;
				}
				case "doc-end": {
					if (!this.doc) {
						this.errors.push(new errors.YAMLParseError(getErrorPos(token), "UNEXPECTED_TOKEN", "Unexpected doc-end without preceding document"));
						break;
					}
					this.doc.directives.docEnd = true;
					const end = resolveEnd.resolveEnd(token.end, token.offset + token.source.length, this.doc.options.strict, this.onError);
					this.decorate(this.doc, true);
					if (end.comment) {
						const dc = this.doc.comment;
						this.doc.comment = dc ? `${dc}\n${end.comment}` : end.comment;
					}
					this.doc.range[2] = end.offset;
					break;
				}
				default: this.errors.push(new errors.YAMLParseError(getErrorPos(token), "UNEXPECTED_TOKEN", `Unsupported token ${token.type}`));
			}
		}
		/**
		* Call at end of input to yield any remaining document.
		*
		* @param forceDoc - If the stream contains no document, still emit a final document including any comments and directives that would be applied to a subsequent document.
		* @param endOffset - Should be set if `forceDoc` is also set, to set the document range end and to indicate errors correctly.
		*/
		*end(forceDoc = false, endOffset = -1) {
			if (this.doc) {
				this.decorate(this.doc, true);
				yield this.doc;
				this.doc = null;
			} else if (forceDoc) {
				const opts = Object.assign({ _directives: this.directives }, this.options);
				const doc = new Document.Document(void 0, opts);
				if (this.atDirectives) this.onError(endOffset, "MISSING_CHAR", "Missing directives-end indicator line");
				doc.range = [
					0,
					endOffset,
					endOffset
				];
				this.decorate(doc, false);
				yield doc;
			}
		}
	};
	exports.Composer = Composer;
}));
//#endregion
//#region node_modules/yaml/dist/parse/cst-scalar.js
var require_cst_scalar = /* @__PURE__ */ __commonJSMin(((exports) => {
	var resolveBlockScalar = require_resolve_block_scalar();
	var resolveFlowScalar = require_resolve_flow_scalar();
	var errors = require_errors();
	var stringifyString = require_stringifyString();
	function resolveAsScalar(token, strict = true, onError) {
		if (token) {
			const _onError = (pos, code, message) => {
				const offset = typeof pos === "number" ? pos : Array.isArray(pos) ? pos[0] : pos.offset;
				if (onError) onError(offset, code, message);
				else throw new errors.YAMLParseError([offset, offset + 1], code, message);
			};
			switch (token.type) {
				case "scalar":
				case "single-quoted-scalar":
				case "double-quoted-scalar": return resolveFlowScalar.resolveFlowScalar(token, strict, _onError);
				case "block-scalar": return resolveBlockScalar.resolveBlockScalar({ options: { strict } }, token, _onError);
			}
		}
		return null;
	}
	/**
	* Create a new scalar token with `value`
	*
	* Values that represent an actual string but may be parsed as a different type should use a `type` other than `'PLAIN'`,
	* as this function does not support any schema operations and won't check for such conflicts.
	*
	* @param value The string representation of the value, which will have its content properly indented.
	* @param context.end Comments and whitespace after the end of the value, or after the block scalar header. If undefined, a newline will be added.
	* @param context.implicitKey Being within an implicit key may affect the resolved type of the token's value.
	* @param context.indent The indent level of the token.
	* @param context.inFlow Is this scalar within a flow collection? This may affect the resolved type of the token's value.
	* @param context.offset The offset position of the token.
	* @param context.type The preferred type of the scalar token. If undefined, the previous type of the `token` will be used, defaulting to `'PLAIN'`.
	*/
	function createScalarToken(value, context) {
		const { implicitKey = false, indent, inFlow = false, offset = -1, type = "PLAIN" } = context;
		const source = stringifyString.stringifyString({
			type,
			value
		}, {
			implicitKey,
			indent: indent > 0 ? " ".repeat(indent) : "",
			inFlow,
			options: {
				blockQuote: true,
				lineWidth: -1
			}
		});
		const end = context.end ?? [{
			type: "newline",
			offset: -1,
			indent,
			source: "\n"
		}];
		switch (source[0]) {
			case "|":
			case ">": {
				const he = source.indexOf("\n");
				const head = source.substring(0, he);
				const body = source.substring(he + 1) + "\n";
				const props = [{
					type: "block-scalar-header",
					offset,
					indent,
					source: head
				}];
				if (!addEndtoBlockProps(props, end)) props.push({
					type: "newline",
					offset: -1,
					indent,
					source: "\n"
				});
				return {
					type: "block-scalar",
					offset,
					indent,
					props,
					source: body
				};
			}
			case "\"": return {
				type: "double-quoted-scalar",
				offset,
				indent,
				source,
				end
			};
			case "'": return {
				type: "single-quoted-scalar",
				offset,
				indent,
				source,
				end
			};
			default: return {
				type: "scalar",
				offset,
				indent,
				source,
				end
			};
		}
	}
	/**
	* Set the value of `token` to the given string `value`, overwriting any previous contents and type that it may have.
	*
	* Best efforts are made to retain any comments previously associated with the `token`,
	* though all contents within a collection's `items` will be overwritten.
	*
	* Values that represent an actual string but may be parsed as a different type should use a `type` other than `'PLAIN'`,
	* as this function does not support any schema operations and won't check for such conflicts.
	*
	* @param token Any token. If it does not include an `indent` value, the value will be stringified as if it were an implicit key.
	* @param value The string representation of the value, which will have its content properly indented.
	* @param context.afterKey In most cases, values after a key should have an additional level of indentation.
	* @param context.implicitKey Being within an implicit key may affect the resolved type of the token's value.
	* @param context.inFlow Being within a flow collection may affect the resolved type of the token's value.
	* @param context.type The preferred type of the scalar token. If undefined, the previous type of the `token` will be used, defaulting to `'PLAIN'`.
	*/
	function setScalarValue(token, value, context = {}) {
		let { afterKey = false, implicitKey = false, inFlow = false, type } = context;
		let indent = "indent" in token ? token.indent : null;
		if (afterKey && typeof indent === "number") indent += 2;
		if (!type) switch (token.type) {
			case "single-quoted-scalar":
				type = "QUOTE_SINGLE";
				break;
			case "double-quoted-scalar":
				type = "QUOTE_DOUBLE";
				break;
			case "block-scalar": {
				const header = token.props[0];
				if (header.type !== "block-scalar-header") throw new Error("Invalid block scalar header");
				type = header.source[0] === ">" ? "BLOCK_FOLDED" : "BLOCK_LITERAL";
				break;
			}
			default: type = "PLAIN";
		}
		const source = stringifyString.stringifyString({
			type,
			value
		}, {
			implicitKey: implicitKey || indent === null,
			indent: indent !== null && indent > 0 ? " ".repeat(indent) : "",
			inFlow,
			options: {
				blockQuote: true,
				lineWidth: -1
			}
		});
		switch (source[0]) {
			case "|":
			case ">":
				setBlockScalarValue(token, source);
				break;
			case "\"":
				setFlowScalarValue(token, source, "double-quoted-scalar");
				break;
			case "'":
				setFlowScalarValue(token, source, "single-quoted-scalar");
				break;
			default: setFlowScalarValue(token, source, "scalar");
		}
	}
	function setBlockScalarValue(token, source) {
		const he = source.indexOf("\n");
		const head = source.substring(0, he);
		const body = source.substring(he + 1) + "\n";
		if (token.type === "block-scalar") {
			const header = token.props[0];
			if (header.type !== "block-scalar-header") throw new Error("Invalid block scalar header");
			header.source = head;
			token.source = body;
		} else {
			const { offset } = token;
			const indent = "indent" in token ? token.indent : -1;
			const props = [{
				type: "block-scalar-header",
				offset,
				indent,
				source: head
			}];
			if (!addEndtoBlockProps(props, "end" in token ? token.end : void 0)) props.push({
				type: "newline",
				offset: -1,
				indent,
				source: "\n"
			});
			for (const key of Object.keys(token)) if (key !== "type" && key !== "offset") delete token[key];
			Object.assign(token, {
				type: "block-scalar",
				indent,
				props,
				source: body
			});
		}
	}
	/** @returns `true` if last token is a newline */
	function addEndtoBlockProps(props, end) {
		if (end) for (const st of end) switch (st.type) {
			case "space":
			case "comment":
				props.push(st);
				break;
			case "newline":
				props.push(st);
				return true;
		}
		return false;
	}
	function setFlowScalarValue(token, source, type) {
		switch (token.type) {
			case "scalar":
			case "double-quoted-scalar":
			case "single-quoted-scalar":
				token.type = type;
				token.source = source;
				break;
			case "block-scalar": {
				const end = token.props.slice(1);
				let oa = source.length;
				if (token.props[0].type === "block-scalar-header") oa -= token.props[0].source.length;
				for (const tok of end) tok.offset += oa;
				delete token.props;
				Object.assign(token, {
					type,
					source,
					end
				});
				break;
			}
			case "block-map":
			case "block-seq": {
				const nl = {
					type: "newline",
					offset: token.offset + source.length,
					indent: token.indent,
					source: "\n"
				};
				delete token.items;
				Object.assign(token, {
					type,
					source,
					end: [nl]
				});
				break;
			}
			default: {
				const indent = "indent" in token ? token.indent : -1;
				const end = "end" in token && Array.isArray(token.end) ? token.end.filter((st) => st.type === "space" || st.type === "comment" || st.type === "newline") : [];
				for (const key of Object.keys(token)) if (key !== "type" && key !== "offset") delete token[key];
				Object.assign(token, {
					type,
					indent,
					source,
					end
				});
			}
		}
	}
	exports.createScalarToken = createScalarToken;
	exports.resolveAsScalar = resolveAsScalar;
	exports.setScalarValue = setScalarValue;
}));
//#endregion
//#region node_modules/yaml/dist/parse/cst-stringify.js
var require_cst_stringify = /* @__PURE__ */ __commonJSMin(((exports) => {
	/**
	* Stringify a CST document, token, or collection item
	*
	* Fair warning: This applies no validation whatsoever, and
	* simply concatenates the sources in their logical order.
	*/
	const stringify = (cst) => "type" in cst ? stringifyToken(cst) : stringifyItem(cst);
	function stringifyToken(token) {
		switch (token.type) {
			case "block-scalar": {
				let res = "";
				for (const tok of token.props) res += stringifyToken(tok);
				return res + token.source;
			}
			case "block-map":
			case "block-seq": {
				let res = "";
				for (const item of token.items) res += stringifyItem(item);
				return res;
			}
			case "flow-collection": {
				let res = token.start.source;
				for (const item of token.items) res += stringifyItem(item);
				for (const st of token.end) res += st.source;
				return res;
			}
			case "document": {
				let res = stringifyItem(token);
				if (token.end) for (const st of token.end) res += st.source;
				return res;
			}
			default: {
				let res = token.source;
				if ("end" in token && token.end) for (const st of token.end) res += st.source;
				return res;
			}
		}
	}
	function stringifyItem({ start, key, sep, value }) {
		let res = "";
		for (const st of start) res += st.source;
		if (key) res += stringifyToken(key);
		if (sep) for (const st of sep) res += st.source;
		if (value) res += stringifyToken(value);
		return res;
	}
	exports.stringify = stringify;
}));
//#endregion
//#region node_modules/yaml/dist/parse/cst-visit.js
var require_cst_visit = /* @__PURE__ */ __commonJSMin(((exports) => {
	const BREAK = Symbol("break visit");
	const SKIP = Symbol("skip children");
	const REMOVE = Symbol("remove item");
	/**
	* Apply a visitor to a CST document or item.
	*
	* Walks through the tree (depth-first) starting from the root, calling a
	* `visitor` function with two arguments when entering each item:
	*   - `item`: The current item, which included the following members:
	*     - `start: SourceToken[]` – Source tokens before the key or value,
	*       possibly including its anchor or tag.
	*     - `key?: Token | null` – Set for pair values. May then be `null`, if
	*       the key before the `:` separator is empty.
	*     - `sep?: SourceToken[]` – Source tokens between the key and the value,
	*       which should include the `:` map value indicator if `value` is set.
	*     - `value?: Token` – The value of a sequence item, or of a map pair.
	*   - `path`: The steps from the root to the current node, as an array of
	*     `['key' | 'value', number]` tuples.
	*
	* The return value of the visitor may be used to control the traversal:
	*   - `undefined` (default): Do nothing and continue
	*   - `visit.SKIP`: Do not visit the children of this token, continue with
	*      next sibling
	*   - `visit.BREAK`: Terminate traversal completely
	*   - `visit.REMOVE`: Remove the current item, then continue with the next one
	*   - `number`: Set the index of the next step. This is useful especially if
	*     the index of the current token has changed.
	*   - `function`: Define the next visitor for this item. After the original
	*     visitor is called on item entry, next visitors are called after handling
	*     a non-empty `key` and when exiting the item.
	*/
	function visit(cst, visitor) {
		if ("type" in cst && cst.type === "document") cst = {
			start: cst.start,
			value: cst.value
		};
		_visit(Object.freeze([]), cst, visitor);
	}
	/** Terminate visit traversal completely */
	visit.BREAK = BREAK;
	/** Do not visit the children of the current item */
	visit.SKIP = SKIP;
	/** Remove the current item */
	visit.REMOVE = REMOVE;
	/** Find the item at `path` from `cst` as the root */
	visit.itemAtPath = (cst, path) => {
		let item = cst;
		for (const [field, index] of path) {
			const tok = item?.[field];
			if (tok && "items" in tok) item = tok.items[index];
			else return void 0;
		}
		return item;
	};
	/**
	* Get the immediate parent collection of the item at `path` from `cst` as the root.
	*
	* Throws an error if the collection is not found, which should never happen if the item itself exists.
	*/
	visit.parentCollection = (cst, path) => {
		const parent = visit.itemAtPath(cst, path.slice(0, -1));
		const field = path[path.length - 1][0];
		const coll = parent?.[field];
		if (coll && "items" in coll) return coll;
		throw new Error("Parent collection not found");
	};
	function _visit(path, item, visitor) {
		let ctrl = visitor(item, path);
		if (typeof ctrl === "symbol") return ctrl;
		for (const field of ["key", "value"]) {
			const token = item[field];
			if (token && "items" in token) {
				for (let i = 0; i < token.items.length; ++i) {
					const ci = _visit(Object.freeze(path.concat([[field, i]])), token.items[i], visitor);
					if (typeof ci === "number") i = ci - 1;
					else if (ci === BREAK) return BREAK;
					else if (ci === REMOVE) {
						token.items.splice(i, 1);
						i -= 1;
					}
				}
				if (typeof ctrl === "function" && field === "key") ctrl = ctrl(item, path);
			}
		}
		return typeof ctrl === "function" ? ctrl(item, path) : ctrl;
	}
	exports.visit = visit;
}));
//#endregion
//#region node_modules/yaml/dist/parse/cst.js
var require_cst = /* @__PURE__ */ __commonJSMin(((exports) => {
	var cstScalar = require_cst_scalar();
	var cstStringify = require_cst_stringify();
	var cstVisit = require_cst_visit();
	/** The byte order mark */
	const BOM = "﻿";
	/** Start of doc-mode */
	const DOCUMENT = "";
	/** Unexpected end of flow-mode */
	const FLOW_END = "";
	/** Next token is a scalar value */
	const SCALAR = "";
	/** @returns `true` if `token` is a flow or block collection */
	const isCollection = (token) => !!token && "items" in token;
	/** @returns `true` if `token` is a flow or block scalar; not an alias */
	const isScalar = (token) => !!token && (token.type === "scalar" || token.type === "single-quoted-scalar" || token.type === "double-quoted-scalar" || token.type === "block-scalar");
	/* istanbul ignore next */
	/** Get a printable representation of a lexer token */
	function prettyToken(token) {
		switch (token) {
			case BOM: return "<BOM>";
			case DOCUMENT: return "<DOC>";
			case FLOW_END: return "<FLOW_END>";
			case SCALAR: return "<SCALAR>";
			default: return JSON.stringify(token);
		}
	}
	/** Identify the type of a lexer token. May return `null` for unknown tokens. */
	function tokenType(source) {
		switch (source) {
			case BOM: return "byte-order-mark";
			case DOCUMENT: return "doc-mode";
			case FLOW_END: return "flow-error-end";
			case SCALAR: return "scalar";
			case "---": return "doc-start";
			case "...": return "doc-end";
			case "":
			case "\n":
			case "\r\n": return "newline";
			case "-": return "seq-item-ind";
			case "?": return "explicit-key-ind";
			case ":": return "map-value-ind";
			case "{": return "flow-map-start";
			case "}": return "flow-map-end";
			case "[": return "flow-seq-start";
			case "]": return "flow-seq-end";
			case ",": return "comma";
		}
		switch (source[0]) {
			case " ":
			case "	": return "space";
			case "#": return "comment";
			case "%": return "directive-line";
			case "*": return "alias";
			case "&": return "anchor";
			case "!": return "tag";
			case "'": return "single-quoted-scalar";
			case "\"": return "double-quoted-scalar";
			case "|":
			case ">": return "block-scalar-header";
		}
		return null;
	}
	exports.createScalarToken = cstScalar.createScalarToken;
	exports.resolveAsScalar = cstScalar.resolveAsScalar;
	exports.setScalarValue = cstScalar.setScalarValue;
	exports.stringify = cstStringify.stringify;
	exports.visit = cstVisit.visit;
	exports.BOM = BOM;
	exports.DOCUMENT = DOCUMENT;
	exports.FLOW_END = FLOW_END;
	exports.SCALAR = SCALAR;
	exports.isCollection = isCollection;
	exports.isScalar = isScalar;
	exports.prettyToken = prettyToken;
	exports.tokenType = tokenType;
}));
//#endregion
//#region node_modules/yaml/dist/parse/lexer.js
var require_lexer = /* @__PURE__ */ __commonJSMin(((exports) => {
	var cst = require_cst();
	function isEmpty(ch) {
		switch (ch) {
			case void 0:
			case " ":
			case "\n":
			case "\r":
			case "	": return true;
			default: return false;
		}
	}
	const hexDigits = /* @__PURE__ */ new Set("0123456789ABCDEFabcdef");
	const tagChars = /* @__PURE__ */ new Set("0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-#;/?:@&=+$_.!~*'()");
	const flowIndicatorChars = /* @__PURE__ */ new Set(",[]{}");
	const invalidAnchorChars = /* @__PURE__ */ new Set(" ,[]{}\n\r	");
	const isNotAnchorChar = (ch) => !ch || invalidAnchorChars.has(ch);
	/**
	* Splits an input string into lexical tokens, i.e. smaller strings that are
	* easily identifiable by `tokens.tokenType()`.
	*
	* Lexing starts always in a "stream" context. Incomplete input may be buffered
	* until a complete token can be emitted.
	*
	* In addition to slices of the original input, the following control characters
	* may also be emitted:
	*
	* - `\x02` (Start of Text): A document starts with the next token
	* - `\x18` (Cancel): Unexpected end of flow-mode (indicates an error)
	* - `\x1f` (Unit Separator): Next token is a scalar value
	* - `\u{FEFF}` (Byte order mark): Emitted separately outside documents
	*/
	var Lexer = class {
		constructor() {
			/**
			* Flag indicating whether the end of the current buffer marks the end of
			* all input
			*/
			this.atEnd = false;
			/**
			* Explicit indent set in block scalar header, as an offset from the current
			* minimum indent, so e.g. set to 1 from a header `|2+`. Set to -1 if not
			* explicitly set.
			*/
			this.blockScalarIndent = -1;
			/**
			* Block scalars that include a + (keep) chomping indicator in their header
			* include trailing empty lines, which are otherwise excluded from the
			* scalar's contents.
			*/
			this.blockScalarKeep = false;
			/** Current input */
			this.buffer = "";
			/**
			* Flag noting whether the map value indicator : can immediately follow this
			* node within a flow context.
			*/
			this.flowKey = false;
			/** Count of surrounding flow collection levels. */
			this.flowLevel = 0;
			/**
			* Minimum level of indentation required for next lines to be parsed as a
			* part of the current scalar value.
			*/
			this.indentNext = 0;
			/** Indentation level of the current line. */
			this.indentValue = 0;
			/** Position of the next \n character. */
			this.lineEndPos = null;
			/** Stores the state of the lexer if reaching the end of incpomplete input */
			this.next = null;
			/** A pointer to `buffer`; the current position of the lexer. */
			this.pos = 0;
		}
		/**
		* Generate YAML tokens from the `source` string. If `incomplete`,
		* a part of the last line may be left as a buffer for the next call.
		*
		* @returns A generator of lexical tokens
		*/
		*lex(source, incomplete = false) {
			if (source) {
				if (typeof source !== "string") throw TypeError("source is not a string");
				this.buffer = this.buffer ? this.buffer + source : source;
				this.lineEndPos = null;
			}
			this.atEnd = !incomplete;
			let next = this.next ?? "stream";
			while (next && (incomplete || this.hasChars(1))) next = yield* this.parseNext(next);
		}
		atLineEnd() {
			let i = this.pos;
			let ch = this.buffer[i];
			while (ch === " " || ch === "	") ch = this.buffer[++i];
			if (!ch || ch === "#" || ch === "\n") return true;
			if (ch === "\r") return this.buffer[i + 1] === "\n";
			return false;
		}
		charAt(n) {
			return this.buffer[this.pos + n];
		}
		continueScalar(offset) {
			let ch = this.buffer[offset];
			if (this.indentNext > 0) {
				let indent = 0;
				while (ch === " ") ch = this.buffer[++indent + offset];
				if (ch === "\r") {
					const next = this.buffer[indent + offset + 1];
					if (next === "\n" || !next && !this.atEnd) return offset + indent + 1;
				}
				return ch === "\n" || indent >= this.indentNext || !ch && !this.atEnd ? offset + indent : -1;
			}
			if (ch === "-" || ch === ".") {
				const dt = this.buffer.substr(offset, 3);
				if ((dt === "---" || dt === "...") && isEmpty(this.buffer[offset + 3])) return -1;
			}
			return offset;
		}
		getLine() {
			let end = this.lineEndPos;
			if (typeof end !== "number" || end !== -1 && end < this.pos) {
				end = this.buffer.indexOf("\n", this.pos);
				this.lineEndPos = end;
			}
			if (end === -1) return this.atEnd ? this.buffer.substring(this.pos) : null;
			if (this.buffer[end - 1] === "\r") end -= 1;
			return this.buffer.substring(this.pos, end);
		}
		hasChars(n) {
			return this.pos + n <= this.buffer.length;
		}
		setNext(state) {
			this.buffer = this.buffer.substring(this.pos);
			this.pos = 0;
			this.lineEndPos = null;
			this.next = state;
			return null;
		}
		peek(n) {
			return this.buffer.substr(this.pos, n);
		}
		*parseNext(next) {
			switch (next) {
				case "stream": return yield* this.parseStream();
				case "line-start": return yield* this.parseLineStart();
				case "block-start": return yield* this.parseBlockStart();
				case "doc": return yield* this.parseDocument();
				case "flow": return yield* this.parseFlowCollection();
				case "quoted-scalar": return yield* this.parseQuotedScalar();
				case "block-scalar": return yield* this.parseBlockScalar();
				case "plain-scalar": return yield* this.parsePlainScalar();
			}
		}
		*parseStream() {
			let line = this.getLine();
			if (line === null) return this.setNext("stream");
			if (line[0] === cst.BOM) {
				yield* this.pushCount(1);
				line = line.substring(1);
			}
			if (line[0] === "%") {
				let dirEnd = line.length;
				let cs = line.indexOf("#");
				while (cs !== -1) {
					const ch = line[cs - 1];
					if (ch === " " || ch === "	") {
						dirEnd = cs - 1;
						break;
					} else cs = line.indexOf("#", cs + 1);
				}
				while (true) {
					const ch = line[dirEnd - 1];
					if (ch === " " || ch === "	") dirEnd -= 1;
					else break;
				}
				const n = (yield* this.pushCount(dirEnd)) + (yield* this.pushSpaces(true));
				yield* this.pushCount(line.length - n);
				this.pushNewline();
				return "stream";
			}
			if (this.atLineEnd()) {
				const sp = yield* this.pushSpaces(true);
				yield* this.pushCount(line.length - sp);
				yield* this.pushNewline();
				return "stream";
			}
			yield cst.DOCUMENT;
			return yield* this.parseLineStart();
		}
		*parseLineStart() {
			const ch = this.charAt(0);
			if (!ch && !this.atEnd) return this.setNext("line-start");
			if (ch === "-" || ch === ".") {
				if (!this.atEnd && !this.hasChars(4)) return this.setNext("line-start");
				const s = this.peek(3);
				if ((s === "---" || s === "...") && isEmpty(this.charAt(3))) {
					yield* this.pushCount(3);
					this.indentValue = 0;
					this.indentNext = 0;
					return s === "---" ? "doc" : "stream";
				}
			}
			this.indentValue = yield* this.pushSpaces(false);
			if (this.indentNext > this.indentValue && !isEmpty(this.charAt(1))) this.indentNext = this.indentValue;
			return yield* this.parseBlockStart();
		}
		*parseBlockStart() {
			const [ch0, ch1] = this.peek(2);
			if (!ch1 && !this.atEnd) return this.setNext("block-start");
			if ((ch0 === "-" || ch0 === "?" || ch0 === ":") && isEmpty(ch1)) {
				const n = (yield* this.pushCount(1)) + (yield* this.pushSpaces(true));
				this.indentNext = this.indentValue + 1;
				this.indentValue += n;
				return "block-start";
			}
			return "doc";
		}
		*parseDocument() {
			yield* this.pushSpaces(true);
			const line = this.getLine();
			if (line === null) return this.setNext("doc");
			let n = yield* this.pushIndicators();
			switch (line[n]) {
				case "#": yield* this.pushCount(line.length - n);
				case void 0:
					yield* this.pushNewline();
					return yield* this.parseLineStart();
				case "{":
				case "[":
					yield* this.pushCount(1);
					this.flowKey = false;
					this.flowLevel = 1;
					return "flow";
				case "}":
				case "]":
					yield* this.pushCount(1);
					return "doc";
				case "*":
					yield* this.pushUntil(isNotAnchorChar);
					return "doc";
				case "\"":
				case "'": return yield* this.parseQuotedScalar();
				case "|":
				case ">":
					n += yield* this.parseBlockScalarHeader();
					n += yield* this.pushSpaces(true);
					yield* this.pushCount(line.length - n);
					yield* this.pushNewline();
					return yield* this.parseBlockScalar();
				default: return yield* this.parsePlainScalar();
			}
		}
		*parseFlowCollection() {
			let nl, sp;
			let indent = -1;
			do {
				nl = yield* this.pushNewline();
				if (nl > 0) {
					sp = yield* this.pushSpaces(false);
					this.indentValue = indent = sp;
				} else sp = 0;
				sp += yield* this.pushSpaces(true);
			} while (nl + sp > 0);
			const line = this.getLine();
			if (line === null) return this.setNext("flow");
			if (indent !== -1 && indent < this.indentNext && line[0] !== "#" || indent === 0 && (line.startsWith("---") || line.startsWith("...")) && isEmpty(line[3])) {
				if (!(indent === this.indentNext - 1 && this.flowLevel === 1 && (line[0] === "]" || line[0] === "}"))) {
					this.flowLevel = 0;
					yield cst.FLOW_END;
					return yield* this.parseLineStart();
				}
			}
			let n = 0;
			while (line[n] === ",") {
				n += yield* this.pushCount(1);
				n += yield* this.pushSpaces(true);
				this.flowKey = false;
			}
			n += yield* this.pushIndicators();
			switch (line[n]) {
				case void 0: return "flow";
				case "#":
					yield* this.pushCount(line.length - n);
					return "flow";
				case "{":
				case "[":
					yield* this.pushCount(1);
					this.flowKey = false;
					this.flowLevel += 1;
					return "flow";
				case "}":
				case "]":
					yield* this.pushCount(1);
					this.flowKey = true;
					this.flowLevel -= 1;
					return this.flowLevel ? "flow" : "doc";
				case "*":
					yield* this.pushUntil(isNotAnchorChar);
					return "flow";
				case "\"":
				case "'":
					this.flowKey = true;
					return yield* this.parseQuotedScalar();
				case ":": {
					const next = this.charAt(1);
					if (this.flowKey || isEmpty(next) || next === ",") {
						this.flowKey = false;
						yield* this.pushCount(1);
						yield* this.pushSpaces(true);
						return "flow";
					}
				}
				default:
					this.flowKey = false;
					return yield* this.parsePlainScalar();
			}
		}
		*parseQuotedScalar() {
			const quote = this.charAt(0);
			let end = this.buffer.indexOf(quote, this.pos + 1);
			if (quote === "'") while (end !== -1 && this.buffer[end + 1] === "'") end = this.buffer.indexOf("'", end + 2);
			else while (end !== -1) {
				let n = 0;
				while (this.buffer[end - 1 - n] === "\\") n += 1;
				if (n % 2 === 0) break;
				end = this.buffer.indexOf("\"", end + 1);
			}
			const qb = this.buffer.substring(0, end);
			let nl = qb.indexOf("\n", this.pos);
			if (nl !== -1) {
				while (nl !== -1) {
					const cs = this.continueScalar(nl + 1);
					if (cs === -1) break;
					nl = qb.indexOf("\n", cs);
				}
				if (nl !== -1) end = nl - (qb[nl - 1] === "\r" ? 2 : 1);
			}
			if (end === -1) {
				if (!this.atEnd) return this.setNext("quoted-scalar");
				end = this.buffer.length;
			}
			yield* this.pushToIndex(end + 1, false);
			return this.flowLevel ? "flow" : "doc";
		}
		*parseBlockScalarHeader() {
			this.blockScalarIndent = -1;
			this.blockScalarKeep = false;
			let i = this.pos;
			while (true) {
				const ch = this.buffer[++i];
				if (ch === "+") this.blockScalarKeep = true;
				else if (ch > "0" && ch <= "9") this.blockScalarIndent = Number(ch) - 1;
				else if (ch !== "-") break;
			}
			return yield* this.pushUntil((ch) => isEmpty(ch) || ch === "#");
		}
		*parseBlockScalar() {
			let nl = this.pos - 1;
			let indent = 0;
			let ch;
			loop: for (let i = this.pos; ch = this.buffer[i]; ++i) switch (ch) {
				case " ":
					indent += 1;
					break;
				case "\n":
					nl = i;
					indent = 0;
					break;
				case "\r": {
					const next = this.buffer[i + 1];
					if (!next && !this.atEnd) return this.setNext("block-scalar");
					if (next === "\n") break;
				}
				default: break loop;
			}
			if (!ch && !this.atEnd) return this.setNext("block-scalar");
			if (indent >= this.indentNext) {
				if (this.blockScalarIndent === -1) this.indentNext = indent;
				else this.indentNext = this.blockScalarIndent + (this.indentNext === 0 ? 1 : this.indentNext);
				do {
					const cs = this.continueScalar(nl + 1);
					if (cs === -1) break;
					nl = this.buffer.indexOf("\n", cs);
				} while (nl !== -1);
				if (nl === -1) {
					if (!this.atEnd) return this.setNext("block-scalar");
					nl = this.buffer.length;
				}
			}
			let i = nl + 1;
			ch = this.buffer[i];
			while (ch === " ") ch = this.buffer[++i];
			if (ch === "	") {
				while (ch === "	" || ch === " " || ch === "\r" || ch === "\n") ch = this.buffer[++i];
				nl = i - 1;
			} else if (!this.blockScalarKeep) do {
				let i = nl - 1;
				let ch = this.buffer[i];
				if (ch === "\r") ch = this.buffer[--i];
				const lastChar = i;
				while (ch === " ") ch = this.buffer[--i];
				if (ch === "\n" && i >= this.pos && i + 1 + indent > lastChar) nl = i;
				else break;
			} while (true);
			yield cst.SCALAR;
			yield* this.pushToIndex(nl + 1, true);
			return yield* this.parseLineStart();
		}
		*parsePlainScalar() {
			const inFlow = this.flowLevel > 0;
			let end = this.pos - 1;
			let i = this.pos - 1;
			let ch;
			while (ch = this.buffer[++i]) if (ch === ":") {
				const next = this.buffer[i + 1];
				if (isEmpty(next) || inFlow && flowIndicatorChars.has(next)) break;
				end = i;
			} else if (isEmpty(ch)) {
				let next = this.buffer[i + 1];
				if (ch === "\r") {
					if (next === "\n") {
						i += 1;
						ch = "\n";
						next = this.buffer[i + 1];
					} else end = i;
				}
				if (next === "#" || inFlow && flowIndicatorChars.has(next)) break;
				if (ch === "\n") {
					const cs = this.continueScalar(i + 1);
					if (cs === -1) break;
					i = Math.max(i, cs - 2);
				}
			} else {
				if (inFlow && flowIndicatorChars.has(ch)) break;
				end = i;
			}
			if (!ch && !this.atEnd) return this.setNext("plain-scalar");
			yield cst.SCALAR;
			yield* this.pushToIndex(end + 1, true);
			return inFlow ? "flow" : "doc";
		}
		*pushCount(n) {
			if (n > 0) {
				yield this.buffer.substr(this.pos, n);
				this.pos += n;
				return n;
			}
			return 0;
		}
		*pushToIndex(i, allowEmpty) {
			const s = this.buffer.slice(this.pos, i);
			if (s) {
				yield s;
				this.pos += s.length;
				return s.length;
			} else if (allowEmpty) yield "";
			return 0;
		}
		*pushIndicators() {
			let n = 0;
			loop: while (true) {
				switch (this.charAt(0)) {
					case "!":
						n += yield* this.pushTag();
						n += yield* this.pushSpaces(true);
						continue loop;
					case "&":
						n += yield* this.pushUntil(isNotAnchorChar);
						n += yield* this.pushSpaces(true);
						continue loop;
					case "-":
					case "?":
					case ":": {
						const inFlow = this.flowLevel > 0;
						const ch1 = this.charAt(1);
						if (isEmpty(ch1) || inFlow && flowIndicatorChars.has(ch1)) {
							if (!inFlow) this.indentNext = this.indentValue + 1;
							else if (this.flowKey) this.flowKey = false;
							n += yield* this.pushCount(1);
							n += yield* this.pushSpaces(true);
							continue loop;
						}
					}
				}
				break loop;
			}
			return n;
		}
		*pushTag() {
			if (this.charAt(1) === "<") {
				let i = this.pos + 2;
				let ch = this.buffer[i];
				while (!isEmpty(ch) && ch !== ">") ch = this.buffer[++i];
				return yield* this.pushToIndex(ch === ">" ? i + 1 : i, false);
			} else {
				let i = this.pos + 1;
				let ch = this.buffer[i];
				while (ch) if (tagChars.has(ch)) ch = this.buffer[++i];
				else if (ch === "%" && hexDigits.has(this.buffer[i + 1]) && hexDigits.has(this.buffer[i + 2])) ch = this.buffer[i += 3];
				else break;
				return yield* this.pushToIndex(i, false);
			}
		}
		*pushNewline() {
			const ch = this.buffer[this.pos];
			if (ch === "\n") return yield* this.pushCount(1);
			else if (ch === "\r" && this.charAt(1) === "\n") return yield* this.pushCount(2);
			else return 0;
		}
		*pushSpaces(allowTabs) {
			let i = this.pos - 1;
			let ch;
			do
				ch = this.buffer[++i];
			while (ch === " " || allowTabs && ch === "	");
			const n = i - this.pos;
			if (n > 0) {
				yield this.buffer.substr(this.pos, n);
				this.pos = i;
			}
			return n;
		}
		*pushUntil(test) {
			let i = this.pos;
			let ch = this.buffer[i];
			while (!test(ch)) ch = this.buffer[++i];
			return yield* this.pushToIndex(i, false);
		}
	};
	exports.Lexer = Lexer;
}));
//#endregion
//#region node_modules/yaml/dist/parse/line-counter.js
var require_line_counter = /* @__PURE__ */ __commonJSMin(((exports) => {
	/**
	* Tracks newlines during parsing in order to provide an efficient API for
	* determining the one-indexed `{ line, col }` position for any offset
	* within the input.
	*/
	var LineCounter = class {
		constructor() {
			this.lineStarts = [];
			/**
			* Should be called in ascending order. Otherwise, call
			* `lineCounter.lineStarts.sort()` before calling `linePos()`.
			*/
			this.addNewLine = (offset) => this.lineStarts.push(offset);
			/**
			* Performs a binary search and returns the 1-indexed { line, col }
			* position of `offset`. If `line === 0`, `addNewLine` has never been
			* called or `offset` is before the first known newline.
			*/
			this.linePos = (offset) => {
				let low = 0;
				let high = this.lineStarts.length;
				while (low < high) {
					const mid = low + high >> 1;
					if (this.lineStarts[mid] < offset) low = mid + 1;
					else high = mid;
				}
				if (this.lineStarts[low] === offset) return {
					line: low + 1,
					col: 1
				};
				if (low === 0) return {
					line: 0,
					col: offset
				};
				const start = this.lineStarts[low - 1];
				return {
					line: low,
					col: offset - start + 1
				};
			};
		}
	};
	exports.LineCounter = LineCounter;
}));
//#endregion
//#region node_modules/yaml/dist/parse/parser.js
var require_parser = /* @__PURE__ */ __commonJSMin(((exports) => {
	var node_process = __require("process");
	var cst = require_cst();
	var lexer = require_lexer();
	function includesToken(list, type) {
		for (let i = 0; i < list.length; ++i) if (list[i].type === type) return true;
		return false;
	}
	function findNonEmptyIndex(list) {
		for (let i = 0; i < list.length; ++i) switch (list[i].type) {
			case "space":
			case "comment":
			case "newline": break;
			default: return i;
		}
		return -1;
	}
	function isFlowToken(token) {
		switch (token?.type) {
			case "alias":
			case "scalar":
			case "single-quoted-scalar":
			case "double-quoted-scalar":
			case "flow-collection": return true;
			default: return false;
		}
	}
	function getPrevProps(parent) {
		switch (parent.type) {
			case "document": return parent.start;
			case "block-map": {
				const it = parent.items[parent.items.length - 1];
				return it.sep ?? it.start;
			}
			case "block-seq": return parent.items[parent.items.length - 1].start;
			/* istanbul ignore next should not happen */
			default: return [];
		}
	}
	/** Note: May modify input array */
	function getFirstKeyStartProps(prev) {
		if (prev.length === 0) return [];
		let i = prev.length;
		loop: while (--i >= 0) switch (prev[i].type) {
			case "doc-start":
			case "explicit-key-ind":
			case "map-value-ind":
			case "seq-item-ind":
			case "newline": break loop;
		}
		while (prev[++i]?.type === "space");
		return prev.splice(i, prev.length);
	}
	function arrayPushArray(target, source) {
		if (source.length < 1e5) Array.prototype.push.apply(target, source);
		else for (let i = 0; i < source.length; ++i) target.push(source[i]);
	}
	function fixFlowSeqItems(fc) {
		if (fc.start.type === "flow-seq-start") {
			for (const it of fc.items) if (it.sep && !it.value && !includesToken(it.start, "explicit-key-ind") && !includesToken(it.sep, "map-value-ind")) {
				if (it.key) it.value = it.key;
				delete it.key;
				if (isFlowToken(it.value)) {
					if (it.value.end) arrayPushArray(it.value.end, it.sep);
					else it.value.end = it.sep;
				} else arrayPushArray(it.start, it.sep);
				delete it.sep;
			}
		}
	}
	/**
	* A YAML concrete syntax tree (CST) parser
	*
	* ```ts
	* const src: string = ...
	* for (const token of new Parser().parse(src)) {
	*   // token: Token
	* }
	* ```
	*
	* To use the parser with a user-provided lexer:
	*
	* ```ts
	* function* parse(source: string, lexer: Lexer) {
	*   const parser = new Parser()
	*   for (const lexeme of lexer.lex(source))
	*     yield* parser.next(lexeme)
	*   yield* parser.end()
	* }
	*
	* const src: string = ...
	* const lexer = new Lexer()
	* for (const token of parse(src, lexer)) {
	*   // token: Token
	* }
	* ```
	*/
	var Parser = class {
		/**
		* @param onNewLine - If defined, called separately with the start position of
		*   each new line (in `parse()`, including the start of input).
		*/
		constructor(onNewLine) {
			/** If true, space and sequence indicators count as indentation */
			this.atNewLine = true;
			/** If true, next token is a scalar value */
			this.atScalar = false;
			/** Current indentation level */
			this.indent = 0;
			/** Current offset since the start of parsing */
			this.offset = 0;
			/** On the same line with a block map key */
			this.onKeyLine = false;
			/** Top indicates the node that's currently being built */
			this.stack = [];
			/** The source of the current token, set in parse() */
			this.source = "";
			/** The type of the current token, set in parse() */
			this.type = "";
			this.lexer = new lexer.Lexer();
			this.onNewLine = onNewLine;
		}
		/**
		* Parse `source` as a YAML stream.
		* If `incomplete`, a part of the last line may be left as a buffer for the next call.
		*
		* Errors are not thrown, but yielded as `{ type: 'error', message }` tokens.
		*
		* @returns A generator of tokens representing each directive, document, and other structure.
		*/
		*parse(source, incomplete = false) {
			if (this.onNewLine && this.offset === 0) this.onNewLine(0);
			for (const lexeme of this.lexer.lex(source, incomplete)) yield* this.next(lexeme);
			if (!incomplete) yield* this.end();
		}
		/**
		* Advance the parser by the `source` of one lexical token.
		*/
		*next(source) {
			this.source = source;
			if (node_process.env.LOG_TOKENS) console.log("|", cst.prettyToken(source));
			if (this.atScalar) {
				this.atScalar = false;
				yield* this.step();
				this.offset += source.length;
				return;
			}
			const type = cst.tokenType(source);
			if (!type) {
				const message = `Not a YAML token: ${source}`;
				yield* this.pop({
					type: "error",
					offset: this.offset,
					message,
					source
				});
				this.offset += source.length;
			} else if (type === "scalar") {
				this.atNewLine = false;
				this.atScalar = true;
				this.type = "scalar";
			} else {
				this.type = type;
				yield* this.step();
				switch (type) {
					case "newline":
						this.atNewLine = true;
						this.indent = 0;
						if (this.onNewLine) this.onNewLine(this.offset + source.length);
						break;
					case "space":
						if (this.atNewLine && source[0] === " ") this.indent += source.length;
						break;
					case "explicit-key-ind":
					case "map-value-ind":
					case "seq-item-ind":
						if (this.atNewLine) this.indent += source.length;
						break;
					case "doc-mode":
					case "flow-error-end": return;
					default: this.atNewLine = false;
				}
				this.offset += source.length;
			}
		}
		/** Call at end of input to push out any remaining constructions */
		*end() {
			while (this.stack.length > 0) yield* this.pop();
		}
		get sourceToken() {
			return {
				type: this.type,
				offset: this.offset,
				indent: this.indent,
				source: this.source
			};
		}
		*step() {
			const top = this.peek(1);
			if (this.type === "doc-end" && top?.type !== "doc-end") {
				while (this.stack.length > 0) yield* this.pop();
				this.stack.push({
					type: "doc-end",
					offset: this.offset,
					source: this.source
				});
				return;
			}
			if (!top) return yield* this.stream();
			switch (top.type) {
				case "document": return yield* this.document(top);
				case "alias":
				case "scalar":
				case "single-quoted-scalar":
				case "double-quoted-scalar": return yield* this.scalar(top);
				case "block-scalar": return yield* this.blockScalar(top);
				case "block-map": return yield* this.blockMap(top);
				case "block-seq": return yield* this.blockSequence(top);
				case "flow-collection": return yield* this.flowCollection(top);
				case "doc-end": return yield* this.documentEnd(top);
			}
			/* istanbul ignore next should not happen */
			yield* this.pop();
		}
		peek(n) {
			return this.stack[this.stack.length - n];
		}
		*pop(error) {
			const token = error ?? this.stack.pop();
			/* istanbul ignore if should not happen */
			if (!token) yield {
				type: "error",
				offset: this.offset,
				source: "",
				message: "Tried to pop an empty stack"
			};
			else if (this.stack.length === 0) yield token;
			else {
				const top = this.peek(1);
				if (token.type === "block-scalar") token.indent = "indent" in top ? top.indent : 0;
				else if (token.type === "flow-collection" && top.type === "document") token.indent = 0;
				if (token.type === "flow-collection") fixFlowSeqItems(token);
				switch (top.type) {
					case "document":
						top.value = token;
						break;
					case "block-scalar":
						top.props.push(token);
						break;
					case "block-map": {
						const it = top.items[top.items.length - 1];
						if (it.value) {
							top.items.push({
								start: [],
								key: token,
								sep: []
							});
							this.onKeyLine = true;
							return;
						} else if (it.sep) it.value = token;
						else {
							Object.assign(it, {
								key: token,
								sep: []
							});
							this.onKeyLine = !it.explicitKey;
							return;
						}
						break;
					}
					case "block-seq": {
						const it = top.items[top.items.length - 1];
						if (it.value) top.items.push({
							start: [],
							value: token
						});
						else it.value = token;
						break;
					}
					case "flow-collection": {
						const it = top.items[top.items.length - 1];
						if (!it || it.value) top.items.push({
							start: [],
							key: token,
							sep: []
						});
						else if (it.sep) it.value = token;
						else Object.assign(it, {
							key: token,
							sep: []
						});
						return;
					}
					/* istanbul ignore next should not happen */
					default:
						yield* this.pop();
						yield* this.pop(token);
				}
				if ((top.type === "document" || top.type === "block-map" || top.type === "block-seq") && (token.type === "block-map" || token.type === "block-seq")) {
					const last = token.items[token.items.length - 1];
					if (last && !last.sep && !last.value && last.start.length > 0 && findNonEmptyIndex(last.start) === -1 && (token.indent === 0 || last.start.every((st) => st.type !== "comment" || st.indent < token.indent))) {
						if (top.type === "document") top.end = last.start;
						else top.items.push({ start: last.start });
						token.items.splice(-1, 1);
					}
				}
			}
		}
		*stream() {
			switch (this.type) {
				case "directive-line":
					yield {
						type: "directive",
						offset: this.offset,
						source: this.source
					};
					return;
				case "byte-order-mark":
				case "space":
				case "comment":
				case "newline":
					yield this.sourceToken;
					return;
				case "doc-mode":
				case "doc-start": {
					const doc = {
						type: "document",
						offset: this.offset,
						start: []
					};
					if (this.type === "doc-start") doc.start.push(this.sourceToken);
					this.stack.push(doc);
					return;
				}
			}
			yield {
				type: "error",
				offset: this.offset,
				message: `Unexpected ${this.type} token in YAML stream`,
				source: this.source
			};
		}
		*document(doc) {
			if (doc.value) return yield* this.lineEnd(doc);
			switch (this.type) {
				case "doc-start":
					if (findNonEmptyIndex(doc.start) !== -1) {
						yield* this.pop();
						yield* this.step();
					} else doc.start.push(this.sourceToken);
					return;
				case "anchor":
				case "tag":
				case "space":
				case "comment":
				case "newline":
					doc.start.push(this.sourceToken);
					return;
			}
			const bv = this.startBlockValue(doc);
			if (bv) this.stack.push(bv);
			else yield {
				type: "error",
				offset: this.offset,
				message: `Unexpected ${this.type} token in YAML document`,
				source: this.source
			};
		}
		*scalar(scalar) {
			if (this.type === "map-value-ind") {
				const start = getFirstKeyStartProps(getPrevProps(this.peek(2)));
				let sep;
				if (scalar.end) {
					sep = scalar.end;
					sep.push(this.sourceToken);
					delete scalar.end;
				} else sep = [this.sourceToken];
				const map = {
					type: "block-map",
					offset: scalar.offset,
					indent: scalar.indent,
					items: [{
						start,
						key: scalar,
						sep
					}]
				};
				this.onKeyLine = true;
				this.stack[this.stack.length - 1] = map;
			} else yield* this.lineEnd(scalar);
		}
		*blockScalar(scalar) {
			switch (this.type) {
				case "space":
				case "comment":
				case "newline":
					scalar.props.push(this.sourceToken);
					return;
				case "scalar":
					scalar.source = this.source;
					this.atNewLine = true;
					this.indent = 0;
					if (this.onNewLine) {
						let nl = this.source.indexOf("\n") + 1;
						while (nl !== 0) {
							this.onNewLine(this.offset + nl);
							nl = this.source.indexOf("\n", nl) + 1;
						}
					}
					yield* this.pop();
					break;
				/* istanbul ignore next should not happen */
				default:
					yield* this.pop();
					yield* this.step();
			}
		}
		*blockMap(map) {
			const it = map.items[map.items.length - 1];
			switch (this.type) {
				case "newline":
					this.onKeyLine = false;
					if (it.value) {
						const end = "end" in it.value ? it.value.end : void 0;
						if ((Array.isArray(end) ? end[end.length - 1] : void 0)?.type === "comment") end?.push(this.sourceToken);
						else map.items.push({ start: [this.sourceToken] });
					} else if (it.sep) it.sep.push(this.sourceToken);
					else it.start.push(this.sourceToken);
					return;
				case "space":
				case "comment":
					if (it.value) map.items.push({ start: [this.sourceToken] });
					else if (it.sep) it.sep.push(this.sourceToken);
					else {
						if (this.atIndentedComment(it.start, map.indent)) {
							const end = map.items[map.items.length - 2]?.value?.end;
							if (Array.isArray(end)) {
								arrayPushArray(end, it.start);
								end.push(this.sourceToken);
								map.items.pop();
								return;
							}
						}
						it.start.push(this.sourceToken);
					}
					return;
			}
			if (this.indent >= map.indent) {
				const atMapIndent = !this.onKeyLine && this.indent === map.indent;
				const atNextItem = atMapIndent && (it.sep || it.explicitKey) && this.type !== "seq-item-ind";
				let start = [];
				if (atNextItem && it.sep && !it.value) {
					const nl = [];
					for (let i = 0; i < it.sep.length; ++i) {
						const st = it.sep[i];
						switch (st.type) {
							case "newline":
								nl.push(i);
								break;
							case "space": break;
							case "comment":
								if (st.indent > map.indent) nl.length = 0;
								break;
							default: nl.length = 0;
						}
					}
					if (nl.length >= 2) start = it.sep.splice(nl[1]);
				}
				switch (this.type) {
					case "anchor":
					case "tag":
						if (atNextItem || it.value) {
							start.push(this.sourceToken);
							map.items.push({ start });
							this.onKeyLine = true;
						} else if (it.sep) it.sep.push(this.sourceToken);
						else it.start.push(this.sourceToken);
						return;
					case "explicit-key-ind":
						if (!it.sep && !it.explicitKey) {
							it.start.push(this.sourceToken);
							it.explicitKey = true;
						} else if (atNextItem || it.value) {
							start.push(this.sourceToken);
							map.items.push({
								start,
								explicitKey: true
							});
						} else this.stack.push({
							type: "block-map",
							offset: this.offset,
							indent: this.indent,
							items: [{
								start: [this.sourceToken],
								explicitKey: true
							}]
						});
						this.onKeyLine = true;
						return;
					case "map-value-ind":
						if (it.explicitKey) {
							if (!it.sep) {
								if (includesToken(it.start, "newline")) Object.assign(it, {
									key: null,
									sep: [this.sourceToken]
								});
								else {
									const start = getFirstKeyStartProps(it.start);
									this.stack.push({
										type: "block-map",
										offset: this.offset,
										indent: this.indent,
										items: [{
											start,
											key: null,
											sep: [this.sourceToken]
										}]
									});
								}
							} else if (it.value) map.items.push({
								start: [],
								key: null,
								sep: [this.sourceToken]
							});
							else if (includesToken(it.sep, "map-value-ind")) this.stack.push({
								type: "block-map",
								offset: this.offset,
								indent: this.indent,
								items: [{
									start,
									key: null,
									sep: [this.sourceToken]
								}]
							});
							else if (isFlowToken(it.key) && !includesToken(it.sep, "newline")) {
								const start = getFirstKeyStartProps(it.start);
								const key = it.key;
								const sep = it.sep;
								sep.push(this.sourceToken);
								delete it.key;
								delete it.sep;
								this.stack.push({
									type: "block-map",
									offset: this.offset,
									indent: this.indent,
									items: [{
										start,
										key,
										sep
									}]
								});
							} else if (start.length > 0) it.sep = it.sep.concat(start, this.sourceToken);
							else it.sep.push(this.sourceToken);
						} else if (!it.sep) Object.assign(it, {
							key: null,
							sep: [this.sourceToken]
						});
						else if (it.value || atNextItem) map.items.push({
							start,
							key: null,
							sep: [this.sourceToken]
						});
						else if (includesToken(it.sep, "map-value-ind")) this.stack.push({
							type: "block-map",
							offset: this.offset,
							indent: this.indent,
							items: [{
								start: [],
								key: null,
								sep: [this.sourceToken]
							}]
						});
						else it.sep.push(this.sourceToken);
						this.onKeyLine = true;
						return;
					case "alias":
					case "scalar":
					case "single-quoted-scalar":
					case "double-quoted-scalar": {
						const fs = this.flowScalar(this.type);
						if (atNextItem || it.value) {
							map.items.push({
								start,
								key: fs,
								sep: []
							});
							this.onKeyLine = true;
						} else if (it.sep) this.stack.push(fs);
						else {
							Object.assign(it, {
								key: fs,
								sep: []
							});
							this.onKeyLine = true;
						}
						return;
					}
					default: {
						const bv = this.startBlockValue(map);
						if (bv) {
							if (bv.type === "block-seq") {
								if (!it.explicitKey && it.sep && !includesToken(it.sep, "newline")) {
									yield* this.pop({
										type: "error",
										offset: this.offset,
										message: "Unexpected block-seq-ind on same line with key",
										source: this.source
									});
									return;
								}
							} else if (atMapIndent) map.items.push({ start });
							this.stack.push(bv);
							return;
						}
					}
				}
			}
			yield* this.pop();
			yield* this.step();
		}
		*blockSequence(seq) {
			const it = seq.items[seq.items.length - 1];
			switch (this.type) {
				case "newline":
					if (it.value) {
						const end = "end" in it.value ? it.value.end : void 0;
						if ((Array.isArray(end) ? end[end.length - 1] : void 0)?.type === "comment") end?.push(this.sourceToken);
						else seq.items.push({ start: [this.sourceToken] });
					} else it.start.push(this.sourceToken);
					return;
				case "space":
				case "comment":
					if (it.value) seq.items.push({ start: [this.sourceToken] });
					else {
						if (this.atIndentedComment(it.start, seq.indent)) {
							const end = seq.items[seq.items.length - 2]?.value?.end;
							if (Array.isArray(end)) {
								arrayPushArray(end, it.start);
								end.push(this.sourceToken);
								seq.items.pop();
								return;
							}
						}
						it.start.push(this.sourceToken);
					}
					return;
				case "anchor":
				case "tag":
					if (it.value || this.indent <= seq.indent) break;
					it.start.push(this.sourceToken);
					return;
				case "seq-item-ind":
					if (this.indent !== seq.indent) break;
					if (it.value || includesToken(it.start, "seq-item-ind")) seq.items.push({ start: [this.sourceToken] });
					else it.start.push(this.sourceToken);
					return;
			}
			if (this.indent > seq.indent) {
				const bv = this.startBlockValue(seq);
				if (bv) {
					this.stack.push(bv);
					return;
				}
			}
			yield* this.pop();
			yield* this.step();
		}
		*flowCollection(fc) {
			const it = fc.items[fc.items.length - 1];
			if (this.type === "flow-error-end") {
				let top;
				do {
					yield* this.pop();
					top = this.peek(1);
				} while (top?.type === "flow-collection");
			} else if (fc.end.length === 0) {
				switch (this.type) {
					case "comma":
					case "explicit-key-ind":
						if (!it || it.sep) fc.items.push({ start: [this.sourceToken] });
						else it.start.push(this.sourceToken);
						return;
					case "map-value-ind":
						if (!it || it.value) fc.items.push({
							start: [],
							key: null,
							sep: [this.sourceToken]
						});
						else if (it.sep) it.sep.push(this.sourceToken);
						else Object.assign(it, {
							key: null,
							sep: [this.sourceToken]
						});
						return;
					case "space":
					case "comment":
					case "newline":
					case "anchor":
					case "tag":
						if (!it || it.value) fc.items.push({ start: [this.sourceToken] });
						else if (it.sep) it.sep.push(this.sourceToken);
						else it.start.push(this.sourceToken);
						return;
					case "alias":
					case "scalar":
					case "single-quoted-scalar":
					case "double-quoted-scalar": {
						const fs = this.flowScalar(this.type);
						if (!it || it.value) fc.items.push({
							start: [],
							key: fs,
							sep: []
						});
						else if (it.sep) this.stack.push(fs);
						else Object.assign(it, {
							key: fs,
							sep: []
						});
						return;
					}
					case "flow-map-end":
					case "flow-seq-end":
						fc.end.push(this.sourceToken);
						return;
				}
				const bv = this.startBlockValue(fc);
				/* istanbul ignore else should not happen */
				if (bv) this.stack.push(bv);
				else {
					yield* this.pop();
					yield* this.step();
				}
			} else {
				const parent = this.peek(2);
				if (parent.type === "block-map" && (this.type === "map-value-ind" && parent.indent === fc.indent || this.type === "newline" && !parent.items[parent.items.length - 1].sep)) {
					yield* this.pop();
					yield* this.step();
				} else if (this.type === "map-value-ind" && parent.type !== "flow-collection") {
					const start = getFirstKeyStartProps(getPrevProps(parent));
					fixFlowSeqItems(fc);
					const sep = fc.end.splice(1, fc.end.length);
					sep.push(this.sourceToken);
					const map = {
						type: "block-map",
						offset: fc.offset,
						indent: fc.indent,
						items: [{
							start,
							key: fc,
							sep
						}]
					};
					this.onKeyLine = true;
					this.stack[this.stack.length - 1] = map;
				} else yield* this.lineEnd(fc);
			}
		}
		flowScalar(type) {
			if (this.onNewLine) {
				let nl = this.source.indexOf("\n") + 1;
				while (nl !== 0) {
					this.onNewLine(this.offset + nl);
					nl = this.source.indexOf("\n", nl) + 1;
				}
			}
			return {
				type,
				offset: this.offset,
				indent: this.indent,
				source: this.source
			};
		}
		startBlockValue(parent) {
			switch (this.type) {
				case "alias":
				case "scalar":
				case "single-quoted-scalar":
				case "double-quoted-scalar": return this.flowScalar(this.type);
				case "block-scalar-header": return {
					type: "block-scalar",
					offset: this.offset,
					indent: this.indent,
					props: [this.sourceToken],
					source: ""
				};
				case "flow-map-start":
				case "flow-seq-start": return {
					type: "flow-collection",
					offset: this.offset,
					indent: this.indent,
					start: this.sourceToken,
					items: [],
					end: []
				};
				case "seq-item-ind": return {
					type: "block-seq",
					offset: this.offset,
					indent: this.indent,
					items: [{ start: [this.sourceToken] }]
				};
				case "explicit-key-ind": {
					this.onKeyLine = true;
					const start = getFirstKeyStartProps(getPrevProps(parent));
					start.push(this.sourceToken);
					return {
						type: "block-map",
						offset: this.offset,
						indent: this.indent,
						items: [{
							start,
							explicitKey: true
						}]
					};
				}
				case "map-value-ind": {
					this.onKeyLine = true;
					const start = getFirstKeyStartProps(getPrevProps(parent));
					return {
						type: "block-map",
						offset: this.offset,
						indent: this.indent,
						items: [{
							start,
							key: null,
							sep: [this.sourceToken]
						}]
					};
				}
			}
			return null;
		}
		atIndentedComment(start, indent) {
			if (this.type !== "comment") return false;
			if (this.indent <= indent) return false;
			return start.every((st) => st.type === "newline" || st.type === "space");
		}
		*documentEnd(docEnd) {
			if (this.type !== "doc-mode") {
				if (docEnd.end) docEnd.end.push(this.sourceToken);
				else docEnd.end = [this.sourceToken];
				if (this.type === "newline") yield* this.pop();
			}
		}
		*lineEnd(token) {
			switch (this.type) {
				case "comma":
				case "doc-start":
				case "doc-end":
				case "flow-seq-end":
				case "flow-map-end":
				case "map-value-ind":
					yield* this.pop();
					yield* this.step();
					break;
				case "newline": this.onKeyLine = false;
				default:
					if (token.end) token.end.push(this.sourceToken);
					else token.end = [this.sourceToken];
					if (this.type === "newline") yield* this.pop();
			}
		}
	};
	exports.Parser = Parser;
}));
//#endregion
//#region node_modules/yaml/dist/public-api.js
var require_public_api = /* @__PURE__ */ __commonJSMin(((exports) => {
	var composer = require_composer();
	var Document = require_Document();
	var errors = require_errors();
	var log = require_log();
	var identity = require_identity();
	var lineCounter = require_line_counter();
	var parser = require_parser();
	function parseOptions(options) {
		const prettyErrors = options.prettyErrors !== false;
		return {
			lineCounter: options.lineCounter || prettyErrors && new lineCounter.LineCounter() || null,
			prettyErrors
		};
	}
	/**
	* Parse the input as a stream of YAML documents.
	*
	* Documents should be separated from each other by `...` or `---` marker lines.
	*
	* @returns If an empty `docs` array is returned, it will be of type
	*   EmptyStream and contain additional stream information. In
	*   TypeScript, you should use `'empty' in docs` as a type guard for it.
	*/
	function parseAllDocuments(source, options = {}) {
		const { lineCounter, prettyErrors } = parseOptions(options);
		const parser$1 = new parser.Parser(lineCounter?.addNewLine);
		const composer$1 = new composer.Composer(options);
		const docs = Array.from(composer$1.compose(parser$1.parse(source)));
		if (prettyErrors && lineCounter) for (const doc of docs) {
			doc.errors.forEach(errors.prettifyError(source, lineCounter));
			doc.warnings.forEach(errors.prettifyError(source, lineCounter));
		}
		if (docs.length > 0) return docs;
		return Object.assign([], { empty: true }, composer$1.streamInfo());
	}
	/** Parse an input string into a single YAML.Document */
	function parseDocument(source, options = {}) {
		const { lineCounter, prettyErrors } = parseOptions(options);
		const parser$1 = new parser.Parser(lineCounter?.addNewLine);
		const composer$1 = new composer.Composer(options);
		let doc = null;
		for (const _doc of composer$1.compose(parser$1.parse(source), true, source.length)) if (!doc) doc = _doc;
		else if (doc.options.logLevel !== "silent") {
			doc.errors.push(new errors.YAMLParseError(_doc.range.slice(0, 2), "MULTIPLE_DOCS", "Source contains multiple documents; please use YAML.parseAllDocuments()"));
			break;
		}
		if (prettyErrors && lineCounter) {
			doc.errors.forEach(errors.prettifyError(source, lineCounter));
			doc.warnings.forEach(errors.prettifyError(source, lineCounter));
		}
		return doc;
	}
	function parse(src, reviver, options) {
		let _reviver = void 0;
		if (typeof reviver === "function") _reviver = reviver;
		else if (options === void 0 && reviver && typeof reviver === "object") options = reviver;
		const doc = parseDocument(src, options);
		if (!doc) return null;
		doc.warnings.forEach((warning) => log.warn(doc.options.logLevel, warning));
		if (doc.errors.length > 0) {
			if (doc.options.logLevel !== "silent") throw doc.errors[0];
			else doc.errors = [];
		}
		return doc.toJS(Object.assign({ reviver: _reviver }, options));
	}
	function stringify(value, replacer, options) {
		let _replacer = null;
		if (typeof replacer === "function" || Array.isArray(replacer)) _replacer = replacer;
		else if (options === void 0 && replacer) options = replacer;
		if (typeof options === "string") options = options.length;
		if (typeof options === "number") {
			const indent = Math.round(options);
			options = indent < 1 ? void 0 : indent > 8 ? { indent: 8 } : { indent };
		}
		if (value === void 0) {
			const { keepUndefined } = options ?? replacer ?? {};
			if (!keepUndefined) return void 0;
		}
		if (identity.isDocument(value) && !_replacer) return value.toString(options);
		return new Document.Document(value, _replacer, options).toString(options);
	}
	exports.parse = parse;
	exports.parseAllDocuments = parseAllDocuments;
	exports.parseDocument = parseDocument;
	exports.stringify = stringify;
}));
//#endregion
//#region src/engine/dependency-analyzer.ts
var import_dist = (/* @__PURE__ */ __commonJSMin(((exports) => {
	var composer = require_composer();
	var Document = require_Document();
	var Schema = require_Schema();
	var errors = require_errors();
	var Alias = require_Alias();
	var identity = require_identity();
	var Pair = require_Pair();
	var Scalar = require_Scalar();
	var YAMLMap = require_YAMLMap();
	var YAMLSeq = require_YAMLSeq();
	require_cst();
	var lexer = require_lexer();
	var lineCounter = require_line_counter();
	var parser = require_parser();
	var publicApi = require_public_api();
	var visit = require_visit();
	exports.Composer = composer.Composer;
	exports.Document = Document.Document;
	exports.Schema = Schema.Schema;
	exports.YAMLError = errors.YAMLError;
	exports.YAMLParseError = errors.YAMLParseError;
	exports.YAMLWarning = errors.YAMLWarning;
	exports.Alias = Alias.Alias;
	exports.isAlias = identity.isAlias;
	exports.isCollection = identity.isCollection;
	exports.isDocument = identity.isDocument;
	exports.isMap = identity.isMap;
	exports.isNode = identity.isNode;
	exports.isPair = identity.isPair;
	exports.isScalar = identity.isScalar;
	exports.isSeq = identity.isSeq;
	exports.Pair = Pair.Pair;
	exports.Scalar = Scalar.Scalar;
	exports.YAMLMap = YAMLMap.YAMLMap;
	exports.YAMLSeq = YAMLSeq.YAMLSeq;
	exports.Lexer = lexer.Lexer;
	exports.LineCounter = lineCounter.LineCounter;
	exports.Parser = parser.Parser;
	exports.parse = publicApi.parse;
	exports.parseAllDocuments = publicApi.parseAllDocuments;
	exports.parseDocument = publicApi.parseDocument;
	exports.stringify = publicApi.stringify;
	exports.visit = visit.visit;
	exports.visitAsync = visit.visitAsync;
})))();
const DEP_KINDS = [
	"dependencies",
	"peerDependencies",
	"optionalDependencies"
];
function createDependencyAnalyzer(options) {
	const fsys = options.fs_ ?? fs;
	const yamlParse = options.yamlParse ?? import_dist.parse;
	function listProfiles() {
		const dir = path.join(options.dshHome, "profiles");
		if (!fsys.existsSync(dir)) return [];
		return fsys.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
	}
	function readJson(p) {
		try {
			return JSON.parse(fsys.readFileSync(p, "utf-8"));
		} catch {
			return null;
		}
	}
	/** 从 package.json 抽出 (name → kind) 依赖表 */
	function depsOf(pkg) {
		const out = /* @__PURE__ */ new Map();
		for (const kind of DEP_KINDS) {
			const sec = pkg[kind];
			if (sec && typeof sec === "object") for (const name of Object.keys(sec)) out.set(name, kind);
		}
		return out;
	}
	/** 解析 cordis.patch.yml：收集所有条目的 id（支持 {changes:[{id}]} 与 [{id}] 两种形态） */
	function patchIds(file) {
		if (!fsys.existsSync(file)) return {
			ids: [],
			parseError: null
		};
		try {
			const doc = yamlParse(fsys.readFileSync(file, "utf-8"));
			const ids = [];
			const visit = (node) => {
				if (Array.isArray(node)) {
					node.forEach(visit);
					return;
				}
				if (node && typeof node === "object") {
					const rec = node;
					if (typeof rec.id === "string") ids.push(rec.id);
					for (const v of Object.values(rec)) if (v && typeof v === "object") visit(v);
				}
			};
			visit(doc);
			return {
				ids: [...new Set(ids)],
				parseError: null
			};
		} catch (e) {
			return {
				ids: [],
				parseError: errorToMessage(e)
			};
		}
	}
	/** node_modules 下的一级包名（含 @scope/name 两段） */
	function listBundleDirs(nmRoot) {
		if (!fsys.existsSync(nmRoot)) return [];
		const out = [];
		for (const e of fsys.readdirSync(nmRoot, { withFileTypes: true })) {
			if (e.name.startsWith(".")) continue;
			if (e.name.startsWith("@")) {
				const scopeDir = path.join(nmRoot, e.name);
				if (!fsys.existsSync(scopeDir)) continue;
				for (const sub of fsys.readdirSync(scopeDir, { withFileTypes: true })) if (sub.isDirectory()) out.push(`${e.name}/${sub.name}`);
			} else if (e.isDirectory()) out.push(e.name);
		}
		return out;
	}
	function buildGraph(profileFilter) {
		const nodes = /* @__PURE__ */ new Map();
		const edges = [];
		const upsert = (name, patch = {}) => {
			const key = name;
			const cur = nodes.get(key) ?? {
				name: key,
				declaredIn: [],
				patchRefs: []
			};
			nodes.set(key, {
				name: key,
				declaredIn: dedupeJoin(cur.declaredIn, patch.declaredIn),
				patchRefs: dedupeJoin(cur.patchRefs, patch.patchRefs)
			});
		};
		const dedupeJoin = (a, b) => [.../* @__PURE__ */ new Set([...a, ...b ?? []])];
		for (const profile of listProfiles()) {
			if (profileFilter && profile !== profileFilter) continue;
			const profileDir = path.join(options.dshHome, "profiles", profile);
			const pkgPath = path.join(profileDir, "package.json");
			const synthetic = `profile:${profile}`;
			if (fsys.existsSync(pkgPath)) {
				const pkg = readJson(pkgPath);
				if (pkg) {
					upsert(synthetic, { declaredIn: [pkgPath] });
					for (const [dep, kind] of depsOf(pkg)) {
						upsert(dep);
						edges.push({
							from: synthetic,
							to: dep,
							kind,
							declaredIn: pkgPath
						});
					}
				}
			}
			const nmRoot = path.join(profileDir, "node_modules");
			for (const bundle of listBundleDirs(nmRoot)) {
				const bp = path.join(nmRoot, ...bundle.split("/"), "package.json");
				if (!fsys.existsSync(bp)) continue;
				const pkg = readJson(bp);
				if (!pkg) continue;
				upsert(bundle);
				for (const [dep, kind] of depsOf(pkg)) {
					if (!(nodes.has(dep) || fsys.existsSync(path.join(nmRoot, ...dep.split("/"))))) continue;
					upsert(dep);
					edges.push({
						from: bundle,
						to: dep,
						kind,
						declaredIn: bp
					});
				}
			}
			const patchFiles = [path.join(options.dshHome, "cordis.patch.yml"), path.join(profileDir, "cordis.patch.yml")];
			for (const pf of patchFiles) {
				const { ids } = patchIds(pf);
				for (const id of ids) {
					upsert(id, { patchRefs: [pf] });
					edges.push({
						from: synthetic,
						to: id,
						kind: "patch-ref",
						declaredIn: pf
					});
				}
			}
		}
		return makeGraph(nodes, edges);
	}
	function makeGraph(nodes, edges) {
		const forward = /* @__PURE__ */ new Map();
		const backward = /* @__PURE__ */ new Map();
		const touch = (m, k) => {
			if (!m.has(k)) m.set(k, /* @__PURE__ */ new Set());
		};
		for (const e of edges) {
			touch(forward, e.from);
			touch(forward, e.to);
			touch(backward, e.from);
			touch(backward, e.to);
			forward.get(e.from).add(e.to);
			backward.get(e.to).add(e.from);
		}
		for (const k of nodes.keys()) {
			touch(forward, k);
			touch(backward, k);
		}
		const closure = (start, next) => {
			const seen = /* @__PURE__ */ new Set();
			const queue = [start];
			for (let head = 0; head < queue.length; head++) {
				const cur = queue[head];
				for (const n of next(cur)) if (n !== start && !seen.has(n)) {
					seen.add(n);
					queue.push(n);
				}
			}
			return [...seen];
		};
		const dependentsMemo = /* @__PURE__ */ new Map();
		const dependenciesMemo = /* @__PURE__ */ new Map();
		const cycles = tarjanCycles(nodes, forward);
		return {
			nodes,
			edges,
			dependentsOf: (name) => {
				let v = dependentsMemo.get(name);
				if (v === void 0) {
					v = closure(name, (n) => [...backward.get(n) ?? []]);
					dependentsMemo.set(name, v);
				}
				return v;
			},
			dependenciesOf: (name) => {
				let v = dependenciesMemo.get(name);
				if (v === void 0) {
					v = closure(name, (n) => [...forward.get(n) ?? []]);
					dependenciesMemo.set(name, v);
				}
				return v;
			},
			hasCycle: () => cycles.length > 0,
			cycles: () => cycles
		};
	}
	function tarjanCycles(nodes, forward) {
		let index = 0;
		const stack = [];
		const onStack = /* @__PURE__ */ new Set();
		const indices = /* @__PURE__ */ new Map();
		const lowlink = /* @__PURE__ */ new Map();
		const out = [];
		const strongconnect = (v) => {
			indices.set(v, index);
			lowlink.set(v, index);
			index++;
			stack.push(v);
			onStack.add(v);
			for (const w of forward.get(v) ?? []) if (!indices.has(w)) {
				strongconnect(w);
				lowlink.set(v, Math.min(lowlink.get(v), lowlink.get(w)));
			} else if (onStack.has(w)) lowlink.set(v, Math.min(lowlink.get(v), indices.get(w)));
			if (lowlink.get(v) === indices.get(v)) {
				const scc = [];
				let w;
				do {
					w = stack.pop();
					onStack.delete(w);
					scc.push(w);
				} while (w !== v);
				if (scc.length > 1) out.push(scc);
				else if (scc.length === 1 && (forward.get(scc[0])?.has(scc[0]) ?? false)) out.push(scc);
			}
		};
		for (const n of nodes.keys()) if (!indices.has(n)) strongconnect(n);
		return out;
	}
	const analyzer = {
		async buildGraph(profile) {
			try {
				return ok(buildGraph(profile));
			} catch (e) {
				return err(ioError("依赖图构建失败", e));
			}
		},
		async blockersOf(plugins) {
			const g = await analyzer.buildGraph();
			if (!g.ok) return g;
			const removing = new Set(plugins);
			const out = [];
			for (const target of plugins) {
				const blockedBy = g.value.dependentsOf(target).filter((d) => !removing.has(d) && !d.startsWith("profile:"));
				if (blockedBy.length > 0) out.push({
					plugin: target,
					blockedBy,
					reason: `被其他插件依赖: ${blockedBy.join(", ")}`
				});
			}
			return ok(out);
		}
	};
	return analyzer;
}
//#endregion
//#region src/engine/residual-scanner.ts
const TEMP_MARKER_RE$1 = /dsh|deepseek|cordis/i;
function createResidualScanner(options) {
	const now = options.now ?? (() => /* @__PURE__ */ new Date());
	const cache = options.scanCache;
	function referencedBy(plugin) {
		return options.referenceIndex?.get(plugin) ?? [];
	}
	function makeEvidence(partial) {
		return {
			location: partial.location,
			kind: partial.kind,
			description: partial.description,
			sizeBytes: partial.sizeBytes,
			lastAccessedAt: partial.atime,
			referencedBy: referencedBy(partial.plugin),
			suggestedAction: partial.suggestedAction
		};
	}
	/** 单插件 × 单 profile 的全部检查点 */
	function* checkPoints(plugin, profile) {
		const profileDir = path.join(options.dshHome, "profiles", profile);
		yield {
			kind: "config-ref",
			location: path.join(profileDir, "pnpm-workspace.yaml"),
			description: `pnpm-workspace.yaml 中仍引用 ${plugin}`,
			isFile: true,
			contains: plugin,
			action: "clean-workspace-yaml"
		};
		yield {
			kind: "config-ref",
			location: path.join(profileDir, "cordis.patch.yml"),
			description: `profile patch 中仍引用 ${plugin}`,
			isFile: true,
			contains: plugin,
			action: "clean-profile-patch"
		};
		yield {
			kind: "config-ref",
			location: path.join(options.dshHome, "cordis.patch.yml"),
			description: `home patch 中仍引用 ${plugin}`,
			isFile: true,
			contains: plugin,
			action: "clean-home-patch"
		};
		yield {
			kind: "node-modules",
			location: path.join(profileDir, "node_modules", ...plugin.split("/")),
			description: `node_modules 包目录: ${plugin}`,
			isFile: false,
			action: "remove-node-modules"
		};
		yield {
			kind: "storage",
			location: path.join(options.dshHome, "storages", plugin),
			description: `storages 持久化数据: ${plugin}`,
			isFile: false,
			action: "remove-storages"
		};
		yield {
			kind: "attachment",
			location: path.join(options.dshHome, "attachments", "v1", plugin),
			description: `attachments 会话附件: ${plugin}`,
			isFile: false,
			action: "remove-attachments"
		};
	}
	function listProfiles() {
		const dir = path.join(options.dshHome, "profiles");
		try {
			return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
		} catch {
			return [];
		}
	}
	/** TEMP 孤儿（aggressive 专属）：共享实现（fs-utils.tempOrphanEntries） */
	const tempEntries = (maxAgeDays) => tempOrphanEntries(options.tempRoot, maxAgeDays, now, TEMP_MARKER_RE$1).map((e) => ({
		entry: e.path,
		size: e.sizeBytes,
		ageDays: e.ageDays
	}));
	async function* scan(request) {
		let scannedPaths = 0;
		let totalFound = 0;
		let bytesReclaimable = 0;
		const cancelled = () => request.signal?.aborted ?? false;
		const profiles = request.profile ? [request.profile] : listProfiles();
		for (const profile of profiles) {
			if (cancelled()) break;
			let plugins;
			if (request.plugin) plugins = [request.plugin];
			else plugins = globalPluginSet(profile);
			for (const plugin of plugins) {
				if (cancelled()) break;
				for (const cp of checkPoints(plugin, profile)) {
					if (cancelled()) break;
					scannedPaths++;
					yield {
						type: "progress",
						scannedPaths,
						currentRoot: path.dirname(cp.location)
					};
					let stat = null;
					try {
						stat = fs.statSync(cp.location);
					} catch {}
					if (stat === null) continue;
					const cached = cache?.get(cp.location, stat.mtimeMs, stat.size) ?? null;
					let containsHit = true;
					if (cp.isFile && cp.contains !== void 0) {
						if (cached?.containsHit !== void 0) containsHit = cached.containsHit;
						else {
							let content = "";
							try {
								content = fs.readFileSync(cp.location, "utf-8");
							} catch {}
							containsHit = content.includes(cp.contains);
							cache?.set(cp.location, {
								mtimeMs: stat.mtimeMs,
								size: stat.size,
								containsHit
							});
						}
						if (!containsHit) continue;
					}
					let size;
					if (cp.isFile) size = stat.size;
					else if (cached?.dirBytes !== void 0) size = cached.dirBytes;
					else {
						size = dirSize(cp.location);
						cache?.set(cp.location, {
							mtimeMs: stat.mtimeMs,
							size: stat.size,
							dirBytes: size
						});
					}
					bytesReclaimable += size;
					totalFound++;
					yield {
						type: "found",
						evidence: makeEvidence({
							location: cp.location,
							kind: cp.kind,
							description: cp.description,
							sizeBytes: size,
							plugin,
							suggestedAction: cp.action,
							atime: stat.atime
						})
					};
				}
			}
			if (cancelled()) break;
			const pd = path.join(options.dshHome, "profiles", profile);
			yield {
				type: "root-summary",
				root: pd,
				bytesScannable: dirSize(pd)
			};
		}
		if (!cancelled() && request.includeTemp && request.strategy === "aggressive") {
			for (const t of tempEntries(7)) {
				if (cancelled()) break;
				scannedPaths++;
				totalFound++;
				bytesReclaimable += t.size;
				yield {
					type: "found",
					evidence: makeEvidence({
						location: t.entry,
						kind: "temp-orphan",
						description: `TEMP 中 ${t.ageDays.toFixed(1)} 天未动的 dsh 残留`,
						sizeBytes: t.size,
						plugin: path.basename(t.entry),
						suggestedAction: "purge-temp",
						atime: null
					})
				};
			}
			yield {
				type: "root-summary",
				root: options.tempRoot,
				bytesScannable: dirSize(options.tempRoot)
			};
		}
		cache?.flush();
		yield {
			type: "done",
			totalFound,
			bytesReclaimable
		};
	}
	/** 全局模式：profile package.json 依赖 + storages/attachments 目录名 并集 */
	function globalPluginSet(profile) {
		const set = /* @__PURE__ */ new Set();
		const pkgPath = path.join(options.dshHome, "profiles", profile, "package.json");
		try {
			const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
			for (const k of [
				"dependencies",
				"peerDependencies",
				"optionalDependencies"
			]) for (const name of Object.keys(pkg[k] ?? {})) set.add(name);
			for (const b of pkg?.dsh?.profile?.bundles ?? []) set.add(b);
		} catch {}
		for (const root of [path.join(options.dshHome, "storages"), path.join(options.dshHome, "attachments", "v1")]) try {
			for (const e of fs.readdirSync(root, { withFileTypes: true })) if (e.isDirectory()) set.add(e.name);
		} catch {}
		set.delete("@deepseek-ai/dsh-base");
		return [...set];
	}
	return { scan };
}
//#endregion
//#region src/engine/orphan-detector.ts
const TEMP_MARKER_RE = /dsh|deepseek|cordis/i;
const PROTECTED = /* @__PURE__ */ new Set([
	"@deepseek-ai/dsh-base",
	".pnpm",
	".bin",
	".modules.yaml",
	"node_modules"
]);
function createOrphanDetector(options) {
	const now = options.now ?? (() => /* @__PURE__ */ new Date());
	function listProfiles() {
		try {
			return fs.readdirSync(path.join(options.dshHome, "profiles"), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
		} catch {
			return [];
		}
	}
	/** 全 profile 引用集合：package.json 依赖 + bundles + patch yml 中出现的 id */
	function referencedNames() {
		const refs = /* @__PURE__ */ new Set();
		const collectPkg = (pkgPath) => {
			try {
				const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
				for (const k of [
					"dependencies",
					"peerDependencies",
					"optionalDependencies"
				]) for (const name of Object.keys(pkg[k] ?? {})) refs.add(name);
				for (const b of pkg?.dsh?.profile?.bundles ?? []) refs.add(b);
			} catch {}
		};
		for (const profile of listProfiles()) {
			const profileDir = path.join(options.dshHome, "profiles", profile);
			collectPkg(path.join(profileDir, "package.json"));
			for (const pf of [path.join(options.dshHome, "cordis.patch.yml"), path.join(profileDir, "cordis.patch.yml")]) try {
				const text = fs.readFileSync(pf, "utf-8");
				for (const m of text.matchAll(/^\s*-?\s*id:\s*(\S+)\s*$/gm)) refs.add(m[1]);
			} catch {}
		}
		return refs;
	}
	/** node_modules 一级条目名（含 @scope 两段、.pnpm 展开到实际包名） */
	function installedPackages() {
		const out = [];
		for (const profile of listProfiles()) {
			const nm = path.join(options.dshHome, "profiles", profile, "node_modules");
			let top;
			try {
				top = fs.readdirSync(nm, { withFileTypes: true });
			} catch {
				continue;
			}
			for (const e of top) {
				if (e.name.startsWith(".") || e.name === "node_modules") continue;
				if (e.name.startsWith("@")) try {
					for (const sub of fs.readdirSync(path.join(nm, e.name), { withFileTypes: true })) if (sub.isDirectory()) out.push({
						name: `${e.name}/${sub.name}`,
						dir: path.join(nm, e.name, sub.name)
					});
				} catch {}
				else if (e.isDirectory()) out.push({
					name: e.name,
					dir: path.join(nm, e.name)
				});
			}
		}
		return out;
	}
	return { async detect(opts) {
		try {
			const refs = referencedNames();
			const signal = opts.signal;
			const candidates = installedPackages().filter((pkg) => !refs.has(pkg.name) && !PROTECTED.has(pkg.name) && !pkg.name.startsWith("@deepseek-ai/"));
			if (signal?.aborted) return err({
				code: "E_CANCELLED",
				message: "孤儿检测被取消"
			});
			const orphanPluginDirs = [];
			const sized1 = await forEachPool(candidates, 8, async (pkg) => ({
				path: pkg.dir,
				sizeBytes: await dirSizeAsync(pkg.dir, { ...signal ? { signal } : {} })
			}));
			for (const r of sized1) if (r.status === "fulfilled") orphanPluginDirs.push(r.value);
			orphanPluginDirs.sort((a, b) => b.sizeBytes - a.sizeBytes);
			const dataCandidates = [];
			for (const root of [path.join(options.dshHome, "storages"), path.join(options.dshHome, "attachments", "v1")]) {
				let entries;
				try {
					entries = fs.readdirSync(root, { withFileTypes: true });
				} catch {
					continue;
				}
				for (const e of entries) {
					if (!e.isDirectory() || refs.has(e.name)) continue;
					dataCandidates.push(path.join(root, e.name));
				}
			}
			if (signal?.aborted) return err({
				code: "E_CANCELLED",
				message: "孤儿检测被取消"
			});
			const orphanDataDirs = [];
			const sized2 = await forEachPool(dataCandidates, 8, async (d) => ({
				path: d,
				sizeBytes: await dirSizeAsync(d, { ...signal ? { signal } : {} })
			}));
			for (const r of sized2) if (r.status === "fulfilled") orphanDataDirs.push(r.value);
			orphanDataDirs.sort((a, b) => b.sizeBytes - a.sizeBytes);
			if (signal?.aborted) return err({
				code: "E_CANCELLED",
				message: "孤儿检测被取消"
			});
			const tempOrphans = tempOrphanEntries(options.tempRoot, opts.tempMaxAgeDays, now, TEMP_MARKER_RE).map((e) => ({
				path: e.path,
				sizeBytes: e.sizeBytes,
				ageDays: e.ageDays
			}));
			return ok({
				orphanPluginDirs,
				orphanDataDirs,
				tempOrphans,
				totalReclaimableBytes: orphanPluginDirs.reduce((s, d) => s + d.sizeBytes, 0) + orphanDataDirs.reduce((s, d) => s + d.sizeBytes, 0) + tempOrphans.reduce((s, d) => s + d.sizeBytes, 0)
			});
		} catch (e) {
			return err(ioError("孤儿检测失败", e));
		}
	} };
}
//#endregion
//#region src/engine/health-inspector.ts
const SEVERITY_WEIGHT = {
	info: 1,
	warning: 2,
	critical: 4
};
function createHealthInspector(options) {
	const now = options.now ?? (() => /* @__PURE__ */ new Date());
	const runCommand = options.runCommand ?? ((cmd, args, opts) => {
		const r = spawnSync(cmd, args, {
			cwd: opts.cwd,
			encoding: "utf-8",
			timeout: opts.timeoutMs
		});
		return {
			status: r.status,
			stdout: r.stdout ?? "",
			stderr: r.stderr ?? ""
		};
	});
	const R = (check, passed, message, severity, group, fix) => ({
		check,
		passed,
		message,
		severity,
		group,
		...fix ? { fix } : {}
	});
	function checkConfig(profile, out) {
		const profileDir = path.join(options.dshHome, "profiles", profile);
		const pkgPath = path.join(profileDir, "package.json");
		if (fs.existsSync(pkgPath)) try {
			const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
			out.push(R("package.json 语法", true, "JSON 格式正确", "info", "config"));
			const bundles = pkg?.dsh?.profile?.bundles ?? [];
			const deps = new Set(Object.keys(pkg?.dependencies ?? {}));
			const orphans = bundles.filter((b) => !deps.has(b) && b !== "@deepseek-ai/dsh-base");
			if (orphans.length === 0) out.push(R("bundles 一致性", true, "所有 bundle 均有对应依赖", "info", "config"));
			else out.push(R("bundles 一致性", false, `孤立 bundle: ${orphans.join(", ")}`, "warning", "config", "将孤立 bundle 加入 dependencies 或从 bundles 中移除"));
		} catch (e) {
			out.push(R("package.json 语法", false, `JSON 解析失败: ${errorToMessage(e)}`, "critical", "config", "修复 JSON 语法；可从备份区恢复上一版本"));
		}
		else out.push(R("package.json 存在性", false, `profile "${profile}" 不存在或缺少 package.json`, "critical", "config"));
		const wsPath = path.join(profileDir, "pnpm-workspace.yaml");
		if (fs.existsSync(wsPath)) try {
			(0, import_dist.parse)(fs.readFileSync(wsPath, "utf-8"));
			out.push(R("pnpm-workspace.yaml 语法", true, "YAML 格式正确", "info", "config"));
		} catch (e) {
			out.push(R("pnpm-workspace.yaml 语法", false, `YAML 解析失败: ${errorToMessage(e)}`, "critical", "config"));
		}
		for (const [label, pf] of [["cordis.patch.yml (profile)", path.join(profileDir, "cordis.patch.yml")], ["cordis.patch.yml (home)", path.join(options.dshHome, "cordis.patch.yml")]]) {
			if (!fs.existsSync(pf)) continue;
			try {
				(0, import_dist.parse)(fs.readFileSync(pf, "utf-8"));
				out.push(R(`${label} 语法`, true, "YAML 格式正确", "info", "config"));
			} catch (e) {
				out.push(R(`${label} 语法`, false, `YAML 解析失败: ${errorToMessage(e)}`, "critical", "config"));
			}
		}
	}
	function checkDependency(profile, out) {
		const profileDir = path.join(options.dshHome, "profiles", profile);
		const pkgPath = path.join(profileDir, "package.json");
		const lockPath = path.join(profileDir, "pnpm-lock.yaml");
		if (fs.existsSync(pkgPath) && fs.existsSync(lockPath)) {
			if (fs.statSync(pkgPath).mtimeMs > fs.statSync(lockPath).mtimeMs) out.push(R("lockfile 新鲜度", false, "package.json 比 pnpm-lock.yaml 更新，依赖可能漂移", "warning", "dependency", "在 profile 目录执行 pnpm install 刷新 lockfile"));
			else out.push(R("lockfile 新鲜度", true, "lockfile 不早于 package.json", "info", "dependency"));
		}
		try {
			const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
			const deps = Object.keys(pkg?.dependencies ?? {});
			const nm = path.join(profileDir, "node_modules");
			const missing = deps.filter((d) => !fs.existsSync(path.join(nm, ...d.split("/"))) && d !== "@deepseek-ai/dsh-base");
			if (missing.length > 0) out.push(R("依赖安装完整性", false, `缺失 node_modules 条目: ${missing.join(", ")}`, "warning", "dependency", "执行 pnpm install 补齐"));
			else out.push(R("依赖安装完整性", true, "声明的依赖均已安装", "info", "dependency"));
		} catch {}
	}
	function checkRuntime(out) {
		const dsh = runCommand("dsh", ["--version"], {
			cwd: options.dshHome,
			timeoutMs: 5e3
		});
		if (dsh.status === 0) out.push(R("dsh CLI", true, `版本: ${dsh.stdout.trim().slice(0, 60)}`, "info", "runtime"));
		else out.push(R("dsh CLI", false, "dsh 命令不可用（不在 PATH 或执行失败）", "critical", "runtime", "确认 dsh 已安装且在 PATH 中；standard-remove 步骤将不可用"));
		const pnpm = runCommand("pnpm", ["--version"], {
			cwd: options.dshHome,
			timeoutMs: 5e3
		});
		if (pnpm.status === 0) out.push(R("pnpm CLI", true, `版本: ${pnpm.stdout.trim().slice(0, 60)}`, "info", "runtime"));
		else out.push(R("pnpm CLI", false, "pnpm 命令不可用", "warning", "runtime", "安装 pnpm: npm i -g pnpm"));
		const lockPath = path.join(options.dshHome, ".nuke", "nuke.lock");
		if (fs.existsSync(lockPath)) out.push(R("nuke 锁残留", false, `发现锁文件 ${lockPath}，可能存在并发清理或上次异常退出`, "warning", "runtime", "确认无清理进行后由管理员破锁"));
		else out.push(R("nuke 锁残留", true, "无锁残留", "info", "runtime"));
		const unfinished = options.walUnfinished?.() ?? [];
		if (unfinished.length > 0) out.push(R("WAL 未完成事务", false, `${unfinished.length} 个未终结事务: ${unfinished.join(", ")}`, "warning", "runtime", "先执行 nuke recover 完成崩溃恢复"));
		else out.push(R("WAL 未完成事务", true, "无未终结事务", "info", "runtime"));
	}
	function checkResidue(out) {
		let orphanStorages = 0;
		let orphanBytes = 0;
		const storages = path.join(options.dshHome, "storages");
		try {
			for (const e of fs.readdirSync(storages, { withFileTypes: true })) {
				if (!e.isDirectory()) continue;
				let total = 0;
				const d = path.join(storages, e.name);
				try {
					for (const f of fs.readdirSync(d)) try {
						total += fs.statSync(path.join(d, f)).size;
					} catch {}
				} catch {}
				if (total > 52428800) {
					orphanStorages++;
					orphanBytes += total;
				}
			}
		} catch {}
		if (orphanStorages > 0) out.push(R("storages 膨胀", false, `${orphanStorages} 个插件存储超过 50MB（共 ${(orphanBytes / 1024 / 1024).toFixed(0)}MB）`, "info", "residue", "运行 nuke scan 评估可回收空间"));
		else out.push(R("storages 膨胀", true, "无超 50MB 的插件存储", "info", "residue"));
	}
	return { async inspect(profile) {
		try {
			const results = [];
			checkConfig(profile, results);
			checkDependency(profile, results);
			checkRuntime(results);
			checkResidue(results);
			const blocking = results.some((r) => r.severity === "critical" && !r.passed);
			const weightTotal = results.reduce((s, r) => s + SEVERITY_WEIGHT[r.severity], 0);
			const weightGot = results.reduce((s, r) => s + (r.passed ? SEVERITY_WEIGHT[r.severity] : 0), 0);
			const score = weightTotal === 0 ? 100 : Math.round(100 * weightGot / weightTotal);
			return ok({
				profile,
				checkedAt: now().toISOString(),
				results,
				blocking,
				score
			});
		} catch (e) {
			return err(ioError("健康检查失败", e));
		}
	} };
}
//#endregion
//#region src/infra/reporter.ts
function createReporter(options) {
	const now = options.now ?? (() => /* @__PURE__ */ new Date());
	function baseName(payload) {
		const id = payload.tx?.txId ?? payload.dryRun?.txId;
		const ts = now().toISOString().replace(/[:.]/g, "-");
		return id ? `nuke-${id}-${ts}` : `nuke-scan-${ts}`;
	}
	function statusIcon(passed) {
		return passed ? "✅" : "❌";
	}
	function renderMarkdown(payload) {
		const L = [];
		L.push("# Nuke 清理报告", "");
		L.push(`- **生成时间**: ${payload.generatedAt}`);
		L.push(`- **审计链校验**: ${payload.chainValid ? "✅ 完整" : "❌ 已被篡改"}`, "");
		if (payload.tx) {
			const tx = payload.tx;
			L.push("## 事务摘要", "");
			L.push(`- **事务 ID**: ${tx.txId}`);
			L.push(`- **状态**: ${tx.state}`);
			L.push(`- **开始**: ${tx.startedAt}${tx.finishedAt ? ` / **结束**: ${tx.finishedAt}` : ""}`);
			L.push(`- **释放空间**: ${fmtBytes(tx.bytesFreedTotal)}`, "");
			L.push("| # | 操作 | 动作 | 状态 | 释放 |", "|---|---|---|---|---|");
			for (const s of tx.steps) L.push(`| ${s.index} | ${s.operationId} | ${s.action} | ${s.status} | ${fmtBytes(s.bytesFreed)} |`);
			L.push("");
		}
		if (payload.dryRun) {
			const dr = payload.dryRun;
			L.push("## 预演（Dry-run）", "");
			L.push(`- **事务 ID**: ${dr.txId}`);
			L.push(`- **预计回收**: ${fmtBytes(dr.estimatedBytesReclaimable)}`, "");
			for (const p of dr.plans) {
				L.push(`### ${p.operation ?? p.summary}`);
				L.push(`- ${p.summary}`);
				if (p.operation) {
					L.push(`- 触及路径: ${p.operation.touchedPaths.join(", ") || "无"}`);
					L.push(`- 预计回收: ${fmtBytes(p.operation.estimatedBytesReclaimable)}`);
					L.push(`- 需要独占锁: ${p.operation.requiresExclusiveLock ? "是" : "否"}`);
				}
				L.push("");
			}
			if (dr.warnings.length > 0) {
				L.push("### 警告", "");
				for (const w of dr.warnings) L.push(`- ${w.blocking ? "⛔ [阻断] " : "⚠️ "}${w.message}`);
				L.push("");
			}
		}
		L.push("## 健康检查", "");
		L.push("| 状态 | 检查项 | 结果 | 级别 | 分组 |", "|---|---|---|---|---|");
		for (const h of payload.health) {
			const msg = h.message.replace(/\|/g, "\\|");
			L.push(`| ${statusIcon(h.passed)} | ${h.check} | ${msg} | ${h.severity} | ${h.group} |`);
		}
		L.push("");
		L.push("## 审计链", "");
		if (payload.auditTrail.length === 0) L.push("(无审计记录)", "");
		else {
			L.push("| seq | 时间 | 操作人 | 动作 | 结果 | hash |", "|---|---|---|---|---|---|");
			for (const a of payload.auditTrail) L.push(`| ${a.seq} | ${a.timestamp} | ${a.actor} | ${a.action} | ${a.outcome} | \`${a.hash.slice(0, 12)}…\` |`);
			L.push("");
		}
		return L.join("\n");
	}
	return { async export(format, payload) {
		try {
			fs.mkdirSync(options.reportsRoot, { recursive: true });
			const name = baseName(payload);
			const file = path.join(options.reportsRoot, `${name}.${format === "json" ? "json" : "md"}`);
			const content = format === "json" ? JSON.stringify(payload, null, 2) : renderMarkdown(payload);
			fs.writeFileSync(file, content, "utf-8");
			return ok({
				path: file,
				bytes: Buffer.byteLength(content)
			});
		} catch (e) {
			return err(ioError("报告导出失败", e));
		}
	} };
}
//#endregion
//#region src/engine/doctor.ts
/** 处方条目上限：报告可读性优先，超出部分仍计入总可回收空间 */
const MAX_RECOMMENDATIONS = 50;
function createDoctor(deps) {
	function priorityOf(e) {
		if (e.referencedBy.length > 0 || e.score.band === "critical") return 1;
		if (e.score.band === "high" || e.score.band === "medium") return 2;
		return 3;
	}
	function strategyOf(e) {
		if (e.referencedBy.length > 0) return "safe";
		if (e.kind === "temp-orphan") return "aggressive";
		return "balanced";
	}
	function reasonOf(e) {
		if (e.referencedBy.length > 0) return `仍被 ${e.referencedBy.join(", ")} 引用 —— 先以 safe 策略摘除配置引用，再评估目录回收`;
		if (e.kind === "temp-orphan") return "TEMP 过期孤儿（aggressive 动作，需确认令牌）";
		if (e.score.band === "critical" || e.score.band === "high") return `${e.score.band} 级孤儿残留，建议 balanced 物理回收`;
		return `${e.score.band} 级残留（${e.score.total} 分），可择机清理`;
	}
	return { async diagnose(profile, options) {
		try {
			const h = await deps.health.inspect(profile);
			if (!h.ok) return h;
			const health = h.value;
			const evidences = [];
			const signal = options?.signal;
			for await (const ev of deps.scanner.scan({
				profile,
				strategy: "safe",
				includeTemp: false,
				...signal ? { signal } : {}
			})) {
				if (signal?.aborted) return err({
					code: "E_CANCELLED",
					message: "体检被取消"
				});
				if (ev.type === "found") evidences.push(ev.evidence);
			}
			const o = await deps.orphans.detect({
				tempMaxAgeDays: 7,
				...signal ? { signal } : {}
			});
			if (o.ok) {
				for (const d of o.value.orphanPluginDirs) evidences.push({
					location: d.path,
					kind: "node-modules",
					description: `node_modules 孤儿包: ${d.path}`,
					sizeBytes: d.sizeBytes,
					lastAccessedAt: null,
					referencedBy: [],
					suggestedAction: "remove-node-modules"
				});
				for (const d of o.value.orphanDataDirs) evidences.push({
					location: d.path,
					kind: "storage",
					description: `无主数据目录: ${d.path}`,
					sizeBytes: d.sizeBytes,
					lastAccessedAt: null,
					referencedBy: [],
					suggestedAction: "remove-storages"
				});
				for (const t of o.value.tempOrphans) {
					const age = /* @__PURE__ */ new Date(deps.clock.now().getTime() - t.ageDays * 864e5);
					evidences.push({
						location: t.path,
						kind: "temp-orphan",
						description: `TEMP 过期孤儿（${t.ageDays.toFixed(1)} 天）: ${t.path}`,
						sizeBytes: t.sizeBytes,
						lastAccessedAt: age,
						referencedBy: [],
						suggestedAction: "purge-temp"
					});
				}
			}
			const all = deps.scorer.rank(evidences).map((e) => ({
				priority: priorityOf(e),
				evidence: e,
				suggestedStrategy: strategyOf(e),
				reason: reasonOf(e)
			}));
			all.sort((a, b) => a.priority - b.priority || b.evidence.score.total - a.evidence.score.total);
			const totalReclaimableBytes = evidences.reduce((s, e) => s + e.sizeBytes, 0);
			const hasUrgent = all.some((r) => r.priority <= 2);
			const verdict = health.blocking || health.score < 40 ? "critical" : health.score < 80 || hasUrgent ? "attention" : "healthy";
			return ok({
				generatedAt: deps.clock.now().toISOString(),
				profile,
				verdict,
				healthScore: health.score,
				blocking: health.blocking,
				recommendations: all.slice(0, MAX_RECOMMENDATIONS),
				totalReclaimableBytes
			});
		} catch (e) {
			return err(ioError("体检编排失败", e));
		}
	} };
}
//#endregion
//#region src/engine/dedup-analyzer.ts
const PROFILE_RE = /(?:^|[/\\])profiles[/\\]([^/\\]+)[/\\]/;
function createDedupAnalyzer(options) {
	const now = options.now ?? (() => Date.now());
	const maxGroups = options.maxGroups ?? 100;
	function defaultRoots() {
		const out = [];
		const profilesDir = path.join(options.dshHome, "profiles");
		try {
			for (const e of fs.readdirSync(profilesDir, { withFileTypes: true })) if (e.isDirectory()) out.push(path.join(profilesDir, e.name, "node_modules"));
		} catch {}
		return out;
	}
	function profileOf(p) {
		return PROFILE_RE.exec(p)?.[1] ?? null;
	}
	/** 收集参与分析的文件：跳过符号链接、过滤小文件 */
	function collect(roots, minSize, signal) {
		const bySize = /* @__PURE__ */ new Map();
		let filesScanned = 0;
		let bytesScanned = 0;
		const walk = (dir) => {
			if (signal?.aborted) return false;
			let entries;
			try {
				entries = fs.readdirSync(dir, { withFileTypes: true });
			} catch {
				return true;
			}
			for (const e of entries) {
				if (signal?.aborted) return false;
				const full = path.join(dir, e.name);
				if (e.isSymbolicLink()) continue;
				if (e.isDirectory()) {
					if (!walk(full)) return false;
				} else if (e.isFile()) {
					let size = 0;
					try {
						size = fs.statSync(full).size;
					} catch {
						continue;
					}
					if (size < minSize) continue;
					filesScanned++;
					bytesScanned += size;
					const bucket = bySize.get(size);
					if (bucket) bucket.push(full);
					else bySize.set(size, [full]);
				}
			}
			return true;
		};
		for (const root of roots) if (!walk(root)) return null;
		return {
			bySize,
			filesScanned,
			bytesScanned
		};
	}
	async function hashFile(p) {
		return await new Promise((resolve, reject) => {
			const h = crypto.createHash("sha256");
			const stream = fs.createReadStream(p);
			stream.on("data", (chunk) => h.update(chunk));
			stream.on("error", reject);
			stream.on("end", () => resolve(h.digest("hex")));
		});
	}
	const SAMPLE_BYTES = 4096;
	/** 头尾采样指纹：一次 open + 两次定位 read（≤8KB IO），绝不读全量。
	*  小于 2×SAMPLE 的文件退化为头采（尾部与头部重叠无意义）。 */
	async function sampleFingerprint(p, size) {
		return await new Promise((resolve, reject) => {
			fs.open(p, "r", (err, fd) => {
				if (err) {
					reject(err);
					return;
				}
				const h = crypto.createHash("sha256");
				const head = Buffer.alloc(Math.min(SAMPLE_BYTES, size));
				fs.read(fd, head, 0, head.length, 0, (e1) => {
					if (e1) {
						try {
							fs.closeSync(fd);
						} catch {}
						reject(e1);
						return;
					}
					if (size <= SAMPLE_BYTES) {
						try {
							fs.closeSync(fd);
						} catch {}
						h.update(head);
						resolve(`s:${h.digest("hex")}`);
						return;
					}
					const tail = Buffer.alloc(SAMPLE_BYTES);
					const tailStart = size - SAMPLE_BYTES;
					fs.read(fd, tail, 0, tail.length, tailStart, (e2) => {
						try {
							fs.closeSync(fd);
						} catch {}
						if (e2) {
							reject(e2);
							return;
						}
						h.update(head);
						h.update(tail);
						resolve(`s:${h.digest("hex")}`);
					});
				});
			});
		});
	}
	return { async analyze(analyzeOptions) {
		const started = now();
		const signal = analyzeOptions?.signal;
		const minSize = analyzeOptions?.minSizeBytes ?? 4096;
		const roots = analyzeOptions?.roots ?? defaultRoots();
		if (roots.length === 0) return ok({
			groups: [],
			totalReclaimableBytes: 0,
			filesScanned: 0,
			bytesScanned: 0,
			durationMs: 0
		});
		try {
			const collected = collect(roots, minSize, signal);
			if (!collected) return err({
				code: "E_CANCELLED",
				message: "去重分析被取消"
			});
			const { bySize, filesScanned, bytesScanned } = collected;
			let sizeEliminated = 0;
			const candidates = [];
			for (const [size, paths] of bySize) {
				if (paths.length < 2) {
					sizeEliminated += paths.length;
					continue;
				}
				candidates.push({
					size,
					paths
				});
			}
			let sampleEliminated = 0;
			let bytesSaved = 0;
			const sampleCollisions = [];
			for (const { size, paths } of candidates) {
				if (signal?.aborted) return err({
					code: "E_CANCELLED",
					message: "去重分析被取消"
				});
				const bySample = /* @__PURE__ */ new Map();
				const settled = await forEachPool(paths, 8, async (p) => ({
					p,
					fp: await sampleFingerprint(p, size)
				}));
				for (const r of settled) {
					if (r.status !== "fulfilled") continue;
					const { p, fp } = r.value;
					const bucket = bySample.get(fp);
					if (bucket) bucket.push(p);
					else bySample.set(fp, [p]);
				}
				for (const bucket of bySample.values()) if (bucket.length < 2) {
					sampleEliminated += bucket.length;
					bytesSaved += bucket.length * size;
				} else sampleCollisions.push({
					size,
					paths: bucket
				});
			}
			const groups = [];
			let fullHashed = 0;
			for (const { size, paths } of sampleCollisions) {
				if (signal?.aborted) return err({
					code: "E_CANCELLED",
					message: "去重分析被取消"
				});
				const byHash = /* @__PURE__ */ new Map();
				const settled = await forEachPool(paths, 8, async (p) => ({
					p,
					hash: await hashFile(p)
				}));
				for (const r of settled) {
					if (r.status !== "fulfilled") continue;
					const { p, hash } = r.value;
					fullHashed++;
					const bucket = byHash.get(hash);
					if (bucket) bucket.push(p);
					else byHash.set(hash, [p]);
				}
				for (const [hash, copies] of byHash) {
					if (copies.length < 2) continue;
					groups.push({
						hash,
						sizeBytes: size,
						copies: copies.map((p) => ({
							path: p,
							profile: profileOf(p)
						})),
						reclaimableBytes: (copies.length - 1) * size
					});
				}
			}
			groups.sort((a, b) => b.reclaimableBytes - a.reclaimableBytes);
			const totalReclaimableBytes = groups.reduce((s, g) => s + g.reclaimableBytes, 0);
			return ok({
				groups: groups.slice(0, maxGroups),
				totalReclaimableBytes,
				filesScanned,
				bytesScanned,
				durationMs: now() - started,
				stages: {
					sizeEliminated,
					sampleEliminated,
					fullHashed,
					bytesSavedBySampling: bytesSaved
				}
			});
		} catch (e) {
			return err(ioError("去重分析失败", e));
		}
	} };
}
//#endregion
//#region src/engine/dedup-executor.ts
function createDedupExecutor() {
	function hashFile(p) {
		return new Promise((resolve, reject) => {
			const h = crypto.createHash("sha256");
			const stream = fs.createReadStream(p);
			stream.on("data", (chunk) => h.update(chunk));
			stream.on("error", reject);
			stream.on("end", () => resolve(h.digest("hex")));
		});
	}
	return {
		async apply(report, opts) {
			const signal = opts?.signal;
			const journal = [];
			const skipped = [];
			let linkedFiles = 0;
			let bytesSaved = 0;
			let cancelled = false;
			outer: try {
				for (const group of report.groups) {
					if (signal?.aborted) {
						cancelled = true;
						break;
					}
					if (group.copies.length < 2) continue;
					const canonical = group.copies[0];
					try {
						if (await hashFile(canonical.path) !== group.hash) {
							skipped.push({
								path: canonical.path,
								reason: "复验失败：canonical 内容已变化（整组跳过）"
							});
							continue;
						}
					} catch (e) {
						skipped.push({
							path: canonical.path,
							reason: `canonical 读取失败: ${String(e).slice(0, 80)}`
						});
						continue;
					}
					let canonicalDev;
					let canonicalIno;
					let canonicalMtime;
					try {
						const st = fs.statSync(canonical.path);
						canonicalDev = st.dev;
						canonicalIno = st.ino;
						canonicalMtime = st.mtimeMs;
					} catch {
						skipped.push({
							path: canonical.path,
							reason: "canonical 消失"
						});
						continue;
					}
					for (const copy of group.copies.slice(1)) {
						if (signal?.aborted) {
							cancelled = true;
							break outer;
						}
						const victim = copy.path;
						let linked = false;
						try {
							let lst;
							try {
								lst = fs.lstatSync(victim);
							} catch {
								skipped.push({
									path: victim,
									reason: "victim 消失"
								});
								continue;
							}
							if (lst.isSymbolicLink()) {
								skipped.push({
									path: victim,
									reason: "符号链接（与分析器口径一致，跳过）"
								});
								continue;
							}
							try {
								const cst = fs.statSync(canonical.path);
								if (cst.ino !== canonicalIno || cst.dev !== canonicalDev || cst.mtimeMs !== canonicalMtime) {
									skipped.push({
										path: canonical.path,
										reason: "canonical 在组处理中被修改（整组中止）"
									});
									break;
								}
							} catch {
								skipped.push({
									path: canonical.path,
									reason: "canonical 消失（整组中止）"
								});
								break;
							}
							const vs = fs.statSync(victim);
							if (vs.ino === canonicalIno && vs.dev === canonicalDev) {
								skipped.push({
									path: victim,
									reason: "已是同一 inode（已链接）"
								});
								continue;
							}
							if (vs.dev !== canonicalDev) {
								skipped.push({
									path: victim,
									reason: "跨文件系统（st_dev 不同）"
								});
								continue;
							}
							if (vs.size !== group.sizeBytes) {
								skipped.push({
									path: victim,
									reason: "复验失败：尺寸已变化"
								});
								continue;
							}
							if (await hashFile(victim) !== group.hash) {
								skipped.push({
									path: victim,
									reason: "复验失败：内容已变化"
								});
								continue;
							}
							const tmp = `${victim}.dedup-${crypto.randomBytes(4).toString("hex")}`;
							try {
								fs.linkSync(canonical.path, tmp);
								fs.renameSync(tmp, victim);
								linked = true;
							} catch (e) {
								try {
									fs.unlinkSync(tmp);
								} catch {}
								skipped.push({
									path: victim,
									reason: `链接失败（可能不支持硬链接）: ${String(e).slice(0, 60)}`
								});
								continue;
							}
							let after;
							try {
								after = fs.statSync(victim);
							} catch {
								linkedFiles++;
								if (vs.nlink === 1) bytesSaved += group.sizeBytes;
								journal.push({
									victim,
									canonical: canonical.path,
									sizeBytes: group.sizeBytes
								});
								skipped.push({
									path: victim,
									reason: "事后 stat 失败：链接已生效并已记入 journal"
								});
								continue;
							}
							if (after.ino !== canonicalIno || after.dev !== canonicalDev) {
								linkedFiles++;
								if (vs.nlink === 1) bytesSaved += group.sizeBytes;
								journal.push({
									victim,
									canonical: canonical.path,
									sizeBytes: group.sizeBytes
								});
								skipped.push({
									path: victim,
									reason: "事后断言失败：inode 不匹配（链接已生效，记入 journal 可 undo）"
								});
								continue;
							}
							linkedFiles++;
							if (vs.nlink === 1) bytesSaved += group.sizeBytes;
							journal.push({
								victim,
								canonical: canonical.path,
								sizeBytes: group.sizeBytes
							});
						} catch (e) {
							if (linked) {
								linkedFiles++;
								journal.push({
									victim,
									canonical: canonical.path,
									sizeBytes: group.sizeBytes
								});
								skipped.push({
									path: victim,
									reason: `链接后处理异常（已记入 journal）: ${String(e).slice(0, 60)}`
								});
							} else skipped.push({
								path: victim,
								reason: `处理失败: ${String(e).slice(0, 80)}`
							});
						}
					}
				}
			} catch (e) {
				const error = ioError("去重执行失败", e);
				return err(journal.length > 0 ? {
					...error,
					details: {
						...error.details,
						journal,
						linkedFiles,
						bytesSaved
					}
				} : error);
			}
			return ok({
				linkedFiles,
				bytesSaved,
				journal,
				skipped,
				cancelled
			});
		},
		async undo(journal) {
			let undone = 0;
			const failed = [];
			for (const entry of journal) try {
				copyAtomic(entry.canonical, entry.victim);
				undone++;
			} catch (e) {
				failed.push({
					victim: entry.victim,
					error: String(e).slice(0, 120)
				});
			}
			return ok({
				undone,
				failed
			});
		}
	};
}
//#endregion
//#region src/engine/restore-point.ts
/** home 级关键配置（不含 profile 子目录） */
const HOME_FILES = [
	"package.json",
	"pnpm-workspace.yaml",
	"cordis.patch.yml"
];
/** profile 级关键配置（多一个 lockfile：依赖状态也是可恢复资产） */
const PROFILE_FILES = [
	"package.json",
	"pnpm-workspace.yaml",
	"cordis.patch.yml",
	"pnpm-lock.yaml"
];
function createRestorePointManager(options) {
	const now = options.now ?? (() => /* @__PURE__ */ new Date());
	const rootDir = path.join(options.nukeRoot, "restore-points");
	function metaPath(id) {
		if (!/^rp-[0-9TZ -]+-[0-9a-f]+$/i.test(id)) return "";
		return path.join(rootDir, id, "meta.json");
	}
	/** 子路径是否严格位于 parent 之内（防 meta 篡改后的任意路径读写） */
	function within(parent, child) {
		const rel = path.relative(path.resolve(parent), path.resolve(child));
		return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
	}
	function readMeta(id) {
		const p = metaPath(id);
		if (!p) return null;
		try {
			const m = JSON.parse(fs.readFileSync(p, "utf-8"));
			if (m.id !== id) return null;
			if (typeof m.createdAt !== "string" || typeof m.actor !== "string") return null;
			if (!Array.isArray(m.files)) return null;
			for (const f of m.files) if (typeof f?.source !== "string" || typeof f?.snapshot !== "string") return null;
			return m;
		} catch {
			return null;
		}
	}
	return {
		async create(input) {
			try {
				if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(input.profile)) return err({
					code: "E_VALIDATION",
					message: `profile 名非法: ${input.profile}`
				});
				const id = `rp-${now().toISOString().replace(/[:.]/g, "")}-${crypto.randomBytes(4).toString("hex")}`;
				const dir = path.join(rootDir, id);
				fs.mkdirSync(dir, { recursive: true });
				const files = [];
				const trySnap = (source, rel) => {
					if (!fs.existsSync(source)) return;
					try {
						const snapshot = path.join(dir, rel);
						const bytes = copyAtomic(source, snapshot);
						files.push({
							source,
							snapshot,
							bytes
						});
					} catch {}
				};
				for (const f of HOME_FILES) trySnap(path.join(options.dshHome, f), path.join("home", f));
				const profileDir = path.join(options.dshHome, "profiles", input.profile);
				for (const f of PROFILE_FILES) trySnap(path.join(profileDir, f), path.join(`profile-${input.profile}`, f));
				if (files.length === 0) {
					fs.rmSync(dir, {
						recursive: true,
						force: true
					});
					return err({
						code: "E_VALIDATION",
						message: `无可快照的配置文件（profile "${input.profile}" 不存在？）`
					});
				}
				const meta = {
					id,
					createdAt: now().toISOString(),
					actor: input.actor,
					reason: input.reason,
					profile: input.profile,
					files
				};
				writeJsonAtomic(path.join(dir, "meta.json"), meta);
				return ok(meta);
			} catch (e) {
				return err(ioError("创建还原点失败", e));
			}
		},
		list() {
			try {
				return fs.readdirSync(rootDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => readMeta(e.name)).filter((m) => m !== null).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
			} catch {
				return [];
			}
		},
		async restore(id) {
			const meta = readMeta(id);
			if (!meta) return err({
				code: "E_VALIDATION",
				message: `还原点不存在或已损坏: ${id}`
			});
			const rpDir = path.join(rootDir, id);
			for (const f of meta.files) {
				if (!path.isAbsolute(f.source) || !within(options.dshHome, f.source)) return err({
					code: "E_VALIDATION",
					message: `还原点元数据包含越界路径，拒绝恢复: ${f.source}`
				});
				if (!within(rpDir, f.snapshot)) return err({
					code: "E_VALIDATION",
					message: `还原点快照路径越界，拒绝恢复: ${f.snapshot}`
				});
			}
			try {
				for (const f of meta.files) {
					if (!fs.existsSync(f.snapshot)) continue;
					copyAtomic(f.snapshot, f.source);
				}
				return ok(meta);
			} catch (e) {
				return err(ioError("恢复失败（部分文件可能已写回）", e));
			}
		},
		async prune(keep) {
			if (!Number.isInteger(keep) || keep < 1) return err({
				code: "E_VALIDATION",
				message: "keep 必须为 ≥1 的整数（不允许清空全部还原点）"
			});
			try {
				const victims = this.list().slice(keep);
				for (const v of victims) {
					const target = metaPath(v.id);
					if (!target) continue;
					fs.rmSync(path.dirname(target), {
						recursive: true,
						force: true
					});
				}
				return ok(victims.length);
			} catch (e) {
				return err(ioError("清理还原点失败", e));
			}
		}
	};
}
//#endregion
//#region src/engine/blast-radius.ts
function createBlastRadiusAnalyzer(options) {
	/** 轻量磁盘探测：目标的 node_modules/storages/attachments + 配置引用位置 */
	function probeOnDisk(plugin, profile) {
		const profileDir = path.join(options.dshHome, "profiles", profile);
		let bytes = 0;
		for (const dir of [
			path.join(profileDir, "node_modules", plugin),
			path.join(options.dshHome, "storages", plugin),
			path.join(options.dshHome, "attachments", plugin)
		]) if (fs.existsSync(dir)) bytes += dirSize(dir);
		const refs = [];
		for (const f of [
			path.join(options.dshHome, "cordis.patch.yml"),
			path.join(profileDir, "cordis.patch.yml"),
			path.join(options.dshHome, "pnpm-workspace.yaml")
		]) try {
			if (fs.readFileSync(f, "utf-8").includes(plugin)) refs.push(f);
		} catch {}
		return {
			bytes,
			refs
		};
	}
	return { async simulate(plugins, profile) {
		if (plugins.length === 0) return err({
			code: "E_VALIDATION",
			message: "爆炸半径仿真需要至少一个插件"
		});
		try {
			const g = await options.analyzer.buildGraph(profile);
			if (!g.ok) return g;
			const graph = g.value;
			const removal = new Set(plugins);
			const closure = /* @__PURE__ */ new Set();
			for (const target of plugins) for (const dep of graph.dependentsOf(target)) closure.add(dep);
			const broken = [...closure].filter((p) => !removal.has(p) && !p.startsWith("profile:"));
			const cascade = [...closure].filter((p) => removal.has(p));
			let bytes = 0;
			const refSet = /* @__PURE__ */ new Set();
			for (const plugin of plugins) {
				const { bytes: b, refs } = probeOnDisk(plugin, profile ?? "web");
				bytes += b;
				for (const r of refs) refSet.add(r);
			}
			const riskScore = Math.min(100, broken.length * 25 + cascade.length * 5 + Math.floor(bytes / 1024 ** 3) * 5);
			const riskLevel = riskScore >= 75 ? "extreme" : riskScore >= 50 ? "high" : riskScore >= 25 ? "medium" : "low";
			const advisories = [];
			if (broken.length > 0) advisories.push(`删除将损坏 ${broken.length} 个插件: ${broken.join(", ")} —— 将它们加入同批删除清单（有意级联），或先解除其依赖`);
			if (cascade.length > 0) advisories.push(`${cascade.length} 个插件随目标级联删除（同批），请确认这是预期行为`);
			if (bytes > 1024 ** 3) advisories.push(`预估回收超过 1GB，建议先 dry-run 核对操作清单`);
			if (advisories.length === 0) advisories.push("无外部波及，可以安全进入 dry-run → commit 流程");
			return ok({
				targets: plugins,
				cascadeRemovable: cascade,
				brokenDependents: broken,
				configRefs: [...refSet],
				estimatedBytesReclaimable: bytes,
				riskScore,
				riskLevel,
				advisories
			});
		} catch (e) {
			return err(ioError("爆炸半径仿真失败", e));
		}
	} };
}
//#endregion
//#region src/engine/trend-tracker.ts
const MS_PER_DAY = 864e5;
function median(values) {
	const s = [...values].sort((a, b) => a - b);
	const n = s.length;
	return n % 2 === 1 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
}
/** 快照净化：JSONL 历史可能含损坏/陈旧格式条目（缺字段、非法日期、非有限数）。
*  NaN 是传染性的 —— 一个坏点会让 slope/σ̂/预测全部变 NaN，进而污染
*  daysUntilFull 与异常告警。在入口整条剔除，宁缺毋滥。 */
function sanitizeSnapshots(snaps) {
	return snaps.filter((s) => typeof s.at === "string" && Number.isFinite(Date.parse(s.at)) && typeof s.bytesReclaimable === "number" && Number.isFinite(s.bytesReclaimable));
}
function createTrendTracker(options) {
	const file = path.join(options.historyDir, "trend.jsonl");
	const readAll = () => readJsonl(file) ?? [];
	/** Theil-Sen 稳健回归：斜率 = 全部成对斜率的中位数；截距 = median(y - slope·x)。
	*  O(n²) 对 —— 快照量级（数百）下毫秒级；完美线性数据下与 LS 完全一致。 */
	function regress(points) {
		const n = points.length;
		if (n < 2) return {
			slope: 0,
			intercept: n === 1 ? points[0].y : 0
		};
		const slopes = [];
		for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
			const dx = points[j].x - points[i].x;
			if (dx !== 0) {
				const s = (points[j].y - points[i].y) / dx;
				if (Number.isFinite(s)) slopes.push(s);
			}
		}
		if (slopes.length === 0) return {
			slope: 0,
			intercept: median(points.map((p) => p.y))
		};
		const slope = median(slopes);
		const intercept = median(points.map((p) => p.y - slope * p.x));
		if (!Number.isFinite(slope) || !Number.isFinite(intercept)) return {
			slope: 0,
			intercept: median(points.map((p) => p.y))
		};
		return {
			slope,
			intercept
		};
	}
	/** MAD×1.4826：对正态数据等价于标准差，但对离群点稳健（阈值不被污染） */
	function robustSigma(residuals) {
		const med = median(residuals);
		return 1.4826 * median(residuals.map((r) => Math.abs(r - med)));
	}
	return {
		async record(snapshot) {
			try {
				appendJsonl(file, snapshot);
				return ok(void 0);
			} catch (e) {
				return err(ioError("趋势快照写入失败", e));
			}
		},
		async analyze(profile) {
			try {
				const all = sanitizeSnapshots(readAll().filter((s) => profile === void 0 || s.profile === profile)).sort((a, b) => a.at.localeCompare(b.at));
				const n = all.length;
				const points = all.map((s) => ({
					x: Date.parse(s.at),
					y: s.bytesReclaimable
				}));
				let bytesPerDay = 0;
				let projected30dBytes = null;
				let anomalyDetail = null;
				if (n >= 2) {
					const { slope, intercept } = regress(points);
					bytesPerDay = slope * MS_PER_DAY;
					const lastX = points[n - 1].x;
					projected30dBytes = Math.max(0, intercept + slope * (lastX + 30 * MS_PER_DAY));
					if (n >= 3) {
						const train = points.slice(0, -1);
						const fit = regress(train);
						const sd = robustSigma(train.map((p) => p.y - (fit.intercept + fit.slope * p.x)));
						const predicted = fit.intercept + fit.slope * points[n - 1].x;
						const lastResidual = points[n - 1].y - predicted;
						if (sd > 0 ? Math.abs(lastResidual) > 3 * sd : lastResidual !== 0) anomalyDetail = `最新快照显著偏离趋势（3σ̂ ${lastResidual > 0 ? "激增" : "骤降"}）—— 可能存在插件失控写盘或清理异常`;
					}
				}
				return ok({
					snapshotCount: n,
					firstAt: n > 0 ? all[0].at : null,
					lastAt: n > 0 ? all[n - 1].at : null,
					bytesPerDay: Number.isFinite(bytesPerDay) ? bytesPerDay : 0,
					projected30dBytes: projected30dBytes !== null && Number.isFinite(projected30dBytes) ? projected30dBytes : null,
					anomaly: {
						detected: anomalyDetail !== null,
						detail: anomalyDetail
					},
					latest: n > 0 ? all[n - 1] : null
				});
			} catch (e) {
				return err(ioError("趋势分析失败", e));
			}
		}
	};
}
//#endregion
//#region src/infra/policy-guard.ts
const DEFAULT_POLICY = {
	version: 1,
	protectedPlugins: [],
	maxPluginsPerTx: null,
	maxReclaimBytesPerTx: null,
	minFreeDiskBytes: null,
	blackout: null
};
function createPolicyGuard(options) {
	const now = options.now ?? (() => /* @__PURE__ */ new Date());
	function freeBytes(root) {
		if (options.freeBytesOf) return options.freeBytesOf(root);
		return statfsBytes(root)?.free ?? null;
	}
	function load() {
		try {
			const raw = JSON.parse(fs.readFileSync(options.policyFile, "utf-8"));
			return {
				version: 1,
				protectedPlugins: Array.isArray(raw.protectedPlugins) ? raw.protectedPlugins.filter((x) => typeof x === "string") : [],
				maxPluginsPerTx: typeof raw.maxPluginsPerTx === "number" ? raw.maxPluginsPerTx : null,
				maxReclaimBytesPerTx: typeof raw.maxReclaimBytesPerTx === "number" ? raw.maxReclaimBytesPerTx : null,
				minFreeDiskBytes: typeof raw.minFreeDiskBytes === "number" ? raw.minFreeDiskBytes : null,
				blackout: raw.blackout && typeof raw.blackout.startHour === "number" && typeof raw.blackout.endHour === "number" ? {
					startHour: raw.blackout.startHour,
					endHour: raw.blackout.endHour
				} : null
			};
		} catch {
			return DEFAULT_POLICY;
		}
	}
	function check(request) {
		try {
			const policy = load();
			const violations = [];
			const protectedHit = request.plugins.filter((p) => policy.protectedPlugins.includes(p));
			if (protectedHit.length > 0) violations.push({
				rule: "PROTECTED_PLUGIN",
				blocking: true,
				offending: protectedHit,
				message: `保护名单插件禁止删除: ${protectedHit.join(", ")}`
			});
			if (policy.maxPluginsPerTx !== null && request.plugins.length > policy.maxPluginsPerTx) violations.push({
				rule: "TOO_MANY_PLUGINS",
				blocking: true,
				message: `单事务插件数 ${request.plugins.length} 超过上限 ${policy.maxPluginsPerTx}（防批量误删，请分批）`
			});
			if (policy.maxReclaimBytesPerTx !== null && request.estimatedBytes !== null && request.estimatedBytes > policy.maxReclaimBytesPerTx) violations.push({
				rule: "RECLAIM_CAP",
				blocking: true,
				message: `计划回收量超上限（预估 ${request.estimatedBytes} > ${policy.maxReclaimBytesPerTx}）—— 异常大的预估通常是计划出错的信号`
			});
			if (policy.minFreeDiskBytes !== null) {
				const free = freeBytes(options.diskRoot);
				if (free !== null && free < policy.minFreeDiskBytes) violations.push({
					rule: "LOW_FREE_DISK",
					blocking: true,
					message: `磁盘余量不足（${free} < ${policy.minFreeDiskBytes}）：清理的备份/回收区本身需要空间`
				});
			}
			if (policy.blackout) {
				const hour = now().getHours();
				const { startHour, endHour } = policy.blackout;
				if (startHour <= endHour ? hour >= startHour && hour < endHour : hour >= startHour || hour < endHour) violations.push({
					rule: "BLACKOUT_WINDOW",
					blocking: true,
					message: `当前处于清理黑窗期（${startHour}:00-${endHour}:00），拒绝执行`
				});
			}
			return ok(violations);
		} catch (e) {
			return err(ioError("策略检查失败", e));
		}
	}
	function asPreHook() {
		return {
			id: "policy-guard",
			timing: "pre",
			actions: "*",
			priority: -100,
			onFailure: "best-effort",
			handler: {
				type: "inline",
				run: async (ctx) => {
					if (load().protectedPlugins.includes(ctx.plugin)) return {
						kind: "veto",
						reason: `策略守卫: "${ctx.plugin}" 在保护名单中`
					};
				}
			}
		};
	}
	return {
		load,
		check,
		asPreHook
	};
}
//#endregion
//#region src/engine/disk-forecaster.ts
const DAY_MS = 864e5;
function createDiskForecaster(options) {
	function sample() {
		if (options.sampleDisk) return options.sampleDisk(options.diskRoot);
		return statfsBytes(options.diskRoot);
	}
	return { async forecast() {
		try {
			const now = options.clock.now();
			const trendR = await options.trend.analyze();
			if (!trendR.ok) return trendR;
			const trend = trendR.value;
			const disk = sample();
			const growth = trend.snapshotCount >= 2 && trend.bytesPerDay > 0 ? trend.bytesPerDay : null;
			let daysUntilFull = null;
			let projectedFullAt = null;
			if (disk !== null && growth !== null && growth > 0 && disk.free > 0) {
				daysUntilFull = disk.free / growth;
				projectedFullAt = new Date(now.getTime() + daysUntilFull * DAY_MS).toISOString();
			}
			let severity = "ok";
			if (disk !== null && disk.total > 0) {
				const usedPct = (disk.total - disk.free) / disk.total * 100;
				if (usedPct >= 95) severity = "critical";
				else if (usedPct >= 85) severity = "warning";
				else if (usedPct >= 70) severity = "watch";
			}
			if (daysUntilFull !== null) {
				if (daysUntilFull <= 3) severity = "critical";
				else if (daysUntilFull <= 14 && severity !== "critical") severity = "warning";
				else if (daysUntilFull <= 30 && severity === "ok") severity = "watch";
			}
			if (trend.anomaly.detected && severity === "ok") severity = "watch";
			let recommendation;
			switch (severity) {
				case "critical":
					recommendation = "磁盘即将写满：立即 nuke_doctor 体检 → 按处方 nuke_clean（balanced），必要时 nuke_dedup 核查跨 profile 冗余";
					break;
				case "warning":
					recommendation = "磁盘余量承压：建议 nuke_orphans 扫一遍孤儿 → dry-run 评估回收量后执行";
					break;
				case "watch":
					recommendation = "保持观察：残留仍在增长，建议运行 nuke_doctor 获取处方";
					break;
				default: recommendation = trend.snapshotCount < 2 ? "趋势数据不足：多跑几次 nuke_scan 后即可获得预测能力" : "磁盘健康，按需清理即可";
			}
			return ok({
				sampledAt: now.toISOString(),
				totalBytes: disk?.total ?? null,
				freeBytes: disk?.free ?? null,
				usedPct: disk && disk.total > 0 ? Math.round((disk.total - disk.free) / disk.total * 1e3) / 10 : null,
				growthBytesPerDay: growth,
				daysUntilFull,
				projectedFullAt,
				severity,
				recommendation,
				trendBasis: {
					snapshotCount: trend.snapshotCount,
					bytesPerDay: trend.bytesPerDay,
					anomaly: trend.anomaly
				}
			});
		} catch (e) {
			return err(ioError("磁盘预测失败", e));
		}
	} };
}
//#endregion
//#region src/contracts/guardian.contract.ts
const DEFAULT_GUARDIAN_THRESHOLDS = {
	criticalDaysUntilFull: 3,
	warningDaysUntilFull: 14,
	backlogBytes: 2 * 1024 ** 3,
	minHealthScore: 60
};
//#endregion
//#region src/engine/guardian.ts
const SEV_ORDER = {
	critical: 0,
	warning: 1,
	info: 2
};
function createGuardian(deps) {
	return { async patrol(patrolOptions) {
		try {
			const profile = patrolOptions?.profile ?? "web";
			const th = {
				...DEFAULT_GUARDIAN_THRESHOLDS,
				...patrolOptions?.thresholds
			};
			const alerts = [];
			const partialFailures = [];
			let disk = null;
			const diskR = await deps.forecaster.forecast();
			if (diskR.ok) {
				disk = diskR.value;
				if (disk.daysUntilFull !== null) {
					if (disk.daysUntilFull <= th.criticalDaysUntilFull) alerts.push({
						kind: "DISK_CRITICAL",
						severity: "critical",
						message: `磁盘约 ${disk.daysUntilFull.toFixed(1)} 天后写满（余量 ${disk.freeBytes} 字节，日增 ${Math.round(disk.growthBytesPerDay ?? 0)}）`,
						suggestedTool: "nuke_doctor"
					});
					else if (disk.daysUntilFull <= th.warningDaysUntilFull) alerts.push({
						kind: "DISK_WARNING",
						severity: "warning",
						message: `磁盘 ${disk.daysUntilFull.toFixed(1)} 天后写满，开始规划清理`,
						suggestedTool: "nuke_orphans"
					});
				}
			} else partialFailures.push(`disk: ${diskR.error.message}`);
			let trend = null;
			const trendR = await deps.trend.analyze();
			if (trendR.ok) {
				trend = trendR.value;
				if (trend.anomaly.detected) alerts.push({
					kind: "TREND_ANOMALY",
					severity: "warning",
					message: trend.anomaly.detail ?? "残留量异常突变",
					suggestedTool: "nuke_doctor"
				});
			} else partialFailures.push(`trend: ${trendR.error.message}`);
			let doctor = null;
			const doctorR = await deps.doctor.diagnose(profile);
			if (doctorR.ok) {
				doctor = doctorR.value;
				if (doctor.blocking) alerts.push({
					kind: "HEALTH_BLOCKING",
					severity: "critical",
					message: `健康检查存在阻断项（评分 ${doctor.healthScore}/100），清理事务将被拒绝`,
					suggestedTool: "nuke_health"
				});
				else if (doctor.healthScore < th.minHealthScore) alerts.push({
					kind: "HEALTH_DROP",
					severity: "warning",
					message: `健康度 ${doctor.healthScore}/100 低于阈值 ${th.minHealthScore}`,
					suggestedTool: "nuke_health"
				});
				if (doctor.totalReclaimableBytes >= th.backlogBytes) alerts.push({
					kind: "RECLAIM_BACKLOG",
					severity: "warning",
					message: `可回收空间积压超阈值（${doctor.totalReclaimableBytes} ≥ ${th.backlogBytes}）`,
					suggestedTool: "nuke_clean"
				});
			} else partialFailures.push(`doctor: ${doctorR.error.message}`);
			const unfinished = deps.unfinishedTxIds();
			if (unfinished.length > 0) alerts.push({
				kind: "UNFINISHED_TX",
				severity: "critical",
				message: `检测到 ${unfinished.length} 个未终结事务（崩溃残留）: ${unfinished.join(", ")}`,
				suggestedTool: "nuke_recover"
			});
			alerts.sort((a, b) => SEV_ORDER[a.severity] - SEV_ORDER[b.severity] || a.kind.localeCompare(b.kind));
			return ok({
				patrolledAt: deps.clock.now().toISOString(),
				profile,
				alerts,
				disk,
				trend,
				doctor,
				partialFailures
			});
		} catch (e) {
			return err(ioError("守卫者巡检失败", e));
		}
	} };
}
//#endregion
//#region src/infra/ledger.ts
function createLedger(options) {
	const file = path.join(options.historyDir, "ledger.jsonl");
	const readAll = () => readJsonl(file) ?? [];
	function filterOf(filter) {
		return (e) => (filter?.kind === void 0 || e.kind === filter.kind) && (filter?.profile === void 0 || e.profile === filter.profile) && (filter?.since === void 0 || e.at >= filter.since);
	}
	function breakdown(entries, keyOf) {
		const map = /* @__PURE__ */ new Map();
		for (const e of entries) {
			const key = keyOf(e);
			const cur = map.get(key) ?? {
				bytes: 0,
				count: 0
			};
			cur.bytes += e.bytes;
			cur.count++;
			map.set(key, cur);
		}
		return [...map.entries()].map(([key, v]) => ({
			key,
			...v
		})).sort((a, b) => b.bytes - a.bytes);
	}
	return {
		async record(entry) {
			try {
				appendJsonl(file, entry);
				return ok(void 0);
			} catch (e) {
				return err(ioError("台账写入失败", e));
			}
		},
		async query(filter) {
			try {
				const all = readAll().filter(filterOf(filter));
				const freed = all.filter((e) => e.kind === "freed");
				const pending = all.filter((e) => e.kind === "pending");
				return ok({
					totalFreed: freed.reduce((s, e) => s + e.bytes, 0),
					totalPending: pending.reduce((s, e) => s + e.bytes, 0),
					entryCount: all.length,
					byAction: breakdown(all, (e) => e.action),
					byProfile: breakdown(all, (e) => e.profile),
					byDay: [...breakdown(all, (e) => e.at.slice(0, 10))].sort((a, b) => a.key.localeCompare(b.key))
				});
			} catch (e) {
				return err(ioError("台账查询失败", e));
			}
		},
		entries(filter, limit = 50) {
			return readAll().filter(filterOf(filter)).sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit);
		}
	};
}
//#endregion
//#region src/infra/reliability.ts
function quantile(sorted, q) {
	if (sorted.length === 0) return 0;
	const pos = (sorted.length - 1) * q;
	const lo = Math.floor(pos);
	const hi = Math.ceil(pos);
	if (lo === hi) return sorted[lo];
	return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}
function clamp01(n) {
	return Math.min(1, Math.max(0, n));
}
async function createReliabilityModel(options) {
	const kappa = options.shrinkage ?? 10;
	const minCal = options.minCalibrationSamples ?? 3;
	const entries = await options.audit.query(options.since !== void 0 ? { since: options.since } : {});
	const stats = /* @__PURE__ */ new Map();
	let pooledS = 0;
	let pooledF = 0;
	for (const e of entries) {
		if (!e.action.startsWith("op:")) continue;
		if (e.outcome === "skipped") continue;
		const action = e.action.slice(3);
		const s = stats.get(action) ?? {
			successes: 0,
			failures: 0,
			ratios: []
		};
		if (e.outcome === "success") {
			s.successes++;
			pooledS++;
			const est = e.detail.estimated;
			const act = e.detail.actual;
			if (typeof est === "number" && typeof act === "number" && est > 0) s.ratios.push(act / est);
		} else {
			s.failures++;
			pooledF++;
		}
		stats.set(action, s);
	}
	const mu = (pooledS + 1) / (pooledS + pooledF + 2);
	const sampleCount = pooledS + pooledF;
	function build(action, s) {
		const succ = s?.successes ?? 0;
		const fail = s?.failures ?? 0;
		const alpha = mu * kappa + succ;
		const beta = (1 - mu) * kappa + fail;
		const mean = alpha / (alpha + beta);
		const sd = Math.sqrt(alpha * beta / ((alpha + beta) ** 2 * (alpha + beta + 1)));
		const ratios = [...s?.ratios ?? []].sort((a, b) => a - b);
		const calibration = ratios.length >= minCal ? {
			samples: ratios.length,
			p10: quantile(ratios, .1),
			p50: quantile(ratios, .5),
			p90: quantile(ratios, .9)
		} : null;
		return {
			action,
			successes: succ,
			failures: fail,
			successProbability: mean,
			ci95: [clamp01(mean - 1.96 * sd), clamp01(mean + 1.96 * sd)],
			selfWeight: (succ + fail) / (succ + fail + kappa),
			calibration
		};
	}
	const snapshot = /* @__PURE__ */ new Map();
	for (const [action, s] of stats) snapshot.set(action, build(action, s));
	return {
		sampleCount,
		globalSuccessProbability: mu,
		byAction: () => snapshot,
		reliabilityOf: (action) => snapshot.get(action) ?? build(action, void 0)
	};
}
//#endregion
//#region src/engine/oracle.ts
/** preview 阶段触碰备份区 = 副作用逃逸，立即引爆（防御性纪律） */
const BOMB_BACKUPS = {
	stageFile: () => {
		throw new Error("ORACLE_SHADOW: preview 不得触碰备份区（副作用逃逸）");
	},
	stageDir: () => {
		throw new Error("ORACLE_SHADOW: preview 不得触碰备份区（副作用逃逸）");
	},
	stageEdit: () => {
		throw new Error("ORACLE_SHADOW: preview 不得触碰备份区（副作用逃逸）");
	}
};
function createOracle(deps) {
	return { async divine(request) {
		try {
			const shadowCtx = {
				txId: "oracle-shadow",
				request,
				resolver: deps.resolver,
				logger: deps.logger.child({ oracle: true }),
				clock: deps.clock,
				backups: BOMB_BACKUPS
			};
			const ops = deps.operationFactory(request);
			const previews = [];
			for (const op of ops) {
				const p = await op.preview(shadowCtx);
				previews.push({
					op,
					summary: p.summary,
					estimated: p.estimatedBytesReclaimable
				});
			}
			const rel = await deps.reliability();
			const steps = [];
			const suffix = new Array(previews.length + 1).fill(0);
			for (let i = previews.length - 1; i >= 0; i--) suffix[i] = suffix[i + 1] + previews[i].estimated;
			for (const [i, pv] of previews.entries()) {
				const r = rel.reliabilityOf(pv.op.action);
				steps.push({
					index: i,
					action: pv.op.action,
					operationId: pv.op.id,
					summary: pv.summary,
					estimatedBytes: pv.estimated,
					successProbability: r.successProbability,
					exposureBytes: suffix[i],
					calibration: r.calibration
				});
			}
			const pSuccess = steps.reduce((acc, s) => acc * s.successProbability, 1);
			const calOf = (s, q) => {
				const c = s.calibration;
				return c ? c[q] : 1;
			};
			const q10 = steps.reduce((acc, s) => acc + s.estimatedBytes * calOf(s, "p10"), 0);
			const q50 = steps.reduce((acc, s) => acc + s.estimatedBytes * calOf(s, "p50"), 0);
			const q90 = steps.reduce((acc, s) => acc + s.estimatedBytes * calOf(s, "p90"), 0);
			const expectedReclaim = pSuccess * q50;
			let weakest = null;
			for (const s of steps) {
				const vuln = (1 - s.successProbability) * s.exposureBytes;
				if (vuln > (weakest ? (1 - weakest.successProbability) * weakest.exposureBytes : -1) && vuln > 0) weakest = {
					index: s.index,
					action: s.action,
					successProbability: s.successProbability,
					exposureBytes: s.exposureBytes
				};
			}
			let rollbackDepth = 0;
			let reach = 1;
			for (const s of steps) {
				rollbackDepth += reach * (1 - s.successProbability) * s.index;
				reach *= s.successProbability;
			}
			let broken = null;
			if (deps.blastRadius && request.plugins.length > 0) try {
				const b = await deps.blastRadius.simulate(request.plugins, request.profile);
				if (b.ok) broken = b.value.brokenDependents;
			} catch {
				broken = null;
			}
			let diskExtensionDays = null;
			if (deps.forecaster && expectedReclaim > 0) try {
				const f = await deps.forecaster.forecast();
				if (f.ok && f.value.daysUntilFull !== null && f.value.growthBytesPerDay !== null && f.value.growthBytesPerDay > 0) diskExtensionDays = expectedReclaim / f.value.growthBytesPerDay;
			} catch {
				diskExtensionDays = null;
			}
			const confidence = rel.sampleCount >= 30 ? "high" : rel.sampleCount >= 5 ? "medium" : "low";
			return ok({
				request,
				steps,
				totalEstimatedBytes: suffix[0] ?? 0,
				transactionSuccessProbability: pSuccess,
				expectedReclaimBytes: expectedReclaim,
				reclaimP10IfSuccess: q10,
				reclaimP90IfSuccess: q90,
				weakestStep: weakest,
				expectedRollbackDepth: rollbackDepth,
				brokenDependents: broken,
				diskExtensionDays,
				confidence,
				narrative: narrate(pSuccess, expectedReclaim, weakest, broken, confidence),
				evidence: {
					stepSamples: rel.sampleCount,
					globalSuccessProbability: rel.globalSuccessProbability
				}
			});
		} catch (e) {
			return err(ioError("先知推演失败", e));
		}
	} };
}
function narrate(p, expected, weakest, broken, confidence) {
	const pct = (p * 100).toFixed(1);
	const parts = [];
	parts.push(`事务成功率 ${pct}%，期望回收 ${fmtBytes(expected)}`);
	if (weakest && (1 - weakest.successProbability) * weakest.exposureBytes > 0) parts.push(`最脆弱环节是第 ${weakest.index} 步 ${weakest.action}（成功率 ${(weakest.successProbability * 100).toFixed(0)}%，失败将作废 ${fmtBytes(weakest.exposureBytes)} 潜在回收）`);
	if (broken && broken.length > 0) parts.push(`⚠️ 将损坏 ${broken.length} 个外部依赖方（${broken.join(", ")}），建议先解除依赖或同批删除`);
	else if (p >= .85) parts.push("各环节可靠，可放心进入 dry-run → commit");
	if (confidence === "low") parts.push("历史样本不足，预测以保守先验为主 —— 执行越多，先知越准");
	return parts.join("；") + "。";
}
//#endregion
//#region src/engine/drill.ts
const VICTIM = "drill-victim";
const DATA_BYTES = 262144;
function createDrill(options) {
	const logger = options.logger ?? createLogger({
		sink: "plain",
		minLevel: "error"
	});
	const keepRuns = options.keepRuns ?? 5;
	return { async run(runOptions) {
		const startedMs = Date.now();
		const afterStep = runOptions?.afterStep ?? 1;
		const runId = `${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}`;
		const sandbox = path.join(options.nukeRoot, "drill", runId);
		const home = path.join(sandbox, "home");
		const state = path.join(sandbox, "state");
		const victimDir = path.join(home, "storages", VICTIM);
		const patchFile = path.join(home, "cordis.patch.yml");
		const TOTAL_STEPS = 2;
		if (!Number.isInteger(afterStep) || afterStep < 1 || afterStep > TOTAL_STEPS) return err({
			code: "E_VALIDATION",
			message: `afterStep 必须为 1..${TOTAL_STEPS} 的整数（沙箱剧本共 ${TOTAL_STEPS} 步）`
		});
		const checks = [];
		const check = (name, passed, detail) => {
			checks.push({
				name,
				passed,
				detail
			});
		};
		try {
			fs.mkdirSync(victimDir, { recursive: true });
			fs.mkdirSync(state, { recursive: true });
			const payload = crypto.randomBytes(DATA_BYTES);
			fs.writeFileSync(path.join(victimDir, "data.bin"), payload);
			const dataSha = crypto.createHash("sha256").update(payload).digest("hex");
			const patchOriginal = `- id: keep\n- id: ${VICTIM}\n`;
			fs.writeFileSync(patchFile, patchOriginal);
			const sandboxResolver = {
				platform: () => ({
					os: "linux",
					home,
					tempRoot: path.join(sandbox, "tmp"),
					dshHome: home,
					pathSep: "/"
				}),
				canonicalize: async (p) => ok(p),
				isWithin: async () => true,
				assertDeletable: async (p) => ok(p),
				profileDir: () => path.join(home, "profiles", "web"),
				storagesRoot: () => path.join(home, "storages"),
				attachmentsRoot: () => path.join(home, "attachments"),
				dshHomePatchFile: () => patchFile,
				nukeStateRoot: () => state
			};
			const ops = () => [{
				id: "drill-stage-dir",
				action: "remove-storages",
				target: VICTIM,
				async preview() {
					return {
						summary: `移除 storages/${VICTIM}`,
						touchedPaths: [victimDir],
						estimatedBytesReclaimable: DATA_BYTES,
						requiresExclusiveLock: true
					};
				},
				async validate() {
					return ok(void 0);
				},
				async execute(ctx) {
					if (!fs.existsSync(victimDir)) return ok({
						outcome: {
							bytesFreed: 0,
							message: "跳过（不存在）"
						},
						backup: null
					});
					const backup = await ctx.backups.stageDir(victimDir);
					return ok({
						outcome: {
							bytesFreed: DATA_BYTES,
							message: "已移入回收区"
						},
						backup
					});
				},
				async undo() {
					return ok(void 0);
				}
			}, {
				id: "drill-edit-patch",
				action: "clean-home-patch",
				target: VICTIM,
				async preview() {
					return {
						summary: "摘除 cordis.patch.yml 引用",
						touchedPaths: [patchFile],
						estimatedBytesReclaimable: 5,
						requiresExclusiveLock: true
					};
				},
				async validate() {
					return ok(void 0);
				},
				async execute(ctx) {
					const original = fs.readFileSync(patchFile, "utf-8");
					const next = original.split("\n").filter((l) => !l.includes(VICTIM)).join("\n");
					if (next === original) return ok({
						outcome: {
							bytesFreed: 0,
							message: "无需变更"
						},
						backup: null
					});
					return ok({
						outcome: {
							bytesFreed: 5,
							message: "已清理引用"
						},
						backup: await ctx.backups.stageEdit(patchFile, next)
					});
				},
				async undo() {
					return ok(void 0);
				}
			}];
			const backups1 = createBackupStore({ backupRoot: path.join(state, "backups") });
			const engine1 = createTransactionEngine({
				lockManager: createLockManager({ lockRoot: state }),
				wal: createWal({ walRoot: path.join(state, "tx") }),
				backups: backups1,
				audit: createAuditLog({ filePath: path.join(state, "audit", "chain.jsonl") }),
				resolver: sandboxResolver,
				logger,
				hooks: createHookRegistry({ dir: path.join(state, "hooks") }),
				clock: { now: () => /* @__PURE__ */ new Date() },
				crashAfterStep: afterStep - 1
			}, ops);
			const request = {
				plugins: [VICTIM],
				profile: "web",
				strategy: "safe",
				dryRun: false,
				actor: "chaos-drill"
			};
			let crashed = false;
			let crashMessage = "";
			let txId = "";
			try {
				const session = await engine1.begin(request);
				if (!session.ok) return err(session.error);
				txId = session.value.txId;
				const plan = await engine1.plan(session.value);
				if (!plan.ok) return err(plan.error);
				await engine1.commit(plan.value);
			} catch (e) {
				if (e instanceof SimulatedCrashError) {
					crashed = true;
					crashMessage = e.message;
				} else return err(ioError("演习事务异常（非预期）", e));
			}
			check("崩溃注入生效", crashed, crashed ? crashMessage : "commit 未抛出 SimulatedCrashError");
			const stagedAway = !fs.existsSync(victimDir);
			check("崩溃现场保真（半执行状态）", stagedAway, stagedAway ? `storages/${VICTIM} 已移入回收区，事务确实中断于第 ${afterStep} 步后` : "受害者目录仍在原位，崩溃未发生在执行中途");
			const lockDir = path.join(state, "locks");
			const lockFile = path.join(lockDir, "global.lock");
			const lockDangling = fs.existsSync(lockFile);
			check("独占锁悬挂（真实崩溃语义）", lockDangling, lockDangling ? "崩溃后锁未释放（进程死亡语义正确）" : "锁意外消失 —— 崩溃模拟不忠实");
			const manifestLen = (await backups1.reserve(txId)).manifest().length;
			if (lockDangling) fs.rmSync(lockDir, {
				recursive: true,
				force: true
			});
			check("锁清理（模拟重启运维）", !fs.existsSync(lockFile), "真实环境由 stale-break 协议处理（需进程死亡+TTL）；沙箱以清锁模拟重启");
			const wal2 = createWal({ walRoot: path.join(state, "tx") });
			const audit2 = createAuditLog({ filePath: path.join(state, "audit", "chain.jsonl") });
			const engine2 = createTransactionEngine({
				lockManager: createLockManager({ lockRoot: state }),
				wal: wal2,
				backups: createBackupStore({ backupRoot: path.join(state, "backups") }),
				audit: audit2,
				resolver: sandboxResolver,
				logger,
				hooks: createHookRegistry({ dir: path.join(state, "hooks") }),
				clock: { now: () => /* @__PURE__ */ new Date() }
			}, ops);
			const recovery = await engine2.recover();
			const recovered = recovery.ok ? recovery.value : [];
			check("崩溃恢复：事务回滚", recovery.ok && recovered.length === 1 && recovered[0].state === "rolled-back", recovery.ok ? `recover() 恢复 ${recovered.length} 个事务（state=${recovered[0]?.state ?? "n/a"}）` : `recover() 失败: ${recovery.error.message}`);
			const dataPath = path.join(victimDir, "data.bin");
			let dataRestored = false;
			let dataDetail = "数据文件未还原";
			try {
				const back = fs.readFileSync(dataPath);
				dataRestored = crypto.createHash("sha256").update(back).digest("hex") === dataSha;
				dataDetail = dataRestored ? `${DATA_BYTES / 1024}KB 数据字节级一致（sha256 匹配）` : "内容与崩溃前不一致";
			} catch {}
			check("数据字节级还原", dataRestored, dataDetail);
			let patchRestored = false;
			let patchDetail = "配置未还原";
			try {
				patchRestored = fs.readFileSync(patchFile, "utf-8") === patchOriginal;
				patchDetail = patchRestored ? "cordis.patch.yml 恢复为崩溃前内容" : "patch 内容与崩溃前不一致";
			} catch {}
			check("配置引用还原", patchRestored, patchDetail);
			const chain = await audit2.verify();
			check("审计链完整（hash chain）", chain.valid, chain.valid ? `${chain.totalEntries} 条审计记录链式校验通过` : `链在 seq=${chain.firstBrokenSeq} 处断裂`);
			const unfinished = wal2.unfinishedTxIds();
			check("WAL 无未终结事务", unfinished.length === 0, unfinished.length === 0 ? "全部事务已终结（tx-commit/tx-rollback）" : `残留未终结: ${unfinished.join(", ")}`);
			const again = await engine2.begin(request);
			let unblocked = false;
			let unblockDetail = "begin 失败";
			if (again.ok) {
				const rb = await engine2.rollback(again.value.txId);
				if (rb.ok) {
					unblocked = true;
					unblockDetail = "崩溃恢复后新事务可正常开启与终结";
				} else unblockDetail = `新事务回滚失败: ${rb.error.message}`;
			} else unblockDetail = `begin 失败: ${again.error.message}`;
			check("新事务畅通（无永久阻塞）", unblocked, unblockDetail);
			pruneOldRuns(path.join(options.nukeRoot, "drill"), keepRuns);
			return ok({
				runId,
				crashedAtStep: afterStep,
				checks,
				passed: checks.every((c) => c.passed),
				restoredFiles: manifestLen,
				auditChainValid: chain.valid,
				durationMs: Date.now() - startedMs
			});
		} catch (e) {
			return err(ioError("混沌演习执行异常", e));
		}
	} };
}
/** 保留最近 keepRuns 次演习现场（runId 前缀时间戳 → 字典序即时间序） */
function pruneOldRuns(drillRoot, keepRuns) {
	try {
		const dirs = fs.readdirSync(drillRoot).filter((d) => fs.statSync(path.join(drillRoot, d)).isDirectory()).sort();
		for (const d of dirs.slice(0, Math.max(0, dirs.length - keepRuns))) fs.rmSync(path.join(drillRoot, d), {
			recursive: true,
			force: true
		});
	} catch {}
}
//#endregion
//#region src/operations/yaml-edit.ts
function removePluginFromYaml(content, plugin) {
	const esc = plugin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const listItemRe = new RegExp(`^(\\s*)-\\s+id:\\s*${esc}\\s*$`);
	const stringItemRe = new RegExp(`^(\\s*)-\\s*['"]?${esc}['"]?\\s*$`);
	const mapKeyRe = new RegExp(`^(\\s*)['"]?${esc}['"]?\\s*:\\s*.*$`);
	const lines = content.split("\n");
	const keep = [];
	let dropDeeperThan = null;
	let touched = false;
	for (const line of lines) {
		const indent = line.length - line.trimStart().length;
		if (dropDeeperThan !== null) {
			if (line.trim() === "") {
				keep.push({
					line,
					drop: true
				});
				touched = true;
				continue;
			}
			if (indent > dropDeeperThan) {
				keep.push({
					line,
					drop: true
				});
				touched = true;
				continue;
			}
			dropDeeperThan = null;
		}
		const mId = line.match(listItemRe);
		if (mId) {
			dropDeeperThan = mId[1]?.length ?? 0;
			keep.push({
				line,
				drop: true
			});
			touched = true;
			continue;
		}
		if (stringItemRe.test(line)) {
			keep.push({
				line,
				drop: true
			});
			touched = true;
			continue;
		}
		if (mapKeyRe.test(line)) {
			keep.push({
				line,
				drop: true
			});
			touched = true;
			continue;
		}
		keep.push({
			line,
			drop: false
		});
	}
	if (!touched) return null;
	let out = keep.filter((k) => !k.drop).map((k) => k.line).join("\n");
	out = out.replace(/\n{3,}$/, "\n\n");
	if (out.trim().length > 0 && !out.endsWith("\n")) out += "\n";
	return out;
}
//#endregion
//#region src/operations/edit-ops.ts
function makeConfigEditOp(spec) {
	return {
		id: `${spec.id}:${spec.target}`,
		action: spec.action,
		target: spec.target,
		async preview(ctx) {
			const file = spec.fileOf(ctx);
			if (!existsSafe(file)) return {
				summary: `${spec.description}: 文件不存在，跳过（${file}）`,
				touchedPaths: [],
				estimatedBytesReclaimable: 0,
				requiresExclusiveLock: false
			};
			const content = fs.readFileSync(file, "utf-8");
			const next = removePluginFromYaml(content, spec.target);
			const touched = next === null ? [] : [file];
			return {
				summary: next === null ? `${spec.description}: 未发现 ${spec.target} 的引用，跳过` : `${spec.description}: 摘除 ${spec.target} 引用（${content.length - next.length} 字符）`,
				touchedPaths: touched,
				estimatedBytesReclaimable: 0,
				requiresExclusiveLock: false
			};
		},
		async validate(ctx) {
			const file = spec.fileOf(ctx);
			const check = await ctx.resolver.assertDeletable(file, spec.policy);
			if (!check.ok) return check;
			return ok(void 0);
		},
		async execute(ctx) {
			const file = spec.fileOf(ctx);
			if (!existsSafe(file)) return ok({
				outcome: {
					bytesFreed: 0,
					message: "文件不存在，跳过"
				},
				backup: null
			});
			const next = removePluginFromYaml(fs.readFileSync(file, "utf-8"), spec.target);
			if (next === null) return ok({
				outcome: {
					bytesFreed: 0,
					message: "未发现引用，跳过"
				},
				backup: null
			});
			try {
				const backup = await ctx.backups.stageEdit(file, next);
				return ok({
					outcome: {
						bytesFreed: 0,
						message: `${spec.description}: 已摘除 ${spec.target} 引用`
					},
					backup
				});
			} catch (e) {
				return err(ioError(`${spec.description} 失败`, e));
			}
		},
		async undo(ctx, record) {
			if (!record) return ok(void 0);
			return ctx.backups.restore(record);
		}
	};
}
/** 三个配置清理操作的标准策略 */
function configPolicies(profile) {
	const deny = ["**/@deepseek-ai/dsh-base*", "**/.nuke/**"];
	return {
		profileScoped: {
			allowedRoots: [{
				kind: "profile-dir",
				profile
			}],
			denyGlobs: deny,
			strictWindows: true
		},
		homePatch: {
			allowedRoots: [{ kind: "dsh-home-patch" }],
			denyGlobs: deny,
			strictWindows: true
		}
	};
}
/** 便捷构造：单插件的三个配置编辑操作 */
function configEditOps(target, profile, dshHomeOf) {
	const p = configPolicies(profile);
	return [
		makeConfigEditOp({
			id: "op-clean-workspace-yaml",
			action: "clean-workspace-yaml",
			target,
			fileOf: (ctx) => path.join(dshHomeOf(ctx), "profiles", profile, "pnpm-workspace.yaml"),
			description: "清理 pnpm-workspace.yaml",
			policy: p.profileScoped
		}),
		makeConfigEditOp({
			id: "op-clean-profile-patch",
			action: "clean-profile-patch",
			target,
			fileOf: (ctx) => path.join(dshHomeOf(ctx), "profiles", profile, "cordis.patch.yml"),
			description: "清理 profile patch",
			policy: p.profileScoped
		}),
		makeConfigEditOp({
			id: "op-clean-home-patch",
			action: "clean-home-patch",
			target,
			fileOf: (ctx) => path.join(dshHomeOf(ctx), "cordis.patch.yml"),
			description: "清理 home patch",
			policy: p.homePatch
		})
	];
}
//#endregion
//#region src/operations/fs-ops.ts
const DENY = [
	"**/@deepseek-ai/dsh-base*",
	"**/.nuke/**",
	"**/node_modules/.pnpm/**"
];
function makeDirRemoveOp(spec) {
	return {
		id: `${spec.id}:${spec.target}`,
		action: spec.action,
		target: spec.target,
		async preview(ctx) {
			const dir = spec.dirOf(ctx);
			if (!existsSafe(dir)) return {
				summary: `${spec.description}: 目录不存在，跳过（${dir}）`,
				touchedPaths: [],
				estimatedBytesReclaimable: 0,
				requiresExclusiveLock: false
			};
			const bytes = dirSize(dir);
			return {
				summary: `${spec.description}: ${dir}（${bytes} 字节 → 回收区）`,
				touchedPaths: [dir],
				estimatedBytesReclaimable: bytes,
				requiresExclusiveLock: false
			};
		},
		async validate(ctx) {
			const dir = spec.dirOf(ctx);
			const check = await ctx.resolver.assertDeletable(dir, spec.policy);
			if (!check.ok) return check;
			return ok(void 0);
		},
		async execute(ctx) {
			const dir = spec.dirOf(ctx);
			if (!existsSafe(dir)) return ok({
				outcome: {
					bytesFreed: 0,
					message: "目录不存在，跳过"
				},
				backup: null
			});
			try {
				const backup = await ctx.backups.stageDir(dir);
				return ok({
					outcome: {
						bytesFreed: backup.fingerprint.size,
						message: `${spec.description}: 已移入回收区`
					},
					backup
				});
			} catch (e) {
				return err(ioError(`${spec.description} 失败`, e));
			}
		},
		async undo(ctx, record) {
			if (!record) return ok(void 0);
			return ctx.backups.restore(record);
		}
	};
}
/** 便捷构造：单插件的三个目录清理操作 */
function dirRemoveOps(target, profile, dshHomeOf) {
	const profileScoped = {
		allowedRoots: [{
			kind: "profile-dir",
			profile
		}],
		denyGlobs: DENY,
		strictWindows: true
	};
	const storagesPolicy = {
		allowedRoots: [{ kind: "storages" }],
		denyGlobs: DENY,
		strictWindows: true
	};
	const attachmentsPolicy = {
		allowedRoots: [{ kind: "attachments" }],
		denyGlobs: DENY,
		strictWindows: true
	};
	return [
		makeDirRemoveOp({
			id: "op-remove-node-modules",
			action: "remove-node-modules",
			target,
			dirOf: (ctx) => path.join(dshHomeOf(ctx), "profiles", profile, "node_modules", ...target.split("/")),
			description: "移除 node_modules 包目录",
			policy: profileScoped
		}),
		makeDirRemoveOp({
			id: "op-remove-storages",
			action: "remove-storages",
			target,
			dirOf: (ctx) => path.join(dshHomeOf(ctx), "storages", target),
			description: "移除 storages 持久化数据",
			policy: storagesPolicy
		}),
		makeDirRemoveOp({
			id: "op-remove-attachments",
			action: "remove-attachments",
			target,
			dirOf: (ctx) => path.join(dshHomeOf(ctx), "attachments", "v1", target),
			description: "移除 attachments 会话附件",
			policy: attachmentsPolicy
		})
	];
}
const DEFAULT_MARKER = /dsh|deepseek|cordis/i;
function makePurgeTempOp(options) {
	const ttlDays = options.ttlDays ?? 7;
	const now = options.now ?? (() => /* @__PURE__ */ new Date());
	const marker = options.markerRe ?? DEFAULT_MARKER;
	/** 共享实现（fs-utils.tempOrphanEntries）：标记 + 期限 + 体积，符号链接排除 */
	const staleEntries = () => tempOrphanEntries(options.tempRoot, ttlDays, now, marker).map((e) => ({
		entry: e.path,
		isDir: e.isDir,
		size: e.sizeBytes
	}));
	return {
		id: "op-purge-temp:global",
		action: "purge-temp",
		target: "*temp*",
		async preview() {
			const entries = staleEntries();
			const bytes = entries.reduce((s, e) => s + e.size, 0);
			return {
				summary: `TEMP 孤儿清理: ${entries.length} 个过期条目（≥${ttlDays} 天，${bytes} 字节）`,
				touchedPaths: entries.map((e) => e.entry),
				estimatedBytesReclaimable: bytes,
				requiresExclusiveLock: false
			};
		},
		async validate() {
			return ok(void 0);
		},
		async execute(ctx) {
			const entries = staleEntries();
			if (entries.length === 0) return ok({
				outcome: {
					bytesFreed: 0,
					message: "无过期 TEMP 条目"
				},
				backup: null
			});
			let bytes = 0;
			let backup = null;
			const failures = [];
			for (const e of entries) try {
				if (e.isDir) {
					const rec = await ctx.backups.stageDir(e.entry);
					backup = backup ?? rec;
					bytes += e.size;
				} else {
					const rec = await ctx.backups.stageFile(e.entry);
					backup = backup ?? rec;
					fs.unlinkSync(e.entry);
					bytes += e.size;
				}
			} catch (err2) {
				failures.push(`${e.entry}: ${errorToMessage(err2)}`);
			}
			if (failures.length > 0 && bytes === 0) return err({
				code: "E_IO",
				message: `TEMP 清理全部失败: ${failures.join("; ")}`
			});
			return ok({
				outcome: {
					bytesFreed: bytes,
					message: `TEMP 清理 ${entries.length - failures.length}/${entries.length} 条${failures.length > 0 ? `（失败 ${failures.length}）` : ""}`
				},
				backup
			});
		},
		async undo(ctx, record) {
			if (!record) return ok(void 0);
			return ctx.backups.restore(record);
		}
	};
}
//#endregion
//#region src/operations/exec-ops.ts
/** spawnSync 包装：归一化 stdout/stderr（spawn 失败时可能为 null），
*  调用方拿到的永远是 string —— 消灭各调用点的 String(x || '') 兜底重复。 */
const defaultCommandRunner = (cmd, args, opts) => {
	const r = spawnSync(cmd, args, {
		cwd: opts.cwd,
		encoding: "utf-8",
		timeout: opts.timeoutMs
	});
	return {
		status: r.status,
		stdout: r.stdout ?? "",
		stderr: r.stderr ?? ""
	};
};
function makeStandardRemoveOp(target, profile, options) {
	const run = options.runCommand ?? defaultCommandRunner;
	const timeoutMs = options.commandTimeoutMs ?? 6e4;
	return {
		id: `op-standard-remove:${target}`,
		action: "standard-remove",
		target,
		async preview() {
			return {
				summary: `dsh plugin --profile ${profile} remove ${target}（标准卸载）`,
				touchedPaths: [],
				estimatedBytesReclaimable: 0,
				requiresExclusiveLock: true
			};
		},
		async validate() {
			const name = options.validator.validatePluginName(target);
			if (!name.ok) return err({
				code: "E_VALIDATION",
				message: `插件名非法: ${target}`,
				details: { violations: name.error }
			});
			const prof = options.validator.validateProfileName(profile);
			if (!prof.ok) return err({
				code: "E_VALIDATION",
				message: `profile 名非法: ${profile}`,
				details: { violations: prof.error }
			});
			if (run("dsh", ["--version"], { timeoutMs: 5e3 }).status !== 0) return err({
				code: "E_IO",
				message: "dsh CLI 不可用（standard-remove 需要 dsh 在 PATH 中）"
			});
			return ok(void 0);
		},
		async execute() {
			const r = run("dsh", [
				"plugin",
				"--profile",
				profile,
				"remove",
				target
			], { timeoutMs });
			if (r.status !== 0) return err({
				code: "E_IO",
				message: `dsh 卸载失败（exit ${r.status}）: ${(r.stderr || r.stdout).trim().slice(0, 200)}`
			});
			return ok({
				outcome: {
					bytesFreed: 0,
					message: `标准卸载完成: ${target}`
				},
				backup: null
			});
		},
		async undo() {
			return ok(void 0);
		}
	};
}
function makePnpmPruneOp(profile, profileDirOf, options) {
	const run = options.runCommand ?? defaultCommandRunner;
	const timeoutMs = options.commandTimeoutMs ?? 12e4;
	return {
		id: "op-pnpm-store-prune:global",
		action: "pnpm-store-prune",
		target: "*store*",
		async preview() {
			return {
				summary: `pnpm store prune（清理 profile ${profile} 关联的 pnpm 全局 store 未引用包）`,
				touchedPaths: [],
				estimatedBytesReclaimable: 0,
				requiresExclusiveLock: true
			};
		},
		async validate() {
			if (run("pnpm", ["--version"], { timeoutMs: 5e3 }).status !== 0) return err({
				code: "E_IO",
				message: "pnpm CLI 不可用（pnpm-store-prune 需要 pnpm 在 PATH 中）"
			});
			return ok(void 0);
		},
		async execute(ctx) {
			const r = run("pnpm", ["store", "prune"], {
				cwd: profileDirOf(ctx),
				timeoutMs
			});
			if (r.status !== 0) return err({
				code: "E_IO",
				message: `pnpm store prune 失败（exit ${r.status}）: ${(r.stderr || r.stdout).trim().slice(0, 200)}`
			});
			return ok({
				outcome: {
					bytesFreed: 0,
					message: "pnpm store prune 完成（实际回收以 pnpm 输出为准）"
				},
				backup: null
			});
		},
		async undo() {
			return ok(void 0);
		}
	};
}
//#endregion
//#region src/operations/index.ts
const STRATEGY_ACTIONS = {
	safe: [
		"standard-remove",
		"clean-workspace-yaml",
		"clean-profile-patch",
		"clean-home-patch"
	],
	balanced: [
		"standard-remove",
		"clean-workspace-yaml",
		"clean-profile-patch",
		"clean-home-patch",
		"remove-node-modules",
		"remove-storages",
		"remove-attachments"
	],
	aggressive: [
		"standard-remove",
		"clean-workspace-yaml",
		"clean-profile-patch",
		"clean-home-patch",
		"remove-node-modules",
		"remove-storages",
		"remove-attachments",
		"pnpm-store-prune",
		"purge-temp"
	]
};
/**
* 生成引擎用的 operationFactory。
* 顺序即执行顺序：先标准卸载与配置摘除（轻、可逆），再物理回收目录，最后全局收尾。
*/
function makeOperationFactory(options) {
	return (request) => {
		const dshHomeOf = (c) => c.resolver.platform().dshHome;
		const actions = new Set(STRATEGY_ACTIONS[request.strategy]);
		const ops = [];
		const plugins = request.plugins.filter((p) => options.validator.validatePluginName(p).ok);
		for (const plugin of plugins) {
			if (actions.has("standard-remove")) ops.push(makeStandardRemoveOp(plugin, request.profile, {
				validator: options.validator,
				...options.runCommand ? { runCommand: options.runCommand } : {}
			}));
			ops.push(...configEditOps(plugin, request.profile, dshHomeOf).filter((op) => actions.has(op.action)));
			ops.push(...dirRemoveOps(plugin, request.profile, dshHomeOf).filter((op) => actions.has(op.action)));
		}
		if (actions.has("pnpm-store-prune")) ops.push(makePnpmPruneOp(request.profile, (c) => c.resolver.profileDir(request.profile), {
			validator: options.validator,
			...options.runCommand ? { runCommand: options.runCommand } : {}
		}));
		if (actions.has("purge-temp")) ops.push(makePurgeTempOp({
			tempRoot: options.tempRoot,
			...options.tempTtlDays !== void 0 ? { ttlDays: options.tempTtlDays } : {},
			...options.now ? { now: options.now } : {}
		}));
		return ops;
	};
}
//#endregion
//#region src/index.ts
const name = "dsh-nuke-plugin";
const inject = ["tools"];
function buildRuntime() {
	const resolver = createPathResolver();
	const platform = resolver.platform();
	const nukeRoot = path.join(platform.dshHome, ".nuke");
	const logger = createLogger({ minLevel: process.env.NUKE_LOG_LEVEL === "debug" ? "debug" : "info" });
	const validator = createValidator(platform.os === "windows" ? "windows" : "linux");
	const lockManager = createLockManager({ lockRoot: nukeRoot });
	const wal = createWal({ walRoot: path.join(nukeRoot, "tx") });
	const backups = createBackupStore({ backupRoot: path.join(nukeRoot, "backups") });
	const audit = createAuditLog({ filePath: path.join(nukeRoot, "audit", "chain.jsonl") });
	const hooks = createHookRegistry({ dir: path.join(nukeRoot, "hooks") });
	/** aggressive 二次确认令牌：显式拼出 profile 与插件清单，防止误触 */
	const confirmationTokenOf = (profile, plugins) => `CONFIRM:${profile}:${[...plugins].sort().join(",")}`;
	const operationFactory = makeOperationFactory({
		validator,
		tempRoot: platform.tempRoot,
		tempTtlDays: 7
	});
	const engine = createTransactionEngine({
		lockManager,
		wal,
		backups,
		audit,
		resolver,
		logger,
		hooks,
		clock: { now: () => /* @__PURE__ */ new Date() },
		verifyConfirmationToken: (token, req) => token === confirmationTokenOf(req.profile, req.plugins)
	}, operationFactory);
	const scorer = createSeverityScorer();
	const analyzer = createDependencyAnalyzer({ dshHome: platform.dshHome });
	const scanCache = createScanCache({ filePath: path.join(nukeRoot, "cache", "scan-cache.json") });
	const scanner = createResidualScanner({
		dshHome: platform.dshHome,
		tempRoot: platform.tempRoot,
		scanCache
	});
	const orphans = createOrphanDetector({
		dshHome: platform.dshHome,
		tempRoot: platform.tempRoot
	});
	const health = createHealthInspector({
		dshHome: platform.dshHome,
		walUnfinished: () => wal.unfinishedTxIds()
	});
	const doctor = createDoctor({
		health,
		scanner,
		orphans,
		scorer,
		clock: { now: () => /* @__PURE__ */ new Date() }
	});
	const dedup = createDedupAnalyzer({ dshHome: platform.dshHome });
	const dedupExec = createDedupExecutor();
	const restorePoints = createRestorePointManager({
		dshHome: platform.dshHome,
		nukeRoot
	});
	const reporter = createReporter({ reportsRoot: path.join(nukeRoot, "reports") });
	const blastRadius = createBlastRadiusAnalyzer({
		dshHome: platform.dshHome,
		analyzer
	});
	const trend = createTrendTracker({ historyDir: path.join(nukeRoot, "history") });
	const ledger = createLedger({ historyDir: path.join(nukeRoot, "history") });
	const forecaster = createDiskForecaster({
		diskRoot: platform.dshHome,
		trend,
		clock: { now: () => /* @__PURE__ */ new Date() }
	});
	const guardian = createGuardian({
		forecaster,
		trend,
		doctor,
		unfinishedTxIds: () => wal.unfinishedTxIds(),
		clock: { now: () => /* @__PURE__ */ new Date() }
	});
	const policy = createPolicyGuard({
		policyFile: path.join(nukeRoot, "policy.json"),
		diskRoot: platform.dshHome,
		now: () => /* @__PURE__ */ new Date()
	});
	hooks.register(policy.asPreHook());
	return {
		resolver,
		platform,
		nukeRoot,
		logger,
		validator,
		engine,
		wal,
		audit,
		scorer,
		analyzer,
		scanner,
		orphans,
		health,
		doctor,
		dedup,
		dedupExec,
		restorePoints,
		reporter,
		blastRadius,
		trend,
		policy,
		forecaster,
		guardian,
		ledger,
		oracle: createOracle({
			reliability: () => createReliabilityModel({ audit }),
			operationFactory,
			resolver,
			logger,
			clock: { now: () => /* @__PURE__ */ new Date() },
			blastRadius,
			forecaster
		}),
		drill: createDrill({ nukeRoot }),
		confirmationTokenOf
	};
}
/** 图标映射键一律用契约联合类型：拼错键或缺键在编译期即失败 */
const BAND_ICON = {
	info: "·",
	low: "🟢",
	medium: "🟡",
	high: "🟠",
	critical: "🔴"
};
/** dsh-tools 契约：execute 返回 canonical value，先经 output.schema 校验，
*  再由 render(args, value) 投影为 ContentBlock 数组。
*  本插件 21 个工具统一 shape：{ content: string }（纯文本）→ 单个 text 块，
*  契约集中声明一次，由 defineTextTool 注入 —— 避免逐个注册重复 21 份。 */
const TEXT_OUTPUT_SCHEMA = {
	type: "object",
	additionalProperties: false,
	properties: { content: {
		type: "string",
		required: true
	} }
};
/** 统一定义入口：注入共享 output 契约后交给官方 defineTool。
*  参数用 ParameterSchemaSpec DSL 声明 —— 框架完成 JSON Schema 编译、
*  运行时参数校验（类型/enum/required）与 InferArgs 类型推导；DSL 表达
*  不了的领域约束（插件名白名单、txId 格式、数值下限）仍在 execute 内
*  手工检查（fail loudly，返回 ❌ 文本或抛 ToolArgsError 由宿主物化）。 */
function defineTextTool(tool) {
	return defineTool({
		name: tool.name,
		description: tool.description,
		parameters: tool.parameters,
		output: {
			schema: TEXT_OUTPUT_SCHEMA,
			render: (_args, value) => [{
				type: "text",
				text: value.content
			}]
		},
		async execute(args) {
			return tool.execute(args);
		}
	});
}
function apply(ctx) {
	const rt = buildRuntime();
	/** 入参校验：插件名列表（元素类型已由 defineTool 保证为 string，这里做领域白名单） */
	function checkPlugins(names) {
		if (names.length === 0) return {
			ok: false,
			error: "请提供 plugin_names 数组（至少一个）"
		};
		for (const n of names) {
			const r = rt.validator.validatePluginName(n);
			if (!r.ok) return {
				ok: false,
				error: `插件名 "${n}" 非法: ${r.error.map((v) => v.detail).join("; ")}`
			};
		}
		return {
			ok: true,
			plugins: names
		};
	}
	function checkProfile(p) {
		const r = rt.validator.validateProfileName(p);
		if (!r.ok) return {
			ok: false,
			error: `profile "${p}" 非法: ${r.error.map((v) => v.detail).join("; ")}`
		};
		return {
			ok: true,
			profile: p
		};
	}
	ctx.tools.register(defineTextTool({
		name: "nuke_list",
		description: "列出指定 profile 下所有已安装的第三方插件",
		parameters: { profile: {
			type: "string",
			description: "默认 \"web\""
		} },
		execute: async ({ profile = "web" }) => {
			const cp = checkProfile(profile);
			if (!cp.ok) return { content: `❌ ${cp.error}` };
			const pkgPath = path.join(rt.resolver.profileDir(cp.profile), "package.json");
			try {
				const bundles = (JSON.parse(fs.readFileSync(pkgPath, "utf-8"))?.dsh?.profile?.bundles ?? []).filter((b) => !b.startsWith("@deepseek-ai/dsh-"));
				if (bundles.length === 0) return { content: `profile "${cp.profile}" 下没有第三方插件。` };
				return { content: `profile "${cp.profile}" 已安装 ${bundles.length} 个第三方插件：\n${bundles.map((b, i) => `  ${i + 1}. ${b}`).join("\n")}` };
			} catch {
				return { content: `❌ 无法读取 ${pkgPath}（profile 不存在？）` };
			}
		}
	}));
	ctx.tools.register(defineTextTool({
		name: "nuke_scan",
		description: "扫描插件残留（配置引用/目录/TEMP），带五因子严重程度评分与可回收空间统计。省略 plugin_name 进入全局模式",
		parameters: {
			plugin_name: {
				type: "string",
				description: "插件名（省略 = 全 profile 全插件全局扫描）"
			},
			profile: {
				type: "string",
				description: "默认 \"web\""
			},
			include_temp: {
				type: "boolean",
				description: "是否扫描 TEMP（仅 aggressive 生效），默认 false"
			}
		},
		execute: async ({ plugin_name, profile = "web", include_temp = false }) => {
			const cp = checkProfile(profile);
			if (!cp.ok) return { content: `❌ ${cp.error}` };
			let plugin;
			if (plugin_name !== void 0) {
				const cn = rt.validator.validatePluginName(plugin_name);
				if (!cn.ok) return { content: `❌ 插件名非法: ${cn.error.map((v) => v.detail).join("; ")}` };
				plugin = plugin_name;
			}
			const evidences = [];
			let bytesReclaimable = 0;
			for await (const ev of rt.scanner.scan({
				...plugin !== void 0 ? { plugin } : {},
				profile: cp.profile,
				strategy: include_temp ? "aggressive" : "safe",
				includeTemp: include_temp
			})) if (ev.type === "found") {
				evidences.push(ev.evidence);
				bytesReclaimable += ev.evidence.sizeBytes;
			}
			if (evidences.length === 0) {
				await rt.trend.record({
					at: (/* @__PURE__ */ new Date()).toISOString(),
					trigger: "scan",
					profile: cp.profile,
					bytesReclaimable: 0,
					bytesFreed: 0,
					residualCount: 0,
					healthScore: -1
				});
				return { content: `✅ ${plugin_name ?? "全局扫描"} 无残留。` };
			}
			const ranked = rt.scorer.rank(evidences);
			await rt.trend.record({
				at: (/* @__PURE__ */ new Date()).toISOString(),
				trigger: "scan",
				profile: cp.profile,
				bytesReclaimable,
				bytesFreed: 0,
				residualCount: evidences.length,
				healthScore: -1
			});
			const lines = ranked.map((e, i) => `  ${i + 1}. ${BAND_ICON[e.score.band] ?? "·"} [${e.score.total}分/${e.score.band}] ${e.description}\n     📍 ${e.location}  💾 ${fmtBytes(e.sizeBytes)}` + (e.referencedBy.length > 0 ? `  ⚠️ 仍被引用: ${e.referencedBy.join(", ")}` : "  ✅ 孤儿（无引用）"));
			return { content: `⚠️ 发现 ${evidences.length} 处残留，可回收 ${fmtBytes(bytesReclaimable)}：\n${lines.join("\n")}\n\n评分说明: 五因子加权（类型×访问衰减×层级×引用态×体量），≥60 需人工确认后再清理。` };
		}
	}));
	ctx.tools.register(defineTextTool({
		name: "nuke_deps",
		description: "依赖关系检测：哪些插件/profile 声明引用了目标插件（删除前必查）",
		parameters: {
			plugin_names: {
				type: "array",
				items: { type: "string" },
				required: true,
				description: "要检测的插件名列表"
			},
			profile: {
				type: "string",
				description: "限定单 profile 分析（省略 = 全 profile）"
			}
		},
		execute: async ({ plugin_names, profile }) => {
			const cp = checkPlugins(plugin_names);
			if (!cp.ok) return { content: `❌ ${cp.error}` };
			let prof;
			if (profile !== void 0) {
				const c = checkProfile(profile);
				if (!c.ok) return { content: `❌ ${c.error}` };
				prof = c.profile;
			}
			const g = await rt.analyzer.buildGraph(prof);
			if (!g.ok) return { content: `❌ ${g.error.message}` };
			const lines = [];
			for (const p of cp.plugins) {
				const deps = g.value.dependenciesOf(p);
				const dependents = g.value.dependentsOf(p);
				lines.push(`📦 ${p}`);
				lines.push(`   被依赖（删除会波及）: ${dependents.length > 0 ? dependents.join(", ") : "无"}`);
				lines.push(`   依赖（需要一起处理）: ${deps.length > 0 ? deps.join(", ") : "无"}`);
			}
			const blockers = await rt.analyzer.blockersOf(cp.plugins);
			if (blockers.ok && blockers.value.length > 0) {
				lines.push("", `🚨 阻断警告（同批删除后仍存在的外部依赖方）:`);
				for (const b of blockers.value) lines.push(`   ${b.plugin}: ${b.reason}`);
			}
			if (g.value.hasCycle()) lines.push("", `⚠️ 检测到依赖环: ${g.value.cycles().map((c) => c.join(" → ")).join("; ")}`);
			return { content: lines.join("\n") };
		}
	}));
	ctx.tools.register(defineTextTool({
		name: "nuke_orphans",
		description: "全局孤儿扫描：node_modules 未声明包 / 无主 storages-attachments / TEMP 过期条目",
		parameters: { temp_max_age_days: {
			type: "number",
			description: "TEMP 条目过期天数，默认 7（须 ≥1）"
		} },
		execute: async ({ temp_max_age_days = 7 }) => {
			if (temp_max_age_days < 1) return { content: "❌ temp_max_age_days 必须为 ≥1 的数字（防止把刚写入的临时文件判为孤儿）" };
			const ageDays = temp_max_age_days;
			const r = await rt.orphans.detect({ tempMaxAgeDays: ageDays });
			if (!r.ok) return { content: `❌ ${r.error.message}` };
			const { orphanPluginDirs, orphanDataDirs, tempOrphans, totalReclaimableBytes } = r.value;
			if (orphanPluginDirs.length + orphanDataDirs.length + tempOrphans.length === 0) return { content: "✅ 未发现孤儿残留。" };
			const lines = [`🗑️ 孤儿总计可回收 ${fmtBytes(totalReclaimableBytes)}`];
			if (orphanPluginDirs.length > 0) {
				lines.push("", `node_modules 孤儿包 (${orphanPluginDirs.length}):`);
				for (const d of orphanPluginDirs.slice(0, 20)) lines.push(`  ${d.path}  ${fmtBytes(d.sizeBytes)}`);
			}
			if (orphanDataDirs.length > 0) {
				lines.push("", `storages/attachments 无主目录 (${orphanDataDirs.length}):`);
				for (const d of orphanDataDirs.slice(0, 20)) lines.push(`  ${d.path}  ${fmtBytes(d.sizeBytes)}`);
			}
			if (tempOrphans.length > 0) {
				lines.push("", `TEMP 过期条目 (${tempOrphans.length}):`);
				for (const t of tempOrphans.slice(0, 20)) lines.push(`  ${t.path}  ${fmtBytes(t.sizeBytes)}  ${t.ageDays.toFixed(1)} 天`);
			}
			return { content: lines.join("\n") };
		}
	}));
	ctx.tools.register(defineTextTool({
		name: "nuke_health",
		description: "系统健康检查：config/dependency/runtime/residue 四组检查，输出健康度评分与阻断项",
		parameters: { profile: {
			type: "string",
			description: "默认 \"web\""
		} },
		execute: async ({ profile = "web" }) => {
			const cp = checkProfile(profile);
			if (!cp.ok) return { content: `❌ ${cp.error}` };
			const r = await rt.health.inspect(cp.profile);
			if (!r.ok) return { content: `❌ ${r.error.message}` };
			const icon = (passed, severity) => passed ? "✅" : severity === "critical" ? "🔴" : severity === "warning" ? "🟡" : "❌";
			return { content: [
				`🏥 健康度 ${r.value.score}/100  ${r.value.blocking ? "🔴 存在阻断项（critical 失败，清理事务将被拒绝）" : "🟢 无阻断"}`,
				"",
				...r.value.results.map((x) => `  ${icon(x.passed, x.severity)} [${x.group}/${x.severity}] ${x.check}: ${x.message}${x.fix ? `\n     💡 ${x.fix}` : ""}`)
			].join("\n") };
		}
	}));
	ctx.tools.register(defineTextTool({
		name: "nuke_strategies",
		description: "查看三级清理策略（safe/balanced/aggressive）及其动作集",
		parameters: {},
		execute: async () => {
			const desc = {
				safe: "仅标准卸载 + 配置引用摘除，不动任何目录（生产安全）",
				balanced: "safe + 物理回收 node_modules/storages/attachments（推荐）",
				aggressive: "balanced + pnpm store prune + TEMP 孤儿清理（需确认令牌）"
			};
			return { content: `可用清理策略：\n\n${Object.keys(STRATEGY_ACTIONS).map((s) => `🛡️ ${s}\n  ${desc[s]}\n  动作: ${STRATEGY_ACTIONS[s].join(", ")}`).join("\n\n")}\n\naggressive 二次确认令牌格式: CONFIRM:<profile>:<逗号排序插件清单>` };
		}
	}));
	ctx.tools.register(defineTextTool({
		name: "nuke_oracle",
		description: "先知推演：dry-run 说\"我打算做什么\"，先知说\"做了会怎样\"——事务成功率、期望回收（校准分布修正）、最脆弱步骤、爆炸半径、磁盘倒计时延长。基于历史执行数据（贝叶斯学习），零副作用不拿锁。建议清理前先问先知",
		parameters: {
			plugin_names: {
				type: "array",
				items: { type: "string" },
				description: "要推演的插件名列表"
			},
			plugin_name: {
				type: "string",
				description: "单个插件名（plugin_names 简写）"
			},
			profile: {
				type: "string",
				description: "默认 \"web\""
			},
			strategy: {
				type: "string",
				enum: [
					"safe",
					"balanced",
					"aggressive"
				],
				description: "推演所用策略，默认 balanced"
			}
		},
		execute: async (args) => {
			const { profile = "web", strategy = "balanced", plugin_names, plugin_name } = args;
			const cp = checkPlugins(plugin_names ?? (plugin_name ? [plugin_name] : []));
			if (!cp.ok) return { content: `❌ ${cp.error}` };
			const cprof = checkProfile(profile);
			if (!cprof.ok) return { content: `❌ ${cprof.error}` };
			const r = await rt.oracle.divine({
				plugins: cp.plugins,
				profile: cprof.profile,
				strategy
			});
			if (!r.ok) return { content: `❌ [${r.error.code}] ${r.error.message}` };
			const o = r.value;
			const pct = (n) => `${(n * 100).toFixed(1)}%`;
			const lines = [
				`🔮 先知推演 @ ${(/* @__PURE__ */ new Date()).toISOString()}`,
				`   插件: ${cp.plugins.join(", ")}  |  profile: ${cprof.profile}  |  策略: ${strategy}`,
				`   事务成功率: ${pct(o.transactionSuccessProbability)}  ${{
					high: "🟢",
					medium: "🟡",
					low: "🔴"
				}[o.confidence]} 置信 ${o.confidence}（${o.evidence.stepSamples} 个历史步骤样本）`,
				`   期望回收: ${fmtBytes(o.expectedReclaimBytes)}（已折算失败回滚；若成功: ${fmtBytes(o.reclaimP10IfSuccess)} ~ ${fmtBytes(o.reclaimP90IfSuccess)}）`,
				`   预估总量: ${fmtBytes(o.totalEstimatedBytes)}  |  失败期望回滚深度: ${o.expectedRollbackDepth.toFixed(1)} 步`
			];
			if (o.weakestStep) lines.push(`   ⚠️ 最脆弱: 第 ${o.weakestStep.index} 步 ${o.weakestStep.action}（成功率 ${pct(o.weakestStep.successProbability)}，失败作废 ${fmtBytes(o.weakestStep.exposureBytes)}）`);
			if (o.brokenDependents !== null) lines.push(o.brokenDependents.length > 0 ? `   💥 爆炸半径: 将损坏 ${o.brokenDependents.length} 个外部依赖方（${o.brokenDependents.join(", ")}）` : "   💥 爆炸半径: 无外部波及");
			if (o.diskExtensionDays !== null) lines.push(`   ⏳ 磁盘写满倒计时预计延长 +${o.diskExtensionDays.toFixed(1)} 天`);
			lines.push("", "─ 逐步推演 ─");
			for (const s of o.steps) {
				const cal = s.calibration ? `  校准 ${(s.calibration.p50 * 100).toFixed(0)}%（${s.calibration.samples} 样本）` : "  校准 n/a";
				lines.push(`  [${s.index}] ${s.action}  ${fmtBytes(s.estimatedBytes)}  成功率 ${pct(s.successProbability)}${cal}`);
			}
			lines.push("", `💡 ${o.narrative}`);
			lines.push("", "决策链建议: nuke_oracle（后果推演）→ nuke_clean dry_run（计划预演）→ nuke_clean（执行）");
			return { content: lines.join("\n") };
		}
	}));
	ctx.tools.register(defineTextTool({
		name: "nuke_drill",
		description: "混沌演习：在沙箱中执行真实事务并在第 N 步后模拟进程崩溃（不回滚、锁悬挂），再走真实崩溃恢复路径，逐项验证数据字节级还原/审计链完整/WAL 终结，签发崩溃安全证书。不触碰真实环境，随时可跑",
		parameters: { crash_after_step: {
			type: "number",
			description: "第几步成功后\"断电\"（1-2，默认 1）"
		} },
		execute: async ({ crash_after_step = 1 }) => {
			const r = await rt.drill.run({ afterStep: crash_after_step });
			if (!r.ok) return { content: `❌ [${r.error.code}] ${r.error.message}` };
			const d = r.value;
			return { content: [
				`${d.passed ? "🎖️ 崩溃安全证书已签发" : "⚠️ 演习未通过"}  演习 ${d.runId}`,
				`   注入点: 第 ${d.crashedAtStep} 步成功落盘后模拟进程死亡  |  恢复备份 ${d.restoredFiles} 项  |  耗时 ${d.durationMs}ms`,
				"",
				"─ 逐项验证 ─",
				...d.checks.map((c) => `  ${c.passed ? "✅" : "❌"} ${c.name}: ${c.detail}`),
				"",
				d.passed ? "本次演习证明：崩溃后 recover() 能完整还原环境，审计链无断裂，后续事务不受阻塞。建议定期演习（尤其升级后）。" : "存在失败项：崩溃恢复能力存疑，请勿在生产依赖自动恢复，优先人工核查。演习现场保留在 .nuke/drill/ 供取证。"
			].join("\n") };
		}
	}));
	ctx.tools.register(defineTextTool({
		name: "nuke_clean",
		description: "事务化强力卸载：健康检查闸门 → 健康度阻断拒绝 → begin(独占锁) → plan(依赖/令牌校验) → [dry_run 预演 | commit 原子执行]。失败自动 Saga 回滚，全程审计",
		parameters: {
			plugin_names: {
				type: "array",
				items: { type: "string" },
				description: "要卸载的插件名列表"
			},
			plugin_name: {
				type: "string",
				description: "单个插件名（plugin_names 简写）"
			},
			profile: {
				type: "string",
				description: "默认 \"web\""
			},
			strategy: {
				type: "string",
				enum: [
					"safe",
					"balanced",
					"aggressive"
				],
				description: "safe / balanced / aggressive，默认 balanced"
			},
			dry_run: {
				type: "boolean",
				description: "仅预演，默认 false"
			},
			confirmation_token: {
				type: "string",
				description: "aggressive 必填：CONFIRM:<profile>:<插件清单>"
			},
			skip_health: {
				type: "boolean",
				description: "跳过健康检查闸门，默认 false"
			},
			report_format: {
				type: "string",
				enum: [
					"json",
					"markdown",
					"both",
					"none"
				],
				description: "报告格式，默认 markdown"
			},
			actor: {
				type: "string",
				description: "操作人标识（写入审计日志），默认 nuke-tool"
			}
		},
		execute: async (args) => {
			const { profile = "web", strategy = "balanced", dry_run = false, skip_health = false, report_format = "markdown", actor = "nuke-tool", plugin_names, plugin_name, confirmation_token } = args;
			const cp = checkPlugins(plugin_names ?? (plugin_name ? [plugin_name] : []));
			if (!cp.ok) return { content: `❌ ${cp.error}` };
			const cprof = checkProfile(profile);
			if (!cprof.ok) return { content: `❌ ${cprof.error}` };
			const strat = strategy;
			const fmt = report_format;
			if (!skip_health) {
				const h = await rt.health.inspect(cprof.profile);
				if (!h.ok) return { content: `🚫 健康检查本身失败，清理被拒绝（可用 skip_health 强制跳过，不建议）: ${h.error.message}` };
				if (h.value.blocking) return { content: `🚫 健康检查存在 critical 失败，清理被拒绝（可用 skip_health 强制跳过，不建议）:\n${h.value.results.filter((x) => !x.passed && x.severity === "critical").map((x) => `  🔴 ${x.check}: ${x.message}`).join("\n")}` };
			}
			const rpLines = [];
			if (!dry_run) {
				const rp = await rt.restorePoints.create({
					actor,
					reason: `pre-clean:${strat}`,
					profile: cprof.profile
				});
				rpLines.push(rp.ok ? `🛡️ 配置还原点 ${rp.value.id}（${rp.value.files.length} 文件，nuke_restorepoint 可恢复）` : `⚠️ 还原点创建失败: ${rp.error.message}（事务级备份仍生效）`);
			}
			const begin = await rt.engine.begin({
				plugins: cp.plugins,
				profile: cprof.profile,
				strategy: strat,
				dryRun: dry_run,
				actor,
				...confirmation_token !== void 0 ? { confirmationToken: confirmation_token } : {}
			});
			if (!begin.ok) return { content: `❌ 事务开启失败 [${begin.error.code}]: ${begin.error.message}` };
			const session = begin.value;
			const planR = await rt.engine.plan(session);
			if (!planR.ok) {
				await rt.engine.rollback(session.txId);
				return { content: `❌ 计划编译失败 [${planR.error.code}]: ${planR.error.message}` };
			}
			const plan = planR.value;
			const policyCheck = rt.policy.check({
				plugins: cp.plugins,
				estimatedBytes: plan.estimatedBytesReclaimable
			});
			if (!policyCheck.ok) {
				await rt.engine.rollback(session.txId);
				return { content: `❌ 策略检查失败（事务已回滚释放）: ${policyCheck.error.message}` };
			}
			if (policyCheck.value.length > 0) {
				await rt.engine.rollback(session.txId);
				return { content: [
					`🛡️ 策略守卫拦截（事务已回滚释放）:`,
					...policyCheck.value.map((v) => `  ⛔ [${v.rule}] ${v.message}`),
					`策略文件: ${path.join(rt.nukeRoot, "policy.json")}（nuke_policy 可查看）`
				].join("\n") };
			}
			const out = [
				...rpLines,
				`🔧 事务 [${session.txId}]  ${dry_run ? "预演（dry-run）" : "执行"}`,
				`   插件: ${cp.plugins.join(", ")}  |  profile: ${cprof.profile}  |  策略: ${strat}`,
				`   预计可回收: ${fmtBytes(plan.estimatedBytesReclaimable)}  |  步骤数: ${plan.operations.length}`
			];
			for (const w of plan.warnings) out.push(`  ${w.blocking ? "⛔" : "⚠️"} ${w.message}`);
			let txCommitted = false;
			try {
				if (dry_run) {
					const dr = await rt.engine.dryRun(plan);
					if (dr.ok) {
						out.push("", "─ 预演明细 ─");
						for (const p of dr.value.plans) out.push(`  • ${p.summary}`);
						out.push("", `预计回收 ${fmtBytes(dr.value.estimatedBytesReclaimable)}。确认后去掉 dry_run 执行。`);
					} else out.push("", `❌ 预演失败 [${dr.error.code}]: ${dr.error.message}`);
					await rt.engine.rollback(session.txId);
					return { content: out.join("\n") };
				}
				const commit = await rt.engine.commit(plan);
				if (!commit.ok) {
					out.push("", `❌ 执行失败已自动回滚 [${commit.error.code}]: ${commit.error.message}`);
					return { content: out.join("\n") };
				}
				txCommitted = true;
				const tx = commit.value;
				out.push("", "─ 执行结果 ─");
				for (const s of tx.steps) {
					const mark = s.status === "done" ? "✅" : s.status === "skipped" ? "⏭️" : s.status === "undone" ? "↩️" : "❌";
					out.push(`  ${mark} [${s.index}] ${s.action} (${s.operationId})  ${s.status}${s.bytesFreed > 0 ? `  回收 ${fmtBytes(s.bytesFreed)}` : ""}`);
				}
				out.push("", `状态: ${tx.state}  |  实际回收: ${fmtBytes(tx.bytesFreedTotal)}`);
				await rt.trend.record({
					at: (/* @__PURE__ */ new Date()).toISOString(),
					trigger: "clean",
					profile: cprof.profile,
					bytesReclaimable: 0,
					bytesFreed: tx.bytesFreedTotal,
					residualCount: 0,
					healthScore: -1
				});
				for (const s of tx.steps) {
					if (s.status !== "done" || s.bytesFreed <= 0) continue;
					await rt.ledger.record({
						at: (/* @__PURE__ */ new Date()).toISOString(),
						kind: "freed",
						txId: session.txId,
						profile: cprof.profile,
						plugin: null,
						action: s.action,
						bytes: s.bytesFreed,
						note: `事务 ${session.txId} 步骤 ${s.index}`
					});
				}
				if (fmt !== "none") {
					const healthR = await rt.health.inspect(cprof.profile);
					const trail = await rt.audit.query({ txId: session.txId });
					const chain = await rt.audit.verify();
					const payload = {
						tx,
						health: healthR.ok ? healthR.value.results : [],
						auditTrail: trail,
						generatedAt: (/* @__PURE__ */ new Date()).toISOString(),
						chainValid: chain.valid
					};
					const formats = fmt === "both" ? ["json", "markdown"] : [fmt === "json" ? "json" : "markdown"];
					for (const f of formats) {
						const r = await rt.reporter.export(f, payload);
						if (r.ok) out.push(`📄 ${f} 报告: ${r.value.path}`);
					}
				}
				return { content: out.join("\n") };
			} catch (e) {
				if (txCommitted) return { content: `⚠️ 事务已提交，但收尾阶段异常: ${errorToMessage(e)}` };
				try {
					await rt.engine.rollback(session.txId);
					return { content: `❌ 未预期异常（事务已回滚释放）: ${errorToMessage(e)}` };
				} catch (e2) {
					return { content: `❌ 未预期异常且回滚失败: ${errorToMessage(e)} / ${errorToMessage(e2)}（请立即运行 nuke_recover）` };
				}
			}
		}
	}));
	ctx.tools.register(defineTextTool({
		name: "nuke_status",
		description: "查询事务状态（活跃/已终结，含步骤明细与回收统计）",
		parameters: { tx_id: {
			type: "string",
			required: true,
			description: "16 位十六进制事务 ID"
		} },
		execute: async ({ tx_id }) => {
			if (!/^[0-9a-f]{16}$/.test(tx_id)) return { content: `❌ tx_id 非法（应为 16 位十六进制事务 ID）` };
			const s = await rt.engine.status(tx_id);
			if (!s) return { content: `❌ 事务不存在: ${tx_id}` };
			return { content: [
				`事务 ${s.txId}: ${s.state}`,
				`  开始: ${s.startedAt}${s.finishedAt ? `  完成: ${s.finishedAt}` : ""}`,
				`  回收总计: ${fmtBytes(s.bytesFreedTotal)}  步骤: ${s.steps.length}`,
				...s.steps.map((x) => `    [${x.index}] ${x.action} → ${x.status} (${fmtBytes(x.bytesFreed)})`)
			].join("\n") };
		}
	}));
	ctx.tools.register(defineTextTool({
		name: "nuke_recover",
		description: "崩溃恢复：扫描未终结事务的 WAL，反向补偿恢复到执行前状态",
		parameters: {},
		execute: async () => {
			const r = await rt.engine.recover();
			if (!r.ok) return { content: `❌ ${r.error.message}` };
			if (r.value.length === 0) return { content: "✅ 无需恢复：没有未终结事务。" };
			const lines = [`↩️ 已恢复 ${r.value.length} 个未终结事务:`];
			for (const s of r.value) lines.push(`  ${s.txId}: ${s.steps.length} 步已反向补偿`);
			return { content: lines.join("\n") };
		}
	}));
	ctx.tools.register(defineTextTool({
		name: "nuke_verify",
		description: "审计链完整性校验（hash chain 任何篡改均可定位）",
		parameters: {},
		execute: async () => {
			const v = await rt.audit.verify();
			if (v.valid) return { content: `✅ 审计链完整：${v.totalEntries} 条记录，hash 链校验通过。` };
			return { content: `🚨 审计链被篡改！共 ${v.totalEntries} 条，首个损坏点: seq=${v.firstBrokenSeq}` };
		}
	}));
	ctx.tools.register(defineTextTool({
		name: "nuke_doctor",
		description: "一键全科体检：健康检查+残留扫描+孤儿检测+五因子评分 → 优先级处方（P1 立即/P2 建议/P3 可选）与建议清理策略",
		parameters: { profile: {
			type: "string",
			description: "默认 \"web\""
		} },
		execute: async ({ profile = "web" }) => {
			const cp = checkProfile(profile);
			if (!cp.ok) return { content: `❌ ${cp.error}` };
			const r = await rt.doctor.diagnose(cp.profile);
			if (!r.ok) return { content: `❌ ${r.error.message}` };
			const d = r.value;
			const verdictIcon = {
				healthy: "✅",
				attention: "🟡",
				critical: "🔴"
			};
			const priorityLabel = {
				1: "🔴 P1 立即",
				2: "🟠 P2 建议",
				3: "🟢 P3 可选"
			};
			const lines = [
				`🩺 体检报告 [${cp.profile}]  ${verdictIcon[d.verdict] ?? "·"} ${d.verdict}`,
				`   健康度 ${d.healthScore}/100${d.blocking ? "  ⛔ 存在阻断项（清理事务将被拒绝）" : ""}`,
				`   潜在可回收: ${fmtBytes(d.totalReclaimableBytes)}  处方条目: ${d.recommendations.length}`
			];
			if (d.recommendations.length === 0) lines.push("", "✅ 环境干净，无需清理。");
			else {
				lines.push("", "─ 处方（按优先级）─");
				for (const rec of d.recommendations) lines.push(`  ${priorityLabel[rec.priority]} [${rec.evidence.score.total}分/${rec.evidence.score.band}] ${rec.evidence.description}`, `     💡 ${rec.reason} → 建议 ${rec.suggestedStrategy}`, `     📍 ${rec.evidence.location}  💾 ${fmtBytes(rec.evidence.sizeBytes)}`);
			}
			return { content: lines.join("\n") };
		}
	}));
	ctx.tools.register(defineTextTool({
		name: "nuke_dedup",
		description: "内容寻址去重：三级瀑布（尺寸分桶→头尾采样→全量 SHA-256）定位重复文件群；apply=true 时以硬链接实收（verify-then-link，需确认令牌）",
		parameters: {
			min_size_bytes: {
				type: "integer",
				description: "参与分析的最小文件尺寸，默认 4096（须 ≥1）"
			},
			apply: {
				type: "boolean",
				description: "将重复副本替换为硬链接实收空间（默认 false 只分析）"
			},
			confirm_token: {
				type: "string",
				description: "apply=true 时必填：LINK-DEDUP"
			}
		},
		execute: async ({ min_size_bytes, apply, confirm_token }) => {
			if (min_size_bytes !== void 0 && min_size_bytes < 1) return { content: "❌ min_size_bytes 必须为 ≥1 的整数" };
			const minSize = min_size_bytes;
			if (apply === true && confirm_token !== "LINK-DEDUP") return { content: "❌ apply=true 需要确认令牌 confirm_token=\"LINK-DEDUP\"（硬链接替换不可逆于权限语义）" };
			const r = await rt.dedup.analyze(minSize !== void 0 ? { minSizeBytes: minSize } : void 0);
			if (!r.ok) return { content: `❌ ${r.error.message}` };
			const d = r.value;
			if (d.groups.length === 0) return { content: `✅ 未发现重复文件（扫描 ${d.filesScanned} 个 / ${fmtBytes(d.bytesScanned)} / ${d.durationMs}ms）。` };
			await rt.ledger.record({
				at: (/* @__PURE__ */ new Date()).toISOString(),
				kind: "pending",
				txId: null,
				profile: "*",
				plugin: null,
				action: "dedup-potential",
				bytes: d.totalReclaimableBytes,
				note: `${d.groups.length} 组重复内容`
			});
			if (apply === true) {
				const ex = await rt.dedupExec.apply(d);
				if (!ex.ok) return { content: `❌ ${ex.error.message}` };
				const e = ex.value;
				await rt.ledger.record({
					at: (/* @__PURE__ */ new Date()).toISOString(),
					kind: "freed",
					txId: null,
					profile: "*",
					plugin: null,
					action: "dedup-hardlink",
					bytes: e.bytesSaved,
					note: `${e.linkedFiles} 个副本硬链接化 / ${e.skipped.length} 跳过`
				});
				const lines = [
					`${e.cancelled ? "⏹️ 去重执行被中途取消（已完成部分已记 journal，可 undo）" : "♻️ 硬链接去重完成"}：${e.linkedFiles} 个副本已链接，实际回收 ${fmtBytes(e.bytesSaved)}`,
					`   （跳过 ${e.skipped.length} 项：复验失败/跨设备/已链接等）`,
					"",
					"  已链接样本："
				];
				for (const j of e.journal.slice(0, 8)) lines.push(`    • ${path.basename(j.victim)} → ${path.basename(j.canonical)} (${fmtBytes(j.sizeBytes)})`);
				if (e.skipped.length > 0) {
					lines.push("", "  跳过样本：");
					for (const s of e.skipped.slice(0, 5)) lines.push(`    • ${path.basename(s.path)}: ${s.reason}`);
				}
				return { content: lines.join("\n") };
			}
			const lines = [
				`♻️ 发现 ${d.groups.length} 组重复，合计可回收 ${fmtBytes(d.totalReclaimableBytes)}`,
				`   扫描 ${d.filesScanned} 文件 / ${fmtBytes(d.bytesScanned)} / ${d.durationMs}ms`,
				`   三级瀑布：尺寸淘汰 ${d.stages?.sizeEliminated ?? "—"} / 采样淘汰 ${d.stages?.sampleEliminated ?? "—"} / 全量哈希 ${d.stages?.fullHashed ?? "—"}（省读 ${fmtBytes(d.stages?.bytesSavedBySampling ?? 0)}）`,
				""
			];
			for (const g of d.groups.slice(0, 10)) {
				lines.push(`  • ${fmtBytes(g.sizeBytes)} × ${g.copies.length} 份`);
				for (const c of g.copies) lines.push(`      ${c.profile ?? "—"}/${path.basename(c.path)}`);
			}
			if (d.groups.length > 10) lines.push("", `  … 及另外 ${d.groups.length - 10} 组`);
			lines.push("", "💡 确认后可执行硬链接实收：apply=true + confirm_token=\"LINK-DEDUP\"");
			return { content: lines.join("\n") };
		}
	}));
	ctx.tools.register(defineTextTool({
		name: "nuke_restorepoint",
		description: "配置还原点管理：清理前自动快照关键配置，事故后一键恢复（list / create / restore / prune）",
		parameters: {
			action: {
				type: "string",
				enum: [
					"list",
					"create",
					"restore",
					"prune"
				],
				description: "list / create / restore / prune，默认 list"
			},
			id: {
				type: "string",
				description: "restore 目标还原点 id"
			},
			profile: {
				type: "string",
				description: "create 用，默认 \"web\""
			},
			reason: {
				type: "string",
				description: "create 用，默认 manual"
			},
			keep: {
				type: "integer",
				description: "prune 用：保留最近几个，默认 5（须 ≥1）"
			},
			actor: {
				type: "string",
				description: "create 用，默认 nuke-tool"
			}
		},
		execute: async ({ action = "list", id, profile = "web", reason = "manual", keep = 5, actor = "nuke-tool" }) => {
			if (action === "create") {
				const cp = checkProfile(profile);
				if (!cp.ok) return { content: `❌ ${cp.error}` };
				const r = await rt.restorePoints.create({
					actor,
					reason,
					profile: cp.profile
				});
				if (!r.ok) return { content: `❌ [${r.error.code}] ${r.error.message}` };
				return { content: `🛡️ 还原点已创建: ${r.value.id}\n   文件 ${r.value.files.length} 个，快照于 ${r.value.createdAt}。` };
			}
			if (action === "restore") {
				if (!id) return { content: "❌ 请提供 id" };
				const r = await rt.restorePoints.restore(id);
				if (!r.ok) return { content: `❌ [${r.error.code}] ${r.error.message}` };
				return { content: `↩️ 已恢复 ${r.value.files.length} 个配置文件到 ${r.value.createdAt} 时点（${r.value.id}）。` };
			}
			if (action === "prune") {
				if (keep < 1) return { content: "❌ keep 必须为 ≥1 的整数（不允许清空全部还原点）" };
				const r = await rt.restorePoints.prune(keep);
				if (!r.ok) return { content: `❌ ${r.error.message}` };
				return { content: `🧹 已删除 ${r.value} 个旧还原点。` };
			}
			const all = rt.restorePoints.list();
			if (all.length === 0) return { content: "暂无还原点。" };
			const lines = [`🛡️ ${all.length} 个还原点（最新在前）:`];
			for (const m of all) lines.push(`  ${m.id}  ${m.createdAt}  ${m.files.length} 文件  by ${m.actor}  (${m.reason})`);
			return { content: lines.join("\n") };
		}
	}));
	ctx.tools.register(defineTextTool({
		name: "nuke_blastradius",
		description: "爆炸半径沙盘推演（what-if）：删除前预测传递闭包波及面 —— 谁会损坏、谁可级联、风险几级、如何降险。零副作用",
		parameters: {
			plugin_names: {
				type: "array",
				items: { type: "string" },
				required: true,
				description: "要推演的插件名列表"
			},
			profile: {
				type: "string",
				description: "限定单 profile 图（省略 = 全 profile）"
			}
		},
		execute: async ({ plugin_names, profile }) => {
			const cp = checkPlugins(plugin_names);
			if (!cp.ok) return { content: `❌ ${cp.error}` };
			let prof;
			if (profile !== void 0) {
				const c = checkProfile(profile);
				if (!c.ok) return { content: `❌ ${c.error}` };
				prof = c.profile;
			}
			const r = await rt.blastRadius.simulate(cp.plugins, prof);
			if (!r.ok) return { content: `❌ [${r.error.code}] ${r.error.message}` };
			const b = r.value;
			const lines = [
				`💥 爆炸半径推演  ${{
					low: "🟢",
					medium: "🟡",
					high: "🟠",
					extreme: "🔴"
				}[b.riskLevel]} ${b.riskLevel.toUpperCase()}（风险分 ${b.riskScore}/100）`,
				`   目标: ${b.targets.join(", ")}`,
				`   预估可回收: ${fmtBytes(b.estimatedBytesReclaimable)}  |  配置引用: ${b.configRefs.length} 处`
			];
			if (b.brokenDependents.length > 0) lines.push("", `🚨 将损坏的插件 (${b.brokenDependents.length}): ${b.brokenDependents.join(", ")}`);
			else lines.push("", "✅ 无意外波及（删除集合外无依赖方）");
			if (b.cascadeRemovable.length > 0) lines.push(`📦 级联同删 (${b.cascadeRemovable.length}): ${b.cascadeRemovable.join(", ")}`);
			lines.push("", "─ 顾问建议 ─");
			for (const a of b.advisories) lines.push(`  💡 ${a}`);
			return { content: lines.join("\n") };
		}
	}));
	ctx.tools.register(defineTextTool({
		name: "nuke_trend",
		description: "历史趋势分析：可回收空间变化率（字节/天）、30 天线性外推、3σ 异常检测（插件失控写盘早期信号）",
		parameters: { profile: {
			type: "string",
			description: "限定 profile（省略 = 全部）"
		} },
		execute: async ({ profile }) => {
			let prof;
			if (profile !== void 0) {
				const cp = checkProfile(profile);
				if (!cp.ok) return { content: `❌ ${cp.error}` };
				prof = cp.profile;
			}
			const r = await rt.trend.analyze(prof);
			if (!r.ok) return { content: `❌ ${r.error.message}` };
			const t = r.value;
			if (t.snapshotCount === 0) return { content: "暂无历史快照 —— 运行 nuke_scan / nuke_clean / nuke_doctor 后自动积累。" };
			const lines = [`📈 趋势分析（${t.snapshotCount} 个快照，${t.firstAt} → ${t.lastAt}）`, `   变化率: ${t.bytesPerDay >= 0 ? "+" : ""}${fmtBytes(Math.abs(t.bytesPerDay))}/天${t.bytesPerDay > 0 ? "（残留净增长）" : t.bytesPerDay < 0 ? "（净回收，趋势向好）" : ""}`];
			if (t.projected30dBytes !== null) lines.push(`   30 天外推: ${fmtBytes(t.projected30dBytes)} 可回收`);
			if (t.anomaly.detected) lines.push("", `🚨 异常: ${t.anomaly.detail}`);
			else if (t.snapshotCount >= 3) lines.push("   ✅ 无异常突变");
			if (t.latest) lines.push(`   最新快照: ${{
				scan: "扫描",
				clean: "清理",
				doctor: "体检"
			}[t.latest.trigger] ?? t.latest.trigger} @ ${t.latest.at}，可回收 ${fmtBytes(t.latest.bytesReclaimable)}`);
			return { content: lines.join("\n") };
		}
	}));
	ctx.tools.register(defineTextTool({
		name: "nuke_policy",
		description: "查看当前清理策略守卫配置（保护名单/批量上限/回收上限/磁盘下限/时间黑窗）。策略文件: <dshHome>/.nuke/policy.json",
		parameters: {},
		execute: async () => {
			const p = rt.policy.load();
			const lines = ["🛡️ 当前清理策略（policy.json）:"];
			lines.push(`  保护名单: ${p.protectedPlugins.length > 0 ? p.protectedPlugins.join(", ") : "（空）"}`);
			lines.push(`  单事务插件上限: ${p.maxPluginsPerTx ?? "无限制"}`);
			lines.push(`  单事务回收上限: ${p.maxReclaimBytesPerTx !== null ? fmtBytes(p.maxReclaimBytesPerTx) : "无限制"}`);
			lines.push(`  磁盘余量下限: ${p.minFreeDiskBytes !== null ? fmtBytes(p.minFreeDiskBytes) : "不检查"}`);
			lines.push(`  时间黑窗: ${p.blackout ? `${p.blackout.startHour}:00 - ${p.blackout.endHour}:00` : "无"}`);
			lines.push("", "说明: 策略文件缺失或损坏时默认全放行；保护名单同时以引擎 pre-hook 形式强制执行（纵深防御）。");
			return { content: lines.join("\n") };
		}
	}));
	ctx.tools.register(defineTextTool({
		name: "nuke_guardian",
		description: "守卫者巡检：一键主动运维 —— 磁盘写满倒计时/趋势异常/健康阻断/可回收积压/崩溃残留事务，输出带行动建议的分级告警",
		parameters: { profile: {
			type: "string",
			description: "默认 \"web\""
		} },
		execute: async ({ profile = "web" }) => {
			const cp = checkProfile(profile);
			if (!cp.ok) return { content: `❌ ${cp.error}` };
			const r = await rt.guardian.patrol({ profile: cp.profile });
			if (!r.ok) return { content: `❌ [${r.error.code}] ${r.error.message}` };
			const g = r.value;
			const sevIcon = {
				critical: "🔴",
				warning: "🟡",
				info: "ℹ️"
			};
			const lines = [`🛡️ 守卫者巡检 @ ${g.patrolledAt}`];
			if (g.disk && g.disk.usedPct !== null) lines.push(`   磁盘: 已用 ${g.disk.usedPct}%` + (g.disk.daysUntilFull !== null ? `，按当前增速约 ${g.disk.daysUntilFull.toFixed(1)} 天后写满` : ""));
			if (g.partialFailures.length > 0) lines.push(`   ⚠️ 部分采集降级: ${g.partialFailures.join("; ")}`);
			if (g.alerts.length === 0) lines.push("", "✅ 一切正常，无需行动。");
			else {
				lines.push("", `发现 ${g.alerts.length} 条告警:`);
				for (const a of g.alerts) {
					lines.push(`  ${sevIcon[a.severity]} [${a.kind}] ${a.message}`);
					lines.push(`     → 建议调用 ${a.suggestedTool}`);
				}
			}
			return { content: lines.join("\n") };
		}
	}));
	ctx.tools.register(defineTextTool({
		name: "nuke_forecast",
		description: "磁盘写满预测：趋势回归 × 实时余量 → 写满倒计时（daysUntilFull）、30 天走势与分级建议",
		parameters: {},
		execute: async () => {
			const r = await rt.forecaster.forecast();
			if (!r.ok) return { content: `❌ [${r.error.code}] ${r.error.message}` };
			const f = r.value;
			const lines = [`🔮 磁盘预测 @ ${f.sampledAt}  ${{
				ok: "🟢",
				watch: "🟡",
				warning: "🟠",
				critical: "🔴"
			}[f.severity]} ${f.severity}`];
			if (f.totalBytes !== null && f.freeBytes !== null) lines.push(`   容量 ${fmtBytes(f.totalBytes)} | 余量 ${fmtBytes(f.freeBytes)} | 已用 ${f.usedPct}%`);
			else lines.push("   磁盘采样不可用（statfs 无权限），仅输出趋势侧结论");
			if (f.growthBytesPerDay !== null) lines.push(`   残留增速: ${fmtBytes(f.growthBytesPerDay)}/天（依据 ${f.trendBasis?.snapshotCount ?? 0} 个快照）`);
			else lines.push("   残留增速: 尚不可测（趋势样本不足或正在净回收）");
			if (f.daysUntilFull !== null && f.projectedFullAt !== null) lines.push(`   ⏳ 写满倒计时: ${f.daysUntilFull.toFixed(1)} 天（预计 ${f.projectedFullAt}）`);
			lines.push("", `💡 ${f.recommendation}`);
			return { content: lines.join("\n") };
		}
	}));
	ctx.tools.register(defineTextTool({
		name: "nuke_ledger",
		description: "空间台账：每字节回收可溯源 —— 按动作/profile/日聚合，已回收(freed)与待回收(pending)双轨统计",
		parameters: {
			kind: {
				type: "string",
				enum: ["freed", "pending"],
				description: "freed / pending（省略 = 全部）"
			},
			profile: {
				type: "string",
				description: "限定 profile（省略 = 全部）"
			},
			days: {
				type: "number",
				description: "只统计最近 N 天（省略 = 全部）"
			}
		},
		execute: async ({ kind, profile, days }) => {
			const filter = {};
			if (kind !== void 0) filter.kind = kind;
			if (profile !== void 0) {
				const cp = checkProfile(profile);
				if (!cp.ok) return { content: `❌ ${cp.error}` };
				filter.profile = cp.profile;
			}
			if (days !== void 0) {
				if (days < 0) return { content: "❌ days 必须为 ≥0 的数字" };
				filter.since = (/* @__PURE__ */ new Date(Date.now() - days * 864e5)).toISOString();
			}
			const r = await rt.ledger.query(filter);
			if (!r.ok) return { content: `❌ ${r.error.message}` };
			const s = r.value;
			if (s.entryCount === 0) return { content: "暂无台账记录 —— nuke_clean 执行后自动记账。" };
			const lines = [
				`📒 空间台账（${s.entryCount} 条）`,
				`   已回收: ${fmtBytes(s.totalFreed)}  |  待回收潜力: ${fmtBytes(s.totalPending)}`,
				"",
				"─ 按动作 ─",
				...s.byAction.slice(0, 8).map((b) => `  ${b.key}: ${fmtBytes(b.bytes)} × ${b.count} 次`),
				"",
				"─ 按 profile ─",
				...s.byProfile.map((b) => `  ${b.key}: ${fmtBytes(b.bytes)}`)
			];
			if (s.byDay.length > 1) {
				lines.push("", "─ 按日（回收趋势）─");
				for (const d of s.byDay.slice(-14)) lines.push(`  ${d.key}: ${fmtBytes(d.bytes)}`);
			}
			const recent = rt.ledger.entries(filter, 3);
			if (recent.length > 0) {
				lines.push("", "─ 最近记录 ─");
				for (const e of recent) lines.push(`  ${e.at}  ${e.kind === "freed" ? "✅" : "⏳"} ${e.action} ${fmtBytes(e.bytes)}${e.txId ? ` (${e.txId})` : ""}`);
			}
			return { content: lines.join("\n") };
		}
	}));
}
//#endregion
export { apply, inject, name };
