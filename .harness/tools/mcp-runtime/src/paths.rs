// Caminhos (SPEC §5): raiz de config unificada em todas as plataformas,
// resolução bin-dir próprio → PATH (SPEC §7) e utilidades de filesystem.
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use crate::cli::UsageError;

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

/// Cópia do ambiente do processo (paridade com os defaults `env = process.env`
/// do script Node e injetável nos testes).
#[derive(Debug, Clone, Default)]
pub struct Env(pub BTreeMap<String, String>);

impl Env {
    pub fn from_process() -> Self {
        let mut map = BTreeMap::new();
        for (key, value) in std::env::vars() {
            // Windows expõe o path como `Path` (e às vezes `PATH`); o BTreeMap
            // é case-sensitive e `find_on_path` consulta `PATH` — sem normalizar,
            // docker/nerdctl somem e o status falha com "runtime não encontrado".
            let key = if cfg!(windows) && key.eq_ignore_ascii_case("PATH") {
                "PATH".to_string()
            } else if cfg!(windows) && key.eq_ignore_ascii_case("PATHEXT") {
                "PATHEXT".to_string()
            } else {
                key
            };
            map.insert(key, value);
        }
        Env(map)
    }

    pub fn get(&self, key: &str) -> Option<&str> {
        if let Some(value) = self.0.get(key) {
            return Some(value.as_str());
        }
        // Variante de caixa (ex.: `Path` no Windows) como fallback, em todas
        // as plataformas — na unix a consulta exata tem prioridade e o
        // fallback só existe quando a chave pedida está ausente.
        self.0
            .iter()
            .find(|(candidate, _)| candidate.eq_ignore_ascii_case(key))
            .map(|(_, value)| value.as_str())
    }
}

/// Nomes de plataforma equivalentes a process.platform no script Node.
pub fn platform_name() -> &'static str {
    if cfg!(target_os = "macos") {
        "darwin"
    } else if cfg!(windows) {
        "win32"
    } else {
        "linux"
    }
}

/// Padrão do contexto: ^[a-z0-9][a-z0-9-]{0,63}$
pub fn is_valid_context(context: &str) -> bool {
    let bytes = context.as_bytes();
    if bytes.is_empty() || bytes.len() > 64 {
        return false;
    }
    let first = bytes[0];
    if !(first.is_ascii_lowercase() || first.is_ascii_digit()) {
        return false;
    }
    bytes[1..]
        .iter()
        .all(|&byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
}

#[cfg(windows)]
pub fn home_dir() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE").map(PathBuf::from)
}

#[cfg(not(windows))]
pub fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from)
}

pub fn config_root(env: &Env) -> PathBuf {
    if let Some(dir) = env.get("MCP_RUNTIME_CONFIG_DIR") {
        if !dir.is_empty() {
            return PathBuf::from(dir);
        }
    }
    home_dir()
        .unwrap_or_else(|| PathBuf::from("/"))
        .join(".config")
        .join("ai-playbook")
        .join("mcp-runtime")
}

#[derive(Debug, Clone)]
pub struct ContextPaths {
    pub key: PathBuf,
    pub sops_file: PathBuf,
    pub recipients: PathBuf,
    pub sops_config: PathBuf,
    /// Caminho do corpus normativo lembrado pelo último `up` com corpus válido.
    pub arch_corpus_path: PathBuf,
}

pub fn context_paths(context: &str, env: &Env) -> ContextPaths {
    let root = config_root(env);
    let context_dir = root.join("contexts").join(context);
    ContextPaths {
        key: root.join("keys").join(format!("{context}.agekey")),
        sops_file: context_dir.join("secrets.sops.env"),
        recipients: context_dir.join("recipients.txt"),
        sops_config: context_dir.join(".sops.yaml"),
        arch_corpus_path: context_dir.join("arch-corpus.path"),
    }
}

#[derive(Debug, Clone)]
pub struct EphemeralPaths {
    pub dir: PathBuf,
    pub secrets_file: PathBuf,
}

pub fn ephemeral_paths(context: &str, env: &Env) -> EphemeralPaths {
    ephemeral_paths_in(&std::env::temp_dir(), context, env)
}

pub fn ephemeral_paths_in(temp_root: &Path, context: &str, _env: &Env) -> EphemeralPaths {
    // O caminho efêmero é fixo (SPEC §9) — MCP_RUNTIME_CONFIG_DIR não o afeta.
    let dir = temp_root.join("ai-playbook-mcp-runtime").join(context);
    EphemeralPaths {
        secrets_file: dir.join("secrets.env"),
        dir,
    }
}

