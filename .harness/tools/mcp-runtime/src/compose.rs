// Compose (SPEC §10): denominador comum nerdctl/docker. O env-file efêmero
// (pins + variáveis do runtime) é gerado por chamada e removido no fim —
// nerdctl compose resolve a interpolação SOMENTE pelos --env-file.
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use crate::paths::{create_temp_dir, ephemeral_paths, remove_tree, ContainerRuntime, Env};
use crate::pins::{load_pins, Pins};

/// Raiz do artefato: override por MCP_RUNTIME_ARTIFACT_DIR ou subida a partir
/// do próprio binário (cargo run/test dentro do artefato localiza o diretório).
/// O caminho resolvido é o canônico (SPEC §10): o binário pode ser invocado
/// por symlink (instalação em ~/.config/ai-playbook/bin), e o `current_exe()`
/// do macOS não resolve symlink — sem `canonicalize` a busca pelo artefato
/// partiria do diretório do symlink e falharia.
pub fn artifact_dir() -> Result<PathBuf, String> {
    if let Some(dir) = std::env::var_os("MCP_RUNTIME_ARTIFACT_DIR") {
        let path = PathBuf::from(dir);
        return Ok(fs::canonicalize(&path).unwrap_or(path));
    }
    if let Ok(exe) = std::env::current_exe() {
        let exe = fs::canonicalize(&exe).unwrap_or(exe);
        for ancestor in exe.ancestors().skip(1) {
            if ancestor.join("containers").join("compose.yaml").is_file() {
                return Ok(ancestor.to_path_buf());
            }
        }
    }
    Err(
        "artefato tools/mcp-runtime não localizado a partir do binário; defina MCP_RUNTIME_ARTIFACT_DIR"
            .to_string(),
    )
}

pub fn pins_file() -> Result<PathBuf, String> {
    Ok(artifact_dir()?.join("containers").join("pins.env"))
}

pub fn load_pins_file() -> Result<Pins, String> {
    let path = pins_file()?;
    let text = fs::read_to_string(&path)
        .map_err(|error| format!("{}: falha ao ler pins: {error}", path.display()))?;
    load_pins(&text, &path.display().to_string())
}

/// Conteúdo determinístico do env-file do compose (paridade com o Node:
/// pins na ordem do arquivo + contexto + caminho do segredo + usuário + corpus).
pub fn compose_env_file_contents(
    pins: &Pins,
    context: &str,
    env: &Env,
    secrets_file: Option<&Path>,
    container_user: Option<&str>,
) -> String {
    let mut lines: Vec<String> = pins
        .entries
        .iter()
        .map(|(k, v)| format!("{k}={v}"))
        .collect();
    lines.push(format!("MCP_RUNTIME_CONTEXT={context}"));
    let secrets = secrets_file
        .map(Path::to_path_buf)
        .unwrap_or_else(|| ephemeral_paths(context, env).secrets_file);
    // O default live no env-file (nunca em interpolação `${VAR:-default}` no
    // compose.yaml: o nerdctl mangela defaults com dois-pontos — verificado).
    lines.push(format!("MCP_RUNTIME_SECRETS_FILE={}", secrets.display()));
    lines.push(format!(
        "MCP_RUNTIME_CONTAINER_USER={}",
        container_user.unwrap_or("10001:10001")
    ));
    // Corpus normativo (ADR-0008): compose interpola o volume do serviço
    // `xharness` mesmo quando ele não sobe (`up github ado`). Sem a variável,
    // docker/nerdctl geram `:/app/repo:ro` e falham. Sempre emite um path
    // absoluto existente: o real quando válido, ou um placeholder efêmero.
    let corpus = crate::lifecycle::resolve_arch_corpus(env, Some(context))
        .unwrap_or_else(|_| placeholder_arch_corpus());
    lines.push(format!("MCP_RUNTIME_ARCH_CORPUS={}", corpus.display()));
    format!("{}\n", lines.join("\n"))
}

