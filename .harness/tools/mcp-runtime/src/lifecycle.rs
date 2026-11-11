// up / down / status (SPEC §8, §10). A prontidão do `up` é o handshake MCP
// `initialize` no endpoint de cada serviço (SPEC §9, src/mcp.rs): HTTP puro
// sobre loopback, sem TLS — SPEC §1.
use std::io::IsTerminal;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::thread;
use std::time::{Duration, Instant};

use crate::compose::{capture_compose, run_compose, spawn_compose};
use crate::paths::{
    context_paths, ephemeral_paths, find_runtime, find_secrets_tools, remove_tree,
    ContainerRuntime, Env,
};
use crate::AppError;

pub const GITHUB_PORT: u16 = 8377;
pub const ADO_PORT: u16 = 8378;
pub const XHARNESS_PORT: u16 = 8379;
const WAIT_TIMEOUT: Duration = Duration::from_secs(120);
const WAIT_INTERVAL: Duration = Duration::from_secs(1);
/// x-harness (v1+) sobe HTTP na hora; QMD indexa/embeda em background.
/// Só esperamos a porta/health — não o fim do embed.
const XHARNESS_HEALTH_TIMEOUT: Duration = Duration::from_secs(90);
const XHARNESS_HEALTH_INTERVAL: Duration = Duration::from_secs(2);
/// Timeout por tentativa do handshake (o server pode segurar a conexão).
const PROBE_TIMEOUT: Duration = Duration::from_secs(5);
/// Deadline próprio do login por device code (o `az` bloqueia até expirar).
const LOGIN_TIMEOUT: Duration = Duration::from_secs(600);
/// Recurso do Azure DevOps usado no gate de sessão (SPEC §4).
const AZ_RESOURCE: &str = "https://app.vssps.visualstudio.com";
/// Linhas de log por container no dump de falha (SPEC §12).
const LOG_TAIL: &str = "50";

#[derive(Debug, Clone)]
pub struct Endpoint {
    pub service: &'static str,
    pub url: String,
}

/// Endpoints dos serviços que o `up`/`status` devem considerar.
/// Sem corpus, `include_xharness` é false e só github/ado entram no handshake.
pub fn active_endpoints(include_xharness: bool) -> Vec<Endpoint> {
    let mut list = vec![
        Endpoint {
            service: "github",
            url: format!("http://127.0.0.1:{GITHUB_PORT}/"),
        },
        Endpoint {
            service: "ado",
            url: format!("http://127.0.0.1:{ADO_PORT}/mcp"),
        },
    ];
    if include_xharness {
        list.push(Endpoint {
            service: "xharness",
            url: format!("http://127.0.0.1:{XHARNESS_PORT}/mcp"),
        });
    }
    list
}

/// Serviços passados ao `compose up` (lista explícita evita bind sem corpus).
pub fn active_compose_services(include_xharness: bool) -> Vec<&'static str> {
    if include_xharness {
        vec!["github", "ado", "xharness"]
    } else {
        vec!["github", "ado"]
    }
}

/// Resolve e valida o corpus normativo (SPEC §5 / ADR-0008): diretório
/// existente contendo `arch-graph/graph-doc`. Ordem: env `MCP_RUNTIME_ARCH_CORPUS`,
/// depois `arch-corpus.path` do contexto (último `up` com corpus válido).
pub fn resolve_arch_corpus(env: &Env, context: Option<&str>) -> Result<PathBuf, String> {
    if let Some(path) = env_arch_corpus_raw(env) {
        return validate_arch_corpus_dir(&path);
    }
    if let Some(ctx) = context {
        let remembered = context_paths(ctx, env).arch_corpus_path;
        if remembered.is_file() {
            let raw = std::fs::read_to_string(&remembered)
                .map_err(|e| format!("arch-corpus.path ilegível: {e}"))?;
            let trimmed = raw.trim();
            if !trimmed.is_empty() {
                return validate_arch_corpus_dir(trimmed);
            }
        }
    }
    Err(
        "MCP_RUNTIME_ARCH_CORPUS (serviço: xharness) — defina o caminho absoluto do clone do corpus (deve conter arch-graph/graph-doc) ou rode `up` com o corpus uma vez para persistir no contexto"
            .to_string(),
    )
}

