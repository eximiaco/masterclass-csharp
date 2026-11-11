// doctor — inventário de pré-requisitos (SPEC §7): caminhos encontrados vão
// para stdout; orientação de instalação vai para stderr. Também reporta, sem
// efeito colateral: como o CLI foi resolvido (SPEC §7 — o binário não vai para
// o PATH), as variáveis do contexto por NOME, o modo de autenticação
// resultante e o estado da sessão Azure (SPEC §4/§5). Nunca imprime valores.
use crate::paths::{context_paths, find_runtime, find_secrets_tools, Env, SecretsTools};
use crate::AppError;

pub fn install_guidance(binary: &str) -> String {
    format!(
        "  - {binary}: ausente no bin-dir próprio e no PATH\n    instale com: mcp-runtime tools install"
    )
}

pub fn doctor(context: Option<&str>, env: &Env, platform: &str) -> Result<i32, AppError> {
    let tools = find_secrets_tools(env, platform);
    let runtime = find_runtime(env, platform)?;
    let mut missing: Vec<String> = Vec::new();

    for (label, path) in [
        ("age", &tools.age),
        ("age-keygen", &tools.age_keygen),
        ("sops", &tools.sops),
    ] {
        if let Some(path) = path {
            println!("[doctor] {label}: {}", path.display());
        } else {
            eprintln!("{}", install_guidance(label));
            missing.push(label.to_string());
        }
    }
    match &runtime {
        Some(runtime) => {
            println!(
                "[doctor] runtime de container: {} ({})",
                runtime.name,
                runtime.path.display()
            );
        }
        None => {
            eprintln!("  - runtime de container: ausente (nerdctl ou docker)");
            eprintln!("    instale Rancher Desktop (inclui nerdctl) ou Docker Desktop");
            missing.push("runtime".to_string());
        }
    }

    report_executable();

    match crate::lifecycle::resolve_arch_corpus(env, context) {
        Ok(path) => println!("[doctor] corpus xharness: {}", path.display()),
        Err(message) => {
            eprintln!("  - {message}");
            eprintln!(
                "    o `up` sobe sem xharness se o corpus estiver ausente; defina MCP_RUNTIME_ARCH_CORPUS para habilitar a norma (SPEC §5 / ADR-0008)"
            );
        }
    }

    if let Some(context) = context {
        let paths = context_paths(context, env);
        let expected = [
            ("chave age", &paths.key),
            ("secrets.sops.env", &paths.sops_file),
            ("recipients", &paths.recipients),
            (".sops.yaml", &paths.sops_config),
        ];
        for (label, path) in expected {
            if path.exists() {
                println!("[doctor] contexto {context} — {label}: {}", path.display());
            } else {
                eprintln!(
                    "  - contexto {context} — {label} ausente: {}",
                    path.display()
                );
                eprintln!("    crie com: mcp-runtime secrets init --context {context}");
                missing.push(format!("contexto:{label}"));
            }
        }
        report_context(context, env, &tools, runtime.as_ref());
    }

    if !missing.is_empty() {
        eprintln!("[doctor] pendências: {}", missing.join(", "));
        return Ok(1);
    }
    println!("[doctor] pré-requisitos completos");
    Ok(0)
}

// ---------------------------------------------------------------------------
// Relatórios informativos (não alteram o código de saída — P6/P7, SPEC §7)
// ---------------------------------------------------------------------------

/// Resolução do próprio CLI: o binário vive no diretório do artefato e o canal
/// NÃO o coloca no PATH (SPEC §7) — o doctor diz de onde ele rodou.
fn report_executable() {
    let Some(resolved) = crate::paths::executable_path() else {
        eprintln!("  - executável: não resolvido (o sistema não informou o próprio caminho)");
        return;
    };
    println!("[doctor] executável: {}", resolved.display());
    match crate::compose::artifact_dir() {
        Ok(dir) => {
            println!("[doctor] artefato: {}", dir.display());
            if !resolved.starts_with(&dir) {
                eprintln!(
                    "    executável fora do diretório do artefato; use o caminho da instalação \
                     (<alvo>/.harness/tools/mcp-runtime/mcp-runtime), exporte esse diretório no PATH \
                     ou defina MCP_RUNTIME_ARTIFACT_DIR"
                );
            }
        }
        Err(message) => eprintln!("  - {message}"),
    }
}

/// Variáveis do contexto (nome + presente/ausente), modo do serviço `ado` e
/// estado da sessão Azure quando o modo é `azcli`.
fn report_context(
    context: &str,
    env: &Env,
    tools: &SecretsTools,
    runtime: Option<&crate::paths::ContainerRuntime>,
) {
    let paths = context_paths(context, env);
    let Some(sops) = tools.sops.as_ref() else {
        eprintln!("  - contexto {context}: variáveis não avaliadas (sops ausente)");
        return;
    };
    if !paths.sops_file.exists() || !paths.key.exists() {
        return;
    }
    let vars = match crate::context::decrypt(sops, &paths.sops_file, &paths.key) {
        Ok(decrypted) => crate::context::ContextVars::parse(&decrypted),
        Err(message) => {
            eprintln!("  - contexto {context}: variáveis não avaliadas ({message})");
            return;
        }
    };

    for (service, key, _) in crate::context::REQUIRED {
        println!(
            "[doctor] contexto {context} — {key} ({service}): {}",
            presence(&vars, key)
        );
    }
    println!(
        "[doctor] contexto {context} — AZURE_DEVOPS_PAT (ado): {} (opcional; seleciona o modo)",
        presence(&vars, "AZURE_DEVOPS_PAT")
    );
    println!(
        "[doctor] contexto {context} — modo do serviço ado: {}",
        vars.auth_mode().as_str()
    );

    if vars.auth_mode() != crate::context::AuthMode::Azcli {
        return;
    }
    let Some(runtime) = runtime else {
        eprintln!(
            "  - contexto {context}: sessão Azure não avaliada (runtime de container ausente)"
        );
        return;
    };
    if !crate::lifecycle::container_running(runtime, context, "ado") {
        println!(
            "[doctor] contexto {context} — sessão Azure: não avaliada (container mcp-{context}-ado-1 não está no ar)"
        );
        return;
    }
    match crate::compose::capture_compose(runtime, context, &crate::lifecycle::az_session_command(), env) {
        Ok((Some(0), _)) => println!(
            "[doctor] contexto {context} — sessão Azure: válida no container (a CLI usa a mesma checagem no `up`)"
        ),
        Ok((code, _)) => eprintln!(
            "  - contexto {context}: sessão Azure ausente/expirada no container (exit {}) — o `up` conduz o login por device code",
            code.map(|code| code.to_string()).unwrap_or_else(|| "signal".to_string())
        ),
        Err(message) => eprintln!("  - contexto {context}: sessão Azure não avaliada ({message})"),
    }
}

fn presence(vars: &crate::context::ContextVars, key: &str) -> &'static str {
    if vars.is_set(key) {
        "presente"
    } else {
        "ausente"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn orientacao_aponta_para_o_tools_install() {
        for binary in ["sops", "age", "age-keygen"] {
            let guidance = install_guidance(binary);
            assert!(
                guidance.contains(&format!(
                    "  - {binary}: ausente no bin-dir próprio e no PATH"
                )),
                "{guidance}"
            );
            assert!(
                guidance.contains("    instale com: mcp-runtime tools install"),
                "{guidance}"
            );
        }
    }
}