/// Diretório placeholder para interpolação do compose quando o corpus está
/// ausente/inválido. O serviço `xharness` continua omitido pelo `up`.
fn placeholder_arch_corpus() -> PathBuf {
    let dir = std::env::temp_dir()
        .join("ai-playbook-mcp-runtime")
        .join("_no-arch-corpus");
    let _ = fs::create_dir_all(&dir);
    dir
}

pub struct ComposeEnvFile {
    pub dir: PathBuf,
    pub file: PathBuf,
}

pub fn write_compose_env_file(
    context: &str,
    env: &Env,
    secrets_file: Option<&Path>,
    container_user: Option<&str>,
) -> Result<ComposeEnvFile, String> {
    let pins = load_pins_file()?;
    let dir = create_temp_dir("mcp-runtime-compose-env-").map_err(|error| error.to_string())?;
    let file = dir.join("compose.env");
    let contents = compose_env_file_contents(&pins, context, env, secrets_file, container_user);
    fs::write(&file, contents).map_err(|error| error.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut permissions = fs::metadata(&file)
            .map_err(|error| error.to_string())?
            .permissions();
        permissions.set_mode(0o600);
        fs::set_permissions(&file, permissions).map_err(|error| error.to_string())?;
    }
    Ok(ComposeEnvFile { dir, file })
}

/// Comando do compose compartilhado por execução direta, captura e spawn.
/// O diretório canônico do artefato entra como `current_dir` E como `PWD`:
/// `Command::current_dir` não atualiza `PWD`, e a ponte `rdctl shell` do
/// Rancher Desktop no macOS repassa o `PWD` do host, que aponta para um `/tmp`
/// do host ausente no guest (SPEC §10). `-f` e `--env-file` são absolutos.
fn compose_command(
    runtime: &ContainerRuntime,
    context: &str,
    env_file: &Path,
    artifact_dir: &Path,
    subcommand: &[&str],
) -> Command {
    let mut command = Command::new(&runtime.path);
    command
        .arg("compose")
        .arg("--env-file")
        .arg(env_file)
        .arg("--file")
        .arg(artifact_dir.join("containers").join("compose.yaml"))
        .arg("--project-name")
        .arg(format!("mcp-{context}"))
        .args(subcommand)
        .current_dir(artifact_dir)
        .env("PWD", artifact_dir);
    command
}

/// Executa o compose com stdio herdado (paridade com spawnSync stdio
/// 'inherit'); o env-file efêmero é removido no fim da chamada.
pub fn run_compose(
    runtime: &ContainerRuntime,
    context: &str,
    subcommand: &[&str],
    env: &Env,
    secrets_file: Option<&Path>,
    container_user: Option<&str>,
) -> Result<Option<i32>, String> {
    let env_file = write_compose_env_file(context, env, secrets_file, container_user)?;
    let artifact_dir = artifact_dir()?;
    let status =
        compose_command(runtime, context, &env_file.file, &artifact_dir, subcommand).status();
    remove_tree(&env_file.dir);
    Ok(status.ok().and_then(|exit| exit.code()))
}

/// Igual a `run_compose`, mas captura stdout (comandos curtos e não
/// interativos, como consultar a conta autenticada do `az`).
pub fn capture_compose(
    runtime: &ContainerRuntime,
    context: &str,
    subcommand: &[&str],
    env: &Env,
) -> Result<(Option<i32>, String), String> {
    let env_file = write_compose_env_file(context, env, None, None)?;
    let artifact_dir = artifact_dir()?;
    let output = compose_command(runtime, context, &env_file.file, &artifact_dir, subcommand)
        .output()
        .map_err(|error| error.to_string());
    remove_tree(&env_file.dir);
    let output = output?;
    Ok((
        output.status.code(),
        String::from_utf8_lossy(&output.stdout).to_string(),
    ))
}

