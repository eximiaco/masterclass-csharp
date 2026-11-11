// Prontidão por protocolo (SPEC §9): faz o `initialize` do MCP no endpoint do
// serviço e classifica o resultado. O binário continua não sendo um cliente
// MCP (SPEC §1): a mensagem é mínima — só o suficiente para provar que o
// server atende ao handshake — e nenhuma credencial é impressa (SPEC §12).
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::time::Duration;

/// Versão de protocolo usada no handshake (a mesma do cliente do harness de
/// testes, aceita pelos servers oficiais pinados).
pub const PROTOCOL_VERSION: &str = "2025-03-26";

#[derive(Debug, Clone)]
pub struct Initialize {
    pub ok: bool,
    pub http_status: Option<u16>,
    pub server_info: Option<String>,
    pub detail: String,
}

impl Initialize {
    fn failure(http_status: Option<u16>, detail: impl Into<String>) -> Self {
        Initialize {
            ok: false,
            http_status,
            server_info: None,
            detail: detail.into(),
        }
    }

    /// Linha humana do resultado, sem valor de segredo.
    pub fn summary(&self) -> String {
        match (&self.server_info, self.http_status) {
            (Some(info), Some(status)) => {
                format!("initialize OK — {info} (HTTP {status})")
            }
            (Some(info), None) => format!("initialize OK — {info}"),
            (None, Some(status)) => format!("handshake {} (HTTP {status})", self.detail),
            (None, None) => format!("handshake {}", self.detail),
        }
    }
}

/// Corpo do `initialize` enviado ao endpoint (JSON-RPC 2.0).
pub fn request_body() -> String {
    format!(
        "{{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":\
         {{\"protocolVersion\":\"{PROTOCOL_VERSION}\",\"capabilities\":{{}},\
         \"clientInfo\":{{\"name\":\"mcp-runtime\",\"version\":\"{}\"}}}}}}",
        env!("CARGO_PKG_VERSION")
    )
}

/// Handshake `initialize` no endpoint HTTP do serviço. `bearer`, quando
/// presente, vai no header `Authorization` (server GitHub, SPEC §4).
pub fn initialize(url: &str, bearer: Option<&str>, timeout: Duration) -> Initialize {
    match post(url, bearer, timeout) {
        Ok(response) => {
            let status = response.status;
            if !(200..300).contains(&status) {
                let detail = match status {
                    401 | 403 => "credencial recusada".to_string(),
                    other => format!("HTTP {other} sem initialize"),
                };
                return Initialize::failure(Some(status), detail);
            }
            match server_info(&response.body) {
                Some(info) => Initialize {
                    ok: true,
                    http_status: Some(status),
                    server_info: Some(info),
                    detail: "initialize OK".to_string(),
                },
                None => Initialize::failure(Some(status), "HTTP 200 sem serverInfo na resposta"),
            }
        }
        Err(error) => Initialize::failure(None, error),
    }
}

/// GET simples (prontidão HTTP bruta). Usado como pré-porta do `xharness`
/// enquanto o QMD indexa/embeda — ainda assim o SPEC §9 exige `initialize`
/// depois; health sozinho não declara a stack pronta.
pub fn health_ok(url: &str, timeout: Duration) -> bool {
    match get(url, timeout) {
        Ok(response) => (200..300).contains(&response.status),
        Err(_) => false,
    }
}

struct RawResponse {
    status: u16,
    body: String,
}

/// POST HTTP/1.1 com `Content-Type: application/json` e
/// `Accept: application/json, text/event-stream` (transporte streamable HTTP).
/// Sem TLS: os endpoints são loopback (SPEC §1).
fn post(url: &str, bearer: Option<&str>, timeout: Duration) -> Result<RawResponse, String> {
    let (authority, path, mut stream) = connect(url, timeout)?;

    let body = request_body();
    let mut request = format!(
        "POST {path} HTTP/1.1\r\nHost: {authority}\r\nConnection: close\r\n\
         User-Agent: mcp-runtime\r\nContent-Type: application/json\r\n\
         Accept: application/json, text/event-stream\r\nContent-Length: {}\r\n",
        body.len()
    );
    if let Some(token) = bearer {
        request.push_str(&format!("Authorization: Bearer {token}\r\n"));
    }
    request.push_str("\r\n");
    request.push_str(&body);

    stream.write_all(request.as_bytes()).map_err(classify_io)?;
    read_http_response(&mut stream)
}

fn get(url: &str, timeout: Duration) -> Result<RawResponse, String> {
    let (authority, path, mut stream) = connect(url, timeout)?;
    let request = format!(
        "GET {path} HTTP/1.1\r\nHost: {authority}\r\nConnection: close\r\n\
         User-Agent: mcp-runtime\r\nAccept: */*\r\n\r\n"
    );
    stream.write_all(request.as_bytes()).map_err(classify_io)?;
    read_http_response(&mut stream)
}

fn connect(url: &str, timeout: Duration) -> Result<(String, String, TcpStream), String> {
    let rest = url
        .strip_prefix("http://")
        .ok_or_else(|| format!("endpoint inválido: {url}"))?;
    let (authority, path) = match rest.find('/') {
        Some(index) => (&rest[..index], &rest[index..]),
        None => (rest, "/"),
    };
    let socket: SocketAddr = if authority.contains(':') {
        authority
            .parse()
            .map_err(|_| format!("endpoint inválido: {url}"))?
    } else {
        format!("{authority}:80")
            .parse()
            .map_err(|_| format!("endpoint inválido: {url}"))?
    };

    let stream = TcpStream::connect_timeout(&socket, timeout).map_err(classify_io)?;
    stream
        .set_read_timeout(Some(timeout))
        .map_err(classify_io)?;
    stream
        .set_write_timeout(Some(timeout))
        .map_err(classify_io)?;
    Ok((authority.to_string(), path.to_string(), stream))
}

fn read_http_response(stream: &mut TcpStream) -> Result<RawResponse, String> {
    let mut raw: Vec<u8> = Vec::new();
    let mut chunk = [0u8; 4096];
    loop {
        match stream.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => raw.extend_from_slice(&chunk[..n]),
            Err(error) => {
                if raw.is_empty() {
                    return Err(classify_io(error));
                }
                break;
            }
        }
    }
    let text = String::from_utf8_lossy(&raw).to_string();
    let (head, body) = match text.find("\r\n\r\n") {
        Some(index) => (&text[..index], text[index + 4..].to_string()),
        None => (text.as_str(), String::new()),
    };
    let status = head
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|code| code.parse::<u16>().ok())
        .ok_or_else(|| "resposta sem status HTTP".to_string())?;
    let body = if head
        .to_ascii_lowercase()
        .contains("transfer-encoding: chunked")
    {
        dechunk(&body)
    } else {
        body
    };
    Ok(RawResponse { status, body })
}

