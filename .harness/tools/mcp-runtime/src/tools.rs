// tools install — auto-instalação de sops/age nas versões pinadas (SPEC §7):
// baixa dos releases oficiais sobre HTTPS, verificação sha256 antes de mover
// para ~/.config/ai-playbook/bin (0755 em unix), idempotência com --force.
// Distribuição de binários apenas: criptografia permanece 100% em SOPS/age.
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

use crate::pins::Pins;

const PIN_SOURCE: &str = "containers/pins.env";

/// Pins embutidos no binário: fallback para uso standalone (release binário),
/// quando containers/pins.env não está acessível a partir do executável.
const EMBEDDED_PINS: &str = include_str!("../containers/pins.env");

/// Pins para `tools install`: disco primeiro (monorepo), embutido como fallback.
fn load_pins_for_tools() -> Result<Pins, String> {
    match crate::compose::load_pins_file() {
        Ok(pins) => Ok(pins),
        Err(_) => crate::pins::load_pins(EMBEDDED_PINS, PIN_SOURCE),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    /// Binário solto (sops publica binários por SO/arquitetura).
    Raw,
    /// Tar.gz com os binários em `age/` (linux e darwin).
    TarGz,
    /// Zip com os binários em `age/` (windows).
    Zip,
}

/// Um download verificado: origem oficial, pin sha256 e os arquivos a extrair
/// (membro dentro do pacote → nome final no bin-dir).
#[derive(Debug)]
pub struct Job {
    pub label: String,
    pub url: String,
    pub sha256: String,
    pub kind: Kind,
    pub picks: Vec<(String, String)>,
}

pub struct Platform {
    pub os: &'static str,
    pub arch: &'static str,
}

/// SO da plataforma do host + arquitetura do binário em execução.
pub fn current_platform() -> Result<Platform, String> {
    let os = crate::paths::platform_name();
    let arch = match std::env::consts::ARCH {
        "x86_64" => "amd64",
        "aarch64" => "arm64",
        other => return Err(format!("arquitetura não suportada: {other}")),
    };
    Ok(Platform { os, arch })
}

fn pin(pins: &Pins, key: &str) -> Result<String, String> {
    pins.require(key, PIN_SOURCE)
}

/// Plano de instalação da plataforma (SPEC §7): versões e sha256 dos pins.
pub fn plan(platform: &Platform, pins: &Pins) -> Result<Vec<Job>, String> {
    let supported = matches!(
        (platform.os, platform.arch),
        ("linux", "amd64")
            | ("linux", "arm64")
            | ("darwin", "amd64")
            | ("darwin", "arm64")
            | ("win32", "amd64")
    );
    if !supported {
        return Err(format!(
            "plataforma não suportada para ferramentas oficiais: {}-{}",
            platform.os, platform.arch
        ));
    }
    let sops_version = pin(pins, "SOPS_VERSION")?;
    let age_version = pin(pins, "AGE_VERSION")?;
    let os = platform.os;
    let arch = platform.arch;
    let os_key: &str = if os == "win32" {
        "WINDOWS"
    } else {
        &os.to_uppercase()
    };
    let sha_key = |tool: &str| {
        format!(
            "{}_{}_{}_SHA256",
            tool.to_uppercase(),
            os_key,
            arch.to_uppercase()
        )
    };

    // sops: binário solto por SO/arquitetura; windows publica apenas amd64.
    let (sops_asset, sops_dest) = if os == "win32" {
        (format!("sops-v{sops_version}.amd64.exe"), "sops.exe")
    } else {
        (format!("sops-v{sops_version}.{os}.{arch}"), "sops")
    };
    let sops = Job {
        label: format!("sops v{sops_version}"),
        url: format!(
            "https://github.com/getsops/sops/releases/download/v{sops_version}/{sops_asset}"
        ),
        sha256: pin(pins, &sha_key("SOPS"))?,
        kind: Kind::Raw,
        picks: vec![(sops_dest.to_string(), sops_dest.to_string())],
    };

    // age: tar.gz em linux/darwin (age + age-keygen), zip em windows.
    let (age_asset, age_kind, age_members) = if os == "win32" {
        (
            format!("age-v{age_version}-windows-{arch}.zip"),
            Kind::Zip,
            vec!["age/age.exe", "age/age-keygen.exe"],
        )
    } else {
        (
            format!("age-v{age_version}-{os}-{arch}.tar.gz"),
            Kind::TarGz,
            vec!["age/age", "age/age-keygen"],
        )
    };
    let age = Job {
        label: format!("age v{age_version}"),
        url: format!(
            "https://github.com/FiloSottile/age/releases/download/v{age_version}/{age_asset}"
        ),
        sha256: pin(pins, &sha_key("AGE"))?,
        kind: age_kind,
        picks: age_members
            .iter()
            .map(|member| {
                let file = member.rsplit('/').next().unwrap_or(member);
                (member.to_string(), file.to_string())
            })
            .collect(),
    };

    Ok(vec![sops, age])
}

fn download(url: &str) -> Result<Vec<u8>, String> {
    let response = crate::http::agent()?
        .get(url)
        .call()
        .map_err(|error| format!("falha ao baixar {url}: {error}"))?;
    let mut bytes = Vec::new();
    response
        .into_reader()
        .read_to_end(&mut bytes)
        .map_err(|error| format!("falha ao ler {url}: {error}"))?;
    Ok(bytes)
}

/// Verificação sha256 (streaming) do conteúdo baixado.
pub fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

fn verify(label: &str, bytes: &[u8], expected: &str) -> Result<(), String> {
    let obtained = sha256_hex(bytes);
    if obtained != expected.to_lowercase() {
        return Err(format!(
            "checksum inválido para {label}: esperado {expected}, obtido {obtained}"
        ));
    }
    Ok(())
}

/// Gravação atômica no bin-dir: arquivo temporário no mesmo diretório, 0755 em
/// unix, renomeado por cima do destino. Falha não deixa binário parcial.
fn write_executable(dest: &Path, bytes: &[u8]) -> Result<(), String> {
    let temp = dest.with_extension(format!("tmp-{}", std::process::id()));
    let _ = fs::remove_file(&temp);
    fs::write(&temp, bytes)
        .map_err(|error| format!("falha ao gravar {}: {error}", temp.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut permissions = fs::metadata(&temp)
            .map_err(|error| format!("falha ao stat {}: {error}", temp.display()))?
            .permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(&temp, permissions)
            .map_err(|error| format!("falha ao chmod {}: {error}", temp.display()))?;
    }
    // rename por cima de arquivo existente falha em windows — remove antes.
    #[cfg(windows)]
    if dest.exists() {
        fs::remove_file(dest)
            .map_err(|error| format!("falha ao substituir {}: {error}", dest.display()))?;
    }
    fs::rename(&temp, dest).map_err(|error| {
        let _ = fs::remove_file(&temp);
        format!("falha ao instalar {}: {error}", dest.display())
    })
}

/// Extrai os membros escolhidos do pacote para memória.
fn extract(job: &Job, bytes: &[u8]) -> Result<Vec<(String, Vec<u8>)>, String> {
    match job.kind {
        Kind::Raw => Ok(job
            .picks
            .iter()
            .map(|(_, dest)| (dest.clone(), bytes.to_vec()))
            .collect()),
        Kind::TarGz => {
            let decoder = flate2::read::GzDecoder::new(bytes);
            let mut archive = tar::Archive::new(decoder);
            let mut found = Vec::new();
            let entries = archive
                .entries()
                .map_err(|error| format!("falha ao ler {}: {error}", job.label))?;
            for entry in entries {
                let mut entry =
                    entry.map_err(|error| format!("falha ao ler {}: {error}", job.label))?;
                let Ok(path) = entry.path() else {
                    continue;
                };
                let name = path.to_string_lossy().trim_start_matches("./").to_string();
                let Some((_, dest)) = job.picks.iter().find(|(member, _)| member == &name) else {
                    continue;
                };
                let mut data = Vec::new();
                entry
                    .read_to_end(&mut data)
                    .map_err(|error| format!("falha ao extrair {name}: {error}"))?;
                found.push((dest.clone(), data));
            }
            Ok(found)
        }
        Kind::Zip => {
            let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes))
                .map_err(|error| format!("falha ao abrir {}: {error}", job.label))?;
            let mut found = Vec::new();
            for index in 0..archive.len() {
                let mut file = archive
                    .by_index(index)
                    .map_err(|error| format!("falha ao ler {}: {error}", job.label))?;
                if !file.is_file() {
                    continue;
                }
                let name = file.name().to_string();
                let Some((_, dest)) = job.picks.iter().find(|(member, _)| member == &name) else {
                    continue;
                };
                let mut data = Vec::new();
                file.read_to_end(&mut data)
                    .map_err(|error| format!("falha ao extrair {name}: {error}"))?;
                found.push((dest.clone(), data));
            }
            Ok(found)
        }
    }
}