// ---------------------------------------------------------------------------
// Resolução de binários no PATH.
// ---------------------------------------------------------------------------

fn path_entries(path_value: Option<&str>, platform: &str) -> Vec<PathBuf> {
    let separator = if platform == "win32" { ";" } else { ":" };
    String::from(path_value.unwrap_or(""))
        .split(separator)
        .filter(|entry| !entry.is_empty())
        .map(PathBuf::from)
        .collect()
}

#[cfg(windows)]
fn executable_candidates(dir: &Path, name: &str) -> Vec<PathBuf> {
    let default_exts = ".COM;.EXE;.BAT;.CMD";
    let exts = std::env::var("PATHEXT").unwrap_or_else(|_| default_exts.to_string());
    exts.split(';')
        .filter(|ext| !ext.is_empty())
        .map(|ext| dir.join(format!("{name}{}", ext.to_lowercase())))
        .collect()
}

#[cfg(not(windows))]
fn executable_candidates(dir: &Path, name: &str) -> Vec<PathBuf> {
    vec![dir.join(name)]
}

/// Binário executável regular (bit de execução em unix).
fn is_executable_file(path: &Path) -> bool {
    match fs::metadata(path) {
        Ok(metadata) if metadata.is_file() => {
            #[cfg(unix)]
            {
                use std::os::unix::fs::MetadataExt;
                metadata.mode() & 0o111 != 0
            }
            #[cfg(not(unix))]
            {
                true
            }
        }
        _ => false,
    }
}

/// Diretório de binários próprios do usuário (SPEC §7):
/// ~/.config/ai-playbook/bin — resolvido antes do PATH.
/// Caminho resolvido do próprio executável (SPEC §7, P6): o binário vive no
/// diretório do artefato e não vai para o PATH; `current_exe` não resolve
/// symlink no macOS, por isso o `canonicalize` antes de exibir.
pub fn executable_path() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    Some(fs::canonicalize(&exe).unwrap_or(exe))
}

pub fn bin_dir() -> PathBuf {
    home_dir()
        .unwrap_or_else(|| PathBuf::from("/"))
        .join(".config")
        .join("ai-playbook")
        .join("bin")
}

pub fn find_on_path(name: &str, env: &Env, platform: &str) -> Option<PathBuf> {
    for dir in path_entries(env.get("PATH"), platform) {
        for candidate in executable_candidates(&dir, name) {
            if is_executable_file(&candidate) {
                return Some(candidate);
            }
        }
    }
    None
}

/// Resolução de ferramentas oficiais (SPEC §7): bin-dir próprio primeiro,
/// PATH como fallback. O PATH do usuário nunca é mutado.
pub fn find_tool(name: &str, env: &Env, platform: &str) -> Option<PathBuf> {
    find_tool_in(&bin_dir(), name, env, platform)
}

pub fn find_tool_in(bin: &Path, name: &str, env: &Env, platform: &str) -> Option<PathBuf> {
    for candidate in executable_candidates(bin, name) {
        if is_executable_file(&candidate) {
            return Some(candidate);
        }
    }
    find_on_path(name, env, platform)
}

#[derive(Debug, Clone)]
pub struct ContainerRuntime {
    pub name: &'static str,
    pub path: PathBuf,
}

/// Runtime de container: nerdctl primeiro, docker como fallback (SPEC §10).
/// MCP_RUNTIME_CONTAINER_RUNTIME força a escolha (nerdctl|docker): o harness
/// de testes propaga a flag --runtime do runner por ela; exportável manualmente.
pub fn find_runtime(env: &Env, platform: &str) -> Result<Option<ContainerRuntime>, UsageError> {
    let raw = env.get("MCP_RUNTIME_CONTAINER_RUNTIME").unwrap_or("");
    let forced = raw.trim().to_lowercase();
    if !forced.is_empty() && forced != "nerdctl" && forced != "docker" {
        return Err(UsageError(format!(
            "MCP_RUNTIME_CONTAINER_RUNTIME inválido: \"{raw}\" (use nerdctl ou docker)"
        )));
    }
    let names: &[&str] = match forced.as_str() {
        "nerdctl" => &["nerdctl"],
        "docker" => &["docker"],
        _ => &["nerdctl", "docker"],
    };
    for name in names {
        if let Some(path) = find_on_path(name, env, platform) {
            return Ok(Some(ContainerRuntime { name, path }));
        }
    }
    Ok(None)
}