/// Igual a `run_compose`, mas devolve o processo vivo com stdout/stderr em
/// pipe (relé com prefixo) e o diretório do env-file, que o chamador remove
/// quando o processo termina.
pub fn spawn_compose(
    runtime: &ContainerRuntime,
    context: &str,
    subcommand: &[&str],
    env: &Env,
    secrets_file: Option<&Path>,
    container_user: Option<&str>,
) -> Result<(std::process::Child, PathBuf), String> {
    let env_file = write_compose_env_file(context, env, secrets_file, container_user)?;
    let artifact_dir = artifact_dir()?;
    let spawned = compose_command(runtime, context, &env_file.file, &artifact_dir, subcommand)
        .stdin(std::process::Stdio::inherit())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn();
    match spawned {
        Ok(child) => Ok((child, env_file.dir)),
        Err(error) => {
            remove_tree(&env_file.dir);
            Err(error.to_string())
        }
    }
}

/// Tags `mcp-runtime:v*` presentes no compose.yaml, na ordem de aparição.
fn image_tags(compose: &str) -> Vec<String> {
    let marker = "mcp-runtime:v";
    let mut tags: Vec<String> = Vec::new();
    let mut rest = compose;
    while let Some(index) = rest.find(marker) {
        let tail = &rest[index + marker.len()..];
        let end = tail
            .find(|character: char| {
                !character.is_ascii_alphanumeric()
                    && character != '.'
                    && character != '-'
                    && character != '_'
            })
            .unwrap_or(tail.len());
        // comentários do compose citam `mcp-runtime:v<versão>`: só tags com
        // dígito inicial contam (a regex do harness também é ancorada).
        if tail.starts_with(|character: char| character.is_ascii_digit()) {
            tags.push(format!("v{}", &tail[..end]));
        }
        rest = &tail[end..];
    }
    tags
}

fn artifact_version(manifest: &str) -> Option<String> {
    manifest.lines().find_map(|line| {
        line.trim()
            .strip_prefix("version:")
            .map(|value| value.trim().trim_matches('"').to_string())
    })
}

