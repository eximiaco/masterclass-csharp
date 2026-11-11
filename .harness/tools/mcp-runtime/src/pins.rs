// pins.env — fontes oficiais pinadas (mecanismo fixo). Proibido `latest`;
// alterar qualquer valor exige bump de versão do artefato.
#[derive(Debug, Clone, Default)]
pub struct Pins {
    pub entries: Vec<(String, String)>,
}

impl Pins {
    pub fn get(&self, key: &str) -> Option<&str> {
        self.entries
            .iter()
            .find(|(name, _)| name == key)
            .map(|(_, value)| value.as_str())
    }

    /// Pin obrigatório com validação de valor (proibido `latest`).
    pub fn require(&self, key: &str, source: &str) -> Result<String, String> {
        match self.get(key) {
            Some(value) => {
                let trimmed = value.trim();
                if trimmed.is_empty() {
                    return Err(format!("{source}: pin ausente: {key}"));
                }
                if trimmed.eq_ignore_ascii_case("latest") {
                    return Err(format!("{source}: pin inválido (proibido latest): {key}"));
                }
                Ok(trimmed.to_string())
            }
            None => Err(format!("{source}: pin ausente: {key}")),
        }
    }

    pub fn required(&self) -> Vec<(&'static str, Option<&str>)> {
        [
            "GITHUB_MCP_IMAGE",
            "ADO_MCP_NPM_VERSION",
            "ADO_HTTP_ADAPTER",
            "AZURE_CLI_VERSION",
            "XHARNESS_MCP_IMAGE",
        ]
        .into_iter()
        .map(|key| (key, self.get(key)))
        .collect()
    }
}

pub fn load_pins(text: &str, source: &str) -> Result<Pins, String> {
    let mut pins = Pins::default();
    for raw_line in text.split(['\r', '\n']) {
        let line = raw_line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some(eq) = line.find('=') else {
            return Err(format!("{source}: linha inválida: {line}"));
        };
        if eq == 0 {
            return Err(format!("{source}: linha inválida: {line}"));
        }
        pins.entries
            .push((line[..eq].to_string(), line[eq + 1..].to_string()));
    }
    for (key, value) in pins.required() {
        if value.is_none() {
            return Err(format!("{source}: pin ausente: {key}"));
        }
    }
    Ok(pins)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn pins_file() -> PathBuf {
        // paridade com o script Node: pins lidos de containers/pins.env do artefato
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("containers")
            .join("pins.env")
    }

    #[test]
    fn le_pins_env_com_fontes_obrigatorias() {
        let text = std::fs::read_to_string(pins_file()).unwrap();
        let pins = load_pins(&text, "containers/pins.env").unwrap();
        for key in [
            "GITHUB_MCP_IMAGE",
            "ADO_MCP_NPM_VERSION",
            "ADO_HTTP_ADAPTER",
            "AZURE_CLI_VERSION",
            "XHARNESS_MCP_IMAGE",
        ] {
            assert!(pins.get(key).is_some(), "pin ausente: {key}");
        }
        assert_eq!(pins.get("ADO_MCP_NPM_VERSION"), Some("2.10.0"));
        let xharness = pins.get("XHARNESS_MCP_IMAGE").unwrap();
        assert!(
            xharness.starts_with("ghcr.io/") && !xharness.contains("latest"),
            "XHARNESS_MCP_IMAGE inválido: {xharness}"
        );
    }

    #[test]
    fn pins_env_proibido_latest_e_sha256_de_64_hex() {
        let text = std::fs::read_to_string(pins_file()).unwrap();
        let pins = load_pins(&text, "containers/pins.env").unwrap();
        for (key, value) in &pins.entries {
            let words: Vec<&str> = value.split_whitespace().collect();
            assert!(!words.contains(&"latest"), "latest proibido: {key}={value}");
        }
        let image = pins.get("GITHUB_MCP_IMAGE").unwrap();
        let digest = image
            .strip_prefix("ghcr.io/github/github-mcp-server@sha256:")
            .unwrap_or("");
        assert_eq!(digest.len(), 64, "digest deve ter 64 hex: {image}");
        assert!(
            digest.bytes().all(|byte| byte.is_ascii_hexdigit()),
            "{image}"
        );
        assert!(pins.get("ADO_MCP_NPM_VERSION").unwrap().split('.').count() == 3);
        for key in [
            "SOPS_LINUX_AMD64_SHA256",
            "SOPS_LINUX_ARM64_SHA256",
            "SOPS_DARWIN_AMD64_SHA256",
            "SOPS_DARWIN_ARM64_SHA256",
            "SOPS_WINDOWS_AMD64_SHA256",
            "AGE_LINUX_AMD64_SHA256",
            "AGE_LINUX_ARM64_SHA256",
            "AGE_DARWIN_AMD64_SHA256",
            "AGE_DARWIN_ARM64_SHA256",
            "AGE_WINDOWS_AMD64_SHA256",
        ] {
            let value = pins.get(key).unwrap_or("");
            assert_eq!(value.len(), 64, "{key} deve ter 64 hex");
            assert!(value.bytes().all(|byte| byte.is_ascii_hexdigit()), "{key}");
        }
        // pins de instalação: versões explícitas, sem "v" e sem "latest"
        assert_eq!(pins.get("SOPS_VERSION"), Some("3.13.3"));
        assert_eq!(pins.get("AGE_VERSION"), Some("1.3.2"));
        assert!(pins.require("SOPS_VERSION", "p.env").is_ok());
        assert!(pins.require("AGE_VERSION", "p.env").is_ok());
    }

    #[test]
    fn rejeita_linha_invalida_e_pin_ausente() {
        assert_eq!(
            load_pins("KEY=valor\nlinha sem igual\n", "p.env").unwrap_err(),
            "p.env: linha inválida: linha sem igual"
        );
        let missing = load_pins("GITHUB_MCP_IMAGE=x\n", "p.env").unwrap_err();
        assert_eq!(missing, "p.env: pin ausente: ADO_MCP_NPM_VERSION");
    }

    #[test]
    fn preserva_a_ordem_das_linhas_do_arquivo() {
        let pins = load_pins(
            "GITHUB_MCP_IMAGE=a\nEXTRA=x\nADO_MCP_NPM_VERSION=1.0.0\n\
             ADO_HTTP_ADAPTER=b\nAZURE_CLI_VERSION=c\n\
             XHARNESS_MCP_IMAGE=ghcr.io/eximiaco/x-harness-mcp:v1.0.0\n",
            "p.env",
        )
        .unwrap();
        let names: Vec<&str> = pins.entries.iter().map(|(k, _)| k.as_str()).collect();
        assert_eq!(
            names,
            vec![
                "GITHUB_MCP_IMAGE",
                "EXTRA",
                "ADO_MCP_NPM_VERSION",
                "ADO_HTTP_ADAPTER",
                "AZURE_CLI_VERSION",
                "XHARNESS_MCP_IMAGE"
            ]
        );
    }
}
