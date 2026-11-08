/**
 * The platform contract: everything the shared engine needs from a transport.
 * Platform modules (src/platforms/*) own transport, formatting, limits, admin rules,
 * prompt sections, tools, commands and lifecycle. The engine must not branch on a
 * platform name.
 *
 * Normalized incoming message passed to the shared agent.
 * @typedef {Object} BotEvent
 * @property {'text'|'image'|'sticker'|'voice'|'unsupported'|'unknown'} kind
 * @property {string} chatId
 * @property {string} chatType
 * @property {string} senderId
 * @property {string} senderName
 * @property {boolean} isBot
 * @property {string} text
 * @property {string|null} imageUrl
 * @property {string[]} [imageUrls] every image attachment, largest first (max 5)
 * @property {{data: Buffer, contentType?: string}|null} [imageData] validated bytes for vision models
 * @property {{data: Buffer, contentType?: string}[]} [imageDataList] validated bytes for every image
 * @property {string|null} sticker
 * @property {string} messageId
 * @property {number} date
 * @property {string} eventName
 * @property {'discord'} [platform]
 * @property {string} [botName]
 * @property {boolean} [isAdmin]
 * @property {boolean} [private] the answer is visible only to the sender; keep it out of shared context
 * @property {any} [rawMessage]
 * @property {any} [rawInteraction]
 *
 * @typedef {Object} PlatformTransport
 * @property {string} [displayName]
 * @property {any} [client] underlying platform SDK client, when the entry needs to wire events
 * @property {() => Promise<void>} [start] connect the transport (optional; the entry may own this)
 * @property {() => Promise<void>} [stop] disconnect the transport
 * @property {(chatId: string, text: string, options?: {replyToMessageId?: string}) => Promise<any>} sendMessage
 * @property {(chatId: string, url: string, caption?: string, options?: {data?: Buffer, contentType?: string}) => Promise<any>} sendPhoto
 * @property {(chatId: string, stickerId: string) => Promise<any>} [sendSticker]
 * @property {(chatId: string) => (() => Promise<void>|void)} startTyping
 * @property {() => void} stopAllTyping
 * @property {(chatId?: string) => number|Promise<number>} ping
 * @property {(chatId: string, messageId: string, text: string) => Promise<any>} [editMessage]
 * @property {(chatId: string, messageId: string, emoji: string) => Promise<any>} [react]
 * @property {(chatId: string, name: string) => Promise<any>} [createThread]
 */

/**
 * @typedef {Object} PlatformCapabilities
 * @property {boolean} stickers
 * @property {boolean} uploadMedia
 * @property {boolean} nativeInteractions
 * @property {boolean} messageEdits
 * @property {boolean} threads
 */

/**
 * @typedef {Object} PlatformLimits
 * @property {number} text
 * @property {number} caption
 */

/**
 * @typedef {Object} PlatformPrompt
 * @property {(registry: any, options: any) => void} register
 * @property {Record<string, string>} [toolGuidance]
 */

/**
 * @typedef {Object} PlatformCommands
 * @property {Array<Record<string, any>>} specs
 * @property {Record<string, string>} [helpOverrides]
 * @property {string} [helpNote]
 * @property {(name: string, args: string, ctx: any) => Promise<any>|any} [run]
 * @property {Record<string, (interaction: any) => Promise<void>|void>} [native]
 */

/**
 * @typedef {Object} PlatformTools
 * @property {(input: {config: any}) => any[]} [definitions]
 * @property {(name: string, args: any, ctx: any) => Promise<{ok: boolean, text: string, data?: any}|null>} [run]
 */

/**
 * @typedef {Object} PlatformStartInput
 * @property {(event: any) => void} onEvent
 * @property {AbortSignal} [signal]
 * @property {boolean} [once]
 */

/**
 * @typedef {Object} PlatformStartResult
 * @property {any} [ready] info for the startup banner
 * @property {Promise<void>} done resolves when message intake stops
 */

/**
 * @typedef {Object} Platform
 * @property {'discord'} name
 * @property {string} label human-readable platform name for user-facing text
 * @property {PlatformTransport} transport
 * @property {'gateway'|'polling'|'webhook'} transportMode
 * @property {PlatformCapabilities} capabilities
 * @property {PlatformLimits} limits
 * @property {(text: string) => string} formatOutgoing
 * @property {(event: any) => boolean} isAdmin
 * @property {PlatformPrompt} prompt
 * @property {PlatformCommands} commands
 * @property {PlatformTools} [tools]
 * @property {any} [stickers] platform sticker service, when supported
 * @property {string[]} healthServices
 * @property {(error: any) => string|null} explainError
 * @property {(input: PlatformStartInput) => Promise<PlatformStartResult>} start
 * @property {() => Promise<void>} stop
 * @property {(event: any, helpers: {stopTyping: () => Promise<void>|void}) => Promise<boolean>} [handleIncoming]
 */

export {};