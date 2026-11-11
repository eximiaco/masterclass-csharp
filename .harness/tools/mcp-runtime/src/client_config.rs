//! Wiring do cliente Cursor após `up` (SPEC — host client config).
//! Merge em `~/.cursor/mcp.json` (e opcionalmente `MCP_RUNTIME_CLIENT_ROOT`)
//! sem gravar PAT/headers. Opt-out: `MCP_RUNTIME_SKIP_CLIENT_CONFIG=1`.
//! Entrada gerenciada: `awu` → xharness em 8379.

use std::fs;
use std::path::{Path, PathBuf};

use serde_json::{json, Map, Value};

use crate::lifecycle::XHARNESS_PORT;
use crate::paths::{home_dir, Env};
use crate::AppError;

const SKIP_ENV: &str = "MCP_RUNTIME_SKIP_CLIENT_CONFIG";
const CLIENT_ROOT_ENV: &str = "MCP_RUNTIME_CLIENT_ROOT";

/// Nome canônico do MCP normativo no Cursor.
const KEY_AWU: &str = "awu";

/// Chaves que versões anteriores do wiring gravavam — removidas no merge.
const LEGACY_KEYS: &[&str] = &["x-harness", "ai-playbook-github", "ai-playbook-ado"];

/// Sincroniza o Cursor com o endpoint canônico do xharness (`awu`).
/// Falhas de I/O sobem como `AppError`; o caller do `up` trata como aviso.
pub fn sync_cursor_mcp(env: &Env, include_xharness: bool) -> Result<Vec<PathBuf>, AppError> {
    if skip_client_config(env) {
        eprintln!("[mcp-runtime] client config: omitido ({SKIP_ENV})");
        return Ok(Vec::new());
    }

    let mut written = Vec::new();
    let user_path = cursor_user_mcp_path()?;
    write_merged_mcp_json(&user_path, include_xharness)?;
    eprintln!("[mcp-runtime] client config: {}", user_path.display());
    written.push(user_path);

    if let Some(root) = client_root(env) {
        let project_path = root.join(".cursor").join("mcp.json");
        write_merged_mcp_json(&project_path, include_xharness)?;
        eprintln!("[mcp-runtime] client config: {}", project_path.display());
        written.push(project_path);
    }

    Ok(written)
}

fn skip_client_config(env: &Env) -> bool {
    env.get(SKIP_ENV)
        .map(truthy)
        .or_else(|| std::env::var(SKIP_ENV).ok().map(|v| truthy(&v)))
        .unwrap_or(false)
}

fn truthy(value: &str) -> bool {
    matches!(
        value.trim().to_ascii_lowercase().as_str(),
        "1" | "true" | "yes" | "on"
    )
}

fn client_root(env: &Env) -> Option<PathBuf> {
    let raw = env
        .get(CLIENT_ROOT_ENV)
        .map(str::to_string)
        .or_else(|| std::env::var(CLIENT_ROOT_ENV).ok())
        .unwrap_or_default();
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(PathBuf::from(trimmed))
}

fn cursor_user_mcp_path() -> Result<PathBuf, AppError> {
    let home = home_dir().ok_or_else(|| {
        AppError::Other("não foi possível resolver o diretório home para ~/.cursor/mcp.json".into())
    })?;
    Ok(home.join(".cursor").join("mcp.json"))
}

fn write_merged_mcp_json(path: &Path, include_xharness: bool) -> Result<(), AppError> {
    let existing = if path.exists() {
        fs::read_to_string(path).map_err(|e| AppError::Other(e.to_string()))?
    } else {
        String::new()
    };
    let merged = merge_mcp_json(&existing, include_xharness)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| AppError::Other(e.to_string()))?;
    }
    fs::write(path, merged).map_err(|e| AppError::Other(e.to_string()))?;
    Ok(())
}

/// Merge puro (testável): preserva servers não gerenciados; upsert de `awu`
/// quando o xharness está ativo; remove chaves legadas do wiring antigo.
fn merge_mcp_json(existing: &str, include_xharness: bool) -> Result<String, AppError> {
    let mut root: Value = if existing.trim().is_empty() {
        json!({ "mcpServers": {} })
    } else {
        serde_json::from_str(existing)
            .map_err(|e| AppError::Other(format!("mcp.json inválido: {e}")))?
    };

    if !root.is_object() {
        return Err(AppError::Other(
            "mcp.json deve ser um objeto JSON na raiz".into(),
        ));
    }

    let servers = root
        .as_object_mut()
        .expect("objeto verificado")
        .entry("mcpServers")
        .or_insert_with(|| json!({}));

    if !servers.is_object() {
        return Err(AppError::Other(
            "mcp.json: mcpServers deve ser um objeto".into(),
        ));
    }

    let map = servers.as_object_mut().expect("objeto verificado");
    for key in LEGACY_KEYS {
        map.remove(*key);
    }

    if include_xharness {
        upsert_http(
            map,
            KEY_AWU,
            &format!("http://127.0.0.1:{XHARNESS_PORT}/mcp"),
        );
    }

    serde_json::to_string_pretty(&root)
        .map(|s| format!("{s}\n"))
        .map_err(|e| AppError::Other(e.to_string()))
}

fn upsert_http(map: &mut Map<String, Value>, key: &str, url: &str) {
    map.insert(
        key.to_string(),
        json!({
            "type": "http",
            "url": url
        }),
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    #[test]
    fn merge_preserva_servers_estranhos_e_grava_awu() {
        let existing = r#"{
  "mcpServers": {
    "devops-eximia": { "command": "node", "args": ["x"] },
    "x-harness": { "type": "http", "url": "http://127.0.0.1:3100/mcp" },
    "ai-playbook-github": { "type": "http", "url": "http://127.0.0.1:8377/" }
  }
}"#;
        let out = merge_mcp_json(existing, true).expect("merge");
        let v: Value = serde_json::from_str(&out).unwrap();
        let servers = v["mcpServers"].as_object().unwrap();
        assert_eq!(servers["devops-eximia"]["command"], "node");
        assert!(servers.get("x-harness").is_none());
        assert!(servers.get("ai-playbook-github").is_none());
        assert_eq!(
            servers[KEY_AWU]["url"],
            format!("http://127.0.0.1:{XHARNESS_PORT}/mcp")
        );
        assert_eq!(servers[KEY_AWU]["type"], "http");
    }

    #[test]
    fn sem_xharness_nao_insere_awu_e_limpa_legado() {
        let existing = r#"{
  "mcpServers": {
    "other": { "type": "http", "url": "http://x" },
    "x-harness": { "type": "http", "url": "http://127.0.0.1:8379/mcp" }
  }
}"#;
        let out = merge_mcp_json(existing, false).expect("merge");
        let v: Value = serde_json::from_str(&out).unwrap();
        assert!(v["mcpServers"].get(KEY_AWU).is_none());
        assert!(v["mcpServers"].get("x-harness").is_none());
        assert_eq!(v["mcpServers"]["other"]["url"], "http://x");
    }

    #[test]
    fn skip_env_truthy() {
        let mut map = BTreeMap::new();
        map.insert(SKIP_ENV.into(), "1".into());
        let env = Env(map);
        assert!(skip_client_config(&env));
    }

    #[test]
    fn arquivo_vazio_cria_awu() {
        let out = merge_mcp_json("", true).expect("merge");
        let v: Value = serde_json::from_str(&out).unwrap();
        assert!(v["mcpServers"].get(KEY_AWU).is_some());
        assert!(v["mcpServers"].get("ai-playbook-ado").is_none());
    }
}
