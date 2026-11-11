// Argumentos — conjunto fechado (SPEC §8).
#[derive(Debug)]
pub struct UsageError(pub String);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Command {
    Up,
    Down,
    Status,
    Doctor,
    ToolsInstall,
    SecretsInit,
    SecretsEdit,
    KeysAdd,
    KeysRemove,
}

pub struct ParsedArgs {
    pub command: Command,
    pub label: String,
    pub context: Option<String>,
    pub force: bool,
    // consumido pela revisão 0.2.2 (unit mcp-runtime-secrets-wrappers)
    #[allow(dead_code)]
    pub recipient: Option<String>,
}

pub fn usage() -> String {
    [
        "Uso: mcp-runtime <comando> --context <nome>",
        "",
        "Comandos:",
        "  up      --context <c>   sobe a stack (github/ado; xharness se corpus ok) e sincroniza ~/.cursor/mcp.json",
        "  down    --context <c>   derruba a stack do contexto (preserva cache QMD do xharness)",
        "  status  --context <c>   mostra containers e health dos endpoints",
        "  doctor  [--context <c>] verifica pré-requisitos (age, age-keygen, sops, runtime)",
        "  tools install [--force] instala sops e age pinados em ~/.config/ai-playbook/bin",
        "  secrets init    --context <c>   cria o contexto (identidade age e primeiro arquivo cifrado)",
        "  secrets edit    --context <c>   edita o secrets.sops.env do contexto",
        "  keys add        --context <c> --recipient <age1...>   adiciona recipient e reencapsula",
        "  keys remove     --context <c> --recipient <age1...>   remove recipient e reencapsula",
    ]
    .join("\n")
}

fn known(command: &str) -> Option<Command> {
    match command {
        "up" => Some(Command::Up),
        "down" => Some(Command::Down),
        "status" => Some(Command::Status),
        "doctor" => Some(Command::Doctor),
        _ => None,
    }
}

/// Comandos agrupados (`tools|secrets|keys <subcomando>`) com rótulo composto.
fn grouped(first: &str, second: Option<&String>) -> Result<(Command, String), UsageError> {
    let Some(second) = second else {
        return Err(UsageError(match first {
            "tools" => "tools exige subcomando (install)".to_string(),
            "secrets" => "secrets exige subcomando (init ou edit)".to_string(),
            _ => "keys exige subcomando (add ou remove)".to_string(),
        }));
    };
    let pair = match first {
        "tools" => match second.as_str() {
            "install" => Some((Command::ToolsInstall, "tools install".to_string())),
            _ => None,
        },
        "secrets" => match second.as_str() {
            "init" => Some((Command::SecretsInit, "secrets init".to_string())),
            "edit" => Some((Command::SecretsEdit, "secrets edit".to_string())),
            _ => None,
        },
        _ => match second.as_str() {
            "add" => Some((Command::KeysAdd, "keys add".to_string())),
            "remove" => Some((Command::KeysRemove, "keys remove".to_string())),
            _ => None,
        },
    };
    let expected = match first {
        "tools" => "install",
        "secrets" => "init ou edit",
        _ => "add ou remove",
    };
    match pair {
        Some(pair) => Ok(pair),
        None => Err(UsageError(format!(
            "subcomando {first} desconhecido: {second} (use {expected})"
        ))),
    }
}

