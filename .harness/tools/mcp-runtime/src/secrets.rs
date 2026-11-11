//! Atalhos de segredos (SPEC §6, §8): `secrets init/edit` e `keys add/remove`.
//!
//! Os wrappers NÃO reimplementam criptografia — cada comando compõe os binários
//! nativos `age-keygen` e `sops` (resolvidos bin-dir próprio → PATH, SPEC §7).
//! O formato do contexto segue o layout de `paths::context_paths`:
//! `keys/<c>.agekey` + `contexts/<c>/{secrets.sops.env,recipients.txt,.sops.yaml}`.

use std::path::Path;
use std::process::Command as ProcessCommand;

use crate::cli::{Command, ParsedArgs};
use crate::paths::{self, ContextPaths, Env};
use crate::AppError;

/// Template inicial do secrets.sops.env (comentado; valores ficam por conta do
/// `secrets edit`). SPEC §12: nada de valores de segredo em logs.
const SECRET_TEMPLATE: &str = "# Contexto gerenciado pelo mcp-runtime (SPEC §6).\n\
# Edite com: mcp-runtime secrets edit --context <c>\n\
GITHUB_PERSONAL_ACCESS_TOKEN=\n\
# AZURE_DEVOPS_PAT= (opcional)\n\
ADO_ORG=\n";

pub fn run(parsed: &ParsedArgs, env: &Env, platform: &str) -> Result<i32, AppError> {
    let context = parsed
        .context
        .as_deref()
        .expect("parse_args garante --context para secrets/keys");
    match parsed.command {
        Command::SecretsInit => init(context, env, platform),
        Command::SecretsEdit => edit(context, env, platform),
        Command::KeysAdd => keys_add(
            context,
            parsed
                .recipient
                .as_deref()
                .expect("parse_args garante --recipient"),
            env,
            platform,
        ),
        Command::KeysRemove => keys_remove(
            context,
            parsed
                .recipient
                .as_deref()
                .expect("parse_args garante --recipient"),
            env,
            platform,
        ),
        _ => Err(AppError::Other(format!(
            "comando não pertence ao grupo de segredos: {}",
            parsed.label
        ))),
    }
}

// ---------------------------------------------------------------------------
// secrets init
// ---------------------------------------------------------------------------

fn init(context: &str, env: &Env, platform: &str) -> Result<i32, AppError> {
    let paths = paths::context_paths(context, env);
    if context_files_exist(&paths) {
        let dir = paths
            .sops_file
            .parent()
            .map(|dir| dir.display().to_string())
            .unwrap_or_else(|| context.to_string());
        return Err(AppError::Usage(format!(
            "contexto {context} já existe em {dir} (remova-o antes de recriar)"
        )));
    }

    let keygen = paths::find_tool("age-keygen", env, platform)
        .ok_or_else(|| AppError::Other(age_missing_error(platform)))?;
    let keys_dir = paths.key.parent().expect("key tem diretório pai");
    std::fs::create_dir_all(keys_dir)?;
    std::fs::create_dir_all(context_dir(&paths))?;

    let mut keygen_cmd = ProcessCommand::new(&keygen);
    keygen_cmd
        .arg("-o")
        .arg(&paths.key)
        .stdout(std::process::Stdio::piped());
    let keygen_out = keygen_cmd.output()?;
    if !keygen_out.status.success() {
        std::fs::remove_file(&paths.key).ok();
        return Err(AppError::Other(format!(
            "age-keygen falhou (exit {}): {}",
            keygen_out.status.code().unwrap_or(1),
            String::from_utf8_lossy(&keygen_out.stderr).trim()
        )));
    }
    restrict_key_permissions(&paths.key)?;

    let public = public_key_from_file(&paths.key)
        .or_else(|| public_key_from_output(&String::from_utf8_lossy(&keygen_out.stderr)))
        .ok_or_else(|| {
            AppError::Other(format!(
                "chave pública não encontrada em {} (age-keygen sem comentário)",
                paths.key.display()
            ))
        })?;

    std::fs::write(&paths.recipients, format!("{public}\n"))?;
    std::fs::write(
        &paths.sops_config,
        render_sops_config(std::slice::from_ref(&public)),
    )?;
    std::fs::write(&paths.sops_file, SECRET_TEMPLATE)?;

    // cifra o template para o primeiro recipient (sops lê .sops.yaml apenas
    // para criação automática — aqui a chave vem explícita em --age)
    let sops = paths::find_tool("sops", env, platform)
        .ok_or_else(|| AppError::Other(sops_missing_error(platform)))?;
    let mut encrypt = ProcessCommand::new(&sops);
    encrypt
        .arg("--encrypt")
        .arg("--age")
        .arg(&public)
        .arg("--in-place")
        .arg("--input-type")
        .arg("env")
        .arg("--output-type")
        .arg("env")
        .arg(&paths.sops_file)
        .current_dir(context_dir(&paths));
    let out = encrypt.output()?;
    if !out.status.success() {
        return Err(AppError::Other(format!(
            "sops --encrypt falhou (exit {}): {}",
            out.status.code().unwrap_or(1),
            String::from_utf8_lossy(&out.stderr).trim()
        )));
    }

    println!("[mcp-runtime] contexto {context} inicializado");
    println!("[mcp-runtime] chave privada: {}", paths.key.display());
    println!("[mcp-runtime] chave pública: {public}");
    println!("[mcp-runtime] {}", paths.sops_file.display());
    println!("[mcp-runtime] secrets.sops.env cifrado para {public}");
    println!("[mcp-runtime] edite com: mcp-runtime secrets edit --context {context}");
    println!("[mcp-runtime] o template nasce com as obrigatórias vazias; depois suba com: mcp-runtime up --context {context}");
    Ok(0)
}

