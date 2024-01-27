import { AsyncLocalStorage } from "async_hooks";
import {
	H3Error,
	H3Event,
	MIMES,
	callNodeListener,
	clearResponseHeaders,
	createApp,
	createAppEventHandler,
	createError,
	createEvent,
	createRouter,
	defineEventHandler,
	defineLazyEventHandler,
	defineNodeListener,
	defineNodeMiddleware,
	defineRequestMiddleware,
	defineResponseMiddleware,
	dynamicEventHandler,
	eventHandler,
	fromNodeMiddleware,
	fromPlainHandler,
	fromWebHandler,
	isCorsOriginAllowed,
	isError,
	isEventHandler,
	isMethod,
	isPreflightRequest,
	isStream,
	isWebResponse,
	lazyEventHandler,
	promisifyNodeListener,
	sanitizeStatusCode,
	sanitizeStatusMessage,
	serveStatic,
	splitCookiesString,
	toEventHandler,
	toNodeListener,
	toPlainHandler,
	toWebHandler,
} from "h3";
import {
	appendCorsHeaders as _appendCorsHeaders,
	appendCorsPreflightHeaders as _appendCorsPreflightHeaders,
	appendHeader as _appendHeader,
	appendHeaders as _appendHeaders,
	appendResponseHeader as _appendResponseHeader,
	appendResponseHeaders as _appendResponseHeaders,
	assertMethod as _assertMethod,
	clearSession as _clearSession,
	defaultContentType as _defaultContentType,
	deleteCookie as _deleteCookie,
	fetchWithEvent as _fetchWithEvent,
	getCookie as _getCookie,
	getHeader as _getHeader,
	getHeaders as _getHeaders,
	getProxyRequestHeaders as _getProxyRequestHeaders,
	getQuery as _getQuery,
	getRequestFingerprint as _getRequestFingerprint,
	getRequestHeader as _getRequestHeader,
	getRequestHeaders as _getRequestHeaders,
	getRequestHost as _getRequestHost,
	getRequestIP as _getRequestIP,
	getRequestProtocol as _getRequestProtocol,
	getRequestURL as _getRequestURL,
	getRequestWebStream as _getRequestWebStream,
	getResponseHeader as _getResponseHeader,
	getResponseHeaders as _getResponseHeaders,
	getResponseStatus as _getResponseStatus,
	getResponseStatusText as _getResponseStatusText,
	getRouterParam as _getRouterParam,
	getRouterParams as _getRouterParams,
	getValidatedQuery as _getValidatedQuery,
	getValidatedRouterParams as _getValidatedRouterParams,
	handleCacheHeaders as _handleCacheHeaders,
	handleCors as _handleCors,
	isCorsOriginAllowed as _isCorsOriginAllowed,
	isMethod as _isMethod,
	isPreflightRequest as _isPreflightRequest,
	parseCookies as _parseCookies,
	proxyRequest as _proxyRequest,
	readBody as _readBody,
	readFormData as _readFormData,
	readMultipartFormData as _readMultipartFormData,
	readRawBody as _readRawBody,
	readValidatedBody as _readValidatedBody,
	removeResponseHeader as _removeResponseHeader, // ... import other utilities as needed
	sanitizeStatusCode as _sanitizeStatusCode,
	sanitizeStatusMessage as _sanitizeStatusMessage,
	send as _send,
	sendError as _sendError,
	sendNoContent as _sendNoContent,
	sendProxy as _sendProxy,
	sendRedirect as _sendRedirect,
	sendStream as _sendStream,
	sendWebResponse as _sendWebResponse,
	setCookie as _setCookie,
	setHeader as _setHeader,
	setHeaders as _setHeaders,
	setResponseHeader as _setResponseHeader,
	setResponseHeaders as _setResponseHeaders,
	setResponseStatus as _setResponseStatus,
	splitCookiesString as _splitCookiesString,
	unsealSession as _unsealSession,
	useBase as _useBase,
	writeEarlyHints as _writeEarlyHints,
} from "h3";
import { seal, defaults as sealDefaults } from "iron-webcrypto";
import crypto from "uncrypto";

