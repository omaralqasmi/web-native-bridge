export type MessageType = 'request' | 'response' | 'command' | 'handshake';

export interface BridgeMessage<T = any> {
    id: string;
    type: MessageType;
    action?: string;
    payload?: T;
    error?: string;
}

export interface BridgeOptions {
    timeout?: number;
    debug?: boolean;
    namespace?: string;
}

export class NativeWebBridge {
    private pendingRequests = new Map<string, {
        resolve: (v: any) => void,
        reject: (e: any) => void,
        timeoutId: any
    }>();

    private handlers = new Map<string, (payload: any) => any>();
    private listeners = new Map<string, Set<(payload: any) => void>>();
    
    // The Web Queue System
    private isNativeReady = false;
    private messageQueue: string[] = [];

    private readonly options: Required<BridgeOptions>;

    constructor(options: BridgeOptions = {}) {
        this.options = {
            timeout: options.timeout ?? 30000,
            debug: options.debug ?? false,
            namespace: options.namespace ?? 'NativeBridgeReceiver'
        };

        if (typeof window !== 'undefined') {
            this.setupGlobalReceiver();
            this.autoUnlockQueue();
        }
    }
    private autoUnlockQueue(attempts = 0) {
        const win = window as any;
        
        // 1. Check if Android or iOS has injected its interface
        if (win.webkit?.messageHandlers?.iosInterface || win.AndroidInterface) {
            this.log("✅ Native Interface Detected! Auto-unlocking web queue...");
            this.isNativeReady = true;
            this.flushQueue();
            return;
        }
        
        // 2. If not found, keep checking every 50ms (Cap at 5 seconds)
        if (attempts < 100) {
            setTimeout(() => this.autoUnlockQueue(attempts + 1), 50);
        } else {
            this.log("⚠️ No Native Interface found after 5 seconds. Running in Web-Only Mode.");
        }
    }
    private setupGlobalReceiver() {
        (window as any)[this.options.namespace] = {
            receiveMessage: (b64: string) => this.handleIncoming(b64),
            signalReady: () => {
                if (!this.isNativeReady) {
                    this.log("✅ Native manually signaled readiness!");
                    this.isNativeReady = true;
                    this.flushQueue();
                }            
            }
        };
    }

    private encode(str: string): string {
        const bytes = new TextEncoder().encode(str);
        const binString = Array.from(bytes, (byte) => String.fromCodePoint(byte)).join("");
        return btoa(binString);
    }

    private decode(b64: string): string {
        const binString = atob(b64);
        const bytes = Uint8Array.from(binString, (m) => m.codePointAt(0)!);
        return new TextDecoder().decode(bytes);
    }

    private handleIncoming(b64: string) {
        try {
            const message: BridgeMessage = JSON.parse(this.decode(b64));
            this.log("⬇️ INCOMING FROM NATIVE:", message);

            if (message.type === 'response') {
                const deferred = this.pendingRequests.get(message.id);
                if (deferred) {
                    clearTimeout(deferred.timeoutId);
                    message.error ? deferred.reject(new Error(message.error)) : deferred.resolve(message.payload);
                    this.pendingRequests.delete(message.id);
                }
            } else {
                this.processIncomingAction(message);
            }
        } catch (e) {
            console.error("NativeWebBridge: Parse Error", e);
        }
    }

    private async processIncomingAction(message: BridgeMessage) {
        if (!message.action) return;

        // Trigger event listeners (like event.app.resume)
        this.listeners.get(message.action)?.forEach(cb => cb(message.payload));

        // Trigger registered handlers
        const handler = this.handlers.get(message.action);
        if (handler && message.type === 'request') {
            try {
                const response = await handler(message.payload);
                this.post({ id: message.id, type: 'response', payload: response });
            } catch (err: any) {
                this.post({ id: message.id, type: 'response', error: err.message || 'Unknown error' });
            }
        }
    }