// ---------------------------------------------------------------------------
// secrets edit
// ---------------------------------------------------------------------------

fn edit(context: &str, env: &Env, platform: &str) -> Result<i32, AppError> {
    let paths = paths::context_paths(context, env);
    require_context(&paths, context)?;
    let sops = paths::find_tool("sops", env, platform)
        .ok_or_else(|| AppError::Other(sops_missing_error(platform)))?;

    let mut cmd = ProcessCommand::new(&sops);
    cmd.arg("edit")
        .arg(&paths.sops_file)
        .env("SOPS_AGE_KEY_FILE", &paths.key)
        .current_dir(context_dir(&paths));
    let status = cmd.status()?;
    let code = status.code().unwrap_or(1);
    if !(status.success() || code == 200) {
        // sops 3.13.3: "File has not changed, exiting." sai 200 quando o editor
        // não altera o arquivo — sem alterações é sucesso para o wrapper.
        return Err(AppError::Exit(code));
    }

    // SPEC §5 (P7): o wrapper valida o resultado da edição — sem isso um
    // contexto vazio parece pronto. Só nomes e presença; nunca valores (§12).
    validate_context(context, &paths, &sops)
}

/// Relatório pós-edição: quais obrigatórias continuam ausentes e qual modo de
/// autenticação resultou. Nunca imprime valores de segredo (SPEC §12).
fn validate_context(context: &str, paths: &ContextPaths, sops: &Path) -> Result<i32, AppError> {
    let decrypted = crate::context::decrypt(sops, &paths.sops_file, &paths.key)?;
    let vars = crate::context::ContextVars::parse(&decrypted);
    println!(
        "[mcp-runtime] autenticação do serviço ado: modo {}",
        vars.auth_mode().as_str()
    );
    let absent = vars.missing();
    if absent.is_empty() {
        println!("[mcp-runtime] variáveis obrigatórias presentes");
        println!("[mcp-runtime] suba a stack com: mcp-runtime up --context {context}");
        return Ok(0);
    }
    eprintln!("[mcp-runtime] contexto {context}: variáveis obrigatórias ainda ausentes");
    for (service, key, reason) in &absent {
        eprintln!("  - {key} (serviço: {service}) — {reason}");
    }
    eprintln!("[mcp-runtime] edite com: mcp-runtime secrets edit --context {context}");
    eprintln!("[mcp-runtime] o `up` recusa iniciar enquanto faltar variável obrigatória");
    Ok(1)
}

// ---------------------------------------------------------------------------
// keys add / keys remove
// ---------------------------------------------------------------------------

