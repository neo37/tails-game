import UIKit
import WebKit

/// «Хвосты»: WebView во весь экран с игрой из Tails.app/www (её кладёт туда ios/sync_web.sh при сборке).
/// То же, что android/…/MainActivity.java: свой origin для страниц, ссылки наружу — в Safari, перезапуск упавшей страницы.
final class GameViewController: UIViewController {
    static let scheme = "tails"
    static let home = URL(string: "tails://app/index.html")!

    private var web: WKWebView!

    override func loadView() {
        let cfg = WKWebViewConfiguration()
        let www = Bundle.main.resourceURL!.appendingPathComponent("www", isDirectory: true)
        cfg.setURLSchemeHandler(BundleSchemeHandler(root: www), forURLScheme: Self.scheme)
        cfg.websiteDataStore = .default()   // прогресс и свои уровни (localStorage) переживают перезапуск
        cfg.allowsInlineMediaPlayback = true
        cfg.mediaTypesRequiringUserActionForPlayback = []
        cfg.userContentController.addUserScript(WKUserScript(source: Self.appStyle, injectionTime: .atDocumentEnd, forMainFrameOnly: true))
#if DEBUG
        cfg.userContentController.addUserScript(WKUserScript(source: Self.consoleBridge, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        cfg.userContentController.add(ConsoleLog(), name: "console")
        // свой скрипт на каждой странице: `-js '…'` при запуске (так ios/screenshots.sh расставляет сцены для магазина)
        if let js = Self.launchArgument("js") {
            cfg.userContentController.addUserScript(WKUserScript(source: js, injectionTime: .atDocumentEnd, forMainFrameOnly: true))
        }
#endif
        let web = WKWebView(frame: .zero, configuration: cfg)
        web.isOpaque = false   // без белой вспышки до первой отрисовки
        web.backgroundColor = .black
        web.scrollView.backgroundColor = .black
        web.scrollView.bounces = false
        // страницы сами обходят вырезы экрана: viewport-fit=cover + env(safe-area-inset-*)
        web.scrollView.contentInsetAdjustmentBehavior = .never
        web.allowsLinkPreview = false
        web.navigationDelegate = self
        web.uiDelegate = self
#if DEBUG
        if #available(iOS 16.4, *) { web.isInspectable = true }   // Safari → Разработка → Симулятор
#endif
        self.web = web
        view = web
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        var url = Self.home
#if DEBUG
        // сразу нужная страница: xcrun simctl launch <udid> business.spacecode.tails -page 'play.html?map=castle&level=1'
        if let page = Self.launchArgument("page"), let u = URL(string: page, relativeTo: Self.home) { url = u }
#endif
        web.load(URLRequest(url: url))
    }

#if DEBUG
    /// Значение после `-имя` в аргументах запуска как есть (UserDefaults разбирал бы «(…)» как plist-массив).
    private static func launchArgument(_ name: String) -> String? {
        let args = ProcessInfo.processInfo.arguments
        guard let i = args.firstIndex(of: "-" + name), i + 1 < args.count else { return nil }
        return args[i + 1]
    }
#endif

    override var prefersStatusBarHidden: Bool { true }
    override var prefersHomeIndicatorAutoHidden: Bool { true }
    // свайп от края сначала только показывает полоску «домой» — из игры не выйти случайно, водя джойстиком
    override var preferredScreenEdgesDeferringSystemGestures: UIRectEdge { .all }
    override var supportedInterfaceOrientations: UIInterfaceOrientationMask { .landscape }

    private static func isGame(_ url: URL) -> Bool {
        ["tails", "about", "blob", "data"].contains(url.scheme ?? "")
    }

    /// То, что в браузере не нужно, а в приложении мешает: меню и лупа по долгому нажатию,
    /// серая подсветка касаний, автоувеличение шрифта в горизонтальном положении.
    private static let appStyle = """
    (() => {
      const s = document.createElement('style');
      s.textContent = `html { -webkit-text-size-adjust: 100%; }
        * { -webkit-touch-callout: none; -webkit-tap-highlight-color: transparent; }
        body { -webkit-user-select: none; user-select: none; }
        input, textarea, [contenteditable] { -webkit-user-select: text; user-select: text; }`;
      document.head.appendChild(s);
    })();
    """

#if DEBUG
    /// Отладка: console.* и ошибки страницы — в консоль Xcode (и в `xcrun simctl launch --console`).
    private static let consoleBridge = """
    (() => {
      const str = (x) => { if (x instanceof Error) return x.stack || String(x); if (typeof x === 'string') return x;
        try { return JSON.stringify(x); } catch (e) { return String(x); } };
      const send = (level, args) => { try { webkit.messageHandlers.console.postMessage(level + ': ' + Array.from(args, str).join(' ')); } catch (e) { /* */ } };
      for (const level of ['log', 'info', 'warn', 'error']) {
        const orig = console[level].bind(console);
        console[level] = (...a) => { send(level, a); orig(...a); };
      }
      addEventListener('error', (e) => send('error', [e.message ? `${e.message} @ ${e.filename}:${e.lineno}`
        : `не загрузилось: ${e.target?.src || e.target?.href}`]), true);
      addEventListener('unhandledrejection', (e) => send('unhandled rejection', [e.reason]));
      addEventListener('DOMContentLoaded', () => send('page', [location.href, 'secure=' + isSecureContext]));
    })();
    """
#endif
}

extension GameViewController: WKNavigationDelegate {
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url, !Self.isGame(url), action.targetFrame?.isMainFrame != false else {
            decisionHandler(.allow)
            return
        }
        // ссылки наружу (видео, сайт) — в Safari или в своём приложении
        UIApplication.shared.open(url)
        decisionHandler(.cancel)
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        // процесс страницы упал (например, не хватило памяти) — открываем её заново, а не оставляем пустой экран
        if webView.url != nil { webView.reload() } else { webView.load(URLRequest(url: Self.home)) }
    }
}

extension GameViewController: WKUIDelegate {
    /// target="_blank" и window.open: страницы игры — в этом же окне, остальное — в Safari.
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = action.request.url {
            if Self.isGame(url) { webView.load(action.request) } else { UIApplication.shared.open(url) }
        }
        return nil
    }

    // WKWebView сам не показывает alert/confirm: без этого confirm() всегда давал бы «нет»
    // (в «Гонке» так спрашивают перед удалением трассы и перед жалобой)
    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        guard presentedViewController == nil else { return completionHandler() }
        let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "ОК", style: .default) { _ in completionHandler() })
        present(alert, animated: true)
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        guard presentedViewController == nil else { return completionHandler(false) }
        let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "Отмена", style: .cancel) { _ in completionHandler(false) })
        alert.addAction(UIAlertAction(title: "ОК", style: .default) { _ in completionHandler(true) })
        present(alert, animated: true)
    }
}

#if DEBUG
private final class ConsoleLog: NSObject, WKScriptMessageHandler {
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        NSLog("[web] %@", String(describing: message.body))
    }
}
#endif