    private post(message: BridgeMessage) {
        const b64 = this.encode(JSON.stringify(message));

        // If Android hasn't called signalReady() yet, protect the message!
        if (!this.isNativeReady) {
            this.log("⏳ Queueing message until Native is ready:", message.action);
            this.messageQueue.push(b64);
            return;
        }

        this.dispatchToNative(b64);
    }

    private flushQueue() {
        while (this.messageQueue.length > 0) {
            const b64 = this.messageQueue.shift();
            if (b64) {
                this.log("🚀 Flushing queued message to Native...");
                this.dispatchToNative(b64);
            }
        }
    }

    // A unified, try/catch protected dispatcher
    private dispatchToNative(b64: string) {
        try {
            const win = window as any;
            if (win.webkit?.messageHandlers?.iosInterface) {
                win.webkit.messageHandlers.iosInterface.postMessage(b64);
            } else if (win.AndroidInterface) {
                win.AndroidInterface.postMessage(b64);
            } else {
                this.log("⚠️ Warning: No native interface detected. Message lost.");
            }
        } catch (e) {
            console.error("NativeWebBridge: Failed to dispatch to native environment", e);
        }
    }

    private log(...args: any[]) {
        if (this.options.debug) console.log("NativeWebBridge 🌉:", ...args);
    }