/// Remove o enquadramento `Transfer-Encoding: chunked`: o parser de
/// `serverInfo` trabalha sobre texto SSE/JSON puro.
fn dechunk(body: &str) -> String {
    let mut result = String::new();
    let mut rest = body;
    while let Some(index) = rest.find('\n') {
        let (size_line, after) = rest.split_at(index);
        let after = &after[1..];
        let size_text = size_line.trim().split(';').next().unwrap_or("").trim();
        let Ok(size) = usize::from_str_radix(size_text, 16) else {
            break;
        };
        if size == 0 {
            break;
        }
        if after.len() < size {
            result.push_str(after);
            break;
        }
        let (chunk, remainder) = after.split_at(size);
        result.push_str(chunk);
        // descarta o CRLF que fecha o chunk
        let without_cr = remainder.strip_prefix('\r').unwrap_or(remainder);
        rest = without_cr.strip_prefix('\n').unwrap_or(without_cr);
    }
    result
}

fn classify_io(error: std::io::Error) -> String {
    match error.kind() {
        std::io::ErrorKind::ConnectionRefused => "sem resposta (conexão recusada)".to_string(),
        std::io::ErrorKind::TimedOut | std::io::ErrorKind::WouldBlock => {
            "sem resposta (timeout)".to_string()
        }
        _ => {
            let text = error.to_string().to_ascii_lowercase();
            if text.contains("refused") {
                "sem resposta (conexão recusada)".to_string()
            } else if text.contains("timed out") || text.contains("timeout") {
                "sem resposta (timeout)".to_string()
            } else {
                format!("sem resposta ({error})")
            }
        }
    }
}

/// Extrai `serverInfo` de uma resposta JSON ou SSE (`data: {...}`).
pub fn server_info(body: &str) -> Option<String> {
    for candidate in json_candidates(body) {
        if let Some(info) = server_info_in(&candidate) {
            return Some(info);
        }
    }
    None
}

fn json_candidates(body: &str) -> Vec<String> {
    let mut candidates: Vec<String> = Vec::new();
    for line in body.lines() {
        let line = line.trim();
        if let Some(data) = line.strip_prefix("data:") {
            let data = data.trim();
            if data.contains("serverInfo") {
                candidates.push(data.to_string());
            }
        } else if line.contains("serverInfo") {
            candidates.push(line.to_string());
        }
    }
    if candidates.is_empty() && body.contains("serverInfo") {
        candidates.push(body.to_string());
    }
    candidates
}

fn server_info_in(json: &str) -> Option<String> {
    let start = json.find("\"serverInfo\"")?;
    let window = &json[start..json.len().min(start + 512)];
    let name = json_string(window, "\"name\"")?;
    match json_string(window, "\"version\"") {
        // o server pode já reportar a versão com "v" (github-mcp-server v1.12.2)
        Some(version) if version.starts_with(['v', 'V']) => Some(format!("{name} {version}")),
        Some(version) => Some(format!("{name} v{version}")),
        None => Some(name),
    }
}

