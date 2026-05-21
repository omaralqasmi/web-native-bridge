import Foundation
import WebKit
import UIKit
import LocalAuthentication
import AVFoundation
import ContactsUI
import CoreLocation
import Network
import StoreKit
import UserNotifications

public class NativeWebBridge: NSObject, WKScriptMessageHandler {
    
    // MARK: - Properties
    public var isDebugMode: Bool = false
    
    private weak var webView: WKWebView?
    private weak var viewController: UIViewController?
    private var customHandlers: [String: ([String: Any], @escaping (Any?, String?) -> Void) -> Void] = [:]
    private var isWebReady = false
    private var nativeMessageQueue: [String] = []
    private var activeCallback: ((Any?, String?) -> Void)?
    
    private let locationManager = CLLocationManager()
    private let networkMonitor = NWPathMonitor()
    
    // MARK: - Lifecycle & Initialization
    public init(viewController: UIViewController, configuration: WKWebViewConfiguration) {
        self.viewController = viewController
        super.init()
        
        // Register all common aliases the NPM library might use
        configuration.userContentController.add(self, name: "iosInterface")
        configuration.userContentController.add(self, name: "nativeWebBridge")
        configuration.userContentController.add(self, name: "NativeWebBridge")
        
        locationManager.delegate = self
        setupLifecycleHooks()
        setupNetworkMonitor()
        registerDefaultHandlers()
    }    
    
    public func attachWebView(_ webView: WKWebView) {
        self.webView = webView
    }
    
    private func setupLifecycleHooks() {
        NotificationCenter.default.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { [weak self] _ in 
            self?.sendCommandToWeb(action: "event.app.pause") 
        }
        NotificationCenter.default.addObserver(forName: UIApplication.willEnterForegroundNotification, object: nil, queue: .main) { [weak self] _ in 
            self?.sendCommandToWeb(action: "event.app.resume") 
        }
        NotificationCenter.default.addObserver(forName: UIResponder.keyboardWillShowNotification, object: nil, queue: .main) { [weak self] _ in 
            self?.sendCommandToWeb(action: "event.ui.keyboardChanged", payload: ["isVisible": true]) 
        }
        NotificationCenter.default.addObserver(forName: UIResponder.keyboardWillHideNotification, object: nil, queue: .main) { [weak self] _ in 
            self?.sendCommandToWeb(action: "event.ui.keyboardChanged", payload: ["isVisible": false]) 
        }
    }
    
    private func setupNetworkMonitor() {
        networkMonitor.pathUpdateHandler = { [weak self] path in
            let connected = path.status == .satisfied
            let type = path.usesInterfaceType(.wifi) ? "wifi" : (path.usesInterfaceType(.cellular) ? "cellular" : "none")
            self?.sendCommandToWeb(action: "event.network.statusChanged", payload: ["connected": connected, "type": type])
        }
        networkMonitor.start(queue: DispatchQueue.global(qos: .background))
    }
    
    public func triggerDeepLink(url: String) { 
        sendCommandToWeb(action: "event.app.deepLink", payload: ["url": url]) 
    }
    
    public func triggerBackButton() { 
        sendCommandToWeb(action: "event.app.backButton") 
    }
    
    // MARK: - Core Inbound Parser
    public func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        if isDebugMode { print("📥 NATIVE BRIDGE RAW INBOUND: \(message.body)") }
        var dict: [String: Any]? = nil
        