pub fn parse_args(argv: &[String]) -> Result<ParsedArgs, UsageError> {
    let Some(first) = argv.first() else {
        return Err(UsageError("comando ausente".into()));
    };
    let (command, label, rest) = if let Some(command) = known(first) {
        (command, first.clone(), &argv[1..])
    } else if matches!(first.as_str(), "tools" | "secrets" | "keys") {
        let (command, label) = grouped(first, argv.get(1))?;
        (command, label, &argv[2..])
    } else {
        return Err(UsageError(format!("comando desconhecido: {first}")));
    };
    let mut context: Option<String> = None;
    let mut force = false;
    let mut recipient: Option<String> = None;
    let mut rest = rest;
    while !rest.is_empty() {
        let arg = rest[0].as_str();
        if arg == "--context" {
            let Some(value) = rest.get(1) else {
                return Err(UsageError("--context exige um valor".into()));
            };
            context = Some(value.clone());
            rest = &rest[2..];
        } else if let Some(value) = arg.strip_prefix("--context=") {
            context = Some(value.to_string());
            rest = &rest[1..];
        } else if arg == "--force" {
            force = true;
            rest = &rest[1..];
        } else if arg == "--recipient" {
            let Some(value) = rest.get(1) else {
                return Err(UsageError("--recipient exige um valor".into()));
            };
            recipient = Some(value.clone());
            rest = &rest[2..];
        } else if let Some(value) = arg.strip_prefix("--recipient=") {
            recipient = Some(value.to_string());
            rest = &rest[1..];
        } else {
            return Err(UsageError(format!("argumento desconhecido: {arg}")));
        }
    }
    let needs_context = matches!(
        command,
        Command::Up
            | Command::Down
            | Command::Status
            | Command::SecretsInit
            | Command::SecretsEdit
            | Command::KeysAdd
            | Command::KeysRemove
    );
    if needs_context && context.is_none() {
        return Err(UsageError(format!("--context é obrigatório para {label}")));
    }
    if force && command != Command::ToolsInstall {
        return Err(UsageError(
            "--force é válido apenas para tools install".into(),
        ));
    }
    if recipient.is_some() && !matches!(command, Command::KeysAdd | Command::KeysRemove) {
        return Err(UsageError(
            "--recipient é válido apenas para keys add e keys remove".into(),
        ));
    }
    if matches!(command, Command::KeysAdd | Command::KeysRemove) && recipient.is_none() {
        return Err(UsageError(format!(
            "--recipient é obrigatório para {label}"
        )));
    }
    if let Some(value) = &context {
        if !crate::paths::is_valid_context(value) {
            return Err(UsageError(format!(
                "--context inválido: \"{value}\" (use kebab-case minúsculo: [a-z0-9][a-z0-9-]*)"
            )));
        }
    }
    Ok(ParsedArgs {
        command,
        label,
        context,
        force,
        recipient,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn aceita_o_conjunto_fechado_de_comandos() {
        let parsed = parse_args(&args(&["up", "--context", "teste"])).unwrap();
        assert_eq!(parsed.command, Command::Up);
        assert_eq!(parsed.context.as_deref(), Some("teste"));
        let parsed = parse_args(&args(&["down", "--context", "prod"])).unwrap();
        assert_eq!(parsed.command, Command::Down);
        let parsed = parse_args(&args(&["status", "--context=c1"])).unwrap();
        assert_eq!(parsed.command, Command::Status);
        assert_eq!(parsed.context.as_deref(), Some("c1"));
        let parsed = parse_args(&args(&["doctor"])).unwrap();
        assert_eq!(parsed.command, Command::Doctor);
        assert_eq!(parsed.context, None);
        let parsed = parse_args(&args(&["doctor", "--context", "x9"])).unwrap();
        assert_eq!(parsed.context.as_deref(), Some("x9"));
    }

    #[test]
    fn aceita_tools_install_com_force() {
        let parsed = parse_args(&args(&["tools", "install"])).unwrap();
        assert_eq!(parsed.command, Command::ToolsInstall);
        assert_eq!(parsed.label, "tools install");
        assert!(!parsed.force);
        let parsed = parse_args(&args(&["tools", "install", "--force"])).unwrap();
        assert!(parsed.force);
        // --context é opcional e validado quando presente
        let parsed = parse_args(&args(&["tools", "install", "--context", "c1"])).unwrap();
        assert_eq!(parsed.context.as_deref(), Some("c1"));
    }

    #[test]
    fn aceita_secrets_e_keys_com_recipient() {
        let parsed = parse_args(&args(&["secrets", "init", "--context", "c1"])).unwrap();
        assert_eq!(parsed.command, Command::SecretsInit);
        let parsed = parse_args(&args(&["secrets", "edit", "--context=c1"])).unwrap();
        assert_eq!(parsed.command, Command::SecretsEdit);
        let parsed = parse_args(&args(&[
            "keys",
            "add",
            "--context",
            "c1",
            "--recipient",
            "age1abc",
        ]))
        .unwrap();
        assert_eq!(parsed.command, Command::KeysAdd);
        assert_eq!(parsed.recipient.as_deref(), Some("age1abc"));
        let parsed = parse_args(&args(&[
            "keys",
            "remove",
            "--context",
            "c1",
            "--recipient=age1xyz",
        ]))
        .unwrap();
        assert_eq!(parsed.command, Command::KeysRemove);
        assert_eq!(parsed.recipient.as_deref(), Some("age1xyz"));
    }

    #[test]
    fn e_estrito_conjunto_fechado() {
        let rejected: &[&[&str]] = &[
            &[],
            &["unknown"],
            &["up"],
            &["up", "--context"],
            &["up", "--other", "x"],
            &["up", "--context", "X"],
            &["up", "--context", "-x"],
            &["up", "--context", "a_b"],
            &["tools"],
            &["tools", "uninstall"],
            &["secrets"],
            &["secrets", "rotate"],
            &["keys"],
            &["keys", "list"],
            &["tools", "install", "--force", "--recipient", "age1x"],
            &["keys", "add", "--context", "c1"],
            &["secrets", "init", "--context", "c1", "--force"],
        ];
        for argv in rejected {
            assert!(
                parse_args(&args(argv)).is_err(),
                "deveria rejeitar: {argv:?}"
            );
        }
    }

    #[test]
    fn usage_lista_apenas_os_comandos_do_spec() {
        let text = usage();
        for cmd in [
            "up",
            "down",
            "status",
            "doctor",
            "tools install",
            "secrets init",
            "secrets edit",
            "keys add",
            "keys remove",
        ] {
            assert!(text.contains(cmd), "{cmd}");
        }
    }
}