/// Guard do contrato de imagem: a tag literal do compose.yaml precisa casar
/// com `metadata.version` do artifact.yaml (a suíte smoke deriva a imagem
/// esperada do compose; um drift silencioso já aconteceu em 0.3.1).
pub fn image_tag_check() -> Result<String, String> {
    let dir = artifact_dir()?;
    let manifest =
        fs::read_to_string(dir.join("artifact.yaml")).map_err(|error| error.to_string())?;
    let version = artifact_version(&manifest)
        .ok_or_else(|| "artifact.yaml sem metadata.version".to_string())?;
    let compose = fs::read_to_string(dir.join("containers").join("compose.yaml"))
        .map_err(|error| error.to_string())?;
    let expected = format!("v{version}");
    let tags = image_tags(&compose);
    if !tags.is_empty() && tags.iter().all(|tag| *tag == expected) {
        Ok(version)
    } else {
        Err(format!(
            "tag da imagem no containers/compose.yaml {tags:?} diverge de artifact.yaml (v{version})"
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pins::load_pins;

    fn env_from(pairs: &[(&str, &str)]) -> Env {
        Env(pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect())
    }

    fn sample_pins() -> Pins {
        load_pins(
            "GITHUB_MCP_IMAGE=img@sha256:00\nADO_MCP_NPM_VERSION=2.10.0\n\
             ADO_HTTP_ADAPTER=adapter\nAZURE_CLI_VERSION=cli\n\
             XHARNESS_MCP_IMAGE=ghcr.io/eximiaco/x-harness-mcp:v1.0.0\n",
            "p.env",
        )
        .unwrap()
    }

    #[test]
    fn conteudo_do_env_file_e_deterministico() {
        let pins = sample_pins();
        let env = env_from(&[("MCP_RUNTIME_CONFIG_DIR", "/cfg")]);
        let contents = compose_env_file_contents(
            &pins,
            "ctx",
            &env,
            Some(Path::new("/tmp/eph/secrets.env")),
            Some("1000:1000"),
        );
        assert!(contents.contains("GITHUB_MCP_IMAGE=img@sha256:00\n"));
        assert!(contents.contains("MCP_RUNTIME_CONTEXT=ctx\n"));
        assert!(contents.contains("MCP_RUNTIME_SECRETS_FILE=/tmp/eph/secrets.env\n"));
        assert!(contents.contains("MCP_RUNTIME_CONTAINER_USER=1000:1000\n"));
        assert!(
            contents.contains("MCP_RUNTIME_ARCH_CORPUS="),
            "corpus (real ou placeholder) é obrigatório para interpolação do compose:\n{contents}"
        );
        assert!(contents.ends_with('\n'));
    }

    #[test]
    fn env_file_inclui_corpus_quando_configurado() {
        let pins = sample_pins();
        let fixture = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("test")
            .join("fixtures")
            .join("arch-corpus");
        let env = env_from(&[("MCP_RUNTIME_ARCH_CORPUS", fixture.to_str().unwrap())]);
        let contents = compose_env_file_contents(&pins, "ctx", &env, None, None);
        assert!(contents.contains("MCP_RUNTIME_ARCH_CORPUS="), "{contents}");
        assert!(
            contents.contains("arch-corpus") || contents.contains("arch_corpus"),
            "path do fixture esperado em:\n{contents}"
        );
    }

    #[test]
    fn env_file_usa_placeholder_quando_corpus_invalido() {
        let pins = sample_pins();
        let env = env_from(&[("MCP_RUNTIME_ARCH_CORPUS", "/caminho/inexistente")]);
        let contents = compose_env_file_contents(&pins, "ctx", &env, None, None);
        assert!(
            contents.contains("MCP_RUNTIME_ARCH_CORPUS="),
            "compose exige path absoluto mesmo sem xharness:\n{contents}"
        );
        assert!(
            contents.contains("_no-arch-corpus"),
            "placeholder esperado quando corpus inválido:\n{contents}"
        );
        assert!(
            !contents.contains("/caminho/inexistente"),
            "path inválido não deve ir ao env-file:\n{contents}"
        );
    }

    #[test]
    fn env_file_sem_overrides_usa_defaults_do_spec() {
        let pins = sample_pins();
        let env = env_from(&[]);
        let contents = compose_env_file_contents(&pins, "ctx", &env, None, None);
        let secrets = ephemeral_paths("ctx", &env).secrets_file;
        assert!(contents.contains(&format!("MCP_RUNTIME_SECRETS_FILE={}", secrets.display())));
        assert!(contents.contains("MCP_RUNTIME_CONTAINER_USER=10001:10001"));
        assert!(contents.contains("MCP_RUNTIME_CONTEXT=ctx"));
        assert!(contents.ends_with('\n'));
    }

    #[test]
    fn artifact_dir_localiza_o_diretorio_do_artefato_pelo_exe() {
        // nos testes (e no cargo run dentro do artefato), a subida a partir do
        // binário deve achar containers/compose.yaml
        let dir = artifact_dir().unwrap();
        assert!(dir.join("containers").join("compose.yaml").is_file());
        assert!(dir.join("containers").join("pins.env").is_file());
    }

    #[test]
    fn guard_da_tag_usa_a_versao_do_artefato() {
        let dir = artifact_dir().unwrap();
        let manifest = fs::read_to_string(dir.join("artifact.yaml")).unwrap();
        let version = artifact_version(&manifest).unwrap();
        let compose = fs::read_to_string(dir.join("containers").join("compose.yaml")).unwrap();
        let tags = image_tags(&compose);
        assert_eq!(tags, vec![format!("v{version}"), format!("v{version}")]);
        assert_eq!(image_tag_check().unwrap(), version);
    }

    #[test]
    fn tags_encontradas_em_compose_de_exemplo() {
        let sample = "image: mcp-runtime:v0.3.2\n    image: mcp-runtime:v0.3.2\n";
        assert_eq!(
            image_tags(sample),
            vec!["v0.3.2".to_string(), "v0.3.2".to_string()]
        );
        assert_eq!(
            artifact_version("metadata:\n  version: 0.3.2\n").unwrap(),
            "0.3.2"
        );
    }
}