fn env_arch_corpus_raw(env: &Env) -> Option<String> {
    env.get("MCP_RUNTIME_ARCH_CORPUS")
        .map(str::to_string)
        .or_else(|| std::env::var("MCP_RUNTIME_ARCH_CORPUS").ok())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

fn validate_arch_corpus_dir(trimmed: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(trimmed);
    if !path.is_dir() {
        return Err(format!(
            "MCP_RUNTIME_ARCH_CORPUS (serviço: xharness) — diretório inexistente: {trimmed}"
        ));
    }
    let graph = path.join("arch-graph").join("graph-doc");
    if !graph.is_dir() {
        return Err(format!(
            "MCP_RUNTIME_ARCH_CORPUS (serviço: xharness) — falta arch-graph/graph-doc em {trimmed}"
        ));
    }
    Ok(std::fs::canonicalize(&path).unwrap_or(path))
}

/// Grava o corpus resolvido em `contexts/<contexto>/arch-corpus.path`.
pub fn persist_arch_corpus(context: &str, env: &Env, path: &Path) -> Result<(), String> {
    let file = context_paths(context, env).arch_corpus_path;
    if let Some(parent) = file.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let display = path.to_string_lossy();
    std::fs::write(&file, format!("{display}\n")).map_err(|e| e.to_string())?;
    Ok(())
}

/// uid:gid do arquivo de segredos no Linux (SPEC §9); em macOS o compose usa
/// o default do env-file (10001:10001).
#[cfg(target_os = "linux")]
pub fn container_user_for(platform: &str, secrets_file: &Path) -> Option<String> {
    if platform != "linux" {
        return None;
    }
    use std::os::unix::fs::MetadataExt;
    let metadata = std::fs::metadata(secrets_file).ok()?;
    Some(format!("{}:{}", metadata.uid(), metadata.gid()))
}

#[cfg(not(target_os = "linux"))]
pub fn container_user_for(_platform: &str, _secrets_file: &Path) -> Option<String> {
    None
}

pub fn up(context: &str, env: &Env, platform: &str) -> Result<i32, AppError> {
    let paths = context_paths(context, env);
    let ephemeral = ephemeral_paths(context, env);
    let runtime = find_runtime(env, platform)?;
    let tools = find_secrets_tools(env, platform);

    // pré-requisitos mínimos para subir: runtime de container + sops.
    let mut problems: Vec<&str> = Vec::new();
    if runtime.is_none() {
        problems.push("runtime de container não encontrado (nerdctl ou docker)");
    }
    if tools.sops.is_none() {
        problems.push("sops não encontrado no PATH");
    }
    if !problems.is_empty() {
        eprintln!(
            "[mcp-runtime] pré-requisitos ausentes:\n  - {}",
            problems.join("\n  - ")
        );
        eprintln!("[mcp-runtime] veja as instruções de instalação: mcp-runtime doctor");
        return Ok(1);
    }
    let runtime = runtime.expect("runtime verificado acima");

    let missing: Vec<&std::path::PathBuf> = [&paths.sops_file, &paths.key]
        .into_iter()
        .filter(|path| !path.exists())
        .collect();
    if !missing.is_empty() {
        eprintln!("[mcp-runtime] contexto incompleto; arquivos ausentes:");
        for path in &missing {
            eprintln!("  - {}", path.display());
        }
        eprintln!("[mcp-runtime] crie o contexto com os comandos nativos documentados no TOOL.md");
        return Ok(1);
    }

    eprintln!("[mcp-runtime] runtime: {}", runtime.name);
    if let Some(exe) = crate::paths::executable_path() {
        // P6: o binário não entra no PATH — a saída diz de onde ele rodou.
        eprintln!("[mcp-runtime] executável: {}", exe.display());
    }
    eprintln!("[mcp-runtime] contexto: {context} (projeto mcp-{context})");
    if let Err(message) = crate::compose::image_tag_check() {
        eprintln!("[mcp-runtime] aviso: {message}");
    }

    // Janela efêmera (SPEC §9): recria o diretório do zero a cada up.
    remove_tree(&ephemeral.dir);
    std::fs::create_dir_all(&ephemeral.dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut permissions = std::fs::metadata(&ephemeral.dir)
            .map_err(|error| error.to_string())?
            .permissions();
        permissions.set_mode(0o700);
        std::fs::set_permissions(&ephemeral.dir, permissions).map_err(|error| error.to_string())?;
    }

    let pins = match crate::compose::load_pins_file() {
        Ok(pins) => pins,
        Err(message) => {
            eprintln!("[mcp-runtime] {message}");
            remove_tree(&ephemeral.dir);
            return Ok(1);
        }
    };
    drop(pins);

    // Decriptação com sops: a chave age entra por SOPS_AGE_KEY_FILE no
    // ambiente do processo (nunca em argv — SPEC §6).
    let sops = tools.sops.expect("sops verificado acima");
    let decrypted = match crate::context::decrypt(&sops, &paths.sops_file, &paths.key) {
        Ok(decrypted) => decrypted,
        Err(message) => {
            eprintln!("[mcp-runtime] {message}");
            remove_tree(&ephemeral.dir);
            return Ok(1);
        }
    };

    // Validação das variáveis obrigatórias ANTES de qualquer container
    // (SPEC §5): sem elas o serviço sobe e não é consumível.
    let vars = crate::context::ContextVars::parse(&decrypted);
    let absent = vars.missing();
    if !absent.is_empty() {
        eprintln!("[mcp-runtime] contexto {context}: variáveis obrigatórias ausentes");
        for (service, key, reason) in &absent {
            eprintln!("  - {key} (serviço: {service}) — {reason}");
        }
        eprintln!("[mcp-runtime] corrija com: mcp-runtime secrets edit --context {context}");
        eprintln!("[mcp-runtime] nada foi iniciado; nenhum container foi criado");
        remove_tree(&ephemeral.dir);
        return Ok(1);
    }

    // Corpus normativo (SPEC §5 / ADR-0008): opcional. Ausente/inválido ⇒ aviso
    // e stack sobe só com github/ado; awu-compiler usa cascata/lacuna.
    let include_xharness = match resolve_arch_corpus(env, Some(context)) {
        Ok(path) => {
            eprintln!("[mcp-runtime] corpus xharness: {}", path.display());
            if let Err(message) = persist_arch_corpus(context, env, &path) {
                eprintln!("[mcp-runtime] aviso: não persistiu arch-corpus.path: {message}");
            }
            true
        }
        Err(message) => {
            eprintln!("[mcp-runtime] aviso: xharness omitido (serviço normativo off)");
            eprintln!("  - {message}");
            eprintln!(
                "[mcp-runtime] para habilitar: export MCP_RUNTIME_ARCH_CORPUS=<clone-do-corpus>"
            );
            eprintln!(
                "[mcp-runtime] stack sobe sem xharness; awu-compiler usará cascata/lacuna se a norma for necessária"
            );
            false
        }
    };

    let auth_mode = vars.auth_mode();
    let credentials = vars.derived_credential_values();
    let github_token = vars.get("GITHUB_PERSONAL_ACCESS_TOKEN").map(str::to_string);

    let secrets_file = ephemeral.secrets_file.clone();
    std::fs::write(&secrets_file, &decrypted).map_err(|error| error.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut permissions = std::fs::metadata(&secrets_file)
            .map_err(|error| error.to_string())?
            .permissions();
        permissions.set_mode(0o600);
        std::fs::set_permissions(&secrets_file, permissions).map_err(|error| error.to_string())?;
    }

    eprintln!(
        "[mcp-runtime] autenticação do serviço ado: modo {}",
        auth_mode.as_str()
    );
    let services = active_compose_services(include_xharness);
    // github e ado compartilham a mesma tag de imagem; `up --build` paralelo no
    // Docker Desktop falha com `image “...”: already exists`. Builda um único
    // serviço com Dockerfile (github) e depois `up -d` sem --build. xharness
    // só faz pull da imagem pinada.
    let container_user = container_user_for(platform, &secrets_file);
    let build_target = services
        .iter()
        .copied()
        .find(|service| *service == "github" || *service == "ado");
    if let Some(target) = build_target {
        let build_args = ["build", target];
        eprintln!("[mcp-runtime] compose build {target} ...");
        let built = run_compose(
            &runtime,
            context,
            &build_args,
            env,
            Some(&secrets_file),
            container_user.as_deref(),
        )?;
        if built != Some(0) {
            let status_text = built
                .map(|code| code.to_string())
                .unwrap_or_else(|| "signal".to_string());
            eprintln!("[mcp-runtime] compose build falhou (exit {status_text})");
            remove_tree(&ephemeral.dir);
            eprintln!(
                "[mcp-runtime] arquivo efêmero removido ({})",
                secrets_file.display()
            );
            return Ok(1);
        }
    }
    let mut compose_args: Vec<&str> = vec!["up", "-d"];
    compose_args.extend(services.iter().copied());
    eprintln!("[mcp-runtime] compose up -d {} ...", services.join(" "));
    let created = run_compose(
        &runtime,
        context,
        &compose_args,
        env,
        Some(&secrets_file),
        container_user.as_deref(),
    )?;

    let cleanup = |secrets_file: &Path| {
        remove_tree(&ephemeral.dir);
        eprintln!(
            "[mcp-runtime] arquivo efêmero removido ({})",
            secrets_file.display()
        );
    };

    if created != Some(0) {
        let status_text = created
            .map(|code| code.to_string())
            .unwrap_or_else(|| "signal".to_string());
        eprintln!("[mcp-runtime] compose up falhou (exit {status_text})");
        cleanup(&secrets_file);
        return Ok(1);
    }

    // O plaintext já cumpriu seu papel no start dos containers: removido antes
    // da prontidão e do login (SPEC §9).
    cleanup(&secrets_file);

    if include_xharness {
        eprintln!(
            "[mcp-runtime] aguardando health do xharness (até {}s; QMD indexa em background) ...",
            XHARNESS_HEALTH_TIMEOUT.as_secs()
        );
        if let Err(reason) = wait_xharness_health(&runtime, context) {
            eprintln!("[mcp-runtime] prontidão reprovada: {reason}");
            dump_logs(&runtime, context, &credentials, include_xharness);
            return Ok(1);
        }
        eprintln!("[mcp-runtime] xharness: health OK (http://127.0.0.1:{XHARNESS_PORT}/health)");
    }

    eprintln!("[mcp-runtime] aguardando handshake MCP ...");
    match wait_handshakes(&runtime, context, github_token.as_deref(), include_xharness) {
        Ok(waited) => {
            for (endpoint, init) in &waited {
                eprintln!("[mcp-runtime] {}: {}", endpoint.service, init.summary());
            }
        }
        Err((waited, reason)) => {
            eprintln!("[mcp-runtime] prontidão reprovada: {reason}");
            for (endpoint, init) in &waited {
                eprintln!(
                    "[mcp-runtime] {}: {} | {}",
                    endpoint.service,
                    container_label(&runtime, context, endpoint.service),
                    init.summary()
                );
            }
            if waited
                .iter()
                .any(|(_, init)| init.detail.contains("credencial recusada"))
            {
                eprintln!(
                    "[mcp-runtime] rotacione com: mcp-runtime secrets edit --context {context}"
                );
            }
            dump_logs(&runtime, context, &credentials, include_xharness);
            return Ok(1);
        }
    }

    // Modo azcli (SPEC §4): sem PAT o server depende da sessão az do container.
    if auth_mode == crate::context::AuthMode::Azcli {
        let code = ensure_az_session(&runtime, context, env)?;
        if code != 0 {
            return Ok(code);
        }
    }

    // Wiring Cursor (ADR-0009): merge mcp.json com endpoints canônicos; sem PAT.
    // Falha de I/O não derruba a stack já pronta.
    if let Err(error) = crate::client_config::sync_cursor_mcp(env, include_xharness) {
        let detail = match error {
            AppError::Other(message) | AppError::Usage(message) => message,
            AppError::Exit(code) => format!("exit {code}"),
        };
        eprintln!("[mcp-runtime] aviso: client config não sincronizado: {detail}");
    }

    eprintln!("[mcp-runtime] stack pronta; endpoints em loopback (SPEC §1)");
    Ok(0)
}

/// Nome determinístico do compose: `<project>-<service>-<index>`.
fn container_name(context: &str, service: &str) -> String {
    format!("mcp-{context}-{service}-1")
}

/// Estado do container por `inspect` (SPEC §10): status e exit code.
fn container_state(
    runtime: &ContainerRuntime,
    context: &str,
    service: &str,
) -> Option<(String, i64)> {
    let name = container_name(context, service);
    let output = Command::new(&runtime.path)
        .args([
            "inspect",
            "--format",
            "{{.State.Status}}|{{.State.ExitCode}}",
            &name,
        ])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let (status, code) = text.trim().split_once('|')?;
    Some((status.trim().to_string(), code.trim().parse().unwrap_or(-1)))
}

/// Container do serviço está no ar? (usado pelo `doctor`, sem efeito colateral)
pub fn container_running(runtime: &ContainerRuntime, context: &str, service: &str) -> bool {
    matches!(container_state(runtime, context, service), Some((status, _)) if status == "running")
}

/// `compose exec` com a checagem de sessão Azure (SPEC §4), para o `doctor`.
pub fn az_session_command() -> Vec<&'static str> {
    let mut args = vec!["exec", "-T", "ado", "az"];
    args.extend(az_check_args());
    args
}