        if let bodyDict = message.body as? [String: Any] {
            dict = bodyDict
        } else if let str = message.body as? String {
            // Try standard JSON first
            if let data = str.data(using: .utf8),
               let parsed = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                dict = parsed
            } else {
                // Try Base64, fixing Swift's strict padding limitations
                var b64 = str.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
                let remainder = b64.count % 4
                if remainder > 0 { b64 += String(repeating: "=", count: 4 - remainder) }
                
                if let data = Data(base64Encoded: b64),
                   let parsed = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                    dict = parsed
                }
            }
        }
        
        guard let payloadDict = dict else {
            print("❌ NATIVE BRIDGE FATAL: Could not parse Vue message. Payload: \(message.body)")
            return 
        }
        
        if isDebugMode { print("✅ NATIVE BRIDGE PARSED: \(payloadDict)") }
        
        let type = payloadDict["type"] as? String ?? ""
        let id = payloadDict["id"] as? String ?? ""
        let action = payloadDict["action"] as? String ?? ""
        let payload = payloadDict["payload"] as? [String: Any] ?? [:]
        
        if type == "request" || type == "command" { 
            if let handler = customHandlers[action] { 
                handler(payload) { [weak self] res, err in 
                    if type == "request" { self?.sendResponse(id: id, payload: res, error: err) } 
                } 
            } else if type == "request" { 
                sendResponse(id: id, payload: nil, error: "Not implemented on iOS: \(action)") 
            } 
        }
    }
    
    // MARK: - Core Outbound Senders
    private func sendResponse(id: String, payload: Any?, error: String?) {
        var response: [String: Any] = ["id": id, "type": "response"]
        if let p = payload { response["payload"] = p }
        if let e = error { response["error"] = e }
        
        do {
            let data = try JSONSerialization.data(withJSONObject: response)
            let b64 = data.base64EncodedString()
            if isDebugMode { print("📤 NATIVE BRIDGE OUTBOUND: Sending response for ID \(id)") }
            dispatchToWeb(base64Payload: b64)
        } catch {
            print("❌ NATIVE BRIDGE ENCODE ERROR: \(error)")
        }
    }
    
    public func sendCommandToWeb(action: String, payload: [String: Any]? = nil) {
        var req: [String: Any] = ["id": UUID().uuidString, "type": "command", "action": action]
        if let p = payload { req["payload"] = p }
        
        if let data = try? JSONSerialization.data(withJSONObject: req) { 
            dispatchToWeb(base64Payload: data.base64EncodedString()) 
        }
    }
    
    private func dispatchToWeb(base64Payload: String) {
        let script = "if(window.NativeBridgeReceiver) { window.NativeBridgeReceiver.receiveMessage('\(base64Payload)'); } else { console.log('❌ Vue NativeBridgeReceiver missing'); }"
        
        DispatchQueue.main.async { 
            if self.isWebReady { 
                self.webView?.evaluateJavaScript(script) { _, err in
                    if let e = err { print("❌ JS EXECUTION ERROR: \(e)") }
                } 
            } else { 
                self.nativeMessageQueue.append(script) 
            } 
        }
    }
    
    private func flushNativeQueue() { 
        DispatchQueue.main.async { 
            self.nativeMessageQueue.forEach { self.webView?.evaluateJavaScript($0, completionHandler: nil) }
            self.nativeMessageQueue.removeAll() 
        } 
    }
    
    public func registerHandler(action: String, handler: @escaping ([String: Any], @escaping (Any?, String?) -> Void) -> Void) { 
        customHandlers[action] = handler 
    }
    
    // MARK: - Default API Handlers
    private func registerDefaultHandlers() {
        
        // Core
        registerHandler(action: "system.core.webReady") { [weak self] _, cb in 
            self?.isWebReady = true
            self?.flushNativeQueue()
            cb(["success": true], nil) 
        }
        
        // Info & Device
        registerHandler(action: "system.info.getComplete") { _, cb in 
            cb([
                "appVersion": Bundle.main.infoDictionary?["CFBundleShortVersionString"] ?? "Unknown", 
                "osName": "iOS", 
                "osVersion": UIDevice.current.systemVersion, 
                "deviceName": UIDevice.current.name, 
                "deviceModel": UIDevice.current.model, 
                "platform": "ios"
            ], nil) 
        }
        
        registerHandler(action: "system.device.getLanguage") { _, cb in 
            cb(Locale.preferredLanguages.first ?? "en-US", nil) 
        }
        
        registerHandler(action: "system.device.getBatteryLevel") { _, cb in 
            UIDevice.current.isBatteryMonitoringEnabled = true
            let lvl = Int(UIDevice.current.batteryLevel * 100)
            cb(lvl >= 0 ? lvl : 100, nil) 
        }
        
        registerHandler(action: "system.screen.setKeepScreenOn") { p, cb in 
            DispatchQueue.main.async { 
                UIApplication.shared.isIdleTimerDisabled = p["keepOn"] as? Bool ?? true
                cb(true, nil) 
            } 
        }
        
        registerHandler(action: "system.network.getStatus") { [weak self] _, cb in 
            let p = self?.networkMonitor.currentPath
            cb([
                "connected": p?.status == .satisfied, 
                "type": p?.usesInterfaceType(.wifi) == true ? "wifi" : (p?.usesInterfaceType(.cellular) == true ? "cellular" : "none")
            ], nil) 
        }
        
        // Permissions
        registerHandler(action: "system.permissions.check") { p, cb in
            let type = p["type"] as? String ?? ""
            if type == "camera" { 
                cb(AVCaptureDevice.authorizationStatus(for: .video) == .authorized, nil) 
            } else if type == "notifications" { 
                UNUserNotificationCenter.current().getNotificationSettings { settings in 
                    DispatchQueue.main.async { 
                        cb(settings.authorizationStatus == .authorized || settings.authorizationStatus == .provisional, nil) 
                    } 
                } 
            } else { 
                cb(true, nil) 
            }
        }
        
        registerHandler(action: "system.permissions.request") { p, cb in
            let type = p["type"] as? String ?? ""
            if type == "camera" { 
                AVCaptureDevice.requestAccess(for: .video) { granted in 
                    DispatchQueue.main.async { cb(granted, nil) } 
                } 
            } else if type == "notifications" { 
                UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .badge, .sound]) { granted, error in 
                    DispatchQueue.main.async { cb(granted, error?.localizedDescription) } 
                } 
            } else { 
                cb(true, nil) 
            }
        }
        
        // Location & Audio
        registerHandler(action: "system.location.getCurrent") { [weak self] _, cb in 
            DispatchQueue.main.async { 
                self?.activeCallback = cb
                self?.locationManager.requestWhenInUseAuthorization()
                self?.locationManager.requestLocation() 
            } 
        }
        
        registerHandler(action: "system.audio.playSound") { _, cb in 
            AudioServicesPlaySystemSound(1003)
            cb(true, nil) 
        }
        
        // App Actions
        registerHandler(action: "system.app.openSettings") { _, cb in 
            DispatchQueue.main.async { 
                if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
                cb(true, nil) 
            } 
        }
        
        registerHandler(action: "system.app.requestRating") { _, cb in 
            DispatchQueue.main.async { 
                if let scene = UIApplication.shared.connectedScenes.first(where: { $0.activationState == .foregroundActive }) as? UIWindowScene { 
                    SKStoreReviewController.requestReview(in: scene) 
                }
                cb(true, nil) 
            } 
        }
        
        registerHandler(action: "system.app.forceUpdate") { p, cb in 
            DispatchQueue.main.async { 
                if let url = URL(string: p["url"] as? String ?? "itms-apps://itunes.apple.com/") { 
                    UIApplication.shared.open(url) 
                }
                cb(true, nil) 
            } 
        }
        
        registerHandler(action: "system.app.exit") { _, cb in 
            cb(false, "Apple forbids programmatic exits.") 
        }
        
        registerHandler(action: "system.app.clearCaches") { _, cb in 
            DispatchQueue.main.async { 
                let dataStore = WKWebsiteDataStore.default()
                let allTypes = WKWebsiteDataStore.allWebsiteDataTypes()
                dataStore.removeData(ofTypes: allTypes, modifiedSince: Date(timeIntervalSince1970: 0)) { 
                    cb(true, nil) 
                } 
            } 
        }
        
        // UI
        registerHandler(action: "system.ui.getTheme") { _, cb in 
            DispatchQueue.main.async { 
                cb(UIScreen.main.traitCollection.userInterfaceStyle == .dark ? "dark" : "light", nil) 
            } 
        }
        
        registerHandler(action: "system.ui.setTheme") { [weak self] p, cb in 
            DispatchQueue.main.async { 
                let t = p["theme"] as? String
                self?.viewController?.view.window?.overrideUserInterfaceStyle = t == "dark" ? .dark : (t == "light" ? .light : .unspecified)
                cb(true, nil) 
            } 
        }
        
        registerHandler(action: "system.ui.showToast") { [weak self] p, cb in 
            DispatchQueue.main.async { 
                let a = UIAlertController(title: nil, message: p["message"] as? String, preferredStyle: .alert)
                self?.viewController?.present(a, animated: true)
                DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { 
                    a.dismiss(animated: true)
                    cb(true, nil) 
                } 
            } 
        }
        
        registerHandler(action: "system.ui.showAlert") { [weak self] p, cb in 
            DispatchQueue.main.async { 
                let a = UIAlertController(title: p["title"] as? String, message: p["message"] as? String, preferredStyle: .alert)
                a.addAction(UIAlertAction(title: p["buttonText"] as? String ?? "OK", style: .default) { _ in cb(true, nil) })
                self?.viewController?.present(a, animated: true) 
            } 
        }
        
        registerHandler(action: "system.ui.showConfirm") { [weak self] p, cb in 
            DispatchQueue.main.async { 
                let a = UIAlertController(title: p["title"] as? String, message: p["message"] as? String, preferredStyle: .alert)
                a.addAction(UIAlertAction(title: p["okText"] as? String ?? "Yes", style: .default) { _ in cb(true, nil) })
                a.addAction(UIAlertAction(title: p["cancelText"] as? String ?? "No", style: .cancel) { _ in cb(false, nil) })
                self?.viewController?.present(a, animated: true) 
            } 
        }
        
        // Notifications
        registerHandler(action: "system.notifications.getToken") { _, cb in 
            cb(UserDefaults.standard.string(forKey: "PushToken"), nil) 
        }
        
        registerHandler(action: "system.notifications.setToken") { p, cb in 
            UserDefaults.standard.set(p["token"], forKey: "PushToken")
            cb(true, nil) 
        }
        
        // Media
        registerHandler(action: "system.media.takePhoto") { [weak self] _, cb in 
            DispatchQueue.main.async { 
                self?.activeCallback = cb
                let pk = UIImagePickerController()
                pk.sourceType = .camera
                pk.delegate = self
                self?.viewController?.present(pk, animated: true) 
            } 
        }
        
        registerHandler(action: "system.media.pickImage") { [weak self] _, cb in 
            DispatchQueue.main.async { 
                self?.activeCallback = cb
                let pk = UIImagePickerController()
                pk.sourceType = .photoLibrary
                pk.delegate = self
                self?.viewController?.present(pk, animated: true) 
            } 
        }
        
        registerHandler(action: "system.media.downloadImage") { p, cb in 
            guard let uStr = p["url"] as? String, let url = URL(string: uStr) else { 
                return cb(false, "Invalid URL") 
            }
            URLSession.shared.dataTask(with: url) { d, _, _ in 
                if let d = d, let img = UIImage(data: d) { 
                    UIImageWriteToSavedPhotosAlbum(img, nil, nil, nil)
                    cb(true, nil) 
                } else { 
                    cb(false, "Failed to download image") 
                } 
            }.resume() 
        }
        
        // Sharing
        registerHandler(action: "system.share.text") { [weak self] p, cb in 
            DispatchQueue.main.async { 
                let ac = UIActivityViewController(activityItems: [p["text"] as? String ?? ""], applicationActivities: nil)
                self?.viewController?.present(ac, animated: true)
                cb(true, nil) 
            } 
        }
        
        registerHandler(action: "system.share.link") { [weak self] p, cb in 
            DispatchQueue.main.async { 
                if let url = URL(string: p["url"] as? String ?? "") { 
                    let ac = UIActivityViewController(activityItems: [url], applicationActivities: nil)
                    self?.viewController?.present(ac, animated: true)
                    cb(true, nil) 
                } else { 
                    cb(false, "Invalid URL") 
                } 
            } 
        }
        
        registerHandler(action: "system.share.image") { [weak self] p, cb in 
            DispatchQueue.main.async { 
                guard let b64 = p["base64Data"] as? String, 
                      let d = Data(base64Encoded: b64, options: .ignoreUnknownCharacters), 
                      let img = UIImage(data: d) else { 
                    return cb(false, "Invalid data") 
                }
                let ac = UIActivityViewController(activityItems: [img], applicationActivities: nil)
                self?.viewController?.present(ac, animated: true)
                cb(true, nil) 
            } 
        }
        
        registerHandler(action: "system.share.video") { [weak self] p, cb in 
            DispatchQueue.main.async { 
                guard let b64 = p["base64Data"] as? String, 
                      let d = Data(base64Encoded: b64, options: .ignoreUnknownCharacters) else { 
                    return cb(false, "Invalid data") 
                }
                let tmp = FileManager.default.temporaryDirectory.appendingPathComponent(p["fileName"] as? String ?? "video.mp4")
                try? d.write(to: tmp)
                let ac = UIActivityViewController(activityItems: [tmp], applicationActivities: nil)
                self?.viewController?.present(ac, animated: true)
                cb(true, nil) 
            } 
        }
        
        // Communication
        registerHandler(action: "system.communication.dial") { p, cb in 
            DispatchQueue.main.async { 
                if let url = URL(string: "tel://\(p["phoneNumber"] as? String ?? "")") { 
                    UIApplication.shared.open(url)
                    cb(true, nil) 
                } 
            } 
        }
        
        registerHandler(action: "system.communication.openBrowser") { p, cb in 
            DispatchQueue.main.async { 
                if let url = URL(string: p["url"] as? String ?? "") { 
                    UIApplication.shared.open(url)
                    cb(true, nil) 
                } 
            } 
        }
        
        // Hardware
        registerHandler(action: "system.hardware.haptic") { p, cb in 
            DispatchQueue.main.async { 
                let g = UIImpactFeedbackGenerator(style: (p["style"] as? String == "heavy") ? .heavy : .medium)
                g.prepare()
                g.impactOccurred()
                cb(true, nil) 
            } 
        }
        
        registerHandler(action: "system.hardware.flashlight") { p, cb in 
            guard let d = AVCaptureDevice.default(for: .video), d.hasTorch else { 
                return cb(false, "No flash") 
            }
            try? d.lockForConfiguration()
            d.torchMode = (p["on"] as? Bool == true) ? .on : .off
            d.unlockForConfiguration()
            cb(true, nil) 
        }
        
        // Storage
        registerHandler(action: "system.storage.setItem") { p, cb in 
            UserDefaults.standard.set(p["value"], forKey: p["key"] as? String ?? "")
            cb(true, nil) 
        }
        
        registerHandler(action: "system.storage.getItem") { p, cb in 
            cb(UserDefaults.standard.value(forKey: p["key"] as? String ?? ""), nil) 
        }
        
        registerHandler(action: "system.secureStorage.setItem") { p, cb in 
            guard let k = p["key"] as? String, 
                  let v = p["value"] as? String, 
                  let d = v.data(using: .utf8) else { 
                return cb(false, "Error") 
            }
            let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrAccount as String: k]
            SecItemDelete(q as CFDictionary)
            
            let a: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrAccount as String: k, kSecValueData as String: d]
            cb(SecItemAdd(a as CFDictionary, nil) == errSecSuccess, nil) 
        }
        
        registerHandler(action: "system.secureStorage.getItem") { p, cb in 
            guard let k = p["key"] as? String else { return cb(nil, "Error") }
            let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrAccount as String: k, kSecReturnData as String: true, kSecMatchLimit as String: kSecMatchLimitOne]
            var i: CFTypeRef?
            
            if SecItemCopyMatching(q as CFDictionary, &i) == errSecSuccess, 
               let d = i as? Data, 
               let v = String(data: d, encoding: .utf8) { 
                cb(v, nil) 
            } else { 
                cb(nil, nil) 
            } 
        }
        
        // Miscellaneous
        registerHandler(action: "system.clipboard.copy") { p, cb in 
            DispatchQueue.main.async { 
                UIPasteboard.general.string = p["text"] as? String
                cb(true, nil) 
            } 
        }
        
        registerHandler(action: "system.clipboard.read") { _, cb in 
            DispatchQueue.main.async { 
                cb(UIPasteboard.general.string ?? "", nil) 
            } 
        }
        
        registerHandler(action: "system.biometrics.authenticate") { p, cb in 
            let c = LAContext()
            var e: NSError?
            if c.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &e) { 
                c.evaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, localizedReason: p["reason"] as? String ?? "Auth") { s, _ in 
                    cb(s, s ? nil : "Failed") 
                } 
            } else { 
                cb(false, "Unavailable") 
            } 
        }
        
        registerHandler(action: "system.contacts.pick") { [weak self] _, cb in 
            DispatchQueue.main.async { 
                self?.activeCallback = cb
                let pk = CNContactPickerViewController()
                pk.delegate = self
                self?.viewController?.present(pk, animated: true) 
            } 
        }
        
        registerHandler(action: "system.file.pick") { [weak self] _, cb in 
            DispatchQueue.main.async { 
                self?.activeCallback = cb
                let pk = UIDocumentPickerViewController(forOpeningContentTypes: [.data], asCopy: true)
                pk.delegate = self
                self?.viewController?.present(pk, animated: true) 
            } 
        }
    }
}