/// Instala um job no bin-dir: baixa, verifica e grava. Retorna (ferramenta, caminhos).
fn install_job(job: &Job, bin: &Path, force: bool) -> Result<Vec<(String, PathBuf)>, String> {
    println!("[mcp-runtime] baixando {}: {}", job.label, job.url);
    let bytes = download(&job.url)?;
    install_verified(job, &bytes, bin, force)
}

/// Verificação e gravação a partir de bytes já obtidos (testável sem rede).
fn install_verified(
    job: &Job,
    bytes: &[u8],
    bin: &Path,
    force: bool,
) -> Result<Vec<(String, PathBuf)>, String> {
    let dests: Vec<PathBuf> = job.picks.iter().map(|(_, dest)| bin.join(dest)).collect();
    if !force && dests.iter().all(|dest| dest.exists()) {
        return Ok(dests
            .into_iter()
            .map(|dest| {
                (
                    dest.file_stem()
                        .unwrap_or_default()
                        .to_string_lossy()
                        .to_string(),
                    dest,
                )
            })
            .collect());
    }
    verify(&job.label, bytes, &job.sha256)?;
    let extracted = extract(job, bytes)?;
    if extracted.len() != job.picks.len() {
        return Err(format!(
            "{}: membros esperados não encontrados no pacote ({})",
            job.label,
            job.picks
                .iter()
                .map(|(member, _)| member.as_str())
                .collect::<Vec<_>>()
                .join(", ")
        ));
    }
    // Associação por NOME do membro (não por ordem): o pacote age lista
    // age-keygen antes de age — emparelhar por posição trocaria os binários.
    let by_dest: std::collections::BTreeMap<String, &[u8]> = extracted
        .iter()
        .map(|(dest, data)| (dest.clone(), data.as_slice()))
        .collect();
    let mut installed = Vec::new();
    for dest in &dests {
        let name = dest
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
            .unwrap_or_default();
        let Some(data) = by_dest.get(&name) else {
            return Err(format!("{}: membro {name} ausente no pacote", job.label));
        };
        write_executable(dest, data)?;
        let tool = dest
            .file_stem()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();
        println!(
            "[mcp-runtime] {}: instalado em {} (sha256 verificado)",
            tool,
            dest.display()
        );
        installed.push((tool, dest.clone()));
    }
    Ok(installed)
}