fn keys_add(context: &str, recipient: &str, env: &Env, platform: &str) -> Result<i32, AppError> {
    validate_recipient(recipient)?;
    let paths = paths::context_paths(context, env);
    require_context(&paths, context)?;
    let mut recipients = read_recipients(&paths.recipients)?;
    if recipients.iter().any(|r| r == recipient) {
        return Err(AppError::Usage(format!(
            "recipient {recipient} já está presente no contexto {context}"
        )));
    }
    recipients.push(recipient.to_string());
    persist_recipients(&paths, &recipients)?;
    run_updatekeys(&paths, env, platform)
}

fn keys_remove(context: &str, recipient: &str, env: &Env, platform: &str) -> Result<i32, AppError> {
    validate_recipient(recipient)?;
    let paths = paths::context_paths(context, env);
    require_context(&paths, context)?;
    let recipients = read_recipients(&paths.recipients)?;
    if !recipients.iter().any(|r| r == recipient) {
        return Err(AppError::Usage(format!(
            "recipient {recipient} não está presente no contexto {context}"
        )));
    }
    if recipients.len() <= 1 {
        return Err(AppError::Usage(format!(
            "não é possível remover o último recipient do contexto {context}"
        )));
    }
    let remaining: Vec<String> = recipients
        .iter()
        .filter(|r| r.as_str() != recipient)
        .cloned()
        .collect();
    persist_recipients(&paths, &remaining)?;
    run_updatekeys(&paths, env, platform)
}

/// Reencapsula o secrets.sops.env para a lista atual de recipients
/// (`sops updatekeys` lê o .sops.yaml a partir do CWD — por isso o cwd do
/// contexto), confirmando com "y" no stdin e usando a identidade do contexto.
fn run_updatekeys(paths: &ContextPaths, env: &Env, platform: &str) -> Result<i32, AppError> {
    let sops = paths::find_tool("sops", env, platform)
        .ok_or_else(|| AppError::Other(sops_missing_error(platform)))?;
    let mut cmd = ProcessCommand::new(&sops);
    cmd.arg("updatekeys")
        .arg("secrets.sops.env")
        .env("SOPS_AGE_KEY_FILE", &paths.key)
        .current_dir(context_dir(paths))
        .stdin(std::process::Stdio::piped());
    let mut child = cmd.spawn()?;
    if let Some(stdin) = child.stdin.as_mut() {
        use std::io::Write;
        stdin.write_all(b"y\n")?;
    }
    let status = child.wait()?;
    if status.success() {
        println!("[mcp-runtime] secrets.sops.env reencapsulado");
        Ok(0)
    } else {
        Err(AppError::Exit(status.code().unwrap_or(1)))
    }
}

// ---------------------------------------------------------------------------
// Helpers puros (testáveis)
// ---------------------------------------------------------------------------

fn context_files_exist(paths: &ContextPaths) -> bool {
    paths.key.exists()
        || paths.sops_file.exists()
        || paths.recipients.exists()
        || paths.sops_config.exists()
}

fn context_dir(paths: &ContextPaths) -> std::path::PathBuf {
    paths
        .sops_file
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_default()
}

fn require_context(paths: &ContextPaths, context: &str) -> Result<(), AppError> {
    let missing: Vec<&str> = [
        ("chave", paths.key.as_path()),
        ("secrets.sops.env", paths.sops_file.as_path()),
        ("recipients.txt", paths.recipients.as_path()),
        (".sops.yaml", paths.sops_config.as_path()),
    ]
    .into_iter()
    .filter(|(_, path)| !path.exists())
    .map(|(label, _)| label)
    .collect();
    if !missing.is_empty() {
        return Err(AppError::Usage(format!(
            "contexto {context} não inicializado ({}) em {}; rode: mcp-runtime secrets init --context {context}",
            missing.join(", "),
            context_dir(paths).display()
        )));
    }
    Ok(())
}

fn read_recipients(path: &Path) -> Result<Vec<String>, AppError> {
    let text = std::fs::read_to_string(path)?;
    let recipients: Vec<String> = text
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
        .map(str::to_string)
        .collect();
    if recipients.is_empty() {
        return Err(AppError::Other(format!(
            "{}: recipients.txt sem recipients válidos",
            path.display()
        )));
    }
    Ok(recipients)
}

/// .sops.yaml com UMA creation rule: recipients separados por vírgula formam
/// o grupo de chaves do arquivo (sops divide a lista na vírgula).
fn render_sops_config(recipients: &[String]) -> String {
    format!("creation_rules:\n  - age: \"{}\"\n", recipients.join(","))
}