/**
 *
 * @param {import('h3').H3Event} event
 * @param {string} key
 * @param {any} value
 */
function _setContext(event, key, value) {
	event.context[key] = value;
}

/**
 *
 * @param {import('h3').H3Event} event
 * @param {string} key
 */
function _getContext(event, key) {
	return event.context[key];
}

/**
 *
 * @param {{ onRequest?: import("h3")._RequestMiddleware | import("h3")._RequestMiddleware[]; onBeforeResponse?: import("h3")._ResponseMiddleware | import("h3")._ResponseMiddleware[] }} options
 * @returns
 */
export function defineMiddleware(options) {
	return options;
}

/**
 * The web request utils are copied from `h3` with a few bug fixes regaring multiple access to
 * `readBody` and when the body is an ArrayBuffer, such as in Deno, Edge Functions, etc.
 *
 * We intend to remove this section once this is upstreamed in h3.
 */

function toWebRequestH3(/** @type {import('h3').H3Event} */ event) {
	/**
	 * @type {ReadableStream | undefined}
	 */
	let readableStream;

	const url = getRequestURL(event);
	const base = {
		// @ts-ignore Undici option
		duplex: "half",
		method: event.method,
		headers: event.headers,
	};

	if (event.node.req.body instanceof ArrayBuffer) {
		return new Request(url, {
			...base,
			body: event.node.req.body,
		});
	}

	return new Request(url, {
		...base,
		get body() {
			if (readableStream) {
				return readableStream;
			}
			readableStream = getRequestWebStream(event);
			return readableStream;
		},
	});
}

export function toWebRequest(/** @type {import('h3').H3Event} */ event) {
	event.web ??= {
		request: toWebRequestH3(event),
		url: getRequestURL(event),
	};
	return event.web.request;
}

/**
 * The session utils are copied from `h3` with a few bug fixe regaring locking when sealing happens
 * so things dont get stuck.
 *
 * We intend to remove this section once this is upstreamed in h3.
 *
 */

const DEFAULT_NAME = "h3";
const DEFAULT_COOKIE = {
	path: "/",
	secure: true,
	httpOnly: true,
};

async function _useSession(
	/** @type {import('h3').H3Event} */ event,
	/** @type {import('h3').SessionConfig} */ config,
) {
	// Create a synced wrapper around the session
	const sessionName = config.name || DEFAULT_NAME;
	await getSession(event, config); // Force init

	/** @type {Awaited<ReturnType<import('h3')['useSession']>>} */
	const sessionManager = {
		get id() {
			return event.context.sessions?.[sessionName]?.id;
		},
		get data() {
			return event.context.sessions?.[sessionName]?.data || {};
		},
		update: async (update) => {
			await updateSession(event, config, update);
			return sessionManager;
		},
		clear: async () => {
			await clearSession(event, config);
			return sessionManager;
		},
	};
	return sessionManager;
}

async function _getSession(
	/** @type {import('h3').H3Event} */ event,
	/** @type {import('h3').SessionConfig} */ config,
) {
	const sessionName = config.name || DEFAULT_NAME;
	// Return existing session if available
	if (!event.context.sessions) {
		event.context.sessions = Object.create(null);
	}
	if (!event.context.sessionLocks) {
		event.context.sessionLocks = Object.create(null);
	}
	// Wait for existing session to load
	if (event.context.sessionLocks[sessionName]) {
		await event.context.sessionLocks[sessionName];
	}
	if (event.context.sessions[sessionName]) {
		return event.context.sessions[sessionName];
	}
	// Prepare an empty session object and store in context
	const session = {
		id: "",
		createdAt: 0,
		data: Object.create(null),
	};
	event.context.sessions[sessionName] = session;
	// Try to load session
	let sealedSession;
	// Try header first
	if (config.sessionHeader !== false) {
		const headerName =
			typeof config.sessionHeader === "string"
				? config.sessionHeader.toLowerCase()
				: `x-${sessionName.toLowerCase()}-session`;
		const headerValue = event.node.req.headers[headerName];
		if (typeof headerValue === "string") {
			sealedSession = headerValue;
		}
	}
	// Fallback to cookies
	if (!sealedSession) {
		sealedSession = getCookie(event, sessionName);
	}
	if (sealedSession) {
		// Unseal session data from cookie
		const lock = unsealSession(event, config, sealedSession)
			.catch(() => {})
			.then((unsealed) => {
				Object.assign(session, unsealed);
				// make sure deletion occurs before promise resolves
				delete event.context.sessionLocks[sessionName];
			});

		event.context.sessionLocks[sessionName] = lock;
		await lock;
	}
	// New session store in response cookies
	if (!session.id) {
		session.id =
			config.generateId?.() ?? (config.crypto || crypto).randomUUID();
		session.createdAt = Date.now();
		await updateSession(event, config);
	}
	return session;
}