fn json_string(window: &str, key: &str) -> Option<String> {
    let index = window.find(key)?;
    let after = &window[index + key.len()..];
    let colon = after.find(':')?;
    let rest = after[colon + 1..].trim_start();
    let mut chars = rest.chars();
    if chars.next()? != '"' {
        return None;
    }
    let mut value = String::new();
    let mut escaped = false;
    for character in chars {
        if escaped {
            value.push(character);
            escaped = false;
            continue;
        }
        match character {
            '\\' => escaped = true,
            '"' => return Some(value),
            other => value.push(other),
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;
    use std::thread;

    fn serve_once(response: &'static str) -> SocketAddr {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        thread::spawn(move || {
            if let Ok((mut stream, _)) = listener.accept() {
                let mut request = [0u8; 2048];
                let _ = stream.read(&mut request);
                let _ = stream.write_all(response.as_bytes());
            }
        });
        addr
    }

    const SSE_OK: &str = "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\r\n\
        event: message\ndata: {\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"protocolVersion\":\"2025-03-26\",\"serverInfo\":{\"name\":\"Azure DevOps MCP Server\",\"version\":\"2.10.0\"},\"capabilities\":{}}}\n\n";
    const JSON_OK: &str = "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n\
        {\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"serverInfo\":{\"name\":\"github-mcp-server\",\"version\":\"1.12.2\"}}}";
    const UNAUTHORIZED: &str =
        "HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";

    #[test]
    fn handshake_ok_em_sse_com_server_info() {
        let addr = serve_once(SSE_OK);
        let result = initialize(&format!("http://{addr}/mcp"), None, Duration::from_secs(5));
        assert!(result.ok, "{result:?}");
        assert_eq!(
            result.server_info.as_deref(),
            Some("Azure DevOps MCP Server v2.10.0")
        );
        assert!(result.summary().contains("initialize OK"));
        assert!(result.summary().contains("HTTP 200"));
    }

    #[test]
    fn handshake_ok_em_json_com_server_info() {
        let addr = serve_once(JSON_OK);
        let result = initialize(
            &format!("http://{addr}/"),
            Some("ghp_dummy"),
            Duration::from_secs(5),
        );
        assert!(result.ok, "{result:?}");
        assert_eq!(
            result.server_info.as_deref(),
            Some("github-mcp-server v1.12.2")
        );
    }

    #[test]
    fn credencial_recusada_e_falha_classificada() {
        let addr = serve_once(UNAUTHORIZED);
        let result = initialize(
            &format!("http://{addr}/"),
            Some("ghp_dummy"),
            Duration::from_secs(5),
        );
        assert!(!result.ok);
        assert_eq!(result.http_status, Some(401));
        assert!(
            result.detail.contains("credencial recusada"),
            "{}",
            result.detail
        );
        assert!(result.summary().contains("401"), "{}", result.summary());
    }

    #[test]
    fn endpoint_fechado_e_falha_com_conexao_recusada() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        drop(listener);
        let result = initialize(&format!("http://{addr}/mcp"), None, Duration::from_secs(2));
        assert!(!result.ok);
        assert_eq!(result.http_status, None);
        // No Windows o connect a porta recém-fechada pode virar timeout em
        // vez de connection refused; os dois classificam endpoint indisponível.
        assert!(
            result.detail.contains("conexão recusada") || result.detail.contains("timeout"),
            "{}",
            result.detail
        );
    }

    #[test]
    fn versao_que_ja_traz_v_nao_ganha_segundo_v() {
        let com_v = "{\"result\":{\"serverInfo\":{\"name\":\"github-mcp-server\",\"version\":\"v1.12.2\"}}}";
        assert_eq!(
            server_info(com_v).as_deref(),
            Some("github-mcp-server v1.12.2")
        );
        let sem_v = "{\"result\":{\"serverInfo\":{\"name\":\"Azure DevOps MCP Server\",\"version\":\"2.10.0\"}}}";
        assert_eq!(
            server_info(sem_v).as_deref(),
            Some("Azure DevOps MCP Server v2.10.0")
        );
    }

    #[test]
    fn corpo_sem_server_info_nao_e_pronto() {
        let addr = serve_once(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{}}",
        );
        let result = initialize(&format!("http://{addr}/mcp"), None, Duration::from_secs(5));
        assert!(!result.ok);
        assert!(
            result.detail.contains("sem serverInfo"),
            "{}",
            result.detail
        );
    }

    #[test]
    fn corpo_do_initialize_e_json_rpc_2() {
        let body = request_body();
        assert!(body.contains("\"method\":\"initialize\""));
        assert!(body.contains(PROTOCOL_VERSION));
        assert!(body.contains("\"clientInfo\""));
    }
}
