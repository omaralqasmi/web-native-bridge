"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.bridge = exports.NativeWebBridge = void 0;
class NativeWebBridge {
    constructor(options = {}) {
        var _a, _b, _c;
        this.pendingRequests = new Map();
        this.handlers = new Map();
        this.listeners = new Map();
        // The Web Queue System
        this.isNativeReady = false;
        this.messageQueue = [];
        this.options = {
            timeout: (_a = options.timeout) !== null && _a !== void 0 ? _a : 30000,
            debug: (_b = options.debug) !== null && _b !== void 0 ? _b : false,
            namespace: (_c = options.namespace) !== null && _c !== void 0 ? _c : 'NativeBridgeReceiver'
        };
        if (typeof window !== 'undefined') {
            this.setupGlobalReceiver();
            this.autoUnlockQueue();
        }
    }
    autoUnlockQueue(attempts = 0) {
        var _a, _b;
        const win = window;
        // 1. Check if Android or iOS has injected its interface
        if (((_b = (_a = win.webkit) === null || _a === void 0 ? void 0 : _a.messageHandlers) === null || _b === void 0 ? void 0 : _b.iosInterface) || win.AndroidInterface) {
            this.log("✅ Native Interface Detected! Auto-unlocking web queue...");
            this.isNativeReady = true;
            this.flushQueue();
            return;
        }
        // 2. If not found, keep checking every 50ms (Cap at 5 seconds)
        if (attempts < 100) {
            setTimeout(() => this.autoUnlockQueue(attempts + 1), 50);
        }
        else {
            this.log("⚠️ No Native Interface found after 5 seconds. Running in Web-Only Mode.");
        }
    }
    setupGlobalReceiver() {
        window[this.options.namespace] = {
            receiveMessage: (b64) => this.handleIncoming(b64),
            signalReady: () => {
                if (!this.isNativeReady) {
                    this.log("✅ Native manually signaled readiness!");
                    this.isNativeReady = true;
                    this.flushQueue();
                }
            }
        };
    }
    encode(str) {
        const bytes = new TextEncoder().encode(str);
        const binString = Array.from(bytes, (byte) => String.fromCodePoint(byte)).join("");
        return btoa(binString);
    }
    decode(b64) {
        const binString = atob(b64);
        const bytes = Uint8Array.from(binString, (m) => m.codePointAt(0));
        return new TextDecoder().decode(bytes);
    }
    handleIncoming(b64) {
        try {
            const message = JSON.parse(this.decode(b64));
            this.log("⬇️ INCOMING FROM NATIVE:", message);
            if (message.type === 'response') {
                const deferred = this.pendingRequests.get(message.id);
                if (deferred) {
                    clearTimeout(deferred.timeoutId);
                    message.error ? deferred.reject(new Error(message.error)) : deferred.resolve(message.payload);
                    this.pendingRequests.delete(message.id);
                }
            }
            else {
                this.processIncomingAction(message);
            }
        }
        catch (e) {
            console.error("NativeWebBridge: Parse Error", e);
        }
    }
    async processIncomingAction(message) {
        var _a;
        if (!message.action)
            return;
        // Trigger event listeners (like event.app.resume)
        (_a = this.listeners.get(message.action)) === null || _a === void 0 ? void 0 : _a.forEach(cb => cb(message.payload));
        // Trigger registered handlers
        const handler = this.handlers.get(message.action);
        if (handler && message.type === 'request') {
            try {
                const response = await handler(message.payload);
                this.post({ id: message.id, type: 'response', payload: response });
            }
            catch (err) {
                this.post({ id: message.id, type: 'response', error: err.message || 'Unknown error' });
            }
        }
    }
    post(message) {
        const b64 = this.encode(JSON.stringify(message));
        // If Android hasn't called signalReady() yet, protect the message!
        if (!this.isNativeReady) {
            this.log("⏳ Queueing message until Native is ready:", message.action);
            this.messageQueue.push(b64);
            return;
        }
        this.dispatchToNative(b64);
    }
    flushQueue() {
        while (this.messageQueue.length > 0) {
            const b64 = this.messageQueue.shift();
            if (b64) {
                this.log("🚀 Flushing queued message to Native...");
                this.dispatchToNative(b64);
            }
        }
    }
    // A unified, try/catch protected dispatcher
    dispatchToNative(b64) {
        var _a, _b;
        try {
            const win = window;
            if ((_b = (_a = win.webkit) === null || _a === void 0 ? void 0 : _a.messageHandlers) === null || _b === void 0 ? void 0 : _b.iosInterface) {
                win.webkit.messageHandlers.iosInterface.postMessage(b64);
            }
            else if (win.AndroidInterface) {
                win.AndroidInterface.postMessage(b64);
            }
            else {
                this.log("⚠️ Warning: No native interface detected. Message lost.");
            }
        }
        catch (e) {
            console.error("NativeWebBridge: Failed to dispatch to native environment", e);
        }
    }
    log(...args) {
        if (this.options.debug)
            console.log("NativeWebBridge 🌉:", ...args);
    }
    request(action, payload) {
        return new Promise((resolve, reject) => {
            const id = typeof crypto !== 'undefined' && crypto.randomUUID
                ? crypto.randomUUID()
                : Math.random().toString(36).substring(2) + Date.now().toString(36);
            const timeoutId = setTimeout(() => {
                this.pendingRequests.delete(id);
                reject(new Error(`Bridge request timed out: ${action}`));
            }, this.options.timeout);
            this.pendingRequests.set(id, { resolve, reject, timeoutId });
            this.post({ id, type: 'request', action, payload });
        });
    }
    sendCommand(action, payload) {
        const id = typeof crypto !== 'undefined' && crypto.randomUUID
            ? crypto.randomUUID()
            : Math.random().toString(36).substring(2);
        this.post({ id, type: 'command', action, payload });
    }
    on(action, callback) {
        if (!this.listeners.has(action))
            this.listeners.set(action, new Set());
        this.listeners.get(action).add(callback);
        return () => { var _a; return (_a = this.listeners.get(action)) === null || _a === void 0 ? void 0 : _a.delete(callback); };
    }
    register(action, handler) {
        this.handlers.set(action, handler);
    }
}
exports.NativeWebBridge = NativeWebBridge;
// 1. Instantiate the core engine (Debug Mode ON for testing!)
const core = new NativeWebBridge({ debug: true });
// 2. Export your comprehensive API wrapping the engine
exports.bridge = {
    core: {
        registerHandler: core.register.bind(core),
        request: core.request.bind(core),
        sendCommand: core.sendCommand.bind(core),
        signalWebReady: () => core.sendCommand('system.core.webReady')
    },
    info: {
        getComplete: () => core.request('system.info.getComplete')
    },
    device: {
        getLanguage: () => core.request('system.device.getLanguage'),
        getBatteryLevel: () => core.request('system.device.getBatteryLevel')
    },
    screen: {
        setKeepScreenOn: (keepOn) => core.request('system.screen.setKeepScreenOn', { keepOn })
    },
    network: {
        getStatus: () => core.request('system.network.getStatus')
    },
    permissions: {
        check: (type) => core.request('system.permissions.check', { type }),
        request: (type) => core.request('system.permissions.request', { type })
    },
    contacts: {
        pick: () => core.request('system.contacts.pick')
    },
    location: {
        getCurrent: () => core.request('system.location.getCurrent')
    },
    file: {
        pick: () => core.request('system.file.pick')
    },
    audio: {
        playSystemSound: () => core.request('system.audio.playSound')
    },
    app: {
        openSettings: () => core.request('system.app.openSettings'),
        requestRating: () => core.request('system.app.requestRating'),
        forceUpdate: (storeUrl) => core.request('system.app.forceUpdate', { url: storeUrl }),
        exit: () => core.request('system.app.exit'),
        clearCaches: () => core.request('system.app.clearCaches')
    },
    ui: {
        setTheme: (theme) => core.request('system.ui.setTheme', { theme }),
        getTheme: () => core.request('system.ui.getTheme'),
        showToast: (message, duration = 'short') => core.request('system.ui.showToast', { message, duration }),
        showAlert: (title, message, buttonText = 'OK') => core.request('system.ui.showAlert', { title, message, buttonText }),
        showConfirm: (title, message, okText = 'Yes', cancelText = 'No') => core.request('system.ui.showConfirm', { title, message, okText, cancelText })
    },
    notifications: {
        getToken: () => core.request('system.notifications.getToken'),
        setToken: (token) => core.request('system.notifications.setToken', { token })
    },
    media: {
        takePhoto: (options) => core.request('system.media.takePhoto', options),
        pickImage: (options) => core.request('system.media.pickImage', options),
        downloadImage: (url) => core.request('system.media.downloadImage', { url })
    },
    share: {
        text: (text, title) => core.request('system.share.text', { text, title }),
        link: (url, title) => core.request('system.share.link', { url, title }),
        image: (base64Data, fileName = 'shared_image.png') => core.request('system.share.image', { base64Data, fileName }),
        video: (base64Data, fileName = 'shared_video.mp4') => core.request('system.share.video', { base64Data, fileName })
    },
    communication: {
        dialNumber: (phoneNumber) => core.request('system.communication.dial', { phoneNumber }),
        openBrowser: (url) => core.request('system.communication.openBrowser', { url })
    },
    hardware: {
        triggerHaptic: (style = 'medium') => core.request('system.hardware.haptic', { style }),
        toggleFlashlight: (on) => core.request('system.hardware.flashlight', { on })
    },
    storage: {
        setItem: (key, value) => core.request('system.storage.setItem', { key, value }),
        getItem: (key) => core.request('system.storage.getItem', { key }),
    },
    secureStorage: {
        setItem: (key, value) => core.request('system.secureStorage.setItem', { key, value }),
        getItem: (key) => core.request('system.secureStorage.getItem', { key })
    },
    biometrics: {
        authenticate: (reason = 'Authenticate') => core.request('system.biometrics.authenticate', { reason })
    },
    clipboard: {
        copy: (text) => core.request('system.clipboard.copy', { text }),
        read: () => core.request('system.clipboard.read')
    },
    custom: {
        /** Send a custom request to Native and await a response */
        invoke: (action, payload) => core.request(action, payload),
        /** Fire a fire-and-forget custom command to Native */
        send: (action, payload) => core.sendCommand(action, payload),
        /** Listen for a custom event fired by Native */
        listen: (action, callback) => core.on(action, callback)
    },
    events: {
        onAppPause: (callback) => core.on('event.app.pause', callback),
        onAppResume: (callback) => core.on('event.app.resume', callback),
        onThemeChanged: (callback) => core.on('event.ui.themeChanged', callback),
        onPushNotification: (callback) => core.on('event.notifications.push', callback),
        onBackButton: (callback) => core.on('event.app.backButton', callback),
        // NEW: Advanced events
        onDeepLink: (callback) => core.on('event.app.deepLink', callback),
        onNetworkChanged: (callback) => core.on('event.network.statusChanged', callback),
        onKeyboardChanged: (callback) => core.on('event.ui.keyboardChanged', callback)
    }
};