async function _updateSession(
	/** @type {import('h3').H3Event} */ event,
	/** @type {import('h3').SessionConfig} */ config,
	update,
) {
	const sessionName = config.name || DEFAULT_NAME;
	// Access current session
	const session =
		event.context.sessions?.[sessionName] || (await getSession(event, config));
	// Update session data if provided
	if (typeof update === "function") {
		update = update(session.data);
	}
	if (update) {
		Object.assign(session.data, update);
	}
	// Seal and store in cookie
	if (config.cookie !== false) {
		const sealed = await sealSession(event, config);
		setCookie(event, sessionName, sealed, {
			...DEFAULT_COOKIE,
			expires: config.maxAge
				? new Date(session.createdAt + config.maxAge * 1000)
				: undefined,
			...config.cookie,
		});
	}
	return session;
}

async function _sealSession(
	/** @type {import('h3').H3Event} */ event,
	/** @type {import('h3').SessionConfig} */ config,
) {
	const sessionName = config.name || DEFAULT_NAME;
	// Access current session
	const session =
		event.context.sessions?.[sessionName] || (await getSession(event, config));
	const sealed = await seal(config.crypto || crypto, session, config.password, {
		...sealDefaults,
		ttl: config.maxAge ? config.maxAge * 1000 : 0,
		...config.seal,
	});
	return sealed;
}

export {
	H3Error,
	H3Event,
	MIMES,
	callNodeListener,
	clearResponseHeaders,
	createApp,
	createAppEventHandler,
	createEvent,
	createRouter,
	defineEventHandler,
	defineLazyEventHandler,
	defineNodeListener,
	defineNodeMiddleware,
	defineRequestMiddleware,
	defineResponseMiddleware,
	dynamicEventHandler,
	eventHandler,
	fromNodeMiddleware,
	fromPlainHandler,
	fromWebHandler,
	isError,
	isEventHandler,
	isWebResponse,
	lazyEventHandler,
	promisifyNodeListener,
	serveStatic,
	toEventHandler,
	toNodeListener,
	toPlainHandler,
	toWebHandler,
	isCorsOriginAllowed,
	isMethod,
	isPreflightRequest,
	isStream,
	createError,
	sanitizeStatusCode,
	sanitizeStatusMessage,
};

function getHTTPEvent() {
	return getEvent();
}

export function isEvent(obj) {
	return true;
	// Implement logic to check if obj is an H3Event
}

function createWrapperFunction(h3Function) {
	return function (...args) {
		let event = args[0];
		if (!isEvent(event)) {
			event = getHTTPEvent();
			if (!event) {
				throw new Error(
					`No HTTPEvent found in AsyncLocalStorage. Make sure you are using the function within the server runtime.`,
				);
			}
			args.unshift(event);
		}
		return h3Function(...args);
	};
}