#[derive(Debug, Clone)]
pub struct SecretsTools {
    pub age: Option<PathBuf>,
    pub age_keygen: Option<PathBuf>,
    pub sops: Option<PathBuf>,
}

pub fn find_secrets_tools(env: &Env, platform: &str) -> SecretsTools {
    SecretsTools {
        age: find_tool("age", env, platform),
        age_keygen: find_tool("age-keygen", env, platform),
        sops: find_tool("sops", env, platform),
    }
}

/// Diretório temporário único (equivalente a mkdtemp do Node), 0700 em unix.
pub fn create_temp_dir(prefix: &str) -> std::io::Result<PathBuf> {
    let base = std::env::temp_dir();
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or_default();
    let pid = std::process::id();
    for attempt in 0..64u32 {
        let dir = base.join(format!("{prefix}{nanos}-{pid}-{attempt}"));
        match fs::create_dir(&dir) {
            Ok(()) => {
                #[cfg(unix)]
                {
                    let mut permissions = fs::metadata(&dir)?.permissions();
                    permissions.set_mode(0o700);
                    fs::set_permissions(&dir, permissions)?;
                }
                return Ok(dir);
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error),
        }
    }
    Err(std::io::Error::new(
        std::io::ErrorKind::AlreadyExists,
        "não foi possível criar diretório temporário único",
    ))
}