/// Estado legível do container para `up`/`status`.
fn container_label(runtime: &ContainerRuntime, context: &str, service: &str) -> String {
    match container_state(runtime, context, service) {
        Some((status, _)) if status == "running" => "container running".to_string(),
        Some((status, code)) => {
            if status == "exited" || status == "dead" {
                format!("container {status} ({code})")
            } else {
                format!("container {status}")
            }
        }
        None => "container ausente".to_string(),
    }
}

/// Dump de logs por container quando a prontidão falha (SPEC §12): `compose
/// logs` pendura no nerdctl (ADR-0001), então usa-se o `logs` do runtime com o
/// nome determinístico. Nenhum valor de credencial é impresso.
fn dump_logs(
    runtime: &ContainerRuntime,
    context: &str,
    credentials: &[String],
    include_xharness: bool,
) {
    for service in active_compose_services(include_xharness) {
        let name = container_name(context, service);
        eprintln!(
            "[mcp-runtime] {} logs --tail {LOG_TAIL} {name}:",
            runtime.name
        );
        match Command::new(&runtime.path)
            .args(["logs", "--tail", LOG_TAIL, &name])
            .output()
        {
            Ok(output) => {
                let text = format!(
                    "{}{}",
                    String::from_utf8_lossy(&output.stdout),
                    String::from_utf8_lossy(&output.stderr)
                );
                let text = crate::context::redact(&text, credentials);
                let text = text.trim_end();
                if text.is_empty() {
                    eprintln!("  (sem saída)");
                } else {
                    for line in text.lines() {
                        eprintln!("  {}", line.trim_end());
                    }
                }
            }
            Err(error) => eprintln!("  (falha ao ler logs: {error})"),
        }
    }
}

