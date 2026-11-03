//! Explicit, message-scoped image loading. The WebView never fetches sender URLs.
use crate::{html, Result};
use base64::{engine::general_purpose::STANDARD, Engine};
use reqwest::{blocking::Client, redirect::Policy, Url};
use serde::Serialize;
use std::{
    io::Read,
    net::{IpAddr, SocketAddr},
    time::{Duration, Instant},
};

const MAX_IMAGE_BYTES: usize = 5 * 1024 * 1024;
const MAX_TOTAL_BYTES: usize = 20 * 1024 * 1024;
const TIME_BUDGET: Duration = Duration::from_secs(30);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Image {
    pub index: usize,
    pub data_url: String,
}
#[derive(Serialize)]
pub struct Loaded {
    pub images: Vec<Image>,
    pub failed: usize,
}

fn public_address(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => {
            let [a, b, c, _] = ip.octets();
            !(matches!(a, 0 | 10 | 127)
                || a >= 224
                || (a == 100 && (64..=127).contains(&b))
                || (a == 169 && b == 254)
                || (a == 172 && (16..=31).contains(&b))
                || (a == 192 && (b == 168 || b == 0 || (b == 88 && c == 99)))
                || (a == 198 && (b == 18 || b == 19 || (b == 51 && c == 100)))
                || (a == 203 && b == 0 && c == 113))
        }
        IpAddr::V6(ip) => {
            let s = ip.segments();
            // Global unicast only; exclude documentation and transition tunnels.
            s[0] & 0xe000 == 0x2000
                && s[0] != 0x2002
                && !(s[0] == 0x2001 && (s[1] < 0x200 || s[1] == 0xdb8))
                && !(s[0] == 0x3fff && s[1] < 0x1000)
        }
    }
}
fn resource_url(value: &str) -> Result<Url> {
    let canonical = html::web_url(value)?;
    let url = Url::parse(&canonical).map_err(|e| e.to_string())?;
    if !matches!(url.port_or_known_default(), Some(80 | 443)) {
        return Err("Externe Ressource verwendet einen nicht unterstützten Port.".into());
    }
    if let Some(host) = url.host_str() {
        if let Ok(ip) = host.trim_matches(['[', ']']).parse::<IpAddr>() {
            if !public_address(ip) {
                return Err("Lokale Ressourcen werden nicht geladen.".into());
            }
        }
    }
    Ok(url)
}
fn pinned_client(url: &Url, remaining: Duration) -> Result<Client> {
    let addresses: Vec<SocketAddr> = url
        .socket_addrs(|| None)
        .map_err(|_| "Bildserver konnte nicht aufgelöst werden.")?;
    if addresses.is_empty()
        || addresses
            .iter()
            .any(|address| !public_address(address.ip()))
    {
        return Err("Lokale Ressourcen werden nicht geladen.".into());
    }
    Client::builder()
        .redirect(Policy::none())
        .no_proxy()
        .connect_timeout(Duration::from_secs(5).min(remaining))
        .timeout(Duration::from_secs(10).min(remaining))
        // Pin the checked addresses, preventing a second DNS lookup/rebinding.
        .resolve_to_addrs(url.host_str().ok_or("Ungültige Bildadresse.")?, &addresses)
        .build()
        .map_err(|e| e.to_string())
}

fn image_type(bytes: &[u8]) -> Result<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Ok("image/png")
    } else if bytes.starts_with(b"\xff\xd8\xff") {
        Ok("image/jpeg")
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Ok("image/gif")
    } else if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") {
        Ok("image/webp")
    } else {
        Err("Die Ressource ist kein unterstütztes Bild.".into())
    }
}
fn fetch_image(source: &str, budget: usize, started: Instant) -> Result<(String, usize)> {
    fetch_image_with(source, budget, started, pinned_client)
}

fn fetch_image_with(
    source: &str,
    budget: usize,
    started: Instant,
    client_for: impl Fn(&Url, Duration) -> Result<Client>,
) -> Result<(String, usize)> {
    let mut url = resource_url(source)?;
    for _ in 0..=4 {
        let remaining = TIME_BUDGET
            .checked_sub(started.elapsed())
            .filter(|left| !left.is_zero())
            .ok_or("Zeitlimit beim Laden der Bilder erreicht.")?;
        let client = client_for(&url, remaining)?;
        let response = client
            .get(url.clone())
            .header("Accept", "image/png,image/jpeg,image/gif,image/webp")
            .send()
            .map_err(|_| "Externes Bild konnte nicht geladen werden.")?;
        if response.status().is_redirection() {
            let location = response
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|value| value.to_str().ok())
                .ok_or("Ungültige Bildweiterleitung.")?;
            let next = url
                .join(location)
                .map_err(|_| "Ungültige Bildweiterleitung.")?;
            if url.scheme() == "https" && next.scheme() != "https" {
                return Err("Unsichere Bildweiterleitung wurde abgelehnt.".into());
            }
            url = resource_url(next.as_str())?;
            continue;
        }
        let response = response
            .error_for_status()
            .map_err(|_| "Bildserver meldet einen Fehler.")?;
        let limit = MAX_IMAGE_BYTES.min(budget);
        if response
            .content_length()
            .is_some_and(|size| size > limit as u64)
        {
            return Err("Externes Bild ist zu groß.".into());
        }
        let mut bytes = Vec::new();
        response
            .take(limit as u64 + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| "Externes Bild konnte nicht gelesen werden.")?;
        if bytes.len() > limit {
            return Err("Externes Bild ist zu groß.".into());
        }
        let mime = image_type(&bytes)?;
        return Ok((
            format!("data:{mime};base64,{}", STANDARD.encode(&bytes)),
            bytes.len(),
        ));
    }
    Err("Zu viele Bildweiterleitungen.".into())
}

