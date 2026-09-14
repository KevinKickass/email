//! Developer helper: stdin HTML -> JSON containing the same renderer output as mail.
#[path = "../src/html.rs"]
#[allow(dead_code)]
mod html;
type Result<T> = std::result::Result<T, String>;
fn main() -> Result<()> {
    use std::io::Read;
    let mut source = String::new();
    std::io::stdin()
        .take(html::MAX_HTML as u64 + 1)
        .read_to_string(&mut source)
        .map_err(|e| e.to_string())?;
    let rendered = html::render(&source)?;
    println!(
        "{}",
        serde_json::json!({"html":rendered.html,"text":rendered.text,"links":rendered.links})
    );
    Ok(())
}
