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
export declare class NativeWebBridge {
    private pendingRequests;
    private handlers;
    private listeners;
    private isNativeReady;
    private messageQueue;
    private readonly options;
    constructor(options?: BridgeOptions);
    private autoUnlockQueue;
    private setupGlobalReceiver;
    private encode;
    private decode;
    private handleIncoming;
    private processIncomingAction;
    private post;
    private flushQueue;
    private dispatchToNative;
    private log;
    request<T = any>(action: string, payload?: any): Promise<T>;
    sendCommand(action: string, payload?: any): void;
    on(action: string, callback: (payload: any) => void): () => boolean | undefined;
    register(action: string, handler: (payload: any) => any): void;
}
export declare const bridge: {
    core: {
        registerHandler: (action: string, handler: (payload: any) => any) => void;
        request: <T = any>(action: string, payload?: any) => Promise<T>;
        sendCommand: (action: string, payload?: any) => void;
        signalWebReady: () => void;
    };
    info: {
        getComplete: () => Promise<{
            appVersion: string;
            osName: string;
            osVersion: string;
            deviceName: string;
            deviceModel: string;
            platform: string;
        }>;
    };
    device: {
        getLanguage: () => Promise<string>;
        getBatteryLevel: () => Promise<number>;
    };
    screen: {
        setKeepScreenOn: (keepOn: boolean) => Promise<any>;
    };
    network: {
        getStatus: () => Promise<{
            connected: boolean;
            type: "wifi" | "cellular" | "none";
        }>;
    };
    permissions: {
        check: (type: "camera" | "location" | "notifications" | "storage" | "contacts") => Promise<boolean>;
        request: (type: "camera" | "location" | "notifications" | "storage" | "contacts") => Promise<boolean>;
    };
    contacts: {
        pick: () => Promise<{
            name: string;
            phoneNumber: string;
        } | null>;
    };
    location: {
        getCurrent: () => Promise<{
            lat: number;
            lng: number;
        }>;
    };
    file: {
        pick: () => Promise<{
            name: string;
            base64: string;
        } | null>;
    };
    audio: {
        playSystemSound: () => Promise<any>;
    };
    app: {
        openSettings: () => Promise<any>;
        requestRating: () => Promise<any>;
        forceUpdate: (storeUrl?: string) => Promise<any>;
        exit: () => Promise<any>;
        clearCaches: () => Promise<any>;
    };
    ui: {
        setTheme: (theme: "light" | "dark" | "system") => Promise<any>;
        getTheme: () => Promise<"light" | "dark" | "system">;
        showToast: (message: string, duration?: "short" | "long") => Promise<any>;
        showAlert: (title: string, message: string, buttonText?: string) => Promise<any>;
        showConfirm: (title: string, message: string, okText?: string, cancelText?: string) => Promise<boolean>;
    };
    notifications: {
        getToken: () => Promise<string | null>;
        setToken: (token: string) => Promise<any>;
    };
    media: {
        takePhoto: (options?: {
            base64?: boolean;
        }) => Promise<{
            uri?: string;
            base64?: string;
        }>;
        pickImage: (options?: {
            base64?: boolean;
        }) => Promise<{
            base64?: string;
        }>;
        downloadImage: (url: string) => Promise<any>;
    };
    share: {
        text: (text: string, title?: string) => Promise<any>;
        link: (url: string, title?: string) => Promise<any>;
        image: (base64Data: string, fileName?: string) => Promise<any>;
        video: (base64Data: string, fileName?: string) => Promise<any>;
    };
    communication: {
        dialNumber: (phoneNumber: string) => Promise<any>;
        openBrowser: (url: string) => Promise<any>;
    };
    hardware: {
        triggerHaptic: (style?: "light" | "medium" | "heavy") => Promise<any>;
        toggleFlashlight: (on: boolean) => Promise<any>;
    };
    storage: {
        setItem: (key: string, value: any) => Promise<any>;
        getItem: (key: string) => Promise<any>;
    };
    secureStorage: {
        setItem: (key: string, value: string) => Promise<any>;
        getItem: (key: string) => Promise<string | null>;
    };
    biometrics: {
        authenticate: (reason?: string) => Promise<boolean>;
    };
    clipboard: {
        copy: (text: string) => Promise<any>;
        read: () => Promise<string>;
    };
    custom: {
        /** Send a custom request to Native and await a response */
        invoke: <T = any>(action: string, payload?: any) => Promise<T>;
        /** Fire a fire-and-forget custom command to Native */
        send: (action: string, payload?: any) => void;
        /** Listen for a custom event fired by Native */
        listen: (action: string, callback: (payload: any) => void) => () => boolean | undefined;
    };
    events: {
        onAppPause: (callback: () => void) => () => boolean | undefined;
        onAppResume: (callback: () => void) => () => boolean | undefined;
        onThemeChanged: (callback: (payload: {
            theme: "light" | "dark";
        }) => void) => () => boolean | undefined;
        onPushNotification: (callback: (payload: any) => void) => () => boolean | undefined;
        onBackButton: (callback: () => void) => () => boolean | undefined;
        onDeepLink: (callback: (payload: {
            url: string;
        }) => void) => () => boolean | undefined;
        onNetworkChanged: (callback: (payload: {
            connected: boolean;
            type: string;
        }) => void) => () => boolean | undefined;
        onKeyboardChanged: (callback: (payload: {
            isVisible: boolean;
        }) => void) => () => boolean | undefined;
    };
};
