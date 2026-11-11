// Variáveis do contexto (SPEC §5, §9, §12): validação antes do start, modo de
// autenticação resultante e valores usados para redigir o dump de logs.
// Nenhuma função aqui imprime valores: só nomes de variáveis e classificação.
use std::collections::BTreeMap;
use std::path::Path;
use std::process::Command;

/// Variável obrigatória por serviço (SPEC §5): sem ela o serviço não é
/// consumível, então o `up` falha antes de criar qualquer container.
/// O terceiro campo é o motivo mostrado ao usuário (nunca valores — §12).
pub const REQUIRED: &[(&str, &str, &str)] = &[
    (
        "ado",
        "ADO_ORG",
        "o server Azure DevOps não inicia sem a organização",
    ),
    (
        "github",
        "GITHUB_PERSONAL_ACCESS_TOKEN",
        "o server GitHub responde 401 em toda tool call",
    ),
];

/// Sufixos/tokens de chave tratados como credencial na redação (SPEC §12).
const CREDENTIAL_MARKERS: &[&str] = &["TOKEN", "SECRET", "PASSWORD", "_PAT", "_KEY"];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuthMode {
    /// `AZURE_DEVOPS_PAT` presente: o server ADO autentica por PAT.
    Pat,
    /// Ausente: sessão az dentro do container (SPEC §4).
    Azcli,
}

