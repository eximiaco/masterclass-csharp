//! Agente HTTP da ureq por plataforma.
//!
//! Mesmo arranjo do ai-installer (`artifacts/tools/ai-installer/src/http.rs`):
//! fora do Windows a ureq compila com a feature `tls` (rustls) e o agente
//! default basta. No alvo `x86_64-pc-windows-gnu` o rustls/ring não compila,
//! então a ureq é compilada com `default-features = false, features =
//! ["native-tls"]` — nesse modo ela NÃO registra backend TLS no agente default
//! (`default_tls_config` só existe com a feature `tls`), e qualquer request
//! `https://` falharia com "cannot make HTTPS request because no TLS backend is
//! configured". A feature `native-tls` exige wiring explícito:
//! `AgentBuilder::tls_connector` com `Arc<native_tls::TlsConnector>` (schannel).
//!
//! Consequência verificada por `scripts/check-binaries.mjs`: o binário Windows
//! importa `secur32.dll` e `crypt32.dll` e usa o repositório de certificados do
//! sistema, em vez de raízes embutidas no binário.

/// Agente HTTP usado por `tools install` para baixar os binários pinados.
pub fn agent() -> Result<ureq::Agent, String> {
    #[cfg(windows)]
    {
        use std::sync::Arc;
        let tls = native_tls::TlsConnector::new()
            .map_err(|error| format!("backend TLS nativo (schannel) indisponível: {error}"))?;
        Ok(ureq::AgentBuilder::new()
            .tls_connector(Arc::new(tls))
            .build())
    }
    #[cfg(not(windows))]
    {
        Ok(ureq::AgentBuilder::new().build())
    }
}
