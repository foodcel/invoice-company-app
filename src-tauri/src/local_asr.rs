use std::{
    fs::{self, OpenOptions},
    net::TcpListener,
    process::{Child, Command, Stdio},
    sync::Mutex,
};
use tauri::Manager;
use uuid::Uuid;

const MODEL: &str = "nemotron-3.5-asr-streaming-0.6b.q8_0.gguf";

#[derive(Default)]
pub struct LocalAsr {
    server: Mutex<Option<RunningServer>>,
}

struct RunningServer {
    child: Child,
    url: String,
}

impl LocalAsr {
    pub fn start(&self, app: &tauri::AppHandle) -> Result<String, String> {
        let mut current = self.server.lock().map_err(|_| "Le service vocal est bloqué.")?;
        if let Some(server) = current.as_mut() {
            if server.child.try_wait().map_err(|e| e.to_string())?.is_none() {
                return Ok(server.url.clone());
            }
        }
        *current = None;

        let base = app.path().resource_dir().map_err(|e| e.to_string())?.join("nemotron");
        let exe = base.join("runtime/bin/nemo-speech.exe");
        let model = base.join(MODEL);
        if !exe.is_file() || !model.is_file() {
            return Err("Le moteur vocal Nemotron manque dans cette installation. Réinstallez l’application.".into());
        }
        let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
        let port = listener.local_addr().map_err(|e| e.to_string())?.port();
        drop(listener);
        let key = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
        let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
        fs::create_dir_all(&data_dir).map_err(|e| e.to_string())?;
        let log = OpenOptions::new().create(true).write(true).truncate(true)
            .open(data_dir.join("nemotron.log")).map_err(|e| e.to_string())?;
        let err_log = log.try_clone().map_err(|e| e.to_string())?;
        let mut command = Command::new(&exe);
        command.args([
            "serve", "--host", "127.0.0.1", "--port", &port.to_string(),
            "--asr-model", &model.to_string_lossy(),
            "--backend", "cpu", "--threads", "4", "--no-ui",
            "--asr.endpointing.enable=true", "--cors-origin", "http://tauri.localhost",
        ]).current_dir(exe.parent().ok_or("Chemin du moteur vocal invalide.")?)
          .env("NEMO_SPEECH_HTTP_API_KEY", &key)
          .stdin(Stdio::null()).stdout(Stdio::from(log)).stderr(Stdio::from(err_log));
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        }
        let child = command.spawn().map_err(|e| format!("Impossible de démarrer Nemotron : {e}"))?;
        let url = format!("ws://127.0.0.1:{port}/v1/audio/transcriptions/realtime?api_key={key}");
        *current = Some(RunningServer { child, url: url.clone() });
        Ok(url)
    }

    pub fn stop(&self) {
        if let Ok(mut current) = self.server.lock() {
            if let Some(mut server) = current.take() {
                let _ = server.child.kill();
                let _ = server.child.wait();
            }
        }
    }
}