    public request<T = any>(action: string, payload?: any): Promise<T> {
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

    public sendCommand(action: string, payload?: any) {
        const id = typeof crypto !== 'undefined' && crypto.randomUUID
            ? crypto.randomUUID()
            : Math.random().toString(36).substring(2);
        this.post({ id, type: 'command', action, payload });
    }

    public on(action: string, callback: (payload: any) => void) {
        if (!this.listeners.has(action)) this.listeners.set(action, new Set());
        this.listeners.get(action)!.add(callback);
        return () => this.listeners.get(action)?.delete(callback);
    }

    public register(action: string, handler: (payload: any) => any) {
        this.handlers.set(action, handler);
    }
}

// 1. Instantiate the core engine (Debug Mode ON for testing!)
const core = new NativeWebBridge({ debug: true });

// 2. Export your comprehensive API wrapping the engine
export const bridge = {
    core: {
        registerHandler: core.register.bind(core),
        request: core.request.bind(core),
        sendCommand: core.sendCommand.bind(core),
        signalWebReady: () => core.sendCommand('system.core.webReady')
    },
    info: {
        getComplete: () => core.request<{ appVersion: string, osName: string, osVersion: string, deviceName: string, deviceModel: string, platform: string }>('system.info.getComplete')
    },
    device: {
        getLanguage: () => core.request<string>('system.device.getLanguage'),
        getBatteryLevel: () => core.request<number>('system.device.getBatteryLevel')
    },
    screen: {
        setKeepScreenOn: (keepOn: boolean) => core.request('system.screen.setKeepScreenOn', { keepOn })
    },
    network: {
        getStatus: () => core.request<{ connected: boolean, type: 'wifi' | 'cellular' | 'none' }>('system.network.getStatus')
    },
    permissions: {
        check: (type: 'camera' | 'location' | 'notifications' | 'storage' | 'contacts') => core.request<boolean>('system.permissions.check', { type }),
        request: (type: 'camera' | 'location' | 'notifications' | 'storage'| 'contacts') => core.request<boolean>('system.permissions.request', { type })
    },
    contacts: {
        pick: () => core.request<{ name: string, phoneNumber: string } | null>('system.contacts.pick')
    },
    location: {
        getCurrent: () => core.request<{ lat: number, lng: number }>('system.location.getCurrent')
    },
    file: {
        pick: () => core.request<{ name: string, base64: string } | null>('system.file.pick')
    },
    audio: {
        playSystemSound: () => core.request('system.audio.playSound')
    },
    app: {
        openSettings: () => core.request('system.app.openSettings'),
        requestRating: () => core.request('system.app.requestRating'),
        forceUpdate: (storeUrl?: string) => core.request('system.app.forceUpdate', { url: storeUrl }),
        exit: () => core.request('system.app.exit'),
        clearCaches: () => core.request('system.app.clearCaches')
    },
    ui: {
        setTheme: (theme: 'light' | 'dark' | 'system') => core.request('system.ui.setTheme', { theme }),
        getTheme: () => core.request<'light' | 'dark' | 'system'>('system.ui.getTheme'),
        showToast: (message: string, duration: 'short' | 'long' = 'short') => core.request('system.ui.showToast', { message, duration }),
        showAlert: (title: string, message: string, buttonText: string = 'OK') => core.request('system.ui.showAlert', { title, message, buttonText }),
        showConfirm: (title: string, message: string, okText: string = 'Yes', cancelText: string = 'No') => core.request<boolean>('system.ui.showConfirm', { title, message, okText, cancelText })
    },
    notifications: {
        getToken: () => core.request<string | null>('system.notifications.getToken'),
        setToken: (token: string) => core.request('system.notifications.setToken', { token })
    },
    media: {
        takePhoto: (options?: { base64?: boolean }) => core.request<{ uri?: string, base64?: string }>('system.media.takePhoto', options),
        pickImage: (options?: { base64?: boolean }) => core.request<{ base64?: string }>('system.media.pickImage', options),
        downloadImage: (url: string) => core.request('system.media.downloadImage', { url })
    },
    share: {
        text: (text: string, title?: string) => core.request('system.share.text', { text, title }),
        link: (url: string, title?: string) => core.request('system.share.link', { url, title }),
        image: (base64Data: string, fileName: string = 'shared_image.png') => core.request('system.share.image', { base64Data, fileName }),
        video: (base64Data: string, fileName: string = 'shared_video.mp4') => core.request('system.share.video', { base64Data, fileName })
    },
    communication: {
        dialNumber: (phoneNumber: string) => core.request('system.communication.dial', { phoneNumber }),
        openBrowser: (url: string) => core.request('system.communication.openBrowser', { url })
    },
    hardware: {
        triggerHaptic: (style: 'light' | 'medium' | 'heavy' = 'medium') => core.request('system.hardware.haptic', { style }),
        toggleFlashlight: (on: boolean) => core.request('system.hardware.flashlight', { on })
    },
    storage: {
        setItem: (key: string, value: any) => core.request('system.storage.setItem', { key, value }),
        getItem: (key: string) => core.request<any>('system.storage.getItem', { key }),
    },
    secureStorage: {
        setItem: (key: string, value: string) => core.request('system.secureStorage.setItem', { key, value }),
        getItem: (key: string) => core.request<string | null>('system.secureStorage.getItem', { key })
    },
    biometrics: {
        authenticate: (reason: string = 'Authenticate') => core.request<boolean>('system.biometrics.authenticate', { reason })
    },
    clipboard: {
        copy: (text: string) => core.request('system.clipboard.copy', { text }),
        read: () => core.request<string>('system.clipboard.read')
    },
    custom: {
        /** Send a custom request to Native and await a response */
        invoke: <T = any>(action: string, payload?: any) => core.request<T>(action, payload),
        
        /** Fire a fire-and-forget custom command to Native */
        send: (action: string, payload?: any) => core.sendCommand(action, payload),
        
        /** Listen for a custom event fired by Native */
        listen: (action: string, callback: (payload: any) => void) => core.on(action, callback)
    },
    events: {
        onAppPause: (callback: () => void) => core.on('event.app.pause', callback),
        onAppResume: (callback: () => void) => core.on('event.app.resume', callback),
        onThemeChanged: (callback: (payload: { theme: 'light' | 'dark' }) => void) => core.on('event.ui.themeChanged', callback),
        onPushNotification: (callback: (payload: any) => void) => core.on('event.notifications.push', callback),
        onBackButton: (callback: () => void) => core.on('event.app.backButton', callback),
        // NEW: Advanced events
        onDeepLink: (callback: (payload: { url: string }) => void) => core.on('event.app.deepLink', callback),
        onNetworkChanged: (callback: (payload: { connected: boolean, type: string }) => void) => core.on('event.network.statusChanged', callback),
        onKeyboardChanged: (callback: (payload: { isVisible: boolean }) => void) => core.on('event.ui.keyboardChanged', callback)
        }
};