/// Resultado do handshake de um serviço (endpoint + classificação).
type Handshake = (Endpoint, crate::mcp::Initialize);
/// Handshakes observados junto do motivo da reprovação.
type HandshakeFailure = (Vec<Handshake>, String);

/// Pré-porta do xharness: espera `GET /health` no loopback (compose mapeia
/// 8379→3100). Não substitui o handshake MCP — só evita timeout de 120s
/// enquanto o QMD ainda indexa/embeda e o HTTP não está no ar.
fn wait_xharness_health(runtime: &ContainerRuntime, context: &str) -> Result<(), String> {
    let url = format!("http://127.0.0.1:{XHARNESS_PORT}/health");
    let started = Instant::now();
    let deadline = started + XHARNESS_HEALTH_TIMEOUT;
    let mut last_log = started;
    loop {
        if crate::mcp::health_ok(&url, PROBE_TIMEOUT) {
            return Ok(());
        }
        if let Some((status, code)) = container_state(runtime, context, "xharness") {
            if status != "running" {
                return Err(format!(
                    "xharness: container {status} ({code}) — o processo do server não está no ar"
                ));
            }
        }
        if Instant::now() >= deadline {
            return Err(format!(
                "tempo esgotado ({}s) aguardando health do xharness em {url}",
                XHARNESS_HEALTH_TIMEOUT.as_secs()
            ));
        }
        if last_log.elapsed() >= Duration::from_secs(30) {
            eprintln!(
                "[mcp-runtime] xharness ainda sem health após {}s ...",
                started.elapsed().as_secs()
            );
            last_log = Instant::now();
        }
        thread::sleep(XHARNESS_HEALTH_INTERVAL);
    }
}