pub fn load(sources: &[String], indices: &[usize]) -> Result<Loaded> {
    if sources.len() > html::MAX_IMAGES
        || indices.len() > html::MAX_IMAGES
        || indices.iter().any(|index| *index >= sources.len())
    {
        return Err("Ungültige Bildauswahl.".into());
    }
    let started = Instant::now();
    let mut images = Vec::new();
    let mut used = 0;
    let mut failed = 0;
    let mut unique = indices.to_vec();
    unique.sort_unstable();
    unique.dedup();
    for index in unique {
        if used >= MAX_TOTAL_BYTES || started.elapsed() >= TIME_BUDGET {
            failed += 1;
            continue;
        }
        match fetch_image(&sources[index], MAX_TOTAL_BYTES - used, started) {
            Ok((data_url, bytes)) => {
                used += bytes;
                images.push(Image { index, data_url });
            }
            Err(_) => failed += 1,
        }
    }
    Ok(Loaded { images, failed })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn response_fixture(response: Vec<u8>) -> (SocketAddr, std::thread::JoinHandle<()>) {
        use std::io::{BufRead, BufReader, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            let mut reader = BufReader::new(stream);
            let mut headers = String::new();
            loop {
                let mut line = String::new();
                reader.read_line(&mut line).unwrap();
                if line == "\r\n" {
                    break;
                }
                assert!(!line.is_empty());
                headers.push_str(&line.to_lowercase());
            }
            assert!(!headers.contains("cookie:"));
            assert!(!headers.contains("referer:"));
            assert!(!headers.contains("authorization:"));
            reader.get_mut().write_all(&response).unwrap();
        });
        (address, server)
    }

    #[test]
    fn downloads_bounded_raster_data_without_cookies_and_rejects_active_content() {
        for (data, accepted) in [
            (b"\x89PNG\r\n\x1a\n".as_slice(), true),
            (b"<svg onload='alert(1)'/>", false),
        ] {
            let mut response = format!("HTTP/1.1 200 OK\r\nContent-Type: image/png\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", data.len()).into_bytes();
            response.extend_from_slice(data);
            let (address, server) = response_fixture(response);
            let result = fetch_image_with(
                "http://images.example.org/logo",
                100,
                Instant::now(),
                |_, _| {
                    Client::builder()
                        .no_proxy()
                        .redirect(Policy::none())
                        .resolve("images.example.org", address)
                        .timeout(Duration::from_secs(3))
                        .build()
                        .map_err(|e| e.to_string())
                },
            );
            assert_eq!(result.is_ok(), accepted);
            if let Ok((image, size)) = result {
                assert!(image.starts_with("data:image/png;base64,"));
                assert_eq!(size, data.len());
            }
            server.join().unwrap();
        }
    }

    #[test]
    fn refuses_oversized_responses_and_private_redirects_before_loading_them() {
        for response in [
            "HTTP/1.1 200 OK\r\nContent-Length: 99999999\r\nConnection: close\r\n\r\n",
            "HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1/secret\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
        ] {
            let (address, server) = response_fixture(response.as_bytes().to_vec());
            let result = fetch_image_with("http://images.example.org/logo", 100, Instant::now(), |_, _| {
                Client::builder().no_proxy().redirect(Policy::none()).resolve("images.example.org", address)
                    .timeout(Duration::from_secs(3)).build().map_err(|e| e.to_string())
            });
            assert!(result.is_err());
            server.join().unwrap();
        }
    }
    #[test]
    fn rejects_local_private_reserved_and_obfuscated_destinations() {
        for ip in [
            "0.0.0.0",
            "127.0.0.1",
            "10.2.3.4",
            "172.16.0.1",
            "192.168.90.71",
            "100.64.0.1",
            "169.254.169.254",
            "198.18.0.1",
            "203.0.113.1",
            "224.0.0.1",
            "::1",
            "::ffff:127.0.0.1",
            "fc00::1",
            "fe80::1",
            "2002:7f00:1::",
            "2001:db8::1",
        ] {
            assert!(!public_address(ip.parse().unwrap()), "{ip}");
        }
        for url in [
            "http://2130706433/",
            "http://0x7f000001/",
            "http://[::1]/",
            "http://example.org:8080/",
            "file:///tmp/a",
            "https://user:pass@example.org/",
            "data:image/svg+xml,x",
        ] {
            assert!(resource_url(url).is_err(), "{url}");
        }
        assert!(public_address("8.8.8.8".parse().unwrap()));
        assert!(public_address("2606:4700:4700::1111".parse().unwrap()));
    }
    #[test]
    fn only_raster_data_is_returned_and_indices_are_message_scoped() {
        for bytes in [
            b"<svg onload='x'>".as_slice(),
            b"<html>fake image</html>",
            b"<script>alert(1)</script>",
        ] {
            assert!(image_type(bytes).is_err());
        }
        assert_eq!(image_type(b"\x89PNG\r\n\x1a\n").unwrap(), "image/png");
        assert_eq!(image_type(b"GIF89a").unwrap(), "image/gif");
        assert!(load(&[], &[0]).is_err());
        assert_eq!(load(&[], &[]).unwrap().failed, 0);
    }
}
