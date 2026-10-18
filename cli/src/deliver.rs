use crate::{api, output};
use anyhow::{anyhow, Result};
use base64::Engine;
use std::time::Instant;

const SKIPPED: [&str; 6] = [
    "host",
    "content-length",
    "connection",
    "transfer-encoding",
    "keep-alive",
    "upgrade",
];

pub struct Target {
    pub http: String,
    pub display: String,
}

impl Target {
    pub fn parse(input: &str) -> Result<Self> {
        let input = input.trim().trim_end_matches('/');
        if let Ok(port) = input.parse::<u16>() {
            return Ok(Self {
                http: format!("http://localhost:{port}"),
                display: format!("localhost:{port}"),
            });
        }
        let http = if input.contains("://") {
            input.to_string()
        } else {
            format!("http://{input}")
        };
        let display = http
            .split_once("://")
            .map(|(_, rest)| rest.to_string())
            .ok_or_else(|| anyhow!("could not read {input} as a port or URL"))?;
        Ok(Self { http, display })
    }
}

pub struct Deliverer {
    client: reqwest::Client,
    target: Target,
}

impl Deliverer {
    pub fn new(target: Target) -> Result<Self> {
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()?;
        Ok(Self { client, target })
    }

    pub fn target(&self) -> &str {
        &self.target.display
    }

    pub async fn send(&self, hook: &api::Hook, id: u64) -> Result<bool> {
        let detail = api::detail(hook, id).await?;
        if detail.truncated {
            output::note(&format!(
                "request {id} was larger than 1 MB; only the first 1 MB is sent"
            ));
        }
        let body = if detail.body_encoding == "base64" {
            base64::engine::general_purpose::STANDARD.decode(detail.body)?
        } else {
            detail.body.into_bytes()
        };
        let method = reqwest::Method::from_bytes(detail.method.as_bytes())?;
        let mut request = self
            .client
            .request(method, format!("{}{}", self.target.http, detail.path));
        for (name, value) in &detail.headers {
            if !SKIPPED.contains(&name.as_str()) {
                request = request.header(name, value);
            }
        }
        let started = Instant::now();
        match request.body(body).send().await {
            Ok(response) => {
                let status = response.status().as_u16().to_string();
                let took = output::duration(started.elapsed());
                output::request(&detail.method, &detail.path, &status, &took);
                Ok(true)
            }
            Err(_) => {
                let reason = format!("nothing answered on {}", self.target.display);
                output::request(&detail.method, &detail.path, "-", &reason);
                Ok(false)
            }
        }
    }
}

pub async fn replay(hook: &api::Hook, ids: Vec<u64>, target: Target) -> Result<()> {
    let ids = if ids.is_empty() {
        match api::list(hook, 0).await?.first() {
            Some(latest) => vec![latest.id],
            None => anyhow::bail!("{} has not received any requests to replay yet", hook.name),
        }
    } else {
        ids
    };
    let deliverer = Deliverer::new(target)?;
    for id in ids {
        if !deliverer.send(hook, id).await? {
            anyhow::bail!("nothing answered on {}", deliverer.target());
        }
    }
    Ok(())
}