/// Aguarda o handshake `initialize` de todos os serviços (SPEC §9) e falha
/// rápido quando o container do serviço já morreu.
fn wait_handshakes(
    runtime: &ContainerRuntime,
    context: &str,
    github_token: Option<&str>,
    include_xharness: bool,
) -> Result<Vec<Handshake>, HandshakeFailure> {
    let deadline = Instant::now() + WAIT_TIMEOUT;
    loop {
        let mut results = Vec::new();
        let mut all_ok = true;
        let mut fatal: Option<String> = None;
        for endpoint in active_endpoints(include_xharness) {
            let token = if endpoint.service == "github" {
                github_token
            } else {
                None
            };
            let init = crate::mcp::initialize(&endpoint.url, token, PROBE_TIMEOUT);
            if !init.ok {
                all_ok = false;
                if let Some((status, code)) = container_state(runtime, context, endpoint.service) {
                    if status != "running" {
                        fatal = Some(format!(
                            "{}: container {status} ({code}) — o processo do server não está no ar",
                            endpoint.service
                        ));
                    }
                }
            }
            results.push((endpoint, init));
        }
        if all_ok {
            return Ok(results);
        }
        if let Some(reason) = fatal {
            return Err((results, reason));
        }
        if Instant::now() >= deadline {
            return Err((
                results,
                format!(
                    "tempo esgotado ({}s) aguardando o handshake MCP",
                    WAIT_TIMEOUT.as_secs()
                ),
            ));
        }
        thread::sleep(WAIT_INTERVAL);
    }
}