/// `tools install [--force]` — instala sops e age pinados no bin-dir próprio.
pub fn install_all(force: bool) -> Result<i32, crate::AppError> {
    let pins = load_pins_for_tools().map_err(crate::AppError::Other)?;
    let platform = current_platform().map_err(crate::AppError::Other)?;
    println!(
        "[mcp-runtime] plataforma: {}-{}",
        platform.os, platform.arch
    );
    let bin = crate::paths::bin_dir();
    fs::create_dir_all(&bin).map_err(|error| {
        crate::AppError::Other(format!("falha ao criar {}: {error}", bin.display()))
    })?;
    println!("[mcp-runtime] bin-dir: {}", bin.display());

    let jobs = plan(&platform, &pins).map_err(crate::AppError::Other)?;
    let mut skipped = 0;
    for job in &jobs {
        let dests: Vec<PathBuf> = job.picks.iter().map(|(_, dest)| bin.join(dest)).collect();
        if !force && dests.iter().all(|dest| dest.exists()) {
            for dest in &dests {
                let tool = dest
                    .file_stem()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .to_string();
                println!(
                    "[mcp-runtime] {}: já instalado em {} (use --force para reinstalar)",
                    tool,
                    dest.display()
                );
            }
            skipped += 1;
            continue;
        }
        install_job(job, &bin, force)?;
    }
    if skipped == jobs.len() {
        println!("[mcp-runtime] ferramentas já instaladas (use --force para reinstalar)");
    } else {
        println!("[mcp-runtime] instalação concluída");
    }
    Ok(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::paths::{create_temp_dir, remove_tree};
    use std::io::Write;

    fn platform(os: &'static str, arch: &'static str) -> Platform {
        Platform { os, arch }
    }

    fn pins_from(pairs: &[(&str, &str)]) -> Pins {
        Pins {
            entries: pairs
                .iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect(),
        }
    }

    fn full_pins() -> Pins {
        pins_from(&[
            ("SOPS_VERSION", "3.13.3"),
            ("SOPS_LINUX_AMD64_SHA256", "aa"),
            ("SOPS_LINUX_ARM64_SHA256", "bb"),
            ("SOPS_DARWIN_AMD64_SHA256", "cc"),
            ("SOPS_DARWIN_ARM64_SHA256", "dd"),
            ("SOPS_WINDOWS_AMD64_SHA256", "ee"),
            ("AGE_VERSION", "1.3.2"),
            ("AGE_LINUX_AMD64_SHA256", "ff"),
            ("AGE_LINUX_ARM64_SHA256", "00"),
            ("AGE_DARWIN_AMD64_SHA256", "11"),
            ("AGE_DARWIN_ARM64_SHA256", "22"),
            ("AGE_WINDOWS_AMD64_SHA256", "33"),
        ])
    }

    #[test]
    fn plano_cobre_as_cinco_plataformas_suportadas() {
        let pins = full_pins();
        for (os, arch) in [
            ("linux", "amd64"),
            ("linux", "arm64"),
            ("darwin", "amd64"),
            ("darwin", "arm64"),
            ("win32", "amd64"),
        ] {
            let jobs = plan(&platform(os, arch), &pins).unwrap();
            assert_eq!(jobs.len(), 2, "{os}-{arch}");
            assert!(jobs[0].label.starts_with("sops v"));
            assert!(jobs[1].label.starts_with("age v"));
        }
    }

    #[test]
    fn plano_usa_os_nomes_de_asset_oficiais() {
        let pins = full_pins();
        let linux = plan(&platform("linux", "amd64"), &pins).unwrap();
        assert_eq!(
            linux[0].url,
            "https://github.com/getsops/sops/releases/download/v3.13.3/sops-v3.13.3.linux.amd64"
        );
        assert_eq!(
            linux[1].url,
            "https://github.com/FiloSottile/age/releases/download/v1.3.2/age-v1.3.2-linux-amd64.tar.gz"
        );
        assert_eq!(linux[1].kind, Kind::TarGz);
        assert_eq!(
            linux[1].picks,
            vec![
                ("age/age".to_string(), "age".to_string()),
                ("age/age-keygen".to_string(), "age-keygen".to_string())
            ]
        );

        let windows = plan(&platform("win32", "amd64"), &pins).unwrap();
        assert_eq!(
            windows[0].url,
            "https://github.com/getsops/sops/releases/download/v3.13.3/sops-v3.13.3.amd64.exe"
        );
        assert_eq!(
            windows[1].url,
            "https://github.com/FiloSottile/age/releases/download/v1.3.2/age-v1.3.2-windows-amd64.zip"
        );
        assert_eq!(windows[1].kind, Kind::Zip);
        assert_eq!(
            windows[1].picks[0],
            ("age/age.exe".to_string(), "age.exe".to_string())
        );

        let darwin = plan(&platform("darwin", "arm64"), &pins).unwrap();
        assert_eq!(
            darwin[0].url,
            "https://github.com/getsops/sops/releases/download/v3.13.3/sops-v3.13.3.darwin.arm64"
        );
    }

    #[test]
    fn plano_rejeita_plataforma_sem_pins_oficiais() {
        let pins = full_pins();
        assert!(plan(&platform("win32", "arm64"), &pins).is_err());
        assert!(plan(&platform("freebsd", "amd64"), &pins).is_err());
    }

    #[test]
    fn plano_exige_pins_sem_latest() {
        let pins = pins_from(&[("SOPS_VERSION", "latest"), ("AGE_VERSION", "1.3.2")]);
        let error = plan(&platform("linux", "amd64"), &pins).unwrap_err();
        assert!(
            error.contains("pin inválido (proibido latest): SOPS_VERSION"),
            "{error}"
        );
        let pins = pins_from(&[("SOPS_VERSION", "3.13.3")]);
        let error = plan(&platform("linux", "amd64"), &pins).unwrap_err();
        assert!(error.contains("pin ausente: AGE_VERSION"), "{error}");
    }

    #[test]
    fn pins_embutidos_sao_fallback_valido_do_plano() {
        // o binário standalone resolve o plano a partir dos pins embutidos
        let pins = load_pins_for_tools().unwrap();
        let jobs = plan(&platform("linux", "amd64"), &pins).unwrap();
        assert_eq!(jobs.len(), 2);
        assert!(jobs[0].url.contains("sops-v3.13.3.linux.amd64"));
        assert!(jobs[1].url.contains("age-v1.3.2-linux-amd64.tar.gz"));
    }

    #[test]
    fn sha256_hex_conhece_vetores_de_teste() {
        assert_eq!(
            sha256_hex(b""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn checksum_invalido_aborta_sem_deixar_binario() {
        let bin = create_temp_dir("tools-checksum-").unwrap();
        let job = Job {
            label: "sops v3.13.3".into(),
            url: "https://exemplo/sops".into(),
            sha256: "00".repeat(32),
            kind: Kind::Raw,
            picks: vec![("sops".into(), "sops".into())],
        };
        let error = install_verified(&job, b"conteudo-adulterado", &bin, true).unwrap_err();
        assert!(
            error.contains("checksum inválido para sops v3.13.3"),
            "{error}"
        );
        assert!(!bin.join("sops").exists());
        // nenhum temporário remanescente no bin-dir
        let leftovers: Vec<_> = std::fs::read_dir(&bin).unwrap().collect();
        assert!(leftovers.is_empty(), "{leftovers:?}");
        remove_tree(&bin);
    }

    #[test]
    fn instala_binario_verificado_com_modo_0755() {
        let bin = create_temp_dir("tools-install-").unwrap();
        let job = Job {
            label: "sops v3.13.3".into(),
            url: "https://exemplo/sops".into(),
            sha256: sha256_hex(b"binario-de-fixture"),
            kind: Kind::Raw,
            picks: vec![("sops".into(), "sops".into())],
        };
        let installed = install_verified(&job, b"binario-de-fixture", &bin, true).unwrap();
        assert_eq!(installed.len(), 1);
        let dest = bin.join("sops");
        assert_eq!(installed[0].1, dest);
        assert_eq!(std::fs::read(&dest).unwrap(), b"binario-de-fixture");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&dest).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o755);
        }
        // idempotência: sem --force, arquivo existente é preservado
        std::fs::write(&dest, b"outro-conteudo").unwrap();
        let again = install_verified(&job, b"binario-de-fixture", &bin, false).unwrap();
        assert_eq!(again[0].1, dest);
        assert_eq!(std::fs::read(&dest).unwrap(), b"outro-conteudo");
        remove_tree(&bin);
    }

    fn gz_tar(members: &[(&str, &[u8])]) -> Vec<u8> {
        let encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
        let mut builder = tar::Builder::new(encoder);
        for (name, data) in members {
            let mut header = tar::Header::new_gnu();
            header.set_size(data.len() as u64);
            header.set_mode(0o755);
            header.set_cksum();
            builder.append_data(&mut header, name, *data).unwrap();
        }
        builder.into_inner().unwrap().finish().unwrap()
    }

    #[test]
    fn extrai_age_e_age_keygen_do_tar_gz() {
        let mut job = Job {
            label: "age v1.3.2".into(),
            url: "https://exemplo/age.tar.gz".into(),
            sha256: "x".into(),
            kind: Kind::TarGz,
            picks: vec![
                ("age/age".into(), "age".into()),
                ("age/age-keygen".into(), "age-keygen".into()),
            ],
        };
        // ordem do pacote oficial: age-keygen vem ANTES de age
        let bytes = gz_tar(&[
            ("age/age-keygen", b"bin-age-keygen" as &[u8]),
            ("age/age", b"bin-age"),
            ("age/README.md", b"leia-me"),
        ]);
        job.sha256 = sha256_hex(&bytes);
        let extracted = extract(&job, &bytes).unwrap();
        assert_eq!(
            extracted,
            vec![
                ("age-keygen".to_string(), b"bin-age-keygen".to_vec()),
                ("age".to_string(), b"bin-age".to_vec())
            ]
        );
        // associação por nome sobrevive à ordem do pacote
        let bin = create_temp_dir("tools-tarinstall-").unwrap();
        let installed = install_verified(&job, &bytes, &bin, true).unwrap();
        let age = bin.join("age");
        let keygen = bin.join("age-keygen");
        assert_eq!(std::fs::read(&age).unwrap(), b"bin-age".to_vec());
        assert_eq!(std::fs::read(&keygen).unwrap(), b"bin-age-keygen".to_vec());
        assert_eq!(
            installed
                .iter()
                .map(|(tool, _)| tool.as_str())
                .collect::<Vec<_>>(),
            ["age", "age-keygen"]
        );
        remove_tree(&bin);
    }

    #[test]
    fn extrai_age_exe_do_zip() {
        let job = Job {
            label: "age v1.3.2".into(),
            url: "https://exemplo/age.zip".into(),
            sha256: "x".into(),
            kind: Kind::Zip,
            picks: vec![
                ("age/age.exe".into(), "age.exe".into()),
                ("age/age-keygen.exe".into(), "age-keygen.exe".into()),
            ],
        };
        let mut buffer = std::io::Cursor::new(Vec::new());
        {
            let mut writer = zip::ZipWriter::new(&mut buffer);
            let options = zip::write::SimpleFileOptions::default();
            for (name, data) in [
                ("age/age.exe", b"bin-age-exe" as &[u8]),
                ("age/age-keygen.exe", b"bin-keygen-exe"),
                ("age/README.txt", b"leia-me"),
            ] {
                writer.start_file(name, options).unwrap();
                writer.write_all(data).unwrap();
            }
            writer.finish().unwrap();
        }
        let extracted = extract(&job, buffer.get_ref()).unwrap();
        assert_eq!(
            extracted,
            vec![
                ("age.exe".to_string(), b"bin-age-exe".to_vec()),
                ("age-keygen.exe".to_string(), b"bin-keygen-exe".to_vec())
            ]
        );
    }
}