// Creating wrappers for each utility and exporting them with their original names
export const readRawBody = createWrapperFunction(_readRawBody);
export const readBody = createWrapperFunction(_readBody);
export const getQuery = createWrapperFunction(_getQuery);
export const getValidatedQuery = createWrapperFunction(_getValidatedQuery);
export const getRouterParams = createWrapperFunction(_getRouterParams);
export const getRouterParam = createWrapperFunction(_getRouterParam);
export const getValidatedRouterParams = createWrapperFunction(
	_getValidatedRouterParams,
);
export const assertMethod = createWrapperFunction(_assertMethod);
export const getRequestHeaders = createWrapperFunction(_getRequestHeaders);
export const getRequestHeader = createWrapperFunction(_getRequestHeader);
export const getRequestURL = createWrapperFunction(_getRequestURL);
export const getRequestHost = createWrapperFunction(_getRequestHost);
export const getRequestProtocol = createWrapperFunction(_getRequestProtocol);
export const getRequestIP = createWrapperFunction(_getRequestIP);
export const send = createWrapperFunction(_send);
export const sendNoContent = createWrapperFunction(_sendNoContent);
export const setResponseStatus = createWrapperFunction(_setResponseStatus);
export const getResponseStatus = createWrapperFunction(_getResponseStatus);
export const getResponseStatusText = createWrapperFunction(
	_getResponseStatusText,
);
export const getResponseHeaders = createWrapperFunction(_getResponseHeaders);
export const getResponseHeader = createWrapperFunction(_getResponseHeader);
export const setResponseHeaders = createWrapperFunction(_setResponseHeaders);
export const setResponseHeader = createWrapperFunction(_setResponseHeader);
export const appendResponseHeaders = createWrapperFunction(
	_appendResponseHeaders,
);
export const appendResponseHeader = createWrapperFunction(
	_appendResponseHeader,
);
export const defaultContentType = createWrapperFunction(_defaultContentType);
export const sendRedirect = createWrapperFunction(_sendRedirect);
export const sendStream = createWrapperFunction(_sendStream);
export const writeEarlyHints = createWrapperFunction(_writeEarlyHints);
export const sendError = createWrapperFunction(_sendError);
export const useBase = createWrapperFunction(_useBase);
export const sendProxy = createWrapperFunction(_sendProxy);
export const proxyRequest = createWrapperFunction(_proxyRequest);
export const fetchWithEvent = createWrapperFunction(_fetchWithEvent);
export const getProxyRequestHeaders = createWrapperFunction(
	_getProxyRequestHeaders,
);
export const parseCookies = createWrapperFunction(_parseCookies);
export const getCookie = createWrapperFunction(_getCookie);
export const setCookie = createWrapperFunction(_setCookie);
export const deleteCookie = createWrapperFunction(_deleteCookie);
export const useSession = createWrapperFunction(_useSession);
export const getSession = createWrapperFunction(_getSession);
export const updateSession = createWrapperFunction(_updateSession);
export const sealSession = createWrapperFunction(_sealSession);
export const unsealSession = createWrapperFunction(_unsealSession);
export const clearSession = createWrapperFunction(_clearSession);
export const handleCacheHeaders = createWrapperFunction(_handleCacheHeaders);
export const handleCors = createWrapperFunction(_handleCors);
export const appendCorsHeaders = createWrapperFunction(_appendCorsHeaders);
export const appendCorsPreflightHeaders = createWrapperFunction(
	_appendCorsPreflightHeaders,
);
export const sendWebResponse = createWrapperFunction(_sendWebResponse);
export const appendHeader = createWrapperFunction(_appendHeader);
export const appendHeaders = createWrapperFunction(_appendHeaders);
export const setHeader = createWrapperFunction(_setHeader);
export const setHeaders = createWrapperFunction(_setHeaders);
export const getHeader = createWrapperFunction(_getHeader);
export const getHeaders = createWrapperFunction(_getHeaders);
export const getRequestFingerprint = createWrapperFunction(
	_getRequestFingerprint,
);
export const getRequestWebStream = createWrapperFunction(_getRequestWebStream);
export const readFormData = createWrapperFunction(_readFormData);
export const readMultipartFormData = createWrapperFunction(
	_readMultipartFormData,
);
export const readValidatedBody = createWrapperFunction(_readValidatedBody);
export const removeResponseHeader = createWrapperFunction(
	_removeResponseHeader,
);
export const getContext = createWrapperFunction(_getContext);
export const setContext = createWrapperFunction(_setContext);

export { createApp as createServer };
