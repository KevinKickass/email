//! HTML is parsed and sanitised in Rust, before any bytes enter a WebView.
//! The frontend adds a separate opaque, scriptless sandbox and a deny-all CSP.
use crate::Result;
use ammonia::{Builder, Url, UrlRelative};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};

pub const MAX_HTML: usize = 2 * 1024 * 1024;
const MAX_MARKUP: usize = 10_000;
const MAX_NODES: usize = 20_000;
const MAX_DEPTH: usize = 128;
const MAX_LINKS: usize = 100;

pub struct Rendered {
    pub html: String,
    pub text: String,
    pub links: Vec<String>,
}

// Shared with the native opener: no relative URLs, credentials, local files,
// custom schemes, controls or command-line arguments reach the OS handler.
pub fn web_url(value: &str) -> Result<String> {
    if value.len() > 2048 || value.chars().any(char::is_control) || value.trim() != value {
        return Err("Dieser Link kann nicht geöffnet werden.".into());
    }
    let url = Url::parse(value).map_err(|_| "Dieser Link kann nicht geöffnet werden.")?;
    if !matches!(url.scheme(), "https" | "http")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("Dieser Link kann nicht geöffnet werden.".into());
    }
    Ok(url.to_string())
}

pub fn escape(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

fn bounded_html(source: &str) -> Result<()> {
    if source.len() > MAX_HTML {
        return Err(
            "HTML-Inhalt ist größer als 2 MiB. Nur-Text wird angezeigt, sofern vorhanden.".into(),
        );
    }
    if source
        .bytes()
        .filter(|b| *b == b'<')
        .take(MAX_MARKUP + 1)
        .count()
        > MAX_MARKUP
    {
        return Err(
            "HTML-Inhalt ist zu komplex. Nur-Text wird angezeigt, sofern vorhanden.".into(),
        );
    }
    // html5ever parses offline; RcDom's traversal and destruction are iterative.
    // Check actual parser-created nodes, not a regex approximation of nesting.
    let dom = html2text::config::plain()
        .parse_html(source.as_bytes())
        .map_err(|_| "HTML-Inhalt konnte nicht gelesen werden.")?;
    let mut queue = vec![(dom.document.clone(), 0)];
    let mut count = 0;
    while let Some((node, depth)) = queue.pop() {
        count += 1;
        if count > MAX_NODES || depth > MAX_DEPTH {
            return Err(
                "HTML-Inhalt ist zu komplex. Nur-Text wird angezeigt, sofern vorhanden.".into(),
            );
        }
        queue.extend(
            node.children
                .borrow()
                .iter()
                .map(|child| (child.clone(), depth + 1)),
        );
    }
    Ok(())
}

pub fn render(source: &str) -> Result<Rendered> {
    bounded_html(source)?;
    let links = Arc::new(Mutex::new(Vec::<String>::new()));
    let captured = Arc::clone(&links);
    let html = Builder::new()
        .tags(
            [
                "a",
                "abbr",
                "b",
                "blockquote",
                "br",
                "caption",
                "code",
                "dd",
                "del",
                "div",
                "dl",
                "dt",
                "em",
                "h1",
                "h2",
                "h3",
                "h4",
                "h5",
                "h6",
                "hr",
                "i",
                "img",
                "ins",
                "li",
                "ol",
                "p",
                "pre",
                "s",
                "small",
                "span",
                "strong",
                "sub",
                "sup",
                "table",
                "tbody",
                "td",
                "tfoot",
                "th",
                "thead",
                "tr",
                "u",
                "ul",
            ]
            .into(),
        )
        .clean_content_tags(
            [
                "script",
                "style",
                "iframe",
                "object",
                "embed",
                "applet",
                "svg",
                "math",
                "form",
                "input",
                "button",
                "select",
                "textarea",
                "template",
                "noscript",
                "head",
                "audio",
                "video",
                "canvas",
                "xmp",
                "plaintext",
            ]
            .into(),
        )
        .generic_attributes(["style", "dir", "lang"].into())
        .tag_attributes(HashMap::from([
            ("a", ["href"].into()),
            ("img", ["alt"].into()),
            ("td", ["colspan", "rowspan"].into()),
            ("th", ["colspan", "rowspan"].into()),
            ("ol", ["start"].into()),
        ]))
        // These properties cannot fetch resources or position content over app UI.
        // CSS rules, sizes, positioning, URLs, fonts, variables and images are omitted.
        .filter_style_properties(
            [
                "color",
                "background-color",
                "font-weight",
                "font-style",
                "text-align",
                "text-decoration-line",
                "vertical-align",
            ]
            .into(),
        )
        .url_schemes(["https", "http"].into())
        .url_relative(UrlRelative::Deny)
        .link_rel(None)
        .attribute_filter(move |tag, attribute, value| {
            match (tag, attribute) {
                ("a", "href") => {
                    if let Ok(url) = web_url(value) {
                        let mut links = captured.lock().unwrap();
                        if links.len() < MAX_LINKS && !links.contains(&url) {
                            links.push(url);
                        }
                    }
                    None // no navigation, even inside the sandbox
                }
                (_, "colspan" | "rowspan") => value
                    .parse::<u16>()
                    .ok()
                    .filter(|v| (1..=100).contains(v))
                    .map(|_| value.into()),
                (_, "start") => value.parse::<i16>().ok().map(|_| value.into()),
                (_, "dir") => matches!(value, "ltr" | "rtl" | "auto").then(|| value.into()),
                (_, "style") => {
                    // Also exclude functions/escapes, including CSS URL obfuscation.
                    (!value.contains(['(', ')', '\\', '@', '{', '}', '!']) && value.len() <= 2048)
                        .then(|| value.into())
                }
                _ => (value.len() <= 2048 && !value.chars().any(|c| c.is_control()))
                    .then(|| value.into()),
            }
        })
        .clean(source)
        .to_string();
    // Keep the fallback independent of sender CSS, including hidden/white text.
    let mut text = html2text::config::plain()
        .raw_mode(true)
        .allow_width_overflow()
        .string_from_read(html.as_bytes(), 80)
        .map_err(|_| "Nur-Text konnte nicht aus HTML erstellt werden.")?;
    let links = links.lock().unwrap().clone();
    if !links.is_empty() {
        text.push('\n');
        for link in &links {
            text.push_str(link);
            text.push('\n');
        }
    }
    Ok(Rendered { html, text, links })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn keeps_readable_structure_and_only_non_fetching_inline_styles() {
        let result = render("<h2>Grüße &amp; news</h2><table><tr><th>Item</th><th>Count</th></tr><tr><td><b>Paper</b></td><td>2</td></tr></table><p style='color:blue;font-weight:bold;position:fixed;top:0;background:url(https://tracker.invalid/x)'>Hello</p>").unwrap();
        assert!(result.html.contains("<table>"));
        assert!(result.html.contains("<b>Paper</b>"));
        assert!(result.text.contains("Grüße & news"));
        assert!(result.text.contains("Paper"));
        assert!(!result.html.contains("position"));
        assert!(!result.html.contains("tracker.invalid"));
        let colors =
            render("<p style='color:blue; font-weight:bold; width:9999px'>blue</p>").unwrap();
        assert!(colors.html.contains("color:blue"));
        assert!(!colors.html.contains("width"));
    }
    #[test]
    fn strips_active_content_network_sources_and_navigation() {
        let source = r#"<base href="https://bad.invalid/"><meta http-equiv="refresh" content="0; url=https://bad.invalid"><link rel="stylesheet" href="https://bad.invalid/style"><script>alert(1)</script><style>@import 'https://bad.invalid/css';</style><iframe srcdoc="<script>alert(2)</script>"></iframe><form action="https://bad.invalid"><input autofocus><button>Sign in</button></form><svg><a xlink:href="javascript:alert(1)">SVG</a></svg><math><mtext><img src=x onerror=alert(1)></mtext></math><img src="https://bad.invalid/pixel" srcset="https://bad.invalid/2 2x" onerror="alert(1)" alt="Logo"><img src="cid:logo"><img src="data:image/svg+xml,bad"><p id="root" class="modal" onclick="alert(1)">Actual message</p><a href="javascript:alert(1)">danger</a><a href="file:///etc/passwd">file</a><a href="https://good.example/path" ping="https://bad.invalid/ping" target="_top">Good</a>"#;
        let result = render(source).unwrap();
        for needle in [
            "<script",
            "<style",
            "<iframe",
            "<form",
            "<svg",
            "<math",
            "<meta",
            "<base",
            "<link",
            "src=",
            "srcset",
            "onerror",
            "onclick",
            "href=",
            "ping=",
            "target=",
            "id=",
            "class=",
            "bad.invalid",
            "alert(",
            "javascript:",
            "file:",
            "data:",
            "cid:",
        ] {
            assert!(
                !result.html.contains(needle),
                "unexpected {needle}: {}",
                result.html
            );
        }
        assert!(result.text.contains("Actual message"));
        assert_eq!(result.links, ["https://good.example/path"]);
    }
    #[test]
    fn handles_obfuscated_markup_and_rejects_unsafe_url_schemes() {
        for source in [
            r#"<IMG SRC=JaVaScRiPt:alert(1)>"#,
            r#"<a href="java&#x09;script:alert(1)">x</a>"#,
            r#"<svg><foreignObject><p onload=alert(1)>x</p></foreignObject></svg>"#,
            r#"<math><mtext><table><mglyph><style><!--</style><img title="--><img src=x onerror=alert(1)>">"#,
            r#"<p style="background-image:u\72l(https://bad.invalid);color:var(--x)">x</p>"#,
        ] {
            let cleaned = render(source).unwrap();
            assert!(cleaned.links.is_empty());
            assert!(!cleaned.html.contains("onerror="));
            assert!(!cleaned.html.contains("src="));
            assert!(!cleaned.html.contains("href="));
            assert!(!cleaned.html.contains("style="));
        }
        for url in [
            "javascript:alert(1)",
            "data:text/html,x",
            "file:///etc/passwd",
            "mailto:x@example.org",
            "//example.org",
            "/relative",
            "https://user:pass@example.org",
            "https://example.org/\n",
            " https://example.org",
            "--help",
        ] {
            assert!(web_url(url).is_err(), "accepted {url}");
        }
        assert_eq!(
            web_url("https://bücher.example/").unwrap(),
            "https://xn--bcher-kva.example/"
        );
    }
    #[test]
    fn limits_size_nesting_links_and_table_spans() {
        assert!(render(&"x".repeat(MAX_HTML + 1)).is_err());
        assert!(render(&format!(
            "{}text{}",
            "<div>".repeat(150),
            "</div>".repeat(150)
        ))
        .is_err());
        let huge = render("<table><tr><td colspan=999999999 rowspan=999999999>x</td></tr></table>")
            .unwrap();
        assert!(!huge.html.contains("span="));
        let source = (0..110)
            .map(|n| format!("<a href='https://example.org/{n}'>Link</a>"))
            .collect::<String>();
        assert_eq!(render(&source).unwrap().links.len(), 100);
    }
    #[test]
    fn browser_fixture_retains_content_and_removes_every_probe_target() {
        let result = render(include_str!("../../tests/fixtures/hostile-email.html")).unwrap();
        assert!(result.html.contains("formatted message"));
        assert!(!result.html.contains("127.0.0.1"));
        assert!(!result.html.contains("href="));
        assert!(!result.html.contains("SCRIPT EXECUTED"));
        assert_eq!(result.links, ["https://example.org/actual-destination"]);
    }
}