/// rmSync(dir, { recursive: true, force: true }) — ausente não é erro.
pub fn remove_tree(dir: &Path) {
    let _ = fs::remove_dir_all(dir);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env_from(pairs: &[(&str, &str)]) -> Env {
        Env(pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect())
    }

    #[test]
    fn config_root_default_unificado_e_override_por_ambiente() {
        let env = env_from(&[]);
        let expected = home_dir()
            .unwrap()
            .join(".config")
            .join("ai-playbook")
            .join("mcp-runtime");
        assert_eq!(config_root(&env), expected);
        let custom = config_root(&env_from(&[("MCP_RUNTIME_CONFIG_DIR", "/tmp/rt-cfg")]));
        assert_eq!(custom, PathBuf::from("/tmp/rt-cfg"));
    }

    #[test]
    fn context_paths_segue_o_layout_do_spec() {
        let env = env_from(&[("MCP_RUNTIME_CONFIG_DIR", "/cfg")]);
        let paths = context_paths("teste", &env);
        assert_eq!(paths.key, PathBuf::from("/cfg/keys/teste.agekey"));
        assert_eq!(
            paths.sops_file,
            PathBuf::from("/cfg/contexts/teste/secrets.sops.env")
        );
        assert_eq!(
            paths.recipients,
            PathBuf::from("/cfg/contexts/teste/recipients.txt")
        );
        assert_eq!(
            paths.sops_config,
            PathBuf::from("/cfg/contexts/teste/.sops.yaml")
        );
        assert_eq!(
            paths.arch_corpus_path,
            PathBuf::from("/cfg/contexts/teste/arch-corpus.path")
        );

        // o caminho efêmero é fixo (SPEC §9) — MCP_RUNTIME_CONFIG_DIR não o afeta
        let eph = ephemeral_paths_in(Path::new("/tmp"), "teste", &env);
        assert_eq!(
            eph.secrets_file,
            PathBuf::from("/tmp/ai-playbook-mcp-runtime/teste/secrets.env")
        );
    }

    #[test]
    fn padrao_do_contexto_kebab_case() {
        assert!(is_valid_context("a"));
        assert!(is_valid_context("9"));
        assert!(is_valid_context("cliente-a"));
        assert!(is_valid_context(&"x".repeat(64)));
        assert!(!is_valid_context(""));
        assert!(!is_valid_context("-a"));
        assert!(!is_valid_context("X"));
        assert!(!is_valid_context("a_b"));
        assert!(!is_valid_context("cliente A"));
        assert!(!is_valid_context(&"x".repeat(65)));
    }

    #[cfg(unix)]
    fn make_stub_dir(name: &str, bins: &[&str]) -> PathBuf {
        let dir = create_temp_dir(&format!("paths-{name}-")).unwrap();
        for bin in bins {
            let path = dir.join(bin);
            fs::write(&path, "#!/bin/sh\nexit 0\n").unwrap();
            let mut permissions = fs::metadata(&path).unwrap().permissions();
            permissions.set_mode(0o755);
            fs::set_permissions(&path, permissions).unwrap();
        }
        dir
    }

    #[cfg(unix)]
    #[test]
    fn find_on_path_percorre_o_path_e_encontra_candidatos() {
        let dir = make_stub_dir("find", &["age-keygen"]);
        let env = env_from(&[("PATH", &format!("{}:/usr/bin:/bin", dir.display()))]);
        assert_eq!(
            find_on_path("age-keygen", &env, "linux"),
            Some(dir.join("age-keygen"))
        );
        assert_eq!(find_on_path("binario-inexistente-xyz", &env, "linux"), None);
        remove_tree(&dir);
    }

    #[test]
    fn get_path_aceita_variante_windows_path() {
        let env = env_from(&[("Path", "C:\\Docker;C:\\Bin")]);
        assert_eq!(env.get("PATH"), Some("C:\\Docker;C:\\Bin"));
        assert_eq!(env.get("Path"), Some("C:\\Docker;C:\\Bin"));
        let entries = path_entries(env.get("PATH"), "win32");
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0], PathBuf::from("C:\\Docker"));
    }

    #[cfg(unix)]
    #[test]
    fn find_runtime_honra_o_runtime_forcado_e_resolve_fallback() {
        let nerdctl_dir = make_stub_dir("nctl-force", &["nerdctl"]);
        let docker_dir = make_stub_dir("dckr-force", &["docker"]);
        let both = env_from(&[
            (
                "PATH",
                &format!("{}:{}", nerdctl_dir.display(), docker_dir.display()),
            ),
            ("MCP_RUNTIME_CONTAINER_RUNTIME", "docker"),
        ]);
        assert_eq!(
            find_runtime(&both, "linux").unwrap().unwrap().name,
            "docker"
        );
        let forced_nerdctl = env_from(&[
            (
                "PATH",
                &format!("{}:{}", nerdctl_dir.display(), docker_dir.display()),
            ),
            ("MCP_RUNTIME_CONTAINER_RUNTIME", "Docker"),
        ]);
        // valor forçado é case-insensitive na comparação, mas o nome buscado é o normalizado
        assert_eq!(
            find_runtime(&forced_nerdctl, "linux")
                .unwrap()
                .unwrap()
                .name,
            "docker"
        );
        let forced_missing = env_from(&[
            ("PATH", nerdctl_dir.to_str().unwrap()),
            ("MCP_RUNTIME_CONTAINER_RUNTIME", "docker"),
        ]);
        assert!(find_runtime(&forced_missing, "linux").unwrap().is_none());
        let invalid = env_from(&[
            ("PATH", nerdctl_dir.to_str().unwrap()),
            ("MCP_RUNTIME_CONTAINER_RUNTIME", "podman"),
        ]);
        assert!(find_runtime(&invalid, "linux").is_err());

        let prefer = env_from(&[(
            "PATH",
            &format!("{}:{}", nerdctl_dir.display(), docker_dir.display()),
        )]);
        assert_eq!(
            find_runtime(&prefer, "linux").unwrap().unwrap().name,
            "nerdctl"
        );
        let fallback = env_from(&[("PATH", &format!("{}:/nonexistent", docker_dir.display()))]);
        assert_eq!(
            find_runtime(&fallback, "linux").unwrap().unwrap().name,
            "docker"
        );
        let none = env_from(&[("PATH", "/nonexistent")]);
        assert!(find_runtime(&none, "linux").unwrap().is_none());

        remove_tree(&nerdctl_dir);
        remove_tree(&docker_dir);
    }

    #[cfg(unix)]
    #[test]
    fn find_tool_prefere_o_bin_dir_proprio_ao_path() {
        let bin = make_stub_dir("bdir-precedence", &["sops"]);
        let on_path = make_stub_dir("bdir-precedence-path", &["sops", "age-keygen"]);
        let env = env_from(&[("PATH", on_path.to_str().unwrap())]);
        // bin-dir próprio ganha, mesmo com o binário também presente no PATH
        assert_eq!(
            find_tool_in(&bin, "sops", &env, "linux"),
            Some(bin.join("sops"))
        );
        // sem o binário no bin-dir, cai para o PATH
        assert_eq!(
            find_tool_in(&bin, "age-keygen", &env, "linux"),
            Some(on_path.join("age-keygen"))
        );
        remove_tree(&bin);
        remove_tree(&on_path);
    }

    #[cfg(unix)]
    #[test]
    fn create_temp_dir_e_unico_com_modo_0700() {
        let a = create_temp_dir("paths-uniq-").unwrap();
        let b = create_temp_dir("paths-uniq-").unwrap();
        assert_ne!(a, b);
        let mode = fs::metadata(&a).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o700);
        remove_tree(&a);
        remove_tree(&b);
    }
}
