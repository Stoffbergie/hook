use anyhow::{bail, Result};
use clap::{Parser, Subcommand};

mod api;
mod config;
mod deliver;
mod output;
mod watch;

#[derive(Parser)]
#[command(
    name = "hook",
    version,
    about = "Capture, inspect and replay webhooks to localhost.",
    args_conflicts_with_subcommands = true,
    after_help = "Examples:\n  hook                               Get a URL and print requests as they arrive\n  hook --to 3000                     Also send each request to localhost:3000\n  hook --name stripe --to 3000       Use a fixed URL like stripe.hook.stoff.dev\n  hook replay stripe --to 3000       Send the latest request again\n  hook watch stripe --to 3000        Pick up a hook created earlier\n  hook config --token <token>        Save the owner token needed for fixed names\n\nSet HOOK_URL to use another server and HOOK_TOKEN to pass the token directly."
)]
struct Cli {
    #[command(subcommand)]
    command: Option<Command>,

    #[arg(long, help = "Local port or URL to send each request to as it arrives")]
    to: Option<String>,

    #[arg(short, long, help = "Fixed name for the URL; needs the owner token")]
    name: Option<String>,
}

#[derive(Subcommand)]
enum Command {
    #[command(about = "Print requests to an existing hook as they arrive")]
    Watch {
        #[arg(help = "Hook name, URL, or watch link ending in #key")]
        hook: String,
        #[arg(long, help = "Local port or URL to send each request to as it arrives")]
        to: Option<String>,
    },
    #[command(about = "Send recorded requests to a local server again")]
    Replay {
        #[arg(help = "Hook name, URL, or watch link ending in #key")]
        hook: String,
        #[arg(help = "Request ids to replay; defaults to the latest request")]
        ids: Vec<u64>,
        #[arg(long, help = "Local port or URL to send them to")]
        to: String,
    },
    #[command(about = "List hooks created from this machine")]
    Ls,
    #[command(about = "Delete a hook and everything it recorded")]
    Rm {
        #[arg(help = "Hook name, URL, or watch link ending in #key")]
        hook: String,
    },
    #[command(about = "Show or set the owner token")]
    Config {
        #[arg(long, help = "Owner token that allows fixed names; empty to remove")]
        token: Option<String>,
    },
}

#[tokio::main]
async fn main() {
    if let Err(error) = run(Cli::parse()).await {
        eprintln!("hook: {error:#}");
        std::process::exit(1);
    }
}

async fn run(cli: Cli) -> Result<()> {
    match cli.command {
        Some(Command::Watch { hook, to }) => {
            let hook = api::resolve(&hook)?;
            let deliverer = deliverer(to)?;
            output::note(&format!("Watching {}. Stop anytime: Ctrl+C", hook.name));
            until_interrupted(watch::run(&hook, deliverer.as_ref(), None)).await
        }
        Some(Command::Replay { hook, ids, to }) => {
            deliver::replay(&api::resolve(&hook)?, ids, deliver::Target::parse(&to)?).await
        }
        Some(Command::Ls) => {
            for (name, saved) in config::load()?.hooks {
                println!("{name:<10} {}", saved.url);
            }
            Ok(())
        }
        Some(Command::Rm { hook }) => {
            let hook = api::resolve(&hook)?;
            api::delete(&hook).await?;
            let mut config = config::load()?;
            config.hooks.remove(&hook.name);
            config::save(&config)?;
            println!("deleted {}", hook.name);
            Ok(())
        }
        Some(Command::Config { token }) => config::edit(token),
        None => catch(cli.name, cli.to).await,
    }
}

async fn catch(name: Option<String>, to: Option<String>) -> Result<()> {
    let token = config::token()?;
    if name.is_some() && token.is_none() {
        bail!("choosing a name needs the owner token; set it with hook config --token <token>");
    }
    let deliverer = deliverer(to)?;
    let created = api::create(name.as_deref(), token.as_deref()).await?;
    match &deliverer {
        Some(deliverer) => println!("{} → {}", created.url, deliverer.target()),
        None => println!("{}", created.url),
    }
    output::note(&format!(
        "Requests appear below. Watch in a browser: {}",
        created.watch
    ));
    output::note("Stop anytime: Ctrl+C. The URL keeps catching for 7 days.");
    let hook = api::Hook {
        name: created.name,
        credential: created.key,
    };
    until_interrupted(watch::run(&hook, deliverer.as_ref(), Some(0))).await
}

fn deliverer(to: Option<String>) -> Result<Option<deliver::Deliverer>> {
    to.map(|to| deliver::Deliverer::new(deliver::Target::parse(&to)?))
        .transpose()
}

async fn until_interrupted(task: impl std::future::Future<Output = Result<()>>) -> Result<()> {
    tokio::select! {
        result = task => result,
        _ = tokio::signal::ctrl_c() => Ok(()),
    }
}