/// Sessão az (SPEC §4): verifica dentro do container e, se faltar, conduz o
/// login por device code retransmitindo a saída do `az` ao terminal do host.
fn ensure_az_session(
    runtime: &ContainerRuntime,
    context: &str,
    env: &Env,
) -> Result<i32, AppError> {
    eprintln!("[mcp-runtime] modo azcli: verificando a sessão Azure no container ...");
    let mut check = vec!["exec", "-T", "ado", "az"];
    check.extend(az_check_args());
    if run_compose(runtime, context, &check, env, None, None)? == Some(0) {
        if let Some(account) = az_account(runtime, context, env) {
            eprintln!("[mcp-runtime] sessão Azure válida (conta: {account})");
        } else {
            eprintln!("[mcp-runtime] sessão Azure válida");
        }
        return Ok(0);
    }

    if !std::io::stdin().is_terminal() {
        eprintln!("[mcp-runtime] sem TTY: rode manualmente para autenticar");
        eprintln!(
            "  {} exec -i {} az login --use-device-code --allow-no-subscriptions",
            runtime.name,
            container_name(context, "ado")
        );
        return Ok(1);
    }

    eprintln!(
        "[mcp-runtime] sessão ausente/expirada; iniciando login por device code no container"
    );
    let mut login = vec!["exec", "-T", "ado", "az", "login", "--use-device-code"];
    login.push("--allow-no-subscriptions");
    let (mut child, env_dir) = spawn_compose(runtime, context, &login, env, None, None)?;
    let outcome = relay_child(&mut child, LOGIN_TIMEOUT);
    remove_tree(&env_dir);
    match outcome {
        Relay::Exited(0) => {}
        Relay::Exited(code) => {
            eprintln!("[mcp-runtime] login az falhou (exit {code})");
            return Ok(1);
        }
        Relay::TimedOut(seconds) => {
            eprintln!("[mcp-runtime] login az excedeu {seconds}s sem concluir; interrompido");
            return Ok(1);
        }
    }

    let mut recheck = vec!["exec", "-T", "ado", "az"];
    recheck.extend(az_check_args());
    if run_compose(runtime, context, &recheck, env, None, None)? != Some(0) {
        eprintln!("[mcp-runtime] sessão Azure ainda inválida após o login");
        return Ok(1);
    }
    match az_account(runtime, context, env) {
        Some(account) => eprintln!("[mcp-runtime] sessão Azure validada (conta: {account})"),
        None => eprintln!("[mcp-runtime] sessão Azure validada"),
    }
    Ok(0)
}

/// Checagem de sessão usada como gate (SPEC §4): sai 0 sem imprimir token.
fn az_check_args() -> Vec<&'static str> {
    vec![
        "account",
        "get-access-token",
        "--resource",
        AZ_RESOURCE,
        "-o",
        "none",
    ]
}

/// Conta autenticada, quando disponível (não é segredo; best effort).
fn az_account(runtime: &ContainerRuntime, context: &str, env: &Env) -> Option<String> {
    let (code, stdout) = capture_compose(
        runtime,
        context,
        &[
            "exec",
            "-T",
            "ado",
            "az",
            "account",
            "list",
            "--query",
            "[0].user.name",
            "-o",
            "tsv",
        ],
        env,
    )
    .ok()?;
    if code != Some(0) {
        return None;
    }
    let account = stdout.trim().to_string();
    if account.is_empty() || account.contains(' ') {
        None
    } else {
        Some(account)
    }
}

enum Relay {
    Exited(i32),
    TimedOut(u64),
}

/// Retransmite stdout/stderr do processo com prefixo `[az] ` e espera com
/// deadline próprio (o `az` bloqueia até o device code expirar).
fn relay_child(child: &mut std::process::Child, timeout: Duration) -> Relay {
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let mut readers = Vec::new();
    for stream in [stdout.map(RelayStream::Out), stderr.map(RelayStream::Err)]
        .into_iter()
        .flatten()
    {
        readers.push(thread::spawn(move || {
            let reader: Box<dyn std::io::Read + Send> = match stream {
                RelayStream::Out(stream) => Box::new(stream),
                RelayStream::Err(stream) => Box::new(stream),
            };
            relay_lines(reader);
        }));
    }

    let deadline = Instant::now() + timeout;
    let outcome = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Relay::Exited(status.code().unwrap_or(1)),
            Ok(None) => {}
            Err(_) => break Relay::Exited(1),
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            break Relay::TimedOut(timeout.as_secs());
        }
        thread::sleep(Duration::from_millis(500));
    };
    for reader in readers {
        let _ = reader.join();
    }
    outcome
}