fn persist_recipients(paths: &ContextPaths, recipients: &[String]) -> Result<(), AppError> {
    std::fs::write(&paths.recipients, format!("{}\n", recipients.join("\n")))?;
    std::fs::write(&paths.sops_config, render_sops_config(recipients))?;
    Ok(())
}

/// Recipient precisa ser uma chave pública age (`age1...`, base bech32).
fn validate_recipient(recipient: &str) -> Result<(), AppError> {
    let value = recipient.trim();
    if value.len() < 20 || !value.starts_with("age1") || value.contains(char::is_whitespace) {
        return Err(AppError::Usage(format!(
            "--recipient inválido: \"{recipient}\" (use uma chave pública age1... gerada pelo age-keygen)"
        )));
    }
    Ok(())
}

/// Chave pública no comentário do arquivo gerado pelo age-keygen.
fn public_key_from_file(path: &Path) -> Option<String> {
    let text = std::fs::read_to_string(path).ok()?;
    public_key_from_output(&text)
}

fn public_key_from_output(text: &str) -> Option<String> {
    for line in text.lines() {
        let line = line.trim();
        for prefix in ["# public key: ", "Public key: "] {
            if let Some(rest) = line.strip_prefix(prefix) {
                let value = rest.trim();
                if value.starts_with("age1") {
                    return Some(value.to_string());
                }
            }
        }
    }
    None
}

fn restrict_key_permissions(path: &Path) -> Result<(), AppError> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = std::fs::metadata(path)?.permissions();
        perms.set_mode(0o600);
        std::fs::set_permissions(path, perms)?;
    }
    #[cfg(not(unix))]
    {
        let _ = path;
    }
    Ok(())
}

fn age_missing_error(platform: &str) -> String {
    format!(
        "age-keygen não encontrado no bin-dir próprio e no PATH ({platform}); rode: mcp-runtime tools install"
    )
}

fn sops_missing_error(platform: &str) -> String {
    format!(
        "sops não encontrado no bin-dir próprio e no PATH ({platform}); rode: mcp-runtime tools install"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn recipients(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn renderiza_creation_rule_com_um_recipient() {
        let config = render_sops_config(&recipients(&["age1abc"]));
        assert_eq!(config, "creation_rules:\n  - age: \"age1abc\"\n");
    }

    #[test]
    fn renderiza_grupo_com_dois_recipients_na_mesma_rule() {
        let config = render_sops_config(&recipients(&["age1abc", "age1def"]));
        assert_eq!(config, "creation_rules:\n  - age: \"age1abc,age1def\"\n");
    }

    #[test]
    fn recipient_invalido_e_rejeitado() {
        assert!(validate_recipient("").is_err());
        assert!(validate_recipient("AGE1ABCDEFGHIJKLMNOPQRSTUVWXYZ").is_err());
        assert!(validate_recipient("ssh-ed25519 AAAA").is_err());
        assert!(validate_recipient("age1 abc def").is_err());
        assert!(validate_recipient("age1abcdefghijklmnopqrstuvwxyz").is_ok());
    }

    #[test]
    fn chave_publica_vem_do_comentario_do_arquivo() {
        let key_file = "# created: 2026-09-19T00:00:00Z\n# public key: age1qyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqs3kj0x\nAGE-SECRET-KEY-1...\n";
        assert_eq!(
            public_key_from_output(key_file).as_deref(),
            Some("age1qyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqs3kj0x")
        );
        assert_eq!(public_key_from_output("nada aqui"), None);
        assert_eq!(
            public_key_from_output(
                "Public key: age1qyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqs3kj0x"
            )
            .as_deref(),
            Some("age1qyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqs3kj0x")
        );
    }

    #[test]
    fn le_recipients_ignorando_comentarios_e_vazias() {
        let dir = paths::create_temp_dir("secrets-recipients-").unwrap();
        let path = dir.join("recipients.txt");
        std::fs::write(&path, "# comentário\n\nage1abc\n  age1def  \n\n").unwrap();
        assert_eq!(read_recipients(&path).unwrap(), vec!["age1abc", "age1def"]);
        std::fs::write(&path, "# só comentário\n").unwrap();
        assert!(read_recipients(&path).is_err());
        paths::remove_tree(&dir);
    }
}
