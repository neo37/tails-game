import Foundation
import UniformTypeIdentifiers
import WebKit

/// Отдаёт игру из Tails.app/www по адресам tails://app/… — как статический сервер:
/// у страниц свой origin, поэтому ES-модули, importmap, fetch моделей и localStorage работают как на сайте.
final class BundleSchemeHandler: NSObject, WKURLSchemeHandler {
    private let root: URL

    init(root: URL) {
        self.root = root.standardizedFileURL
    }

    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        guard let url = task.request.url else {
            task.didFailWithError(URLError(.badURL))
            return
        }
        var path = url.path
        if path.isEmpty || path.hasSuffix("/") { path += "index.html" }
        let file = root.appendingPathComponent(path).standardizedFileURL
        // только файлы внутри www: «..» в адресе наружу не выпускает
        guard file.path.hasPrefix(root.path + "/"), let data = try? Data(contentsOf: file, options: .mappedIfSafe) else {
            respond(task, url: url, status: 404, type: "text/plain; charset=utf-8", data: Data("Not found".utf8))
            return
        }
        respond(task, url: url, status: 200, type: Self.mimeType(file.pathExtension), data: data)
    }

    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {
        // ответ отдаётся сразу целиком в start — останавливать нечего
    }

    private func respond(_ task: WKURLSchemeTask, url: URL, status: Int, type: String, data: Data) {
        let headers = ["Content-Type": type, "Content-Length": String(data.count), "Cache-Control": "no-cache"]
        let response = HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: headers)!
        task.didReceive(response)
        task.didReceive(data)
        task.didFinish()
    }

    /// Модули обязаны приходить с JS-типом, а тексты — в UTF-8 (в игре русский текст).
    static func mimeType(_ ext: String) -> String {
        switch ext.lowercased() {
        case "html", "htm": return "text/html; charset=utf-8"
        case "js", "mjs": return "text/javascript; charset=utf-8"
        case "css": return "text/css; charset=utf-8"
        case "json": return "application/json; charset=utf-8"
        case "svg": return "image/svg+xml"
        case "glb": return "model/gltf-binary"
        case "gltf": return "model/gltf+json"
        case "wasm": return "application/wasm"
        case "ktx2": return "image/ktx2"
        case "txt": return "text/plain; charset=utf-8"
        default: return UTType(filenameExtension: ext)?.preferredMIMEType ?? "application/octet-stream"
        }
    }
}