enum RelayStream {
    Out(std::process::ChildStdout),
    Err(std::process::ChildStderr),
}

fn relay_lines(reader: Box<dyn std::io::Read + Send>) {
    use std::io::BufRead;
    let mut buffer = std::io::BufReader::new(reader);
    let mut line = String::new();
    while let Ok(read) = buffer.read_line(&mut line) {
        if read == 0 {
            break;
        }
        eprintln!("[az] {}", line.trim_end());
        line.clear();
    }
}

pub fn down(context: &str, env: &Env, platform: &str) -> Result<i32, AppError> {
    let runtime = find_runtime(env, platform)?;
    let Some(runtime) = runtime else {
        eprintln!("[mcp-runtime] runtime de container não encontrado (nerdctl ou docker)");
        return Ok(1);
    };
    // Sem `-v`: o volume `xharness-qmd` guarda o cache QMD (busca híbrida).
    // Só removemos `ado-auth` (sessão Azure/PAT efêmera — SPEC §9).
    let result = run_compose(&runtime, context, &["down"], env, None, None)?;
    remove_tree(&ephemeral_paths(context, env).dir);
    if result != Some(0) {
        // paridade com o Node: status nulo (sinal) é impresso como "null"
        let status_text = result
            .map(|code| code.to_string())
            .unwrap_or_else(|| "null".to_string());
        eprintln!("[mcp-runtime] compose down falhou (exit {status_text})");
        return Ok(1);
    }
    let ado_auth = format!("mcp-{context}-ado-auth");
    let _ = Command::new(&runtime.path)
        .args(["volume", "rm", "-f", &ado_auth])
        .output();
    eprintln!(
        "[mcp-runtime] stack mcp-{context} removida (containers, redes, volume {ado_auth}; cache QMD preservado)"
    );
    Ok(0)
}

