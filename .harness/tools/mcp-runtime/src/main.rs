// mcp-runtime — ciclo de vida dos MCP servers em containers (SPEC §8).
// Port Rust do script Node 0.1.x com paridade de contrato: mesmos comandos,
// flags, variáveis de ambiente, códigos de saída e mensagens-chave.
// Nenhum processo do runtime fica entre consumidor e server (SPEC §1): este
// binário não fala MCP e não loga valores de segredo — apenas caminhos,
// comandos e status. Criptografia permanece 100% em SOPS/age (SPEC §5, §6).
mod cli;
mod client_config;
mod compose;
mod context;
mod doctor;
mod http;
mod lifecycle;
mod mcp;
mod paths;
mod pins;
mod secrets;
mod tools;

use std::process::ExitCode;

use cli::{parse_args, usage, Command, UsageError};
use paths::Env;

#[derive(Debug)]
pub enum AppError {
    /// Uso incorreto da CLI — exit 2 com a usage (paridade com o Node).
    Usage(String),
    /// Erro inesperado de execução — exit 1 (paridade com throw não capturado).
    Other(String),
    /// Código de saída de binário nativo delegado (sops) — repassado sem
    /// mensagem adicional: o próprio binário já loga o erro em stderr.
    Exit(i32),
}

impl From<String> for AppError {
    fn from(message: String) -> Self {
        AppError::Other(message)
    }
}

impl From<UsageError> for AppError {
    fn from(error: UsageError) -> Self {
        AppError::Usage(error.0)
    }
}

impl From<std::io::Error> for AppError {
    fn from(error: std::io::Error) -> Self {
        AppError::Other(error.to_string())
    }
}

fn run(argv: &[String], env: &Env, platform: &str) -> Result<i32, AppError> {
    let parsed = parse_args(argv)?;
    match parsed.command {
        Command::Up | Command::Down | Command::Status => {
            // parse_args já garante --context para o ciclo (paridade com o Node)
            let context = parsed
                .context
                .as_deref()
                .expect("parse_args garante --context para o ciclo");
            match parsed.command {
                Command::Up => lifecycle::up(context, env, platform),
                Command::Down => lifecycle::down(context, env, platform),
                _ => lifecycle::status(context, env, platform),
            }
        }
        Command::Doctor => doctor::doctor(parsed.context.as_deref(), env, platform),
        Command::ToolsInstall => tools::install_all(parsed.force),
        Command::SecretsInit | Command::SecretsEdit | Command::KeysAdd | Command::KeysRemove => {
            secrets::run(&parsed, env, platform)
        }
    }
}

fn main() -> ExitCode {
    let env = Env::from_process();
    let platform = paths::platform_name();
    let argv: Vec<String> = std::env::args().skip(1).collect();
    match run(&argv, &env, platform) {
        Ok(code) => ExitCode::from(code.clamp(0, 255) as u8),
        Err(AppError::Usage(message)) => {
            eprintln!("erro: {message}\n{}", usage());
            ExitCode::from(2)
        }
        Err(AppError::Other(message)) => {
            eprintln!("erro: {message}");
            ExitCode::from(1)
        }
        Err(AppError::Exit(code)) => ExitCode::from(code.clamp(0, 255) as u8),
    }
}