// MARK: - CoreLocation Delegate
extension NativeWebBridge: CLLocationManagerDelegate {
    public func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) { 
        if let loc = locations.last { 
            activeCallback?(["lat": loc.coordinate.latitude, "lng": loc.coordinate.longitude], nil)
            activeCallback = nil 
        } 
    }
    
    public func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) { 
        activeCallback?(nil, error.localizedDescription)
        activeCallback = nil 
    }
}

// MARK: - Picker & Controller Delegates
extension NativeWebBridge: CNContactPickerDelegate, UIDocumentPickerDelegate, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
    
    public func contactPicker(_ picker: CNContactPickerViewController, didSelect contact: CNContact) { 
        activeCallback?(["name": "\(contact.givenName) \(contact.familyName)", "phoneNumber": contact.phoneNumbers.first?.value.stringValue ?? ""], nil)
        activeCallback = nil 
    }
    
    public func contactPickerDidCancel(_ picker: CNContactPickerViewController) { 
        activeCallback?(nil, "Cancelled")
        activeCallback = nil 
    }
    
    public func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) { 
        if let url = urls.first, let d = try? Data(contentsOf: url) { 
            activeCallback?(["name": url.lastPathComponent, "base64": d.base64EncodedString()], nil) 
        }
        activeCallback = nil 
    }
    
    public func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) { 
        activeCallback?(nil, "Cancelled")
        activeCallback = nil 
    }
    
    public func imagePickerController(_ picker: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey : Any]) { 
        picker.dismiss(animated: true)
        if let i = info[.originalImage] as? UIImage, let d = i.jpegData(compressionQuality: 0.8) { 
            activeCallback?(["base64": d.base64EncodedString()], nil) 
        }
        activeCallback = nil 
    }
    
    public func imagePickerControllerDidCancel(_ picker: UIImagePickerController) { 
        picker.dismiss(animated: true)
        activeCallback?(nil, "Cancelled")
        activeCallback = nil 
    }
}