pub fn status(context: &str, env: &Env, platform: &str) -> Result<i32, AppError> {
    let runtime = find_runtime(env, platform)?;
    let Some(runtime) = runtime else {
        eprintln!("[mcp-runtime] runtime de container não encontrado (nerdctl ou docker)");
        return Ok(1);
    };

    // Os segredos dão credencial ao handshake do github (SPEC §4/§9); sem eles
    // o status ainda reporta containers e efêmero.
    let tools = find_secrets_tools(env, platform);
    let paths = context_paths(context, env);
    let vars = match &tools.sops {
        Some(sops) if paths.sops_file.exists() && paths.key.exists() => {
            crate::context::decrypt(sops, &paths.sops_file, &paths.key)
                .ok()
                .map(|bytes| crate::context::ContextVars::parse(&bytes))
        }
        _ => None,
    };
    let github_token = vars
        .as_ref()
        .and_then(|vars| vars.get("GITHUB_PERSONAL_ACCESS_TOKEN"))
        .map(str::to_string);

    let include_xharness = resolve_arch_corpus(env, Some(context)).is_ok();
    eprintln!("[mcp-runtime] stack mcp-{context} (contexto {context})");
    let mut ready = true;
    for endpoint in active_endpoints(include_xharness) {
        let token = if endpoint.service == "github" {
            github_token.as_deref()
        } else {
            None
        };
        let label = container_label(&runtime, context, endpoint.service);
        if label != "container running" {
            ready = false;
        }
        match crate::mcp::initialize(&endpoint.url, token, PROBE_TIMEOUT) {
            init if init.ok => {
                eprintln!(
                    "[mcp-runtime]   {}: {} | {}",
                    endpoint.service,
                    label,
                    init.summary()
                );
            }
            init => {
                eprintln!(
                    "[mcp-runtime]   {}: {} | {}",
                    endpoint.service,
                    label,
                    init.summary()
                );
                ready = false;
            }
        }
    }
    if !include_xharness {
        eprintln!(
            "[mcp-runtime]   xharness: omitido (sem MCP_RUNTIME_ARCH_CORPUS válido) — não afeta a prontidão de github/ado"
        );
    }

    let ephemeral = ephemeral_paths(context, env);
    if ephemeral.secrets_file.exists() {
        eprintln!(
            "[mcp-runtime]   efêmero: presente ({}) — reinicie com mcp-runtime up (SPEC §9)",
            ephemeral.secrets_file.display()
        );
        ready = false;
    } else {
        eprintln!("[mcp-runtime]   efêmero: ausente");
    }

    match &vars {
        Some(vars) => {
            eprintln!(
                "[mcp-runtime]   autenticação do serviço ado: modo {}",
                vars.auth_mode().as_str()
            );
        }
        None => {
            eprintln!(
                "[mcp-runtime]   handshake github sem credencial: segredos indisponíveis (sops/chave ausentes)"
            );
        }
    }

    Ok(if ready { 0 } else { 1 })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn endpoints_do_spec_8377_8378_e_8379() {
        let list = active_endpoints(true);
        assert_eq!(list.len(), 3);
        assert_eq!(list[0].service, "github");
        assert_eq!(list[0].url, format!("http://127.0.0.1:{GITHUB_PORT}/"));
        assert_eq!(list[1].service, "ado");
        assert_eq!(list[1].url, format!("http://127.0.0.1:{ADO_PORT}/mcp"));
        assert_eq!(list[2].service, "xharness");
        assert_eq!(list[2].url, format!("http://127.0.0.1:{XHARNESS_PORT}/mcp"));
    }

    #[test]
    fn sem_xharness_active_endpoints_so_github_e_ado() {
        let list = active_endpoints(false);
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].service, "github");
        assert_eq!(list[1].service, "ado");
        assert_eq!(active_compose_services(false), &["github", "ado"]);
        assert_eq!(
            active_compose_services(true),
            &["github", "ado", "xharness"]
        );
    }

    #[test]
    fn resolve_arch_corpus_vazio_retorna_erro() {
        let env = crate::paths::Env(std::collections::BTreeMap::new());
        let err = resolve_arch_corpus(&env, None).unwrap_err();
        assert!(err.contains("MCP_RUNTIME_ARCH_CORPUS"), "{err}");
        assert!(err.contains("xharness"), "{err}");
    }

    #[test]
    fn resolve_arch_corpus_fixture_ok() {
        let fixture = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("test")
            .join("fixtures")
            .join("arch-corpus");
        let mut map = std::collections::BTreeMap::new();
        map.insert(
            "MCP_RUNTIME_ARCH_CORPUS".into(),
            fixture.to_string_lossy().into_owned(),
        );
        let env = crate::paths::Env(map);
        let path = resolve_arch_corpus(&env, None).expect("fixture deve resolver");
        assert!(path.join("arch-graph").join("graph-doc").is_dir());
    }

    #[test]
    fn resolve_arch_corpus_lê_arquivo_do_contexto() {
        let fixture = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("test")
            .join("fixtures")
            .join("arch-corpus");
        let tmp =
            std::env::temp_dir().join(format!("mcp-runtime-corpus-persist-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        let mut map = std::collections::BTreeMap::new();
        map.insert(
            "MCP_RUNTIME_CONFIG_DIR".into(),
            tmp.to_string_lossy().into_owned(),
        );
        let env = crate::paths::Env(map);
        persist_arch_corpus("orbit", &env, &fixture).expect("persist");
        let path = resolve_arch_corpus(&env, Some("orbit")).expect("deve ler arch-corpus.path");
        assert!(path.join("arch-graph").join("graph-doc").is_dir());
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn nome_do_container_e_o_do_compose() {
        assert_eq!(container_name("ctx", "ado"), "mcp-ctx-ado-1");
        assert_eq!(
            container_name("kevsystem", "github"),
            "mcp-kevsystem-github-1"
        );
    }

    #[test]
    fn gate_de_sessao_usa_get_access_token() {
        let args = az_check_args();
        assert_eq!(args[0], "account");
        assert_eq!(args[1], "get-access-token");
        assert!(args.contains(&AZ_RESOURCE));
        assert!(args.contains(&"-o"));
        assert!(!args.contains(&"account list"));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn container_user_no_linux_e_uid_gid_do_arquivo() {
        let dir = crate::paths::create_temp_dir("lifecycle-user-").unwrap();
        let file = dir.join("secrets.env");
        std::fs::write(&file, "X=1\n").unwrap();
        use std::os::unix::fs::MetadataExt;
        let metadata = std::fs::metadata(&file).unwrap();
        assert_eq!(
            container_user_for("linux", &file),
            Some(format!("{}:{}", metadata.uid(), metadata.gid()))
        );
        assert_eq!(container_user_for("darwin", &file), None);
        crate::paths::remove_tree(&dir);
    }
}