impl AuthMode {
    pub fn as_str(self) -> &'static str {
        match self {
            AuthMode::Pat => "pat",
            AuthMode::Azcli => "azcli",
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct ContextVars {
    entries: BTreeMap<String, String>,
}

impl ContextVars {
    /// Formato env (`KEY=VALUE`, chave e valor separados por `=`): o mesmo do
    /// sops `--input-type env --output-type env` usado para decriptar.
    pub fn parse(bytes: &[u8]) -> Self {
        let text = String::from_utf8_lossy(bytes);
        let mut entries = BTreeMap::new();
        for raw in text.lines() {
            let line = raw.trim();
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            let line = line.strip_prefix("export ").unwrap_or(line);
            let Some((key, value)) = line.split_once('=') else {
                continue;
            };
            let key = key.trim();
            if key.is_empty() {
                continue;
            }
            entries.insert(key.to_string(), unquote(value.trim()).to_string());
        }
        ContextVars { entries }
    }

    /// Valor útil: vazio (ou só espaços) conta como ausente (SPEC §5).
    pub fn get(&self, key: &str) -> Option<&str> {
        self.entries
            .get(key)
            .map(String::as_str)
            .filter(|value| !value.trim().is_empty())
    }

    pub fn is_set(&self, key: &str) -> bool {
        self.get(key).is_some()
    }

    /// Variáveis obrigatórias ausentes, na ordem de `REQUIRED`.
    pub fn missing(&self) -> Vec<(&'static str, &'static str, &'static str)> {
        REQUIRED
            .iter()
            .copied()
            .filter(|(_, key, _)| self.get(key).is_none())
            .collect()
    }

    pub fn auth_mode(&self) -> AuthMode {
        if self.is_set("AZURE_DEVOPS_PAT") {
            AuthMode::Pat
        } else {
            AuthMode::Azcli
        }
    }

    /// Formas derivadas que o stack monta a partir do contexto e que também
    /// não podem aparecer em log (SPEC §12): o serviço ado exporta
    /// `PERSONAL_ACCESS_TOKEN=base64("ado-mcp:<PAT>")`.
    pub fn derived_credential_values(&self) -> Vec<String> {
        let mut values = self.credential_values();
        if let Some(pat) = self.get("AZURE_DEVOPS_PAT") {
            values.push(base64(format!("ado-mcp:{pat}").as_bytes()));
        }
        values
    }

    /// Valores tratados como credencial, usados para redigir o dump de logs do
    /// `up` (SPEC §12). Nada aqui é impresso.
    pub fn credential_values(&self) -> Vec<String> {
        self.entries
            .iter()
            .filter(|(key, _)| {
                let upper = key.to_ascii_uppercase();
                CREDENTIAL_MARKERS
                    .iter()
                    .any(|marker| upper.contains(marker))
            })
            .map(|(_, value)| value.clone())
            .filter(|value| value.trim().len() >= 4)
            .collect()
    }
}

/// Base64 padrão (RFC 4648) sem padding omitido — usado só para reconhecer a
/// forma derivada do PAT no dump de logs.
fn base64(bytes: &[u8]) -> String {
    const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::new();
    for chunk in bytes.chunks(3) {
        let b = [
            chunk[0],
            *chunk.get(1).unwrap_or(&0),
            *chunk.get(2).unwrap_or(&0),
        ];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
        out.push(ALPHABET[((n >> 18) & 63) as usize] as char);
        out.push(ALPHABET[((n >> 12) & 63) as usize] as char);
        out.push(if chunk.len() > 1 {
            ALPHABET[((n >> 6) & 63) as usize] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            ALPHABET[(n & 63) as usize] as char
        } else {
            '='
        });
    }
    out
}

/// Substitui cada valor de credencial por `***` (SPEC §12).
pub fn redact(text: &str, values: &[String]) -> String {
    let mut result = text.to_string();
    for value in values {
        if value.trim().is_empty() {
            continue;
        }
        if result.contains(value.as_str()) {
            result = result.replace(value.as_str(), "***");
        }
    }
    result
}

fn unquote(value: &str) -> &str {
    for quote in ['"', '\''] {
        if value.len() >= 2 && value.starts_with(quote) && value.ends_with(quote) {
            return &value[1..value.len() - 1];
        }
    }
    value
}

/// Decripta o contexto com sops. A chave age entra por `SOPS_AGE_KEY_FILE` no
/// ambiente do processo (nunca em argv — SPEC §6).
pub fn decrypt(sops: &Path, sops_file: &Path, key: &Path) -> Result<Vec<u8>, String> {
    match Command::new(sops)
        .args(["-d", "--input-type", "env", "--output-type", "env"])
        .arg(sops_file)
        .env("SOPS_AGE_KEY_FILE", key)
        .output()
    {
        Ok(output) if output.status.success() && !output.stdout.is_empty() => Ok(output.stdout),
        Ok(output) => {
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            Err(format!("falha ao decriptar o contexto (sops):\n{stderr}"))
        }
        Err(error) => Err(format!("falha ao decriptar o contexto (sops): {error}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vars(text: &str) -> ContextVars {
        ContextVars::parse(text.as_bytes())
    }

    #[test]
    fn parse_le_chaves_valores_e_ignora_ruido() {
        let parsed = vars("# comentário\nGITHUB_PERSONAL_ACCESS_TOKEN=ghp_x\n export ADO_ORG=\"org-x\"\n\nADO_ORG=org-y\n");
        assert_eq!(parsed.get("GITHUB_PERSONAL_ACCESS_TOKEN"), Some("ghp_x"));
        assert_eq!(parsed.get("ADO_ORG"), Some("org-y"));
        assert_eq!(parsed.get("ausente"), None);
    }

    #[test]
    fn obrigatorias_ausentes_e_vazias_sao_reportadas_com_o_servico() {
        let parsed = vars("ADO_ORG=\nAZURE_DEVOPS_PAT=\n");
        let missing: Vec<(&str, &str)> = parsed
            .missing()
            .into_iter()
            .map(|(service, key, _)| (service, key))
            .collect();
        assert_eq!(
            missing,
            vec![
                ("ado", "ADO_ORG"),
                ("github", "GITHUB_PERSONAL_ACCESS_TOKEN")
            ]
        );
        assert!(parsed
            .missing()
            .iter()
            .all(|(_, _, reason)| !reason.is_empty()));
    }

    #[test]
    fn contexto_completo_nao_tem_pendencia() {
        let parsed = vars("ADO_ORG=org-x\nGITHUB_PERSONAL_ACCESS_TOKEN=ghp_x\n");
        assert!(parsed.missing().is_empty());
    }

    #[test]
    fn pat_seleciona_modo_pat_e_ausencia_seleciona_azcli() {
        assert_eq!(vars("AZURE_DEVOPS_PAT=x\n").auth_mode(), AuthMode::Pat);
        assert_eq!(vars("ADO_ORG=o\n").auth_mode(), AuthMode::Azcli);
        assert_eq!(vars("AZURE_DEVOPS_PAT=\n").auth_mode(), AuthMode::Azcli);
    }

    #[test]
    fn forma_derivada_do_pat_entra_na_redacao() {
        let parsed = vars("AZURE_DEVOPS_PAT=azpat_segredo\n");
        let derived = parsed.derived_credential_values();
        assert!(
            derived
                .iter()
                .any(|value| value == "YWRvLW1jcDphenBhdF9zZWdyZWRv"),
            "{derived:?}"
        );
        let text = "PERSONAL_ACCESS_TOKEN=YWRvLW1jcDphenBhdF9zZWdyZWRv";
        assert!(!redact(text, &derived).contains("YWRvLW1jcDphenBhdF9zZWdyZWRv"));
    }

    #[test]
    fn redacao_esconde_credenciais_e_preserva_org() {
        let parsed = vars(
            "GITHUB_PERSONAL_ACCESS_TOKEN=ghp_segredo\nAZURE_DEVOPS_PAT=azpat_segredo\nADO_ORG=kevsystem\n",
        );
        let values = parsed.credential_values();
        assert_eq!(values.len(), 2, "{values:?}");
        let text = "child: org=kevsystem token=ghp_segredo pat=azpat_segredo";
        let redacted = redact(text, &values);
        assert!(!redacted.contains("ghp_segredo"));
        assert!(!redacted.contains("azpat_segredo"));
        assert!(redacted.contains("org=kevsystem"));
    }
}
