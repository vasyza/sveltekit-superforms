import { SuperFormError, SchemaError } from './index.js';
import type { SuperValidateOptions } from './superValidate.js';
import { parse } from 'devalue';
import type { JSONSchema7, JSONSchema7Definition } from 'json-schema';
import { schemaInfo, type SchemaInfo } from './jsonSchema.js';

type ParsedData = {
	id: string | undefined;
	posted: boolean;
	data: Record<string, unknown> | undefined;
};

type ParseOptions<T extends object> = {
	preprocessed?: SuperValidateOptions<T, boolean>['preprocessed'];
};

export async function parseRequest<T extends object>(
	data: unknown,
	schemaData: JSONSchema7,
	options?: ParseOptions<T>
) {
	let parsed: ParsedData;

	if (data instanceof FormData) {
		parsed = parseFormData(data, schemaData, options);
	} else if (data instanceof URL || data instanceof URLSearchParams) {
		parsed = parseSearchParams(data, schemaData, options);
	} else if (data instanceof Request) {
		parsed = await tryParseFormData(data, schemaData, options);
	} else if (
		// RequestEvent
		data &&
		typeof data === 'object' &&
		'request' in data &&
		data.request instanceof Request
	) {
		parsed = await tryParseFormData(data.request, schemaData, options);
	} else {
		parsed = {
			id: undefined,
			data: data as Record<string, unknown>,
			posted: false
		};
	}

	return parsed;
}

/**
 * Check what data to validate. If no parsed data, the default entity
 * may still have to be validated if there are side-effects or errors
 * should be displayed.
 */
/*
function dataToValidate<T extends AnyZodObject>(
	parsed: ParsedData,
	schemaData: JSONSchema7
): Record<string, unknown> | undefined {
	if (!parsed.data) {
		return schemaData.hasEffects || schemaData.opts.errors === true
			? schemaData.entityInfo.defaultEntity
			: undefined;
	} else {
		return parsed.data;
	}
}
*/

async function tryParseFormData<T extends object>(
	request: Request,
	schemaData: JSONSchema7,
	options?: ParseOptions<T>
) {
	let formData: FormData | undefined = undefined;
	try {
		formData = await request.formData();
	} catch (e) {
		if (e instanceof TypeError && e.message.includes('already been consumed')) {
			// Pass through the "body already consumed" error, which applies to
			// POST requests when event/request is used after formData has been fetched.
			throw e;
		}
		// No data found, return an empty form
		return { id: undefined, data: undefined, posted: false };
	}
	return parseFormData(formData, schemaData, options);
}

export function parseSearchParams<T extends object>(
	data: URL | URLSearchParams,
	schemaData: JSONSchema7,
	options?: ParseOptions<T>
): ParsedData {
	if (data instanceof URL) data = data.searchParams;

	const convert = new FormData();
	for (const [key, value] of data.entries()) {
		convert.append(key, value);
	}

	const output = parseFormData(convert, schemaData, options);

	// Set posted to false since it's a URL
	output.posted = false;
	return output;
}

export function parseFormData<T extends object>(
	formData: FormData,
	schemaData: JSONSchema7,
	options?: ParseOptions<T>
): ParsedData {
	function tryParseSuperJson() {
		if (formData.has('__superform_json')) {
			try {
				const output = parse(formData.getAll('__superform_json').join('') ?? '');
				if (typeof output === 'object') {
					return output as Record<string, unknown>;
				}
			} catch {
				//
			}
		}
		return null;
	}

	const data = tryParseSuperJson();
	const id = formData.get('__superform_id')?.toString() ?? undefined;

	return data
		? { id, data, posted: true }
		: {
				id,
				data: _parseFormData(formData, schemaData, options?.preprocessed),
				posted: true
		  };
}

function _parseFormData<T extends object>(
	formData: FormData,
	schema: JSONSchema7,
	preprocessed?: (keyof T)[]
) {
	const output: Record<string, unknown> = {};
	const schemaKeys = schema.additionalProperties
		? formData.keys()
		: Object.keys(schema.properties ?? {});

	function parseSingleEntry(key: string, entry: FormDataEntryValue, info: SchemaInfo) {
		if (preprocessed && preprocessed.includes(key as keyof T)) {
			return entry;
		}

		if (entry && typeof entry !== 'string') {
			// File objects are not supported
			// TODO: Add a warning for uploaded files that can be disabled?
			return undefined;
		}

		return parseFormDataEntry(key, entry, info);
	}

	for (const key of schemaKeys) {
		if (!schema.additionalProperties && !formData.has(key)) continue;

		const property: JSONSchema7Definition = schema.properties
			? schema.properties[key]
			: { type: 'string' };

		const unionError = () => {
			throw new SchemaError(
				'FormData parsing failed: ' +
					'Unions (anyOf) are only supported when the dataType option for superForm is set to "json".',
				key
			);
		};

		if (typeof property == 'boolean') {
			throw new SchemaError('Schema properties defined as boolean is not supported.', key);
		}

		const info = schemaInfo(property, !schema.required?.includes(key), unionError);

		const entries = formData.getAll(key);

		if (info.types.includes('array') || info.types.includes('set')) {
			const items = property.items;
			if (!items || typeof items == 'boolean' || (Array.isArray(items) && items.length != 1)) {
				throw new SchemaError(
					'Arrays must have a single "items" property that defines its type.',
					key
				);
			}

			const arrayType = Array.isArray(items) ? items[0] : items;
			if (typeof arrayType == 'boolean') {
				throw new SchemaError('Schema properties defined as boolean is not supported.', key);
			}

			const arrayInfo = schemaInfo(arrayType, info.isOptional, unionError);
			const arrayData = entries.map((e) => parseSingleEntry(key, e, arrayInfo));
			output[key] = info.types.includes('set') ? new Set(arrayData) : arrayData;
		} else {
			output[key] = parseSingleEntry(key, entries[entries.length - 1], info);
		}
	}

	return output;
}

function parseFormDataEntry(key: string, value: string, info: SchemaInfo): unknown {
	if (info.types.length != 1) {
		throw new SchemaError(
			'FormData parsing failed: ' +
				'Multiple types are only supported when the dataType option for superForm is set to "json".' +
				'Types found: ' +
				info.types,
			key
		);
	}

	const type = info.types[0];

	// value can be returned immediately unless it's boolean, which
	// means it could have been posted as a checkbox.
	if (!value && type != 'boolean') {
		console.log(`No FormData for "${key}" (${type}).`);
		return info.isNullable ? null : value;
	}

	// TODO: Probably better to merge default values later, to avoid this code:
	/*
	if (!value) {
		const defaultValue = defaultValues(schema, isOptional, [key]);

		console.log(`No FormData for "${key}" (${type}). Default: ${defaultValue}`, schema);

		// defaultValue can be returned immediately unless it's boolean, which
		// means it could have been posted as a checkbox.
		if (defaultValue !== undefined && type != 'boolean') {
			return defaultValue;
		}
		if (info.isNullable) return null;
		if (info.isOptional) return undefined;
	}
	*/

	console.log(`Parsing FormData "${key}": ${value}`, info);

	function typeError() {
		throw new SchemaError(
			type[0].toUpperCase() +
				type.slice(1) +
				` type found. ` +
				`Set the dataType option to "json" and add use:enhance on the client to use nested data structures. ` +
				`More information: https://superforms.rocks/concepts/nested-data`,
			key
		);
	}

	switch (type) {
		case 'string':
		case 'any':
			return value;
		case 'integer':
			return parseInt(value ?? '', 10);
		case 'number':
			return parseFloat(value ?? '');
		case 'boolean':
			return Boolean(value == 'false' ? '' : value).valueOf();
		case 'unix-time':
			return new Date(value ?? '');
		case 'bigint':
			return BigInt(value ?? '.');
		case 'symbol':
			return Symbol(String(value));

		case 'set':
		case 'array':
		case 'object':
			return typeError();

		default:
			throw new SuperFormError('Unsupported schema type for FormData: ' + type);
	}

	// TODO: Enum parsing
	/*
	} else if (type == 'NativeEnum') {
		const zodEnum = zodType as ZodNativeEnum<EnumLike>;

		if (value !== null && value in zodEnum.enum) {
			const enumValue = zodEnum.enum[value];
			if (typeof enumValue === 'number') return enumValue;
			else if (enumValue in zodEnum.enum) return zodEnum.enum[enumValue];
		} else if (value !== null && Object.values(zodEnum.enum).includes(value)) {
			return value;
		}
		return undefined;
	} 
	*/
}
